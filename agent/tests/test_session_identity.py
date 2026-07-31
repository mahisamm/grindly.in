"""A saved login must be reusable by the process that saved it — and by every
process after that.

Two bugs met here in production. `connect` reported "Internshala login detected
— session saved" and wrote the account connected; twenty-five minutes later every
application on that account failed with "not signed in to Internshala". Both
halves were confidently wrong:

  * the profile was re-opened under a different browser each launch, because the
    apply drivers drew a random user agent per launch while the connect flow
    hardcoded one — so four logins in five were saved as one browser and
    presented as another, and the platform dropped the session;
  * the two sides asked "is this signed in?" in two different ways, so they
    could disagree, and did.
"""
import json
import os

import pytest

import connect_platform
import internshala
import stealth


# --- one identity per profile, for the life of the profile ------------------

def test_identity_is_stable_across_launches(tmp_path):
    profile = str(tmp_path / "internshala")
    first = stealth.profile_identity(profile)
    for _ in range(20):
        assert stealth.profile_identity(profile) == first


def test_identity_is_written_where_the_next_process_finds_it(tmp_path):
    profile = str(tmp_path / "internshala")
    ident = stealth.profile_identity(profile)
    saved = json.loads(
        (tmp_path / "internshala" / "grindly_identity.json").read_text(encoding="utf-8")
    )
    assert saved["user_agent"] == ident["user_agent"]
    assert saved["viewport"] == ident["viewport"]


def test_identity_is_a_usable_browser_identity(tmp_path):
    ident = stealth.profile_identity(str(tmp_path / "p"))
    assert ident["user_agent"].startswith("Mozilla/")
    assert ident["viewport"]["width"] > 0 and ident["viewport"]["height"] > 0


def test_separate_profiles_get_their_own_identity(tmp_path, monkeypatch):
    # Not the same identity for everyone: one shared user agent across the whole
    # fleet would cluster every Grindly user behind one fingerprint.
    seen = set()
    for i in range(12):
        seen.add(stealth.profile_identity(str(tmp_path / f"u{i}"))["user_agent"])
    assert len(seen) > 1


def test_a_corrupt_identity_file_does_not_break_the_launch(tmp_path):
    profile = tmp_path / "internshala"
    profile.mkdir()
    (profile / "grindly_identity.json").write_text("{not json", encoding="utf-8")
    ident = stealth.profile_identity(str(profile))
    assert ident["user_agent"].startswith("Mozilla/")


def test_a_half_written_identity_is_replaced_not_returned(tmp_path):
    profile = tmp_path / "internshala"
    profile.mkdir()
    (profile / "grindly_identity.json").write_text('{"user_agent": ""}', encoding="utf-8")
    ident = stealth.profile_identity(str(profile))
    assert ident["user_agent"].startswith("Mozilla/")
    assert ident["viewport"]["width"] > 0


def test_identity_survives_a_read_only_profile_dir(tmp_path, monkeypatch):
    # If the identity cannot be persisted the launch must still work; it just
    # cannot promise stability, which is strictly better than refusing to run.
    def _boom(*a, **k):
        raise OSError("read-only file system")

    monkeypatch.setattr(os, "open", _boom)
    ident = stealth.profile_identity(str(tmp_path / "p"))
    assert ident["user_agent"].startswith("Mozilla/")


# --- one answer to "is this account signed in?" -----------------------------

class _FakePage:
    """Just enough page for the login test: a set of selectors that match."""

    def __init__(self, present=(), url="https://internshala.com/internships/"):
        self._present = set(present)
        self.url = url
        self.visits = []

    def query_selector(self, sel):
        return object() if sel in self._present else None

    def goto(self, url, **kw):
        self.visits.append(url)
        self.url = url

    def wait_for_timeout(self, _ms):
        pass


def test_logged_out_page_is_read_as_logged_out():
    assert internshala.is_logged_in(_FakePage()) is False
    assert internshala._is_logged_out(_FakePage()) is True


@pytest.mark.parametrize("marker", internshala.LOGGED_IN_MARKERS)
def test_any_account_marker_counts_as_signed_in(marker):
    page = _FakePage(present=[marker])
    assert internshala.is_logged_in(page) is True
    assert internshala._is_logged_out(page) is False


def test_the_word_logout_in_the_html_is_not_evidence():
    # The old test searched the whole document for the string "logout". A page
    # can mention it in a script URL, an analytics payload or a hidden template
    # while showing no account at all — and a real signed-in listing page said
    # "login" 27 times and "logout" zero times, which is how the account menu
    # sitting on screen counted as proof of being signed out.
    page = _FakePage()
    page.content = lambda: "<script>var logoutUrl='/logout';</script>"
    assert internshala.is_logged_in(page) is False


# --- connect and apply cannot disagree --------------------------------------

def test_connect_uses_the_apply_drivers_own_test():
    check = connect_platform._PLATFORMS["internshala"]["check"]
    assert check(_FakePage()) is False
    assert check(_FakePage(present=["#name_box"])) is True


def test_connect_verifies_on_the_page_apply_actually_opens():
    cfg = connect_platform._PLATFORMS["internshala"]
    page = _FakePage(present=["#name_box"])
    assert connect_platform._survives_reload(page, cfg) is True
    assert page.visits == [cfg["verify_url"]]


def test_a_login_that_does_not_survive_the_reload_is_not_a_connection():
    cfg = connect_platform._PLATFORMS["internshala"]

    class _Fades(_FakePage):
        def goto(self, url, **kw):
            super().goto(url, **kw)
            self._present = set()          # the platform dropped the session

    assert connect_platform._survives_reload(_Fades(present=["#name_box"]), cfg) is False


def test_a_failed_verification_navigation_is_not_a_connection():
    cfg = connect_platform._PLATFORMS["internshala"]

    class _Dead(_FakePage):
        def goto(self, url, **kw):
            raise RuntimeError("net::ERR_CONNECTION_RESET")

    assert connect_platform._survives_reload(_Dead(present=["#name_box"]), cfg) is False
