/**
 * thresholds.ts — Scientific Priority Classification Engine
 * ----------------------------------------------------------
 * All numeric decision thresholds for the scoring rules.
 *
 * Design principles
 * ─────────────────
 *   • NO magic numbers anywhere in the codebase.
 *   • Every threshold is configurable via an environment variable.
 *   • Each env var has a sensible, scientifically motivated default.
 *   • getThresholds() reads from process.env on every call — changes to
 *     env vars (e.g. via config reload) are reflected immediately.
 *   • The returned Thresholds object is a plain value type — immutable
 *     within a single classification call.
 *
 * Phase 5.2 — Transient Event Detection
 */

// ---------------------------------------------------------------------------
// Thresholds type
// ---------------------------------------------------------------------------

export interface Thresholds {
  // ── Score → Priority mapping ─────────────────────────────────────────────
  /** Minimum score for P0 (Critical). Default: 70 */
  scoreP0: number;
  /** Minimum score for P1 (High). Default: 45 */
  scoreP1: number;
  /** Minimum score for P2 (Medium). Default: 20 */
  scoreP2: number;

  // ── GW — False Alarm Rate ─────────────────────────────────────────────────
  /** FAR below this → CRITICAL contribution [Hz]. Default: 1e-8 (1/yr) */
  gwFarCritical: number;
  /** FAR below this → HIGH contribution [Hz]. Default: 1e-6 */
  gwFarHigh: number;

  // ── GRB — Fluence ─────────────────────────────────────────────────────────
  /** Fluence above this → HIGH GRB contribution [erg/cm²]. Default: 1e-6 */
  grbFluenceHigh: number;
  /** Fluence above this → MEDIUM contribution. Default: 1e-7 */
  grbFluenceMedium: number;

  // ── GRB — Duration (T90) ──────────────────────────────────────────────────
  /**
   * T90 above this → long-duration GRB (associated with collapsars/SN).
   * Default: 2.0 s (standard GRB classification boundary)
   */
  grbT90Long: number;

  // ── Signal quality (SNR) ─────────────────────────────────────────────────
  /** SNR above this → high quality. Default: 10.0 */
  snrHigh: number;
  /** SNR above this → medium quality. Default: 5.0 */
  snrMedium: number;

  // ── Localization (error radius, arcmin) ───────────────────────────────────
  /**
   * Error radius below this → good localization.
   * Default: 30 arcmin (0.5°) — enables feasible follow-up pointing
   */
  localizationGood: number;
  /**
   * Error radius above this → poor localization.
   * Default: 300 arcmin (5°) — too large for most optical follow-up
   */
  localizationPoor: number;

  // ── Revision penalty ──────────────────────────────────────────────────────
  /**
   * Score deduction per revision. Prevents revision storms from
   * generating too many high-priority notifications.
   * Default: 5 per revision, max 15 deducted total
   */
  revisionPenaltyPerCount: number;
  revisionPenaltyMax: number;
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function envFloat(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return defaultValue;
  const n = parseFloat(raw);
  return isFinite(n) ? n : defaultValue;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Read all thresholds from environment variables.
 * Falls back to scientifically motivated defaults when env vars are absent.
 *
 * Called once per classification — no global mutable state.
 */
export function getThresholds(): Thresholds {
  return {
    // Score → Priority
    scoreP0: envFloat("PRIORITY_SCORE_P0", 70),
    scoreP1: envFloat("PRIORITY_SCORE_P1", 45),
    scoreP2: envFloat("PRIORITY_SCORE_P2", 20),

    // GW
    gwFarCritical: envFloat("PRIORITY_GW_FAR_CRITICAL", 1e-8),
    gwFarHigh:     envFloat("PRIORITY_GW_FAR_HIGH",     1e-6),

    // GRB fluence
    grbFluenceHigh:   envFloat("PRIORITY_GRB_FLUENCE_HIGH",   1e-6),
    grbFluenceMedium: envFloat("PRIORITY_GRB_FLUENCE_MEDIUM",  1e-7),

    // GRB duration
    grbT90Long: envFloat("PRIORITY_GRB_T90_LONG", 2.0),

    // SNR
    snrHigh:   envFloat("PRIORITY_SNR_HIGH",   10.0),
    snrMedium: envFloat("PRIORITY_SNR_MEDIUM",  5.0),

    // Localization
    localizationGood: envFloat("PRIORITY_LOCALIZATION_GOOD", 30),
    localizationPoor: envFloat("PRIORITY_LOCALIZATION_POOR", 300),

    // Revision
    revisionPenaltyPerCount: envFloat("PRIORITY_REVISION_PENALTY",     5),
    revisionPenaltyMax:      envFloat("PRIORITY_REVISION_PENALTY_MAX", 15),
  };
}
