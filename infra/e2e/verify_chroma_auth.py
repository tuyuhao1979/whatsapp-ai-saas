#!/usr/bin/env python3
"""Live verification of ChromaDB token authentication (audit finding H3).

The shipped compose file claimed to configure ChromaDB authentication but did
not: it set `CHROMA_SERVER_AUTHN_CREDENTIALS` without a provider, and in
chromadb 0.5.23 the credentials are ignored unless
`CHROMA_SERVER_AUTHN_PROVIDER` selects the token provider. Every request was
therefore served anonymously, and any process that could resolve chromadb:8000
could read and write every tenant's knowledge base.

Proves, against the running verification stack:
  1. the provider is actually active in the running container (not inert config);
  2. an unauthenticated request is refused, and so is a wrong token;
  3. the configured token works — for raw HTTP and for the real chromadb client
     the image ships, which is the same library the two Python services use;
  4. `/api/v1/heartbeat` stays exempt, which is what the container healthcheck
     and the compose `depends_on` conditions rely on.

Run after infra/verify/run-verification.sh, from the repository root:
    python3 infra/e2e/verify_chroma_auth.py
"""
from __future__ import annotations

import os
import subprocess
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
COMPOSE = "infra/verify/docker-compose.verify.yml"
CHROMA_URL = os.environ.get("CHROMA_URL", "http://127.0.0.1:18000")
# Throwaway token from infra/verify/docker-compose.verify.yml. The real value is
# read from the container's environment below rather than written down twice, so
# this file cannot drift from the stack it is testing.
EXPECTED_PROVIDER = "chromadb.auth.token_authn.TokenAuthenticationServerProvider"

FAILED: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + ("" if ok else f"  -> {detail}"))
    if not ok:
        FAILED.append(f"{label} :: {detail}")


def http(path: str, token: str | None = None) -> tuple[int, str]:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    request = urllib.request.Request(f"{CHROMA_URL}{path}", headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, response.read().decode()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode()


def compose(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["docker", "compose", "-f", COMPOSE, *args],
        cwd=REPO_ROOT, capture_output=True, text=True, check=False,
    )


def container_env_present(name: str) -> str:
    """`set` / `unset` / `error` — never the value itself.

    The credential is a dummy, but a token is a token: reading it back to the
    transcript is a habit worth not forming.
    """
    result = compose(
        "exec", "-T", "chromadb", "sh", "-c",
        f'test -n "${name}" && echo set || echo unset',
    )
    if result.returncode != 0:
        return "error"
    return result.stdout.strip()


def run_in_container(code: str) -> tuple[int, str]:
    """Run a snippet with the chromadb client the server image ships.

    Same library major as the services use, already inside the compose network,
    so this exercises the real client/server handshake rather than a hand-rolled
    HTTP call standing in for it.
    """
    result = compose("exec", "-T", "chromadb", "python", "-c", code)
    return result.returncode, (result.stdout + result.stderr).strip()


AUTHENTICATED_CLIENT = """
import os, chromadb
token = os.environ['CHROMA_SERVER_AUTHN_CREDENTIALS']
client = chromadb.HttpClient(
    host='localhost', port=8000,
    headers={'Authorization': 'Bearer ' + token},
)
collection = client.get_or_create_collection(
    'h3_auth_check', metadata={'hnsw:space': 'cosine'},
)
collection.upsert(ids=['doc-1'], embeddings=[[0.1, 0.2, 0.3]], documents=['hello'])
got = collection.query(
    query_embeddings=[[0.1, 0.2, 0.3]], n_results=1, include=['documents'],
)
print('ROUNDTRIP', got['documents'][0][0])
"""

ANONYMOUS_CLIENT = """
import chromadb
try:
    client = chromadb.HttpClient(host='localhost', port=8000)
    collection = client.get_or_create_collection('h3_anon_check')
    collection.upsert(ids=['x'], embeddings=[[0.1, 0.2]], documents=['x'])
except Exception as exc:
    print('REFUSED', type(exc).__name__)
else:
    print('ACCEPTED')
"""


def main() -> int:
    print(f"ChromaDB authentication verification against {CHROMA_URL}")

    print("\n--- A. the provider is active, not inert configuration ---")
    provider = compose("exec", "-T", "chromadb", "printenv", "CHROMA_SERVER_AUTHN_PROVIDER")
    check(
        "the running container selects the token auth provider",
        provider.stdout.strip() == EXPECTED_PROVIDER,
        f"got {provider.stdout.strip()!r}",
    )
    check(
        "server credentials are present",
        container_env_present("CHROMA_SERVER_AUTHN_CREDENTIALS") == "set",
        "CHROMA_SERVER_AUTHN_CREDENTIALS is unset in the server container",
    )
    logs_result = compose("logs", "chromadb")
    logs = logs_result.stdout + logs_result.stderr
    check(
        "the server started the TokenAuthenticationServerProvider component",
        "Starting component TokenAuthenticationServerProvider" in logs,
        "provider component not found in the server log",
    )

    print("\n--- B. unauthenticated and wrong-token requests are refused ---")
    status, body = http("/api/v1/collections")
    check("listing collections without a token is refused", status == 403, f"HTTP {status} {body[:120]}")
    status, body = http("/api/v1/collections", token="not-the-token")
    check("listing collections with a wrong token is refused", status == 403, f"HTTP {status} {body[:120]}")
    empty_bearer = urllib.request.Request(
        f"{CHROMA_URL}/api/v1/collections", headers={"Authorization": "Bearer "},
    )
    try:
        with urllib.request.urlopen(empty_bearer, timeout=20) as response:
            empty_status = response.status
    except urllib.error.HTTPError as exc:
        empty_status = exc.code
    check("an empty bearer token is refused too", empty_status == 403, f"HTTP {empty_status}")

    print("\n--- C. the configured token works ---")
    result = compose(
        "exec", "-T", "chromadb", "sh", "-c",
        'printf %s "$CHROMA_SERVER_AUTHN_CREDENTIALS"',
    )
    token = result.stdout
    check("the server reports a non-empty credential", token != "", "credential is empty")
    status, body = http("/api/v1/collections", token=token)
    check("listing collections with the token succeeds", status == 200, f"HTTP {status} {body[:120]}")

    print("\n--- D. the real chromadb client ---")
    code, output = run_in_container(ANONYMOUS_CLIENT)
    check(
        "a client without the token cannot write",
        "REFUSED" in output and "ACCEPTED" not in output,
        output[-200:],
    )
    code, output = run_in_container(AUTHENTICATED_CLIENT)
    check(
        "a client with the token completes an upsert and a query",
        "ROUNDTRIP hello" in output,
        output[-200:],
    )

    print("\n--- E. the healthcheck route stays exempt ---")
    status, _ = http("/api/v1/heartbeat")
    check(
        "heartbeat answers without a token (compose healthcheck contract)",
        status == 200,
        f"HTTP {status}",
    )

    print("\n" + "=" * 60)
    if FAILED:
        print(f"{len(FAILED)} FAILED")
        for failure in FAILED:
            print(f"  FAIL  {failure}")
        return 1
    print("All ChromaDB authentication checks passed")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
