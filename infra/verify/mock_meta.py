"""Minimal stand-in for the Meta Graph API, used only by the verification stack.

Purpose: let the onboarding chain be exercised end to end (OAuth code exchange,
token debug, WABA/phone discovery, webhook subscription, message send) without
touching a real Meta account, real WhatsApp numbers, or real customer tokens.

Stdlib only so it can run from a bare python image with no build step.

Endpoints implemented (prefix /v21.0, matching META_API_BASE):
  POST /v21.0/oauth/access_token
  POST /v21.0/debug_token
  GET  /v21.0/{waba_id}/phone_numbers
  GET  /v21.0/{phone_number_id}
  POST /v21.0/{waba_id}/subscribed_apps
  GET  /v21.0/{waba_id}/subscribed_apps
  POST /v21.0/{phone_number_id}/messages
  GET  /health

Behaviour is driven entirely by the request so tests can construct both the
happy path and the attack paths:

  code "good-code"          -> token "test-user-token", granular scope waba-1
  code "no-scope-code"      -> valid token, but no granular WABA scope
  code "foreign-waba-code"  -> granular scope names waba-other only
  anything else             -> 400

The token itself encodes what it may do, so a test can mint a token that is
valid but does NOT own the WABA it is being pointed at:

  token "test-user-token"      -> manages waba-1, app app-123
  token "test-foreign-token"   -> manages waba-other, app app-123
  token "test-otherapp-token"  -> manages waba-1, but app app-999
  token "test-invalid-token"   -> is_valid false
"""

from __future__ import annotations

import json
import re
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs

APP_ID = "app-123"

PHONE_NUMBERS = {
    "waba-1": [
        {
            "id": "pn-1",
            "display_phone_number": "+15550100",
            "verified_name": "Acme Test",
            "quality_rating": "GREEN",
        }
    ],
    "waba-other": [
        {
            "id": "pn-other",
            "display_phone_number": "+15550199",
            "verified_name": "Someone Else",
            "quality_rating": "GREEN",
        }
    ],
}

TOKENS = {
    "test-user-token": {"app": APP_ID, "valid": True, "wabas": ["waba-1"]},
    "test-scopeless-token": {"app": APP_ID, "valid": True, "wabas": []},
    "test-foreign-token": {"app": APP_ID, "valid": True, "wabas": ["waba-other"]},
    "test-otherapp-token": {"app": APP_ID, "valid": False, "wabas": ["waba-1"], "app": "app-999"},
    "test-invalid-token": {"app": APP_ID, "valid": False, "wabas": []},
}

CODE_TO_TOKEN = {
    "good-code": "test-user-token",
    "no-scope-code": "test-scopeless-token",
    "foreign-waba-code": "test-foreign-token",
}

_subscribed: dict[str, set[str]] = {}

# Phone numbers registered at runtime by the verification suite via
# POST /test/phones. Tests use run-scoped ids so the suite is idempotent against
# a database that persists across runs (the named volume is not reset), and so
# runs cannot interfere with each other.
_dynamic_phones: dict[str, dict[str, object]] = {}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args: object) -> None:  # keep CI output readable
        return

    # -- helpers -----------------------------------------------------------

    def _send(self, status: int, body: dict[str, object]) -> None:
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _fail(self, status: int, message: str) -> None:
        self._send(status, {"error": {"message": message, "code": status}})

    def _body(self) -> str:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length).decode() if length else ""

    def _bearer(self) -> str:
        header = self.headers.get("Authorization") or ""
        return header[7:] if header.startswith("Bearer ") else ""

    # -- routing -----------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path.startswith("/health"):
            self._send(200, {"status": "ok"})
            return
        self._dispatch("GET")

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        self._dispatch("POST")

    def _dispatch(self, method: str) -> None:
        path = self.path.split("?")[0]
        if path == "/test/phones" and method == "POST":
            self._register_test_phone()
            return
        if path in ("/v21.0/oauth/access_token",):
            self._oauth()
            return
        if path == "/v21.0/debug_token":
            self._debug()
            return
        m = re.fullmatch(r"/v21\.0/([^/]+)/phone_numbers", path)
        if m and method == "GET":
            self._phone_numbers(m.group(1))
            return
        m = re.fullmatch(r"/v21\.0/([^/]+)/subscribed_apps", path)
        if m:
            self._subscribed_apps(m.group(1), method)
            return
        m = re.fullmatch(r"/v21\.0/([^/]+)/messages", path)
        if m and method == "POST":
            self._messages(m.group(1))
            return
        m = re.fullmatch(r"/v21\.0/([^/]+)", path)
        if m and method == "GET":
            self._phone_profile(m.group(1))
            return
        self._fail(404, f"No mock route for {method} {path}")

    # -- endpoint implementations ------------------------------------------

    def _oauth(self) -> None:
        form = parse_qs(self._body())
        code = (form.get("code") or [""])[0]
        client_id = (form.get("client_id") or [""])[0]
        client_secret = (form.get("client_secret") or [""])[0]
        if not client_id or not client_secret:
            self._fail(400, "client_id and client_secret are required")
            return
        token = CODE_TO_TOKEN.get(code)
        if not token:
            self._fail(400, "Invalid verification code")
            return
        self._send(200, {"access_token": token, "token_type": "bearer", "expires_in": 5184000})

    def _debug(self) -> None:
        form = parse_qs(self._body())
        token = (form.get("input_token") or [""])[0]
        record = TOKENS.get(token)
        if record is None:
            self._send(200, {"data": {"is_valid": False}})
            return
        wabas = record.get("wabas") or []
        granular = (
            [{"scope": "whatsapp_business_management", "target_ids": wabas}] if wabas else []
        )
        self._send(
            200,
            {
                "data": {
                    "app_id": record.get("app"),
                    "is_valid": bool(record.get("valid")),
                    "scopes": ["whatsapp_business_management"] if wabas else [],
                    "granular_scopes": granular,
                    "expires_at": 4102444800,
                }
            },
        )

    def _waba_of_token(self) -> str | None:
        record = TOKENS.get(self._bearer())
        if not record or not record.get("valid"):
            return None
        wabas = record.get("wabas") or []
        return wabas[0] if wabas else None

    def _register_test_phone(self) -> None:
        """Test-only helper: attach a run-scoped phone number to a WABA."""
        body = json.loads(self._body() or "{}")
        waba_id = body.get("waba_id")
        phone_number_id = body.get("phone_number_id")
        if not waba_id or not phone_number_id:
            self._fail(400, "waba_id and phone_number_id are required")
            return
        if waba_id not in PHONE_NUMBERS:
            self._fail(400, f"Unknown WhatsApp Business Account {waba_id}")
            return
        _dynamic_phones[phone_number_id] = {
            "id": phone_number_id,
            "display_phone_number": "+15550101",
            "verified_name": "Verify Run",
            "quality_rating": "GREEN",
            "_waba": waba_id,
        }
        self._send(200, {"ok": True, "phone_number_id": phone_number_id})

    def _phone_numbers(self, waba_id: str) -> None:
        if self._bearer() not in TOKENS:
            self._fail(401, "Invalid OAuth access token")
            return
        static = PHONE_NUMBERS.get(waba_id)
        if static is None:
            self._fail(400, f"Unknown WhatsApp Business Account {waba_id}")
            return
        dynamic = [p for p in _dynamic_phones.values() if p.get("_waba") == waba_id]
        self._send(200, {"data": [*(static or []), *dynamic]})

    def _phone_profile(self, phone_number_id: str) -> None:
        dynamic = _dynamic_phones.get(phone_number_id)
        if dynamic is not None:
            self._send(200, {k: v for k, v in dynamic.items() if not k.startswith("_")})
            return
        for numbers in PHONE_NUMBERS.values():
            for entry in numbers:
                if entry["id"] == phone_number_id:
                    self._send(200, entry)
                    return
        self._fail(400, f"Unknown phone number {phone_number_id}")

    def _subscribed_apps(self, waba_id: str, method: str) -> None:
        if method == "POST":
            _subscribed.setdefault(waba_id, set()).add(APP_ID)
            self._send(200, {"success": True})
            return
        apps = sorted(_subscribed.get(waba_id, set()))
        self._send(
            200,
            {"data": [{"whatsapp_business_api_data": {"id": a}} for a in apps]},
        )

    def _messages(self, phone_number_id: str) -> None:
        if not self._bearer():
            self._fail(401, "Missing access token")
            return
        body = json.loads(self._body() or "{}")
        to = body.get("to", "unknown")
        self._send(
            200,
            {
                "messaging_product": "whatsapp",
                "contacts": [{"wa_id": to}],
                "messages": [{"id": f"wamid.MOCK.{phone_number_id}.{to}"}],
            },
        )


def main() -> None:
    server = HTTPServer(("0.0.0.0", 8080), Handler)  # noqa: S104 - container-internal
    server.serve_forever()


if __name__ == "__main__":
    main()
