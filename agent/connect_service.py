"""Concurrent remote-browser login service for hosted Grindly users.

Each session gets its own X display, VNC port, browser profile, and short-lived
token. Database claims and a shared token map let multiple users connect without
seeing each other's browser or blocking behind one five-minute login window.
"""
from __future__ import annotations

import concurrent.futures
import os
import secrets
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(__file__))
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

import connect_platform
import db

log_prefix = "[connect_service]"

DISPLAY_NUM = 100
VNC_PORT = 5901
TOKEN_FILE = os.path.join(os.path.dirname(__file__), "..", "data", "vnc-tokens.txt")
# 7 min, not 5: a first login from the server IP almost always triggers an
# email verification code (LinkedIn/Naukri "quick verification"). The user has
# to leave, open their inbox, and type it back — 5 min ran too tight and could
# close the window mid-verification, losing the login.
SESSION_TIMEOUT_SEC = 420
POLL_INTERVAL_SEC = 3
MAX_SESSIONS = max(1, int(os.environ.get("GRINDLY_CONNECT_MAX_SESSIONS", "2")))

_token_lock = threading.Lock()
_token_targets: dict[str, int] = {}
_session = threading.local()


def _flush_token_file() -> None:
    os.makedirs(os.path.dirname(TOKEN_FILE), exist_ok=True)
    temporary = f"{TOKEN_FILE}.tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        for token, port in _token_targets.items():
            handle.write(f"{token}: 127.0.0.1:{port}\n")
    os.replace(temporary, TOKEN_FILE)


def _write_token_file(token: str | None) -> None:
    """Add/remove this thread's token while preserving every other session."""
    with _token_lock:
        if token:
            _token_targets[token] = int(getattr(_session, "vnc_port", VNC_PORT))
            _session.token = token
        else:
            current = getattr(_session, "token", None)
            if current:
                _token_targets.pop(current, None)
                _session.token = None
            else:
                _token_targets.clear()
        _flush_token_file()


def _terminate(proc: subprocess.Popen | None) -> None:
    if not proc:
        return
    try:
        proc.terminate()
        proc.wait(timeout=5)
    except Exception:  # noqa: BLE001
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            pass


def _run_session(
    uid: str,
    platform: str,
    slot: int = 0,
    worker_id: str | None = None,
) -> None:
    display_num = DISPLAY_NUM + slot
    display = f":{display_num}"
    vnc_port = VNC_PORT + slot
    _session.vnc_port = vnc_port
    _session.token = None
    xvfb = x11vnc = None
    connected = False
    try:
        xvfb = subprocess.Popen(
            [
                "Xvfb",
                display,
                "-screen",
                "0",
                "1280x860x24",
                "-ac",
                "+extension",
                "GLX",
                "+render",
                "-noreset",
            ]
        )
        time.sleep(1)
        x11vnc = subprocess.Popen(
            [
                "x11vnc",
                "-display",
                display,
                "-rfbport",
                str(vnc_port),
                "-localhost",
                "-forever",
                "-shared",
                "-nopw",
                "-quiet",
            ],
            env=dict(os.environ, DISPLAY=display),
        )
        time.sleep(1)

        token = secrets.token_urlsafe(32)
        expires_at = db.time_from_now_db(SESSION_TIMEOUT_SEC * 1000)
        db.set_connect_token(uid, platform, token, expires_at)
        _write_token_file(token)
        print(
            f"{log_prefix} session started: {uid} / {platform} "
            f"(slot={slot}, token expires in {SESSION_TIMEOUT_SEC}s)"
        )
        connected = connect_platform.connect(
            uid, platform, timeout=SESSION_TIMEOUT_SEC, display=display
        )
    except Exception as error:  # noqa: BLE001
        print(f"{log_prefix} session error for {uid}/{platform}: {error}")
    finally:
        db.clear_connect_token(uid, platform)
        _write_token_file(None)
        _terminate(x11vnc)
        _terminate(xvfb)
        if not connected:
            db.set_integration_status(uid, platform, "disconnected")
        if worker_id is not None:
            db.release_connect_request(uid, platform, worker_id)
        print(f"{log_prefix} session ended: {uid} / {platform} (connected={connected})")


def serve() -> None:
    print(
        f"{log_prefix} polling every {POLL_INTERVAL_SEC}s "
        f"with {MAX_SESSIONS} concurrent session slot(s)..."
    )
    _write_token_file(None)
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_SESSIONS) as executor:
        active: dict[int, concurrent.futures.Future] = {}
        while True:
            for slot, future in list(active.items()):
                if future.done():
                    try:
                        future.result()
                    except Exception as error:  # noqa: BLE001
                        print(f"{log_prefix} slot {slot} failed: {error}")
                    del active[slot]

            claimed = False
            for slot in range(MAX_SESSIONS):
                if slot in active:
                    continue
                worker_id = f"connect-{os.getpid()}-{slot}"
                pending = db.next_pending_connect_request(worker_id)
                if not pending:
                    break
                active[slot] = executor.submit(
                    _run_session,
                    pending["user_id"],
                    pending["platform"],
                    slot,
                    worker_id,
                )
                claimed = True
            if not claimed:
                time.sleep(POLL_INTERVAL_SEC)


if __name__ == "__main__":
    serve()
