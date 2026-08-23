/**
 * scorer.ts — Multi-Messenger Correlation Engine (Phase 6.0A)
 * -----------------------------------------------------------
 * Scores a single (primary, candidate) event pair.
 *
 * Scoring model (upgraded to Gaussian geometric mean in Phase 6.0A)
 * ─────────────────────────────────────────────────────────────────
 *   temporal_score  = exp(−ΔT²  / (2 σT²))          Gaussian in time    [0–1]
 *   spatial_score   = exp(−θ²   / (2 σθ²))           Gaussian in angle   [0–1]
 *   σθ              = √(err₁² + err₂²)  (quadrature, degrees)
 *
 *   combined_score  = weight × √(temporal × spatial)  ← geometric mean × weight
 *   final_score     = round(combined_score × 100)      [0–100]
 *
 * WHY GEOMETRIC MEAN over arithmetic mean?
 * ────────────────────────────────────────
 *   Arithmetic mean allows a perfect temporal score to compensate a zero
 *   spatial score:
 *     mean(1.0, 0.0) = 0.50 → 50% for a GRB from the opposite sky direction.
 *
 *   Geometric mean is zero whenever either factor is zero:
 *     √(1.0 × 0.0) = 0.00 → correctly eliminates that false positive.
 *
 * Pure function — no I/O, no side effects.
 *
 * Phase 6.0A — Transient Event Detection
 */

import type { CorrelationEvent, CorrelationMatch } from "./types.js";
import type { CoincidenceWindows }                  from "./windows.js";
import { getPairingRule }                           from "./pairingRules.js";

// ---------------------------------------------------------------------------
// Haversine angular separation
// ---------------------------------------------------------------------------

const DEG2RAD = Math.PI / 180;

/**
 * Compute the angular separation between two points on the celestial sphere.
 * Uses the haversine formula for numerical stability at small angles.
 *
 * @returns Separation in degrees.
 */
export function angularSeparationDeg(
  ra1: number, dec1: number,
  ra2: number, dec2: number,
): number {
  const dRa  = (ra2  - ra1)  * DEG2RAD;
  const dDec = (dec2 - dec1) * DEG2RAD;
  const a =
    Math.sin(dDec / 2) ** 2 +
    Math.cos(dec1 * DEG2RAD) * Math.cos(dec2 * DEG2RAD) * Math.sin(dRa / 2) ** 2;
  return (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))) / DEG2RAD;
}

// ---------------------------------------------------------------------------
// Temporal window lookup
// ---------------------------------------------------------------------------

function getTemporalWindowSec(
  primaryType: string,
  candidateType: string,
  windows: CoincidenceWindows,
): number {
  const a = primaryType.toUpperCase();
  const b = candidateType.toUpperCase();

  if ((a === "GW"  && b === "GRB") || (a === "GRB" && b === "GW"))  return windows.gwGrbSec;
  if ((a === "GW"  && b === "NU")  || (a === "NU"  && b === "GW"))  return windows.gwNuSec;
  if ((a === "GW"  && b === "FRB") || (a === "FRB" && b === "GW"))  return windows.gwFrbSec;
  if ((a === "GRB" && b === "NU")  || (a === "NU"  && b === "GRB")) return windows.grbNuSec;
  if ((a === "GRB" && b === "FRB") || (a === "FRB" && b === "GRB")) return windows.grbFrbSec;
  if ((a === "EP"  && b === "GW")  || (a === "GW"  && b === "EP"))  return windows.epGwSec;
  if ((a === "EP"  && b === "GRB") || (a === "GRB" && b === "EP"))  return windows.epGrbSec;
  if ((a === "EP"  && b === "NU")  || (a === "NU"  && b === "EP"))  return windows.epNuSec;
  if ((a === "NU"  && b === "FRB") || (a === "FRB" && b === "NU"))  return windows.nuFrbSec;
  return windows.defaultSec;
}

// ---------------------------------------------------------------------------
// Gaussian score components
// ---------------------------------------------------------------------------

/**
 * Gaussian temporal score.
 * Returns exp(−ΔT² / 2σ²) — peaks at 1.0 for ΔT=0, falls to near-zero at |ΔT| >> σ.
 * Also returns whether ΔT is within the strict half-window (for `temporalMatch` flag).
 */
function gaussianTemporalScore(
  deltaTimeSec: number,
  windowSec: number,
): { score: number; match: boolean } {
  const absdt = Math.abs(deltaTimeSec);
  // Use windowSec as 2-sigma boundary so the score is exp(-2) ≈ 0.135 at the window edge
  const sigma = windowSec / 2;
  const score = Math.exp(-(absdt * absdt) / (2 * sigma * sigma));
  return { score, match: absdt <= windowSec };
}

/**
 * Gaussian spatial score.
 * σθ = √(err₁² + err₂²)  (quadrature sum of error radii in degrees)
 * Returns exp(−θ² / 2σθ²) — peaks at 1.0 for θ=0.
 * `match` = true when separation ≤ spatialFactor × σθ.
 */
function gaussianSpatialScore(
  separationDeg: number,
  combinedErrorDeg: number,
  spatialFactor: number,
): { score: number; match: boolean } {
  // Floor combined error at 0.1° to prevent division-by-zero on perfectly localised events.
  const sigma = Math.max(combinedErrorDeg, 0.1);
  const score = Math.exp(-(separationDeg * separationDeg) / (2 * sigma * sigma));
  const threshold = spatialFactor * sigma;
  return { score, match: separationDeg <= threshold };
}

// ---------------------------------------------------------------------------
// Main pair scorer
// ---------------------------------------------------------------------------

/**
 * Score a single (primary, candidate) event pair and return a CorrelationMatch.
 *
 * @param primary   - The primary event triggering the notification.
 * @param candidate - A recent event from the database to compare against.
 * @param windows   - Configurable coincidence windows from environment.
 */
export function scorePair(
  primary:   CorrelationEvent,
  candidate: CorrelationEvent,
  windows:   CoincidenceWindows,
): CorrelationMatch {
  // ── Skip retractions ──────────────────────────────────────────────────────
  if (candidate.isRetraction) {
    return {
      candidate,
      deltaTimeSec:           0,
      angularSeparationDeg:   0,
      combinedErrorDeg:       0,
      temporalScore:          0,
      spatialScore:           0,
      temporalMatch:          false,
      spatialMatch:           false,
      pairingWeight:          0,
      correlationType:        "speculative",
      score:                  0,
      reasoning:              "Candidate is a retraction — excluded from correlation.",
    };
  }

  // ── Position required for any spatial claim ───────────────────────────────
  // A missing sky position must never be treated as a coordinate. JavaScript
  // coerces null to 0 inside the haversine, which would yield a separation of
  // exactly 0° — a *perfect* spatial match — and manufacture multi-messenger
  // "associations" between events that simply have no position at all.
  // 92% of the archive had no position before migration 0011, so this path is
  // not hypothetical.
  const positionKnown =
    primary.ra   != null && primary.dec   != null &&
    candidate.ra != null && candidate.dec != null;

  if (!positionKnown) {
    return {
      candidate,
      deltaTimeSec:           0,
      angularSeparationDeg:   0,
      combinedErrorDeg:       0,
      temporalScore:          0,
      spatialScore:           0,
      temporalMatch:          false,
      spatialMatch:           false,
      pairingWeight:          0,
      correlationType:        "speculative",
      score:                  0,
      reasoning:
        "Sky position unavailable for one or both events — spatial coincidence " +
        "cannot be assessed, so no correlation is claimed.",
    };
  }

  // ── Temporal ──────────────────────────────────────────────────────────────
  const tPrimary   = new Date(primary.detectionTime).getTime();
  const tCandidate = new Date(candidate.detectionTime).getTime();
  const deltaTimeSec = (tCandidate - tPrimary) / 1000;

  const windowSec = getTemporalWindowSec(primary.eventType, candidate.eventType, windows);
  const { score: tScore, match: temporalMatch } = gaussianTemporalScore(deltaTimeSec, windowSec);

  // ── Spatial ───────────────────────────────────────────────────────────────
  const separation = angularSeparationDeg(primary.ra, primary.dec, candidate.ra, candidate.dec);

  // Convert arcmin → degrees; quadrature sum of both error regions
  const err1 = Math.max((primary.errorRadius   || 0) / 60, 0.1);
  const err2 = Math.max((candidate.errorRadius || 0) / 60, 0.1);
  const combinedErrorDeg = Math.sqrt(err1 * err1 + err2 * err2);

  const { score: sScore, match: spatialMatch } = gaussianSpatialScore(
    separation,
    combinedErrorDeg,
    windows.spatialFactor,
  );

  // ── Pairing rule ──────────────────────────────────────────────────────────
  const rule = getPairingRule(primary.eventType, candidate.eventType);

  // ── Aggregate — geometric mean × weight ───────────────────────────────────
  const geometricMean = Math.sqrt(tScore * sScore);
  const score = Math.min(100, Math.round(rule.weight * geometricMean * 100));

  // ── Reasoning ─────────────────────────────────────────────────────────────
  const parts: string[] = [];
  const dtSign = deltaTimeSec >= 0 ? "+" : "";
  parts.push(`ΔT = ${dtSign}${deltaTimeSec.toFixed(1)} s (window: ±${windowSec} s)`);
  parts.push(
    `angular separation = ${separation.toFixed(2)}° ` +
    `(${windows.spatialFactor}σ threshold: ${(windows.spatialFactor * combinedErrorDeg).toFixed(2)}°)`,
  );
  parts.push(rule.physicalBasis);
  if (!temporalMatch) parts.push("Outside temporal coincidence window.");
  if (!spatialMatch)  parts.push("Outside spatial coincidence region.");

  return {
    candidate,
    deltaTimeSec,
    angularSeparationDeg:  separation,
    combinedErrorDeg,
    temporalScore:         tScore,
    spatialScore:          sScore,
    temporalMatch,
    spatialMatch,
    pairingWeight:         rule.weight,
    correlationType:       rule.correlationType,
    score,
    reasoning: parts.join(" "),
  };
}
