/**
 * engine.ts — Notification Deduplication Engine (Phase 5.5)
 * ----------------------------------------------------------
 * Main decision engine.
 *
 * Exposes decide() which takes the current event state and makes a
 * send/suppress decision based on notification history and policy rules.
 *
 * Phase 5.5 — Transient Event Detection
 */

import { getDeduplicationPolicy } from "./policy.js";
import { getLastSentSnapshot } from "./store.js";
import { detectChanges } from "./changeDetector.js";
import type {
  NotificationSnapshot,
  DeduplicationDecision,
  ChangeReason,
} from "./types.js";
import type { ClassificationResult } from "../../science/priorityEngine/index.js";
import type { CorrelationResult } from "../../science/correlationEngine/index.js";

// ---------------------------------------------------------------------------
// Formatting Helpers
// ---------------------------------------------------------------------------

function formatReason(reason: ChangeReason, current: NotificationSnapshot, last: NotificationSnapshot): string {
  switch (reason) {
    case "FIRST_NOTIFICATION":
      return "First notification (no history)";
    case "PRIORITY_LEVEL_INCREASED":
      return `Priority level increased (${last.priorityLevel} → ${current.priorityLevel})`;
    case "PRIORITY_SCORE_JUMPED":
      return `Priority score increased (${last.priorityScore} → ${current.priorityScore})`;
    case "CORRELATION_IMPROVED":
      return `Correlation confidence improved (${last.corrConfidence} → ${current.corrConfidence})`;
    case "LOCALIZATION_IMPROVED":
      return `Localization improved (Error radius ${last.errorRadius} → ${current.errorRadius} arcmin)`;
    case "RETRACTION_ISSUED":
      return "Retraction issued";
    case "CONFIRMED_LIFECYCLE":
      return "Lifecycle reached CONFIRMED stage";
    default:
      return reason;
  }
}

// ---------------------------------------------------------------------------
// Main Orchestrator
// ---------------------------------------------------------------------------

export interface DecideInput {
  eventId: string;
  lifecycle: string;
  revisionCount: number;
  errorRadius: number;
  isRetraction: boolean;
  classification: ClassificationResult;
  correlation: CorrelationResult;
}

/**
 * Make a deduplication decision for an incoming event revision.
 *
 * @param input - Current event state (merged from payload, classifier, correlation)
 * @returns DeduplicationDecision (send/suppress boolean + human-readable reasons)
 */
export async function decide(input: DecideInput): Promise<DeduplicationDecision> {
  const policy = getDeduplicationPolicy();

  const currentSnapshot: NotificationSnapshot = {
    eventId:        input.eventId,
    lifecycle:      input.lifecycle.toLowerCase(), // normalize
    revisionCount:  input.revisionCount,
    priorityLevel:  input.classification.priority,
    priorityScore:  input.classification.score,
    corrConfidence: input.correlation.confidence,
    errorRadius:    input.errorRadius,
  };

  // 1. Retraction overrides everything
  if (input.isRetraction) {
    return {
      send: true,
      reasons: ["Retraction issued"],
      triggers: ["RETRACTION_ISSUED"],
      isRetraction: true,
    };
  }

  // 2. Fetch history
  const lastSent = await getLastSentSnapshot(input.eventId);

  // 3. No history = always send
  if (!lastSent) {
    return {
      send: true,
      reasons: ["First notification"],
      triggers: ["FIRST_NOTIFICATION"],
      isRetraction: false,
    };
  }

  // 4. Compare state (detect meaningful changes)
  const triggers = detectChanges(currentSnapshot, lastSent, policy);

  // 5. Apply lifecycle-specific gating rules
  let send = false;
  const formattedReasons: string[] = [];

  if (currentSnapshot.lifecycle === "preliminary") {
    // PRELIMINARY shouldn't happen again if we already have history,
    // but if it does (GCN glitch), we only send if something triggered.
    send = triggers.length > 0;
  } else if (currentSnapshot.lifecycle === "initial" || currentSnapshot.lifecycle === "update") {
    // INITIAL and UPDATE are always suppressed UNLESS a trigger condition is met.
    send = triggers.length > 0;
  } else if (currentSnapshot.lifecycle === "confirmed") {
    // CONFIRMED is sent if triggers exist, OR if sendOnConfirmed is true and we haven't sent a confirmed yet.
    send = triggers.length > 0;
  }

  // 6. Format output
  if (send) {
    for (const t of triggers) {
      formattedReasons.push(formatReason(t, currentSnapshot, lastSent));
    }
  } else {
    formattedReasons.push(
      `Suppressed: no meaningful change since last send (revision ${lastSent.revisionCount})`,
    );
  }

  return {
    send,
    reasons: formattedReasons,
    triggers,
    isRetraction: false,
  };
}
