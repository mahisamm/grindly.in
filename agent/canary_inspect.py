"""What did we actually type into that form? — a read-only post-mortem.

The first real submit came back "submit click registered but page shows a
validation/error message", and the answers stored on the application row read
wrong: a first name of "naukri", a country of "Search", questions whose label
was the string "Select...". Any of those could be three different faults —
the form reader pairing labels with the wrong inputs, the answerer sourcing a
value from the wrong place, or the vendor's own resume-parse prefill landing
between the two.

So: open the same page, run the same two functions the sender runs, and print
what each field's label, kind and answer actually are. Nothing is filled, no
button is clicked, nothing is written to the database. This exists to be run
against a URL that already failed, not as part of any pipeline.

    python canary_inspect.py --email you@example.com --url https://... [--url ...]
"""
from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import db
import questions


def _user(email: str) -> dict:
    with db.conn() as c:
        row = c.execute("SELECT id FROM users WHERE lower(email)=lower(?)", (email,)).fetchone()
    if not row:
        raise SystemExit(f"no user {email}")
    return db.get_user(dict(row)["id"])


def inspect(url: str, profile: dict, skills: list[str], resume_path: str) -> dict:
    """Open the form the way channel_ats does and report what it sees."""
    import channel_ats
    from playwright.sync_api import sync_playwright

    out: dict = {"url": url, "form_url": "", "fields": [], "error": ""}
    pw = sync_playwright().start()
    browser = None
    try:
        browser = pw.chromium.launch(headless=False, args=["--no-sandbox"])
        page = browser.new_page()

        # channel_ats.apply navigates BEFORE calling open_the_form — that
        # function's job is to get from wherever we landed to the page holding
        # the form, not to do the first hop. Skipping this left the inspector on
        # about:blank, where _looks_gone quite correctly reported a dead posting.
        page.goto(url, timeout=channel_ats._NAV_TIMEOUT_MS, wait_until="domcontentloaded")
        try:
            page.wait_for_load_state("networkidle", timeout=15000)
        except Exception:  # noqa: BLE001
            pass          # client-rendered pages often never go fully idle
        channel_ats._dismiss_consent(page)

        reached = channel_ats.open_the_form(page, url)
        out["form_url"] = page.url
        out["open_the_form"] = reached

        # Order matters and is the point: the sender uploads FIRST, because
        # several vendors parse the resume and prefill name/email/phone, and
        # read_fields then skips anything already filled. Reading before the
        # upload would show a form nobody ever answers.
        uploaded = False
        if resume_path and os.path.exists(resume_path):
            uploaded = channel_ats._attach_resume(
                page, channel_ats._file_inputs(page), resume_path
            )
        out["resume_uploaded"] = uploaded

        fields = questions.read_fields(page)
        answers = questions.answer_fields(
            fields,
            profile=profile,
            resume_text=profile.get("resume_text") or "",
            skills=skills,
            job={"title": "", "company": "", "url": url},
            name=profile.get("name") or "",
            email=profile.get("email") or "",
        )
        for f, a in zip(fields, answers):
            out["fields"].append({
                "label": f["label"],
                "kind": f["kind"],
                "required": f["required"],
                "options": f["options"][:6],
                "answer": a["answer"],
                "source": a["source"],
                "paired_question": a["question"],
            })
        out["prefilled_by_vendor"] = _prefilled(page)
    except Exception as e:  # noqa: BLE001
        out["error"] = f"{type(e).__name__}: {e}"[:300]
    finally:
        try:
            if browser is not None:
                browser.close()
        except Exception:  # noqa: BLE001
            pass
        pw.stop()
    return out


def _prefilled(page) -> list[dict]:
    """Inputs the VENDOR filled from the resume — read_fields skips these, so
    they never appear in the answer list and are invisible in the stored record.
    A wrong name parsed out of the PDF would sit here, unanswered-for and
    submitted."""
    found = []
    try:
        for el in page.query_selector_all("input"):
            try:
                if (el.get_attribute("type") or "text").lower() in ("hidden", "file", "submit"):
                    continue
                value = (el.input_value() or "").strip()
                if value:
                    found.append({
                        "label": (el.evaluate(questions._LABEL_JS) or "").strip()[:120],
                        "name": el.get_attribute("name") or "",
                        "value": value[:120],
                    })
            except Exception:  # noqa: BLE001
                continue
    except Exception:  # noqa: BLE001
        pass
    return found


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--email", required=True)
    ap.add_argument("--url", action="append", required=True)
    ap.add_argument("--json")
    args = ap.parse_args()

    user = _user(args.email)
    profile = user.get("profile") or {}
    profile = {**profile, "name": user.get("name") or "", "email": user.get("email") or ""}
    skills = profile.get("skills") or []
    if isinstance(skills, str):
        skills = json.loads(skills or "[]")

    resume_path = ""
    try:
        import resume_parse

        resume_path = resume_parse.find_resume_file(user["id"]) or ""
    except Exception:  # noqa: BLE001
        pass
    print(f"resume: {resume_path or '(none found)'}")
    print(f"stored name: {profile.get('name')!r}")

    reports = []
    for url in args.url:
        rep = inspect(url, profile, skills, resume_path)
        reports.append(rep)
        print(f"\n=== {url}")
        print(f"    landed on: {rep.get('form_url')}")
        print(f"    resume uploaded: {rep.get('resume_uploaded')}  error: {rep.get('error') or '-'}")
        for p in rep.get("prefilled_by_vendor") or []:
            print(f"    PREFILLED  {p['label'][:40]!r:44} name={p['name'][:26]!r:28} = {p['value']!r}")
        for f in rep.get("fields") or []:
            print(f"    FIELD  {f['label'][:40]!r:44} [{f['kind']}{'*' if f['required'] else ''}]"
                  f" <- {str(f['answer'])[:60]!r} ({f['source']})")
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(reports, fh, indent=2, ensure_ascii=False)
        print(f"\nwrote {args.json}")


if __name__ == "__main__":
    main()
