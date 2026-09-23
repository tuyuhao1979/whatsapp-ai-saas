#!/usr/bin/env python3
"""Live verification of the access-token envelope introduced for H1 + H6.

Proves, against the running verification stack, that:
  1. tenant-api (TypeScript) writes an envelope flow-engine (Python) can read —
     the two implementations must agree on HKDF, AAD and framing;
  2. the stored ciphertext is bound to its row: decrypting it under another
     tenant id fails, which is what stops a copied ciphertext from becoming
     usable credentials;
  3. the plaintext token is nowhere in the row;
  4. the rotation script reports every row already on the current key
     (so a rotation is a no-op until MASTER_KEY changes).

Run after infra/verify/run-verification.sh, from the repository root:
    python3 infra/e2e/verify_token_crypto.py
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "services" / "flow-engine"))

from flow_engine.infrastructure.crypto import (  # noqa: E402
    AccessTokenDecryptError,
    KeyGeneration,
    MasterKeys,
    decrypt_access_token,
)

TENANT_API = os.environ.get("TENANT_API_URL", "http://127.0.0.1:13001")
MOCK_META = os.environ.get("MOCK_META_URL", "http://127.0.0.1:18080")
COMPOSE = "infra/verify/docker-compose.verify.yml"
MASTER_KEY = os.environ.get("MASTER_KEY", "verify_master_key_at_least_32_characters_long")
MASTER_KEY_ID = os.environ.get("MASTER_KEY_ID", "k1")
ACCESS_TOKEN = "test-user-token"  # what infra/verify/mock_meta.py accepts

FAILED: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + ("" if ok else f"  -> {detail}"))
    if not ok:
        FAILED.append(f"{label} :: {detail}")


def call(method: str, url: str, body: object | None = None, token: str | None = None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if body is not None else {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.status, json.loads(resp.read() or b"null")
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"null")


def psql(sql: str) -> str:
    result = subprocess.run(
        ["docker", "compose", "-f", COMPOSE, "exec", "-T", "postgres",
         "psql", "-U", "app_user", "-d", "whatsapp_saas", "-tAc", sql],
        cwd=REPO_ROOT, capture_output=True, text=True, check=False,
    )
    if result.returncode != 0:
        raise SystemExit(f"psql failed: {result.stderr.strip()}")
    return result.stdout.strip()


def run_script(*, dry_run: bool) -> tuple[int, str]:
    """Run the re-encryption entry point inside the tenant-api container."""
    args = ["node", "dist/scripts/reencryptAccessTokens.js"]
    if dry_run:
        args.append("--dry-run")
    result = subprocess.run(
        ["docker", "compose", "-f", COMPOSE, "exec", "-T", "tenant-api", *args],
        cwd=REPO_ROOT, capture_output=True, text=True, check=False,
    )
    return result.returncode, result.stdout + result.stderr


def migrate_count(output: str, phrase: str) -> int:
    """Read the "Would migrate 3, ..." / "Migrated 3, ..." summary line."""
    match = re.search(rf"{re.escape(phrase)}\s+(\d+)", output)
    if match is None:
        raise SystemExit(f"no '{phrase}' summary line in output:\n{output}")
    return int(match.group(1))


def legacy_envelope(plaintext: str, master_key: str) -> str:
    """A v1 ciphertext: base64(iv||ct||tag), key = first 32 bytes, no AAD."""
    from base64 import b64encode
    from os import urandom

    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    iv = urandom(12)
    payload = AESGCM(master_key.encode("utf-8")[:32]).encrypt(iv, plaintext.encode("utf-8"), None)
    return b64encode(iv + payload).decode("ascii")


def main() -> int:
    run_id = str(int(time.time()))
    phone_number_id = f"pn-{run_id}-crypto"

    print(f"Token-envelope verification against {TENANT_API}")

    status, body = call("POST", f"{MOCK_META}/test/phones",
                        {"waba_id": "waba-1", "phone_number_id": phone_number_id})
    check("mock Meta accepts a run-scoped phone number", status == 200, f"HTTP {status} {body}")

    slug = f"crypto-check-{run_id}"
    status, body = call("POST", f"{TENANT_API}/api/v1/auth/register",
                        {"tenant_name": f"Crypto Check {run_id}",
                         "email": f"{slug}@verify.test", "password": "MultiTenantTest1!"})
    if status != 201:
        raise SystemExit(f"register failed: HTTP {status} {body}")
    tenant_id, token = body["data"]["tenant_id"], body["data"]["token"]

    status, body = call("POST", f"{TENANT_API}/api/v1/tenant/whatsapp/connect",
                        {"waba_id": "waba-1", "phone_number_id": phone_number_id,
                         "access_token": ACCESS_TOKEN}, token=token)
    check("tenant connects WhatsApp with a verified token", status == 200, f"HTTP {status} {body}")

    # -- the stored value -----------------------------------------------------
    print("\n--- stored envelope ---")
    stored = psql(f"SELECT access_token FROM tenants WHERE id = '{tenant_id}'")
    check("a ciphertext was persisted", bool(stored), "no access_token in the row")
    check("the plaintext token is not stored", ACCESS_TOKEN not in stored, stored[:40])
    check(f"the envelope carries the current key id (v2.{MASTER_KEY_ID}.)",
          stored.startswith(f"v2.{MASTER_KEY_ID}."), stored[:40])

    # -- the two services agree ----------------------------------------------
    print("\n--- cross-service interoperability (tenant-api wrote it, flow-engine reads it) ---")
    keys = MasterKeys(current=KeyGeneration(id=MASTER_KEY_ID, key=MASTER_KEY))
    try:
        decrypted = decrypt_access_token(stored, keys, tenant_id, phone_number_id)
        check("flow-engine decrypts the envelope tenant-api produced", decrypted == ACCESS_TOKEN,
              f"got {decrypted!r}")
    except AccessTokenDecryptError as exc:
        check("flow-engine decrypts the envelope tenant-api produced", False, str(exc))

    # -- row binding (the H1 failure scenario) --------------------------------
    print("\n--- failure scenario: ciphertext copied to another tenant's row ---")
    other_tenant = "99999999-9999-4999-8999-999999999999"
    try:
        leaked = decrypt_access_token(stored, keys, other_tenant, phone_number_id)
        check("a copied ciphertext is refused", False, f"it decrypted to {leaked!r}")
    except AccessTokenDecryptError:
        check("a copied ciphertext is refused", True)

    try:
        leaked = decrypt_access_token(stored, keys, tenant_id, "pn-someone-else")
        check("a ciphertext moved to another phone number is refused", False,
              f"it decrypted to {leaked!r}")
    except AccessTokenDecryptError:
        check("a ciphertext moved to another phone number is refused", True)

    # -- rotation tooling: v1 -> v2 migration, and idempotency ----------------
    print("\n--- rotation tooling: legacy v1 rows are migrated and the run is idempotent ---")

    # Seed a v1 ciphertext (the pre-upgrade format: no key id, no AAD) so the
    # migration path is exercised on every run, not only on a database that
    # happens to predate the upgrade.
    psql(
        f"UPDATE tenants SET access_token = '{legacy_envelope(ACCESS_TOKEN, MASTER_KEY)}' "
        f"WHERE id = '{tenant_id}'"
    )
    seeded = psql(f"SELECT access_token FROM tenants WHERE id = '{tenant_id}'")
    check("a legacy v1 ciphertext was seeded and still decrypts on the reading side",
          decrypt_access_token(seeded, keys, tenant_id, phone_number_id) == ACCESS_TOKEN,
          seeded[:40])

    dry_code, dry_out = run_script(dry_run=True)
    check("the dry run exits 0", dry_code == 0, dry_out[-400:])

    flagged = migrate_count(dry_out, "Would migrate")
    print(f"        rows not yet on the current key: {flagged}")
    check("the dry run flags the legacy row", flagged >= 1, dry_out[-200:])

    real_code, real_out = run_script(dry_run=False)
    check("the migration exits 0", real_code == 0, real_out[-400:])
    check("it migrates exactly the rows the dry run flagged",
          migrate_count(real_out, "Migrated") == flagged, real_out[-200:])

    again_code, again_out = run_script(dry_run=True)
    check("a second run is a no-op", again_code == 0 and migrate_count(again_out, "Would migrate") == 0,
          again_out[-200:])

    remaining = psql(
        "SELECT count(*) FROM tenants WHERE access_token IS NOT NULL AND access_token NOT LIKE 'v2.%'"
    )
    check("no legacy ciphertext is left in the table", remaining == "0", f"count={remaining}")

    migrated_ok = psql(
        f"SELECT access_token FROM tenants WHERE id = '{tenant_id}'"
    )
    check("the migrated tenant still decrypts after the rotation",
          decrypt_access_token(migrated_ok, keys, tenant_id, phone_number_id) == ACCESS_TOKEN,
          migrated_ok[:40])

    print("\n" + "=" * 60)
    if FAILED:
        print(f"{len(FAILED)} check(s) FAILED")
        for item in FAILED:
            print(f"  FAIL  {item}")
        print("=" * 60)
        return 1
    print("All token-envelope checks passed")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
