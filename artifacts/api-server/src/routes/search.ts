/**
 * search.ts — one query across events and GCN circulars
 * ---------------------------------------------------------------------------
 * Backs the search palette. A researcher typing "260310" wants the burst;
 * typing "kilonova" wants the circulars that discuss one. Those are two
 * different kinds of search and this endpoint runs both.
 *
 *   IDENTIFIERS      trigram / ILIKE. "260310" must find GRB260310A, and a
 *                    substring inside a token is invisible to full-text
 *                    search, which only indexes whole lexemes.
 *
 *   CONTENT          weighted full-text over subject (A) + body (B), so
 *                    "kilonova" also matches "kilonovae" and a circular whose
 *                    SUBJECT is about them outranks one that mentions the word
 *                    once in passing.
 *
 * Both are backed by indexes from migration 0020. Before it, searching circular
 * bodies took ~1.9 s — measured, not estimated — which for a palette that
 * fires on every keystroke is not slow but broken.
 *
 * Read-only and public, matching /events and /events/:id/circulars.
 */

import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../lib/logger.js";

const router = Router();

/** Hard cap per section. The palette shows a handful; nothing paginates here. */
const MAX_LIMIT = 25;
const DEFAULT_LIMIT = 8;

/**
 * The shortest query worth running.
 *
 * A single character matches most of the archive and would return noise while
 * doing the most work — the trigram indexes need three characters to be
 * selective at all.
 */
const MIN_QUERY_LENGTH = 2;

/**
 * Counting stops here. Beyond it the client renders "1000+".
 *
 * An exact total over tens of thousands of full-text matches costs more than
 * the results themselves and tells a reader nothing they act on.
 */
const COUNT_CEILING = 1000;

interface EventHit {
  kind: "event";
  id: string;
  eventId: string;
  eventType: string;
  observatory: string;
  detectionTime: string;
  circularCount: number;
}

interface CircularHit {
  kind: "circular";
  id: string;
  circularId: number;
  version: number;
  subject: string;
  submitter: string;
  createdOn: string;
  /** Event primary key, or null when the circular is attached to nothing. */
  eventPk: string | null;
  eventId: string | null;
  /**
   * Matching fragment of the circular body, with [[hl]]...[[/hl]] around the hit
   * terms.
   *
   * NOT HTML. ts_headline does not escape the text it wraps, so returning
   * <mark> tags would hand the client markup built from untrusted circular
   * bodies — a stored-XSS vector the moment anything renders it as HTML.
   * The marker is plain text that cannot be parsed as markup, and the client
   * splits on it and renders text nodes, so a body containing "<script>" is
   * displayed rather than executed.
   */
  snippet: string | null;
}

// ─── GET /search ─────────────────────────────────────────────────────────────

router.get("/search", async (req, res) => {
  const raw = req.query["q"];
  const q = typeof raw === "string" ? raw.trim() : "";

  const parsedLimit = Number.parseInt(String(req.query["limit"] ?? ""), 10);
  const limit = Number.isInteger(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  if (q.length < MIN_QUERY_LENGTH) {
    // Not an error — an empty palette is the normal resting state.
    res.json({
      query: q,
      events: [],
      circulars: [],
      counts: { events: 0, circulars: 0 },
      note: q.length === 0 ? null : `Type at least ${MIN_QUERY_LENGTH} characters.`,
    });
    return;
  }

  const like = `%${q}%`;
  // A purely numeric query is very likely a circular id or a date fragment;
  // matched exactly as well as by substring so "35176" surfaces circular 35176
  // itself rather than only circulars that mention the number.
  const numeric = /^\d+$/.test(q) ? Number(q) : null;

  try {
    const [eventRows, circularRows, counts] = await Promise.all([
      // ── Events ─────────────────────────────────────────────────────────────
      // Ordered by detection time, not relevance: for an identifier search the
      // matches are near-equivalent, and a researcher scanning them expects
      // newest first, as everywhere else in the archive.
      db.execute(sql`
        SELECT e.id,
               e.event_id,
               e.event_type,
               e.observatory,
               e.detection_time,
               (SELECT count(*) FROM core.event_circulars c
                 WHERE c.event_pk = e.id)::int AS circular_count
          FROM core.events e
         WHERE e.event_id ILIKE ${like}
            OR e.observatory ILIKE ${like}
         ORDER BY e.detection_time DESC
         LIMIT ${limit}
      `),

      // ── Circulars ──────────────────────────────────────────────────────────
      // Full-text OR identifier match, ranked by relevance. The OR is what
      // lets "260310" work: it produces no useful tsquery, so without the
      // ILIKE arm an identifier search would return nothing at all.
      //
      // websearch_to_tsquery, not plainto_tsquery: it tolerates whatever a
      // human types — quoted phrases, OR, a leading minus — instead of
      // erroring on punctuation.
      //
      // TWO-STAGE ON PURPOSE. `hits` finds and ranks against the STORED
      // search_vector, then LIMITs; ts_headline runs only on the survivors.
      // Highlighting inside the ranked query would build a snippet for every
      // match before discarding all but a handful — for a common word like
      // "swift" that is tens of thousands of wasted headline computations.
      db.execute(sql`
        WITH query AS (SELECT websearch_to_tsquery('english', ${q}) AS tsq),
        hits AS (
          SELECT c.id,
                 c.circular_id,
                 c.version,
                 c.subject,
                 c.submitter,
                 c.created_on,
                 c.event_pk,
                 ts_rank(c.search_vector, query.tsq) AS rank
            FROM core.event_circulars c
            CROSS JOIN query
           WHERE c.is_latest
             AND (
                   c.search_vector @@ query.tsq
                OR c.subject ILIKE ${like}
                OR c.gcn_event_id ILIKE ${like}
                OR (${numeric}::numeric IS NOT NULL AND c.circular_id = ${numeric}::numeric)
             )
           ORDER BY rank DESC, c.created_on DESC
           LIMIT ${limit}
        )
        SELECT h.*,
               e.event_id,
               ts_headline(
                 'english',
                 c.body,
                 query.tsq,
                 'MaxFragments=1, MaxWords=28, MinWords=10, StartSel=[[hl]], StopSel=[[/hl]]'
               ) AS snippet
          FROM hits h
          JOIN core.event_circulars c ON c.id = h.id
          CROSS JOIN query
          LEFT JOIN core.events e ON e.id = h.event_pk
         ORDER BY h.rank DESC, h.created_on DESC
      `),

      // ── Totals ─────────────────────────────────────────────────────────────
      // So the palette can say "8 of 171" rather than implying the list is
      // everything there is.
      //
      // COUNTED UP TO A CEILING, not exhaustively. "observation" appears in
      // 32,169 of 44,766 circulars and counting them all cost ~430 ms — paid
      // on every keystroke to render a number nobody reads precisely at that
      // magnitude. The inner LIMIT lets Postgres stop early; past the ceiling
      // the client shows "1000+", which is honest rather than approximate.
      db.execute(sql`
        WITH query AS (SELECT websearch_to_tsquery('english', ${q}) AS tsq)
        SELECT
          (SELECT count(*) FROM (
             SELECT 1 FROM core.events e
              WHERE e.event_id ILIKE ${like} OR e.observatory ILIKE ${like}
              LIMIT ${COUNT_CEILING}
           ) t)::int AS events,
          (SELECT count(*) FROM (
             SELECT 1 FROM core.event_circulars c CROSS JOIN query
              WHERE c.is_latest
                AND (c.search_vector @@ query.tsq
                  OR c.subject ILIKE ${like}
                  OR c.gcn_event_id ILIKE ${like})
              LIMIT ${COUNT_CEILING}
           ) t)::int AS circulars
      `),
    ]);

    const rowsOf = (r: unknown): Record<string, unknown>[] =>
      ((r as { rows?: unknown[] }).rows as Record<string, unknown>[]) ??
      (r as Record<string, unknown>[]);

    const events: EventHit[] = rowsOf(eventRows).map((r) => ({
      kind: "event",
      id: String(r["id"]),
      eventId: String(r["event_id"]),
      eventType: String(r["event_type"]),
      observatory: String(r["observatory"] ?? "Unknown"),
      detectionTime: new Date(r["detection_time"] as string).toISOString(),
      circularCount: Number(r["circular_count"] ?? 0),
    }));

    const circulars: CircularHit[] = rowsOf(circularRows).map((r) => ({
      kind: "circular",
      id: String(r["id"]),
      circularId: Number(r["circular_id"]),
      version: Number(r["version"]),
      subject: String(r["subject"]),
      submitter: String(r["submitter"]),
      createdOn: new Date(r["created_on"] as string).toISOString(),
      eventPk: r["event_pk"] != null ? String(r["event_pk"]) : null,
      eventId: r["event_id"] != null ? String(r["event_id"]) : null,
      // Null when the hit came from the identifier arm — there is no
      // full-text match to highlight, and inventing a fragment would imply one.
      snippet:
        typeof r["snippet"] === "string" && (r["snippet"] as string).includes("[[hl]]")
          ? (r["snippet"] as string)
          : null,
    }));

    const total = rowsOf(counts)[0] ?? {};

    res.json({
      query: q,
      events,
      circulars,
      counts: {
        events: Number(total["events"] ?? 0),
        circulars: Number(total["circulars"] ?? 0),
        /** true when a count hit the ceiling — render as "N+", not "N". */
        capped:
          Number(total["events"] ?? 0) >= COUNT_CEILING ||
          Number(total["circulars"] ?? 0) >= COUNT_CEILING,
        ceiling: COUNT_CEILING,
      },
      note: null,
    });
  } catch (err) {
    logger.error({ err, q }, "[search] query failed");
    res.status(500).json({ error: "Search failed" });
  }
});

export default router;
