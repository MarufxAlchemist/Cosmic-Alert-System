/**
 * providers/rateLimiter.ts
 * ------------------------
 * Per-credential outbound rate limiting.
 *
 * THE FAILURE THIS PREVENTS
 * ─────────────────────────
 * GCN traffic is bursty. A single Fermi trigger is re-issued as ALERT →
 * FLT_POS → GND_POS → FIN_POS within minutes, an LVK superevent can produce
 * several notices, and a backlog drain after a reconnect replays everything
 * at once. WeCom allows 20 messages per minute per robot; exceeding it earns
 * errcode 45009 and, sustained, gets the robot throttled.
 *
 * Without a limiter the first busy night silently loses alerts — the ones
 * most worth having.
 *
 * WHY A SLIDING WINDOW, NOT A TOKEN BUCKET
 * ────────────────────────────────────────
 * The provider's limit is literally "N in any 60 seconds". A token bucket
 * with a refill rate approximates that but permits a burst of N immediately
 * after a quiet period plus another N moments later, which straddles the
 * window boundary and trips the very limit it is meant to respect. Recording
 * timestamps and counting those inside the window matches the stated rule
 * exactly, and at 20/minute the array is trivially small.
 *
 * SCOPE: keyed per credential, not per provider class. Two labs with separate
 * WeCom robots have separate limits, and one lab's burst must not consume
 * another's allowance.
 *
 * This is in-process. With a single api-server container that is exact; if it
 * is ever scaled horizontally the limiter must move to Postgres or Redis, and
 * that is called out in the docs rather than silently assumed away.
 */

const WINDOW_MS = 60_000;

interface Bucket {
  /** Epoch-ms of each send admitted inside the window. */
  hits: number[];
  limit: number;
}

const buckets = new Map<string, Bucket>();

function prune(b: Bucket, now: number): void {
  const cutoff = now - WINDOW_MS;
  // Timestamps are appended in order, so dropping from the front is enough.
  let i = 0;
  while (i < b.hits.length && b.hits[i]! <= cutoff) i++;
  if (i > 0) b.hits.splice(0, i);
}

export interface RateDecision {
  allowed: boolean;
  /** When blocked, how long until a slot frees. */
  retryAfterMs: number;
  /** Remaining allowance in the current window. */
  remaining: number;
}

/**
 * Ask whether one send may proceed. Records the send when it may.
 *
 * Deliberately a single call rather than check-then-record: two async
 * dispatcher slots interleaving between a separate check and record would
 * both observe capacity and both send.
 */
export function tryConsume(key: string, limitPerMinute: number, now = Date.now()): RateDecision {
  let b = buckets.get(key);
  if (!b || b.limit !== limitPerMinute) {
    b = { hits: b?.hits ?? [], limit: limitPerMinute };
    buckets.set(key, b);
  }
  prune(b, now);

  if (b.hits.length < limitPerMinute) {
    b.hits.push(now);
    return { allowed: true, retryAfterMs: 0, remaining: limitPerMinute - b.hits.length };
  }

  // Blocked: a slot frees when the oldest hit leaves the window.
  const oldest = b.hits[0]!;
  return {
    allowed: false,
    retryAfterMs: Math.max(1, oldest + WINDOW_MS - now),
    remaining: 0,
  };
}

/** Non-mutating view, for health reporting and tests. */
export function inspect(key: string, now = Date.now()): { used: number; limit: number } {
  const b = buckets.get(key);
  if (!b) return { used: 0, limit: 0 };
  prune(b, now);
  return { used: b.hits.length, limit: b.limit };
}

export function resetRateLimiter(): void {
  buckets.clear();
}
