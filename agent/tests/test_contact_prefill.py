"""Resume contact prefill — resume_ai.extract_contact + db.update_contact.

The safety property that matters most: it fills BLANK fields only, and never types
a wrong number into a real application form (precision over recall on extraction).
"""
import sqlite3
import time
from contextlib import contextmanager

import pytest

import db
import resume_ai


def _real_conn(path):
    @contextmanager
    def conn():
        c = sqlite3.connect(path, timeout=15)
        c.row_factory = sqlite3.Row
        try:
            yield c
            c.commit()
        finally:
            c.close()
    return conn


@pytest.fixture()
def profdb(tmp_path, monkeypatch):
    path = str(tmp_path / "prof.db")
    c = sqlite3.connect(path)
    c.execute("CREATE TABLE profiles (user_id TEXT PRIMARY KEY, phone TEXT, gpa REAL DEFAULT 8.0, updated_at INTEGER)")
    c.commit()
    c.close()
    monkeypatch.setattr(db, "DB_PATH", path)
    monkeypatch.setattr(db, "PG", False)
    monkeypatch.setattr(db, "conn", _real_conn(path))
    monkeypatch.setattr(db, "now_db", lambda: int(time.time() * 1000))
    return path


def _seed(path, uid, phone=None, gpa=8.0):
    c = sqlite3.connect(path)
    c.execute("INSERT INTO profiles (user_id, phone, gpa, updated_at) VALUES (?,?,?,?)", (uid, phone, gpa, 0))
    c.commit()
    c.close()


def _read(path, uid):
    return sqlite3.connect(path).execute("SELECT phone, gpa FROM profiles WHERE user_id=?", (uid,)).fetchone()


# ── extract_contact ─────────────────────────────────────────────────────────

def test_extract_phone_anchored():
    assert resume_ai.extract_contact("Mobile: +91 98765 43210")["phone"] == "9876543210"


def test_extract_phone_loose():
    assert resume_ai.extract_contact("Reach me anytime at 9876543210, thanks")["phone"] == "9876543210"


def test_extract_rejects_non_mobile_number():
    # A 10-digit that isn't an Indian mobile (doesn't start 6-9) must not be taken.
    assert resume_ai.extract_contact("Reference id 1234567890 on file")["phone"] is None


def test_extract_cgpa_with_scale():
    assert resume_ai.extract_contact("CGPA: 8.4 / 10")["gpa"] == 8.4


def test_extract_gpa_plain():
    assert resume_ai.extract_contact("GPA 9.1 in final year")["gpa"] == 9.1


def test_percentage_is_not_read_as_gpa():
    assert resume_ai.extract_contact("Scored 85% in class 12")["gpa"] is None


def test_out_of_range_gpa_rejected():
    assert resume_ai.extract_contact("CGPA 45.0")["gpa"] is None


def test_extract_empty():
    assert resume_ai.extract_contact("") == {"phone": None, "gpa": None}


# ── db.update_contact (fills blanks only) ───────────────────────────────────

def test_fills_blank_phone_and_default_gpa(profdb):
    _seed(profdb, "u1", phone=None, gpa=8.0)
    filled = db.update_contact("u1", phone="9876543210", gpa=8.4)
    assert filled == {"phone": "9876543210", "gpa": 8.4}
    phone, gpa = _read(profdb, "u1")
    assert phone == "9876543210" and abs(gpa - 8.4) < 1e-9


def test_never_overwrites_user_set_values(profdb):
    _seed(profdb, "u2", phone="1112223333", gpa=7.5)  # user-entered phone + non-default gpa
    filled = db.update_contact("u2", phone="9876543210", gpa=9.9)
    assert filled == {}
    phone, gpa = _read(profdb, "u2")
    assert phone == "1112223333" and abs(gpa - 7.5) < 1e-9


def test_fills_gpa_when_still_default(profdb):
    _seed(profdb, "u3", phone="9998887777", gpa=8.0)
    filled = db.update_contact("u3", gpa=7.2)
    assert filled == {"gpa": 7.2}


def test_no_values_no_change(profdb):
    _seed(profdb, "u4", phone=None, gpa=8.0)
    assert db.update_contact("u4", phone=None, gpa=None) == {}
