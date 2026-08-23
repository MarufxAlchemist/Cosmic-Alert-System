/**
 * policy.ts — Notification Deduplication Engine (Phase 5.5)
 * ----------------------------------------------------------
 * Reads DEDUP_* environment variables and returns a DeduplicationPolicy.
 *
 * Called once per dispatch — no module-level state.
 *
 * Environment variables
 * ─────────────────────
 *   DEDUP_SCORE_DELTA          Minimum score improvement to re-send       [15]
 *   DEDUP_LOCALIZATION_PCT     Minimum error-radius reduction % to re-send [25]
 *   DEDUP_SEND_ON_CONFIRMED    Always send on "confirmed" lifecycle         [true]
 *
 * Phase 5.5 — Transient Event Detection
 */

import type { DeduplicationPolicy } from "./types.js";

function envFloat(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  const n = parseFloat(raw);
  return isFinite(n) ? n : defaultValue;
}

function envBool(key: string, defaultValue: boolean): boolean {
  const raw = process.env[key]?.toLowerCase();
  if (raw === "true")  return true;
  if (raw === "false") return false;
  return defaultValue;
}

/**
 * Build the active deduplication policy from environment configuration.
 */
export function getDeduplicationPolicy(): DeduplicationPolicy {
  return {
    minScoreDelta:            envFloat("DEDUP_SCORE_DELTA",        15),
    localizationImprovementPct: envFloat("DEDUP_LOCALIZATION_PCT", 25),
    sendOnConfirmed:           envBool("DEDUP_SEND_ON_CONFIRMED",  true),

    // Confidence levels ordered from lowest to highest.
    // A move from lower index → higher index = improvement.
    confidenceOrder: ["NONE", "LOW", "MEDIUM", "HIGH"],
  };
}
