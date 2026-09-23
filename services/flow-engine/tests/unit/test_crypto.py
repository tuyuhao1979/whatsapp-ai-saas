"""Regression coverage for audit findings H1 + H6 on the decrypting side.

Flow Engine is the only reader of `tenants.access_token`; the writer is
tenant-api (services/tenant-api/src/application/tenant/encryption.ts). The
cross-language vector below is the contract between them.
"""
from __future__ import annotations

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from flow_engine.infrastructure.crypto import (
    AccessTokenDecryptError,
    KeyGeneration,
    MasterKeys,
    decrypt_access_token,
    derive_tenant_key,
    encrypt_access_token,
)

MASTER_KEY = "M" * 32
KEYS = MasterKeys(current=KeyGeneration(id="k1", key=MASTER_KEY))
TENANT_A = "11111111-1111-4111-8111-111111111111"
TENANT_B = "22222222-2222-4222-8222-222222222222"
PHONE = "pn-1"
TOKEN = "EAAG-test-access-token"

# Produced by the TypeScript side with the same key, tenant, phone and IV.
CROSS_LANGUAGE_ENVELOPE = (
    "v2.k1.AAECAwQFBgcICQoLvvpxQXmMlu3DyFiZ6s1dYly+z51rg5xC5PpByj3QMj2/ATZTiYM="
)
FIXED_IV = bytes(range(12))


def test_envelope_matches_the_typescript_side() -> None:
    assert (
        encrypt_access_token(TOKEN, KEYS, TENANT_A, PHONE, iv=FIXED_IV)
        == CROSS_LANGUAGE_ENVELOPE
    )


def test_decrypts_the_envelope_written_by_typescript() -> None:
    assert decrypt_access_token(CROSS_LANGUAGE_ENVELOPE, KEYS, TENANT_A, PHONE) == TOKEN


def test_round_trip_uses_a_fresh_nonce() -> None:
    first = encrypt_access_token(TOKEN, KEYS, TENANT_A, PHONE)
    second = encrypt_access_token(TOKEN, KEYS, TENANT_A, PHONE)
    assert first != second
    assert decrypt_access_token(first, KEYS, TENANT_A, PHONE) == TOKEN
    assert decrypt_access_token(second, KEYS, TENANT_A, PHONE) == TOKEN


def test_refuses_a_token_bound_to_another_tenant() -> None:
    envelope = encrypt_access_token(TOKEN, KEYS, TENANT_A, PHONE)
    with pytest.raises(AccessTokenDecryptError):
        decrypt_access_token(envelope, KEYS, TENANT_B, PHONE)


def test_refuses_a_token_bound_to_another_phone_number() -> None:
    envelope = encrypt_access_token(TOKEN, KEYS, TENANT_A, PHONE)
    with pytest.raises(AccessTokenDecryptError, match="authentication failed"):
        decrypt_access_token(envelope, KEYS, TENANT_A, "pn-2")


def test_refuses_a_tampered_ciphertext() -> None:
    from base64 import b64decode, b64encode

    prefix, kid, payload = encrypt_access_token(TOKEN, KEYS, TENANT_A, PHONE).split(".")
    raw = bytearray(b64decode(payload))
    raw[-1] ^= 0x01
    tampered = f"{prefix}.{kid}.{b64encode(bytes(raw)).decode('ascii')}"
    with pytest.raises(AccessTokenDecryptError):
        decrypt_access_token(tampered, KEYS, TENANT_A, PHONE)


def test_per_tenant_keys_differ_and_are_not_the_master_key() -> None:
    assert derive_tenant_key(MASTER_KEY, TENANT_A) != derive_tenant_key(MASTER_KEY, TENANT_B)
    assert len(derive_tenant_key(MASTER_KEY, TENANT_A)) == 32
    assert derive_tenant_key(MASTER_KEY, TENANT_A) != MASTER_KEY.encode("utf-8")


def test_reads_rows_written_before_a_rotation() -> None:
    rotated = MasterKeys(
        current=KeyGeneration(id="k2", key="N" * 32),
        previous=KeyGeneration(id="k1", key=MASTER_KEY),
    )
    old_envelope = encrypt_access_token(TOKEN, KEYS, TENANT_A, PHONE)
    assert decrypt_access_token(old_envelope, rotated, TENANT_A, PHONE) == TOKEN
    assert encrypt_access_token(TOKEN, rotated, TENANT_A, PHONE).startswith("v2.k2.")


def test_unknown_key_id_is_reported_explicitly() -> None:
    envelope = encrypt_access_token(TOKEN, KEYS, TENANT_A, PHONE)
    wrong = MasterKeys(current=KeyGeneration(id="k9", key="N" * 32))
    with pytest.raises(AccessTokenDecryptError, match="No key configured for key id 'k1'"):
        decrypt_access_token(envelope, wrong, TENANT_A, PHONE)


def test_legacy_v1_ciphertext_still_decrypts() -> None:
    """v1: base64(iv||ct||tag), key = first 32 bytes of the master key, no AAD."""
    from base64 import b64encode
    from os import urandom

    iv = urandom(12)
    payload = AESGCM(MASTER_KEY.encode("utf-8")[:32]).encrypt(iv, TOKEN.encode("utf-8"), None)
    legacy = b64encode(iv + payload).decode("ascii")

    assert not legacy.startswith("v2.")
    assert decrypt_access_token(legacy, KEYS, TENANT_A, PHONE) == TOKEN


@pytest.mark.parametrize("envelope", ["v2.", "v2.k1", "v2.k1.", "v2.bad kid!!.AAAA", "AAAA"])
def test_malformed_input_is_rejected(envelope: str) -> None:
    with pytest.raises(AccessTokenDecryptError):
        decrypt_access_token(envelope, KEYS, TENANT_A, PHONE)
