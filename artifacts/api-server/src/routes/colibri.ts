/**
 * colibri.ts — Astro-COLIBRI enrichment endpoints
 * ---------------------------------------------------------------------------
 * Follows the conventions already in this router: a plain Express route, not
 * in openapi.yaml — the same choice made for /events/:id/revisions and
 * /events/:id/correlations, whose clients call them with raw fetch().
 *
 * TWO IDENTIFIERS, ONE ROUTE
 * --------------------------
 * :id is the numeric core.events primary key, as everywhere else in this API.
 * Astro-COLIBRI, being a third party, knows nothing of our primary keys — it
 * indexes on the human-readable event name ("GRB260503A"), which we store as
 * events.event_id. So this handler does the translation: it takes our id from
 * the path, reads the event's name out of the database, and sends only that
 * name upstream. A caller passing our primary key straight through to
 * Astro-COLIBRI would query them for an event called "1417" and always get
 * an empty result, which would be indistinguishable from "no afterglow".
 *
 * FAILURE SEMANTICS
 * -----------------
 * 502 means WE could not reach Astro-COLIBRI — we know nothing about this
 * event's afterglow. A 200 carrying { available: false } means Astro-COLIBRI
 * answered and holds nothing. The client renders these differently on purpose;
 * reporting an outage as an absence of observations would be a claim about the
 * sky that no one made.
 */

import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, eventsTable } from "@workspace/db";

import { logger } from "../lib/logger.js";
import { fetchAfterglow, fetchFollowupSummary } from "../services/astro-colibri/client.js";

const router: IRouter = Router();

router.get("/events/:id/colibri/afterglow", async (req, res) => {
  const id = parseInt(req.params["id"] ?? "", 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid event ID — must be a positive integer" });
    return;
  }

  const [row] = await db
    .select({ eventId: eventsTable.eventId })
    .from(eventsTable)
    .where(eq(eventsTable.id, BigInt(id)))
    .limit(1);

  if (!row) {
    res.status(404).json({ error: "Event not found" });
    return;
  }

  // Only the human-readable name crosses the boundary to Astro-COLIBRI.
  const afterglow = await fetchAfterglow(row.eventId);

  if (afterglow === null) {
    logger.warn(
      { id, eventId: row.eventId },
      "[colibri] afterglow lookup failed upstream; reporting 502",
    );
    res.status(502).json({ error: "Astro-COLIBRI service unavailable" });
    return;
  }

  res.json(afterglow);
});

/**
 * Aggregated follow-up reports. Same identifier translation and the same
 * 502-vs-{ available: false } split as the afterglow route above; the id parse
 * and lookup are repeated rather than extracted, matching how routes/events.ts
 * writes each handler out in full.
 */
router.get("/events/:id/colibri/followup", async (req, res) => {
  const id = parseInt(req.params["id"] ?? "", 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid event ID — must be a positive integer" });
    return;
  }

  const [row] = await db
    .select({ eventId: eventsTable.eventId })
    .from(eventsTable)
    .where(eq(eventsTable.id, BigInt(id)))
    .limit(1);

  if (!row) {
    res.status(404).json({ error: "Event not found" });
    return;
  }

  // Only the human-readable name crosses the boundary to Astro-COLIBRI.
  const followup = await fetchFollowupSummary(row.eventId);

  if (followup === null) {
    logger.warn(
      { eventId: row.eventId },
      "[astro-colibri] followup upstream failure",
    );
    res.status(502).json({ error: "Astro-COLIBRI service unavailable" });
    return;
  }

  res.json(followup);
});

export default router;
