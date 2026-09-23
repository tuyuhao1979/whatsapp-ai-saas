"""Access-token envelope shared with tenant-api (audit findings H1 + H6).

The format is defined in services/tenant-api/src/application/tenant/encryption.ts
and must agree byte for byte:

    envelope   `v2.<kid>.<base64(iv || ciphertext || tag)>`
    key        HKDF-SHA256(MASTER_KEY, salt = tenant_id, info = "...:v2")
    AAD        `${tenant_id}|${phone_number_id}`

tests/unit/test_crypto.py asserts a fixed cross-language vector, so a change to
the derivation on one side fails on the other.

v1 (`base64(iv || ciphertext || tag)`, key = first 32 bytes of MASTER_KEY, no
AAD) still decrypts, so rows written before the upgrade keep working.
"""
from __future__ import annotations

from base64 import b64decode, b64encode
from dataclasses import dataclass
from os import urandom

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

_IV_LENGTH = 12
_KEY_LENGTH = 32
_HKDF_INFO = b"whatsapp-access-token:v2"
_V2_PREFIX = "v2"


class AccessTokenDecryptError(Exception):
    """Ciphertext could not be decrypted: unknown key, wrong row, or tampering."""


@dataclass(frozen=True)
class KeyGeneration:
    """One MASTER_KEY generation. `id` is what lands in the envelope as `kid`."""

    id: str
    key: str


@dataclass(frozen=True)
class MasterKeys:
    """Current key plus, during a rotation, the key still needed to read old rows."""

    current: KeyGeneration
    previous: KeyGeneration | None = None


def derive_tenant_key(master_key: str, tenant_id: str) -> bytes:
    """Per-tenant key derivation; mirrors deriveTenantKey in the TypeScript side."""
    return HKDF(
        algorithm=hashes.SHA256(),
        length=_KEY_LENGTH,
        salt=tenant_id.encode("utf-8"),
        info=_HKDF_INFO,
    ).derive(master_key.encode("utf-8"))


def encrypt_access_token(
    plaintext: str,
    keys: MasterKeys,
    tenant_id: str,
    phone_number_id: str,
    iv: bytes | None = None,
) -> str:
    """`iv` is only for deterministic test vectors; production passes None."""
    nonce = urandom(_IV_LENGTH) if iv is None else iv
    if len(nonce) != _IV_LENGTH:
        raise ValueError(f"IV must be {_IV_LENGTH} bytes, got {len(nonce)}")

    key = derive_tenant_key(keys.current.key, tenant_id)
    payload = AESGCM(key).encrypt(
        nonce, plaintext.encode("utf-8"), _aad(tenant_id, phone_number_id)
    )
    return f"{_V2_PREFIX}.{keys.current.id}.{b64encode(nonce + payload).decode('ascii')}"


def decrypt_access_token(
    envelope: str,
    keys: MasterKeys,
    tenant_id: str,
    phone_number_id: str,
) -> str:
    if envelope.startswith(f"{_V2_PREFIX}."):
        return _decrypt_v2(envelope, keys, tenant_id, phone_number_id)
    return _decrypt_legacy(envelope, keys)


def _decrypt_v2(
    envelope: str,
    keys: MasterKeys,
    tenant_id: str,
    phone_number_id: str,
) -> str:
    parts = envelope.split(".")
    if len(parts) != 3 or not parts[1] or not parts[2]:
        raise AccessTokenDecryptError("Malformed v2 envelope (expected v2.<kid>.<payload>)")

    generation = _key_for(parts[1], keys)
    if generation is None:
        raise AccessTokenDecryptError(
            f"No key configured for key id {parts[1]!r} "
            "(check MASTER_KEY_ID / MASTER_KEY_PREVIOUS_ID)"
        )

    raw = b64decode(parts[2])
    if len(raw) <= _IV_LENGTH + 16:
        raise AccessTokenDecryptError("v2 payload is too short to contain an IV and auth tag")

    nonce, payload = raw[:_IV_LENGTH], raw[_IV_LENGTH:]
    try:
        plaintext = AESGCM(derive_tenant_key(generation.key, tenant_id)).decrypt(
            nonce, payload, _aad(tenant_id, phone_number_id)
        )
    except (InvalidTag, ValueError, UnicodeDecodeError) as exc:
        raise AccessTokenDecryptError(
            "Access-token authentication failed: wrong key, wrong tenant/phone binding, "
            f"or tampered ciphertext ({type(exc).__name__})"
        ) from exc
    return plaintext.decode("utf-8")


def _decrypt_legacy(envelope: str, keys: MasterKeys) -> str:
    """v1: no key id, no AAD, key = first 32 bytes of the master key."""
    candidates = [keys.current.key] + ([keys.previous.key] if keys.previous else [])
    last_error: Exception | None = None
    for candidate in candidates:
        try:
            return _legacy_gcm_decrypt(envelope, candidate)
        except (InvalidTag, ValueError, UnicodeDecodeError) as exc:
            last_error = exc
    raise AccessTokenDecryptError(
        f"Legacy (v1) access-token decryption failed with every configured key: {last_error}"
    )


def _legacy_gcm_decrypt(envelope: str, master_key: str) -> str:
    raw = b64decode(envelope)
    if len(raw) <= _IV_LENGTH + 16:
        raise AccessTokenDecryptError("Legacy payload is too short to contain an IV and auth tag")

    key = _legacy_derive_key(master_key)
    nonce, payload = raw[:_IV_LENGTH], raw[_IV_LENGTH:]
    return AESGCM(key).decrypt(nonce, payload, None).decode("utf-8")


def _legacy_derive_key(master_key: str) -> bytes:
    """Byte-for-byte reproduction of the v1 derivation (truncate or zero-pad)."""
    raw = master_key.encode("utf-8")
    if len(raw) >= _KEY_LENGTH:
        return raw[:_KEY_LENGTH]
    return raw.ljust(_KEY_LENGTH, b"\0")


def _key_for(kid: str, keys: MasterKeys) -> KeyGeneration | None:
    if keys.current.id == kid:
        return keys.current
    if keys.previous is not None and keys.previous.id == kid:
        return keys.previous
    return None


def _aad(tenant_id: str, phone_number_id: str) -> bytes:
    return f"{tenant_id}|{phone_number_id}".encode()
