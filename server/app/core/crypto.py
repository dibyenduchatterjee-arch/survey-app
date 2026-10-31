"""Encryption at rest for uploaded media: AES-256-GCM.

The 256-bit key is derived from `settings.media_key` with HKDF-SHA256, so the setting
can be any sufficiently random string rather than exactly 32 bytes. Every call draws a
fresh 12-byte nonce from the OS and prepends it to the ciphertext (which ends with the
16-byte GCM tag): blob = nonce || ciphertext || tag. A nonce must never repeat under one
key; 96 random bits make a repeat negligible at this system's volume.

Decryption authenticates before it returns anything: a flipped bit, a truncated blob or
the wrong key raises `cryptography.exceptions.InvalidTag`, never garbage plaintext.
"""

import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from app.core.config import get_settings

_NONCE_BYTES = 12
_TAG_BYTES = 16
_INFO = b"evidence-action-survey-platform/media/aes-256-gcm/v1"


def _cipher() -> AESGCM:
    secret = get_settings().media_key.get_secret_value().encode("utf-8")
    key = HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=_INFO).derive(secret)
    return AESGCM(key)


def encrypt_bytes(data: bytes) -> bytes:
    nonce = os.urandom(_NONCE_BYTES)
    return nonce + _cipher().encrypt(nonce, data, None)


def decrypt_bytes(blob: bytes) -> bytes:
    if len(blob) < _NONCE_BYTES + _TAG_BYTES:
        raise InvalidTag()
    return _cipher().decrypt(blob[:_NONCE_BYTES], blob[_NONCE_BYTES:], None)
