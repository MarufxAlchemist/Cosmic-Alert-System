"""
test_circular_routing.py
------------------------
The Python backend's only job for GCN Circulars is to route them somewhere
completely separate from notices and forward them verbatim. These tests protect
exactly that, because the failure they prevent is silent:

  * A circular reaching the notice normalizer would be given an invented
    detection time, position and significance, and stored as a detection that
    never happened.
  * A circular whose payload key was `event` instead of `circular` would be run
    through the consumer's alert adapter for the same reason.
  * A circular in the alert replay buffer would be handed to a reconnecting
    dashboard as event history.

The Kafka broker is stubbed, so these run with no credentials and no network.
"""

import asyncio
import json
import sys
import types
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


def _install_stubs() -> None:
    """
    Stub the two runtime-only dependencies these tests do not exercise.

    The existing suite runs under an interpreter that has neither `gcn_kafka`
    nor `fastapi` — they live in backend/venv, which is the deployment
    environment, not the test one. Stubbing them here keeps these tests in the
    same `python -m pytest tests/` run as the other 378 rather than needing a
    second environment, and neither module is under test: `gcn_kafka` only
    supplies a Consumer that is never polled, and `fastapi.WebSocket` is used
    by manager.py purely as a type annotation.
    """
    if "gcn_kafka" not in sys.modules:
        fake_kafka = types.ModuleType("gcn_kafka")
        fake_kafka.Consumer = _StubConsumer
        sys.modules["gcn_kafka"] = fake_kafka

    try:
        import fastapi  # noqa: F401, PLC0415
    except ModuleNotFoundError:
        fake_fastapi = types.ModuleType("fastapi")

        class WebSocket:  # minimal stand-in; only ever used as an annotation
            pass

        fake_fastapi.WebSocket = WebSocket
        sys.modules["fastapi"] = fake_fastapi


class _StubConsumer:
    """Stands in for gcn_kafka.Consumer so importing the module needs no broker."""

    def __init__(self, **_kwargs):
        self.topics = None

    def subscribe(self, topics):
        self.topics = topics

    def consume(self, timeout=1):  # pragma: no cover - never polled here
        return []


@pytest.fixture(scope="module")
def consumer_module():
    _install_stubs()

    import app.gcn.consumer as consumer  # noqa: PLC0415

    return consumer


@pytest.fixture
def captured(consumer_module, monkeypatch):
    """Capture what would have been broadcast and what entered the replay buffer."""
    import app.websocket.manager as wsm  # noqa: PLC0415

    broadcasts: list[dict] = []
    buffered: list[dict] = []

    async def _broadcast(envelope):
        broadcasts.append(envelope)

    monkeypatch.setattr(wsm.manager, "broadcast", _broadcast)
    monkeypatch.setattr(wsm.alert_buffer, "push", buffered.append)
    return broadcasts, buffered


CIRCULAR = {
    "circularId": 35176,
    "subject": "GRB 231124A: CALET Gamma-Ray Burst Monitor detection",
    "eventId": "GRB 231124A",
    "body": "The long GRB 231124A triggered the CALET Gamma-ray Burst Monitor.",
    "submitter": "Yuta Kawakubo at Louisiana State University",
    "createdOn": 1700834480583,
}


class _Message:
    """Minimal stand-in for a confluent_kafka Message."""

    def __init__(self, topic: str, value: str):
        self._topic = topic
        self._value = value

    def topic(self):
        return self._topic

    def value(self):
        return self._value.encode()

    def error(self):
        return None


# ── Subscription ─────────────────────────────────────────────────────────────


def test_every_notice_topic_is_still_subscribed(consumer_module):
    """
    Adding gcn.circulars must be purely additive.

    Subscribing to a narrower list would silently stop notice ingestion, which
    looks identical to the observatories having gone quiet.
    """
    from app.gcn.topics import ALL_TOPICS, TOPICS

    assert set(TOPICS).issubset(set(ALL_TOPICS))
    assert consumer_module.consumer.topics == ALL_TOPICS


def test_circulars_are_not_in_the_notice_metadata_table(consumer_module):
    """
    get_topic_meta() is the notice lookup. A circular reaching it would be given
    the GRB/Unknown/normal fallback and normalized as a detection.
    """
    from app.gcn.topics import CIRCULAR_TOPICS, TOPIC_METADATA

    for topic in CIRCULAR_TOPICS:
        assert topic not in TOPIC_METADATA


def test_is_circular_topic_discriminates(consumer_module):
    from app.gcn.topics import is_circular_topic

    assert is_circular_topic("gcn.circulars")
    assert not is_circular_topic("igwn.gwalert")
    assert not is_circular_topic("gcn.notices.chime.frb")


# ── Envelope ─────────────────────────────────────────────────────────────────


def test_circular_is_broadcast_with_its_own_type_and_key(consumer_module, captured):
    broadcasts, _ = captured
    asyncio.run(consumer_module.process_circular("gcn.circulars", json.dumps(CIRCULAR)))

    assert len(broadcasts) == 1
    envelope = broadcasts[0]
    assert envelope["type"] == "circular"
    # The key must be `circular`. A consumer that found `event` here would run
    # the circular through the alert path.
    assert "circular" in envelope
    assert "event" not in envelope


def test_payload_is_forwarded_verbatim(consumer_module, captured):
    """
    Nothing is normalized, inferred or stripped here. Association happens in the
    Node api-server, which owns core.events and can match deterministically.
    """
    broadcasts, _ = captured
    asyncio.run(consumer_module.process_circular("gcn.circulars", json.dumps(CIRCULAR)))
    assert broadcasts[0]["circular"] == CIRCULAR


def test_circular_never_enters_the_alert_replay_buffer(consumer_module, captured):
    """
    alert_buffer replays *alerts* to a reconnecting dashboard. A circular in it
    would be replayed as event history.
    """
    broadcasts, buffered = captured
    asyncio.run(consumer_module.process_circular("gcn.circulars", json.dumps(CIRCULAR)))
    assert broadcasts, "the circular should still have been broadcast"
    assert buffered == []


# ── Routing ──────────────────────────────────────────────────────────────────


def test_process_alert_routes_a_circular_topic_to_the_circular_path(
    consumer_module, captured
):
    broadcasts, _ = captured
    asyncio.run(
        consumer_module.process_alert(_Message("gcn.circulars", json.dumps(CIRCULAR)))
    )
    assert len(broadcasts) == 1
    assert broadcasts[0]["type"] == "circular"


# ── Malformed input ──────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "raw",
    [
        "not json at all",
        json.dumps([1, 2, 3]),
        json.dumps({"subject": "a circular with no circularId"}),
    ],
    ids=["non-json", "json-array", "no-circular-id"],
)
def test_malformed_circulars_are_dropped_without_raising(
    consumer_module, captured, raw
):
    """
    The Kafka poll loop must not stop for one bad message, and a circular with
    no id has no identity to deduplicate on downstream.
    """
    broadcasts, _ = captured
    asyncio.run(consumer_module.process_circular("gcn.circulars", raw))
    assert broadcasts == []
