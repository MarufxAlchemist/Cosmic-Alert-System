import { WebSocketServer, WebSocket } from "ws";
import { logger } from "./logger";

let wss: WebSocketServer | null = null;

export function setWebSocketServer(server: WebSocketServer) {
  wss = server;
}

let sequenceCount = 1;

export function broadcastEvent(event: Record<string, unknown>) {
  if (!wss) return;

  const snr = typeof event["snr"] === "number" ? event["snr"] : 0;
  const far = typeof event["far"] === "number" ? event["far"] : 1;
  const priority = snr >= 20 || far < 1e-6 ? "high" : "normal";

  const notifMsg = {
    event_id:   event["eventId"],
    event_type: event["eventType"],
    observatory: event["observatory"],
    timestamp:  event["detectionTime"],
    priority,
  };

  const alertMsg = JSON.stringify({
    type: "alert",
    schema_version: "1",
    sent_at: new Date().toISOString(),
    sequence: sequenceCount++,
    event,
    notification: notifMsg,
  });

  let count = 0;
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(alertMsg);
      count++;
    }
  });
  logger.info({ clientCount: count, eventId: event["eventId"] }, "Broadcasted new event to WS clients");
}

/**
 * Broadcast an in-place update for an existing event.
 * The frontend handles type:"event_updated" by replacing the existing card
 * (matched by eventId) rather than prepending a new one.
 */
export function broadcastEventUpdate(event: Record<string, unknown>) {
  if (!wss) return;

  const updateMsg = JSON.stringify({
    type: "event_updated",
    schema_version: "1",
    sent_at: new Date().toISOString(),
    sequence: sequenceCount++,
    event,
  });

  let count = 0;
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(updateMsg);
      count++;
    }
  });
  logger.info(
    { clientCount: count, eventId: event["eventId"], revisionCount: event["revisionCount"] },
    "Broadcasted event_updated to WS clients",
  );
}

// ─── GCN Circulars ───────────────────────────────────────────────────────────
//
// Three message types, following the existing envelope exactly: same
// `schema_version: "1"`, same `sent_at`, same monotonically increasing
// `sequence` counter shared with alert/event_updated so a client can order
// every server message on one timeline.
//
// The payload key is `circular`, NOT `event`. A circular is not an event, and
// reusing the `event` key would make an existing client's `toAstroEvent()`
// adapter run over a shape that has no ra, dec or detectionTime — producing a
// card full of missing measurements for something that was never a detection.
//
// The body is deliberately absent from all three: broadcasting tens of
// kilobytes of text to every connected client on every circular is wasteful,
// and the client fetches the full circular when a researcher opens it.

function broadcastCircularMessage(
  type: "circular_added" | "circular_updated" | "circular_enriched",
  circular: Record<string, unknown>,
): void {
  if (!wss) return;

  const message = JSON.stringify({
    type,
    schema_version: "1",
    sent_at: new Date().toISOString(),
    sequence: sequenceCount++,
    circular,
  });

  let count = 0;
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
      count++;
    }
  });

  logger.info(
    {
      clientCount: count,
      type,
      circularId: circular["circularId"],
      version: circular["version"],
      eventId: circular["eventId"],
    },
    `Broadcasted ${type} to WS clients`,
  );
}

/** A new GCN Circular was stored and associated with an event. */
export function broadcastCircularAdded(circular: Record<string, unknown>): void {
  broadcastCircularMessage("circular_added", circular);
}

/**
 * A revised version of a circular arrived.
 *
 * The earlier version is still stored and still readable — this announces that
 * a newer one exists, not that the old one was replaced.
 */
export function broadcastCircularUpdated(circular: Record<string, unknown>): void {
  broadcastCircularMessage("circular_updated", circular);
}

/**
 * AI extraction finished for a circular that was already visible.
 *
 * Emitted only on success. A failed extraction is not broadcast: the circular
 * on screen is unchanged and still complete, and pushing a failure notice for
 * an enrichment layer would imply something happened to the science.
 */
export function broadcastCircularEnriched(circular: Record<string, unknown>): void {
  broadcastCircularMessage("circular_enriched", circular);
}
