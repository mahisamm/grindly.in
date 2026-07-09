"""Remote-browser connect service — lets a real hosted user (no local machine,
no screen) log into a job platform by watching/driving a live browser stream
in their dashboard, instead of connect_platform.py's headed-browser flow which
only works when someone is physically sitting at the machine running it.

Why this exists: the hosted worker container has no display. Grindly must
never see or store the user's actual platform password (that's the whole
point of this over an encrypted-credential-storage design) — so the only way
to let a hosted user log in themselves is to show them a real browser and let
them type into it, the same as the local dev flow, just over the network.

Flow:
  1. src/app/api/integrations/connect/route.ts sets
     user_integrations.status='connecting' when a user clicks Connect.
  2. This service polls for that (db.next_pending_connect_request), one
     session at a time — a single shared Xvfb display keeps this simple and
     correct; upgrading to concurrent sessions later means allocating a
     display/port per session instead of the fixed ones below.
  3. For the claimed request: start an isolated Xvfb display + x11vnc bound
     to a localhost-only VNC port, generate a random single-use token,
     register it with websockify (see _write_token_file), save the token on
     the user_integrations row so the dashboard can hand it to the noVNC
     viewer, then run connect_platform.connect() exactly as the local flow
     does — same persistent profile dir, same login-detection predicate.
  4. On success or timeout: clear the token, tear down x11vnc + Xvfb.

Security model: the token is the *only* thing gating access to a live,
mid-login browser session — treat it like a password. High-entropy
(32 random bytes via secrets.token_urlsafe), single active session at a
time, cleared the instant the session ends, never logged. websockify and
this service only ever bind to localhost; Caddy is the sole public-facing
edge and must be the only thing route to the bridge port from outside the
container network.

Usage: python connect_service.py
"""
from __future__ import annotations
import os
import secrets
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

import db
import connect_platform

log_prefix = "[connect_service]"

DISPLAY_NUM = 100
VNC_PORT = 5901
TOKEN_FILE = os.path.join(os.path.dirname(__file__), "..", "data", "vnc-tokens.txt")
SESSION_TIMEOUT_SEC = 300
POLL_INTERVAL_SEC = 3


def _write_token_file(token: str | None) -> None:
    """websockify's TokenFile plugin re-reads this file per connection
    attempt, so rewriting it is enough to rotate/clear access — no process
    restart needed. Empty file = no token resolves = nothing reachable."""
    os.makedirs(os.path.dirname(TOKEN_FILE), exist_ok=True)
    with open(TOKEN_FILE, "w") as f:
        if token:
            f.write(f"{token}: 127.0.0.1:{VNC_PORT}\n")


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


def _run_session(uid: str, platform: str) -> None:
    xvfb = x11vnc = None
    connected = False
    try:
        # Bring the display + VNC server up BEFORE issuing the token. If the
        # token were published while port 5901 wasn't listening yet, a fast
        # frontend poll could grab it and fail the first noVNC connect.
        xvfb = subprocess.Popen([
            "Xvfb", f":{DISPLAY_NUM}", "-screen", "0", "1280x860x24",
            "-ac", "+extension", "GLX", "+render", "-noreset",
        ])
        time.sleep(1)  # let Xvfb bind the display before anything uses it

        x11vnc = subprocess.Popen(
            [
                "x11vnc", "-display", f":{DISPLAY_NUM}", "-rfbport", str(VNC_PORT),
                "-localhost", "-forever", "-shared", "-nopw", "-quiet",
            ],
            env=dict(os.environ, DISPLAY=f":{DISPLAY_NUM}"),
        )
        time.sleep(1)

        # VNC is up — now it's safe to publish the token.
        token = secrets.token_urlsafe(32)
        expires_at = db.time_from_now_db(SESSION_TIMEOUT_SEC * 1000)
        db.set_connect_token(uid, platform, token, expires_at)
        _write_token_file(token)

        os.environ["DISPLAY"] = f":{DISPLAY_NUM}"
        print(f"{log_prefix} session started: {uid} / {platform} (token issued, expires in {SESSION_TIMEOUT_SEC}s)")
        connected = connect_platform.connect(uid, platform, timeout=SESSION_TIMEOUT_SEC)
    except Exception as e:  # noqa: BLE001
        print(f"{log_prefix} session error for {uid}/{platform}: {e}")
    finally:
        db.clear_connect_token(uid, platform)
        _write_token_file(None)
        _terminate(x11vnc)
        _terminate(xvfb)
        # Terminal state is mandatory. connect_platform.connect() only sets
        # 'connected' on success and leaves the row untouched on
        # timeout/abandon — without this, a request the user walked away from
        # stays 'connecting' forever, and next_pending_connect_request() keeps
        # re-selecting that same dead row, blocking every other user's connect
        # request permanently (head-of-line deadlock).
        if not connected:
            db.set_integration_status(uid, platform, "disconnected")
        print(f"{log_prefix} session ended: {uid} / {platform} (connected={connected})")


def serve() -> None:
    print(f"{log_prefix} polling for connect requests every {POLL_INTERVAL_SEC}s...")
    _write_token_file(None)  # nothing should be reachable until a session actually starts
    while True:
        pending = db.next_pending_connect_request()
        if pending:
            _run_session(pending["user_id"], pending["platform"])
        else:
            time.sleep(POLL_INTERVAL_SEC)


if __name__ == "__main__":
    serve()
