import { useState, useEffect, useRef, useCallback } from "react";
import type { AstroEvent } from "@workspace/api-client-react/src/generated/api.schemas";
import type { AlertNotification } from "@/lib/NotificationsContext";

// ---------------------------------------------------------------------------
// Server message types (discriminated union, schema_version 1)
// ---------------------------------------------------------------------------

interface BaseMessage {
  type: string;
  schema_version: string;
  sent_at: string;
}

interface ConnectionAckMessage extends BaseMessage {
  type: "connection_ack";
  session_id: string;
  server_time: string;
  subscribed_topics: string[];
  buffer_size: number;
  heartbeat_interval: number;
  deprecated: boolean;
}

interface AlertMessage extends BaseMessage {
  type: "alert";
  sequence: number;
  event: RawEvent;
  notification: RawNotification;
}

interface EventUpdatedMessage extends BaseMessage {
  type: "event_updated";
  sequence: number;
  event: RawEvent;
}

/**
 * GCN Circular frames.
 *
 * The payload key is `circular`, NOT `event`: a circular is a human-authored
 * report, not a detection. Feeding one through toAstroEvent() would produce a
 * card with no position, no time and no significance — an event that never
 * happened. The three types are kept in their own list for the same reason.
 */
interface CircularMessageBase extends BaseMessage {
  sequence: number;
  circular: RawCircular;
}

interface CircularAddedMessage extends CircularMessageBase {
  type: "circular_added";
}

/** A revised version arrived. The earlier version is still stored and readable. */
interface CircularUpdatedMessage extends CircularMessageBase {
  type: "circular_updated";
}

/** AI extraction finished for a circular that was already visible. */
interface CircularEnrichedMessage extends CircularMessageBase {
  type: "circular_enriched";
}

interface HeartbeatMessage extends BaseMessage {
  type: "heartbeat";
  listener_alive: boolean;
  kafka_connected: boolean;
  last_alert_at: string | null;
  last_sequence: number | null;
  active_connections: number;
}

interface HistoryStartMessage extends BaseMessage {
  type: "history_start";
  request_id: string;
  since: string;
  total_events: number;
}

interface HistoryEventMessage extends BaseMessage {
  type: "history_event";
  request_id: string;
  event: RawEvent;
  notification: RawNotification;
}

interface HistoryEndMessage extends BaseMessage {
  type: "history_end";
  request_id: string;
  events_sent: number;
  truncated: boolean;
}

interface PongMessage extends BaseMessage {
  type: "pong";
  echo_sent_at: string;
}

interface ErrorMessage extends BaseMessage {
  type: "error";
  code: string;
  detail: string;
  request_id?: string;
}

type ServerMessage =
  | ConnectionAckMessage
  | AlertMessage
  | EventUpdatedMessage
  | CircularAddedMessage
  | CircularUpdatedMessage
  | CircularEnrichedMessage
  | HeartbeatMessage
  | HistoryStartMessage
  | HistoryEventMessage
  | HistoryEndMessage
  | PongMessage
  | ErrorMessage;

// ---------------------------------------------------------------------------
// Raw backend shapes (snake_case) → mapped to camelCase AstroEvent below
// ---------------------------------------------------------------------------

interface RawEvent {
  id: string;
  eventId: string;
  eventType: string;
  observatory: string;
  topic: string;
  detectionTime: string;
  ra: number;
  dec: number;
  errorRadius: number;
  snr: number;
  far: number;
  // MEASURED ingestion latency — null means UNKNOWN (never received live).
  latencyUs: number | null;
  // DERIVED sky geometry — null means UNKNOWN, never a placeholder.
  galLon: number | null;
  galLat: number | null;
  sunDistance: number | null;
  moonDistance: number | null;
  fluence: number | null;
  dm: number | null;
  raw: any;
  // Alert filtering metadata
  lifecycle?: "preliminary" | "initial" | "update" | "confirmed";
  alertType?: string | null;
  latestRevision?: string | null;
  revisionCount?: number;
  classificationTier?: "GOLD" | "BRONZE" | null;
  updatedAt?: string;
}

/**
 * A circular as broadcast. The body is deliberately absent: pushing tens of
 * kilobytes of text to every client on every circular is wasteful, and the
 * full text is fetched when a researcher opens it.
 */
interface RawCircular {
  id: string;
  circularId: number;
  version: number;
  isLatest: boolean;
  /** core.events primary key, or null when the circular is attached to nothing. */
  eventPk: string | null;
  eventId: string | null;
  gcnEventId: string | null;
  subject: string;
  submitter: string;
  createdOn: string;
  associationMethod: string;
  gcnUrl: string | null;
  /** Present on circular_enriched only. */
  status?: string;
  provider?: string;
}

interface RawNotification {
  event_id: string;
  event_type: string;
  observatory: string;
  timestamp: string;
  priority: "normal" | "high";
}

// ---------------------------------------------------------------------------
// Adapter: RawEvent → AstroEvent
// ---------------------------------------------------------------------------

function toAstroEvent(raw: RawEvent): AstroEvent {
  return {
    id:                 raw.id,
    eventId:            raw.eventId,
    eventType:          raw.eventType as AstroEvent["eventType"],
    observatory:        raw.observatory,
    detectionTime:      raw.detectionTime,
    ra:                 raw.ra,
    dec:                raw.dec,
    errorRadius:        raw.errorRadius,
    snr:                raw.snr,
    far:                raw.far,
    latencyUs:          raw.latencyUs ?? null,
    galLon:             raw.galLon,
    galLat:             raw.galLat,
    sunDistance:        raw.sunDistance,
    moonDistance:       raw.moonDistance,
    fluence:            raw.fluence ?? null,
    dm:                 raw.dm     ?? null,
    // Alert filtering metadata — fall back gracefully for older server versions
    lifecycle:          raw.lifecycle ?? "preliminary",
    alertType:          raw.alertType ?? undefined,
    classificationTier: raw.classificationTier ?? undefined,
  } as AstroEvent;
}

// ---------------------------------------------------------------------------
// Reconnect config
// ---------------------------------------------------------------------------

const BASE_DELAY_MS  = 1_000;
const MAX_DELAY_MS   = 30_000;
const MAX_RETRIES    = 10;
const DEFAULT_WATCHDOG_MS = 45_000;

const NO_RECONNECT_CODES = new Set([
  1000, // Normal closure (server intentional)
  4001, // App-level: auth failure
  4002, // App-level: unsupported version
]);

function backoffDelay(attempt: number): number {
  const jitter = Math.random() * 1_000;
  return Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS) + jitter;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** crypto.randomUUID() is only available on HTTPS or localhost.
 *  This fallback works on plain HTTP (e.g. dev via LAN IP).  */
function safeUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // RFC-4122 v4 fallback
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseAstroWebSocketResult {
  events: AstroEvent[];
  isConnected: boolean;
  listenerAlive: boolean;
  kafkaConnected: boolean;
  latestNotification: Omit<AlertNotification, "id" | "seenAt"> | null;
  subscribedTopics: string[];
  retryCount: number;
  gaveUp: boolean;
  /**
   * The most recent circular event, or null. Consumers refetch the affected
   * event's circulars rather than trying to merge a partial payload into their
   * own cache — the body is not in the frame, so a merge could only produce a
   * half-populated circular.
   */
  latestCircular: CircularSignal | null;
}

/** What happened to a circular, for a consumer deciding whether to refetch. */
export interface CircularSignal {
  kind: "added" | "updated" | "enriched";
  circularId: number;
  version: number;
  eventPk: string | null;
  eventId: string | null;
  subject: string;
  receivedAt: string;
}

export function useAstroWebSocket(): UseAstroWebSocketResult {
  const [events,               setEvents]               = useState<AstroEvent[]>([]);
  const [isConnected,          setIsConnected]          = useState(false);
  const [listenerAlive,        setListenerAlive]        = useState(false);
  const [kafkaConnected,       setKafkaConnected]       = useState(true);
  const [latestNotification,   setLatestNotification]   = useState<Omit<AlertNotification, "id" | "seenAt"> | null>(null);
  const [subscribedTopics,     setSubscribedTopics]     = useState<string[]>([]);
  const [retryCount,           setRetryCount]           = useState(0);
  const [gaveUp,               setGaveUp]               = useState(false);
  const [latestCircular,       setLatestCircular]       = useState<CircularSignal | null>(null);

  const wsRef            = useRef<WebSocket | null>(null);
  const retryCountRef    = useRef(0);
  const reconnectTimer   = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const watchdogTimer    = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const unmountedRef     = useRef(false);

  const lastEventTimeRef = useRef<string | null>(null);
  const lastSequenceRef  = useRef<number | null>(null);
  const watchdogMsRef    = useRef<number>(DEFAULT_WATCHDOG_MS);

  // ------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------

  const sendJson = useCallback((data: any) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  const resetWatchdog = useCallback(() => {
    clearTimeout(watchdogTimer.current);
    watchdogTimer.current = setTimeout(() => {
      console.warn("[ws] Heartbeat watchdog expired — forcing reconnect");
      setListenerAlive(false);
      wsRef.current?.close(1001, "watchdog");
    }, watchdogMsRef.current);
  }, []);

  // ------------------------------------------------------------------
  // Message dispatcher
  // ------------------------------------------------------------------

  const handleMessage = useCallback((raw: string) => {
    let msg: ServerMessage;

    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      console.error("[ws] Unparseable message", raw);
      return;
    }

    if (msg.schema_version && msg.schema_version !== "1") {
      console.warn(`[ws] Unsupported schema_version: ${msg.schema_version}`);
    }

    switch (msg.type) {
      case "connection_ack": {
        setSubscribedTopics(msg.subscribed_topics);
        setListenerAlive(true);
        watchdogMsRef.current = msg.heartbeat_interval * 1500; // x1.5
        resetWatchdog();
        console.info("[ws] Connected. Topics:", msg.subscribed_topics);

        if (msg.deprecated) {
          console.warn("[ws] Server indicated this API version is deprecated.");
        }

        // Request history if we have a cursor
        if (lastEventTimeRef.current) {
          sendJson({
            type: "history_request",
            schema_version: "1",
            sent_at: new Date().toISOString(),
            request_id: safeUUID(),
            since: lastEventTimeRef.current,
            last_sequence: lastSequenceRef.current
          });
        }
        break;
      }

      case "alert": {
        const event = toAstroEvent(msg.event);
        
        lastEventTimeRef.current = event.detectionTime;
        lastSequenceRef.current = msg.sequence;

        setEvents(prev => {
          // Dedup by eventId — prevents duplicates if reconnect replays same event
          if (prev.some(e => e.eventId === event.eventId)) return prev;
          return [event, ...prev].slice(0, 100);
        });

        const { event_id, event_type, observatory, timestamp, priority } = msg.notification;
        setLatestNotification({
          event_id,
          event_type,
          observatory,
          timestamp,
          priority,
        });

        if (priority === "high") {
          sendJson({
            type: "ack",
            schema_version: "1",
            sent_at: new Date().toISOString(),
            event_id: event.eventId,
            sequence: msg.sequence
          });
        }
        break;
      }

      case "event_updated": {
        // A later notice arrived for an existing event — update the card in place.
        const updated = toAstroEvent(msg.event);
        setEvents(prev => {
          const idx = prev.findIndex(e => e.eventId === updated.eventId);
          if (idx === -1) {
            // Event not in memory yet (e.g. page loaded after PRELIMINARY was sent)
            // — treat it as a new card.
            return [updated, ...prev].slice(0, 100);
          }
          const next = [...prev];
          next[idx] = updated;
          return next;
        });
        break;
      }

      case "circular_added":
      case "circular_updated":
      case "circular_enriched": {
        // Circulars are NOT pushed into `events`. That array holds
        // astrophysical detections rendered as event cards; a human-authored
        // report has no position, no SNR and no detection time, and putting one
        // there would render a card full of missing measurements for something
        // that was never a detection.
        const kind =
          msg.type === "circular_added"
            ? "added"
            : msg.type === "circular_updated"
              ? "updated"
              : "enriched";

        setLatestCircular({
          kind,
          circularId: msg.circular.circularId,
          version: msg.circular.version,
          eventPk: msg.circular.eventPk,
          eventId: msg.circular.eventId,
          subject: msg.circular.subject,
          receivedAt: msg.sent_at,
        });

        console.info(
          `[ws] circular_${kind}: #${msg.circular.circularId} v${msg.circular.version}` +
            (msg.circular.eventId ? ` -> ${msg.circular.eventId}` : " (not attached to an event)"),
        );
        break;
      }

      case "heartbeat": {
        setListenerAlive(msg.listener_alive);
        setKafkaConnected(msg.kafka_connected);
        resetWatchdog();
        break;
      }

      case "history_start": {
        console.info(`[ws] History replay starting... (${msg.total_events} events expected)`);
        break;
      }

      case "history_event": {
        const event = toAstroEvent(msg.event);
        
        // Update cursors if this is newer
        if (!lastEventTimeRef.current || event.detectionTime > lastEventTimeRef.current) {
           lastEventTimeRef.current = event.detectionTime;
        }

        setEvents(prev => {
          if (prev.some(e => e.id === event.id)) return prev;
          // Sort after adding history to ensure chronological order
          const newEvents = [event, ...prev].sort(
            (a, b) => new Date(b.detectionTime).getTime() - new Date(a.detectionTime).getTime()
          );
          return newEvents.slice(0, 100);
        });
        break;
      }

      case "history_end": {
        console.info(`[ws] History replay complete. Truncated: ${msg.truncated}`);
        break;
      }

      case "pong": {
        // Optional latency calc
        break;
      }

      case "error": {
        console.error(`[ws] Server error ${msg.code}: ${msg.detail}`);
        break;
      }

      default: {
        console.debug("[ws] Unknown message type:", (msg as BaseMessage).type);
      }
    }
  }, [resetWatchdog, sendJson]);

  // ------------------------------------------------------------------
  // Connect / reconnect
  // ------------------------------------------------------------------

  const connect = useCallback(() => {
    if (unmountedRef.current) return;
    if (gaveUp) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    let wsUrl = `${protocol}//${window.location.host}/api/ws?v=1`;
    
    if (lastEventTimeRef.current) {
        wsUrl += `&since=${encodeURIComponent(lastEventTimeRef.current)}`;
    }

    const socket = new WebSocket(wsUrl);
    wsRef.current = socket;

    socket.onopen = () => {
      if (unmountedRef.current) { socket.close(); return; }
      setIsConnected(true);
      setRetryCount(0);
      retryCountRef.current = 0;
    };

    socket.onmessage = (ev) => handleMessage(ev.data as string);

    socket.onclose = (ev) => {
      if (unmountedRef.current) return;

      clearTimeout(watchdogTimer.current);
      setIsConnected(false);
      setListenerAlive(false);

      if (NO_RECONNECT_CODES.has(ev.code)) {
        console.warn(`[ws] Clean close (${ev.code}) — not reconnecting`);
        return;
      }

      const attempt = retryCountRef.current;

      if (attempt >= MAX_RETRIES) {
        setGaveUp(true);
        console.error("[ws] Max retries reached — giving up");
        return;
      }

      const delay = backoffDelay(attempt);
      retryCountRef.current += 1;
      setRetryCount(retryCountRef.current);

      console.info(
        `[ws] Reconnecting in ${(delay / 1000).toFixed(1)}s ` +
        `(attempt ${retryCountRef.current}/${MAX_RETRIES})`
      );

      reconnectTimer.current = setTimeout(connect, delay);
    };

    socket.onerror = (err) => {
      console.error("[ws] Socket error", err);
    };
  }, [gaveUp, handleMessage]);

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  useEffect(() => {
    unmountedRef.current = false;
    connect();

    return () => {
      unmountedRef.current = true;
      clearTimeout(reconnectTimer.current);
      clearTimeout(watchdogTimer.current);
      wsRef.current?.close(1000, "unmount");
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    events,
    isConnected,
    listenerAlive,
    kafkaConnected,
    latestNotification,
    subscribedTopics,
    retryCount,
    gaveUp,
    latestCircular,
  };
}
