import os

os.environ.setdefault(
    "APP_ENCRYPTION_KEY",
    "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
)

import secret_box  # noqa: E402


def test_round_trip():
    blob = secret_box.encrypt_secret("platform-session-cookie")
    assert "." in blob
    assert secret_box.decrypt_secret(blob) == "platform-session-cookie"


def test_unique_nonce():
    assert secret_box.encrypt_secret("x") != secret_box.encrypt_secret("x")


def test_tamper_fails():
    import base64

    blob = secret_box.encrypt_secret("secret")
    n, _, c = blob.partition(".")
    raw = bytearray(base64.b64decode(c))
    raw[-1] ^= 0x01  # flip a tag bit
    tampered = f"{n}.{base64.b64encode(bytes(raw)).decode()}"
    try:
        secret_box.decrypt_secret(tampered)
        assert False, "expected decryption to fail"
    except Exception:
        pass
