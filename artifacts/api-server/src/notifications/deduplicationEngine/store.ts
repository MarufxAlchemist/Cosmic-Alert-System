/**
 * store.ts — Notification Deduplication Engine (Phase 5.5)
 * ---------------------------------------------------------
 * Database read/write for alerts.notification_history.
 *
 * Two responsibilities:
 *   1. getLastSentSnapshot()  — Read the most-recent SENT record for an eventId.
 *   2. recordDecision()       — Append a new decision row (sent or suppressed).
 *
 * Both are non-throwing — failures are logged and surfaced as null / void.
 * The engine must never block email dispatch due to a DB error.
 *
 * Phase 5.5 — Transient Event Detection
 */

import { db, notificationHistory } from "@workspace/db";
import { eq, desc, and }           from "drizzle-orm";
import { logger }                  from "../../lib/logger.js";
import type { NotificationSnapshot } from "./types.js";

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Fetch the most-recently SENT (suppressed = false) notification snapshot
 * for a given eventId.
 *
 * Returns null when:
 *   · No history exists for this eventId (first notification)
 *   · DB query fails
 */
export async function getLastSentSnapshot(
  eventId: string,
): Promise<NotificationSnapshot | null> {
  try {
    const rows = await db
      .select({
        eventId:        notificationHistory.eventId,
        lifecycle:      notificationHistory.lifecycle,
        revisionCount:  notificationHistory.revisionCount,
        priorityLevel:  notificationHistory.priorityLevel,
        priorityScore:  notificationHistory.priorityScore,
        corrConfidence: notificationHistory.corrConfidence,
        errorRadius:    notificationHistory.errorRadius,
      })
      .from(notificationHistory)
      .where(
        and(
          eq(notificationHistory.eventId, eventId),
          eq(notificationHistory.suppressed, false),
        ),
      )
      .orderBy(desc(notificationHistory.sentAt))
      .limit(1);

    if (rows.length === 0) return null;

    return rows[0] as NotificationSnapshot;
  } catch (err) {
    logger.warn(
      { err, eventId },
      "[dedup] getLastSentSnapshot failed — treating as first notification",
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export interface DecisionRecord {
  snapshot:       NotificationSnapshot;
  suppressed:     boolean;
  triggerReasons: string[];
}

/**
 * Append a deduplication decision to notification_history.
 *
 * Non-throwing — DB failure is logged but does not propagate.
 * Called AFTER the email has been successfully enqueued (send=true)
 * or immediately on suppress (send=false).
 */
export async function recordDecision(record: DecisionRecord): Promise<void> {
  try {
    await db.insert(notificationHistory).values({
      eventId:        record.snapshot.eventId,
      lifecycle:      record.snapshot.lifecycle,
      revisionCount:  record.snapshot.revisionCount,
      priorityLevel:  record.snapshot.priorityLevel,
      priorityScore:  record.snapshot.priorityScore,
      corrConfidence: record.snapshot.corrConfidence,
      errorRadius:    record.snapshot.errorRadius,
      triggerReasons: record.triggerReasons,
      suppressed:     record.suppressed,
    });
  } catch (err) {
    logger.error(
      { err, eventId: record.snapshot.eventId, suppressed: record.suppressed },
      "[dedup] recordDecision failed — audit trail may be incomplete",
    );
  }
}
