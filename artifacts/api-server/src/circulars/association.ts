/**
 * association.ts — deciding which event a GCN Circular belongs to
 * ---------------------------------------------------------------------------
 * DETERMINISTIC BY CONSTRUCTION. No language model is consulted here, and none
 * ever should be. Attaching a human-authored scientific report to the wrong
 * event corrupts the archive in a way that is very hard to notice and very
 * hard to undo, so the decision is made by identifier matching against the
 * database and nothing else.
 *
 * THE LADDER
 * ----------
 *   Level 1  EXACT           GCN's eventId, normalised, matched core.events.event_id
 *   Level 2  ALIAS           matched core.event_aliases (a re-spelling of the same id)
 *   Level 3  PROBABILISTIC   no identifier match; type + time proximity, unique candidate
 *            PENDING_REVIEW  an identifier that resolves to MORE THAN ONE event
 *            UNMATCHED       no identifier, or nothing in this archive matches it
 *
 * WHAT "NOT ATTACHED" MEANS
 * -------------------------
 * PENDING_REVIEW and UNMATCHED both leave `eventPk` NULL. The circular is
 * still stored in full — it is a scientific source and is never discarded —
 * but it does not appear in any event's history, because appearing there
 * would be an assertion this module cannot support. The candidate, when there
 * is one, is recorded separately in `candidateEventPk` so a human can review
 * it without the system having already acted on it.
 *
 * LEVEL 3 IS OFF BY DEFAULT
 * -------------------------
 * A circular's only timestamp is `createdOn` — when the human pressed send.
 * That is not the trigger time: follow-up circulars routinely appear hours to
 * weeks after the burst, and a busy night can produce several GRBs within one
 * plausible window. Temporal proximity is therefore a weak discriminator, and
 * a wrong probabilistic attachment is worse than an honest UNMATCHED. Enable
 * with GCN_CIRCULAR_PROBABILISTIC_ASSOCIATION=true only where a curator is
 * reviewing the results.
 */

import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db, eventsTable, eventAliases } from "@workspace/db";
import type { CircularAssociationMethod } from "@workspace/db";

import { resolveCircularIdentifier, type NormalizedIdentifier } from "./identity.js";
import { logger } from "../lib/logger.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AssociationInput {
  /** GCN's own eventId field, verbatim. May be absent (7.5% of the archive). */
  eventId?: string | null;
  subject?: string | null;
  /** Publication time of the circular. Used only by Level 3. */
  createdOn: Date;
}

export interface AssociationDecision {
  method: CircularAssociationMethod;
  /** Set only for EXACT / ALIAS / PROBABILISTIC. */
  eventPk: bigint | null;
  labId: string | null;
  /** Best candidate when the circular was NOT attached. */
  candidateEventPk: bigint | null;
  /** The canonical identifier this module derived, or null if it found none. */
  normalizedEventId: string | null;
  /** Why this answer, in words, including the candidates that were weighed. */
  rationale: string;
}

/** The subset of an event row association needs. */
interface CandidateEvent {
  id: bigint;
  eventId: string;
  labId: string;
  eventType: string;
  detectionTime: Date;
}

// ─── Configuration ───────────────────────────────────────────────────────────

function probabilisticEnabled(): boolean {
  return process.env["GCN_CIRCULAR_PROBABILISTIC_ASSOCIATION"] === "true";
}

/**
 * How far from a circular's publication time a Level 3 candidate may sit.
 *
 * Default 48 h. Deliberately not wider: the wider this is the more events fall
 * inside it, and the rule requires a UNIQUE candidate, so a wide window mostly
 * produces PENDING_REVIEW rather than better matches.
 */
function probabilisticWindowHours(): number {
  const raw = Number(process.env["GCN_CIRCULAR_PROBABILISTIC_WINDOW_HOURS"]);
  return Number.isFinite(raw) && raw > 0 ? raw : 48;
}

/**
 * Which core.events.event_type values an identifier family may attach to.
 *
 * Only used by Level 3. Identifier-based levels never consult this: if the
 * strings match, the event is the event, whatever type column it happens to
 * carry. (core.events holds GRB, GW, FRB, NU, EP and OTHER — EP rows come
 * from the archive importer, GRB rows for the same instrument from the live
 * normaliser, so a family/type check on the identifier path would reject
 * correct matches.)
 */
const FAMILY_TO_EVENT_TYPES: Readonly<Record<string, readonly string[]>> = {
  GRB: ["GRB", "EP", "OTHER"],
  EP: ["EP", "GRB", "OTHER"],
  GW: ["GW"],
  FRB: ["FRB"],
  NU: ["NU"],
  SGR: ["GRB", "OTHER"],
  XRF: ["GRB", "OTHER"],
  TRANSIENT: ["OTHER"],
  OTHER: [],
};

// ─── Level 1 + 2 lookups ─────────────────────────────────────────────────────

/**
 * Events whose `event_id` equals any of the renderings, case-insensitively.
 *
 * Case-insensitive because the two ingest paths disagree: the archive importer
 * upper-cased ("ICECUBE-251225A") while the GW normaliser did not
 * ("S260605a"). Backed by the UPPER(event_id) index from migration 0019.
 */
async function findByCanonicalId(renderings: string[]): Promise<CandidateEvent[]> {
  if (renderings.length === 0) return [];
  const upper = renderings.map((r) => r.toUpperCase());
  const rows = await db
    .select({
      id: eventsTable.id,
      eventId: eventsTable.eventId,
      labId: eventsTable.labId,
      eventType: eventsTable.eventType,
      detectionTime: eventsTable.detectionTime,
    })
    .from(eventsTable)
    .where(inArray(sql`UPPER(${eventsTable.eventId})`, upper));
  return rows;
}

/** Events reachable through core.event_aliases. */
async function findByAlias(renderings: string[]): Promise<CandidateEvent[]> {
  if (renderings.length === 0) return [];
  const upper = renderings.map((r) => r.toUpperCase());
  const rows = await db
    .select({
      id: eventsTable.id,
      eventId: eventsTable.eventId,
      labId: eventsTable.labId,
      eventType: eventsTable.eventType,
      detectionTime: eventsTable.detectionTime,
    })
    .from(eventAliases)
    .innerJoin(eventsTable, eq(eventAliases.eventPk, eventsTable.id))
    .where(inArray(eventAliases.alias, upper));
  return rows;
}

// ─── Level 3 ─────────────────────────────────────────────────────────────────

async function findByProximity(
  identifier: NormalizedIdentifier | null,
  createdOn: Date,
): Promise<CandidateEvent[]> {
  const types = identifier ? (FAMILY_TO_EVENT_TYPES[identifier.family] ?? []) : [];
  if (types.length === 0) return [];

  const windowMs = probabilisticWindowHours() * 3_600_000;
  // Only BACKWARD in time: a circular is written after the event it describes.
  // A small forward tolerance absorbs clock and timezone edge cases.
  const start = new Date(createdOn.getTime() - windowMs);
  const end = new Date(createdOn.getTime() + 3_600_000);

  return db
    .select({
      id: eventsTable.id,
      eventId: eventsTable.eventId,
      labId: eventsTable.labId,
      eventType: eventsTable.eventType,
      detectionTime: eventsTable.detectionTime,
    })
    .from(eventsTable)
    .where(
      and(
        inArray(eventsTable.eventType, [...types]),
        gte(eventsTable.detectionTime, start),
        lte(eventsTable.detectionTime, end),
      ),
    )
    .limit(25);
}

// ─── Public entry point ──────────────────────────────────────────────────────

/** De-duplicate candidates by primary key, preserving order. */
function distinct(rows: CandidateEvent[]): CandidateEvent[] {
  const seen = new Set<string>();
  const out: CandidateEvent[] = [];
  for (const r of rows) {
    const key = String(r.id);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

function listIds(rows: CandidateEvent[], limit = 5): string {
  const shown = rows.slice(0, limit).map((r) => r.eventId);
  const extra = rows.length - shown.length;
  return extra > 0 ? `${shown.join(", ")} (+${extra} more)` : shown.join(", ");
}

/**
 * Decide which event a circular belongs to.
 *
 * Never throws for want of a match: an unmatchable circular gets an UNMATCHED
 * decision so the caller can still persist it. A database failure DOES throw,
 * because silently recording "unmatched" when the lookup never ran would be a
 * lie about the archive.
 */
export async function associateCircular(input: AssociationInput): Promise<AssociationDecision> {
  const resolved = resolveCircularIdentifier({
    eventId: input.eventId ?? null,
    subject: input.subject ?? null,
  });

  // ── No identifier at all ──────────────────────────────────────────────────
  if (!resolved) {
    const probabilistic = probabilisticEnabled()
      ? await tryProbabilistic(null, input.createdOn)
      : null;
    if (probabilistic) return probabilistic;

    return {
      method: "UNMATCHED",
      eventPk: null,
      labId: null,
      candidateEventPk: null,
      normalizedEventId: null,
      rationale:
        "Neither GCN's eventId field nor the subject line contained a recognisable " +
        "event identifier. The circular is stored but attached to no event.",
    };
  }

  const { identifier, origin } = resolved;
  const originNote =
    origin === "eventId"
      ? `GCN eventId "${identifier.raw}"`
      : `subject line (GCN supplied no eventId) reading "${identifier.raw}"`;

  // ── Level 1: exact ────────────────────────────────────────────────────────
  const exact = distinct(await findByCanonicalId(identifier.renderings));

  if (exact.length === 1) {
    const hit = exact[0]!;
    return {
      method: "EXACT",
      eventPk: hit.id,
      labId: hit.labId,
      candidateEventPk: null,
      normalizedEventId: identifier.canonical,
      rationale:
        `${originNote} normalised to "${identifier.canonical}", which matches ` +
        `core.events.event_id "${hit.eventId}" exactly (case-insensitive).`,
    };
  }

  if (exact.length > 1) {
    return ambiguous(identifier, exact, originNote, "core.events.event_id");
  }

  // ── Level 2: alias ────────────────────────────────────────────────────────
  const aliased = distinct(await findByAlias(identifier.renderings));

  if (aliased.length === 1) {
    const hit = aliased[0]!;
    return {
      method: "ALIAS",
      eventPk: hit.id,
      labId: hit.labId,
      candidateEventPk: null,
      normalizedEventId: identifier.canonical,
      rationale:
        `${originNote} normalised to "${identifier.canonical}", matched via ` +
        `core.event_aliases to event "${hit.eventId}". An alias is an alternate ` +
        `spelling of the same identifier, not a claim that two events are the same object.`,
    };
  }

  if (aliased.length > 1) {
    return ambiguous(identifier, aliased, originNote, "core.event_aliases");
  }

  // ── Level 3: probabilistic ────────────────────────────────────────────────
  if (probabilisticEnabled()) {
    const probabilistic = await tryProbabilistic(identifier, input.createdOn);
    if (probabilistic) return probabilistic;
  }

  // ── Nothing in this archive corresponds to the identifier ─────────────────
  return {
    method: "UNMATCHED",
    eventPk: null,
    labId: null,
    candidateEventPk: null,
    normalizedEventId: identifier.canonical,
    rationale:
      `${originNote} normalised to "${identifier.canonical}", but no event in this ` +
      `archive carries that identifier or any registered alias for it. This means the ` +
      `event was never ingested here — not that the circular is invalid.`,
  };
}

function ambiguous(
  identifier: NormalizedIdentifier,
  candidates: CandidateEvent[],
  originNote: string,
  via: string,
): AssociationDecision {
  logger.warn(
    {
      normalizedEventId: identifier.canonical,
      candidateCount: candidates.length,
      candidates: candidates.slice(0, 5).map((c) => c.eventId),
    },
    "[circulars] ambiguous association — circular held for review, not attached",
  );
  return {
    method: "PENDING_REVIEW",
    eventPk: null,
    labId: null,
    candidateEventPk: candidates[0]!.id,
    normalizedEventId: identifier.canonical,
    rationale:
      `${originNote} normalised to "${identifier.canonical}", which matched ` +
      `${candidates.length} events via ${via}: ${listIds(candidates)}. Attaching it to ` +
      `one of them would be a guess, so the circular is held for review and appears ` +
      `on no event.`,
  };
}

async function tryProbabilistic(
  identifier: NormalizedIdentifier | null,
  createdOn: Date,
): Promise<AssociationDecision | null> {
  const nearby = distinct(await findByProximity(identifier, createdOn));
  if (nearby.length !== 1) {
    if (nearby.length > 1 && identifier) {
      return {
        method: "PENDING_REVIEW",
        eventPk: null,
        labId: null,
        candidateEventPk: nearby[0]!.id,
        normalizedEventId: identifier.canonical,
        rationale:
          `No identifier match. Within ${probabilisticWindowHours()} h of publication ` +
          `there were ${nearby.length} compatible events (${listIds(nearby)}), so no ` +
          `single one can be chosen. Held for review.`,
      };
    }
    return null;
  }

  const hit = nearby[0]!;
  const hours = Math.abs(createdOn.getTime() - hit.detectionTime.getTime()) / 3_600_000;
  return {
    method: "PROBABILISTIC",
    eventPk: hit.id,
    labId: hit.labId,
    candidateEventPk: hit.id,
    normalizedEventId: identifier?.canonical ?? null,
    rationale:
      `No identifier match. "${hit.eventId}" (${hit.eventType}) was the only compatible ` +
      `event within ${probabilisticWindowHours()} h of publication, ${hours.toFixed(1)} h ` +
      `earlier. This is a PROBABILISTIC association inferred from timing, not a stated ` +
      `identifier, and must be presented as such.`,
  };
}

// ─── Alias seeding ───────────────────────────────────────────────────────────

/**
 * Register the mechanical re-spellings of an event's identifier so Level 2 can
 * find it.
 *
 * Never throws and never overwrites: an alias already claimed by another event
 * is left alone, because a unique alias pointing at two events would make
 * association ambiguous by construction. Returns how many rows were inserted,
 * for logging only.
 */
export async function seedAliasesForEvent(
  eventPk: bigint,
  eventId: string,
  renderings: string[],
): Promise<number> {
  const rows = renderings
    .map((r) => r.trim().toUpperCase())
    .filter((r) => r.length > 0)
    .map((alias) => ({
      eventPk,
      alias,
      aliasSource: alias === eventId.trim().toUpperCase() ? "CANONICAL" : "RENDERING",
      note: `Mechanical re-spelling of core.events.event_id "${eventId}".`,
    }));

  if (rows.length === 0) return 0;

  try {
    const inserted = await db
      .insert(eventAliases)
      .values(rows)
      .onConflictDoNothing({ target: eventAliases.alias })
      .returning({ id: eventAliases.id });
    return inserted.length;
  } catch (err) {
    logger.error({ err, eventId }, "[circulars] alias seeding failed — association falls back to exact matching");
    return 0;
  }
}
