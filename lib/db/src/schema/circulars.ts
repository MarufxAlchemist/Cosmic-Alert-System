/**
 * circulars.ts — GCN Circular intelligence (migration 0019)
 * ---------------------------------------------------------------------------
 * A GCN *Notice* is a machine-generated rapid alert. A GCN *Circular* is a
 * human-authored scientific communication about the same event, published
 * minutes to weeks later, carrying follow-up observations, refined
 * localizations, spectroscopy, redshifts, upper limits and corrections.
 *
 * These tables attach Circulars to the canonical `core.events` row. They add
 * to that store; they never replace or duplicate it.
 *
 * Three invariants are encoded here and enforced by CHECK constraints in the
 * migration:
 *
 *   1. Identity is (circularId, version). A revision is a NEW row, so the
 *      original human-authored text is never overwritten.
 *   2. `eventPk IS NULL` ⟺ the circular is NOT associated. An uncertain
 *      association is recorded as uncertain, never silently attached.
 *   3. The AI extraction lives in its own table. A model failure leaves the
 *      circular stored, associated and visible.
 */

import {
  pgSchema,
  bigserial,
  bigint,
  integer,
  numeric,
  uuid,
  text,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { coreSchema, events } from "./events.js";
import { labs } from "./tenant.js";

// ─── core.event_circulars ────────────────────────────────────────────────────

/**
 * How a circular was linked to an event.
 *
 * Decided entirely by deterministic identifier matching. A language model
 * never produces one of these values.
 */
export const CIRCULAR_ASSOCIATION_METHODS = [
  /** GCN's own eventId normalised to the canonical form matched core.events.event_id. */
  "EXACT",
  /** Matched via core.event_aliases — an alternate rendering of the same identifier. */
  "ALIAS",
  /** No unambiguous identifier; matched by type + temporal proximity. Always labelled. */
  "PROBABILISTIC",
  /** An identifier resolved to more than one candidate event. Deliberately NOT attached. */
  "PENDING_REVIEW",
  /** No identifier, or no event in this archive corresponds to it. */
  "UNMATCHED",
] as const;

export type CircularAssociationMethod = (typeof CIRCULAR_ASSOCIATION_METHODS)[number];

export const eventCirculars = coreSchema.table(
  "event_circulars",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),

    /**
     * The canonical event. NULL means NOT ASSOCIATED — not "unknown event".
     * ON DELETE SET NULL: deleting an event must not destroy the
     * human-authored record that referred to it.
     */
    eventPk: bigint("event_pk", { mode: "bigint" })
      .references(() => events.id, { onDelete: "set null" }),

    /** Denormalised from the associated event. NULL exactly when eventPk is NULL. */
    labId: uuid("lab_id").references(() => labs.id),

    /**
     * GCN's own circular identifier, e.g. 35176.
     *
     * NUMERIC, not INTEGER. Seven circulars in the real archive carry ids that
     * are not positive integers: -1, -2, -3, -4 and 0 (pseudo-ids assigned when
     * 1997 circulars were added retroactively, one of them the first GRB with
     * an optical counterpart) and 18448.5, 18453.5 (fractional ids used to
     * insert a circular between two already numbered). An INTEGER column
     * silently discarded all seven. The id is never used for arithmetic.
     */
    circularId: numeric("circular_id", { mode: "number" }).notNull(),
    /** 1 for an original circular (GCN omits the field entirely), then 2, 3 … */
    version: integer("version").notNull().default(1),
    /** True for the highest version of this circularId. */
    isLatest: boolean("is_latest").notNull().default(true),

    /**
     * The eventId string exactly as GCN published it — "GRB 250101A",
     * "LIGO/Virgo S190510g", "IceCube-250302A". Never rewritten: this is what
     * a citation would quote.
     */
    gcnEventId: text("gcn_event_id"),
    /** Canonical form derived from gcnEventId (or the subject line), used for matching. */
    normalizedEventId: text("normalized_event_id"),

    subject: text("subject").notNull(),
    /**
     * The original circular text, verbatim and complete. The scientific source
     * of record — no AI summary may replace it.
     */
    body: text("body").notNull(),
    /**
     * "text/plain" | "text/markdown". NULL means GCN stated no format (85.7%
     * of the archive) and is NOT an assertion that the body is markdown.
     */
    bodyFormat: text("body_format"),

    submitter: text("submitter").notNull(),
    submittedHow: text("submitted_how"),
    bibcode: text("bibcode"),

    /** Publication time of the circular — NOT the trigger time of the event. */
    createdOn: timestamp("created_on", { withTimezone: true }).notNull(),
    editedOn: timestamp("edited_on", { withTimezone: true }),
    editedBy: text("edited_by"),

    gcnUrl: text("gcn_url"),

    associationMethod: text("association_method")
      .notNull()
      .default("UNMATCHED")
      .$type<CircularAssociationMethod>(),
    associationRationale: text("association_rationale"),
    /**
     * Best candidate for a PENDING_REVIEW / PROBABILISTIC circular. A separate
     * column from eventPk on purpose: recording a candidate must never make
     * the circular read as an established fact about that event.
     */
    candidateEventPk: bigint("candidate_event_pk", { mode: "bigint" })
      .references(() => events.id, { onDelete: "set null" }),
    associatedAt: timestamp("associated_at", { withTimezone: true }),

    /** The complete original GCN payload, so nothing unmodelled is lost. */
    rawPayload: jsonb("raw_payload").notNull().$type<Record<string, unknown>>(),

    /**
     * Deterministic, offline regex content triage from
     * astro-colibri-circular-parser's `build_regexp_hints` (Priority #5) —
     * booleans like `likely_redshift_report`, `matched_terms`,
     * `context_snippets`. Computed once in the Python GCN consumer alongside
     * the untouched payload above, never inside it.
     *
     * This is NOT an AI extraction and does not belong in
     * core.circular_extractions: it is plain regex over text already in
     * hand, with no model call and no event association, so a null value
     * here means "not computed" (parser unavailable, or the archive backfill
     * path, which does not run the Python hints step) — never "nothing
     * matched" for a circular that could not be checked.
     */
    regexpHints: jsonb("regexp_hints").$type<Record<string, unknown> | null>(),

    /** SHA-256 over subject + body. Drives the extraction cache. */
    contentHash: text("content_hash").notNull(),

    /** 'kafka' (live gcn.circulars) | 'archive' (historical backfill) */
    source: text("source").notNull().default("kafka"),

    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Idempotency, enforced by the database rather than an application-level
    // "have I seen this?" check that races with itself.
    uniqueIndex("event_circulars_identity_uniq").on(t.circularId, t.version),
    index("event_circulars_event_created_idx").on(t.eventPk, t.createdOn),
    index("event_circulars_circular_latest_idx").on(t.circularId, t.isLatest),
    index("event_circulars_normalized_idx").on(t.normalizedEventId),
    index("event_circulars_unassociated_idx").on(t.associationMethod, t.createdOn),
    index("event_circulars_lab_created_idx").on(t.labId, t.createdOn),
  ],
);

export type EventCircular = typeof eventCirculars.$inferSelect;
export type InsertEventCircular = typeof eventCirculars.$inferInsert;

// ─── core.event_aliases ──────────────────────────────────────────────────────

/**
 * Alternate renderings of an event identifier, used by association Level 2.
 *
 * NOT astrophysical aliases. Nothing here asserts that two differently-named
 * events are the same object — only that different GCN producers write the
 * same identifier differently ("LIGO/Virgo S190510g" vs "S190510g").
 */
export const eventAliases = coreSchema.table(
  "event_aliases",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    eventPk: bigint("event_pk", { mode: "bigint" })
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    /** Upper-cased, whitespace-stripped. */
    alias: text("alias").notNull(),
    /** CANONICAL | RENDERING | OPERATOR. Never a model-produced value. */
    aliasSource: text("alias_source").notNull().default("RENDERING"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One alias may not point at two events: that would make association
    // ambiguous by construction.
    uniqueIndex("event_aliases_alias_uniq").on(t.alias),
    index("event_aliases_event_idx").on(t.eventPk),
  ],
);

export type EventAlias = typeof eventAliases.$inferSelect;
export type InsertEventAlias = typeof eventAliases.$inferInsert;

// ─── core.circular_extractions ───────────────────────────────────────────────

export const CIRCULAR_EXTRACTION_STATUSES = [
  "pending",
  "processing",
  "completed",
  "failed",
] as const;

export type CircularExtractionStatus = (typeof CIRCULAR_EXTRACTION_STATUSES)[number];

/**
 * Why an attempt failed, and therefore whether retrying can help.
 *
 * `configuration` and `invalid_response` are not transient: retrying a missing
 * API key, or a model that cannot produce the schema, only burns quota.
 */
export const CIRCULAR_EXTRACTION_FAILURE_KINDS = [
  "transient",
  "rate_limit",
  "timeout",
  "invalid_response",
  "configuration",
] as const;

export type CircularExtractionFailureKind =
  (typeof CIRCULAR_EXTRACTION_FAILURE_KINDS)[number];

export const circularExtractions = coreSchema.table(
  "circular_extractions",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    circularPk: bigint("circular_pk", { mode: "bigint" })
      .notNull()
      .references(() => eventCirculars.id, { onDelete: "cascade" }),

    status: text("status").notNull().default("pending").$type<CircularExtractionStatus>(),
    attempts: integer("attempts").notNull().default(0),
    /** When this row becomes claimable again. NULL = immediately. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    failureKind: text("failure_kind").$type<CircularExtractionFailureKind | null>(),
    lastError: text("last_error"),

    /** Which model produced this, so a claim can be traced to its author. */
    provider: text("provider"),
    modelName: text("model_name"),
    schemaVersion: integer("schema_version").notNull(),
    promptVersion: integer("prompt_version").notNull(),
    /** SHA-256(subject+body+schemaVersion+promptVersion+model). */
    contentHash: text("content_hash").notNull(),

    /**
     * The schema-validated extraction. NULL until completed, and a null field
     * *inside* it means the circular did not state the quantity — never that
     * the quantity is zero.
     */
    extraction: jsonb("extraction").$type<Record<string, unknown> | null>(),
    extractedAt: timestamp("extracted_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("circular_extractions_cache_uniq").on(t.circularPk, t.contentHash),
    index("circular_extractions_due_idx").on(t.status, t.nextAttemptAt, t.createdAt),
    index("circular_extractions_circular_idx").on(t.circularPk, t.createdAt),
  ],
);

export type CircularExtraction = typeof circularExtractions.$inferSelect;
export type InsertCircularExtraction = typeof circularExtractions.$inferInsert;

// ─── Relations ───────────────────────────────────────────────────────────────

export const eventCircularsRelations = relations(eventCirculars, ({ one, many }) => ({
  event: one(events, { fields: [eventCirculars.eventPk], references: [events.id] }),
  lab: one(labs, { fields: [eventCirculars.labId], references: [labs.id] }),
  extractions: many(circularExtractions),
}));

export const eventAliasesRelations = relations(eventAliases, ({ one }) => ({
  event: one(events, { fields: [eventAliases.eventPk], references: [events.id] }),
}));

export const circularExtractionsRelations = relations(circularExtractions, ({ one }) => ({
  circular: one(eventCirculars, {
    fields: [circularExtractions.circularPk],
    references: [eventCirculars.id],
  }),
}));
