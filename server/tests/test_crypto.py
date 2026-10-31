import pytest
from cryptography.exceptions import InvalidTag

from app.core.config import get_settings
from app.core.crypto import decrypt_bytes, encrypt_bytes


def test_crypto_round_trips_and_ciphertext_differs_each_time():
    a, b = encrypt_bytes(b"photo"), encrypt_bytes(b"photo")
    assert a != b and decrypt_bytes(a) == b"photo" == decrypt_bytes(b)


def test_the_nonce_is_twelve_bytes_prepended_to_ciphertext_and_tag():
    blob = encrypt_bytes(b"photo")
    assert len(blob) == 12 + len(b"photo") + 16
    assert blob[:12] != encrypt_bytes(b"photo")[:12]  # a fresh nonce every call


def test_empty_data_round_trips():
    assert decrypt_bytes(encrypt_bytes(b"")) == b""


@pytest.mark.parametrize("where", [0, 5, 12, -1])
def test_tampered_ciphertext_is_rejected(where):
    blob = bytearray(encrypt_bytes(b"photo"))
    blob[where] ^= 0x01  # flip a bit: unlike overwriting with 0, it always changes the byte
    with pytest.raises(InvalidTag):
        decrypt_bytes(bytes(blob))


def test_a_blob_too_short_to_hold_nonce_and_tag_is_rejected():
    with pytest.raises(InvalidTag):
        decrypt_bytes(b"short")


def test_a_different_key_cannot_decrypt(monkeypatch):
    from pydantic import SecretStr

    blob = encrypt_bytes(b"photo")
    monkeypatch.setattr(get_settings(), "media_key", SecretStr("some-other-media-key-0123456789"))
    with pytest.raises(InvalidTag):
        decrypt_bytes(blob)
