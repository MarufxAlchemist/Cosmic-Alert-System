/**
 * types.ts — Scientific Priority Classification Engine
 * -----------------------------------------------------
 * All type definitions for the priority classification system.
 * No logic, no I/O — pure type declarations.
 *
 * Phase 5.2 — Transient Event Detection
 */

// ---------------------------------------------------------------------------
// Priority levels
// ---------------------------------------------------------------------------

/**
 * Four-tier scientific priority scale.
 *
 *   P0 — Critical   : Immediate notification. Rare, highly significant events.
 *   P1 — High       : Immediate notification. Important events.
 *   P2 — Medium     : Digest mode only. Notable but not urgent.
 *   P3 — Low        : Database only. Informational, no notification.
 */
export type PriorityLevel = "P0" | "P1" | "P2" | "P3";

// ---------------------------------------------------------------------------
// Scoring factor — one per rule evaluation
// ---------------------------------------------------------------------------

/**
 * The output of a single scoring rule.
 *
 * `score` is additive — positive values increase priority, negative decrease.
 * Rules that don't apply return score=0 with an empty reason.
 * All factors are included in ClassificationResult.factors for full auditability
 * and future AI scoring integration.
 */
export interface ScoringFactor {
  /** Unique rule name for debugging and AI integration. */
  name: string;
  /** Score contribution from this rule (positive or negative). */
  score: number;
  /** Human-readable reason string (empty when rule does not apply). */
  reason: string;
  /** Whether this rule contributed a reason to the final reasons list. */
  contributed: boolean;
}

// ---------------------------------------------------------------------------
// Classification result
// ---------------------------------------------------------------------------

/**
 * Complete output of the priority classification engine.
 * Returned by classify() and consumed by notificationService.
 */
export interface ClassificationResult {
  /** P0 / P1 / P2 / P3 */
  priority: PriorityLevel;

  /**
   * Aggregate score in range [0, 100].
   * Score boundaries are configurable via env vars (PRIORITY_SCORE_P0 etc).
   */
  score: number;

  /**
   * Human-readable reasons for the assigned priority.
   * Populated from the `reason` field of rules that contributed.
   * Examples: ["Confirmed GRB", "High Fluence", "Swift BAT", "Good Localization"]
   */
  reasons: string[];

  /**
   * Single recommended action string for the notification recipient.
   * Examples:
   *   P0: "Immediate multi-wavelength follow-up recommended."
   *   P1: "Follow-up observations recommended within 1 hour."
   *   P2: "Include in next digest. Low-priority follow-up."
   *   P3: "No immediate action required. Recorded in database."
   */
  recommendation: string;

  /**
   * All individual scoring factors — one per rule.
   * Included for:
   *   • Debugging and transparency
   *   • Future AI scoring (add a 10th factor without changing other rules)
   *   • Dashboard display / scientific audit trail
   */
  factors: ScoringFactor[];
}

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

/**
 * Event fields required by the classification engine.
 * Maps directly to the broadcast payload shape from kafkaConsumer.ts.
 * All numeric fields default to 0 if absent — the engine handles missing data.
 */
export interface EventClassificationInput {
  /** "GW" | "GRB" | "FRB" | "NU" */
  eventType: string;

  /** e.g. "LIGO (H1,L1)", "IceCube", "Swift (BAT)", "CHIME" */
  observatory: string;

  /** "preliminary" | "initial" | "update" | "confirmed" */
  lifecycle: string;

  /** Raw alert_type string from source (e.g. "PRELIMINARY", "ALERT", "FINAL") */
  alertType: string | null;

  /** "GOLD" | "BRONZE" | null (IceCube neutrino tier) */
  classificationTier: string | null;

  /** Signal-to-noise ratio */
  snr: number;

  /** False alarm rate in Hz — lower values = rarer = more significant */
  far: number;

  /** Sky localization 1-sigma error radius in arcmin */
  errorRadius: number;

  /** True if this is a retraction notice */
  isRetraction: boolean;

  /** True if this event was injected from historical bootstrap data */
  isHistorical: boolean;

  /** Number of prior notices for this event (0 = first notice) */
  revisionCount: number;

  /** GRB fluence [erg/cm²] — null for non-GRB */
  fluence?: number | null;

  /** GRB duration T90 [s] — null for non-GRB */
  t90?: number | null;

  /** FRB dispersion measure [pc/cm³] — null for non-FRB */
  dm?: number | null;

  /** GW chirp mass [M☉] — null for non-GW */
  chirpMass?: number | null;

  /** GW luminosity distance [Mpc] — null for non-GW */
  luminosityDistance?: number | null;
}
