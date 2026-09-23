"""Typed configuration from environment variables.

Fails fast at startup if required variables are missing.
"""
from __future__ import annotations

import os
import sys
from collections.abc import Mapping
from dataclasses import dataclass

_REQUIRED = [
    "REDIS_URL",
    "CHROMADB_HOST",
    "CHROMADB_PORT",
    "OPENAI_API_KEY",
    "INTERNAL_TOKEN",
    "MASTER_KEY",
]

# The Postgres connection string is accepted under either name. docker-compose
# historically injected POSTGRES_URL while this module only read DATABASE_URL,
# which made the service exit(1) at startup under the shipped compose file.
# DATABASE_URL wins when both are present.
_DATABASE_URL_VARS = ("DATABASE_URL", "POSTGRES_URL")


def _resolve_database_url(env: Mapping[str, str]) -> str | None:
    for var in _DATABASE_URL_VARS:
        value = env.get(var)
        if value:
            return value
    return None


@dataclass(frozen=True)
class Config:
    redis_url: str
    database_url: str
    chromadb_host: str
    chromadb_port: int
    openai_api_key: str
    openai_model: str
    internal_token: str
    log_level: str
    flow_engine_port: int
    master_key: str  # AES-256-GCM key for decrypting access_tokens
    master_key_id: str  # key id new ciphertexts carry (envelope `kid`)
    master_key_previous: str | None  # previous key, during a rotation
    master_key_previous_id: str
    mode: str  # both | consumer | admin
    meta_api_base: str
    store_message_body: bool


def load_config(env: Mapping[str, str] | None = None) -> Config:
    source: Mapping[str, str] = os.environ if env is None else env

    missing = [v for v in _REQUIRED if not source.get(v)]
    database_url = _resolve_database_url(source)
    if database_url is None:
        missing.append("DATABASE_URL (or POSTGRES_URL)")
    if missing:
        print(
            f"FATAL: missing required environment variables: {', '.join(missing)}",
            file=sys.stderr,
        )
        sys.exit(1)

    assert database_url is not None  # narrowed by the guard above

    mode = source.get("MODE", "both").strip().lower()
    if mode not in ("both", "consumer", "admin"):
        print(
            f"FATAL: MODE must be one of both|consumer|admin, got {mode!r}",
            file=sys.stderr,
        )
        sys.exit(1)

    return Config(
        redis_url=source["REDIS_URL"],
        database_url=database_url,
        chromadb_host=source["CHROMADB_HOST"],
        chromadb_port=int(source["CHROMADB_PORT"]),
        openai_api_key=source["OPENAI_API_KEY"],
        openai_model=source.get("OPENAI_MODEL", "gpt-4o-mini"),
        internal_token=source["INTERNAL_TOKEN"],
        log_level=source.get("LOG_LEVEL", "INFO"),
        flow_engine_port=int(source.get("FLOW_ENGINE_PORT", "8001")),
        master_key=source["MASTER_KEY"],
        # Rotation (audit finding H6): the id names the generation new
        # ciphertexts carry; the previous key keeps rows written before a
        # rotation readable until they are re-encrypted by tenant-api.
        master_key_id=source.get("MASTER_KEY_ID", "k1"),
        master_key_previous=source.get("MASTER_KEY_PREVIOUS") or None,
        master_key_previous_id=source.get("MASTER_KEY_PREVIOUS_ID", "k0"),
        mode=mode,
        meta_api_base=source.get(
            "META_API_BASE", "https://graph.facebook.com/v21.0"
        ).rstrip("/"),
        store_message_body=source.get("STORE_MESSAGE_BODY", "false").lower()
        in ("1", "true", "yes"),
    )
