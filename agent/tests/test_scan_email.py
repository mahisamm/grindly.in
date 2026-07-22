"""worker.scan_email — the opt-in Gmail interview scan mode.

Two properties that matter: it stays OFF unless the feature is switched on
(gmail.readonly is a Google-restricted scope), and it never raises — a failed
inbox scan must never surface as a broken agent run.
"""
import json
from unittest.mock import patch

import secret_box
import email_scanner
import worker


def test_scan_disabled_by_default(monkeypatch):
    monkeypatch.delenv("GMAIL_SCAN_ENABLED", raising=False)
    with patch.object(worker.db, "get_platform_credential") as cred:
        assert worker.scan_email("u1") == {"skipped": "disabled"}
        cred.assert_not_called()  # never even looks at credentials when off


def test_scan_skips_when_gmail_not_connected(monkeypatch):
    monkeypatch.setenv("GMAIL_SCAN_ENABLED", "1")
    with patch.object(worker.db, "get_platform_credential", return_value=None):
        assert worker.scan_email("u1") == {"skipped": "not_connected"}


def test_scan_skips_when_credential_has_no_refresh_token(monkeypatch):
    monkeypatch.setenv("GMAIL_SCAN_ENABLED", "1")
    with patch.object(worker.db, "get_platform_credential", return_value="cipher"), \
         patch.object(secret_box, "decrypt_secret", return_value=json.dumps({})):
        assert worker.scan_email("u1") == {"skipped": "no_refresh_token"}


def test_scan_invokes_scanner_with_the_decrypted_token(monkeypatch):
    monkeypatch.setenv("GMAIL_SCAN_ENABLED", "1")
    with patch.object(worker.db, "get_platform_credential", return_value="cipher"), \
         patch.object(secret_box, "decrypt_secret",
                      return_value=json.dumps({"refresh_token": "rt-123"})), \
         patch.object(email_scanner, "scan",
                      return_value={"scanned": 3, "detected": []}) as scan:
        out = worker.scan_email("u1")
        scan.assert_called_once_with("u1", "rt-123")
        assert out == {"scanned": 3, "detected": []}


def test_scan_never_raises_on_failure(monkeypatch):
    monkeypatch.setenv("GMAIL_SCAN_ENABLED", "1")
    with patch.object(worker.db, "get_platform_credential", return_value="cipher"), \
         patch.object(secret_box, "decrypt_secret", side_effect=Exception("bad key")):
        assert worker.scan_email("u1") == {"error": "scan_failed"}


def test_run_job_routes_scan_email_mode():
    """The queue drainer dispatches mode='scan_email' to scan_email(), so both the
    daily sweep and the manual 'Scan now' button reach the scanner."""
    with patch.object(worker, "scan_email", return_value={"scanned": 1}) as fn:
        assert worker.run_job("u1", "scan_email") == {"scanned": 1}
        fn.assert_called_once_with("u1")
