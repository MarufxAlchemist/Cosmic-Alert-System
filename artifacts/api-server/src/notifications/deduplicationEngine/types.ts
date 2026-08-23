/**
 * types.ts — Notification Deduplication Engine (Phase 5.5)
 * ---------------------------------------------------------
 * All type definitions. No logic, no I/O.
 *
 * Phase 5.5 — Transient Event Detection
 */

// ---------------------------------------------------------------------------
// Change reasons
// ---------------------------------------------------------------------------

/**
 * Identifies WHY a suppressed revision was promoted to a send.
 * Each constant maps to a configurable threshold.
 */
export type ChangeReason =
  | "FIRST_NOTIFICATION"        // No history exists for this eventId
  | "PRIORITY_LEVEL_INCREASED"  // e.g. P1 → P0
  | "PRIORITY_SCORE_JUMPED"     // Score delta ≥ DEDUP_SCORE_DELTA
  | "CORRELATION_IMPROVED"      // Confidence upgraded (e.g. NONE → HIGH)
  | "LOCALIZATION_IMPROVED"     // Error radius reduced ≥ DEDUP_LOCALIZATION_PCT%
  | "RETRACTION_ISSUED"         // isRetraction = true — always send + halt
  | "CONFIRMED_LIFECYCLE";      // lifecycle = "confirmed" — send on first confirmed notice

// ---------------------------------------------------------------------------
// Notification snapshot
// ---------------------------------------------------------------------------

/**
 * The state of an event at the time a deduplication decision is recorded.
 * Stored in notification_history and read back for change detection.
 */
export interface NotificationSnapshot {
  eventId:        string;
  lifecycle:      string;
  revisionCount:  number;
  priorityLevel:  string;   // "P0" | "P1" | "P2" | "P3"
  priorityScore:  number;   // 0–100
  corrConfidence: string;   // "HIGH" | "MEDIUM" | "LOW" | "NONE"
  /**
   * Localization radius in arcmin. 0 means UNKNOWN — the notice reported no
   * localization — NOT a perfectly-known position. No instrument reports a
   * zero-radius localization, so the two can never be confused legitimately.
   * The containment convention is not carried here, so this value must only
   * ever be compared against another radius from the same source.
   */
  errorRadius:    number;
}

// ---------------------------------------------------------------------------
// Deduplication decision
// ---------------------------------------------------------------------------

/**
 * Output of engine.decide().
 * Consumed by notificationService.ts to gate the email dispatch.
 */
export interface DeduplicationDecision {
  /**
   * true  = send the notification email
   * false = suppress this revision
   */
  send: boolean;

  /**
   * Human-readable reasons for this decision.
   *
   * When send = true:
   *   ["First notification"]
   *   ["Priority increased P1→P0", "Localization improved 31%"]
   *
   * When send = false:
   *   ["Suppressed: no meaningful change since last send (revision 2)"]
   */
  reasons: string[];

  /**
   * The change reasons (enum values) that triggered a send.
   * Empty when send = false.
   */
  triggers: ChangeReason[];

  /**
   * Whether a retraction was detected.
   * When true, notificationService.ts should send regardless of lifecycle
   * and mark the event as terminated in the notification history.
   */
  isRetraction: boolean;
}

// ---------------------------------------------------------------------------
// Policy configuration
// ---------------------------------------------------------------------------

/**
 * Deduplication policy thresholds — read from environment variables.
 * All thresholds have scientifically informed defaults.
 */
export interface DeduplicationPolicy {
  /**
   * Minimum priority score improvement to trigger a re-send.
   * Default: 15 (e.g. FAR drops below threshold and adds +15)
   */
  minScoreDelta: number;

  /**
   * Minimum % reduction in error radius to trigger a localization-improved send.
   * Default: 25 (25% tighter localization is scientifically meaningful)
   */
  localizationImprovementPct: number;

  /**
   * Whether to send on confirmed lifecycle stage even with no other changes.
   * Default: true — researchers should always get the confirmed notice.
   */
  sendOnConfirmed: boolean;

  /**
   * Confidence levels in ascending order — used to detect upgrades.
   * A move from lower index to higher index = improvement.
   */
  confidenceOrder: string[];
}
