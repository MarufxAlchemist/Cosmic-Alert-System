/**
 * filterReport.ts
 *
 * In-memory filter statistics tracker.
 *
 * Tracks every event that passes through the kafka bridge:
 *   - received  : raw messages from Kafka (before any check)
 *   - accepted  : passed all quality gates, persisted to DB
 *   - rejected  : blocked by a quality gate, not persisted
 *
 * Rejected events are grouped by:
 *   - topic      : which Kafka topic they came from
 *   - category   : the class of rejection (e.g. "retraction", "mock_event")
 *   - reason     : human-readable detail string
 *
 * Reset is done on each server startup; data is never persisted.
 * A periodic summary is logged every REPORT_INTERVAL_MS milliseconds.
 */

import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RejectionCategory =
  | "retraction"       // alert explicitly retracted by the source
  | "mock_event"       // MDC / developer test superevent (not real)
  | "test_trigger"     // source-level TEST alert_type
  | "engineering"      // engineering / calibration notice
  | "heartbeat"        // periodic heartbeat — not an astrophysical event
  | "low_significance" // FAR too high, SNR too low, or other quality threshold
  | "sub_threshold"    // source explicitly flagged significant=false
  | "not_astrophysical" // source classified the trigger as non-astrophysical
                        // (e.g. Fermi Def_NOT_a_GRB: particle event, solar
                        // flare or known source). Distinct from a test alert
                        // and from a low-significance real detection.
  | "unknown_format"   // payload missing required fields
  | "topic_blocked"    // topic not in the allow-list
  | "duplicate_type";  // alert_type makes this a retraction-adjacent duplicate

export interface RejectedRecord {
  category: RejectionCategory;
  reason: string;
  topic: string;
  eventId?: string;
  count: number;
}

export interface TopicStats {
  received: number;
  accepted: number;
  rejected: number;
}

export interface FilterReport {
  startedAt: string;
  generatedAt: string;
  uptimeSeconds: number;
  totalReceived: number;
  totalAccepted: number;
  totalRejected: number;
  acceptRate: string;
  byTopic: Record<string, TopicStats>;
  rejectedByCategory: Record<RejectionCategory, number>;
  rejectedByReason: { reason: string; topic: string; category: RejectionCategory; count: number }[];
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const _startedAt = new Date();
let _totalReceived = 0;
let _totalAccepted = 0;
let _totalRejected = 0;

const _byTopic = new Map<string, TopicStats>();
const _rejectedByCategory = new Map<RejectionCategory, number>();
const _rejectedReasonKey = new Map<string, RejectedRecord>();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _topicStats(topic: string): TopicStats {
  if (!_byTopic.has(topic)) {
    _byTopic.set(topic, { received: 0, accepted: 0, rejected: 0 });
  }
  return _byTopic.get(topic)!;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function recordReceived(topic: string): void {
  _totalReceived++;
  _topicStats(topic).received++;
}

export function recordAccepted(topic: string): void {
  _totalAccepted++;
  _topicStats(topic).accepted++;
}

export function recordRejected(
  topic: string,
  category: RejectionCategory,
  reason: string,
  eventId?: string,
): void {
  _totalRejected++;
  _topicStats(topic).rejected++;

  // increment category counter
  _rejectedByCategory.set(category, (_rejectedByCategory.get(category) ?? 0) + 1);

  // aggregate by topic+reason key
  const key = `${topic}::${reason}`;
  const existing = _rejectedReasonKey.get(key);
  if (existing) {
    existing.count++;
  } else {
    _rejectedReasonKey.set(key, { category, reason, topic, eventId, count: 1 });
  }
}

export function getReport(): FilterReport {
  const now = new Date();
  const uptimeMs = now.getTime() - _startedAt.getTime();
  const uptimeSeconds = Math.floor(uptimeMs / 1000);

  const byTopic: Record<string, TopicStats> = {};
  _byTopic.forEach((stats, topic) => { byTopic[topic] = { ...stats }; });

  const rejectedByCategory: Record<string, number> = {};
  _rejectedByCategory.forEach((count, cat) => { rejectedByCategory[cat] = count; });

  const rejectedByReason = Array.from(_rejectedReasonKey.values())
    .sort((a, b) => b.count - a.count)
    .map(r => ({ reason: r.reason, topic: r.topic, category: r.category, count: r.count }));

  const acceptRate = _totalReceived > 0
    ? `${((_totalAccepted / _totalReceived) * 100).toFixed(1)}%`
    : "0.0%";

  return {
    startedAt:          _startedAt.toISOString(),
    generatedAt:        now.toISOString(),
    uptimeSeconds,
    totalReceived:      _totalReceived,
    totalAccepted:      _totalAccepted,
    totalRejected:      _totalRejected,
    acceptRate,
    byTopic,
    rejectedByCategory: rejectedByCategory as Record<RejectionCategory, number>,
    rejectedByReason,
  };
}

// ---------------------------------------------------------------------------
// Periodic summary logging (every 5 minutes)
// ---------------------------------------------------------------------------

const REPORT_INTERVAL_MS = 5 * 60 * 1000;

setInterval(() => {
  const r = getReport();
  if (r.totalReceived === 0) return;

  logger.info(
    {
      uptimeSeconds:      r.uptimeSeconds,
      totalReceived:      r.totalReceived,
      totalAccepted:      r.totalAccepted,
      totalRejected:      r.totalRejected,
      acceptRate:         r.acceptRate,
      rejectedByCategory: r.rejectedByCategory,
    },
    "[filter-report] Periodic summary",
  );
}, REPORT_INTERVAL_MS).unref();
