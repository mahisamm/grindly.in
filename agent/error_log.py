"""Crashes, recorded where an operator can actually see them.

The worker's exception handling is careful and local: a dead board never fails a
sweep, a raising sender never takes down the run. That is right, and it has a
cost — the failure is printed into a container log that rotates, and nobody
reads a container log until someone complains. Sentry has been wired since the
beginning and has never been switched on, because switching it on needs an
account on someone else's service.

So: the same database everything else already uses. `capture()` is best-effort
and swallows its own errors by construction — an error logger that raises turns
a handled failure into an outage, which is precisely the opposite of the point.

Grouped, not appended. One exception inside a retry loop fires hundreds of times
a minute; a row per occurrence is a table nobody can read. Same fingerprint
bumps a count.
"""
from __future__ import annotations

import hashlib
import json
import os
import traceback

import db

# The top of a traceback is the part anyone reads, and a full trace of a deep
# framework call is measured in kilobytes per occurrence.
MAX_STACK = 4000
MAX_MESSAGE = 500

SOURCE = os.environ.get("GRINDLY_ERROR_SOURCE", "worker")


def fingerprint(source: str, kind: str, message: str) -> str:
    """What makes two crashes 'the same bug'.

    Deliberately excludes the stack: the same fault reached through two call
    paths is still one thing to fix, and including the trace would file every
    one separately and bury the page in duplicates.
    """
    raw = f"{source}\n{kind}\n{message}".encode("utf-8", "replace")
    return hashlib.sha1(raw).hexdigest()


def _clean(text: str, limit: int) -> str:
    text = (text or "").strip().replace("\x00", "")
    return text[:limit]


def capture(exc: BaseException | None = None, *, kind: str = "", message: str = "",
            context: dict | None = None, source: str = "") -> None:
    """Record one failure. Never raises, never blocks the caller."""
    try:
        source = source or SOURCE
        if exc is not None:
            kind = kind or type(exc).__name__
            message = message or str(exc)
            stack = "".join(
                traceback.format_exception(type(exc), exc, exc.__traceback__)
            )
        else:
            kind = kind or "unhandled"
            stack = ""

        message = _clean(message, MAX_MESSAGE) or kind
        stack = _clean(stack, MAX_STACK)

        # Credentials and OTPs pass through worker exceptions often enough that
        # this cannot be optional — a crash report is the last place a password
        # should end up, and this table is read by an operator, not the user it
        # belongs to.
        try:
            import redact

            message = redact.redact(message)
            stack = redact.redact(stack)
        except Exception:  # noqa: BLE001
            pass

        blob = ""
        if context:
            try:
                blob = _clean(json.dumps(context, default=str), 2000)
            except Exception:  # noqa: BLE001
                blob = ""

        fp = fingerprint(source, kind, message)
        with db.conn() as c:
            # One statement, so two workers crashing at the same instant cannot
            # race between a SELECT and an INSERT and lose a count.
            c.execute(
                """
                INSERT INTO error_events
                    (id, fingerprint, source, kind, message, stack, context,
                     count, first_seen_at, last_seen_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 1, now(), now())
                ON CONFLICT (fingerprint) DO UPDATE SET
                    count = error_events.count + 1,
                    last_seen_at = now(),
                    stack = EXCLUDED.stack,
                    context = EXCLUDED.context,
                    -- A bug that comes back was not fixed. Clearing this is what
                    -- makes "new since I last looked" mean something.
                    resolved_at = NULL
                """,
                (db.cuid(), fp, source, kind, message, stack, blob),
            )
            c.commit()
    except Exception as e:  # noqa: BLE001
        # The one place a bare print is the right answer: we are already in the
        # failure path, and raising here would replace a handled error with an
        # unhandled one.
        print(f"[error_log] could not record a failure: {type(e).__name__}: {e}")


def recent(limit: int = 50, include_resolved: bool = False) -> list[dict]:
    """Newest-first, for the admin surface and for asking the box directly."""
    try:
        where = "" if include_resolved else "WHERE resolved_at IS NULL"
        with db.conn() as c:
            rows = c.execute(
                f"""SELECT fingerprint, source, kind, message, count,
                           first_seen_at, last_seen_at
                    FROM error_events {where}
                    ORDER BY last_seen_at DESC LIMIT ?""",
                (limit,),
            ).fetchall()
        return [dict(r) for r in rows]
    except Exception as e:  # noqa: BLE001
        print(f"[error_log] could not read failures: {e}")
        return []
