import { Router } from "express";
import { createHash } from "node:crypto";
import { db, eventsTable, eventLocalizations, aiCorrelationAnalysis, eventRevisions } from "@workspace/db";
import { desc, eq, and, inArray, sql } from "drizzle-orm";
import { ListEventsQueryParams, GetEventParams } from "@workspace/api-zod";
import { CorrelationAgent, type CorrelationAnalysisResult } from "../services/ai/correlation-agent.js";
import { createDefaultProvider } from "../services/ai/provider.js";
import { logger } from "../lib/logger.js";
import { EVENT_GROUPS, findGroup, groupedTypes } from "../lib/eventGroups.js";

const router = Router();

// ─── Lazy provider singleton ──────────────────────────────────────────────────
// Instantiated on first analysis request, reused for all subsequent ones.
// Avoids re-reading env vars and re-constructing the SDK client per request.
let _agent: CorrelationAgent | null = null;

function getAgent(): CorrelationAgent {
  if (!_agent) {
    _agent = new CorrelationAgent(createDefaultProvider());
  }
  return _agent;
}

// ─── Event formatter ──────────────────────────────────────────────────────────

function formatEvent(row: typeof eventsTable.$inferSelect) {
  return {
    id: String(row.id),
    eventId: row.eventId,
    eventType: row.eventType,
    observatory: row.observatory ?? "Unknown",
    detectionTime: row.detectionTime.toISOString(),
    ra: row.ra,
    dec: row.dec,
    errorRadius: row.errorRadius,
    // Localization semantics (spec section 23): a radius is not interpretable
    // without knowing what fraction it contains, so the convention travels
    // with it. undefined here means the source never stated it.
    errorRadiusContainment: row.errorRadiusContainment ?? undefined,
    area50Deg2: row.area50Deg2 ?? undefined,
    area90Deg2: row.area90Deg2 ?? undefined,
    snr: row.snr,
    far: row.far,
    fluence: row.fluence ?? undefined,
    dm: row.dm ?? undefined,
    t90: row.t90 ?? undefined,
    peakFlux: row.peakFlux ?? undefined,
    chirpMass: row.chirpMass ?? undefined,
    luminosityDistance: row.luminosityDistance ?? undefined,
    luminosityDistanceError: row.luminosityDistanceError ?? undefined,
    redshift: row.redshift ?? undefined,
    redshiftError: row.redshiftError ?? undefined,
    galLat: row.galLat,
    galLon: row.galLon,
    sunDistance: row.sunDistance,
    moonDistance: row.moonDistance,
    // bigint is serialised as a string; null must survive as null rather than
    // becoming the string "null".
    latencyUs: row.latencyUs != null ? String(row.latencyUs) : null,
    createdAt: row.createdAt.toISOString(),
    lifecycle: (row.lifecycle ?? "preliminary") as "preliminary" | "initial" | "update" | "confirmed",
    alertType: row.alertType ?? undefined,
    classificationTier: (row.classificationTier ?? undefined) as "GOLD" | "BRONZE" | undefined,
    isHistorical: row.isHistorical ?? false,
    source: row.source ?? "kafka",
    signalness: row.signalness ?? undefined,
    validation: row.validation ?? undefined,
    quality: row.quality ?? undefined,
    qualityScore: row.qualityScore ?? undefined,
    validationStatus: row.validationStatus ?? undefined,
    // Derived quantities with their method, assumptions, propagated
    // uncertainty and the cosmology stamp (spec sections 19-24, 33-34).
    derived: row.derived ?? undefined,
    // Research interest (spec section 44). Distinct from qualityScore: one
    // asks whether the data is trustworthy, the other whether the event is
    // worth studying.
    researchInterest: row.researchInterest ?? undefined,
    interestScore: row.interestScore ?? undefined,
  };
}

// ─── GET /events ──────────────────────────────────────────────────────────────

router.get("/events", async (req, res) => {
  // `eventType` is validated HERE, not by ListEventsQueryParams.
  //
  // That schema is generated from openapi.yaml, where the enum is still
  // [GRB, GW, FRB]. The database holds EP, NU and OTHER as well, so letting the
  // generated enum gate this filter makes 66 of 305 events unfilterable and
  // returns "Invalid query params" for a perfectly real event type. Stripping
  // it before the parse keeps limit/offset validation while letting the actual
  // archive decide which types exist.
  const { eventType: rawEventType, ...restQuery } = req.query as Record<string, unknown>;

  const parsed = ListEventsQueryParams.safeParse(restQuery);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query params" });
    return;
  }

  const { limit = 50, offset = 0, observatory } = parsed.data;

  let eventType: string | undefined;
  if (typeof rawEventType === "string" && rawEventType !== "") {
    const t = rawEventType.trim().toUpperCase();
    // Any type the taxonomy accounts for. An unknown one is rejected rather
    // than silently ignored, which would return the whole archive and look
    // like an answer.
    if (!groupedTypes().has(t)) {
      res.status(400).json({
        error: `Unknown eventType "${rawEventType}". Known types: ${[...groupedTypes()].sort().join(", ")}`,
      });
      return;
    }
    eventType = t;
  }

  const conditions = [];

  // ── Group filter ─────────────────────────────────────────────────────────
  // `group` selects a whole messenger category, expanding server-side to the
  // event_type values it spans (see lib/eventGroups.ts). This exists because
  // `eventType` alone cannot express the archive: its generated enum is
  // [GRB, GW, FRB], so EP, NU and OTHER events — 66 of 305 here — were
  // unreachable by any filter the client could send.
  //
  // Read straight off req.query: ListEventsQueryParams does not model it, and
  // Zod strips unknown keys rather than rejecting them.
  const rawGroup = req.query["group"];
  if (typeof rawGroup === "string" && rawGroup !== "") {
    const group = findGroup(rawGroup);
    if (!group) {
      res.status(400).json({
        error: `Unknown group "${rawGroup}". Valid groups: ${EVENT_GROUPS.map((g) => g.key).join(", ")}`,
      });
      return;
    }
    conditions.push(inArray(eventsTable.eventType, [...group.memberTypes]));
  }

  // Narrow within a group to one underlying event_type, so a scientist can
  // separate Einstein Probe rows from GRB rows without losing the group view.
  if (eventType) conditions.push(eq(eventsTable.eventType, eventType));

  // ── Observatory filter ───────────────────────────────────────────────────
  // Previously parsed and then never applied: selecting "Swift" returned the
  // entire archive unfiltered, which is worse than having no filter at all
  // because the result looks like an answer.
  //
  // Substring, case-insensitive, on purpose. Stored values carry the
  // instrument — "Swift (BAT)", "Fermi (GBM)", "Einstein Probe (WXT)",
  // "LIGO (H1,L1)" — so equality against a mission name matches nothing.
  if (typeof observatory === "string" && observatory !== "") {
    conditions.push(sql`${eventsTable.observatory} ILIKE ${"%" + observatory + "%"}`);
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [events, countResult] = await Promise.all([
    db
      .select()
      .from(eventsTable)
      .where(whereClause)
      .orderBy(desc(eventsTable.detectionTime))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(eventsTable)
      .where(whereClause),
  ]);

  res.json({
    events: events.map(formatEvent),
    total: Number(countResult[0]?.count ?? 0),
  });
});

// ─── GET /events/stats ────────────────────────────────────────────────────────

router.get("/events/stats", async (req, res) => {
  const [totalResult, byTypeResult, byObservatoryResult, recentResult, latestResult] =
    await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(eventsTable),
      db
        .select({ eventType: eventsTable.eventType, count: sql<number>`count(*)::int` })
        .from(eventsTable)
        .groupBy(eventsTable.eventType),
      db
        .select({ observatory: eventsTable.observatory, count: sql<number>`count(*)::int` })
        .from(eventsTable)
        .groupBy(eventsTable.observatory)
        .orderBy(desc(sql`count(*)`)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(eventsTable)
        .where(sql`created_at > now() - interval '1 hour'`),
      db.select().from(eventsTable).orderBy(desc(eventsTable.detectionTime)).limit(1),
    ]);

  const byType: Record<string, number> = {};
  for (const row of byTypeResult) byType[row.eventType] = Number(row.count);

  res.json({
    totalEvents: Number(totalResult[0]?.count ?? 0),
    byType,
    byObservatory: byObservatoryResult.map((r) => ({
      observatory: r.observatory ?? "Unknown",
      count: Number(r.count),
    })),
    recentRate: Number(recentResult[0]?.count ?? 0),
    latestEvent: latestResult[0] ? formatEvent(latestResult[0]) : null,
  });
});

// ─── GET /events/groups ──────────────────────────────────────────────────────
//
// The archive's browsable messenger categories, with EXACT ARCHIVE-WIDE counts.
//
// Registered before /:id so Express does not consume "groups" as an id.
//
// The counts here are the whole archive, not a page. The previous grouping was
// computed in the browser over whichever 24 events happened to be on screen, so
// its "8 on this page" could not be used to reason about coverage. A count that
// changes when you turn the page is not a category count.
//
// `byType` is returned alongside `count` so a group that spans several
// event_type labels shows its composition rather than merging them silently.
//
// `ungrouped` reports event_type values present in the database that belong to
// no group. It should always be empty; if it is not, those events exist and are
// invisible in the archive, and the taxonomy in lib/eventGroups.ts needs a new
// entry. Reporting it is what stops that failing silently.

router.get("/events/groups", async (_req, res) => {
  try {
    const rows = await db
      .select({
        eventType: eventsTable.eventType,
        count: sql<number>`count(*)::int`,
        // The outer column is written out in full, NOT interpolated as
        // ${eventsTable.id}. Drizzle renders that as a bare "id", and inside
        // this correlated subquery Postgres resolves a bare "id" against the
        // INNER table — core.event_circulars also has an id — so the predicate
        // silently becomes c.event_pk = c.id and every count comes back 0.
        // No error, just plausible-looking zeros.
        withCirculars: sql<number>`count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM core.event_circulars c WHERE c.event_pk = "core"."events"."id"
        ))::int`,
      })
      .from(eventsTable)
      .groupBy(eventsTable.eventType);

    const byType = new Map(
      rows.map((r) => [r.eventType, { count: Number(r.count), withCirculars: Number(r.withCirculars) }]),
    );

    const groups = EVENT_GROUPS.map((g) => {
      const parts = g.memberTypes.map((t) => ({
        eventType: t,
        count: byType.get(t)?.count ?? 0,
        withCirculars: byType.get(t)?.withCirculars ?? 0,
      }));
      return {
        key: g.key,
        label: g.label,
        description: g.description,
        note: g.note ?? null,
        memberTypes: g.memberTypes,
        count: parts.reduce((a, p) => a + p.count, 0),
        /** How many carry at least one GCN Circular — i.e. have a human-written history. */
        withCirculars: parts.reduce((a, p) => a + p.withCirculars, 0),
        byType: parts,
      };
    });

    const known = groupedTypes();
    const ungrouped = rows
      .filter((r) => !known.has(r.eventType))
      .map((r) => ({ eventType: r.eventType, count: Number(r.count) }));

    if (ungrouped.length > 0) {
      logger.warn(
        { ungrouped },
        "[events] event_type values belong to no archive group — these events are not browsable",
      );
    }

    res.json({
      totalEvents: groups.reduce((a, g) => a + g.count, 0),
      groups,
      ungrouped,
    });
  } catch (err) {
    logger.error({ err }, "[events] GET /events/groups failed");
    res.status(500).json({ error: "Could not load event groups" });
  }
});

// ─── GET /events/:id/localizations ───────────────────────────────────────────
// Registered before /:id to prevent Express consuming "localizations" as :id.

router.get("/events/:id/localizations", async (req, res) => {
  const id = parseInt(req.params["id"] ?? "", 10);
  if (isNaN(id) || id <= 0) {
    res.status(400).json({ error: "Invalid event ID — must be a positive integer" });
    return;
  }

  const rows = await db
    .select()
    .from(eventLocalizations)
    .where(eq(eventLocalizations.eventId, BigInt(id)))
    .orderBy(desc(eventLocalizations.version));

  res.json(
    rows.map((loc) => ({
      id:         String(loc.id),
      eventId:    String(loc.eventId),
      fitsUrl:    loc.fitsUrl,
      method:     loc.method,
      version:    loc.version,
      isLatest:   loc.isLatest,
      nside:      loc.nside      ?? undefined,
      area50Deg2: loc.area50Deg2 ?? undefined,
      area90Deg2: loc.area90Deg2 ?? undefined,
      vol50Mpc3:  loc.vol50Mpc3  ?? undefined,
      vol90Mpc3:  loc.vol90Mpc3  ?? undefined,
      hasNsProb:  loc.hasNsProb  ?? undefined,
      createdAt:  loc.createdAt.toISOString(),
    }))
  );
});

// ─── GET /events/:id/revisions ───────────────────────────────────────────────
//
// The append-only history of every notice received for this event, newest
// first, with the scientific delta each one carried (Phase 6, spec 27-28).
//
// Registered before /:id so Express does not consume "revisions" as :id.
//
// `significance: null` on a revision means the delta could not be computed —
// it does NOT mean the revision carried no scientific change, and the client
// must render the two differently.

router.get("/events/:id/revisions", async (req, res) => {
  const parsed = GetEventParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid params" });
    return;
  }

  const id = parseInt(parsed.data.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "ID must be numeric" });
    return;
  }

  const rows = await db
    .select()
    .from(eventRevisions)
    .where(eq(eventRevisions.eventPk, BigInt(id)))
    .orderBy(desc(eventRevisions.revisionIndex));

  res.json(
    rows.map((r) => ({
      id: String(r.id),
      eventId: r.eventId,
      revisionIndex: r.revisionIndex,
      alertType: r.alertType ?? undefined,
      lifecycle: r.lifecycle ?? undefined,
      isRetraction: r.isRetraction,
      snapshot: r.snapshot,
      delta: r.delta ?? undefined,
      significance: r.significance ?? null,
      receivedAt: r.receivedAt.toISOString(),
    }))
  );
});

// ─── GET /events/:id ─────────────────────────────────────────────────────────

router.get("/events/:id", async (req, res) => {
  const parsed = GetEventParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid params" });
    return;
  }

  const id = parseInt(parsed.data.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "ID must be numeric" });
    return;
  }

  const [row] = await db
    .select()
    .from(eventsTable)
    .where(eq(eventsTable.id, BigInt(id)))
    .limit(1);

  if (!row) {
    res.status(404).json({ error: "Event not found" });
    return;
  }

  res.json(formatEvent(row));
});

// ═════════════════════════════════════════════════════════════════════════════
// CORRELATION ENGINE
// ═════════════════════════════════════════════════════════════════════════════

// ─── Haversine angular separation ────────────────────────────────────────────

function angularSeparation(
  ra1: number, dec1: number,
  ra2: number, dec2: number
): number {
  const d = Math.PI / 180;
  const sinΔDec = Math.sin(((dec2 - dec1) * d) / 2);
  const sinΔRa  = Math.sin(((ra2  - ra1)  * d) / 2);
  const a =
    sinΔDec * sinΔDec +
    Math.cos(dec1 * d) * Math.cos(dec2 * d) * sinΔRa * sinΔRa;
  return 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * (180 / Math.PI);
}

// ─── Pair configuration ───────────────────────────────────────────────────────
//
// SCIENTIFIC RATIONALE
// ────────────────────
// correlationType distinguishes two fundamentally different situations:
//
//   multi_messenger  — different physical messengers from (possibly) the same
//                      astrophysical source (GRB+GW, GRB+ν, EP+GW …).
//                      This is the primary scientific target of Transient Event Detection.
//
//   cross_detection  — same event type, same sky position, close in time.
//                      Almost certainly the same physical event detected by
//                      two different instruments (Swift + Fermi, CHIME + other).
//                      Scientifically valuable for cross-calibration but NOT
//                      a multi-messenger association.
//
//   speculative      — no established physical emission mechanism connects these
//                      event types. Include for completeness at low weight.
//
// sigma_t (seconds) is the Gaussian 1-σ temporal window for each pair.
// Values are chosen from observational constraints in the literature:
//
//   GRB-GW  3 600s : BNS/NS-BH merger; GRB170817A arrived 1.74 s after GW170817.
//                    3 600s (1 h) is generous but encompasses extended emission.
//   EP-GW  86 400s : EP X-ray counterparts may be delayed hours (off-axis, kilonova).
//   GRB-NU  3 600s : Prompt neutrinos from hadronic jets arrive within ~hours.
//   EP-NU  86 400s : Delayed X-ray + neutrino emission from disk winds.
//   GRB-EP  3 600s : Prompt X-ray afterglow from same relativistic jet.
//   FRB-GW 86 400s : Speculative; no confirmed association. Wide window.
//   same   3 600s  : Cross-instrument; window tight enough to identify same burst.

export type CorrelationType = "multi_messenger" | "cross_detection" | "speculative";

interface PairConfig {
  readonly weight: number;          // 0–1 type-compatibility multiplier
  readonly sigmaT: number;          // seconds, Gaussian temporal σ
  readonly correlationType: CorrelationType;
}

const PAIR_CONFIGS: Readonly<Record<string, PairConfig>> = {
  "GRB-GW": { weight: 1.0, sigmaT:   3_600, correlationType: "multi_messenger" },
  "EP-GW":  { weight: 0.9, sigmaT:  86_400, correlationType: "multi_messenger" },
  "GRB-NU": { weight: 0.8, sigmaT:   3_600, correlationType: "multi_messenger" },
  "EP-NU":  { weight: 0.7, sigmaT:  86_400, correlationType: "multi_messenger" },
  "GRB-EP": { weight: 0.6, sigmaT:   3_600, correlationType: "multi_messenger" },
  "FRB-GW": { weight: 0.4, sigmaT:  86_400, correlationType: "speculative"     },
  "FRB-NU": { weight: 0.3, sigmaT: 604_800, correlationType: "speculative"     },
};

function getPairConfig(type1: string, type2: string): PairConfig {
  if (type1 === type2) {
    // Cross-instrument detection of the same event type.
    // Weight reduced to 0.5; tight 1-hour temporal window to avoid inflating
    // score for GRBs reported hours apart by slow-processing pipelines.
    return { weight: 0.5, sigmaT: 3_600, correlationType: "cross_detection" };
  }
  const key = [type1, type2].sort().join("-");
  return PAIR_CONFIGS[key] ?? { weight: 0.2, sigmaT: 86_400, correlationType: "speculative" };
}

// ─── Core correlation computation ─────────────────────────────────────────────
//
// SCORING FORMULA
// ───────────────
//
//   temporal_score(ΔT)  = exp(−ΔT²  / (2 σT²))          Gaussian in time
//   spatial_score(θ)    = exp(−θ²   / (2 σθ²))           Gaussian in angle
//   σθ                  = √(err1² + err2²)   (quadrature of error radii, degrees)
//
//   combined_score      = √(temporal_score × spatial_score)  ← GEOMETRIC MEAN
//
//   final_score         = round(weight × combined_score × 100)
//
// WHY GEOMETRIC MEAN over arithmetic mean?
//
//   Arithmetic mean allows one perfect score to compensate a zero score:
//     mean(1.0, 0.0) = 0.50  → 50% for a GRB from the WRONG direction.
//
//   Geometric mean is zero whenever either factor is zero:
//     √(1.0 × 0.0) = 0.00  → 0% correctly eliminates that false positive.
//
//   Example: GRB-GW, ΔT=2s (near-zero), θ=90° (opposite sky region):
//     spatial ≈ exp(−450) ≈ 0
//     arithmetic: 0.9 × mean(1.0, 0) × 100 = 45  ← false positive
//     geometric:  1.0 × √(1.0 × 0)  × 100 = 0   ← correct

type CandidateRow = typeof eventsTable.$inferSelect;

export interface CorrelationResult {
  id: string;
  eventId: string;
  eventType: string;
  observatory: string;
  score: number;
  angularSeparationDeg: number;
  deltaTSeconds: number;
  spatialScore: number;
  temporalScore: number;
  correlationType: CorrelationType;
}

function computeCorrelations(
  target: CandidateRow,
  candidates: CandidateRow[]
): CorrelationResult[] {
  const results: CorrelationResult[] = [];

  // Spatial coincidence cannot be assessed without both sky positions.
  // JavaScript coerces null to 0 inside the haversine, which yields a
  // separation of exactly 0deg — a *perfect* spatial match — and would
  // manufacture correlations between events that simply have no position.
  // 279 of 304 archived events have no position, so this is not hypothetical.
  //
  // NOTE: this mirrors the same guard in
  // science/correlationEngine/scorer.ts. There are two independent
  // correlation implementations in this codebase; both need the guard.
  if (target.ra == null || target.dec == null) return results;

  for (const candidate of candidates) {
    if (candidate.ra == null || candidate.dec == null) continue;

    const config = getPairConfig(target.eventType, candidate.eventType);

    const deltaTSeconds =
      (candidate.detectionTime.getTime() - target.detectionTime.getTime()) / 1000;

    const temporalScore = Math.exp(
      -(deltaTSeconds * deltaTSeconds) / (2 * config.sigmaT * config.sigmaT)
    );

    const separationDeg = angularSeparation(
      target.ra, target.dec,
      candidate.ra, candidate.dec
    );

    // Error radii are stored in arcminutes; convert to degrees.
    // Floor at 0.1° to prevent division-by-zero on perfectly-localised events.
    const err1 = Math.max((target.errorRadius    || 0) / 60, 0.1);
    const err2 = Math.max((candidate.errorRadius || 0) / 60, 0.1);
    const sigmaS = Math.sqrt(err1 * err1 + err2 * err2);

    const spatialScore = Math.exp(
      -(separationDeg * separationDeg) / (2 * sigmaS * sigmaS)
    );

    // Geometric mean — requires both temporal AND spatial coincidence.
    const combinedScore = Math.sqrt(temporalScore * spatialScore);
    const finalScore    = Math.round(config.weight * combinedScore * 100);

    if (finalScore > 1) {
      results.push({
        id: String(candidate.id),
        eventId: candidate.eventId,
        eventType: candidate.eventType,
        observatory: candidate.observatory,
        score: finalScore,
        angularSeparationDeg: separationDeg,
        deltaTSeconds,
        spatialScore,
        temporalScore,
        correlationType: config.correlationType,
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 10);
}

// ─── Cache hash ───────────────────────────────────────────────────────────────
// Stable fingerprint of the top-10 correlation set for this event.
// Changing the set (new events arrive, scores update) produces a new hash,
// automatically bypassing the stale cache entry.

function buildCorrelationHash(
  eventId: string,
  correlations: CorrelationResult[]
): string {
  const payload = JSON.stringify(
    correlations.map((c) => ({ id: c.id, score: c.score }))
  );
  return createHash("sha256").update(`${eventId}:${payload}`).digest("hex");
}

// ─── Candidate window query ───────────────────────────────────────────────────

async function fetchCandidates(
  target: CandidateRow
): Promise<CandidateRow[]> {
  const windowMs = 7 * 24 * 60 * 60 * 1000;
  const start = new Date(target.detectionTime.getTime() - windowMs);
  const end   = new Date(target.detectionTime.getTime() + windowMs);

  return db
    .select()
    .from(eventsTable)
    .where(
      and(
        eq(eventsTable.labId, target.labId),
        sql`${eventsTable.id} != ${target.id}`,
        sql`${eventsTable.detectionTime} BETWEEN ${start.toISOString()} AND ${end.toISOString()}`
      )
    );
}

// ─── GET /events/:id/correlations ────────────────────────────────────────────

router.get("/events/:id/correlations", async (req, res) => {
  const parsed = GetEventParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid params" });
    return;
  }

  const id = parseInt(parsed.data.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "ID must be numeric" });
    return;
  }

  const [target] = await db
    .select()
    .from(eventsTable)
    .where(eq(eventsTable.id, BigInt(id)))
    .limit(1);

  if (!target) {
    res.status(404).json({ error: "Event not found" });
    return;
  }

  const candidates = await fetchCandidates(target);
  res.json(computeCorrelations(target, candidates));
});

// ─── GET /events/:id/correlations/analysis ───────────────────────────────────
//
// AI-powered scientific assessment of the correlation candidates.
// Cache-first: reads from ai_correlation_analysis before calling Gemini.
// Cache key = SHA-256 of (event_id + top-10 correlation fingerprint).
//
// Error contract:
//   • Cache lookup failure   → log warn, proceed to Gemini
//   • Gemini failure         → 502/503, cache NOT written
//   • Cache write failure    → log warn, STILL return the Gemini result

router.get("/events/:id/correlations/analysis", async (req, res) => {
  const parsed = GetEventParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid params" });
    return;
  }

  const numericId = parseInt(parsed.data.id, 10);
  if (isNaN(numericId)) {
    res.status(400).json({ error: "ID must be numeric" });
    return;
  }
  const eventId    = BigInt(numericId);
  const eventIdStr = String(numericId); // safe for log serialization

  // 1. Load primary event
  const [target] = await db
    .select()
    .from(eventsTable)
    .where(eq(eventsTable.id, eventId))
    .limit(1);

  if (!target) {
    res.status(404).json({ error: "Event not found" });
    return;
  }

  // 2. Compute correlations (deterministic engine — no LLM involvement here)
  const candidates   = await fetchCandidates(target);
  const correlations = computeCorrelations(target, candidates);

  // 3. Build cache key
  const correlationHash = buildCorrelationHash(eventIdStr, correlations);

  // 4. Cache lookup — O(1) via unique index on (event_id, correlation_hash)
  let cached: typeof aiCorrelationAnalysis.$inferSelect | undefined;
  try {
    [cached] = await db
      .select()
      .from(aiCorrelationAnalysis)
      .where(
        and(
          eq(aiCorrelationAnalysis.eventId, eventId),
          eq(aiCorrelationAnalysis.correlationHash, correlationHash)
        )
      )
      .limit(1);
  } catch (lookupErr) {
    // Non-fatal: if the cache table is unavailable, fall through to Gemini
    logger.warn(
      { err: lookupErr, eventId: eventIdStr, correlationHash },
      "AI cache lookup failed — falling through to provider"
    );
  }

  if (cached) {
    logger.info(
      { eventId: eventIdStr, correlationHash, model: cached.modelName },
      "AI cache hit"
    );
    res.json({
      ...(cached.analysisJson as CorrelationAnalysisResult),
      cached:       true,
      generated_at: cached.createdAt.toISOString(),
      model:        cached.modelName,
    });
    return;
  }

  logger.info(
    { eventId: eventIdStr, correlationHash, candidateCount: correlations.length },
    "AI cache miss — calling provider"
  );

  // 5. Build the structured input for the agent
  const correlationScores: Record<string, {
    overall_score: number;
    temporal_score: number;
    spatial_score: number;
    angular_separation_deg: number;
    delta_t_seconds: number;
    event_pair_type: string;
    correlation_type: CorrelationType;
  }> = {};

  for (const corr of correlations) {
    correlationScores[corr.id] = {
      overall_score:         corr.score,
      temporal_score:        corr.temporalScore,
      spatial_score:         corr.spatialScore,
      angular_separation_deg: corr.angularSeparationDeg,
      delta_t_seconds:       corr.deltaTSeconds,
      event_pair_type:       [target.eventType, corr.eventType].sort().join("-"),
      correlation_type:      corr.correlationType,
    };
  }

  // 6. Call the AI agent — Gemini failure must never corrupt cache
  let analysisResult: CorrelationAnalysisResult;
  try {
    analysisResult = await getAgent().analyze({
      primary_event: {
        id:                String(target.id),
        eventId:           target.eventId,
        eventType:         target.eventType,
        observatory:       target.observatory,
        detectionTime:     target.detectionTime.toISOString(),
        ra:                target.ra,
        dec:               target.dec,
        errorRadius:       target.errorRadius,
        snr:               target.snr,
        far:               target.far,
        galLat:            target.galLat,
        galLon:            target.galLon,
        sunDistance:       target.sunDistance,
        moonDistance:      target.moonDistance,
        fluence:           target.fluence           ?? null,
        dm:                target.dm                ?? null,
        t90:               target.t90               ?? null,
        chirpMass:         target.chirpMass         ?? null,
        luminosityDistance: target.luminosityDistance ?? null,
        lifecycle:         target.lifecycle,
      },
      candidate_events: correlations.map((c) => ({
        id:          c.id,
        eventId:     c.eventId,
        eventType:   c.eventType,
        observatory: c.observatory,
      })),
      correlation_scores: correlationScores,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error(
      { err, eventId: eventIdStr, correlationHash },
      "AI provider call failed"
    );

    if (message.includes("GEMINI_API_KEY")) {
      res.status(503).json({
        error: "AI analysis is not configured. Set GEMINI_API_KEY to enable this feature.",
      });
    } else {
      res.status(502).json({ error: `AI provider error: ${message}` });
    }
    return;
  }

  // 7. Persist to cache — runs in a transaction so stale rows are evicted atomically
  // The model name comes from the provider that actually ran, not from a
  // vendor-specific env var: since provider selection became configurable
  // (LLM_PROVIDER), reading GEMINI_MODEL here would stamp a DeepSeek answer
  // with a Gemini model name.
  const modelName = getAgent().providerName;
  const now       = new Date();

  try {
    await db.transaction(async (tx) => {
      // Remove any cached analyses for this event whose hash no longer matches
      // the current correlation set. Prevents unbounded row accumulation.
      await tx
        .delete(aiCorrelationAnalysis)
        .where(
          and(
            eq(aiCorrelationAnalysis.eventId, eventId),
            sql`${aiCorrelationAnalysis.correlationHash} != ${correlationHash}`
          )
        );

      // Insert the fresh analysis; update in-place if same hash already exists
      // (e.g. a concurrent request raced us to the write).
      await tx
        .insert(aiCorrelationAnalysis)
        .values({
          eventId,
          correlationHash,
          modelName,
          analysisJson: analysisResult as unknown as Record<string, unknown>,
          createdAt:    now,
          updatedAt:    now,
        })
        .onConflictDoUpdate({
          target: [aiCorrelationAnalysis.eventId, aiCorrelationAnalysis.correlationHash],
          set: {
            analysisJson: analysisResult as unknown as Record<string, unknown>,
            modelName,
            updatedAt:    now,
          },
        });
    });

    logger.info(
      { eventId: eventIdStr, correlationHash, model: modelName },
      "AI cache save success"
    );
  } catch (cacheErr) {
    // Cache write failure must never prevent the client receiving its analysis.
    logger.warn(
      { err: cacheErr, eventId: eventIdStr, correlationHash },
      "AI cache save failure"
    );
  }

  res.json({
    ...analysisResult,
    cached:       false,
    generated_at: now.toISOString(),
    model:        modelName,
  });
});

export default router;
