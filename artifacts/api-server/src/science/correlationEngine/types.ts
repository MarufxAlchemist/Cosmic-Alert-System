/**
 * types.ts — Multi-Messenger Correlation Engine (Phase 6.0A)
 * ----------------------------------------------------------
 * All type definitions. No logic, no I/O.
 *
 * Phase 6.0A upgrades
 * ───────────────────
 *  • CorrelationType enum — distinguishes multi_messenger / cross_detection / speculative
 *  • correlationType added to CorrelationMatch
 *  • nCandidates added to CorrelationResult
 *  • StoredCorrelation — shape returned from repository / API endpoints
 *
 * Input/output schema matches docs/correlation.txt:
 *   Input:  { primary_event, candidate_events, correlation_scores }
 *   Output: { confidence, scientific_assessment, followup_recommendation, reasoning }
 */

// ---------------------------------------------------------------------------
// Confidence scale
// ---------------------------------------------------------------------------

/**
 * Correlation confidence level.
 *
 *   HIGH   — Temporal + spatial coincidence within thresholds, strong type pairing
 *   MEDIUM — Temporal coincidence with plausible spatial overlap
 *   LOW    — Temporal coincidence only; spatial overlap marginal or type pairing weak
 *   NONE   — No significant correlation found
 */
export type CorrelationConfidence = "HIGH" | "MEDIUM" | "LOW" | "NONE";

// ---------------------------------------------------------------------------
// Correlation type
// ---------------------------------------------------------------------------

/**
 * Physical nature of a correlated pair.
 *
 *   multi_messenger  — different messengers (photons, GW, neutrinos, radio) from the same source.
 *                      This is Transient Event Detection's primary scientific target (e.g. GW+GRB, EP+GW).
 *   cross_detection  — same event type, same sky position, close in time.
 *                      Almost certainly the same source detected by two instruments.
 *                      Scientifically valuable for cross-calibration, not a new multi-messenger event.
 *   speculative      — no established physical emission model; included at low weight.
 */
export type CorrelationType = "multi_messenger" | "cross_detection" | "speculative";

// ---------------------------------------------------------------------------
// Event representations
// ---------------------------------------------------------------------------

/**
 * Minimal event shape required by the correlator.
 * Maps to the fields available in the broadcast payload.
 */
export interface CorrelationEvent {
  eventId:     string;
  eventType:   string;   // "GW" | "GRB" | "FRB" | "NU" | "EP"
  observatory: string;
  /** ISO-8601 detection timestamp */
  detectionTime: string;
  /** Right ascension [degrees] */
  ra:          number;
  /** Declination [degrees] */
  dec:         number;
  /** 1-sigma error radius [arcmin] */
  errorRadius: number;
  /** True if this is a retraction */
  isRetraction?: boolean;
}

// ---------------------------------------------------------------------------
// Per-pair scoring breakdown
// ---------------------------------------------------------------------------

/**
 * Result of correlating primary against one candidate.
 */
export interface CorrelationMatch {
  /** The candidate event that was evaluated */
  candidate:              CorrelationEvent;
  /** Time difference [seconds] — signed: positive = candidate is later */
  deltaTimeSec:           number;
  /** Angular separation [degrees] */
  angularSeparationDeg:   number;
  /** Combined error radius of both events [degrees] — quadrature sum */
  combinedErrorDeg:       number;
  /** Gaussian temporal score component [0–1] */
  temporalScore:          number;
  /** Gaussian spatial score component [0–1] */
  spatialScore:           number;
  /** Whether temporal coincidence is within the configured window */
  temporalMatch:          boolean;
  /** Whether spatial coincidence is within the configured error factor */
  spatialMatch:           boolean;
  /** Event type pairing weight [0–1] */
  pairingWeight:          number;
  /** Physical nature of this pair */
  correlationType:        CorrelationType;
  /** Total score for this pair [0–100] */
  score:                  number;
  /** Human-readable reasoning for this specific pair */
  reasoning:              string;
}

// ---------------------------------------------------------------------------
// Correlation result — matches docs/correlation.txt output schema
// ---------------------------------------------------------------------------

/**
 * Complete output of the correlation engine for one primary event.
 * This is the exact shape expected by the email template and API endpoints.
 */
export interface CorrelationResult {
  /** Overall confidence in any correlation finding */
  confidence: CorrelationConfidence;

  /** Number of candidate events that were evaluated */
  nCandidates: number;

  /**
   * Scientific narrative.
   * Examples:
   *   "Temporal and spatial coincidence consistent with NS-NS merger counterpart."
   *   "No significant multi-messenger counterpart found within coincidence windows."
   */
  scientific_assessment: string;

  /**
   * Recommended action for the research team.
   * Examples:
   *   "Immediate optical/X-ray follow-up of GW sky region recommended."
   *   "No targeted follow-up warranted by correlation analysis."
   */
  followup_recommendation: string;

  /**
   * Concise technical reasoning string.
   * Example: "ΔT = 1.3 s, angular separation = 0.8°, within 3σ combined error (2.1°)"
   */
  reasoning: string;

  /**
   * All candidate pairs that were evaluated.
   * Sorted by score descending. Empty when no candidates were available.
   */
  matches: CorrelationMatch[];

  /**
   * The best-scoring match, or null if no candidates existed / no match found.
   */
  bestMatch: CorrelationMatch | null;
}

// ---------------------------------------------------------------------------
// Engine input — matches docs/correlation.txt input schema
// ---------------------------------------------------------------------------

export interface CorrelationInput {
  primary_event:      CorrelationEvent;
  candidate_events:   CorrelationEvent[];
  /** Optional pre-computed scores to blend in (for future AI integration) */
  correlation_scores?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Stored correlation — shape for DB persistence and API responses
// ---------------------------------------------------------------------------

/**
 * Flattened record for the core.event_correlations table.
 * Written by repository.ts, read by API endpoints.
 */
export interface StoredCorrelation {
  /** Internal DB id of the primary event (core.events.id) */
  primaryEventDbId:   bigint;
  /** Internal DB id of the candidate event */
  candidateEventDbId: bigint;
  /** GCN string event ID of the primary */
  primaryEventId:     string;
  /** GCN string event ID of the candidate */
  candidateEventId:   string;
  confidence:         CorrelationConfidence;
  score:              number;
  deltaTimeSec:       number;
  angularSepDeg:      number;
  correlationType:    CorrelationType;
  reasoning:          string;
  computedAt:         Date;
}
