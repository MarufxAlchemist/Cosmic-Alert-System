/**
 * repository.ts — Multi-Messenger Correlation Engine (Phase 6.0A)
 * ---------------------------------------------------------------
 * Database persistence layer for correlation results.
 *
 * Responsibilities
 * ────────────────
 *   saveCorrelation()          — upsert one CorrelationResult to core.event_correlations
 *   getCorrelationsForEvent()  — fetch all persisted correlations for a primary event
 *   getRecentHighConfidence()  — fetch recent HIGH/MEDIUM results (dashboard feed)
 *
 * Design principles
 * ─────────────────
 *   • Non-throwing — all errors are logged and swallowed.
 *     Correlation persistence must never interrupt the notification pipeline.
 *   • Only persists matches that have a valid bestMatch (confidence ≠ NONE).
 *     NONE results are ephemeral and not worth storing.
 *   • Uses indexed queries — no full table scans.
 *
 * Phase 6.0A — Transient Event Detection
 */

import { db, eventCorrelations, eventsTable } from "@workspace/db";
import { eq, desc, inArray, and } from "drizzle-orm";
import pino from "pino";
import type { CorrelationResult, CorrelationConfidence } from "./types.js";

const logger = pino({ name: "correlation-repository" });

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Persist the best match from a CorrelationResult to core.event_correlations.
 *
 * Only saves when confidence is HIGH, MEDIUM, or LOW (skips NONE).
 * Uses ON CONFLICT DO UPDATE so repeated calls for the same pair are safe.
 *
 * @param primaryEventGcnId  - GCN string event ID (e.g. "S230518h")
 * @param result             - Output of correlate()
 */
export async function saveCorrelation(
  primaryEventGcnId: string,
  result: CorrelationResult,
): Promise<void> {
  if (result.confidence === "NONE" || !result.bestMatch) return;

  try {
    // Resolve internal DB ids from GCN string event IDs
    const [primaryRow] = await db
      .select({ id: eventsTable.id })
      .from(eventsTable)
      .where(eq(eventsTable.eventId, primaryEventGcnId))
      .limit(1);

    if (!primaryRow) {
      logger.warn({ primaryEventGcnId }, "[correlation-repo] Primary event not found in DB — skipping persist");
      return;
    }

    const candidateGcnId = result.bestMatch.candidate.eventId;
    const [candidateRow] = await db
      .select({ id: eventsTable.id })
      .from(eventsTable)
      .where(eq(eventsTable.eventId, candidateGcnId))
      .limit(1);

    if (!candidateRow) {
      logger.warn({ candidateGcnId }, "[correlation-repo] Candidate event not found in DB — skipping persist");
      return;
    }

    await db
      .insert(eventCorrelations)
      .values({
        primaryEventId:   primaryRow.id,
        candidateEventId: candidateRow.id,
        confidence:       result.confidence,
        score:            result.bestMatch.score,
        deltaTimeSec:     result.bestMatch.deltaTimeSec,
        angularSepDeg:    result.bestMatch.angularSeparationDeg,
        correlationType:  result.bestMatch.correlationType,
        reasoning:        result.reasoning,
      })
      .onConflictDoUpdate({
        target: [eventCorrelations.primaryEventId, eventCorrelations.candidateEventId],
        set: {
          confidence:      result.confidence,
          score:           result.bestMatch.score,
          deltaTimeSec:    result.bestMatch.deltaTimeSec,
          angularSepDeg:   result.bestMatch.angularSeparationDeg,
          correlationType: result.bestMatch.correlationType,
          reasoning:       result.reasoning,
          computedAt:      new Date(),
        },
      });

    logger.info(
      {
        primaryEventGcnId,
        candidateGcnId,
        confidence: result.confidence,
        score: result.bestMatch.score,
      },
      "[correlation-repo] Correlation persisted",
    );
  } catch (err) {
    logger.warn({ err, primaryEventGcnId }, "[correlation-repo] Failed to persist correlation — audit trail incomplete");
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Fetch all persisted correlations where this event is the primary.
 * Returns empty array on error.
 *
 * @param primaryEventDbId - Internal DB bigint id of the primary event.
 */
export async function getCorrelationsForEvent(
  primaryEventDbId: bigint,
): Promise<typeof eventCorrelations.$inferSelect[]> {
  try {
    return await db
      .select()
      .from(eventCorrelations)
      .where(eq(eventCorrelations.primaryEventId, primaryEventDbId))
      .orderBy(desc(eventCorrelations.score));
  } catch (err) {
    logger.warn({ err, primaryEventDbId }, "[correlation-repo] getCorrelationsForEvent failed");
    return [];
  }
}

/**
 * Fetch recent HIGH and MEDIUM confidence correlations across all events.
 * Used by the dashboard feed and API endpoints.
 *
 * @param limit - Maximum number of results to return (default: 50).
 * @param confidenceLevels - Array of confidence levels to include.
 */
export async function getRecentHighConfidence(
  limit = 50,
  confidenceLevels: CorrelationConfidence[] = ["HIGH", "MEDIUM"],
): Promise<typeof eventCorrelations.$inferSelect[]> {
  try {
    return await db
      .select()
      .from(eventCorrelations)
      .where(inArray(eventCorrelations.confidence, confidenceLevels))
      .orderBy(desc(eventCorrelations.computedAt))
      .limit(limit);
  } catch (err) {
    logger.warn({ err }, "[correlation-repo] getRecentHighConfidence failed");
    return [];
  }
}

/**
 * Fetch a specific correlation pair by primary + candidate DB ids.
 * Returns null if not found or on error.
 */
export async function getCorrelationPair(
  primaryEventDbId:   bigint,
  candidateEventDbId: bigint,
): Promise<typeof eventCorrelations.$inferSelect | null> {
  try {
    const [row] = await db
      .select()
      .from(eventCorrelations)
      .where(
        and(
          eq(eventCorrelations.primaryEventId,   primaryEventDbId),
          eq(eventCorrelations.candidateEventId, candidateEventDbId),
        ),
      )
      .limit(1);
    return row ?? null;
  } catch (err) {
    logger.warn({ err }, "[correlation-repo] getCorrelationPair failed");
    return null;
  }
}
