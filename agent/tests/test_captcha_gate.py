"""Stop before the click when a human check is in the way.

Measured in production: Botsync's Workable form filled completely, passed every
required-field check, and was clicked — into an unticked Cloudflare "Verify you
are human" box. The button sat on "Submitting…" forever, the application was
recorded as failed, and a real daily slot was spent on something no employer
saw. Tier A had sent 0 of 4 attempts this way.

The design constraint that shapes the detector: an earlier text-based check
("does this page mention captcha?") refused SEVEN of eight perfectly good
applications, because ATS pages mention captcha in their privacy blurb. So this
keys on a widget with an empty response TOKEN — the vendor's own widget writes
that token on success, making empty/non-empty unambiguous.
"""
import questions


class FakePage:
    def __init__(self, result):
        self._result = result

    def evaluate(self, _js):
        if isinstance(self._result, Exception):
            raise self._result
        return self._result


def test_a_named_check_is_reported():
    assert questions.unsolved_captcha(FakePage("Cloudflare human check")) == \
        "Cloudflare human check"


def test_a_clean_page_is_not_blocked():
    assert questions.unsolved_captcha(FakePage("")) == ""


def test_an_unreadable_page_fails_open():
    """A detector that blocked every application whenever evaluation hiccuped
    would be worse than the problem it solves."""
    assert questions.unsolved_captcha(FakePage(RuntimeError("detached"))) == ""
    assert questions.unsolved_captcha(FakePage(None)) == ""


# --- the detector's own rules, asserted against its source -------------------
# The logic runs in the browser, so these pin the properties that keep it from
# regressing into the text-matching version that refused real applications.

def test_it_keys_on_a_token_never_on_page_text():
    js = questions._CAPTCHA_JS
    assert "cf-turnstile-response" in js
    assert "g-recaptcha-response" in js
    assert "h-captcha-response" in js
    # The failure mode being guarded against: matching prose.
    assert "innerText" not in js
    assert "textContent" not in js


def test_a_solved_widget_does_not_block():
    """Non-empty token means the user (or a prior step) already passed it."""
    js = questions._CAPTCHA_JS
    assert "(token.value || '').trim()" in js


def test_a_hidden_widget_does_not_block():
    """Plenty of pages ship an inert widget that is never asked of us."""
    js = questions._CAPTCHA_JS
    assert "getBoundingClientRect" in js
    assert "width === 0" in js


def test_all_three_major_vendors_are_covered():
    js = questions._CAPTCHA_JS
    for host in ("challenges.cloudflare.com", "/recaptcha/", "hcaptcha.com"):
        assert host in js


# --- and the sender stops at the right moment --------------------------------

def test_the_gate_runs_before_submit_is_attempted():
    """Returning before `submit_attempted` is the entire point: it refunds the
    daily slot and the idempotency claim, and lets the listing be handed to the
    user's own browser."""
    import inspect

    import channel_ats

    src = inspect.getsource(channel_ats.apply)
    gate = src.index("unsolved_captcha")
    attempted = src.index('record["submit_attempted"] = True')
    assert gate < attempted, "the captcha check must precede the point of no return"


def test_the_sender_never_tries_to_solve_it():
    import inspect

    import channel_ats

    src = inspect.getsource(channel_ats)
    for forbidden in ("2captcha", "anticaptcha", "solve_captcha", "captcha_solver"):
        assert forbidden not in src.lower()
