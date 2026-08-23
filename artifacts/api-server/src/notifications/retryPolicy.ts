/**
 * retryPolicy.ts
 * --------------
 * When to try a failed delivery again, and when to stop.
 *
 * Pure functions over the failure taxonomy in providers/types.ts, with no I/O,
 * so the policy can be exercised exhaustively without a database or a network.
 *
 * TWO RULES THAT MATTER MORE THAN THE NUMBERS
 *
 * 1. PERMANENT FAILURES ARE NOT RETRIED. A revoked webhook (WeCom 94000) or a
 *    rejected payload will fail identically on every attempt. Retrying it five
 *    times with backoff accomplishes nothing except occupying queue slots and
 *    delaying the moment the user is told their configuration is broken. The
 *    provider classifies; this decides.
 *
 * 2. RATE LIMITING IS NOT A FAILURE. Hitting 20/minute means the message was
 *    never delivered and should be sent shortly — it must not consume the
 *    attempt budget, or a burst of GCN traffic would exhaust the retries of
 *    every alert in it and drop them all. Rate-limited attempts are rescheduled
 *    without incrementing the attempt count.
 *
 * Jitter is applied to the backoff so that a provider outage which fails a
 * hundred queued deliveries at once does not retry all hundred at the same
 * instant, producing a synchronised thundering herd against a service that is
 * already unwell.
 */

import { isPermanentFailure, type DeliveryFailureKind } from "./providers/types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Backoff ladder in milliseconds, per the spec:
 *   attempt 1 → immediate, 2 → 5 s, 3 → 30 s, 4 → 2 min, 5 → 10 min
 * Overridable so an operator can tune without a rebuild.
 */
export function backoffLadderMs(): number[] {
  const raw = process.env["NOTIFICATION_RETRY_BACKOFF_MS"];
  if (raw && raw.trim()) {
    const parts = raw.split(",").map((s) => Number.parseInt(s.trim(), 10));
    if (parts.length && parts.every((n) => Number.isFinite(n) && n >= 0)) return parts;
  }
  return [0, 5_000, 30_000, 120_000, 600_000];
}

export function maxAttempts(): number {
  return envInt("NOTIFICATION_MAX_ATTEMPTS", backoffLadderMs().length);
}

/** ±20% by default. 0 disables, which makes tests deterministic. */
function jitterFraction(): number {
  const raw = process.env["NOTIFICATION_RETRY_JITTER"];
  if (raw === undefined) return 0.2;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 && n < 1 ? n : 0.2;
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export type RetryDecision =
  | { action: "retry"; delayMs: number; nextAttempt: number; countsAsAttempt: boolean }
  | { action: "fail"; reason: string };

/**
 * @param kind         how the provider classified the failure
 * @param attemptsMade attempts already completed (0 before the first)
 * @param retryAfterMs provider-supplied hint, honoured when longer than ours
 */
export function decideRetry(
  kind: DeliveryFailureKind,
  attemptsMade: number,
  retryAfterMs?: number,
  rand: () => number = Math.random,
): RetryDecision {
  if (isPermanentFailure(kind)) {
    return {
      action: "fail",
      reason:
        kind === "configuration"
          ? "Configuration is invalid or the credential was revoked. Retrying cannot succeed; the subscription needs attention."
          : "The provider rejected the message itself. Retrying an identical payload cannot succeed.",
    };
  }

  // Rate limiting: reschedule without spending an attempt (see rule 2).
  if (kind === "rate_limited") {
    const delayMs = Math.max(retryAfterMs ?? 0, 5_000);
    return { action: "retry", delayMs, nextAttempt: attemptsMade, countsAsAttempt: false };
  }

  const ladder = backoffLadderMs();
  const limit = maxAttempts();
  if (attemptsMade >= limit) {
    return {
      action: "fail",
      reason: `Giving up after ${attemptsMade} attempt(s). The provider did not accept the message.`,
    };
  }

  const base = ladder[Math.min(attemptsMade, ladder.length - 1)] ?? 0;
  const f = jitterFraction();
  // Symmetric jitter, floored at zero.
  const jittered = f > 0 ? base * (1 + (rand() * 2 - 1) * f) : base;
  const delayMs = Math.max(0, Math.round(Math.max(jittered, retryAfterMs ?? 0)));

  return { action: "retry", delayMs, nextAttempt: attemptsMade + 1, countsAsAttempt: true };
}

/** Build an idempotency key. Order is fixed so the same delivery always hashes alike. */
export function idempotencyKey(parts: {
  eventId: string;
  revisionCount: number;
  subscriptionId: string | bigint;
  channel: string;
}): string {
  return [parts.eventId, `r${parts.revisionCount}`, String(parts.subscriptionId), parts.channel]
    .join("|");
}
