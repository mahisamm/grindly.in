"""Tests for the remote-browser connect service's session lifecycle.

Focus: the head-of-line-deadlock fix — a connect session that fails/times out
MUST move the integration row off 'connecting' to a terminal state, or
next_pending_connect_request() keeps re-selecting the same dead row forever
and no other user's connect request is ever served.
"""
import connect_service


class _FakeProc:
    def __init__(self, *a, **k):
        self.terminated = False

    def terminate(self):
        self.terminated = True

    def wait(self, timeout=None):
        return 0

    def kill(self):
        pass


def _patch_common(monkeypatch, connect_returns):
    """Stub out everything with real side effects (subprocess, sleep, token
    file, DB writes) so _run_session runs purely in memory. Returns a dict
    recording set_integration_status calls."""
    calls = {"status": [], "set_token": 0, "clear_token": 0, "token_file": []}

    monkeypatch.setattr(connect_service.subprocess, "Popen", lambda *a, **k: _FakeProc())
    monkeypatch.setattr(connect_service.time, "sleep", lambda *_: None)
    monkeypatch.setattr(connect_service, "_write_token_file", lambda tok: calls["token_file"].append(tok))
    monkeypatch.setattr(connect_service.connect_platform, "connect", lambda *a, **k: connect_returns)
    monkeypatch.setattr(connect_service.db, "time_from_now_db", lambda ms: 999999)
    monkeypatch.setattr(connect_service.db, "set_connect_token",
                        lambda *a, **k: calls.__setitem__("set_token", calls["set_token"] + 1))
    monkeypatch.setattr(connect_service.db, "clear_connect_token",
                        lambda *a, **k: calls.__setitem__("clear_token", calls["clear_token"] + 1))
    monkeypatch.setattr(connect_service.db, "set_integration_status",
                        lambda uid, platform, status: calls["status"].append((uid, platform, status)))
    return calls


def test_failed_session_sets_terminal_status_not_stuck_connecting(monkeypatch):
    # connect() returns False (user walked away / timed out) — the row MUST
    # be moved to 'disconnected' so the queue doesn't deadlock on it.
    calls = _patch_common(monkeypatch, connect_returns=False)
    connect_service._run_session("u1", "linkedin")
    assert ("u1", "linkedin", "disconnected") in calls["status"]


def test_successful_session_does_not_force_disconnected(monkeypatch):
    # connect() returns True — connect_platform.connect() already set
    # 'connected' itself; _run_session must NOT stomp it back to disconnected.
    calls = _patch_common(monkeypatch, connect_returns=True)
    connect_service._run_session("u1", "linkedin")
    assert ("u1", "linkedin", "disconnected") not in calls["status"]


def test_session_always_clears_token_on_exit(monkeypatch):
    # Whether it succeeds or fails, the token must be cleared from both DB and
    # the websockify token file when the session ends (no lingering access).
    calls = _patch_common(monkeypatch, connect_returns=False)
    connect_service._run_session("u1", "naukri")
    assert calls["clear_token"] == 1
    assert calls["token_file"][-1] is None  # last write clears the file


def test_token_is_issued_only_after_vnc_processes_start(monkeypatch):
    # Ordering guard for the race fix: the token must be published (set_token)
    # after the display/VNC subprocesses are up, never before.
    order = []
    monkeypatch.setattr(connect_service.time, "sleep", lambda *_: None)
    monkeypatch.setattr(connect_service, "_write_token_file", lambda tok: order.append("token_file") if tok else None)
    monkeypatch.setattr(connect_service.connect_platform, "connect", lambda *a, **k: False)
    monkeypatch.setattr(connect_service.db, "time_from_now_db", lambda ms: 1)
    monkeypatch.setattr(connect_service.db, "set_connect_token", lambda *a, **k: order.append("set_token"))
    monkeypatch.setattr(connect_service.db, "clear_connect_token", lambda *a, **k: None)
    monkeypatch.setattr(connect_service.db, "set_integration_status", lambda *a, **k: None)

    def _popen(*a, **k):
        order.append("popen")
        return _FakeProc()

    monkeypatch.setattr(connect_service.subprocess, "Popen", _popen)

    connect_service._run_session("u1", "unstop")
    # two Popen calls (Xvfb, x11vnc) must both precede the token being set
    assert order.index("set_token") > order.index("popen")
    assert order.count("popen") == 2
    assert order.index("set_token") > _last_index(order, "popen")


def _last_index(seq, val):
    return len(seq) - 1 - seq[::-1].index(val)
