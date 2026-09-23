"""Unit tests for application/flow_executor.py.

All infrastructure dependencies are replaced with fakes.
No real Redis, Postgres, ChromaDB, or Meta API is used.
"""
from __future__ import annotations

from typing import Any

import pytest

from flow_engine.application.flow_executor import FlowExecutor
from flow_engine.domain.models import (
    ConversationTurn,
    Flow,
    FlowNode,
    InboundMessage,
    Session,
)
from flow_engine.domain.ports import IConvLogRepo, IFlowRepo, ILLMPort, IMetaSendPort, IVectorStore
from flow_engine.infrastructure.meta.meta_send_client import RecordingMetaSendClient


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class FakeFlowRepo(IFlowRepo):
    def __init__(self, flows: list[Flow]) -> None:
        self._flows = flows

    def get_active_flows(self, tenant_id: str) -> list[Flow]:
        return self._flows

    def reload_tenant(self, tenant_id: str) -> None:
        pass


class FakeVectorStore(IVectorStore):
    def query(self, tenant_id, query_text, top_k=5) -> list[tuple[str, float]]:
        return []


class FakeLLMPort(ILLMPort):
    def __init__(self) -> None:
        self.called = False

    def generate(self, system_prompt, history, user_message, rag_context=None, max_tokens=500):
        self.called = True
        return "LLM fallback reply", 10


class FakeConvLogRepo(IConvLogRepo):
    def __init__(self) -> None:
        self.logs: list[ConversationTurn] = []

    def write(self, turn: ConversationTurn) -> None:
        self.logs.append(turn)


def _message(text: str = "hello", tenant_id: str = "t1") -> InboundMessage:
    return InboundMessage(
        message_id="msg-001",
        tenant_id=tenant_id,
        phone_number_id="phone-001",
        wa_id="521234567890",
        text=text,
        timestamp="2026-01-01T00:00:00+00:00",
        access_token="tok-test",
    )


def _session(state: str = "IDLE", flow_id: str | None = None, current_node: str | None = None) -> Session:
    return Session(
        tenant_id="t1",
        wa_id="521234567890",
        state=state,  # type: ignore[arg-type]
        flow_id=flow_id,
        current_node=current_node,
        slots={},
        history=[],
        retry_count=0,
        started_at="2026-01-01T00:00:00+00:00",
        last_msg_at="2026-01-01T00:00:00+00:00",
    )


def _make_simple_flow(
    keywords: list[str],
    flow_id: str = "flow-1",
) -> Flow:
    """Flow: start (message) → end."""
    end = FlowNode(id="end", node_type="end", config={"content": "Bye"}, transitions=[])
    start = FlowNode(
        id="start",
        node_type="message",
        config={"content": "Hi!"},
        transitions=[{"condition": "default", "next_node": "end"}],
    )
    return Flow(
        id=flow_id,
        tenant_id="t1",
        name="Simple Flow",
        trigger={"type": "keyword_match", "keywords": keywords},
        entry_node="start",
        nodes={"start": start, "end": end},
        is_active=True,
    )


def _make_executor(
    flows: list[Flow] | None = None,
    recording: RecordingMetaSendClient | None = None,
    llm: ILLMPort | None = None,
) -> tuple[FlowExecutor, RecordingMetaSendClient, FakeConvLogRepo]:
    rec = recording or RecordingMetaSendClient()
    conv_log = FakeConvLogRepo()
    executor = FlowExecutor(
        flow_repo=FakeFlowRepo(flows or []),
        meta_send=rec,
        vector_store=FakeVectorStore(),
        llm=llm or FakeLLMPort(),
        conv_log_repo=conv_log,
    )
    return executor, rec, conv_log


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestIdleToFlowMatch:
    def test_matching_trigger_transitions_to_in_flow(self) -> None:
        flow = _make_simple_flow(keywords=["hola"])
        executor, recording, _ = _make_executor(flows=[flow])
        session = _session()
        executor.execute(_message("hola mundo"), session)
        # After execution: flow runs through start → end, resets to IDLE
        assert session.state == "IDLE"  # end node resets

    def test_no_match_stays_idle(self) -> None:
        flow = _make_simple_flow(keywords=["precio"])
        llm = FakeLLMPort()
        executor, _, _ = _make_executor(flows=[flow], llm=llm)
        session = _session()
        executor.execute(_message("random message"), session)
        assert llm.called is True  # fell back to LLM

    def test_matching_trigger_sets_flow_state(self) -> None:
        """Use a flow where first node waits for input — state stays IN_FLOW."""
        wait_node = FlowNode(
            id="wait",
            node_type="message",
            config={"content": "What is your name?", "collect_slot": "name"},
            transitions=[],
        )
        flow = Flow(
            id="f1",
            tenant_id="t1",
            name="Ask Name",
            trigger={"type": "keyword_match", "keywords": ["start"]},
            entry_node="wait",
            nodes={"wait": wait_node},
            is_active=True,
        )
        executor, _, _ = _make_executor(flows=[flow])
        session = _session()
        executor.execute(_message("start"), session)
        assert session.state == "IN_FLOW"
        assert session.flow_id == "f1"


class TestInFlowContinuation:
    def test_in_flow_advances_to_next_node(self) -> None:
        collect_node = FlowNode(
            id="collect",
            node_type="collect_input",
            config={"slot": "name", "prompt": "Name?"},
            transitions=[{"condition": "default", "next_node": "confirm"}],
        )
        # A `message` node rather than `end`: finishing a flow deliberately
        # clears the slots (see TestEndNodeResetsState), so asserting slot
        # contents after an `end` node contradicts that and could never pass.
        # Asserting them while the flow is still live is what this test means.
        confirm_node = FlowNode(
            id="confirm",
            node_type="message",
            # format_map over session.slots raises KeyError if the answer was
            # not captured, so the placeholder is part of the assertion.
            config={"content": "Thanks {name}!"},
            transitions=[],
        )
        flow = Flow(
            id="f1",
            tenant_id="t1",
            name="Collect Flow",
            trigger={"type": "always"},
            entry_node="collect",
            nodes={"collect": collect_node, "confirm": confirm_node},
            is_active=True,
        )
        executor, _, _ = _make_executor(flows=[flow])
        session = _session(state="IN_FLOW", flow_id="f1", current_node="collect")
        executor.execute(_message("Alice"), session)
        assert session.slots.get("name") == "Alice"
        assert session.current_node == "confirm"
        assert session.state == "IN_FLOW"


class TestEndNodeResetsState:
    def test_end_node_resets_flow_fields(self) -> None:
        flow = _make_simple_flow(keywords=["start"])
        executor, _, _ = _make_executor(flows=[flow])
        session = _session()
        executor.execute(_message("start"), session)
        assert session.state == "IDLE"
        assert session.flow_id is None
        assert session.current_node is None
        assert session.slots == {}


class TestMaxIterationGuard:
    def test_infinite_loop_aborts_at_20(self) -> None:
        """A flow that never waits and never ends hits the iteration limit."""
        # node loops to itself
        loop_node = FlowNode(
            id="loop",
            node_type="condition",
            config={},
            transitions=[{"condition": "default", "next_node": "loop"}],
        )
        flow = Flow(
            id="f1",
            tenant_id="t1",
            name="Loop",
            trigger={"type": "keyword_match", "keywords": ["loop"]},
            entry_node="loop",
            nodes={"loop": loop_node},
            is_active=True,
        )
        executor, _, _ = _make_executor(flows=[flow])
        session = _session()
        executor.execute(_message("loop"), session)
        # MaxIterationsError is caught → state set to ERROR
        assert session.state == "ERROR"


class TestLLMFallback:
    def test_no_flow_match_calls_llm(self) -> None:
        llm = FakeLLMPort()
        executor, recording, _ = _make_executor(flows=[], llm=llm)
        session = _session()
        executor.execute(_message("random"), session)
        assert llm.called is True
        assert len(recording.sent) == 1
        assert recording.sent[0]["text"] == "LLM fallback reply"
        assert session.state == "IDLE"
