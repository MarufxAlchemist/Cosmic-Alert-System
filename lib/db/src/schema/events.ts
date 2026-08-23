import {
  pgSchema,
  bigserial,
  bigint,
  uuid,
  text,
  boolean,
  smallint,
  integer,
  real,
  doublePrecision,
  jsonb,
  timestamp,
  customType,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { labs } from "./tenant.js";
import { observatories } from "./catalog.js";
import { users } from "./identity.js";

export const coreSchema = pgSchema("core");

// ─── Custom types ────────────────────────────────────────────────────────────

/**
 * pgvector vector type — stored as FLOAT4[] internally.
 * HNSW index is defined via raw migration SQL.
 */
const vector = customType<{ data: number[]; driverData: string; config: { dimensions: number } }>({
  dataType(config) {
    return `vector(${config?.dimensions ?? 1536})`;
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return value
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .split(",")
      .map(Number);
  },
});

/**
 * PostGIS geography(POINT, 4326) — spatial column for cone search.
 * GiST index is defined via raw migration SQL.
 */
const geographyPoint = customType<{ data: string }>({
  dataType() {
    return "text";
  },
});

/**
 * ltree — hierarchical label path for localization lineage.
 * Requires the ltree extension (CREATE EXTENSION IF NOT EXISTS ltree).
 */
const ltree = customType<{ data: string }>({
  dataType() {
    return "ltree";
  },
});

// ─── core.events ─────────────────────────────────────────────────────────────

export const events = coreSchema.table("events", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  labId: uuid("lab_id").notNull().references(() => labs.id),
  eventId: text("event_id").notNull(),
  eventType: text("event_type").notNull(),
  detectionTime: timestamp("detection_time", { withTimezone: true }).notNull(),
  // OBSERVED source measurements. NULL means the upstream notice did not
  // report the quantity — never zero. (0,0) is a valid sky position, so a
  // placeholder here is indistinguishable from a real measurement; see
  // migration 0011.
  ra: doublePrecision("ra"),
  dec: doublePrecision("dec"),
  // skyPosition computed via trigger in migration: ST_MakePoint(ra, dec)::geography
  skyPosition: geographyPoint("sky_position"),
  errorRadius: doublePrecision("error_radius"),
  /**
   * What `errorRadius` contains — 1SIGMA_1D | 1SIGMA_2D | 50_2D | 68_2D |
   * 90_2D | 95_2D. NULL means the source did not state it, which is NOT the
   * same as 1-sigma: for a 2-D Gaussian a 90% containment radius is 2.15x the
   * 1-sigma radius, so the convention is never assumed. See migration 0014.
   */
  errorRadiusContainment: text("error_radius_containment"),
  /** 50% credible sky area [deg^2]. An area — not a radius. */
  area50Deg2: doublePrecision("area_50_deg2"),
  /** 90% credible sky area [deg^2]. An area — not a radius. */
  area90Deg2: doublePrecision("area_90_deg2"),
  snr: doublePrecision("snr"),
  far: doublePrecision("far"),
  /** IceCube signalness: P(astrophysical) in [0,1]. NOT an SNR. */
  signalness: doublePrecision("signalness"),
  // GRB-specific
  fluence: doublePrecision("fluence"),
  fluenceBand: text("fluence_band"),
  t90: doublePrecision("t90"),
  // FRB-specific
  dm: doublePrecision("dm"),
  peakFlux: doublePrecision("peak_flux"),
  // GW-specific
  chirpMass: doublePrecision("chirp_mass"),
  luminosityDistance: doublePrecision("luminosity_distance"),
  /** 1-sigma uncertainty on luminosityDistance [Mpc]. GW posteriors are broad. */
  luminosityDistanceError: doublePrecision("luminosity_distance_error"),
  // Celestial geometry
  // DERIVED sky geometry — computed from (ra, dec, detectionTime), not measured.
  // NULL means "could not be responsibly derived", never zero or a typical value.
  galLat: doublePrecision("gal_lat"),
  galLon: doublePrecision("gal_lon"),
  sunDistance: doublePrecision("sun_distance"),
  moonDistance: doublePrecision("moon_distance"),
  redshift: doublePrecision("redshift"),
  /** 1-sigma uncertainty on redshift, propagated into rest-frame quantities. */
  redshiftError: doublePrecision("redshift_error"),
  // ── Derived science (Phase 5) ────────────────────────────────────────────
  /**
   * Derived quantities with their method, inputs, assumptions, propagated
   * uncertainty and provenance: rest-frame T90/Epeak, luminosity distance,
   * band-limited E_iso (stamped with the cosmology used), credible-region
   * geometry and observability. An underivable quantity is stored as UNKNOWN
   * with the reason it could not be derived — never omitted, never guessed.
   */
  derived: jsonb("derived").$type<Record<string, unknown> | null>(),
  // ── Scientific validation (Phase 3) ──────────────────────────────────────
  /** Validation report: {status, worstLevel, counts, diagnostics[]}. */
  validation: jsonb("validation").$type<Record<string, unknown> | null>(),
  /** Transparent quality assessment with per-component deductions. */
  quality: jsonb("quality").$type<Record<string, unknown> | null>(),
  /** Overall quality 0-100, denormalised for indexing/sorting. */
  qualityScore: smallint("quality_score"),
  /** PASS | WARNING | FAIL, denormalised for filtering. */
  validationStatus: text("validation_status"),
  // ── Research interest (Phase 7, spec section 44) ──────────────────────────
  /**
   * Per-rule contributions with rationales, plus quantities that could not be
   * assessed. A triage heuristic for ordering a queue — NOT a measured
   * property of the event, and deliberately distinct from `quality` (is the
   * data trustworthy?) and notification priority (is it urgent?).
   */
  researchInterest: jsonb("research_interest").$type<Record<string, unknown> | null>(),
  /** 0-100 research interest, denormalised for sorting. */
  interestScore: smallint("interest_score"),
  // System fields
  /**
   * MEASURED ingestion latency (microseconds from detectionTime to receipt).
   * NULL = not measurable — e.g. archive imports, which were never received
   * live. Declared `bigint`, NOT `bigserial`: this is a measurement, and a
   * serial would hand any INSERT that omits it an auto-incrementing counter
   * (1, 2, 3 …) to display as a latency. See migration 0017.
   */
  latencyUs: bigint("latency_us", { mode: "bigint" }),
  sourceCatalogId: text("source_catalog_id"),
  gcnUrl: text("gcn_url"),
  status: text("status").notNull().default("preliminary"),
  // Alert filtering metadata
  /** Normalized lifecycle state: preliminary | initial | update | confirmed */
  lifecycle: text("lifecycle").notNull().default("preliminary"),
  /** Raw alert_type string from the originating source (e.g. "PRELIMINARY", "RETRACTION") */
  alertType: text("alert_type"),
  /** IceCube classification tier: GOLD or BRONZE */
  classificationTier: text("classification_tier"),
  /** Source observatory / instrument name (e.g. "Swift", "LIGO-Hanford") */
  observatory: text("observatory").notNull().default("Unknown"),
  /** True when this alert is a retraction of a prior event */
  isRetraction: boolean("is_retraction").notNull().default(false),
  /** Origin of this row: 'kafka' (live GCN alert) | 'bootstrap' (seed from recent_events.json) */
  source: text("source").notNull().default("kafka"),
  /** True for rows inserted by the startup bootstrap — never overwritten by Kafka upserts */
  isHistorical: boolean("is_historical").notNull().default(false),
  /** How many times this row has been updated by a newer notice (0 = first notice only) */
  revisionCount: integer("revision_count").notNull().default(0),
  /** alert_type of the most-recently processed notice (e.g. "INITIAL", "UPDATE") */
  latestRevision: text("latest_revision"),
  ingestedBy: uuid("ingested_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AstroEvent = typeof events.$inferSelect;
export type InsertAstroEvent = typeof events.$inferInsert;

// ─── core.event_detections (TimescaleDB hypertable) ──────────────────────────

export const eventDetections = coreSchema.table("event_detections", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  eventId: bigserial("event_id", { mode: "bigint" }).notNull()
    .references(() => events.id),
  labId: uuid("lab_id").notNull().references(() => labs.id),
  observatoryId: bigserial("observatory_id", { mode: "bigint" }).notNull()
    .references(() => observatories.id),
  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),  // Hypertable key
  ra: doublePrecision("ra").notNull(),
  dec: doublePrecision("dec").notNull(),
  errorRadius: doublePrecision("error_radius").notNull(),
  snr: doublePrecision("snr").notNull(),
  far: doublePrecision("far").notNull(),
  pipelineVersion: text("pipeline_version"),
  rawPayload: jsonb("raw_payload").notNull().$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type EventDetection = typeof eventDetections.$inferSelect;
export type InsertEventDetection = typeof eventDetections.$inferInsert;

// ─── core.event_localizations ────────────────────────────────────────────────

export const eventLocalizations = coreSchema.table("event_localizations", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  eventId: bigserial("event_id", { mode: "bigint" }).notNull()
    .references(() => events.id),
  labId: uuid("lab_id").notNull().references(() => labs.id),
  method: text("method").notNull(),
  version: integer("version").notNull().default(1),
  fitsUrl: text("fits_url").notNull(),
  nside: integer("nside"),
  area50Deg2: real("area_50_deg2"),
  area90Deg2: real("area_90_deg2"),
  vol50Mpc3: doublePrecision("vol_50_mpc3"),
  vol90Mpc3: doublePrecision("vol_90_mpc3"),
  hasNsProb: real("has_ns_prob"),
  lineage: ltree("lineage"),
  isLatest: boolean("is_latest").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type EventLocalization = typeof eventLocalizations.$inferSelect;
export type InsertEventLocalization = typeof eventLocalizations.$inferInsert;

// ─── core.event_classifications ──────────────────────────────────────────────

export const eventClassifications = coreSchema.table("event_classifications", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  eventId: bigserial("event_id", { mode: "bigint" }).notNull()
    .references(() => events.id),
  labId: uuid("lab_id").notNull().references(() => labs.id),
  classifier: text("classifier").notNull().default("gstlal"),
  version: integer("version").notNull().default(1),
  probBns: real("prob_bns"),
  probNsbh: real("prob_nsbh"),
  probBbh: real("prob_bbh"),
  probMassGap: real("prob_mass_gap"),
  probTerrestrial: real("prob_terrestrial"),
  hasNs: boolean("has_ns"),
  hasRemnant: boolean("has_remnant"),
  isLatest: boolean("is_latest").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type EventClassification = typeof eventClassifications.$inferSelect;
export type InsertEventClassification = typeof eventClassifications.$inferInsert;

// ─── core.event_followup_requests ────────────────────────────────────────────

export const eventFollowupRequests = coreSchema.table("event_followup_requests", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  labId: uuid("lab_id").notNull().references(() => labs.id),
  eventId: bigserial("event_id", { mode: "bigint" }).notNull()
    .references(() => events.id),
  observatoryId: bigserial("observatory_id", { mode: "bigint" }).notNull()
    .references(() => observatories.id),
  requestedBy: uuid("requested_by").notNull().references(() => users.id),
  priority: text("priority").notNull().default("normal"),
  status: text("status").notNull().default("pending"),
  exposureTimeS: real("exposure_time_s"),
  filterBand: text("filter_band"),
  notes: text("notes"),
  responseNotes: text("response_notes"),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  respondedAt: timestamp("responded_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});

export type EventFollowupRequest = typeof eventFollowupRequests.$inferSelect;
export type InsertEventFollowupRequest = typeof eventFollowupRequests.$inferInsert;

// ─── core.event_annotations ──────────────────────────────────────────────────

export const eventAnnotations = coreSchema.table("event_annotations", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  labId: uuid("lab_id").notNull().references(() => labs.id),
  eventId: bigserial("event_id", { mode: "bigint" }).notNull()
    .references(() => events.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  parentId: bigserial("parent_id", { mode: "bigint" })
    .references((): any => eventAnnotations.id),
  content: text("content").notNull(),
  tags: text("tags").array().notNull().default([]),
  isPinned: boolean("is_pinned").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export type EventAnnotation = typeof eventAnnotations.$inferSelect;
export type InsertEventAnnotation = typeof eventAnnotations.$inferInsert;

// ─── core.event_embeddings (pgvector) ────────────────────────────────────────

export const eventEmbeddings = coreSchema.table("event_embeddings", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  eventId: bigserial("event_id", { mode: "bigint" }).notNull().unique()
    .references(() => events.id),
  labId: uuid("lab_id").notNull().references(() => labs.id),
  modelName: text("model_name").notNull(),
  modelVersion: text("model_version").notNull(),
  // 1536-dim vector — HNSW index defined via raw migration SQL:
  //   CREATE INDEX ON core.event_embeddings USING hnsw (embedding vector_cosine_ops)
  //   WITH (m = 16, ef_construction = 64);
  embedding: text("embedding").notNull(),
  inputFeatures: text("input_features").array().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type EventEmbedding = typeof eventEmbeddings.$inferSelect;
export type InsertEventEmbedding = typeof eventEmbeddings.$inferInsert;

// ─── core.ai_correlation_analysis ────────────────────────────────────────────

export const aiCorrelationAnalysis = coreSchema.table("ai_correlation_analysis", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  eventId: bigserial("event_id", { mode: "bigint" }).notNull()
    .references(() => events.id, { onDelete: "cascade" }),
  correlationHash: text("correlation_hash").notNull(),
  modelName: text("model_name").notNull().default("gemini-2.5-flash"),
  analysisJson: jsonb("analysis_json").notNull().$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AiCorrelationAnalysis = typeof aiCorrelationAnalysis.$inferSelect;
export type InsertAiCorrelationAnalysis = typeof aiCorrelationAnalysis.$inferInsert;

// ─── core.ai_scientific_summaries ────────────────────────────────────────────

export const aiScientificSummaries = coreSchema.table("ai_scientific_summaries", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  eventId: bigserial("event_id", { mode: "bigint" }).notNull()
    .references(() => events.id, { onDelete: "cascade" }),
  metadataHash: text("metadata_hash").notNull(),
  modelName: text("model_name").notNull().default("gemini-2.5-flash"),
  summaryJson: jsonb("summary_json").notNull().$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AiScientificSummary = typeof aiScientificSummaries.$inferSelect;
export type InsertAiScientificSummary = typeof aiScientificSummaries.$inferInsert;

// ─── core.event_correlations ─────────────────────────────────────────────────
//
// Persisted output of the Multi-Messenger Correlation Engine (Phase 6.0A).
// One row per (primary_event, candidate_event) pair with confidence ≠ NONE.
// Written by science/correlationEngine/repository.ts.
// Read by GET /events/:id/correlations and GET /correlations/recent.
//
// Index: (primary_event_id)            — for per-event lookups
// Index: (confidence, computed_at DESC) — for dashboard high-confidence feed
// Unique: (primary_event_id, candidate_event_id) — prevents duplicates; safe upsert

export const eventCorrelations = coreSchema.table(
  "event_correlations",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    /** Internal DB id of the primary (triggering) event */
    primaryEventId:   bigserial("primary_event_id", { mode: "bigint" }).notNull()
                        .references(() => events.id, { onDelete: "cascade" }),
    /** Internal DB id of the correlated candidate event */
    candidateEventId: bigserial("candidate_event_id", { mode: "bigint" }).notNull()
                        .references(() => events.id, { onDelete: "cascade" }),
    /** Confidence tier: HIGH | MEDIUM | LOW */
    confidence:      text("confidence").notNull().default("NONE"),
    /** Aggregate score [0–100] */
    score:           integer("score").notNull().default(0),
    /** Signed time difference [seconds]: positive = candidate is later */
    deltaTimeSec:    doublePrecision("delta_t_sec").notNull().default(0),
    /** Angular separation between the two sky positions [degrees] */
    angularSepDeg:   doublePrecision("angular_sep_deg").notNull().default(0),
    /** Physical nature of the pairing: multi_messenger | cross_detection | speculative */
    correlationType: text("correlation_type").notNull().default("speculative"),
    /** Human-readable reasoning string from the engine */
    reasoning:       text("reasoning"),
    /** When this result was computed (or last updated) */
    computedAt:      timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("event_correlations_primary_idx").on(t.primaryEventId),
    index("event_correlations_confidence_idx").on(t.confidence, t.computedAt),
  ],
);

export type EventCorrelation = typeof eventCorrelations.$inferSelect;
export type InsertEventCorrelation = typeof eventCorrelations.$inferInsert;

// ─── Relations ───────────────────────────────────────────────────────────────

export const eventsRelations = relations(events, ({ one, many }) => ({
  lab: one(labs, { fields: [events.labId], references: [labs.id] }),
  ingestedByUser: one(users, { fields: [events.ingestedBy], references: [users.id] }),
  detections: many(eventDetections),
  localizations: many(eventLocalizations),
  classifications: many(eventClassifications),
  followupRequests: many(eventFollowupRequests),
  annotations: many(eventAnnotations),
  embedding: many(eventEmbeddings),
  aiSummaries: many(aiScientificSummaries),
  correlationsAsPrimary: many(eventCorrelations, { relationName: "primary" }),
  correlationsAsCandidate: many(eventCorrelations, { relationName: "candidate" }),
}));

export const eventDetectionsRelations = relations(eventDetections, ({ one }) => ({
  event: one(events, { fields: [eventDetections.eventId], references: [events.id] }),
  lab: one(labs, { fields: [eventDetections.labId], references: [labs.id] }),
  observatory: one(observatories, { fields: [eventDetections.observatoryId], references: [observatories.id] }),
}));

export const eventLocalizationsRelations = relations(eventLocalizations, ({ one }) => ({
  event: one(events, { fields: [eventLocalizations.eventId], references: [events.id] }),
  lab: one(labs, { fields: [eventLocalizations.labId], references: [labs.id] }),
}));

export const eventClassificationsRelations = relations(eventClassifications, ({ one }) => ({
  event: one(events, { fields: [eventClassifications.eventId], references: [events.id] }),
  lab: one(labs, { fields: [eventClassifications.labId], references: [labs.id] }),
}));

export const eventFollowupRequestsRelations = relations(eventFollowupRequests, ({ one }) => ({
  event: one(events, { fields: [eventFollowupRequests.eventId], references: [events.id] }),
  lab: one(labs, { fields: [eventFollowupRequests.labId], references: [labs.id] }),
  observatory: one(observatories, { fields: [eventFollowupRequests.observatoryId], references: [observatories.id] }),
  requestedByUser: one(users, { fields: [eventFollowupRequests.requestedBy], references: [users.id] }),
}));

export const eventAnnotationsRelations = relations(eventAnnotations, ({ one, many }) => ({
  event: one(events, { fields: [eventAnnotations.eventId], references: [events.id] }),
  lab: one(labs, { fields: [eventAnnotations.labId], references: [labs.id] }),
  user: one(users, { fields: [eventAnnotations.userId], references: [users.id] }),
  parent: one(eventAnnotations, { fields: [eventAnnotations.parentId], references: [eventAnnotations.id] }),
  replies: many(eventAnnotations),
}));

export const eventEmbeddingsRelations = relations(eventEmbeddings, ({ one }) => ({
  event: one(events, { fields: [eventEmbeddings.eventId], references: [events.id] }),
  lab: one(labs, { fields: [eventEmbeddings.labId], references: [labs.id] }),
}));

export const aiCorrelationAnalysisRelations = relations(aiCorrelationAnalysis, ({ one }) => ({
  event: one(events, { fields: [aiCorrelationAnalysis.eventId], references: [events.id] }),
}));

export const aiScientificSummariesRelations = relations(aiScientificSummaries, ({ one }) => ({
  event: one(events, { fields: [aiScientificSummaries.eventId], references: [events.id] }),
}));

// ─── core.event_value_provenance ─────────────────────────────────────────────
//
// Per-value scientific audit trail (migration 0012). One row per
// (event, parameter) for any quantity that was not read straight off the
// source notice — DERIVED, INFERRED, or CATALOG.
//
// Kept as a side table rather than widening core.events: provenance is sparse
// and append-mostly, and only a few parameters per event carry it.

export const eventValueProvenance = coreSchema.table(
  "event_value_provenance",
  {
    id:      bigserial("id", { mode: "bigint" }).primaryKey(),
    eventId: bigint("event_id", { mode: "bigint" }).notNull()
               .references(() => events.id, { onDelete: "cascade" }),
    /** Column on core.events this describes, e.g. "sun_distance". */
    parameter:    text("parameter").notNull(),
    /** OBSERVED | DERIVED | INFERRED | CATALOG | UNKNOWN */
    source:       text("source").notNull(),
    /** MEASURED | CALCULATED | MODEL_DEPENDENT | LIMITED | UNKNOWN */
    confidence:   text("confidence"),
    /** VALID | SUSPICIOUS | INVALID | MISSING */
    quality:      text("quality").notNull().default("VALID"),
    unit:         text("unit"),
    uncertainty:  doublePrecision("uncertainty"),
    /** How it was produced, e.g. "astropy GCRS separation via get_body". */
    method:       text("method"),
    /** Source fields that fed the calculation. */
    inputFields:  text("input_fields").array().notNull().default([]),
    /** Library/version for reproducibility, e.g. "astropy 6.1.4". */
    software:     text("software"),
    /** Model/cosmology assumptions. Empty for purely geometric results. */
    assumptions:  text("assumptions").array().notNull().default([]),
    calculatedAt: timestamp("calculated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("event_value_provenance_event_idx").on(t.eventId),
    index("event_value_provenance_param_idx").on(t.parameter, t.source),
  ],
);

export type EventValueProvenance = typeof eventValueProvenance.$inferSelect;
export type InsertEventValueProvenance = typeof eventValueProvenance.$inferInsert;


// ─── core.event_revisions ────────────────────────────────────────────────────
//
// Append-only history of every notice received for an event (Phase 6, spec
// sections 27-28).
//
// Revisions were previously applied by an UPSERT that overwrote core.events in
// place, destroying the prior scientific state: a localization that moved 40
// degrees between notices left no trace. This table records each notice's
// snapshot plus the computed delta against its predecessor, so the change is
// visible rather than silently applied.
//
// Rows are never updated — a correction arrives as a new revision.

export const eventRevisions = coreSchema.table(
  "event_revisions",
  {
    id:            bigserial("id", { mode: "bigint" }).primaryKey(),
    eventPk:       bigint("event_pk", { mode: "bigint" })
                     .notNull()
                     .references(() => events.id, { onDelete: "cascade" }),
    /** GCN string id, denormalised so history is queryable without a join. */
    eventId:       text("event_id").notNull(),
    /** 0 for the first notice, then monotonically increasing. */
    revisionIndex: integer("revision_index").notNull(),
    /** PRELIMINARY | INITIAL | UPDATE | RETRACTION, as reported. */
    alertType:     text("alert_type"),
    lifecycle:     text("lifecycle"),
    isRetraction:  boolean("is_retraction").notNull().default(false),
    /** Scientific state per this notice. A missing key means UNKNOWN. */
    snapshot:      jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    /** compare_revisions() output vs the previous revision; null on the first. */
    delta:         jsonb("delta").$type<Record<string, unknown> | null>(),
    /** NONE | ROUTINE | NOTABLE | CRITICAL. */
    significance:  text("significance"),
    receivedAt:    timestamp("received_at", { withTimezone: true })
                     .notNull()
                     .defaultNow(),
  },
  (t) => [
    index("event_revisions_event_id_received_idx").on(t.eventId, t.receivedAt),
    index("event_revisions_significance_idx").on(t.significance, t.receivedAt),
  ],
);

export type EventRevision = typeof eventRevisions.$inferSelect;
export type InsertEventRevision = typeof eventRevisions.$inferInsert;
