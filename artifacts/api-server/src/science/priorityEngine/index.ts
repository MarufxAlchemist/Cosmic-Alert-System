/**
 * index.ts — Scientific Priority Classification Engine
 * -----------------------------------------------------
 * Public re-exports. Consumers import from this file only.
 * Internal modules (scoringRules, thresholds) are not part of the public API.
 *
 * Usage:
 *   import { classify } from "../science/priorityEngine/index.js";
 *   import type { ClassificationResult, EventClassificationInput } from "../science/priorityEngine/index.js";
 *
 * Phase 5.2 — Transient Event Detection
 */

export { classify }                  from "./classifier.js";
export type {
  PriorityLevel,
  ClassificationResult,
  EventClassificationInput,
  ScoringFactor,
}                                    from "./types.js";

// Expose individual rules for unit testing and future tooling
export {
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
}                                    from "./scoringRules.js";

// Expose thresholds for config inspection / health endpoints
export { getThresholds }             from "./thresholds.js";
export type { Thresholds }           from "./thresholds.js";
