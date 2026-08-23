/**
 * classifier.ts — Scientific Priority Classification Engine
 * ----------------------------------------------------------
 * Main orchestrator. Runs all scoring rules, aggregates score, maps to P0–P3.
 *
 * Flow
 * ────
 *   classify(event)
 *     │
 *     ├─ 1. Load thresholds from env (getThresholds)
 *     ├─ 2. Run all scoring rules → collect ScoringFactor[]
 *     ├─ 3. Handle retraction veto (immediate P3 short-circuit)
 *     ├─ 4. Sum scores, clamp to [0, 100]
 *     ├─ 5. Map score → PriorityLevel (P0/P1/P2/P3)
 *     ├─ 6. Collect contributing reason strings
 *     ├─ 7. Generate recommendation text
 *     └─ 8. Return ClassificationResult
 *
 * Extensibility (AI scoring)
 * ──────────────────────────
 *   To add an AI scoring rule (e.g. Gemini-based event significance estimator):
 *     1. Implement async evaluateAIScore(event, thresholds): Promise<ScoringFactor>
 *     2. Add it to the optional AI_RULES array below.
 *     3. classify() already accepts an optional aiFactors parameter.
 *     No existing rules or calling code need to change.
 *
 * Phase 5.2 — Transient Event Detection
 */

import type { EventClassificationInput, ClassificationResult, ScoringFactor, PriorityLevel } from "./types.js";
import { getThresholds }         from "./thresholds.js";
import {
  evaluateRetraction,
  evaluateHistorical,
  evaluateEventType,
  evaluateLifecycle,
  evaluateObservatory,
  evaluateClassificationTier,
  evaluateSignalQuality,
  evaluateLocalization,
  evaluateRevision,
  evaluateFARScore,
  evaluateGRBProperties,
} from "./scoringRules.js";

// ---------------------------------------------------------------------------
// Recommendation strings
// ---------------------------------------------------------------------------

const RECOMMENDATIONS: Record<PriorityLevel, string> = {
  P0: "Immediate multi-wavelength follow-up recommended. Notify all available observers.",
  P1: "Prompt follow-up recommended within 1 hour. Alert primary observers.",
  P2: "Include in next observing digest. Schedule follow-up during next available window.",
  P3: "No immediate action required. Event recorded in database for archival analysis.",
};

// ---------------------------------------------------------------------------
// Priority score mapping
// ---------------------------------------------------------------------------

function scoreToPriority(score: number, scoreP0: number, scoreP1: number, scoreP2: number): PriorityLevel {
  if (score >= scoreP0) return "P0";
  if (score >= scoreP1) return "P1";
  if (score >= scoreP2) return "P2";
  return "P3";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify an accepted astrophysical event and return a full priority result.
 *
 * @param event       - Event fields from the broadcast payload.
 * @param aiFactors   - Optional pre-computed AI scoring factors (for future
 *                      Gemini/ML integration). Injected here to keep the core
 *                      classifier synchronous and pure.
 * @returns ClassificationResult
 */
export function classify(
  event: EventClassificationInput,
  aiFactors: ScoringFactor[] = [],
): ClassificationResult {
  const thresholds = getThresholds();

  // ── 1. Run all deterministic scoring rules ─────────────────────────────
  const factors: ScoringFactor[] = [
    // ❗ Retraction veto first — enables short-circuit below
    evaluateRetraction(event),
    evaluateHistorical(event),
    evaluateEventType(event),
    evaluateLifecycle(event),
    evaluateObservatory(event),
    evaluateClassificationTier(event),
    evaluateSignalQuality(event, thresholds),
    evaluateLocalization(event, thresholds),
    evaluateRevision(event, thresholds),
    evaluateFARScore(event, thresholds),
    evaluateGRBProperties(event, thresholds),
    // AI factors appended last — does not affect deterministic rules
    ...aiFactors,
  ];

  // ── 2. Retraction short-circuit ───────────────────────────────────────
  const retractionFactor = factors.find((f) => f.name === "retraction_veto" && f.contributed);
  if (retractionFactor) {
    return {
      priority:       "P3",
      score:          0,
      reasons:        [retractionFactor.reason],
      recommendation: "Retraction received. Previous alert is withdrawn. No follow-up required.",
      factors,
    };
  }

  // ── 3. Aggregate score ─────────────────────────────────────────────────
  const rawScore = factors.reduce((sum, f) => sum + f.score, 0);
  const score    = Math.max(0, Math.min(100, rawScore));

  // ── 4. Priority level ──────────────────────────────────────────────────
  const priority = scoreToPriority(
    score,
    thresholds.scoreP0,
    thresholds.scoreP1,
    thresholds.scoreP2,
  );

  // ── 5. Collect reasons ─────────────────────────────────────────────────
  const reasons = factors
    .filter((f) => f.contributed)
    .map((f) => f.reason)
    .filter((r) => r.length > 0);

  // ── 6. Recommendation ─────────────────────────────────────────────────
  const recommendation = RECOMMENDATIONS[priority];

  return {
    priority,
    score,
    reasons,
    recommendation,
    factors,
  };
}
