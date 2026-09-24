"""Entrypoint for the RAG Indexer service.

Startup sequence:
1. Load and validate configuration from env vars (fail fast on missing)
2. Configure JSON structured logging
3. Initialise LocalEmbedder (loads ~90 MB model — do this BEFORE the consumer loop)
4. Start heartbeat as a daemon thread
5. Start IndexingConsumer (blocking)
"""
from __future__ import annotations

import logging
import logging.config
import os
import sys
import threading
import time

import psycopg2
import redis

from rag_indexer.application.index_document import IndexDocumentUseCase
from rag_indexer.consumer import IndexingConsumer
from rag_indexer.infrastructure.chroma_store import ChromaVectorStore
from rag_indexer.infrastructure.embedder import LocalEmbedder
from rag_indexer.infrastructure.minio_store import MinioDocumentStore
from rag_indexer.infrastructure.postgres_repo import PostgresStatusRepo

# ---------------------------------------------------------------------------
# Structured JSON logging
# ---------------------------------------------------------------------------

_LOG_FORMAT = (
    '{"time": "%(asctime)s", "level": "%(levelname)s", '
    '"logger": "%(name)s", "message": "%(message)s"%(extra_fields)s}'
)


class _JsonFormatter(logging.Formatter):
    """Minimal JSON log formatter without external dependencies."""

    def format(self, record: logging.LogRecord) -> str:
        import json

        base = {
            "time": self.formatTime(record, self.datefmt),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        # Merge any extra keys passed via `extra={}`
        reserved = logging.LogRecord("", 0, "", 0, "", (), None).__dict__.keys()
        for key, value in record.__dict__.items():
            if key not in reserved and not key.startswith("_"):
                base[key] = value
        return json.dumps(base, default=str)


def _configure_logging(level: str = "INFO") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(_JsonFormatter())
    root = logging.getLogger()
    root.setLevel(level)
    root.handlers = [handler]


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_REQUIRED_VARS = [
    "REDIS_URL",
    "S3_ENDPOINT",
    "S3_ACCESS_KEY",
    "S3_SECRET_KEY",
    "S3_BUCKET_KB",
    "CHROMADB_HOST",
    "CHROMADB_PORT",
    # ChromaDB runs with token authentication (audit finding H3): an
    # unauthenticated vector store is reachable by anything that can resolve its
    # port and holds every tenant's knowledge base.
    "CHROMA_AUTH_TOKEN",
]

# Accept either name; docker-compose injects POSTGRES_URL for this service
# while this module previously only read DATABASE_URL (startup exit(1)).
_DATABASE_URL_VARS = ("DATABASE_URL", "POSTGRES_URL")


def _resolve_database_url() -> str | None:
    for var in _DATABASE_URL_VARS:
        value = os.environ.get(var)
        if value:
            return value
    return None


def _load_config() -> dict[str, str]:
    config: dict[str, str] = {}
    missing: list[str] = []
    for var in _REQUIRED_VARS:
        value = os.environ.get(var)
        if not value:
            missing.append(var)
        else:
            config[var] = value

    database_url = _resolve_database_url()
    if database_url is None:
        missing.append("DATABASE_URL (or POSTGRES_URL)")
    else:
        config["DATABASE_URL"] = database_url

    if missing:
        print(
            f"FATAL: missing required environment variables: {', '.join(missing)}",
            file=sys.stderr,
        )
        sys.exit(1)
    config["LOG_LEVEL"] = os.environ.get("LOG_LEVEL", "INFO")
    return config


# ---------------------------------------------------------------------------
# Heartbeat
# ---------------------------------------------------------------------------

def heartbeat_loop(pg_conn_str: str) -> None:
    """Write worker heartbeat to Postgres every 30 seconds.

    worker_heartbeats is NOT tenant-scoped — no SET LOCAL needed.
    This function runs as a daemon thread and never raises.
    """
    log = logging.getLogger(__name__ + ".heartbeat")
    while True:
        try:
            with psycopg2.connect(pg_conn_str) as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "INSERT INTO worker_heartbeats (worker_name, last_seen_at) "
                        "VALUES (%s, now()) "
                        "ON CONFLICT (worker_name) DO UPDATE SET last_seen_at = now()",
                        ("rag-indexer",),
                    )
                conn.commit()
            log.debug("Heartbeat written")
        except Exception:
            log.exception("Heartbeat write failed — will retry in 30s")
        time.sleep(30)


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

def main() -> None:
    config = _load_config()
    _configure_logging(config["LOG_LEVEL"])

    logger = logging.getLogger(__name__)
    logger.info("RAG Indexer starting up")

    # Infrastructure adapters
    document_store = MinioDocumentStore(
        endpoint=config["S3_ENDPOINT"],
        access_key=config["S3_ACCESS_KEY"],
        secret_key=config["S3_SECRET_KEY"],
        secure=os.environ.get("S3_SECURE", "false").lower() == "true",
    )

    vector_store = ChromaVectorStore(
        host=config["CHROMADB_HOST"],
        port=int(config["CHROMADB_PORT"]),
        auth_token=config["CHROMA_AUTH_TOKEN"],
    )

    status_repo = PostgresStatusRepo(connection_string=config["DATABASE_URL"])

    # Load embedding model BEFORE entering the consumer loop (slow — ~2-5s)
    logger.info("Initialising embedding model (this may take a few seconds)")
    embedder = LocalEmbedder()
    logger.info("Embedding model ready")

    # Use case
    use_case = IndexDocumentUseCase(
        document_store=document_store,
        vector_store=vector_store,
        status_repo=status_repo,
        embedder=embedder,
    )

    # Redis client
    redis_client = redis.from_url(config["REDIS_URL"], decode_responses=False)

    # Heartbeat daemon thread
    hb_thread = threading.Thread(
        target=heartbeat_loop,
        args=(config["DATABASE_URL"],),
        daemon=True,
        name="heartbeat",
    )
    hb_thread.start()
    logger.info("Heartbeat thread started")

    # Consumer (blocking)
    consumer = IndexingConsumer(
        redis_client=redis_client,
        use_case=use_case,
        vector_store=vector_store,
    )
    consumer.run()


if __name__ == "__main__":
    main()
