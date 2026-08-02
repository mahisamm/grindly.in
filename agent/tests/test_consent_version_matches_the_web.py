"""The agent and the web must agree on which consent wording is current.

They are two constants, in two languages, that must hold one value between
them — and on 2026-08-01 they drifted. The TypeScript side was bumped to
2026-08-01 when the setup wording changed; agent/readiness.py was left at
2026-07-25.

The consequence was total and silent. The web wrote consent_version=2026-08-01
onto the profile. The agent compared it against 2026-07-25, decided consent was
incomplete, and held every run. That morning it discovered 109 listings, scored
18 matches, routed 14 of them to real employer application pages — and sent
nothing. The dashboard showed rows marked "matched" and a funnel reading
banked_for_user=18, which is exactly what a healthy queue looks like.

A comment saying "keep these in step" was already present in both files. It did
not work, because nothing checked. This does.
"""
import pathlib
import re

import readiness

_TS = (pathlib.Path(__file__).resolve().parents[2]
       / "src" / "lib" / "readiness.ts")


def _web_consent_version() -> str:
    src = _TS.read_text(encoding="utf-8")
    m = re.search(r'export\s+const\s+CONSENT_VERSION\s*=\s*["\']([^"\']+)["\']', src)
    assert m, f"could not find CONSENT_VERSION in {_TS}"
    return m.group(1)


def test_the_agent_and_the_web_agree_on_the_current_consent_version():
    """If this fails, the agent is silently refusing to send for every user
    whose consent the web considers current. Bump the other one."""
    assert readiness.CONSENT_VERSION == _web_consent_version(), (
        f"agent/readiness.py says {readiness.CONSENT_VERSION!r} but "
        f"src/lib/readiness.ts says {_web_consent_version()!r} — the agent will "
        "hold every run with 'setup incomplete: consent' while the dashboard "
        "shows healthy-looking banked matches"
    )


def _user(consent_version):
    return {
        "name": "A Student", "email": "a@b.test",
        "profile": {
            "resume_name": "cv.pdf", "phone": "9876543210",
            "education": "B.Tech", "grad_year": 2026,
            "preferred_domains": ["Web Development"],
            "auto_apply": True,
            "auto_apply_consent_at": "2026-08-01T10:00:00Z",
            "consent_version": consent_version,
        },
    }


def test_a_profile_on_the_current_version_is_ready():
    ready, missing = readiness.check(_user(readiness.CONSENT_VERSION))
    assert ready is True, missing


def test_a_profile_on_older_wording_is_held_for_consent():
    """The protection this constant exists for: agreeing to v1 is not agreeing
    to v2, so an account on stale wording must stop until it re-agrees."""
    ready, missing = readiness.check(_user("2020-01-01"))
    assert ready is False
    assert "consent" in missing
