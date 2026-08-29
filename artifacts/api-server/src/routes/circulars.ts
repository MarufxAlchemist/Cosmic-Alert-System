/**
 * circulars.ts — GCN Circular and event-timeline endpoints
 * ---------------------------------------------------------------------------
 * Follows the conventions already in this router:
 *   * plain Express routes, not in openapi.yaml — the same choice made for
 *     /events/:id/revisions and /events/:id/correlations, whose clients call
 *     them with raw fetch(). Adding these to the spec would regenerate the
 *     orval client for endpoints nothing generated consumes.
 *   * :id is the numeric core.events primary key, as everywhere else.
 *   * public read, matching /events and /events/:id/revisions. Notes,
 *     bookmarks and discussions are the authenticated resources; published
 *     GCN circulars are public scientific record.
 *
 * TENANCY
 * -------
 * A circular carries the lab_id of the event it is attached to, and every
 * query below is scoped through that event. An UNMATCHED or PENDING_REVIEW
 * circular has no lab and is therefore served by no event route — it cannot
 * leak into another lab's view because it appears in no lab's view at all.
 *
 * WHAT THE PAYLOADS PROMISE
 * -------------------------
 * Every response separates three kinds of statement, because merging them is
 * how an archive stops being evidence:
 *   source      — what the circular's authors wrote (subject, body, submitter)
 *   association — what this system decided, with its method and rationale
 *   extraction  — what a model read out of the text, with its model and time
 */

import { Router } from "express";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  eventsTable,
  eventCirculars,
  circularExtractions,
  eventRevisions,
} from "@workspace/db";
import type { EventCircular, CircularExtraction } from "@workspace/db";

import { logger } from "../lib/logger.js";
import { configuredModelName, extractionEnabled } from "../circulars/extractionWorker.js";

const router = Router();

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Event primary keys and version numbers: strictly positive integers. */
function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * A GCN circular id, which is NOT necessarily a positive integer.
 *
 * Seven real archived circulars have ids of -1, -2, -3, -4, 0, 18448.5 and
 * 18453.5. Rejecting those here would make genuine scientific reports
 * unreachable through the API even though they are stored.
 */
function parseCircularId(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * The extraction as the client sees it.
 *
 * `status` is always present and always honest. A failed or pending extraction
 * returns its state and its reason rather than an empty payload — an empty
 * extraction rendered beside a circular reads as "this circular reported
 * nothing", which is a scientific claim nobody made.
 */
function formatExtraction(row: CircularExtraction | undefined) {
  if (!row) {
    return {
      status: "none" as const,
      note: "No AI extraction has been recorded for this circular.",
    };
  }
  return {
    status: row.status,
    /** Present only when status === 'completed'. */
    data: row.status === "completed" ? row.extraction : null,
    // Provenance: which model, which prompt, which schema, when.
    model: row.provider ?? row.modelName ?? null,
    schemaVersion: row.schemaVersion,
    promptVersion: row.promptVersion,
    extractedAt: row.extractedAt?.toISOString() ?? null,
    attempts: row.attempts,
    failureKind: row.failureKind ?? null,
    /** Why it failed, so a researcher is not left guessing at a blank panel. */
    error: row.status === "failed" ? row.lastError : null,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
  };
}

/** Circular metadata, without the body. Used in list responses. */
function formatCircularSummary(row: EventCircular) {
  return {
    id: String(row.id),
    circularId: row.circularId,
    version: row.version,
    isLatest: row.isLatest,
    /** Original vs Revised, decided by the version number, not by a guess. */
    revisionStatus: row.version > 1 ? ("revised" as const) : ("original" as const),
    eventPk: row.eventPk != null ? String(row.eventPk) : null,
    /** GCN's own words for the event name — what a citation would quote. */
    gcnEventId: row.gcnEventId,
    normalizedEventId: row.normalizedEventId,
    subject: row.subject,
    submitter: row.submitter,
    submittedHow: row.submittedHow,
    bibcode: row.bibcode,
    /** Publication time of the circular — NOT the event's trigger time. */
    createdOn: row.createdOn.toISOString(),
    editedOn: row.editedOn?.toISOString() ?? null,
    editedBy: row.editedBy,
    gcnUrl: row.gcnUrl,
    bodyFormat: row.bodyFormat,
    association: {
      method: row.associationMethod,
      rationale: row.associationRationale,
      candidateEventPk: row.candidateEventPk != null ? String(row.candidateEventPk) : null,
    },
    source: row.source,
    ingestedAt: row.ingestedAt.toISOString(),
  };
}

/** Circular including the full original text. */
function formatCircularFull(row: EventCircular) {
  return {
    ...formatCircularSummary(row),
    /**
     * The complete original circular, verbatim. Always served, whatever the
     * extraction did, because it is the scientific source of record.
     */
    body: row.body,
  };
}

/** Load the newest extraction per circular in one query. */
async function loadExtractions(circularPks: bigint[]): Promise<Map<string, CircularExtraction>> {
  const out = new Map<string, CircularExtraction>();
  if (circularPks.length === 0) return out;

  const rows = await db
    .select()
    .from(circularExtractions)
    .where(inArray(circularExtractions.circularPk, circularPks))
    .orderBy(desc(circularExtractions.createdAt));

  // Newest first, so the first row seen for a circular is the one to keep.
  // A second row exists only when the schema, prompt or model changed; the
  // older extraction stays in the table as provenance but is not served here.
  for (const row of rows) {
    const key = String(row.circularPk);
    if (!out.has(key)) out.set(key, row);
  }
  return out;
}

// ─── GET /events/:id/circulars ───────────────────────────────────────────────
//
// Every circular attached to this event, oldest first — the order in which the
// scientific story actually unfolded.
//
// Query: ?includeSuperseded=true also returns older versions of a revised
// circular. Default false, so the list shows the current text of each circular
// without the earlier versions interleaved; the history is always reachable at
// /circulars/:circularId/versions.

router.get("/events/:id/circulars", async (req, res) => {
  const id = parsePositiveInt(req.params["id"]);
  if (id === null) {
    res.status(400).json({ error: "Invalid event ID — must be a positive integer" });
    return;
  }

  const includeSuperseded = req.query["includeSuperseded"] === "true";

  try {
    const conditions = [eq(eventCirculars.eventPk, BigInt(id))];
    if (!includeSuperseded) conditions.push(eq(eventCirculars.isLatest, true));

    const rows = await db
      .select()
      .from(eventCirculars)
      .where(and(...conditions))
      .orderBy(asc(eventCirculars.createdOn), asc(eventCirculars.circularId));

    const extractions = await loadExtractions(rows.map((r) => r.id));

    res.json({
      eventPk: String(id),
      total: rows.length,
      circulars: rows.map((row) => ({
        ...formatCircularSummary(row),
        extraction: formatExtraction(extractions.get(String(row.id))),
      })),
    });
  } catch (err) {
    logger.error({ err, eventId: id }, "[circulars] GET /events/:id/circulars failed");
    res.status(500).json({ error: "Could not load circulars for this event" });
  }
});

// ─── GET /events/:id/timeline ────────────────────────────────────────────────
//
// The combined evidence timeline: every notice received for the event and
// every circular attached to it, on one chronological axis, ordered newest
// first.
//
// Every entry carries `source`, `timestamp`, `type` and its provenance. No
// entry is synthesised — each one corresponds to a row that exists, and an
// event with no revision history and no circulars returns an empty timeline
// rather than a fabricated "detected" marker.
//
// A NOTE ON THE TWO TIMESTAMPS
// A notice entry is stamped with when the notice was RECEIVED; a circular
// entry with when it was PUBLISHED. Neither is the event's trigger time (that
// is the event's own detectionTime, returned in `event`). Conflating
// publication time with trigger time is the single easiest way to misread a
// circular, so the field is named and labelled explicitly.

interface TimelineEntry {
  kind: "notice" | "circular";
  timestamp: string;
  timestampMeaning: string;
  title: string;
  detail: string | null;
  provenance: Record<string, unknown>;
}

router.get("/events/:id/timeline", async (req, res) => {
  const id = parsePositiveInt(req.params["id"]);
  if (id === null) {
    res.status(400).json({ error: "Invalid event ID — must be a positive integer" });
    return;
  }

  try {
    const [event] = await db
      .select()
      .from(eventsTable)
      .where(eq(eventsTable.id, BigInt(id)))
      .limit(1);

    if (!event) {
      res.status(404).json({ error: "Event not found" });
      return;
    }

    const [notices, circulars] = await Promise.all([
      db
        .select()
        .from(eventRevisions)
        .where(eq(eventRevisions.eventPk, BigInt(id)))
        .orderBy(asc(eventRevisions.revisionIndex)),
      db
        .select()
        .from(eventCirculars)
        .where(and(eq(eventCirculars.eventPk, BigInt(id)), eq(eventCirculars.isLatest, true)))
        .orderBy(asc(eventCirculars.createdOn)),
    ]);

    const extractions = await loadExtractions(circulars.map((c) => c.id));

    const entries: TimelineEntry[] = [];

    for (const n of notices) {
      entries.push({
        kind: "notice",
        timestamp: n.receivedAt.toISOString(),
        timestampMeaning: "when this notice was received by Transient Event Detection",
        title: n.revisionIndex === 0 ? "Initial GCN Notice" : `GCN Notice — revision ${n.revisionIndex}`,
        detail: n.isRetraction ? "Retraction" : (n.alertType ?? n.lifecycle ?? null),
        provenance: {
          source: "GCN Notice",
          revisionIndex: n.revisionIndex,
          alertType: n.alertType,
          lifecycle: n.lifecycle,
          isRetraction: n.isRetraction,
          // null means the delta could NOT be computed — never that nothing
          // changed. The client must render the two differently.
          significance: n.significance ?? null,
          machineGenerated: true,
        },
      });
    }

    for (const c of circulars) {
      const extraction = extractions.get(String(c.id));
      entries.push({
        kind: "circular",
        timestamp: c.createdOn.toISOString(),
        timestampMeaning: "when this circular was published by its authors",
        title: `GCN Circular #${c.circularId}`,
        detail: c.subject,
        provenance: {
          source: "GCN Circular",
          circularId: c.circularId,
          version: c.version,
          revisionStatus: c.version > 1 ? "revised" : "original",
          submitter: c.submitter,
          gcnUrl: c.gcnUrl,
          associationMethod: c.associationMethod,
          humanAuthored: true,
          extractionStatus: extraction?.status ?? "none",
        },
      });
    }

    // Newest first. An event that is still developing is read from its latest
    // evidence backwards, so the most recent notice or circular sits at the top
    // rather than at the bottom of a list that grows for weeks.
    //
    // The reverse() before the sort matters: sort is stable, so entries sharing
    // an identical timestamp (two notices received in the same second) would
    // otherwise keep the ascending order they were built in and read backwards
    // inside the tie. Reversing first makes ties descend too.
    entries.reverse();
    entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    res.json({
      eventPk: String(event.id),
      eventId: event.eventId,
      /** The event's own trigger time. Distinct from every timestamp below. */
      detectionTime: event.detectionTime.toISOString(),
      noticeCount: notices.length,
      circularCount: circulars.length,
      entries,
    });
  } catch (err) {
    logger.error({ err, eventId: id }, "[circulars] GET /events/:id/timeline failed");
    res.status(500).json({ error: "Could not load the timeline for this event" });
  }
});

// ─── GET /circulars/extraction-status ────────────────────────────────────────
//
// The state of the AI enrichment queue.
//
// Registered BEFORE /circulars/:circularId so Express does not treat
// "extraction-status" as an id.
//
// Exists because "AI extraction failed" was previously only answerable with
// psql. A researcher seeing that on a circular has no way to tell whether one
// call timed out or nothing has been configured at all — and those call for
// completely different actions.
//
// Reports the provider NAME, never a key. `configured: false` is the honest
// answer when no credentials are present; the value itself stays server-side.

router.get("/circulars/extraction-status", async (_req, res) => {
  try {
    const [statusRows, kindRows, coverage] = await Promise.all([
      db
        .select({ status: circularExtractions.status, count: sql<number>`count(*)::int` })
        .from(circularExtractions)
        .groupBy(circularExtractions.status),
      db
        .select({ kind: circularExtractions.failureKind, count: sql<number>`count(*)::int` })
        .from(circularExtractions)
        .where(eq(circularExtractions.status, "failed"))
        .groupBy(circularExtractions.failureKind),
      db.execute(sql`
        SELECT
          (SELECT count(*) FROM core.event_circulars)::int AS circulars,
          (SELECT count(DISTINCT circular_pk) FROM core.circular_extractions
            WHERE status = 'completed')::int AS extracted
      `),
    ]);

    const byStatus: Record<string, number> = {
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
    };
    for (const r of statusRows) byStatus[r.status] = Number(r.count);

    const cov =
      ((coverage as unknown as { rows?: unknown[] }).rows as Record<string, unknown>[])?.[0] ??
      (coverage as unknown as Record<string, unknown>[])[0] ??
      {};

    // Resolved rather than assumed: the worker reports the model it would
    // actually use, which is "unconfigured" when no credentials exist.
    const model = configuredModelName();

    res.json({
      /** false when CIRCULAR_AI_EXTRACTION=false — the loop is not running. */
      enabled: extractionEnabled(),
      /** false when no LLM credentials are present. Never the key itself. */
      configured: model !== "unconfigured",
      model,
      byStatus,
      /** Only meaningful for failures; distinguishes "retry later" from "cannot succeed". */
      failuresByKind: kindRows.map((r) => ({
        kind: r.kind ?? "unknown",
        count: Number(r.count),
      })),
      coverage: {
        circulars: Number(cov["circulars"] ?? 0),
        extracted: Number(cov["extracted"] ?? 0),
      },
    });
  } catch (err) {
    logger.error({ err }, "[circulars] GET /circulars/extraction-status failed");
    res.status(500).json({ error: "Could not load extraction status" });
  }
});

// ─── GET /circulars/:circularId/versions ─────────────────────────────────────
//
// Registered before /circulars/:circularId so Express does not consume
// "versions" as the id.
//
// The complete revision history of one circular, newest version first. The
// original text of every version is included: a revision adds a version, it
// never rewrites what was already published, and a researcher must be able to
// see what an earlier version said.

router.get("/circulars/:circularId/versions", async (req, res) => {
  const circularId = parseCircularId(req.params["circularId"]);
  if (circularId === null) {
    res.status(400).json({ error: "Invalid circular ID — must be a number" });
    return;
  }

  try {
    const rows = await db
      .select()
      .from(eventCirculars)
      .where(eq(eventCirculars.circularId, circularId))
      .orderBy(desc(eventCirculars.version));

    if (rows.length === 0) {
      res.status(404).json({ error: "Circular not found" });
      return;
    }

    res.json({
      circularId,
      currentVersion: rows[0]!.version,
      versionCount: rows.length,
      versions: rows.map((row) => ({
        ...formatCircularFull(row),
        /**
         * Character-level size of this version's text. Enough to see at a
         * glance that a revision changed something substantial; a real diff is
         * left to the client, which has both bodies.
         */
        bodyLength: row.body.length,
      })),
    });
  } catch (err) {
    logger.error({ err, circularId }, "[circulars] GET /circulars/:id/versions failed");
    res.status(500).json({ error: "Could not load circular versions" });
  }
});

// ─── GET /circulars/:circularId ──────────────────────────────────────────────
//
// One circular in full: the original text, its provenance, its association and
// its AI extraction, clearly separated.
//
// Query: ?version=N selects a specific version. Default is the latest.

router.get("/circulars/:circularId", async (req, res) => {
  const circularId = parseCircularId(req.params["circularId"]);
  if (circularId === null) {
    res.status(400).json({ error: "Invalid circular ID — must be a number" });
    return;
  }

  const rawVersion = req.query["version"];
  let version: number | null = null;
  if (typeof rawVersion === "string" && rawVersion !== "") {
    version = parsePositiveInt(rawVersion);
    if (version === null) {
      res.status(400).json({ error: "Invalid version — must be a positive integer" });
      return;
    }
  }

  try {
    const conditions = [eq(eventCirculars.circularId, circularId)];
    if (version !== null) conditions.push(eq(eventCirculars.version, version));

    const [row] = await db
      .select()
      .from(eventCirculars)
      .where(and(...conditions))
      .orderBy(desc(eventCirculars.version))
      .limit(1);

    if (!row) {
      res.status(404).json({ error: "Circular not found" });
      return;
    }

    // The event, for a link back. Absent for an unassociated circular, and the
    // absence is reported rather than papered over.
    let event: { id: string; eventId: string; eventType: string } | null = null;
    if (row.eventPk != null) {
      const [ev] = await db
        .select({
          id: eventsTable.id,
          eventId: eventsTable.eventId,
          eventType: eventsTable.eventType,
        })
        .from(eventsTable)
        .where(eq(eventsTable.id, row.eventPk))
        .limit(1);
      if (ev) event = { id: String(ev.id), eventId: ev.eventId, eventType: ev.eventType };
    }

    const [{ count } = { count: 0 }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(eventCirculars)
      .where(eq(eventCirculars.circularId, circularId));

    const extractions = await loadExtractions([row.id]);

    res.json({
      ...formatCircularFull(row),
      event,
      versionCount: Number(count),
      extraction: formatExtraction(extractions.get(String(row.id))),
    });
  } catch (err) {
    logger.error({ err, circularId }, "[circulars] GET /circulars/:id failed");
    res.status(500).json({ error: "Could not load the circular" });
  }
});

export default router;
