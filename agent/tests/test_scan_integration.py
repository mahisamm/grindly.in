"""Deep end-to-end test of email_scanner.scan against a real SQLite DB.

Proves the whole pipeline: fake Gmail message -> match to an applied company ->
classify -> write Application.outcome -> notify. Also proves it never overwrites an
outcome already set, and drops low-confidence / unrelated mail.
"""
import base64
import sqlite3
import time
from unittest.mock import patch

import pytest

import db
import email_scanner


def _b64(text: str) -> str:
    return base64.urlsafe_b64encode(text.encode()).decode()


def _msg(sender: str, subject: str, body: str) -> dict:
    return {
        "payload": {
            "headers": [
                {"name": "From", "value": sender},
                {"name": "Subject", "value": subject},
            ],
            "mimeType": "text/plain",
            "body": {"data": _b64(body)},
        }
    }


@pytest.fixture()
def scandb(tmp_path, monkeypatch):
    path = str(tmp_path / "scan.db")
    c = sqlite3.connect(path)
    c.execute("CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, slack_user_id TEXT, slack_connected INTEGER)")
    c.execute(
        "CREATE TABLE applications (id TEXT PRIMARY KEY, user_id TEXT, job_title TEXT, "
        "company TEXT, status TEXT, outcome TEXT, outcome_at INTEGER, created_at INTEGER)"
    )
    c.execute("INSERT INTO users VALUES ('u1','stu@x.com',NULL,0)")
    now = int(time.time() * 1000)
    c.execute(
        "INSERT INTO applications VALUES ('a1','u1','Backend Intern','Acme Corp','applied',NULL,NULL,?)",
        (now,),
    )
    c.commit()
    c.close()
    monkeypatch.setattr(db, "DB_PATH", path)
    monkeypatch.setattr(db, "PG", False)
    return path


def _read_outcome(path, app_id):
    return sqlite3.connect(path).execute(
        "SELECT outcome FROM applications WHERE id=?", (app_id,)
    ).fetchone()[0]


def test_scan_detects_interview_and_writes_outcome(scandb):
    notified = []
    with patch.object(email_scanner, "refresh_access_token", return_value="tok"), \
         patch.object(email_scanner, "list_messages", return_value=[{"id": "m1"}]), \
         patch.object(email_scanner, "get_message",
                      return_value=_msg("recruiting@acmecorp.com", "Interview invitation",
                                        "We'd like to schedule an interview.")), \
         patch.object(email_scanner, "classify_email",
                      return_value={"outcome": "interview", "confidence": 0.95, "note": "invite"}), \
         patch.object(email_scanner, "notify_user",
                      side_effect=lambda *a, **k: notified.append(a)):
        result = email_scanner.scan("u1", "rt")

    assert _read_outcome(scandb, "a1") == "interview"
    assert result["detected"] and result["detected"][0]["outcome"] == "interview"
    assert notified and notified[0][3] == "interview"  # notify fired with the outcome


def test_scan_does_not_overwrite_an_existing_outcome(scandb):
    # Student already marked it rejected by hand; a later email must not clobber it.
    c = sqlite3.connect(scandb)
    c.execute("UPDATE applications SET outcome='rejected' WHERE id='a1'")
    c.commit(); c.close()

    with patch.object(email_scanner, "refresh_access_token", return_value="tok"), \
         patch.object(email_scanner, "list_messages", return_value=[{"id": "m1"}]), \
         patch.object(email_scanner, "get_message",
                      return_value=_msg("recruiting@acmecorp.com", "Interview", "schedule an interview")), \
         patch.object(email_scanner, "classify_email",
                      return_value={"outcome": "interview", "confidence": 0.95, "note": "x"}), \
         patch.object(email_scanner, "notify_user"):
        email_scanner.scan("u1", "rt")

    assert _read_outcome(scandb, "a1") == "rejected"  # untouched


def test_scan_ignores_mail_from_an_unrelated_company(scandb):
    with patch.object(email_scanner, "refresh_access_token", return_value="tok"), \
         patch.object(email_scanner, "list_messages", return_value=[{"id": "m1"}]), \
         patch.object(email_scanner, "get_message",
                      return_value=_msg("promo@randomshop.com", "50% off sale", "buy now")), \
         patch.object(email_scanner, "classify_email") as classify, \
         patch.object(email_scanner, "notify_user"):
        result = email_scanner.scan("u1", "rt")

    classify.assert_not_called()   # never even classified — sender matched no application
    assert _read_outcome(scandb, "a1") is None
    assert result["detected"] == []


def test_scan_drops_low_confidence(scandb):
    with patch.object(email_scanner, "refresh_access_token", return_value="tok"), \
         patch.object(email_scanner, "list_messages", return_value=[{"id": "m1"}]), \
         patch.object(email_scanner, "get_message",
                      return_value=_msg("hr@acmecorp.com", "Update", "some vague note")), \
         patch.object(email_scanner, "classify_email",
                      return_value={"outcome": "interview", "confidence": 0.3, "note": "unsure"}), \
         patch.object(email_scanner, "notify_user"):
        email_scanner.scan("u1", "rt")

    assert _read_outcome(scandb, "a1") is None  # below the 0.5 confidence floor
