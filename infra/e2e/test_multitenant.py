#!/usr/bin/env python3
"""Multi-tenant isolation, RBAC and Meta-onboarding security tests.

Runs against the isolated verification stack (infra/verify/docker-compose.verify.yml)
on 127.0.0.1. Never touches production, a real Meta account, or real customer
tokens: META_API_BASE points at the in-stack mock Meta service.

Stdlib only. Exits non-zero if any assertion fails.

Usage:
    python3 infra/e2e/test_multitenant.py
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.error
import urllib.request

TENANT_API = os.environ.get("TENANT_API_URL", "http://127.0.0.1:13001")
GATEWAY = os.environ.get("GATEWAY_URL", "http://127.0.0.1:13000")
MOCK_META = os.environ.get("MOCK_META_URL", "http://127.0.0.1:18080")
JWT_SECRET = os.environ.get("JWT_SECRET", "verify_jwt_secret_at_least_32_characters_long")
META_APP_SECRET = os.environ.get("META_APP_SECRET", "test-app-secret")

PASSED: list[str] = []
FAILED: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> bool:
    if ok:
        PASSED.append(label)
        print(f"  PASS  {label}")
    else:
        FAILED.append(f"{label} :: {detail}")
        print(f"  FAIL  {label}  -> {detail}")
    return ok


def call(
    method: str,
    url: str,
    body: object | None = None,
    token: str | None = None,
    raw: bytes | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, object]:
    data = raw
    hdrs = dict(headers or {})
    if body is not None:
        data = json.dumps(body).encode()
        hdrs["Content-Type"] = "application/json"
    if token:
        hdrs["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            payload = resp.read()
            status = resp.status
    except urllib.error.HTTPError as exc:
        payload = exc.read()
        status = exc.code
    try:
        return status, json.loads(payload or b"null")
    except json.JSONDecodeError:
        return status, payload.decode(errors="replace")


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def mint_jwt(tenant_id: str, role: str, user_id: str = "synthetic-user") -> str:
    """Forge a JWT with the tenant's own signing secret.

    Needed because register always creates an `owner`; the viewer/admin RBAC
    paths have no API to create those users, so the token is minted directly.
    This is the verification stack's non-production secret.
    """
    header = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    now = int(time.time())
    payload = b64(
        json.dumps(
            {"sub": user_id, "tid": tenant_id, "role": role, "iat": now, "exp": now + 3600}
        ).encode()
    )
    signing_input = f"{header}.{payload}".encode()
    signature = b64(hmac.new(JWT_SECRET.encode(), signing_input, hashlib.sha256).digest())
    return f"{header}.{payload}.{signature}"


def register(name: str, password: str = "MultiTenantTest1!") -> tuple[str, str, str]:
    """Returns (tenant_id, user_id, token)."""
    slug = name.lower().replace(" ", "-")
    status, body = call(
        "POST",
        f"{TENANT_API}/api/v1/auth/register",
        {"tenant_name": name, "email": f"{slug}@verify.test", "password": password},
    )
    if status != 201:
        raise SystemExit(f"register failed for {name}: HTTP {status} {body}")
    data = body["data"]  # type: ignore[index]
    return data["tenant_id"], data["user_id"], data["token"]


def create_flow(token: str, name: str) -> str:
    status, body = call(
        "POST",
        f"{TENANT_API}/api/v1/flows",
        {
            "name": name,
            "trigger": {"type": "keyword_match", "keywords": ["ping"]},
            "entry_node": "start",
            "nodes": [
                {
                    "node_key": "start",
                    "type": "end",
                    "config": {"content": "done"},
                    "transitions": [],
                }
            ],
        },
        token=token,
    )
    if status != 201:
        raise SystemExit(f"flow creation failed: HTTP {status} {body}")
    return body["data"]["id"]  # type: ignore[index]


def register_phone(waba_id: str, phone_number_id: str) -> None:
    """Attach a run-scoped phone number to a WABA in the mock Meta service.

    The verification database persists across runs, so a fixed phone id would
    already be bound to an earlier run's tenant and every connect would 409.
    Run-scoped ids keep the suite idempotent.
    """
    status, body = call(
        "POST",
        f"{MOCK_META}/test/phones",
        {"waba_id": waba_id, "phone_number_id": phone_number_id},
    )
    if status != 200:
        raise SystemExit(f"phone registration failed: HTTP {status} {body}")


def section(title: str) -> None:
    print(f"\n--- {title} ---")


def main() -> int:
    run_id = str(int(time.time()))
    print(f"Multi-tenant verification against {TENANT_API}")

    # -- A. registration and login (regression: RLS used to block both) -----
    section("A. registration / login under RLS")
    tenant_a, _, token_a = register(f"Verify Alpha {run_id}")
    tenant_b, _, token_b = register(f"Verify Beta {run_id}")
    check("register creates two distinct tenants", tenant_a != tenant_b)

    status, body = call(
        "POST",
        f"{TENANT_API}/api/v1/auth/login",
        {
            "email": f"verify-alpha-{run_id}@verify.test",
            "password": "MultiTenantTest1!",
            "tenant_slug": f"verify-alpha-{run_id}",
        },
    )
    check("login succeeds (RLS context is established)", status == 200, f"HTTP {status} {body}")

    # -- B. cross-tenant read isolation ------------------------------------
    section("B. cross-tenant read isolation")
    flow_a = create_flow(token_a, f"Alpha Flow {run_id}")

    status, _ = call("GET", f"{TENANT_API}/api/v1/flows/{flow_a}", token=token_b)
    check("tenant B cannot read tenant A flow by id", status == 404, f"got HTTP {status}")

    status, body = call("GET", f"{TENANT_API}/api/v1/flows", token=token_b)
    ids = [f.get("id") for f in (body.get("data") or [])] if status == 200 else []
    check(
        "tenant A flow absent from tenant B flow list",
        status == 200 and flow_a not in ids,
        f"HTTP {status} ids={ids}",
    )

    status, body = call("GET", f"{TENANT_API}/api/v1/flows", token=token_a)
    own = [f.get("id") for f in (body.get("data") or [])] if status == 200 else []
    check("tenant A still sees its own flow", flow_a in own, f"ids={own}")

    status, _ = call("DELETE", f"{TENANT_API}/api/v1/flows/{flow_a}", token=token_b)
    check("tenant B cannot delete tenant A flow", status == 404, f"got HTTP {status}")

    # -- C. RBAC ------------------------------------------------------------
    section("C. role-based access control")
    viewer = mint_jwt(tenant_a, "viewer")
    admin = mint_jwt(tenant_a, "admin")
    owner = mint_jwt(tenant_a, "owner")

    status, _ = call("GET", f"{TENANT_API}/api/v1/flows", token=viewer)
    check("viewer can read", status == 200, f"HTTP {status}")

    status, _ = call(
        "POST",
        f"{TENANT_API}/api/v1/flows",
        {
            "name": "viewer attempt",
            "trigger": {"type": "always"},
            "entry_node": "s",
            "nodes": [{"node_key": "s", "type": "end", "config": {}, "transitions": []}],
        },
        token=viewer,
    )
    check("viewer cannot create a flow (403)", status == 403, f"got HTTP {status}")

    status, _ = call("DELETE", f"{TENANT_API}/api/v1/flows/{flow_a}", token=viewer)
    check("viewer cannot delete a flow (403)", status == 403, f"got HTTP {status}")

    status, _ = call(
        "POST",
        f"{TENANT_API}/api/v1/tenant/whatsapp/connect",
        {"waba_id": "waba-1", "phone_number_id": "pn-1", "access_token": "test-user-token"},
        token=viewer,
    )
    check("viewer cannot rebind the WhatsApp token (403)", status == 403, f"got HTTP {status}")

    status, _ = call("POST", f"{TENANT_API}/api/v1/meta/embedded-signup/start", {}, token=viewer)
    check("viewer cannot start Embedded Signup (403)", status == 403, f"got HTTP {status}")

    for role, token in (("admin", admin), ("owner", owner)):
        status, _ = call("POST", f"{TENANT_API}/api/v1/meta/embedded-signup/start", {}, token=token)
        check(f"{role} can start Embedded Signup", status == 200, f"HTTP {status}")

    status, _ = call("POST", f"{TENANT_API}/api/v1/flows", {}, token=None)
    check("unauthenticated mutate returns 401", status == 401, f"got HTTP {status}")

    # -- D. ownership proof / hijack prevention ----------------------------
    section("D. WABA + phone number ownership proof")
    phone_d = f"pn-{run_id}-d"
    register_phone("waba-1", phone_d)

    status, body = call(
        "POST",
        f"{TENANT_API}/api/v1/tenant/whatsapp/connect",
        {"waba_id": "waba-1", "phone_number_id": phone_d, "access_token": "test-invalid-token"},
        token=owner,
    )
    check("invalid token is rejected", status == 403, f"HTTP {status} {body}")

    status, body = call(
        "POST",
        f"{TENANT_API}/api/v1/tenant/whatsapp/connect",
        {
            "waba_id": "waba-1",
            "phone_number_id": phone_d,
            "access_token": "test-foreign-token",
        },
        token=owner,
    )
    check(
        "token that does not manage the WABA is rejected",
        status == 403,
        f"HTTP {status} {body}",
    )

    status, body = call(
        "POST",
        f"{TENANT_API}/api/v1/tenant/whatsapp/connect",
        {
            "waba_id": "waba-other",
            "phone_number_id": "pn-other",
            "access_token": "test-user-token",
        },
        token=owner,
    )
    check(
        "phone number outside the token's WABA is rejected",
        status == 403,
        f"HTTP {status} {body}",
    )

    status, body = call(
        "POST",
        f"{TENANT_API}/api/v1/tenant/whatsapp/connect",
        {
            "waba_id": "waba-1",
            "phone_number_id": phone_d,
            "access_token": "test-otherapp-token",
        },
        token=owner,
    )
    check(
        "token issued by a different app is rejected",
        status == 403,
        f"HTTP {status} {body}",
    )

    status, body = call(
        "POST",
        f"{TENANT_API}/api/v1/tenant/whatsapp/connect",
        {"waba_id": "waba-1", "phone_number_id": phone_d, "access_token": "test-user-token"},
        token=owner,
    )
    check("legitimate owner connects successfully", status == 200, f"HTTP {status} {body}")

    status, body = call(
        "POST",
        f"{TENANT_API}/api/v1/tenant/whatsapp/connect",
        {"waba_id": "waba-1", "phone_number_id": phone_d, "access_token": "test-user-token"},
        token=token_b,
    )
    check(
        "another tenant cannot take over the claimed phone number (409)",
        status == 409,
        f"HTTP {status} {body}",
    )

    # -- E. Embedded Signup state handling --------------------------------
    section("E. Embedded Signup OAuth state")
    tenant_c, _, token_c = register(f"Verify Gamma {run_id}")
    phone_c = f"pn-{run_id}-c"
    register_phone("waba-1", phone_c)

    def start_state(token: str) -> tuple[int, dict, str | None]:
        st, bd = call("POST", f"{TENANT_API}/api/v1/meta/embedded-signup/start", {}, token=token)
        return st, bd, ((bd.get("data") or {}).get("state") if st == 200 else None)

    status, body, state = start_state(token_c)
    check("start issues an oauth state", status == 200 and bool(state), f"HTTP {status} {body}")

    # A state is bound to the tenant that requested it. The cross-tenant attempt
    # below also burns it (single-use regardless of caller), which is deliberate:
    # it stops a race where two callers try to redeem the same state. A fresh
    # state is therefore issued for the legitimate onboarding that follows.
    _, _, foreign_state = start_state(token_c)
    status, body = call(
        "POST",
        f"{TENANT_API}/api/v1/meta/embedded-signup/complete",
        {
            "code": "good-code",
            "state": foreign_state,
            "waba_id": "waba-1",
            "phone_number_id": phone_c,
        },
        token=token_b,
    )
    check(
        "state issued to one tenant cannot be used by another (400)",
        status == 400,
        f"HTTP {status} {body}",
    )

    status, body = call(
        "POST",
        f"{TENANT_API}/api/v1/meta/embedded-signup/complete",
        {"code": "good-code", "state": "not-a-real-state"},
        token=token_c,
    )
    check("unknown state is rejected (400)", status == 400, f"HTTP {status} {body}")

    _, _, state = start_state(token_c)
    status, body = call(
        "POST",
        f"{TENANT_API}/api/v1/meta/embedded-signup/complete",
        {"code": "good-code", "state": state, "waba_id": "waba-1", "phone_number_id": phone_c},
        token=token_c,
    )
    check("valid state onboards the tenant", status == 200, f"HTTP {status} {body}")

    status, body = call(
        "POST",
        f"{TENANT_API}/api/v1/meta/embedded-signup/complete",
        {"code": "good-code", "state": state, "waba_id": "waba-1", "phone_number_id": phone_c},
        token=token_c,
    )
    check("replayed state is rejected (400)", status == 400, f"HTTP {status} {body}")

    status, body = call("GET", f"{TENANT_API}/api/v1/meta/connection", token=token_c)
    data = body.get("data") or {} if status == 200 else {}
    check(
        "connection health reports the binding and subscription",
        status == 200 and data.get("connected") is True and data.get("webhookSubscribed") is True,
        f"HTTP {status} {body}",
    )

    # -- F. conversation log isolation ------------------------------------
    section("F. conversation log isolation")
    status, body = call("GET", f"{TENANT_API}/api/v1/conversations", token=token_b)
    rows = body.get("data") or {} if status == 200 else {}
    check(
        "tenant B conversation log is empty",
        status == 200 and not (rows.get("data") if isinstance(rows, dict) else rows),
        f"HTTP {status} {body}",
    )

    # -- G. webhook signature + wamid --------------------------------------
    section("G. gateway webhook signature and wamid")
    payload = json.dumps(
        {
            "object": "whatsapp_business_account",
            "entry": [
                {
                    "changes": [
                        {
                            "value": {
                                "messaging_product": "whatsapp",
                                "metadata": {"phone_number_id": "pn-1"},
                                "contacts": [{"wa_id": "521234567890"}],
                                "messages": [
                                    {
                                        "from": "521234567890",
                                        "id": "wamid.VERIFY.1",
                                        "timestamp": "1716000000",
                                        "type": "text",
                                        "text": {"body": "hello"},
                                    }
                                ],
                            }
                        }
                    ]
                }
            ],
        }
    ).encode()
    good_sig = hmac.new(META_APP_SECRET.encode(), payload, hashlib.sha256).hexdigest()

    status, _ = call(
        "POST",
        f"{GATEWAY}/webhook",
        raw=payload,
        headers={"Content-Type": "application/json", "X-Hub-Signature-256": "sha256=deadbeef"},
    )
    check("webhook with an invalid signature is rejected (403)", status == 403, f"HTTP {status}")

    status, _ = call(
        "POST",
        f"{GATEWAY}/webhook",
        raw=payload,
        headers={
            "Content-Type": "application/json",
            "X-Hub-Signature-256": f"sha256={good_sig}",
        },
    )
    check("webhook with a valid signature is accepted (200)", status == 200, f"HTTP {status}")

    status, _ = call(
        "GET",
        f"{GATEWAY}/webhook?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=abc",
    )
    check("handshake with the right verify token succeeds (200)", status == 200, f"HTTP {status}")

    status, _ = call(
        "GET",
        f"{GATEWAY}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc",
    )
    check("handshake with a wrong verify token is rejected (403)", status == 403, f"HTTP {status}")

    # -- summary -----------------------------------------------------------
    total = len(PASSED) + len(FAILED)
    print(f"\n{'=' * 60}")
    if FAILED:
        print(f"{len(PASSED)}/{total} passed, {len(FAILED)} FAILED")
        for item in FAILED:
            print(f"  FAIL  {item}")
        print("=" * 60)
        return 1
    print(f"All {total} multi-tenant checks passed")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
