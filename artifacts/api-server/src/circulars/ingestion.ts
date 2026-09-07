/**
 * ingestion.ts — persisting a GCN Circular
 * ---------------------------------------------------------------------------
 * THE ORDER OF OPERATIONS IS THE FEATURE.
 *
 *   validate → persist the original text → associate → enqueue AI extraction
 *
 * The circular is written to the database BEFORE anything clever happens to
 * it. Every step after persistence is best-effort: association can fail and
 * leave the circular unattached, extraction can fail and leave it unenriched,
 * and in both cases the human-authored scientific source is safe. The one
 * outcome this module must make impossible is a circular that arrived and was
 * lost, and no model is on the path that could cause that.
 *
 * WHAT THIS IS NOT
 * ----------------
 * Circulars do NOT pass through `applyAlertFilter`. That filter exists to
 * reject retractions, MDC/mock notices and sub-threshold machine alerts — it
 * encodes rules about machine-generated Notices. A Circular is a human
 * scientific communication; "sub-threshold" is not a property it has, and a
 * circular announcing a retraction is itself important scientific information
 * that must be kept, not dropped.
 */

import { createHash } from "node:crypto";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db, eventCirculars, circularExtractions, eventsTable } from "@workspace/db";
import type { EventCircular } from "@workspace/db";

import {
  circularContentHash as hashContent,
  gcnUrlFor as buildGcnUrl,
  normalizeFormat as toStoredFormat,
  normalizeRegexpHints as toStoredRegexpHints,
  parseCircular as parsePayload,
  type RawGcnCircular as RawCircular,
} from "./payload.js";
import { associateCircular } from "./association.js";
import { EXTRACTION_SCHEMA_VERSION } from "./extractionSchema.js";
import { EXTRACTION_PROMPT_VERSION } from "../services/ai/prompts/circular-extraction.js";
import { logger } from "../lib/logger.js";
import { broadcastCircularAdded, broadcastCircularUpdated } from "../lib/eventBroadcaster.js";

// ─── The wire shape ──────────────────────────────────────────────────────────
//
// Parsing lives in payload.ts, which imports no database. vitest.config.ts
// documents that the unit suite runs without one, and @workspace/db throws at
// module load when DATABASE_URL is unset — so the rules deciding whether a
// circular is storable are kept where they can be tested with nothing running.
// Re-exported here so callers have a single import site.

export {
  parseCircular,
  circularContentHash,
  normalizeFormat,
  gcnUrlFor,
  CircularValidationError,
} from "./payload.js";
export type { RawGcnCircular } from "./payload.js";

export interface IngestResult {
  circular: EventCircular;
  /** false when this exact (circularId, version) was already stored. */
  isNew: boolean;
  /** true when version > 1 — a revision of an earlier circular. */
  isRevision: boolean;
}

// ─── Persist ─────────────────────────────────────────────────────────────────

/**
 * Store a circular and attach it to its event.
 *
 * Idempotent by database constraint, not by an application-level "have I seen
 * this?" check: `event_circulars_identity_uniq` on (circular_id, version)
 * means two concurrent consumers processing the same redelivery cannot both
 * insert. The loser of the race takes the ON CONFLICT path and returns the
 * existing row.
 *
 * @param source 'kafka' for the live stream, 'archive' for the backfill.
 * @param regexpHints Deterministic regex triage from the Python GCN consumer
 *   (see backend/app/gcn/circular_hints.py), or null/undefined when not
 *   computed — always the case for `source: "archive"`, which does not run
 *   that step. Never an AI extraction; stored as-is, not validated for
 *   shape (see normalizeRegexpHints).
 */
export async function persistCircular(
  raw: RawCircular,
  source: "kafka" | "archive" = "kafka",
  regexpHints?: unknown,
): Promise<IngestResult> {
  const createdOn = new Date(raw.createdOn);
  const version = raw.version ?? 1;

  // ── Associate BEFORE the insert so the row lands already attached ─────────
  // A two-step "insert then update" would leave a window in which the circular
  // exists with no event, which a concurrent read would render as unattached.
  //
  // A failure here is fatal to this attempt and is deliberately allowed to
  // propagate: writing UNMATCHED because the lookup never ran would record a
  // false statement about the archive. The caller retries; nothing is lost
  // because nothing was written.
  const decision = await associateCircular({
    eventId: raw.eventId ?? null,
    subject: raw.subject,
    createdOn,
  });

  const values = {
    eventPk: decision.eventPk,
    labId: decision.labId,
    circularId: raw.circularId,
    version,
    isLatest: true,
    gcnEventId: raw.eventId ?? null,
    normalizedEventId: decision.normalizedEventId,
    subject: raw.subject,
    body: raw.body,
    bodyFormat: toStoredFormat(raw.format),
    submitter: raw.submitter,
    submittedHow: raw.submittedHow ?? null,
    bibcode: raw.bibcode ?? null,
    createdOn,
    editedOn: raw.editedOn ? new Date(raw.editedOn) : null,
    editedBy: raw.editedBy ?? null,
    gcnUrl: buildGcnUrl(raw.circularId),
    associationMethod: decision.method,
    associationRationale: decision.rationale,
    candidateEventPk: decision.candidateEventPk,
    associatedAt: new Date(),
    rawPayload: raw as unknown as Record<string, unknown>,
    regexpHints: toStoredRegexpHints(regexpHints),
    contentHash: hashContent(raw.subject, raw.body),
    source,
  };

  // Was this exact version already stored? Determined by whether the INSERT
  // produced a new id, so the answer is the database's, not a prior SELECT's.
  const [existing] = await db
    .select({ id: eventCirculars.id })
    .from(eventCirculars)
    .where(and(eq(eventCirculars.circularId, raw.circularId), eq(eventCirculars.version, version)))
    .limit(1);

  const [row] = await db
    .insert(eventCirculars)
    .values(values)
    .onConflictDoUpdate({
      target: [eventCirculars.circularId, eventCirculars.version],
      set: {
        // Re-running association is the point of a redelivery: the event may
        // have been ingested since. The human-authored text is NOT refreshed
        // from the payload here — an unchanged version has unchanged text by
        // definition, and a changed text would arrive as a new version.
        eventPk: sql`EXCLUDED.event_pk`,
        labId: sql`EXCLUDED.lab_id`,
        normalizedEventId: sql`EXCLUDED.normalized_event_id`,
        associationMethod: sql`EXCLUDED.association_method`,
        associationRationale: sql`EXCLUDED.association_rationale`,
        candidateEventPk: sql`EXCLUDED.candidate_event_pk`,
        associatedAt: sql`EXCLUDED.associated_at`,
        updatedAt: sql`now()`,
      },
    })
    .returning();

  if (!row) {
    throw new Error(`Circular ${raw.circularId} v${version} did not persist and no error was raised.`);
  }

  const isNew = !existing;

  // ── Version bookkeeping ───────────────────────────────────────────────────
  // Only the highest version of a circular_id is `is_latest`. Older versions
  // stay in the table, complete and readable: a revision must never destroy
  // what the original said.
  if (version > 1) {
    await db
      .update(eventCirculars)
      .set({ isLatest: false, updatedAt: new Date() })
      .where(
        and(
          eq(eventCirculars.circularId, raw.circularId),
          ne(eventCirculars.id, row.id),
          sql`${eventCirculars.version} < ${version}`,
        ),
      );
  } else {
    // A version-1 payload arriving after a revision was already stored (an
    // out-of-order replay) must not steal `is_latest` back from it.
    const [{ maxVersion } = { maxVersion: version }] = await db
      .select({ maxVersion: sql<number>`MAX(${eventCirculars.version})::int` })
      .from(eventCirculars)
      .where(eq(eventCirculars.circularId, raw.circularId));

    if (Number(maxVersion) > version) {
      await db
        .update(eventCirculars)
        .set({ isLatest: false, updatedAt: new Date() })
        .where(eq(eventCirculars.id, row.id));
      row.isLatest = false;
    }
  }

  logger.info(
    {
      circularId: row.circularId,
      version: row.version,
      eventPk: row.eventPk != null ? String(row.eventPk) : null,
      associationMethod: row.associationMethod,
      source,
      action: isNew ? (version > 1 ? "revision" : "new") : "duplicate",
    },
    isNew
      ? version > 1
        ? "[circulars] Circular revision stored"
        : "[circulars] Circular stored"
      : "[circulars] Circular already stored — association refreshed, no duplicate created",
  );

  if (row.eventPk == null) {
    logger.warn(
      {
        circularId: row.circularId,
        version: row.version,
        normalizedEventId: row.normalizedEventId,
        associationMethod: row.associationMethod,
      },
      "[circulars] Circular is not attached to any event",
    );
  }

  return { circular: row, isNew, isRevision: version > 1 };
}

// ─── Enqueue enrichment ──────────────────────────────────────────────────────

/**
 * Queue the AI extraction for a circular.
 *
 * NEVER THROWS. The circular is already safely stored by the time this runs;
 * an enrichment that could not even be scheduled must not undo that.
 *
 * The row is created in state 'pending' and picked up by the background
 * worker. Nothing here calls a model — that would put provider latency on the
 * Kafka path, which is exactly what an enrichment layer must not do.
 *
 * @returns true when a new job was created, false when one already existed
 *          for this content (the cache hit) or scheduling failed.
 */
export async function enqueueExtraction(
  circular: Pick<EventCircular, "id" | "circularId" | "version" | "subject" | "body">,
  modelName: string,
): Promise<boolean> {
  // The cache key. Identical content, schema, prompt and model produce an
  // identical hash, and the unique index turns the second attempt into a
  // no-op rather than a second call to a paid API.
  const contentHash = createHash("sha256")
    .update(
      [
        hashContent(circular.subject, circular.body),
        `schema:${EXTRACTION_SCHEMA_VERSION}`,
        `prompt:${EXTRACTION_PROMPT_VERSION}`,
        `model:${modelName}`,
      ].join("|"),
    )
    .digest("hex");

  try {
    const inserted = await db
      .insert(circularExtractions)
      .values({
        circularPk: circular.id,
        status: "pending",
        schemaVersion: EXTRACTION_SCHEMA_VERSION,
        promptVersion: EXTRACTION_PROMPT_VERSION,
        contentHash,
        modelName,
      })
      // A row for this exact content already exists — completed, in flight, or
      // permanently failed. Re-queuing it would re-pay for an answer already
      // held, or re-attempt something already given up on.
      .onConflictDoNothing({
        target: [circularExtractions.circularPk, circularExtractions.contentHash],
      })
      .returning({ id: circularExtractions.id });

    if (inserted.length === 0) {
      logger.debug(
        { circularId: circular.circularId, version: circular.version },
        "[circulars] extraction already recorded for this content — skipped",
      );
      return false;
    }

    logger.info(
      {
        circularId: circular.circularId,
        version: circular.version,
        schemaVersion: EXTRACTION_SCHEMA_VERSION,
        promptVersion: EXTRACTION_PROMPT_VERSION,
      },
      "[circulars] AI extraction queued",
    );
    return true;
  } catch (err) {
    logger.error(
      { err, circularId: circular.circularId, version: circular.version },
      "[circulars] could not queue AI extraction — the circular itself is stored and visible",
    );
    return false;
  }
}

// ─── The full path ───────────────────────────────────────────────────────────

/**
 * Validate, persist, associate, enqueue, broadcast.
 *
 * The entry point used by both the live Kafka bridge and the historical
 * backfill, so the two cannot diverge in how a circular is treated.
 *
 * Throws only on validation failure or a database failure — cases where
 * nothing was written and a retry is the correct response.
 */
export async function ingestCircular(
  payload: unknown,
  options: {
    source?: "kafka" | "archive";
    modelName: string;
    broadcast?: boolean;
    /** See persistCircular's `regexpHints` param. Omitted by the archive backfill. */
    regexpHints?: unknown;
  },
): Promise<IngestResult> {
  const raw = parsePayload(payload);
  const result = await persistCircular(raw, options.source ?? "kafka", options.regexpHints);

  // Enrichment and broadcast are strictly after the source is safe.
  await enqueueExtraction(result.circular, options.modelName);

  if (options.broadcast !== false && result.isNew) {
    // A backfill of 44,766 circulars must not fire 44,766 WebSocket frames;
    // callers pass broadcast:false for that.
    const message = await buildBroadcastPayload(result.circular);
    if (result.isRevision) broadcastCircularUpdated(message);
    else broadcastCircularAdded(message);
  }

  return result;
}

/**
 * The wire form of a circular for WebSocket and API consumers.
 *
 * The body is NOT included: broadcasting 20 KB of text to every connected
 * client on every circular is wasteful, and the client fetches the full
 * circular when a researcher opens it.
 */
export async function buildBroadcastPayload(row: EventCircular): Promise<Record<string, unknown>> {
  let eventIdString: string | null = null;
  if (row.eventPk != null) {
    try {
      const [ev] = await db
        .select({ eventId: eventsTable.eventId })
        .from(eventsTable)
        .where(eq(eventsTable.id, row.eventPk))
        .limit(1);
      eventIdString = ev?.eventId ?? null;
    } catch {
      // Cosmetic only — the numeric key below is what the client routes on.
      eventIdString = null;
    }
  }

  return {
    id: String(row.id),
    circularId: row.circularId,
    version: row.version,
    isLatest: row.isLatest,
    eventPk: row.eventPk != null ? String(row.eventPk) : null,
    eventId: eventIdString,
    gcnEventId: row.gcnEventId,
    subject: row.subject,
    submitter: row.submitter,
    createdOn: row.createdOn.toISOString(),
    associationMethod: row.associationMethod,
    gcnUrl: row.gcnUrl,
  };
}

// ─── Re-association ──────────────────────────────────────────────────────────

/**
 * Attach previously-orphaned circulars to an event that has just appeared.
 *
 * Circulars are routinely received for events this archive does not hold —
 * because the notice topic was not subscribed, or because a backfill loaded
 * circulars before events. When the event does arrive, the circulars that were
 * waiting for it should stop being orphans.
 *
 * NEVER THROWS: it is called fire-and-forget from the notice ingestion path,
 * which must not be affected by anything that happens here.
 *
 * Only UNMATCHED circulars are reconsidered. PENDING_REVIEW ones are left
 * alone on purpose: they were ambiguous, a new event makes them no less
 * ambiguous, and quietly resolving them would defeat the point of holding them
 * for a human.
 *
 * @returns how many circulars were attached.
 */
export async function reassociateOrphans(
  eventPk: bigint,
  eventId: string,
  labId: string,
  aliases: string[],
): Promise<number> {
  try {
    const keys = [eventId, ...aliases].map((k) => k.trim().toUpperCase()).filter(Boolean);
    if (keys.length === 0) return 0;

    const updated = await db
      .update(eventCirculars)
      .set({
        eventPk,
        labId,
        associationMethod: "EXACT",
        associationRationale:
          `Re-associated when event "${eventId}" was ingested: the circular's normalized ` +
          `identifier already matched it, but the event did not yet exist in this archive.`,
        associatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(eventCirculars.associationMethod, "UNMATCHED"),
          // inArray, not `= ANY(${keys})`: Drizzle expands a JS array in a raw
          // sql template into N separate placeholders, which Postgres rejects
          // with "op ANY/ALL (array) requires array on right side". The same
          // construction is used in association.ts.
          inArray(sql`UPPER(${eventCirculars.normalizedEventId})`, keys),
        ),
      )
      .returning({ id: eventCirculars.id, circularId: eventCirculars.circularId });

    if (updated.length > 0) {
      logger.info(
        { eventId, attached: updated.length, circularIds: updated.slice(0, 10).map((u) => u.circularId) },
        "[circulars] orphaned circulars attached to newly ingested event",
      );
    }
    return updated.length;
  } catch (err) {
    logger.error({ err, eventId }, "[circulars] orphan re-association failed — no circular was lost");
    return 0;
  }
}
