/**
 * changeDetector.ts — Notification Deduplication Engine (Phase 5.5)
 * ------------------------------------------------------------------
 * Pure functions to compare the current event state against the last-sent
 * snapshot. Detects meaningful changes that warrant a new notification.
 *
 * Phase 5.5 — Transient Event Detection
 */

import type { NotificationSnapshot, DeduplicationPolicy, ChangeReason } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * P0 > P1 > P2 > P3
 * Returns true if currentLevel is a higher priority (lower number) than lastLevel.
 */
function isPriorityLevelIncreased(currentLevel: string, lastLevel: string): boolean {
  const c = parseInt(currentLevel.replace("P", ""), 10);
  const l = parseInt(lastLevel.replace("P", ""), 10);
  if (isNaN(c) || isNaN(l)) return false;
  return c < l;
}

/**
 * Returns true if currentConfidence is higher than lastConfidence,
 * according to the order defined in the policy.
 */
function isCorrelationImproved(
  currentConfidence: string,
  lastConfidence: string,
  order: string[],
): boolean {
  const cIdx = order.indexOf(currentConfidence);
  const lIdx = order.indexOf(lastConfidence);
  if (cIdx === -1 || lIdx === -1) return false;
  return cIdx > lIdx;
}

/**
 * Returns true if the error radius was reduced by AT LEAST the required percentage.
 *
 * Zero or absent is UNKNOWN, never "perfect"
 * ------------------------------------------
 * This function previously read:
 *
 *     if (currentRadius <= 0) return true;  // "Perfect localization"
 *
 * Since Phase 2 an absent localization is stored as null and arrives here as
 * 0, so a revision that STOPPED reporting a localization was classified as a
 * perfect localization and fired a "LOCALIZATION_IMPROVED" alert. That is
 * inverted: losing the uncertainty is a loss of knowledge, not a refinement,
 * and no real instrument reports a zero-radius position.
 *
 * Both directions are now treated as "not an improvement" — the change is
 * still recorded in the revision history (Phase 6), which reports a lost
 * localization explicitly rather than as a silent upgrade.
 */
function isLocalizationImproved(
  currentRadius: number,
  lastRadius: number,
  requiredPct: number,
): boolean {
  // Previous radius unknown → there is nothing to have improved upon.
  if (!Number.isFinite(lastRadius) || lastRadius <= 0) return false;
  // Current radius unknown → knowledge was lost, not gained.
  if (!Number.isFinite(currentRadius) || currentRadius <= 0) return false;
  if (currentRadius >= lastRadius) return false;

  const reductionPct = ((lastRadius - currentRadius) / lastRadius) * 100;
  return reductionPct >= requiredPct;
}

// ---------------------------------------------------------------------------
// Main Detector
// ---------------------------------------------------------------------------

/**
 * Compare current event state against the last-sent snapshot to identify
 * any meaningful changes that trigger a re-send.
 *
 * @returns Array of change reasons. Empty array = no meaningful change.
 */
export function detectChanges(
  current: NotificationSnapshot,
  last: NotificationSnapshot,
  policy: DeduplicationPolicy,
): ChangeReason[] {
  const triggers: ChangeReason[] = [];

  // 1. Priority Level Increased (e.g. P1 -> P0)
  if (isPriorityLevelIncreased(current.priorityLevel, last.priorityLevel)) {
    triggers.push("PRIORITY_LEVEL_INCREASED");
  }

  // 2. Priority Score Jumped (e.g. +15 points)
  if (current.priorityScore - last.priorityScore >= policy.minScoreDelta) {
    triggers.push("PRIORITY_SCORE_JUMPED");
  }

  // 3. Correlation Confidence Improved (e.g. NONE -> HIGH)
  if (isCorrelationImproved(current.corrConfidence, last.corrConfidence, policy.confidenceOrder)) {
    triggers.push("CORRELATION_IMPROVED");
  }

  // 4. Localization Improved (e.g. radius shrank by 25%)
  if (isLocalizationImproved(current.errorRadius, last.errorRadius, policy.localizationImprovementPct)) {
    triggers.push("LOCALIZATION_IMPROVED");
  }

  // 5. Confirmed Lifecycle Stage
  // If the last notification wasn't "confirmed", but this one is, and the policy allows it.
  if (
    policy.sendOnConfirmed &&
    current.lifecycle === "confirmed" &&
    last.lifecycle !== "confirmed"
  ) {
    triggers.push("CONFIRMED_LIFECYCLE");
  }

  return triggers;
}
