"""Postgres-backed flow repository with short-lived process-local cache.

Loads active flows + their nodes for a tenant.
The in-memory cache (60s TTL per tenant) is intentionally process-local:
with replicas:2 each replica has its own cache; a reload call hits one
replica's /admin endpoint, so callers should call /admin/flows/reload
for every instance (or just let the cache expire in 60s).

RLS: every query runs within a transaction with SET LOCAL app.tenant_id.
"""
from __future__ import annotations

import logging
import time
from typing import Any

import psycopg2
import psycopg2.extras

from flow_engine.domain.models import Flow, FlowNode
from flow_engine.domain.ports import IFlowRepo

logger = logging.getLogger(__name__)

_CACHE_TTL_S = 60.0  # process-local cache TTL in seconds


class PostgresFlowRepo(IFlowRepo):
    def __init__(self, connection_string: str) -> None:
        self._conn_string = connection_string
        # {tenant_id: (expires_at_monotonic, list[Flow])}
        self._cache: dict[str, tuple[float, list[Flow]]] = {}

    def _connect(self) -> psycopg2.extensions.connection:
        return psycopg2.connect(
            self._conn_string,
            cursor_factory=psycopg2.extras.RealDictCursor,
        )

    def get_active_flows(self, tenant_id: str) -> list[Flow]:
        now = time.monotonic()
        cached = self._cache.get(tenant_id)
        if cached is not None and cached[0] > now:
            return cached[1]

        flows = self._load_from_db(tenant_id)
        self._cache[tenant_id] = (now + _CACHE_TTL_S, flows)
        logger.debug(
            "Loaded flows from DB",
            extra={"tenant_id": tenant_id, "count": len(flows)},
        )
        return flows

    def reload_tenant(self, tenant_id: str) -> None:
        """Invalidate the process-local cache for this tenant."""
        self._cache.pop(tenant_id, None)
        logger.info("Flow cache invalidated", extra={"tenant_id": tenant_id})

    def _load_from_db(self, tenant_id: str) -> list[Flow]:
        flows_map: dict[str, Flow] = {}

        with self._connect() as conn, conn.cursor() as cur:
            # RLS context (transaction-local)
            cur.execute(
                "SELECT set_config('app.tenant_id', %s, true)", (tenant_id,)
            )

            # Load flows. Column names per infra/migrations/002_create_flows.sql:
            # trigger (JSONB), entry_node (TEXT referencing flow_nodes.node_key)
            cur.execute(
                """
                    SELECT id, name, trigger, entry_node
                      FROM flows
                     WHERE tenant_id = %s
                       AND is_active = true
                    """,
                (tenant_id,),
            )
            flow_rows = cur.fetchall()

            for row in flow_rows:
                flow_id: str = str(row["id"])
                trigger: dict[str, Any] = row["trigger"] or {}
                flows_map[flow_id] = Flow(
                    id=flow_id,
                    tenant_id=tenant_id,
                    name=row["name"],
                    trigger=trigger,
                    entry_node=str(row["entry_node"] or ""),
                    nodes={},
                    is_active=True,
                )

            if not flows_map:
                return []

            # Load flow_nodes for all active flows. Column `type` (not
            # node_type) and `node_key` (not id) — the node key is what
            # session.current_node and conversation_logs.node_key store.
            flow_ids = list(flows_map.keys())
            placeholders = ",".join(["%s"] * len(flow_ids))
            cur.execute(
                f"""
                    SELECT flow_id, node_key, type, config, transitions
                      FROM flow_nodes
                     WHERE flow_id IN ({placeholders})
                    """,
                flow_ids,
            )
            node_rows = cur.fetchall()

        for row in node_rows:
            flow_id = str(row["flow_id"])
            node_key = str(row["node_key"])
            flow = flows_map.get(flow_id)
            if flow is None:
                continue

            flow.nodes[node_key] = FlowNode(
                id=node_key,
                node_type=row["type"],
                config=row["config"] or {},
                transitions=row["transitions"] or [],
            )

        return list(flows_map.values())
