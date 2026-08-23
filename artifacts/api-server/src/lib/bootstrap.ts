/**
 * bootstrap.ts
 *
 * Startup seeding guard for Transient Event Detection.
 *
 * Rules
 * ─────
 * 1. Run ONLY when core.events is empty (zero rows).
 * 2. Load up to 10 events from recent_events.json (co-located with this
 *    server's package root — i.e. artifacts/api-server/recent_events.json).
 * 3. Insert each with source='bootstrap' and is_historical=true.
 * 4. Idempotent: if any row already exists the function exits immediately,
 *    so it is safe to call on every startup.
 * 5. Never overwrites a bootstrap row with a Kafka upsert — the Kafka
 *    ON CONFLICT path uses DO UPDATE which will update fields but keeps
 *    source/is_historical immutable (they are excluded from the SET clause).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, eventsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BootstrapEvent {
  eventId:             string;
  eventType:           string;
  observatory?:        string;
  detectionTime:       string;
  ra?:                 number | null;
  dec?:                number | null;
  errorRadius?:        number | null;
  snr?:                number | null;
  far?:                number | null;
  fluence?:            number | null;
  dm?:                 number | null;
  t90?:                number | null;
  peakFlux?:           number | null;
  chirpMass?:          number | null;
  luminosityDistance?: number | null;
  galLat?:             number | null;
  galLon?:             number | null;
  sunDistance?:        number | null;
  moonDistance?:       number | null;
  lifecycle?:          string;
  alertType?:          string;
  classificationTier?: string | null;
  status?:             string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveDataFile(): string {
  // When running from dist/, __dirname is artifacts/api-server/dist/
  // recent_events.json sits one level up in artifacts/api-server/
  const __filename = fileURLToPath(import.meta.url);
  const __dirname  = path.dirname(__filename);
  return path.resolve(__dirname, "..", "recent_events.json");
}

function safeFloat(v: unknown, fallback = 0): number {
  const n = Number(v);
  return isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * runBootstrap()
 *
 * Called once from index.ts immediately after the HTTP server starts
 * listening, before startKafkaConsumer().
 *
 * No-op if core.events already has rows.
 */
export async function runBootstrap(): Promise<void> {
  try {
    // ── Guard: skip if table is not empty ──────────────────────────────────
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(eventsTable);

    if (Number(count) > 0) {
      logger.info(
        { existingRows: Number(count) },
        "[bootstrap] core.events not empty — skipping seed",
      );
      return;
    }

    logger.info("[bootstrap] core.events is empty — loading recent_events.json");

    // ── Load seed file ─────────────────────────────────────────────────────
    const filePath = resolveDataFile();

    if (!fs.existsSync(filePath)) {
      logger.warn(
        { path: filePath },
        "[bootstrap] recent_events.json not found — skipping seed",
      );
      return;
    }

    const raw     = fs.readFileSync(filePath, "utf-8");
    const events: BootstrapEvent[] = JSON.parse(raw);

    if (!Array.isArray(events) || events.length === 0) {
      logger.warn("[bootstrap] recent_events.json is empty or invalid — skipping seed");
      return;
    }

    // ── Resolve default lab ────────────────────────────────────────────────
    const { labs } = await import("@workspace/db");
    let [defaultLab] = await db.select().from(labs).limit(1);
    if (!defaultLab) {
      [defaultLab] = await db
        .insert(labs)
        .values({ slug: "default", name: "Default Lab" })
        .returning();
    }

    // ── Insert bootstrap rows ──────────────────────────────────────────────
    const toInsert = events.slice(0, 10); // hard cap at 10
    let inserted   = 0;
    let skipped    = 0;

    for (const ev of toInsert) {
      if (!ev.eventId || !ev.eventType || !ev.detectionTime) {
        logger.warn({ ev }, "[bootstrap] Skipping malformed record");
        skipped++;
        continue;
      }

      const detectionTime = new Date(ev.detectionTime);
      const latencyUs     = BigInt(
        Math.max(0, Math.round((Date.now() - detectionTime.getTime()) * 1000)),
      );

      try {
        await db
          .insert(eventsTable)
          .values({
            labId:              defaultLab.id,
            eventId:            ev.eventId,
            eventType:          ev.eventType,
            observatory:        ev.observatory ?? "Unknown",
            detectionTime,
            // OBSERVED measurements — null (UNKNOWN) rather than a
            // fabricated 0. Zero is rejected by the migration-0012 CHECKs.
            ra:                 ev.ra  != null ? safeFloat(ev.ra)  : null,
            dec:                ev.dec != null ? safeFloat(ev.dec) : null,
            errorRadius:        ev.errorRadius != null && safeFloat(ev.errorRadius) > 0
                                  ? safeFloat(ev.errorRadius) : null,
            snr:                ev.snr != null && safeFloat(ev.snr) > 0
                                  ? safeFloat(ev.snr) : null,
            far:                ev.far != null && safeFloat(ev.far) > 0
                                  ? safeFloat(ev.far) : null,
            fluence:            ev.fluence            ?? null,
            dm:                 ev.dm                 ?? null,
            t90:                ev.t90                ?? null,
            peakFlux:           ev.peakFlux           ?? null,
            chirpMass:          ev.chirpMass          ?? null,
            luminosityDistance: ev.luminosityDistance ?? null,
            // DERIVED sky geometry — null (UNKNOWN) rather than a fabricated
            // placeholder when the seed payload does not carry the value.
            galLat:             ev.galLat       != null ? safeFloat(ev.galLat)       : null,
            galLon:             ev.galLon       != null ? safeFloat(ev.galLon)       : null,
            sunDistance:        ev.sunDistance  != null ? safeFloat(ev.sunDistance)  : null,
            moonDistance:       ev.moonDistance != null ? safeFloat(ev.moonDistance) : null,
            latencyUs,
            lifecycle:          (ev.lifecycle  ?? "preliminary") as "preliminary" | "initial" | "update" | "confirmed",
            alertType:          ev.alertType          ?? null,
            classificationTier: ev.classificationTier ?? null,
            status:             ev.status             ?? "preliminary",
            isRetraction:       false,
            revisionCount:      0,
            latestRevision:     ev.alertType ?? null,
            // Bootstrap markers — never overwritten by Kafka upserts
            source:             "bootstrap",
            isHistorical:       true,
          })
          .onConflictDoNothing({ target: eventsTable.eventId });

        inserted++;
        logger.info(
          { eventId: ev.eventId, eventType: ev.eventType, observatory: ev.observatory },
          "[bootstrap] Inserted historical event",
        );
      } catch (rowErr) {
        logger.error({ err: rowErr, eventId: ev.eventId }, "[bootstrap] Failed to insert row");
        skipped++;
      }
    }

    logger.info(
      { inserted, skipped, total: toInsert.length },
      "[bootstrap] Seed complete",
    );

  } catch (err) {
    // Bootstrap failures must never crash the server
    logger.error({ err }, "[bootstrap] Unexpected error — server will start without seed data");
  }
}
