"""Symmetric encryption for credentials/sessions stored at rest.

AES-256-GCM, wire format `base64(nonce).base64(ciphertext||tag)` — byte-for-byte
compatible with src/lib/crypto.ts, so the Python worker can decrypt what the
Next app encrypted (and vice-versa). Key from APP_ENCRYPTION_KEY (64 hex chars).

Requires: pip install cryptography
"""
from __future__ import annotations
import base64
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def _key() -> bytes:
    h = os.environ.get("APP_ENCRYPTION_KEY")
    if not h or len(h) < 64:
        raise RuntimeError("APP_ENCRYPTION_KEY missing or too short (need 64 hex chars)")
    return bytes.fromhex(h[:64])


def encrypt_secret(plain: str) -> str:
    nonce = os.urandom(12)
    # AESGCM.encrypt returns ciphertext||tag — matches the TS `combined` layout.
    combined = AESGCM(_key()).encrypt(nonce, plain.encode("utf-8"), None)
    return f"{base64.b64encode(nonce).decode()}.{base64.b64encode(combined).decode()}"


def decrypt_secret(blob: str) -> str:
    n, _, c = blob.partition(".")
    if not n or not c:
        raise ValueError("malformed ciphertext")
    nonce = base64.b64decode(n)
    combined = base64.b64decode(c)
    return AESGCM(_key()).decrypt(nonce, combined, None).decode("utf-8")
