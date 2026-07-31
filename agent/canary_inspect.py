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


def inspect(url: str, profile: dict, skills: list[str], resume_path: str,
            do_fill: bool = False) -> dict:
    """Open the form the way channel_ats does and report what it sees.

    With `do_fill`, it also TYPES the answers in and then asks the browser which
    controls still fail validation — the same question `channel_ats` now asks
    before it clicks. That is the only way to see a rejection coming without
    filing a real application to find out: reading the form tells you what was
    intended, filling it tells you what actually landed, and the two came apart
    on every submit that was refused.

    It still never clicks submit.
    """
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
            # A field we could not read a question for is the one worth the most
            # detail: it is required often enough to block a submit, and the
            # stored record shows nothing but an empty string.
            debug = ""
            if questions.unreadable_label(f["label"]):
                try:
                    debug = f["el"].evaluate(
                        # Raw: this is JavaScript, and \s is a regex escape, not
                        # a Python one. Python 3.12 warns on it and a future
                        # version makes it an error.
                        r"""e => {
                          const g = e.closest('div,fieldset,section') || e.parentElement;
                          return JSON.stringify({
                            name: e.getAttribute('name') || '',
                            id: e.id || '',
                            type: e.getAttribute('type') || '',
                            cls: (e.className || '').slice(0, 80),
                            placeholder: e.getAttribute('placeholder') || '',
                            labelledby: e.getAttribute('aria-labelledby') || '',
                            describedby: e.getAttribute('aria-describedby') || '',
                            around: (g ? g.innerText : '').trim().replace(/\s+/g, ' ').slice(0, 160),
                            html: (g ? g.outerHTML : '').replace(/\s+/g, ' ').slice(0, 300)
                          });
                        }"""
                    )
                except Exception:  # noqa: BLE001
                    debug = ""
            out["fields"].append({
                "debug": debug,
                "label": f["label"],
                "kind": f["kind"],
                "required": f["required"],
                "options": f["options"][:6],
                "answer": a["answer"],
                "source": a["source"],
                "paired_question": a["question"],
            })
        out["prefilled_by_vendor"] = _prefilled(page)

        if do_fill:
            out["filled_count"] = questions.fill(
                page, fields, answers, channel_ats._human_type
            )
            page.wait_for_timeout(1200)
            for f, rec in zip(out["fields"], fields):
                f["value_after_fill"] = questions.live_value(rec["el"])
            submit = None
            for sel in channel_ats._SUBMIT_CANDIDATES:
                try:
                    el = page.query_selector(sel)
                except Exception:  # noqa: BLE001
                    continue
                if el:
                    submit = el
                    break
            out["submit_found"] = submit is not None
            out["blockers"] = questions.form_blockers(page, submit)
            out["unfilled_required"] = questions.unfilled_required(fields)
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
    ap.add_argument(
        "--fill",
        action="store_true",
        help="also type the answers in and report what the form would refuse "
             "(still never clicks submit)",
    )
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
        rep = inspect(url, profile, skills, resume_path, do_fill=args.fill)
        reports.append(rep)
        print(f"\n=== {url}")
        print(f"    landed on: {rep.get('form_url')}")
        print(f"    resume uploaded: {rep.get('resume_uploaded')}  error: {rep.get('error') or '-'}")
        for p in rep.get("prefilled_by_vendor") or []:
            print(f"    PREFILLED  {p['label'][:40]!r:44} name={p['name'][:26]!r:28} = {p['value']!r}")
        for f in rep.get("fields") or []:
            print(f"    FIELD  {f['label'][:40]!r:44} [{f['kind']}{'*' if f['required'] else ''}]"
                  f" <- {str(f['answer'])[:60]!r} ({f['source']})")
            if args.fill:
                print(f"        AFTER FILL: {str(f.get('value_after_fill'))[:70]!r}")
            if f.get("debug"):
                print(f"        UNREADABLE: {f['debug'][:420]}")
        if args.fill:
            print(f"    filled: {rep.get('filled_count')}  submit button found: {rep.get('submit_found')}")
            for b in rep.get("blockers") or []:
                print(f"    BLOCKER  {b}")
            for u in rep.get("unfilled_required") or []:
                print(f"    STILL EMPTY (required)  {u}")
            if not rep.get("blockers") and not rep.get("unfilled_required"):
                print("    -> form is submit-ready")
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(reports, fh, indent=2, ensure_ascii=False)
        print(f"\nwrote {args.json}")


if __name__ == "__main__":
    main()
