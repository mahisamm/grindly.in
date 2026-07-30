"""Run the apply path for real — everything except the click. Writes nothing.

`discovery_probe` answers "what can the agent find?". This answers the question
the user actually asked next: "and can it finish those on its own?".

The only honest way to know is to do it. Not to reason about the code, not to
count vendors we have adapters for — open the employer's real application page,
upload the real resume, answer the real screening questions with the real
question engine, and stop with the cursor over the submit button. Everything
before that click is reversible and invisible to the employer; the click is
neither, so the probe never makes it.

    python agent/apply_probe.py --email you@example.com --runs 10
    python agent/apply_probe.py --email you@example.com --json out.json

What it guarantees
------------------
  * No submit is ever clicked. `_NEVER_SUBMIT` is checked at the one place a
    click could happen, and the report carries `submitted: false` per listing so
    the grade can verify the invariant rather than trust this docstring.
  * Nothing is persisted: no jobs, no applications, no run row, no idempotency
    claim, no daily-usage slot. A probe must never put work on a dashboard or
    consume the user's quota.
  * The resume IS uploaded to the employer's form. That is a local file-input
    assignment — the browser holds it until a submit that never comes.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import apply_score  # noqa: E402
import db  # noqa: E402
import flags  # noqa: E402
import hosts  # noqa: E402
import matcher  # noqa: E402
import questions  # noqa: E402
import resolver  # noqa: E402
import resume_parse  # noqa: E402
import safety  # noqa: E402
import worker  # noqa: E402

# The invariant, as a constant rather than as a comment, so the one branch that
# could ever click reads like what it is.
_NEVER_SUBMIT = True


def _user_by_email(email: str) -> dict | None:
    with db.conn() as c:
        row = c.execute(
            "SELECT id, email, name FROM users WHERE lower(email)=?", (email.lower(),)
        ).fetchone()
        return dict(row) if row else None


def _jlist(v) -> list:
    if not v:
        return []
    try:
        return json.loads(v) if isinstance(v, str) else list(v)
    except Exception:  # noqa: BLE001
        return []


# ---- answer provenance ------------------------------------------------------

def _classify_stall(missing: list[str], profile: dict) -> dict:
    """Two very different failures wear the same face on a dashboard.

    "Could not answer a required question" can mean the agent failed to read a
    form it should have understood — its problem — or that the form asked for a
    fact about the candidate that the candidate has never given us: their class
    12 percentage, their current salary, their date of birth. The second is not
    fixable by better code, and refusing is the correct behaviour. It IS fixable
    once, by the user, for every future application at the same time — so it has
    to be told apart and named, not buried in a count.
    """
    gaps = [questions.missing_fact_for(label, profile) for label in missing]
    named = sorted({g for g in gaps if g})
    if named and all(gaps):
        return {
            "outcome": "waiting_on_a_fact_you_have_not_given",
            "detail": "needs: " + ", ".join(named),
            "required_unanswered": missing[:6],
            "missing_profile_facts": named,
        }
    return {
        "outcome": "unanswered_required",
        "detail": "; ".join(missing[:3]),
        "required_unanswered": missing[:6],
        "missing_profile_facts": named,
    }


def _invented(fields: list[dict], answers: list[dict]) -> int:
    """Answers that state something we do not actually know.

    Should always be zero — `questions.answer_fields` refuses rather than
    invents, and this is the check that the refusal actually holds on real
    forms rather than only in the unit tests. Two ways it could break:

      * a field the engine itself marked `unanswerable` came back non-empty
      * the generic fallback paragraph landed in a box asking for a FACT
        ("Class 12 percentage", "Do you hold a B.Tech?"), where a paragraph is
        both nonsense and an implied claim
    """
    bad = 0
    for rec in answers:
        text = (rec.get("answer") or "").strip()
        if not text:
            continue
        if rec.get("source") == "unanswerable":
            bad += 1
            continue
        label = fields[rec["_i"]]["label"] or ""
        if rec.get("source") == "fallback" and (
            questions._FACTUAL_CLAIM.search(label) or questions._WANTS_A_DATUM.search(label)
        ):
            bad += 1
    return bad


# ---- the ATS dry run --------------------------------------------------------

def _dry_run_ats(url: str, job: dict, profile: dict, skills: list[str],
                 resume_path: str, letter: str) -> dict:
    """Drive a real ATS application page up to (never through) the submit.

    Deliberately reuses channel_ats's own helpers instead of reimplementing the
    steps: a probe that walks a different path than the sender measures a
    program nobody runs.
    """
    import channel_ats

    from playwright.sync_api import sync_playwright

    out: dict = {
        "channel": "ats", "outcome": "", "detail": "", "submitted": False,
        "answers_total": 0, "invented_answers": 0, "required_unanswered": [],
        "seconds": 0.0,
    }
    t0 = time.time()
    pw = sync_playwright().start()
    browser = None
    try:
        try:
            browser = pw.chromium.launch(
                headless=channel_ats._headless(),
                args=["--disable-blink-features=AutomationControlled"],
            )
        except Exception as e:  # noqa: BLE001
            out.update(outcome="browser_failed", detail=str(e)[:140])
            return out

        import stealth

        ctx = browser.new_context(
            user_agent=stealth.random_ua(),
            viewport=stealth.random_viewport(),
            accept_downloads=False,
        )
        stealth.apply_stealth(ctx)
        page = ctx.new_page()

        try:
            page.goto(url, timeout=channel_ats._NAV_TIMEOUT_MS, wait_until="domcontentloaded")
        except Exception as e:  # noqa: BLE001
            out.update(outcome="nav_failed", detail=str(e)[:140])
            return out
        try:
            page.wait_for_load_state("networkidle", timeout=15000)
        except Exception:  # noqa: BLE001
            pass

        channel_ats._dismiss_consent(page)

        try:
            landed = page.url or ""
        except Exception:  # noqa: BLE001
            landed = ""
        if channel_ats._looks_gone(url, landed):
            out.update(outcome="closed", detail=f"posting is gone — landed on {landed[:90]}")
            return out

        body = channel_ats._page_text(page)
        if channel_ats._CLOSED_RE.search(body[:4000]):
            out.update(outcome="closed", detail="listing is no longer accepting applications")
            return out
        if safety.detect_challenge(page) == safety.FAILURE_REASON.CAPTCHA:
            out.update(outcome="challenge", detail="page showed a human-check")
            return out

        uploads = channel_ats.open_the_form(page, url)
        try:
            landed = page.url or ""
        except Exception:  # noqa: BLE001
            landed = ""
        out["form_url"] = landed[:140]
        if not uploads and channel_ats._looks_gone(url, landed):
            out.update(outcome="closed", detail=f"posting is gone — landed on {landed[:90]}")
            return out
        if not uploads:
            out.update(outcome="no_form", detail="no file input on the page")
            return out
        if not channel_ats._attach_resume(page, uploads, resume_path):
            out.update(outcome="resume_rejected", detail="form would not take the upload")
            return out

        fields = questions.read_fields(page)
        answers: list[dict] = []
        if fields:
            answers = questions.answer_fields(
                fields, profile=profile, resume_text=profile.get("resume_text") or "",
                skills=skills, job=job, name=profile.get("name") or "",
                email=profile.get("email") or "",
            )
            channel_ats._apply_cover_letter(fields, answers, letter)
        out["answers_total"] = len(answers)
        out["invented_answers"] = _invented(fields, answers)

        missing = channel_ats._unanswered_required(fields, answers)
        if missing:
            out.update(**_classify_stall(missing, profile))
            return out

        import selector_ai

        submit = selector_ai.find_element(page, "submit application button",
                                          channel_ats._SUBMIT_CANDIDATES)
        if not submit:
            out.update(outcome="no_submit_button", detail="submit control not found")
            return out

        # The whole point of the probe. Everything above this line is reversible.
        if _NEVER_SUBMIT:
            out.update(outcome="submit_ready",
                       detail="form complete, submit located — stopped without clicking")
            return out
        raise AssertionError("apply_probe must never submit")   # unreachable by design
    except Exception as e:  # noqa: BLE001
        out.update(outcome="error", detail=f"{type(e).__name__}: {e}"[:160])
        return out
    finally:
        out["seconds"] = round(time.time() - t0, 1)
        try:
            if browser is not None:
                browser.close()
        except Exception:  # noqa: BLE001
            pass
        try:
            pw.stop()
        except Exception:  # noqa: BLE001
            pass


# ---- the Google Form dry run ------------------------------------------------

def _dry_run_google_form(url: str, job: dict, profile: dict, skills: list[str]) -> dict:
    """Same question, no browser. A Google Form publishes its own schema, so the
    whole check is one GET plus the question engine."""
    import channel_google_form as gform

    out: dict = {
        "channel": "google_form", "outcome": "", "detail": "", "submitted": False,
        "answers_total": 0, "invented_answers": 0, "required_unanswered": [],
        "seconds": 0.0,
    }
    t0 = time.time()
    try:
        html, final_url = gform._get(url)
        if not html:
            out.update(outcome="nav_failed", detail="form did not load")
            return out
        if gform._SIGNIN_RE.search(final_url or ""):
            out.update(outcome="sign_in_required", detail="form is restricted to signed-in users")
            return out
        schema = gform.parse_form(html)
        if not schema:
            out.update(outcome="no_form", detail="could not read the form schema")
            return out
        block = gform.blocking_reason(schema)
        if block:
            out.update(outcome="unsupported_field", detail=block)
            return out

        fields = gform._to_question_fields(schema.get("fields") or [])
        answers = questions.answer_fields(
            fields, profile=profile, resume_text=profile.get("resume_text") or "",
            skills=skills, job=job, name=profile.get("name") or "",
            email=profile.get("email") or "",
        )
        out["answers_total"] = len(answers)
        out["invented_answers"] = _invented(fields, answers)
        answered = {r["_i"] for r in answers if (r.get("answer") or "").strip()}
        missing = [
            (f["label"] or "(unlabelled)")[:60]
            for i, f in enumerate(fields) if f.get("required") and i not in answered
        ]
        if missing:
            out.update(**_classify_stall(missing, profile))
            return out
        out.update(outcome="submit_ready", detail="every required question answered — not posted")
        return out
    except Exception as e:  # noqa: BLE001
        # A 401 or 403 is the form telling us it is for signed-in people only.
        # That is the employer's choice, not a fault in the agent, and it was
        # being counted as a crash — inflating a failure nobody could avoid.
        if any(code in str(e) for code in ("401", "403")):
            out.update(outcome="sign_in_required",
                       detail="form refuses anonymous access (HTTP 401/403)")
            return out
        out.update(outcome="error", detail=f"{type(e).__name__}: {e}"[:160])
        return out
    finally:
        out["seconds"] = round(time.time() - t0, 1)


# ---- the probe --------------------------------------------------------------

def probe(email: str, *, found: int, runs: int, with_boards: bool = False) -> dict:
    user = _user_by_email(email)
    if not user:
        raise SystemExit(f"no account for {email}")
    full = db.get_user(user["id"]) or {}
    profile = full.get("profile") or {}
    skills = _jlist(profile.get("skills"))
    plan = worker.build_plan(profile, skills, cap=found, user=full)
    kw_sets = worker._expand_search_keywords(plan["domains"], skills)

    apply_profile = {
        **profile,
        "name": full.get("name") or user.get("name") or "",
        "email": full.get("email") or user.get("email") or "",
    }
    resume_path = resume_parse.find_resume_file(user["id"])

    sources = [s for s in worker.ALWAYS_ON_SOURCES if flags.source_enabled(s)]
    if with_boards:
        sources = worker._platforms_for_today(
            user["id"], [s for s in worker.DISCOVERY_PLATFORMS if flags.source_enabled(s)]
        ) + sources

    jobs: list[dict] = []
    for src in sources:
        mod = worker._load_module(src)
        if mod is None:
            continue
        errors: dict[str, str] = {}
        try:
            _, got = worker._fetch_source_all_kw(
                src, mod, kw_sets, max(8, found), user["id"], errors
            )
            jobs.extend(got)
        except Exception as e:  # noqa: BLE001
            print(f"[probe] {src} failed: {type(e).__name__}: {e}")
        finally:
            close = getattr(mod, "close", None)
            if callable(close):
                try:
                    close(user["id"])
                except Exception:  # noqa: BLE001
                    pass

    threshold = plan["min_match_score"]
    rows: list[dict] = []
    seen: set[str] = set()
    for j in jobs:
        url = j.get("url") or ""
        if not url or url in seen:
            continue
        seen.add(url)
        score, reason = matcher.score_job(
            j, skills, plan["domains"], profile.get("experience_level"), j.get("jd_text", "")
        )
        dest = resolver.resolve(j, j.get("jd_text") or "")
        rows.append({
            "title": j.get("title", ""),
            "company": j.get("company", ""),
            "url": url,
            "source": j.get("source", ""),
            "host_class": j.get("host_class") or hosts.classify(url),
            "skills": j.get("skills", [])[:8],
            "score": score,
            "passes_threshold": score >= threshold,
            "jd_text": j.get("jd_text") or "",
            "channel": dest.get("channel"),
            "tier": dest.get("tier"),
            "target": dest.get("target"),
            "vendor": dest.get("vendor"),
            "evidence": dest.get("evidence"),
            "deliverable": worker.channel_deliverable(dest),
            "confirmation_known": _confirmation_known(dest),
        })
    rows.sort(key=lambda r: (-int(bool(r["tier"] == "A")), -r["score"]))

    # Dry-run the best submittable ones, newest scoring first — the same order a
    # live run would have reached them in.
    budget = runs
    for r in rows:
        if budget <= 0:
            break
        if r["tier"] != "A" or not r["target"] or not r["deliverable"]:
            continue
        job = {"title": r["title"], "company": r["company"], "url": r["url"],
               "skills": r["skills"], "source": r["source"]}
        letter = f"I am applying for the {r['title']} role at {r['company']}."
        if r["channel"] == resolver.CHANNEL_ATS:
            if not resume_path or not os.path.exists(resume_path or ""):
                r["dry_run"] = {"channel": "ats", "outcome": "no_resume",
                                "detail": "no resume file on the account",
                                "submitted": False, "answers_total": 0,
                                "invented_answers": 0, "seconds": 0.0}
            else:
                r["dry_run"] = _dry_run_ats(
                    r["target"], job, apply_profile, skills, resume_path, letter
                )
        elif r["channel"] == resolver.CHANNEL_GOOGLE_FORM:
            r["dry_run"] = _dry_run_google_form(r["target"], job, apply_profile, skills)
        else:
            continue
        budget -= 1
        print(f"[probe] {r['dry_run']['outcome']:<20} {r['company'][:28]:<30} {r['title'][:44]}")

    for r in rows:
        r.pop("jd_text", None)

    rep = {
        "user": {"email": user["email"], "id": user["id"]},
        "flags": flags.snapshot(),
        "auto_apply_mode": safety.auto_apply_mode(),
        "resume_on_file": bool(resume_path and os.path.exists(resume_path or "")),
        "sources_run": sources,
        "keyword_sets": kw_sets,
        "listings": rows,
        "total_found": len(rows),
        "dry_runs_attempted": runs - budget,
    }
    rep["grade"] = apply_score.score(rep)
    return rep


def _confirmation_known(dest: dict) -> bool:
    """Do we have a success signal specific to this destination's vendor?"""
    channel = dest.get("channel")
    if channel == resolver.CHANNEL_GOOGLE_FORM:
        return True          # a Google Form POST answers with its own confirm page
    if channel != resolver.CHANNEL_ATS:
        return False
    try:
        import channel_ats
        return bool(channel_ats.vendor_success_selectors(dest.get("vendor") or ""))
    except Exception:  # noqa: BLE001
        return False


def _print(rep: dict) -> None:
    g = rep["grade"]
    print(f"\nuser            {rep['user']['email']}")
    print(f"mode            {rep['auto_apply_mode']}   flags {rep['flags']}")
    print(f"resume on file  {rep['resume_on_file']}")
    print(f"listings        {rep['total_found']}   dry runs {rep['dry_runs_attempted']}")
    print()
    print(apply_score.explain(g))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--email", required=True)
    ap.add_argument("--found", type=int, default=40,
                    help="how many listings discovery should look for")
    ap.add_argument("--runs", type=int, default=10,
                    help="how many application pages to dry-run")
    ap.add_argument("--boards", action="store_true", help="include today's board rotation")
    ap.add_argument("--json", help="write the full report here")
    args = ap.parse_args()

    rep = probe(args.email, found=args.found, runs=args.runs, with_boards=args.boards)
    _print(rep)
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(rep, fh, indent=2, ensure_ascii=False)
        print(f"wrote {args.json}")


if __name__ == "__main__":
    main()
