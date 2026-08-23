/**
 * bridge.ts — handling a `circular` frame from the Python GCN backend
 * ---------------------------------------------------------------------------
 * The Python backend owns the single Kafka connection and forwards every
 * message over the existing WebSocket at PYTHON_BACKEND_URL. Notices arrive as
 * `{type:"alert"}` and are handled by lib/kafkaConsumer.ts; circulars arrive as
 * `{type:"circular"}` and are handled here.
 *
 * WHY THIS IS A SEPARATE FILE AND A SEPARATE PATH
 * -----------------------------------------------
 * Nothing in the notice path applies to a circular:
 *
 *   * ALLOWED_TOPICS — a per-observatory notice allow-list. `gcn.circulars`
 *     carries reports about every observatory at once.
 *   * applyAlertFilter — rejects retractions, MDC/mock notices and
 *     sub-threshold machine alerts. A circular has no threshold, and a
 *     circular announcing a retraction is itself important information that
 *     must be kept.
 *   * the core.events UPSERT — a circular is not a detection and must never
 *     create or modify an event row.
 *
 * Keeping the two paths physically apart means a future change to the notice
 * filter cannot start silently discarding human-authored science.
 */

import { logger } from "../lib/logger.js";
import { ingestCircular, CircularValidationError } from "./ingestion.js";
import { configuredModelName } from "./extractionWorker.js";

/** Whether circulars are consumed at all. Default on. */
export function circularIngestionEnabled(): boolean {
  return process.env["GCN_CIRCULARS_ENABLED"] !== "false";
}

/**
 * Process one `circular` frame.
 *
 * NEVER THROWS. Called fire-and-forget from the bridge's message handler,
 * which must keep reading the socket whatever happens to any single circular.
 *
 * Returns true when the circular was stored (whether new or already present),
 * false when it was rejected or the write failed. The return value is for
 * tests and logging; the caller does not branch on it.
 */
export async function handleCircularFrame(frame: Record<string, unknown>): Promise<boolean> {
  if (!circularIngestionEnabled()) return false;

  const payload = frame["circular"];
  if (!payload || typeof payload !== "object") {
    logger.warn("[circular-bridge] frame has no 'circular' object — skipped");
    return false;
  }

  try {
    const result = await ingestCircular(payload, {
      source: "kafka",
      modelName: configuredModelName(),
      broadcast: true,
    });

    logger.info(
      {
        circularId: result.circular.circularId,
        version: result.circular.version,
        eventPk: result.circular.eventPk != null ? String(result.circular.eventPk) : null,
        associationMethod: result.circular.associationMethod,
        isNew: result.isNew,
        isRevision: result.isRevision,
        source: "gcn-circular-bridge",
      },
      result.isNew
        ? "[circular-bridge] ✓ Circular received → stored, associated, extraction queued"
        : "[circular-bridge] Circular already stored — duplicate suppressed",
    );
    return true;
  } catch (err) {
    if (err instanceof CircularValidationError) {
      // A malformed circular is dropped rather than stored half-formed. The
      // circularId is logged when it is legible so the loss is traceable, and
      // the body is never logged.
      logger.warn(
        {
          err: err.message,
          circularId: (payload as Record<string, unknown>)["circularId"],
        },
        "[circular-bridge] Circular failed validation — not stored",
      );
      return false;
    }

    logger.error(
      {
        err,
        circularId: (payload as Record<string, unknown>)["circularId"],
      },
      "[circular-bridge] Circular ingestion failed — nothing was written; a redelivery will retry",
    );
    return false;
  }
}
