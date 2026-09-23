"""FlowExecutor: main orchestration loop for the Flow Engine.

Processes one inbound message at a time for a given session.
Stateless across calls — all state lives in the Session dataclass
which is persisted to Redis after every execution.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from flow_engine.application.node_executors import ExecutorDeps, NodeResult, execute_node
from flow_engine.application.trigger_matcher import match_trigger
from flow_engine.domain.errors import MaxIterationsError, NodeExecutionError
from flow_engine.domain.models import Flow, FlowNode, InboundMessage, Session
from flow_engine.domain.ports import IConvLogRepo, IFlowRepo, ILLMPort, IMetaSendPort, IVectorStore

logger = logging.getLogger(__name__)

_MAX_ITERATIONS = 20


class FlowExecutor:
    """Orchestrates flow execution for a single inbound message."""

    def __init__(
        self,
        flow_repo: IFlowRepo,
        meta_send: IMetaSendPort,
        vector_store: IVectorStore,
        llm: ILLMPort,
        conv_log_repo: IConvLogRepo,
    ) -> None:
        self._flow_repo = flow_repo
        self._meta_send = meta_send
        self._vector_store = vector_store
        self._llm = llm
        self._conv_log_repo = conv_log_repo
        # Meta message ids of everything sent during the current execution,
        # so the consumer can persist them and correlate status callbacks.
        self._sent_wamids: list[str] = []

    def execute(self, message: InboundMessage, session: Session) -> list[str]:
        """Process one inbound message, mutating *session* in place.

        Returns the Meta message ids (wamids) of every outbound message sent
        while handling this inbound message.
        """
        self._sent_wamids = []
        now = _now_iso()

        # Append user turn to history (cap at 10)
        session.history.append({"role": "user", "content": message.text, "ts": now})
        if len(session.history) > 10:
            session.history = session.history[-10:]

        deps = ExecutorDeps(
            meta_send=self._meta_send,
            vector_store=self._vector_store,
            llm=self._llm,
            phone_number_id=message.phone_number_id,
            access_token=message.access_token,
        )

        active_flows = self._flow_repo.get_active_flows(message.tenant_id)

        try:
            if session.state == "IN_FLOW":
                self._continue_flow(session, message, active_flows, deps)
            else:
                self._start_or_fallback(session, message, active_flows, deps)
        except MaxIterationsError:
            logger.error(
                "Max iterations reached — aborting flow",
                extra={"tenant_id": message.tenant_id, "wa_id": message.wa_id},
            )
            session.state = "ERROR"
        except NodeExecutionError as exc:
            logger.warning(
                "Node execution error",
                extra={
                    "tenant_id": message.tenant_id,
                    "wa_id": message.wa_id,
                    "node_id": exc.node_id,
                    "reason": exc.reason,
                },
            )
            session.state = "ERROR"

        session.last_msg_at = _now_iso()
        return self._sent_wamids

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _continue_flow(
        self,
        session: Session,
        message: InboundMessage,
        active_flows: list[Flow],
        deps: ExecutorDeps,
    ) -> None:
        """Session is already IN_FLOW — execute the current node."""
        flow = _find_flow(active_flows, session.flow_id)
        if flow is None:
            logger.warning(
                "Active flow not found — resetting to IDLE",
                extra={"flow_id": session.flow_id},
            )
            _reset_flow_state(session)
            return

        node = flow.nodes.get(session.current_node or "")
        if node is None:
            logger.warning("Current node not found — resetting", extra={"node": session.current_node})
            _reset_flow_state(session)
            return

        result = execute_node(node, session, message.text, deps)
        self._record_sent(_apply_result(session, result))
        self._log_assistant_turn(session, result, message)

        if not result.requires_user_input and not result.done:
            self._execute_until_wait_or_end(session, flow, "", deps, message)

    def _start_or_fallback(
        self,
        session: Session,
        message: InboundMessage,
        active_flows: list[Flow],
        deps: ExecutorDeps,
    ) -> None:
        """Session is IDLE — try to match a flow trigger; fall back to LLM."""
        matched_flow = match_trigger(message.text, active_flows)
        if matched_flow:
            session.state = "IN_FLOW"
            session.flow_id = matched_flow.id
            session.current_node = matched_flow.entry_node
            session.slots = {}
            session.retry_count = 0
            self._execute_until_wait_or_end(session, matched_flow, message.text, deps, message)
        else:
            self._run_llm_fallback(session, message, deps)

    def _execute_until_wait_or_end(
        self,
        session: Session,
        flow: Flow,
        trigger_text: str,
        deps: ExecutorDeps,
        message: InboundMessage,
    ) -> None:
        """Advance through non-waiting nodes until a wait or end is hit."""
        for iteration in range(_MAX_ITERATIONS):
            node = flow.nodes.get(session.current_node or "")
            if node is None:
                _reset_flow_state(session)
                return

            result = execute_node(node, session, trigger_text, deps)
            self._record_sent(_apply_result(session, result))
            self._log_assistant_turn(session, result, message)

            # Clear trigger text after first node — subsequent nodes are automatic
            trigger_text = ""

            if result.done:
                _reset_flow_state(session)
                return
            if result.requires_user_input or result.next_node is None:
                return

        raise MaxIterationsError(_MAX_ITERATIONS)

    def _run_llm_fallback(
        self,
        session: Session,
        message: InboundMessage,
        deps: ExecutorDeps,
    ) -> None:
        """No flow matched — use RAG + LLM as fallback reply."""
        session.state = "LLM_FALLBACK"
        rag_context: str | None = None
        results = self._vector_store.query(message.tenant_id, message.text, top_k=5)
        if results and results[0][1] >= 0.5:
            rag_context = "\n\n".join(text for text, _ in results)

        try:
            reply_text, tokens = self._llm.generate(
                system_prompt="You are a helpful WhatsApp assistant. Answer concisely.",
                history=session.history[-10:],
                user_message=message.text,
                rag_context=rag_context,
                max_tokens=500,
            )
        except Exception:
            logger.exception(
                "LLM fallback failed",
                extra={"tenant_id": message.tenant_id, "wa_id": message.wa_id},
            )
            session.state = "IDLE"
            return

        sent_wamid = deps.meta_send.send_text(
            phone_number_id=message.phone_number_id,
            to=message.wa_id,
            text=reply_text,
            access_token=message.access_token,
        )
        self._record_sent(sent_wamid)

        session.history.append({"role": "assistant", "content": reply_text, "ts": _now_iso()})
        if len(session.history) > 10:
            session.history = session.history[-10:]

        session.state = "IDLE"

    def _record_sent(self, wamid: str | None) -> None:
        """Record the Meta message id of an outbound message."""
        if wamid:
            self._sent_wamids.append(wamid)

    def _log_assistant_turn(
        self,
        session: Session,
        result: NodeResult,
        message: InboundMessage,
    ) -> None:
        """Append assistant reply to history."""
        if result.reply:
            session.history.append(
                {"role": "assistant", "content": result.reply, "ts": _now_iso()}
            )
            if len(session.history) > 10:
                session.history = session.history[-10:]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _find_flow(flows: list[Flow], flow_id: str | None) -> Flow | None:
    if not flow_id:
        return None
    return next((f for f in flows if f.id == flow_id), None)


def _reset_flow_state(session: Session) -> None:
    """Reset flow-related fields; preserve history."""
    session.state = "IDLE"
    session.flow_id = None
    session.current_node = None
    session.slots = {}
    session.retry_count = 0


def _apply_result(session: Session, result: NodeResult) -> str | None:
    """Apply NodeResult mutations to the session.

    Returns the Meta message id of any message sent by the node, so the caller
    can record it for delivery-status correlation.
    """
    session.slots.update(result.slot_updates)
    if result.next_node:
        session.current_node = result.next_node
    return result.sent_wamid


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
