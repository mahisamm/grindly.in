"""Serve fill plans to the web container, which serves them to the extension.

Why this process exists
-----------------------
The answering engine is Python and lives here. The web container is
`node:20-slim` and has no Python at all, so a Next route cannot call the engine
directly — and porting forty-odd hard-won patterns into JavaScript would mean
rediscovering every one of their bugs a second time.

So: the browser is the hands, `fill_plan` is the brain, and this is the wire
between them. The extension posts a form snapshot to the WEB app, which is the
only thing that can authenticate it; the web app forwards the snapshot here and
returns the answer.

What it is not
--------------
Not a public API. It binds inside the docker network, its port is never
published, and it requires a shared secret both containers already hold. It
reads nothing from the database, holds no session, and issues no credentials —
the caller sends the candidate's facts and gets values back. It cannot submit
anything, and it cannot be made to: the only thing it can do is decide what
text belongs in which box.

Deliberately the standard library. This runs beside a worker on a 1 vCPU box;
adding a web framework to answer one JSON shape would cost more memory than the
whole job.
"""
from __future__ import annotations

import json
import logging
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import fill_plan  # noqa: E402

log = logging.getLogger("grindly.planner")

# Inside the compose network only. Never add a `ports:` mapping for this.
HOST = os.environ.get("GRINDLY_PLANNER_HOST", "0.0.0.0")
PORT = int(os.environ.get("GRINDLY_PLANNER_PORT", "8781"))

# Shared with the web container. Absent means refuse everything rather than
# serve openly: a planner that answers unauthenticated callers would let anyone
# on the network mine the answering engine.
SECRET = os.environ.get("GRINDLY_PLANNER_SECRET", "")

# A form snapshot is small. A megabyte is already a page that has gone wrong,
# and reading an unbounded body is how a single request eats the container.
MAX_BODY = 1_000_000


class Handler(BaseHTTPRequestHandler):
    # BaseHTTPRequestHandler logs every request to stderr by default, which on a
    # shared worker log is pure noise.
    def log_message(self, fmt, *args):  # noqa: A003
        pass

    def _reply(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:  # noqa: BLE001 — the caller hung up; nothing to do
            pass

    def do_GET(self):  # noqa: N802
        if self.path == "/health":
            return self._reply(200, {"ok": True})
        return self._reply(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        if self.path != "/plan":
            return self._reply(404, {"error": "not found"})

        if not SECRET or self.headers.get("X-Planner-Secret") != SECRET:
            return self._reply(401, {"error": "unauthorized"})

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._reply(400, {"error": "bad length"})
        if length <= 0 or length > MAX_BODY:
            return self._reply(413, {"error": "body too large"})

        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception:  # noqa: BLE001
            return self._reply(400, {"error": "bad json"})

        try:
            result = fill_plan.plan(
                payload.get("fields") or [],
                profile=payload.get("profile") or {},
                resume_text=payload.get("resumeText") or "",
                skills=payload.get("skills") or [],
                job=payload.get("job") or {},
                name=payload.get("name") or "",
                email=payload.get("email") or "",
                cover_letter=payload.get("coverLetter") or "",
            )
        except Exception as e:  # noqa: BLE001
            # fill_plan already swallows its own failures; this is the last
            # net. A browser waiting on a plan must get an answer, because the
            # alternative is a real application left half-typed in a tab.
            log.exception("plan failed")
            return self._reply(200, {
                "fills": [], "unanswered": [], "considered": 0,
                "error": f"{type(e).__name__}"[:80],
            })

        return self._reply(200, result)


def serve(host: str = HOST, port: int = PORT) -> None:
    if not SECRET:
        log.error("GRINDLY_PLANNER_SECRET is unset — every request will be "
                  "refused. Set it on the planner AND the web container.")
    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    log.info("planner listening on %s:%s", host, port)
    server.serve_forever()


def serve_in_background(host: str = HOST, port: int = PORT) -> threading.Thread:
    """For running the planner inside another process (tests, local dev)."""
    t = threading.Thread(target=serve, args=(host, port), daemon=True)
    t.start()
    return t


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-8s [%(name)s] %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )
    serve()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
