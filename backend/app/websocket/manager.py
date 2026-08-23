"""
manager.py
----------
ConnectionManager: tracks WebSocket connections, sends all typed messages.
AlertRingBuffer: in-memory circular store for history replay.
"""

import uuid
from collections import deque
from datetime import datetime, timezone
from typing import Any

from fastapi import WebSocket

from app.gcn.topics import ALL_TOPICS

SCHEMA_VERSION  = "1"
HEARTBEAT_INTERVAL_S = 30
BUFFER_CAPACITY = 200          # max events kept for replay


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


# ---------------------------------------------------------------------------
# Alert ring buffer — history replay
# ---------------------------------------------------------------------------

class AlertRingBuffer:
    """
    Circular buffer of the last BUFFER_CAPACITY normalized alert envelopes.
    Thread-safe for reads; writes happen only from the asyncio event loop.
    """

    def __init__(self, capacity: int = BUFFER_CAPACITY) -> None:
        self._capacity = capacity
        self._store: deque[dict] = deque(maxlen=capacity)

    def push(self, envelope: dict) -> None:
        """Add a broadcast-ready alert envelope to the tail of the buffer."""
        self._store.append(envelope)

    def since(
        self,
        iso_timestamp: str,
        last_sequence: int | None = None,
    ) -> list[dict]:
        """
        Return all envelopes whose event.detectionTime > iso_timestamp.
        If last_sequence is provided, additionally exclude envelopes with
        sequence <= last_sequence (dedup guard for clock-skew edge cases).
        """
        results = []
        for envelope in self._store:
            event_time = envelope.get("event", {}).get("detectionTime", "")
            if event_time <= iso_timestamp:
                continue
            if last_sequence is not None:
                seq = envelope.get("sequence", 0)
                if seq <= last_sequence:
                    continue
            results.append(envelope)
        return results


alert_buffer = AlertRingBuffer()


# ---------------------------------------------------------------------------
# Connection manager
# ---------------------------------------------------------------------------

class ConnectionManager:

    def __init__(self) -> None:
        self.active_connections: list[WebSocket] = []
        self._kafka_connected: bool = True          # updated by background_listener
        self._last_alert_at: str | None = None      # updated by consumer
        self._last_sequence: int | None = None      # updated by consumer

    # ------------------------------------------------------------------
    # Connection lifecycle
    # ------------------------------------------------------------------

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.active_connections.append(websocket)
        await self._send_ack(websocket)

    def disconnect(self, websocket: WebSocket) -> None:
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    # ------------------------------------------------------------------
    # State setters (called by background_listener / consumer)
    # ------------------------------------------------------------------

    def set_kafka_connected(self, value: bool) -> None:
        self._kafka_connected = value

    def record_alert(self, sent_at: str, sequence: int) -> None:
        """Called by consumer.process_alert after a successful broadcast."""
        self._last_alert_at = sent_at
        self._last_sequence = sequence

    # ------------------------------------------------------------------
    # Typed send helpers
    # ------------------------------------------------------------------

    async def _send_ack(self, websocket: WebSocket) -> None:
        """
        Send connection_ack immediately after accepting a client.

        Why session_id: the frontend stores it for future auth / debug use.
        Why buffer_size: the client uses this to decide whether to bother
          sending a history_request (no point if buffer is 0).
        Why heartbeat_interval: client sets its watchdog to interval * 1.5.
        Why deprecated: allows server to signal a graceful migration window.
        """
        ack = {
            "type":               "connection_ack",
            "schema_version":     SCHEMA_VERSION,
            "sent_at":            _now_iso(),
            "session_id":         str(uuid.uuid4()),
            "server_time":        _now_iso(),
            # ALL_TOPICS, not TOPICS: the ack must report what the consumer is
            # actually subscribed to. Reporting only the notice topics would
            # tell a client that circulars are not being consumed while they
            # were arriving on the very same socket.
            "subscribed_topics":  ALL_TOPICS,
            "buffer_size":        BUFFER_CAPACITY,
            "heartbeat_interval": HEARTBEAT_INTERVAL_S,
            "deprecated":         False,
        }
        try:
            await websocket.send_json(ack)
        except Exception as exc:
            print(f"[manager] Failed to send connection_ack: {exc}")
            self.disconnect(websocket)

    async def send_heartbeat(self) -> None:
        """
        Broadcast heartbeat to all connected clients.

        Why kafka_connected: lets the client surface "Kafka disconnected"
          without forcing a reconnect (TCP is healthy; Kafka may recover).
        Why last_sequence: client uses this to detect gaps in the alert
          stream without relying on timestamps alone.
        """
        heartbeat = {
            "type":               "heartbeat",
            "schema_version":     SCHEMA_VERSION,
            "sent_at":            _now_iso(),
            "listener_alive":     True,
            "kafka_connected":    self._kafka_connected,
            "last_alert_at":      self._last_alert_at,
            "last_sequence":      self._last_sequence,
            "active_connections": len(self.active_connections),
        }
        await self.broadcast(heartbeat)

    async def send_pong(self, websocket: WebSocket, echo_sent_at: str) -> None:
        """
        Send pong to a single client.

        Why echo_sent_at: the client copies its own sent_at into the
          history_request; echoing it back lets the client compute RTT.
        """
        try:
            await websocket.send_json({
                "type":           "pong",
                "schema_version": SCHEMA_VERSION,
                "sent_at":        _now_iso(),
                "echo_sent_at":   echo_sent_at,
            })
        except Exception:
            self.disconnect(websocket)

    async def send_history(
        self,
        websocket: WebSocket,
        request_id: str,
        since: str,
        last_sequence: int | None,
    ) -> None:
        """
        Replay buffered events to a single client.

        Sequence:
          1. history_start  (tells client how many events to expect)
          2. history_event  × N
          3. history_end    (truncated flag if buffer didn't go back far enough)

        Why unicast not broadcast: only the reconnecting client needs replay;
          all other connected clients already have the events.
        """
        events = alert_buffer.since(since, last_sequence)

        # history_start
        try:
            await websocket.send_json({
                "type":           "history_start",
                "schema_version": SCHEMA_VERSION,
                "sent_at":        _now_iso(),
                "request_id":     request_id,
                "since":          since,
                "total_events":   len(events),
            })
        except Exception:
            self.disconnect(websocket)
            return

        # history_event × N
        sent = 0
        for envelope in events:
            try:
                await websocket.send_json({
                    "type":         "history_event",
                    "schema_version": SCHEMA_VERSION,
                    "sent_at":      _now_iso(),
                    "request_id":   request_id,
                    "event":        envelope["event"],
                    "notification": envelope["notification"],
                })
                sent += 1
            except Exception:
                self.disconnect(websocket)
                return

        # Truncated if buffer capacity was hit before reaching `since`
        truncated = len(self._store_snapshot()) >= BUFFER_CAPACITY and len(events) == 0

        # history_end
        try:
            await websocket.send_json({
                "type":           "history_end",
                "schema_version": SCHEMA_VERSION,
                "sent_at":        _now_iso(),
                "request_id":     request_id,
                "events_sent":    sent,
                "truncated":      truncated,
            })
        except Exception:
            self.disconnect(websocket)

    def _store_snapshot(self) -> list:
        return list(alert_buffer._store)

    # ------------------------------------------------------------------
    # Broadcast
    # ------------------------------------------------------------------

    async def broadcast(self, message: dict[str, Any]) -> None:
        """
        Send a message to all connected clients.
        Failed clients are collected and removed after iteration to avoid
        mutating active_connections mid-loop.
        """
        dead: list[WebSocket] = []
        for conn in self.active_connections:
            try:
                await conn.send_json(message)
            except Exception:
                dead.append(conn)
        for conn in dead:
            self.disconnect(conn)

    async def send_error(
        self,
        websocket: WebSocket,
        code: str,
        detail: str,
        request_id: str | None = None,
    ) -> None:
        """Send a structured error message to a single client."""
        error: dict[str, Any] = {
            "type":           "error",
            "schema_version": SCHEMA_VERSION,
            "sent_at":        _now_iso(),
            "code":           code,
            "detail":         detail,
        }
        if request_id:
            error["request_id"] = request_id
        try:
            await websocket.send_json(error)
        except Exception:
            self.disconnect(websocket)


manager = ConnectionManager()