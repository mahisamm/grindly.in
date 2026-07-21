"""Scam-gate Layer 2 — company reputation (agent/company_rep.py + db cache).

Same guiding rule as L1: it must catch the fraud AND never condemn a company on a
missing signal. The "no LLM -> None -> nothing blocked" path is the important one.
"""
import os
import sqlite3
import time
from contextlib import contextmanager

import pytest

import db
import company_rep


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
def repdb(tmp_path, monkeypatch):
    """Point db.py at a fresh temp SQLite file. The company_reputation table
    self-creates via _ensure_company_reputation_table, so no schema is preloaded."""
    path = str(tmp_path / "rep.db")
    sqlite3.connect(path).close()
    monkeypatch.setattr(db, "DB_PATH", path)
    monkeypatch.setattr(db, "PG", False)
    monkeypatch.setattr(db, "conn", _real_conn(path))
    monkeypatch.setattr(db, "cuid", lambda: "c" + os.urandom(12).hex())
    monkeypatch.setattr(db, "now_db", lambda: int(time.time() * 1000))
    monkeypatch.setattr(db, "time_ago_db", lambda ms: int(time.time() * 1000) - ms)
    return path


# ── normalize (the cache key) ───────────────────────────────────────────────

def test_normalize_strips_legal_suffix():
    # legal forms (pvt/ltd/corp/inc/llp) are stripped; the core brand remains, so
    # "TechNova Pvt Ltd" and plain "TechNova" resolve to the same cache key.
    assert company_rep.normalize("TechNova Pvt. Ltd.") == "technova"
    assert company_rep.normalize("  TECHNOVA   private limited ") == "technova"


def test_normalize_preserves_multiword_core():
    # descriptive words ("Solutions") are NOT legal suffixes, so a two-word brand
    # is not collapsed down to its first word.
    assert company_rep.normalize("TechNova Solutions Pvt Ltd") == "technova solutions"


def test_normalize_keeps_descriptive_words_distinct():
    # "Labs" vs "Services" are NOT legal suffixes — must not collapse together.
    assert company_rep.normalize("Bright Labs") != company_rep.normalize("Bright Services")


# ── cache round-trip + TTL ──────────────────────────────────────────────────

def test_cache_round_trip(repdb):
    db.set_company_reputation("acme corp", "scam", 0.9, evidence="asks for fee")
    row = db.get_company_reputation("acme corp", max_age_ms=company_rep._TTL_MS)
    assert row is not None
    assert row["verdict"] == "scam"
    assert row["evidence"] == "asks for fee"


def test_cache_upsert_overwrites(repdb):
    db.set_company_reputation("acme corp", "scam", 0.9)
    db.set_company_reputation("acme corp", "ok", 0.1, evidence="revised")
    row = db.get_company_reputation("acme corp")
    assert row["verdict"] == "ok" and row["evidence"] == "revised"


def test_cache_respects_ttl(repdb, monkeypatch):
    ten_days = 10 * 24 * 60 * 60 * 1000
    monkeypatch.setattr(db, "now_db", lambda: int(time.time() * 1000) - ten_days)
    db.set_company_reputation("stale co", "scam", 0.9)
    monkeypatch.setattr(db, "now_db", lambda: int(time.time() * 1000))
    assert db.get_company_reputation("stale co", max_age_ms=24 * 60 * 60 * 1000) is None
    assert db.get_company_reputation("stale co", max_age_ms=30 * 24 * 60 * 60 * 1000) is not None


# ── check_company verdicts ──────────────────────────────────────────────────

def test_no_llm_returns_none_and_never_blocks(repdb, monkeypatch):
    monkeypatch.setattr(company_rep.llm_mod, "chat_json_ensemble", lambda *a, **k: None)
    assert company_rep.check_company("Unknown Startup", "we build web apps") is None


def test_scam_high_confidence(repdb, monkeypatch):
    monkeypatch.setattr(company_rep.llm_mod, "chat_json_ensemble",
                        lambda *a, **k: {"is_scam": True, "confidence": 0.9, "reason": "charges a fee"})
    r = company_rep.check_company("Scam Co", "pay to join")
    assert r["verdict"] == "scam"
    assert r["cached"] is False


def test_scam_low_confidence_is_caution(repdb, monkeypatch):
    monkeypatch.setattr(company_rep.llm_mod, "chat_json_ensemble",
                        lambda *a, **k: {"is_scam": True, "confidence": 0.4, "reason": "unsure"})
    assert company_rep.check_company("Maybe Co", "")["verdict"] == "caution"


def test_not_scam_is_ok(repdb, monkeypatch):
    monkeypatch.setattr(company_rep.llm_mod, "chat_json_ensemble",
                        lambda *a, **k: {"is_scam": False, "confidence": 0.8, "reason": "looks fine"})
    assert company_rep.check_company("Good Co", "great internship")["verdict"] == "ok"


def test_second_call_served_from_cache(repdb, monkeypatch):
    calls = {"n": 0}

    def fake(*a, **k):
        calls["n"] += 1
        return {"is_scam": True, "confidence": 0.9, "reason": "fee"}

    monkeypatch.setattr(company_rep.llm_mod, "chat_json_ensemble", fake)
    company_rep.check_company("Repeat Co", "pay fee")
    second = company_rep.check_company("Repeat Co", "pay fee")
    assert calls["n"] == 1                 # LLM hit once; second call cached
    assert second["cached"] is True
    assert second["verdict"] == "scam"
