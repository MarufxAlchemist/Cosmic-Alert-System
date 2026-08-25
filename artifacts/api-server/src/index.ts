import crypto from "node:crypto";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import app from "./app";
import { logger } from "./lib/logger";
import { setWebSocketServer } from "./lib/eventBroadcaster";
// startIngestion is now a no-op — imported only so existing code that calls it
// doesn't break; real events come from startKafkaConsumer() below.
import { startIngestion } from "./lib/eventIngestion";
import { startKafkaConsumer } from "./lib/kafkaConsumer";
import { runBootstrap } from "./lib/bootstrap";
import { startDispatcher } from "./notifications/notificationDispatcher";
import { startExtractionWorker } from "./circulars/extractionWorker";
import { reportEmailConfig } from "./notifications/emailService";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = createServer(app);

const wss = new WebSocketServer({ server, path: "/api/ws" });
setWebSocketServer(wss);

wss.on("connection", (ws, req) => {
  logger.info({ ip: req.socket.remoteAddress }, "WebSocket client connected");

  // Send connection ack
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: "connection_ack",
      schema_version: "1",
      sent_at: new Date().toISOString(),
      session_id: crypto.randomUUID(),
      server_time: new Date().toISOString(),
      subscribed_topics: [
        "igwn.gwalert",
        "gcn.notices.chime.frb",
        "gcn.notices.icecube.lvk_nu_track_search",
        "gcn.notices.icecube.gold_bronze_track_alerts",
        "gcn.notices.swift.bat.guano",
        "gcn.notices.einstein_probe.wxt.alert",
        // Human-authored scientific communications, handled on their own path.
        "gcn.circulars",
      ],
      buffer_size: 100,
      heartbeat_interval: 30000,
      deprecated: false,
    }));
  }

  // Heartbeat every 30 s so the client can detect a dead connection
  const interval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "heartbeat",
        schema_version: "1",
        sent_at: new Date().toISOString(),
        listener_alive: true,
        kafka_connected: true,
        last_alert_at: null,
        last_sequence: null,
        active_connections: wss.clients.size,
      }));
    }
  }, 30000);

  ws.on("close", () => {
    logger.info("WebSocket client disconnected");
    clearInterval(interval);
  });

  ws.on("error", (err) => {
    logger.error({ err }, "WebSocket error");
  });
});

server.listen(port, () => {
  logger.info({ port }, "Server listening (HTTP + WebSocket)");

  // ── CAN THIS DEPLOYMENT SEND MAIL? ───────────────────────────────────────
  // Answered once, out loud, at boot. Every provider otherwise only finds out
  // at send time, so the first symptom of a broken mail setup was an
  // invitation that never arrived and nobody noticed.
  reportEmailConfig();

  // ── SIMULATOR (no-op) ────────────────────────────────────────────────────
  // startIngestion() is kept here for import compatibility but does nothing.
  startIngestion();

  // ── NOTIFICATION DELIVERY LOOP ───────────────────────────────────────────
  // Sends queued provider-channel deliveries and picks up scheduled retries.
  //
  // Started before the Kafka consumer on purpose: deliveries are rows in
  // alerts.alerts, so anything left mid-backoff by a restart or a crash is
  // resumed here rather than lost. An alert that vanishes because a container
  // was redeployed is exactly the alert someone needed.
  startDispatcher();

  // ── GCN CIRCULAR AI ENRICHMENT LOOP ──────────────────────────────────────
  // Drains core.circular_extractions. Started independently of the Kafka
  // bridge on purpose: extractions queued before a restart, and any left
  // mid-backoff, are resumed here whether or not the bridge ever connects.
  //
  // This loop can never lose a circular. It reads circulars and writes
  // extraction rows; a total provider outage leaves the circulars stored,
  // associated and fully readable with their enrichment marked failed.
  startExtractionWorker();

  // ── BOOTSTRAP SEED ───────────────────────────────────────────────────────
  // Inserts up to 10 historical events from recent_events.json only when
  // core.events is completely empty. No-op on every subsequent startup.
  runBootstrap()
    .then(() => {
      // ── REAL KAFKA CONSUMER ────────────────────────────────────────────
      // Connects to GCN Kafka, subscribes to the real observatory topics,
      // and broadcasts every accepted alert to all connected WebSocket clients.
      startKafkaConsumer().catch((err) => {
        logger.error({ err }, "[kafka] startKafkaConsumer() failed — no live alerts will be received");
      });
    })
    .catch((err) => {
      logger.error({ err }, "[bootstrap] runBootstrap() threw — starting Kafka consumer anyway");
      startKafkaConsumer().catch((err2) => {
        logger.error({ err: err2 }, "[kafka] startKafkaConsumer() failed — no live alerts will be received");
      });
    });
});
