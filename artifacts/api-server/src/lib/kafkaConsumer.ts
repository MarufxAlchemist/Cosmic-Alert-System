/**
 * kafkaConsumer.ts
 * ----------------
 * Bridges the Node.js api-server to the real GCN Kafka consumer running in
 * the Python FastAPI backend (backend/app/).
 *
 * Architecture
 * ------------
 * The Python FastAPI backend (backend/) connects directly to the GCN Kafka
 * broker via the gcn-kafka library and exposes a WebSocket endpoint at
 * ws://<PYTHON_BACKEND_URL>/api/ws that broadcasts every normalized alert.
 *
 * This module:
 *   1. Connects to the Python backend WebSocket as a client.
 *   2. Receives "alert" messages (schema_version 1 envelopes).
 *   3. Applies the alert filter (applyAlertFilter) to reject retractions,
 *      MDC/mock events, and sub-threshold alerts.
 *   4. Persists accepted events to the PostgreSQL database via Drizzle ORM.
 *   5. Broadcasts the event to all connected frontend WebSocket clients via
 *      broadcastEvent().
 *   6. Reconnects automatically with exponential back-off on disconnect.
 *
 * Configuration
 * -------------
 * Set the environment variable PYTHON_BACKEND_URL to the WebSocket URL of
 * the Python FastAPI backend, e.g.:
 *
 *   PYTHON_BACKEND_URL=ws://localhost:8001/api/ws
 *
 * If unset it defaults to ws://localhost:8001/api/ws.
 *
 * Real Kafka topics (received via the Python backend)
 * ---------------------------------------------------
 *   • igwn.gwalert                                  (GW  — LVK superevents)
 *   • gcn.notices.chime.frb                         (FRB — CHIME)
 *   • gcn.notices.icecube.lvk_nu_track_search        (NU  — IceCube)
 *   • gcn.notices.icecube.gold_bronze_track_alerts   (NU  — IceCube GOLD/BRONZE)
 *   • gcn.notices.swift.bat.guano                    (GRB — Swift-BAT)
 *   • gcn.notices.einstein_probe.wxt.alert           (GRB — Einstein Probe)
 */

import { WebSocket } from "ws";
import { sql, eq } from "drizzle-orm";
import { db, eventsTable } from "@workspace/db";
import { eventLocalizations } from "@workspace/db";

import { broadcastEvent, broadcastEventUpdate } from "./eventBroadcaster";
import { applyAlertFilter } from "./alertFilter";
import type { Lifecycle } from "./alertFilter";
import { recordReceived, recordAccepted, recordRejected } from "./filterReport";
import { logger } from "./logger";
import { dispatchForEvent } from "../notifications/notificationService";
import { recordRevision } from "./revisionRecorder";
import { handleCircularFrame } from "../circulars/bridge";
import { reassociateOrphans } from "../circulars/ingestion";
import { seedAliasesForEvent } from "../circulars/association";
import { renderingsForEventId } from "../circulars/identity";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PYTHON_BACKEND_URL =
  process.env["PYTHON_BACKEND_URL"] ?? "ws://localhost:8001/api/ws";

// Real observatory topics accepted through the Python → Kafka bridge.
// Messages arriving on topics NOT in this set are silently ignored so that
// any future Python-side additions don't accidentally pollute the DB.
// This is a SECOND allow-list, independent of the Python topic subscription in
// backend/app/gcn/topics.py. Both must be updated together: a topic added only
// on the Python side is consumed, normalized, broadcast — and then silently
// dropped here, which looks exactly like the alert never arriving at all.
const ALLOWED_TOPICS = new Set([
  "igwn.gwalert",
  "gcn.notices.chime.frb",
  "gcn.notices.icecube.lvk_nu_track_search",
  "gcn.notices.icecube.gold_bronze_track_alerts",
  "gcn.notices.swift.bat.guano",
  "gcn.notices.einstein_probe.wxt.alert",
  // Fermi GBM — the instrument that reports most GRBs. Four stages of the
  // same trigger; they share a TrigID so later notices revise the event.
  "gcn.classic.voevent.FERMI_GBM_ALERT",
  "gcn.classic.voevent.FERMI_GBM_FLT_POS",
  "gcn.classic.voevent.FERMI_GBM_GND_POS",
  "gcn.classic.voevent.FERMI_GBM_FIN_POS",
  // SVOM
  "gcn.notices.svom.voevent.grm",
  "gcn.notices.svom.voevent.eclairs",
]);

// Reconnect back-off: 2 s → 4 s → 8 s → … → 60 s cap
const INITIAL_RECONNECT_DELAY_MS = 2_000;
const MAX_RECONNECT_DELAY_MS     = 60_000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let _connected   = false;
let _reconnectMs = INITIAL_RECONNECT_DELAY_MS;
let _ws: WebSocket | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _now(): string {
  return new Date().toISOString();
}

/**
 * Map a string event type from the Python normalizer to a DB-compatible type.
 * Falls back to "GRB" for unknown values so the DB constraint never fires.
 */
function _safeEventType(raw: string): "GRB" | "GW" | "FRB" | "NU" {
  if (raw === "GW"  || raw === "FRB" || raw === "NU") return raw;
  return "GRB";
}

function _safeFloat(v: unknown, fallback = 0): number {
  const n = Number(v);
  return isFinite(n) ? n : fallback;
}

/**
 * OBSERVED measurement from the normalizer: null/absent stays null (UNKNOWN).
 *
 * Must not fall back to 0. The Python normalizer deliberately emits null for
 * measurements the notice did not report; coercing that to 0 here would
 * re-fabricate exactly what it was fixed to stop inventing — and, since
 * migration 0012 added CHECK constraints, a fabricated 0 for snr/far/
 * error_radius now fails the insert outright and drops the event.
 */
function _measured(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Pull the 0-100 overall score out of the quality block, if present. */
function _qualityScore(q: unknown): number | null {
  if (!q || typeof q !== "object") return null;
  const v = (q as Record<string, unknown>)["overall"];
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n) : null;
}

/** Pull the 0-100 research interest out of its block, if present. */
function _interestScore(i: unknown): number | null {
  if (!i || typeof i !== "object") return null;
  const v = (i as Record<string, unknown>)["score"];
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n) : null;
}

/** Pull PASS | WARNING | FAIL out of the validation block, if present. */
function _validationStatus(v: unknown): string | null {
  if (!v || typeof v !== "object") return null;
  const s = (v as Record<string, unknown>)["status"];
  return typeof s === "string" && ["PASS", "WARNING", "FAIL", "UNKNOWN"].includes(s) ? s : null;
}

/**
 * Localization containment convention (spec section 23).
 *
 * Only the six recognised conventions are stored; anything else becomes null
 * rather than being passed through, because migration 0014's CHECK constraint
 * would reject the row and drop the event. Null means "the source did not
 * state it" and is never defaulted to a convention — 1-sigma and 90%
 * containment differ by 2.15x for a 2-D Gaussian.
 */
const CONTAINMENT_CONVENTIONS = [
  "1SIGMA_1D", "1SIGMA_2D", "50_2D", "68_2D", "90_2D", "95_2D",
] as const;

function _containment(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toUpperCase();
  return (CONTAINMENT_CONVENTIONS as readonly string[]).includes(s) ? s : null;
}

/** Square degrees in the whole sky — 4*pi sr. */
const FULL_SKY_DEG2 = 41253;

/**
 * A credible sky area, or null when the reported value is not a possible area.
 *
 * This guard exists because of the Phase 2 lesson: migration 0014 rejects an
 * area above the whole sky, so passing a malformed value straight through
 * would fail the INSERT and silently DROP the alert. The impossible value is
 * discarded here while the validator's `credible_area_exceeds_sky` diagnostic
 * keeps the record of what the source actually said — the event survives with
 * an honest UNKNOWN instead of vanishing.
 */
function _skyArea(v: unknown): number | null {
  const n = _positiveMeasured(v);
  return n === null || n > FULL_SKY_DEG2 ? null : n;
}

/** _measured(), rejecting non-positive values where zero is unphysical. */
function _positiveMeasured(v: unknown): number | null {
  const n = _measured(v);
  return n === null || n <= 0 ? null : n;
}

function _safeStr(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

// ---------------------------------------------------------------------------
// Persist an alert envelope to the DB and broadcast to frontend clients
// ---------------------------------------------------------------------------

async function _handleAlert(envelope: Record<string, unknown>): Promise<void> {
  const event = envelope["event"] as Record<string, unknown> | undefined;
  if (!event) {
    logger.warn("[kafka-bridge] Alert envelope missing 'event' field — skipped");
    return;
  }

  const topic     = _safeStr(event["topic"]);
  const eventType = _safeEventType(_safeStr(event["eventType"], "GRB"));

  // ── Topic allow-list check ───────────────────────────────────────────────
  const topicMatched =
    ALLOWED_TOPICS.has(topic) ||
    [...ALLOWED_TOPICS].some((t) => topic.startsWith(t));

  if (!topicMatched) {
    recordRejected(topic || "unknown", "topic_blocked", `Topic not in allow-list: ${topic}`);
    logger.warn({ topic }, "[kafka-bridge] Topic not in allow-list — skipped");
    return;
  }

  // ── Record received BEFORE filter ────────────────────────────────────────
  recordReceived(topic);

  // ── Scientific quality filter ────────────────────────────────────────────
  const rawPayload = (event["raw"] as Record<string, unknown>) ?? {};
  const verdict = applyAlertFilter(topic, rawPayload);

  if (verdict.action === "reject") {
    recordRejected(topic, verdict.category, verdict.reason, _safeStr(event["eventId"]));
    logger.warn(
      { topic, reason: verdict.reason, category: verdict.category, eventId: event["eventId"] },
      "[kafka-bridge] [filter] Event rejected — not persisted",
    );
    return;
  }

  recordAccepted(topic);

  const { lifecycle, alertType, classificationTier, observatory } = verdict;

  // ── Persist to DB ─────────────────────────────────────────────────────────
  try {
    const { labs } = await import("@workspace/db");

    // Ensure a default lab exists (idempotent)
    let [defaultLab] = await db.select().from(labs).limit(1);
    if (!defaultLab) {
      [defaultLab] = await db
        .insert(labs)
        .values({ slug: "default", name: "Default Lab" })
        .returning();
    }

    const detectionTimeRaw = _safeStr(event["detectionTime"]);
    const detectionTime    = detectionTimeRaw
      ? new Date(detectionTimeRaw)
      : new Date();

    // Latency: microseconds since detectionTime
    const latencyUs = BigInt(
      Math.max(0, Math.round((Date.now() - detectionTime.getTime()) * 1000)),
    );

    const record = {
      labId:              defaultLab.id,
      eventId:            _safeStr(event["eventId"]) || `KAFKA-${Date.now()}`,
      eventType,
      detectionTime,
      // OBSERVED measurements — null (UNKNOWN) passes straight through.
      // Zero is unphysical for snr/far/errorRadius and is rejected by the
      // CHECK constraints added in migration 0012.
      ra:                 _measured(event["ra"]),
      dec:                _measured(event["dec"]),
      errorRadius:        _positiveMeasured(event["errorRadius"]),
      // What that radius contains (spec section 23). Null means the source did
      // not state it — which is NOT the same as 1-sigma, so it is never
      // defaulted. A 90% containment radius is 2.15x the 1-sigma radius for a
      // 2-D Gaussian; defaulting here would silently resize every error circle.
      errorRadiusContainment: _containment(event["errorRadiusContainment"]),
      // Credible AREAS in deg^2, kept separate from the radius. Conflating the
      // two is the bug migration 0014 documents. An inverted pair is dropped
      // rather than stored: a 50% region larger than the 90% region is
      // impossible, the CHECK constraint rejects it, and an unguarded write
      // would take the whole alert down with it.
      ...(() => {
        const a50 = _skyArea(event["area50Deg2"]);
        const a90 = _skyArea(event["area90Deg2"]);
        const inverted = a50 !== null && a90 !== null && a50 > a90;
        return inverted
          ? { area50Deg2: null, area90Deg2: null }
          : { area50Deg2: a50, area90Deg2: a90 };
      })(),
      snr:                _positiveMeasured(event["snr"]),
      far:                _positiveMeasured(event["far"]),
      /** IceCube P(astrophysical) in [0,1] — NOT an SNR. */
      signalness:         _measured(event["signalness"]),
      // Scientific validation computed by the Python normalizer on the
      // synchronous path. Stored whole, plus two denormalised columns so the
      // dashboard can filter/sort without unpacking JSONB.
      validation:         (event["validation"] as Record<string, unknown>) ?? null,
      quality:            (event["quality"]    as Record<string, unknown>) ?? null,
      qualityScore:       _qualityScore(event["quality"]),
      validationStatus:   _validationStatus(event["validation"]),
      // Derived quantities with their methods, assumptions and propagated
      // uncertainties (spec sections 19-24, 33-34). Computed by the Python
      // normalizer; stored whole so the cosmology stamp travels with the
      // numbers it produced.
      derived:            (event["derived"] as Record<string, unknown>) ?? null,
      // Research interest (spec section 44) — a triage heuristic, kept
      // strictly separate from qualityScore (is the data trustworthy?) and
      // from notification priority (is it urgent?).
      researchInterest:   (event["researchInterest"] as Record<string, unknown>) ?? null,
      interestScore:      _interestScore(event["researchInterest"]),
      fluence:            event["fluence"]  != null ? _safeFloat(event["fluence"])  : null,
      dm:                 event["dm"]       != null ? _safeFloat(event["dm"])       : null,
      t90:                event["t90"]      != null ? _safeFloat(event["t90"])      : null,
      peakFlux:           event["peakFlux"] != null ? _safeFloat(event["peakFlux"]) : null,
      chirpMass:          event["chirpMass"] != null ? _safeFloat(event["chirpMass"]) : null,
      luminosityDistance: event["luminosityDistance"] != null ? _safeFloat(event["luminosityDistance"]) : null,
      // DERIVED sky geometry — computed upstream by the Python normalizer.
      // Pass null (UNKNOWN) straight through; never substitute a placeholder.
      // These previously defaulted to 90, re-fabricating the exact value the
      // normalizer was fixed to stop inventing.
      galLat:             event["galLat"]       != null ? _safeFloat(event["galLat"])       : null,
      galLon:             event["galLon"]       != null ? _safeFloat(event["galLon"])       : null,
      sunDistance:        event["sunDistance"]  != null ? _safeFloat(event["sunDistance"])  : null,
      moonDistance:       event["moonDistance"] != null ? _safeFloat(event["moonDistance"]) : null,
      latencyUs,
      // Alert filtering metadata
      lifecycle:          lifecycle as Lifecycle,
      alertType:          alertType  ?? null,
      classificationTier: classificationTier ?? null,
      observatory:        observatory || _safeStr(event["observatory"], "Unknown"),
      isRetraction:       false,
      revisionCount:      0,
      latestRevision:     alertType ?? null,
    };

    // ── Capture the prior state BEFORE it is overwritten ───────────────────
    // The UPSERT below replaces the row in place, so this is the only moment
    // at which the previous scientific state still exists. Without it a
    // revision that moves a localization 40 degrees leaves no trace (Phase 6,
    // spec sections 27-28).
    //
    // Read failure must not block ingestion: the revision is then recorded
    // with an unknown delta rather than a fabricated empty one.
    let previousRow: Record<string, unknown> | null = null;
    try {
      const [prior] = await db
        .select()
        .from(eventsTable)
        .where(eq(eventsTable.eventId, record.eventId))
        .limit(1);
      previousRow = (prior as Record<string, unknown>) ?? null;
    } catch (err) {
      logger.error(
        { err, eventId: record.eventId },
        "[revisions] could not read prior state; delta will be unknown",
      );
    }

    // ── Upsert: one row per astrophysical event_id ─────────────────────────
    // First notice  → INSERT with revisionCount=0.
    // Later notices → UPDATE in place; revisionCount increments by 1.
    const [upserted] = await db
      .insert(eventsTable)
      .values(record)
      .onConflictDoUpdate({
        target: eventsTable.eventId,
        set: {
          // Refresh all mutable fields with the newer notice's values
          lifecycle:          sql`EXCLUDED.lifecycle`,
          alertType:          sql`EXCLUDED.alert_type`,
          latestRevision:     sql`EXCLUDED.alert_type`,
          status:             sql`EXCLUDED.lifecycle`,
          ra:                 sql`EXCLUDED.ra`,
          dec:                sql`EXCLUDED.dec`,
          errorRadius:        sql`EXCLUDED.error_radius`,
          errorRadiusContainment: sql`EXCLUDED.error_radius_containment`,
          area50Deg2:         sql`EXCLUDED.area_50_deg2`,
          area90Deg2:         sql`EXCLUDED.area_90_deg2`,
          snr:                sql`EXCLUDED.snr`,
          far:                sql`EXCLUDED.far`,
          fluence:            sql`EXCLUDED.fluence`,
          dm:                 sql`EXCLUDED.dm`,
          signalness:         sql`EXCLUDED.signalness`,
          validation:         sql`EXCLUDED.validation`,
          quality:            sql`EXCLUDED.quality`,
          qualityScore:       sql`EXCLUDED.quality_score`,
          validationStatus:   sql`EXCLUDED.validation_status`,
          // A revision changes the inputs, so every derived quantity must be
          // recomputed with it — a stale rest-frame value attached to a
          // revised redshift would be worse than none.
          derived:            sql`EXCLUDED.derived`,
          researchInterest:   sql`EXCLUDED.research_interest`,
          interestScore:      sql`EXCLUDED.interest_score`,
          galLat:             sql`EXCLUDED.gal_lat`,
          galLon:             sql`EXCLUDED.gal_lon`,
          // Derived geometry must track revised positions, and must be
          // cleared when a revision removes the position.
          sunDistance:        sql`EXCLUDED.sun_distance`,
          moonDistance:       sql`EXCLUDED.moon_distance`,
          observatory:        sql`EXCLUDED.observatory`,
          classificationTier: sql`EXCLUDED.classification_tier`,
          latencyUs:          sql`EXCLUDED.latency_us`,
          // Monotonically increment the revision counter
          revisionCount:      sql`"core"."events"."revision_count" + 1`,
          updatedAt:          sql`now()`,
        },
      })
      .returning();

    const isRevision = Number(upserted.revisionCount) > 0;

    // ── Append to the revision history ─────────────────────────────────────
    // Every notice is recorded, including the first: a history that begins at
    // the second notice cannot show what the first one said. The delta is
    // computed by the Python science layer (single implementation of the
    // rules) and is null on the first notice, which has no predecessor.
    const revisionDelta = await recordRevision({
      eventPk:       upserted.id,
      eventId:       upserted.eventId,
      revisionIndex: Number(upserted.revisionCount),
      alertType:     alertType ?? null,
      lifecycle,
      isRetraction:  upserted.isRetraction ?? false,
      previousRow,
      currentEvent:  { ...record, ...(event as Record<string, unknown>) },
    });

    logger.info(
      {
        eventId:       upserted.eventId,
        eventType:     upserted.eventType,
        topic,
        observatory:   upserted.observatory,
        lifecycle,
        alertType,
        revisionCount: Number(upserted.revisionCount),
        action:        isRevision ? "updated" : "inserted",
        // null means the delta could not be computed — NOT that nothing changed.
        revisionSignificance: revisionDelta?.significance ?? null,
        source:        "gcn-kafka-bridge",
      },
      isRevision
        ? `[kafka-bridge] Event upserted (update) — revision_count=${upserted.revisionCount}`
        : "[kafka-bridge] Event persisted from real Kafka (new)",
    );

    // ── Build broadcast payload ────────────────────────────────────────────
    const broadcastPayload: Record<string, unknown> = {
      id:                  String(upserted.id),
      eventId:             upserted.eventId,
      eventType:           upserted.eventType,
      observatory:         upserted.observatory,
      detectionTime:       upserted.detectionTime.toISOString(),
      ra:                  upserted.ra,
      dec:                 upserted.dec,
      errorRadius:         upserted.errorRadius,
      snr:                 upserted.snr,
      far:                 upserted.far,
      fluence:             upserted.fluence    ?? undefined,
      dm:                  upserted.dm         ?? undefined,
      t90:                 upserted.t90        ?? undefined,
      peakFlux:            upserted.peakFlux   ?? undefined,
      chirpMass:           upserted.chirpMass  ?? undefined,
      luminosityDistance:  upserted.luminosityDistance ?? undefined,
      galLat:              upserted.galLat,
      galLon:              upserted.galLon,
      sunDistance:         upserted.sunDistance,
      moonDistance:        upserted.moonDistance,
      latencyUs:           Number(upserted.latencyUs),
      createdAt:           upserted.createdAt.toISOString(),
      updatedAt:           upserted.updatedAt.toISOString(),
      lifecycle:           upserted.lifecycle  as Lifecycle,
      alertType:           upserted.alertType  ?? undefined,
      latestRevision:      upserted.latestRevision ?? undefined,
      revisionCount:       Number(upserted.revisionCount),
      classificationTier:  upserted.classificationTier ?? undefined,
      isHistorical:        upserted.isHistorical  ?? false,
      source:              upserted.source        ?? "kafka",
    };

    // New event → alert; updated event → event_updated (frontend replaces card)
    if (isRevision) {
      broadcastEventUpdate(broadcastPayload);
    } else {
      broadcastEvent(broadcastPayload);
    }

    // ── Notification pipeline (fire-and-forget, isolated from ingestion) ────
    // Delegates entirely to the notifications/ module. kafkaConsumer has zero
    // notification logic. Errors in the notification layer never affect ingestion.
    void dispatchForEvent(broadcastPayload, isRevision).catch((err) =>
      logger.error({ err }, "[notifications] dispatchForEvent threw unexpectedly"),
    );

    // ── Attach circulars that were waiting for this event ──────────────────
    // Circulars routinely arrive for events this archive does not yet hold —
    // a backfill loaded out of order, or a notice topic that was not
    // subscribed at the time. Registering the event's identifier spellings and
    // sweeping the orphans turns those into attached scientific history the
    // moment the event exists.
    //
    // Fire-and-forget and non-throwing on both calls: notice ingestion has
    // already succeeded and must not be affected by either.
    void (async () => {
      await seedAliasesForEvent(
        upserted.id,
        upserted.eventId,
        renderingsForEventId(upserted.eventId),
      );
      await reassociateOrphans(
        upserted.id,
        upserted.eventId,
        upserted.labId,
        renderingsForEventId(upserted.eventId),
      );
    })().catch((err) =>
      logger.error({ err, eventId: upserted.eventId }, "[circulars] post-ingest sweep threw"),
    );

    // ── Persist localization metadata (GW events only) ─────────────────────
    // Only runs when the Python normalizer emitted a fitsUrl.
    // Failure here is non-fatal: event ingestion is already complete.
    const fitsUrl = typeof event["fitsUrl"] === "string" && event["fitsUrl"].trim()
      ? (event["fitsUrl"] as string).trim()
      : null;

    if (fitsUrl) {
      try {
        // Step 1: mark all prior localizations for this event as not-latest
        await db
          .update(eventLocalizations)
          .set({ isLatest: false })
          .where(sql`${eventLocalizations.eventId} = ${upserted.id}`);

        // Step 2: derive revision number from event revision count
        const locVersion = Number(upserted.revisionCount) + 1;

        // Step 3: insert the new localization row
        await db.insert(eventLocalizations).values({
          eventId: upserted.id,
          labId:   defaultLab.id,
          method:  "bayestar",   // LVK standard rapid localisation pipeline
          version: locVersion,
          fitsUrl,
          isLatest: true,
        });

        logger.info(
          {
            eventId:    upserted.eventId,
            fitsUrl,
            version:    locVersion,
            source:     "gcn-kafka-bridge",
          },
          "[kafka-bridge] Localization row inserted into core.event_localizations",
        );
      } catch (locErr) {
        // Log but do NOT rethrow — event ingestion has already succeeded.
        logger.error(
          { locErr, eventId: upserted.eventId, fitsUrl },
          "[kafka-bridge] Failed to persist localization metadata — event row unaffected",
        );
      }
    }

  } catch (err) {
    logger.error({ err, eventId: event["eventId"] }, "[kafka-bridge] DB insert failed");
  }
}

// ---------------------------------------------------------------------------
// WebSocket client — connects to the Python FastAPI backend
// ---------------------------------------------------------------------------

function _connect(): void {
  logger.info(
    { url: PYTHON_BACKEND_URL },
    "[kafka-bridge] Connecting to Python GCN Kafka backend…",
  );

  const ws = new WebSocket(PYTHON_BACKEND_URL);
  _ws = ws;

  ws.on("open", () => {
    _connected   = true;
    _reconnectMs = INITIAL_RECONNECT_DELAY_MS; // reset back-off on success
    logger.info(
      { url: PYTHON_BACKEND_URL },
      "=".repeat(60) + "\n" +
      "[kafka-bridge] ✓ Connected to Python GCN Kafka backend\n" +
      "[kafka-bridge] ✓ Kafka consumer active\n" +
      "[kafka-bridge] ✓ Topics subscribed: " + [...ALLOWED_TOPICS].join(", ") + "\n" +
      "=".repeat(60),
    );
  });

  ws.on("message", (data) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      logger.warn("[kafka-bridge] Non-JSON message received — ignored");
      return;
    }

    const msgType = msg["type"];

    if (msgType === "connection_ack") {
      const topics = msg["subscribed_topics"];
      logger.info(
        { subscribed_topics: topics },
        "[kafka-bridge] Python backend connection_ack received — Kafka consumer running",
      );
      return;
    }

    if (msgType === "heartbeat") {
      logger.debug(
        {
          kafka_connected:    msg["kafka_connected"],
          last_alert_at:      msg["last_alert_at"],
          last_sequence:      msg["last_sequence"],
          active_connections: msg["active_connections"],
        },
        "[kafka-bridge] Heartbeat from Python backend",
      );
      return;
    }

    // ── GCN Circulars ─────────────────────────────────────────────────────
    // A completely separate path: no topic allow-list, no applyAlertFilter,
    // no core.events upsert. A human-authored scientific report is not a
    // machine detection and must not be filtered as one. Fire-and-forget and
    // non-throwing, so a circular can never disturb notice ingestion.
    if (msgType === "circular") {
      void handleCircularFrame(msg).catch((err) =>
        logger.error({ err }, "[circular-bridge] handleCircularFrame threw unexpectedly"),
      );
      return;
    }

    if (msgType === "alert") {
      const seq      = msg["sequence"];
      const sentAt   = msg["sent_at"];
      const notif    = msg["notification"] as Record<string, unknown> | undefined;

      logger.info(
        {
          sequence:    seq,
          sent_at:     sentAt,
          event_id:    notif?.["event_id"],
          event_type:  notif?.["event_type"],
          observatory: notif?.["observatory"],
          priority:    notif?.["priority"],
          source: "gcn-kafka-bridge",
        },
        "[kafka-bridge] ✓ Real Kafka alert received → persisting + broadcasting",
      );

      void _handleAlert(msg).catch((err) =>
        logger.error({ err }, "[kafka-bridge] _handleAlert threw unexpectedly"),
      );
      return;
    }

    if (msgType === "error") {
      logger.warn(
        { code: msg["code"], detail: msg["detail"] },
        "[kafka-bridge] Error message from Python backend",
      );
      return;
    }

    // history_start / history_event / history_end — not relevant here
    logger.debug({ type: msgType }, "[kafka-bridge] Unhandled message type — ignored");
  });

  ws.on("close", (code, reason) => {
    _connected = false;
    _ws        = null;
    logger.warn(
      { code, reason: reason.toString(), nextRetryMs: _reconnectMs },
      "[kafka-bridge] Disconnected from Python backend — will retry",
    );
    _scheduleReconnect();
  });

  ws.on("error", (err) => {
    logger.error(
      { err: (err as Error).message, url: PYTHON_BACKEND_URL },
      "[kafka-bridge] WebSocket error — Python backend may not be running",
    );
    // 'error' is always followed by 'close', so _scheduleReconnect is called there
  });
}

function _scheduleReconnect(): void {
  const delay = _reconnectMs;
  // Exponential back-off capped at MAX_RECONNECT_DELAY_MS
  _reconnectMs = Math.min(_reconnectMs * 2, MAX_RECONNECT_DELAY_MS);

  logger.info(
    { delayMs: delay },
    `[kafka-bridge] Reconnecting in ${delay / 1000}s…`,
  );
  setTimeout(() => _connect(), delay);
}

// ---------------------------------------------------------------------------
// Public entry point — called from index.ts after server.listen()
// ---------------------------------------------------------------------------

/**
 * Start the GCN Kafka consumer bridge.
 *
 * Connects to the Python FastAPI backend WebSocket, which is the real
 * GCN Kafka consumer.  Returns immediately; connection is managed
 * asynchronously with automatic reconnection.
 *
 * Evidence logged on startup:
 *   [kafka-bridge] Connecting to Python GCN Kafka backend…
 *   [kafka-bridge] ✓ Connected to Python GCN Kafka backend
 *   [kafka-bridge] ✓ Kafka consumer active
 *   [kafka-bridge] ✓ Topics subscribed: igwn.gwalert, gcn.notices.chime.frb …
 *   [kafka-bridge] Python backend connection_ack received — Kafka consumer running
 *   [kafka-bridge] ✓ Real Kafka alert received → persisting + broadcasting
 *   Broadcasted event to WS clients   ← from eventBroadcaster.ts
 */
export async function startKafkaConsumer(): Promise<void> {
  logger.info(
    {
      pythonBackendUrl: PYTHON_BACKEND_URL,
      allowedTopics:    [...ALLOWED_TOPICS],
    },
    "[kafka-bridge] Starting GCN Kafka consumer bridge",
  );

  _connect();

  // Return immediately — connection is async
}

/**
 * Gracefully close the bridge (e.g. on SIGTERM).
 */
export function stopKafkaConsumer(): void {
  if (_ws) {
    logger.info("[kafka-bridge] Closing WebSocket bridge connection");
    _ws.close(1000, "Server shutdown");
    _ws = null;
  }
}

/**
 * Returns true if the bridge is currently connected to the Python backend.
 * Useful for the /health endpoint.
 */
export function isKafkaBridgeConnected(): boolean {
  return _connected;
}
