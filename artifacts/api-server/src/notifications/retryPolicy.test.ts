/**
 * retryPolicy.test.ts
 * -------------------
 * When a failed delivery is tried again, and when it is given up on.
 *
 * The two rules worth protecting with tests are the counter-intuitive ones:
 * a permanent failure must NOT be retried, and a rate limit must NOT count
 * as an attempt.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { backoffLadderMs, decideRetry, idempotencyKey, maxAttempts } from "./retryPolicy.js";
import type { DeliveryFailureKind } from "./providers/types.js";

beforeEach(() => {
  process.env["NOTIFICATION_RETRY_JITTER"] = "0";
  delete process.env["NOTIFICATION_RETRY_BACKOFF_MS"];
  delete process.env["NOTIFICATION_MAX_ATTEMPTS"];
});

describe("permanent failures", () => {
  it.each<DeliveryFailureKind>(["configuration", "invalid_payload"])(
    "%s is never retried, even on the first attempt",
    (kind) => {
      expect(decideRetry(kind, 0).action).toBe("fail");
    },
  );

  it("explains that a revoked credential cannot succeed by retrying", () => {
    const d = decideRetry("configuration", 0);
    expect(d.action).toBe("fail");
    if (d.action === "fail") expect(d.reason).toMatch(/revoked|invalid/i);
  });
});

describe("transient failures", () => {
  const ladder = [0, 5_000, 30_000, 120_000, 600_000];

  it("uses the documented ladder", () => {
    expect(backoffLadderMs()).toEqual(ladder);
  });

  it.each<DeliveryFailureKind>(["provider_error", "network", "timeout"])(
    "%s walks the ladder",
    (kind) => {
      const delays = ladder.map((_, i) => {
        const d = decideRetry(kind, i);
        return d.action === "retry" ? d.delayMs : -1;
      });
      expect(delays).toEqual(ladder);
    },
  );

  it("counts each transient attempt", () => {
    const d = decideRetry("network", 2);
    expect(d.action === "retry" && d.countsAsAttempt).toBe(true);
  });

  it("gives up once attempts are exhausted", () => {
    expect(decideRetry("network", maxAttempts()).action).toBe("fail");
    expect(decideRetry("network", 99).action).toBe("fail");
  });

  it("honours a provider hint when it is longer than our backoff", () => {
    const d = decideRetry("provider_error", 1, 60_000);
    expect(d.action === "retry" && d.delayMs).toBe(60_000);
  });
});

describe("rate limiting is not a failure", () => {
  it("reschedules without consuming an attempt", () => {
    const d = decideRetry("rate_limited", 3, 12_000);
    expect(d.action).toBe("retry");
    if (d.action === "retry") {
      // If a rate limit spent the attempt budget, one burst of GCN traffic
      // would exhaust every queued alert's retries and drop them all.
      expect(d.nextAttempt).toBe(3);
      expect(d.countsAsAttempt).toBe(false);
      expect(d.delayMs).toBe(12_000);
    }
  });

  it("still retries past the attempt limit", () => {
    expect(decideRetry("rate_limited", 999).action).toBe("retry");
  });

  it("floors the wait when the provider gives no hint", () => {
    const d = decideRetry("rate_limited", 0);
    expect(d.action === "retry" && d.delayMs).toBeGreaterThanOrEqual(5_000);
  });
});

describe("jitter", () => {
  it("spreads retries so an outage does not produce a thundering herd", () => {
    process.env["NOTIFICATION_RETRY_JITTER"] = "0.2";
    const seen = new Set<number>();
    for (let i = 0; i < 60; i++) {
      const d = decideRetry("network", 2);
      if (d.action === "retry") seen.add(d.delayMs);
    }
    expect(seen.size).toBeGreaterThan(10);
    for (const v of seen) {
      expect(v).toBeGreaterThanOrEqual(24_000);
      expect(v).toBeLessThanOrEqual(36_000);
    }
  });

  it("is deterministic when disabled", () => {
    const a = decideRetry("network", 1);
    const b = decideRetry("network", 1);
    expect(a.action === "retry" && b.action === "retry" && a.delayMs === b.delayMs).toBe(true);
  });
});

describe("configuration overrides", () => {
  it("accepts a custom ladder", () => {
    process.env["NOTIFICATION_RETRY_BACKOFF_MS"] = "100,200,300";
    expect(backoffLadderMs()).toEqual([100, 200, 300]);
  });

  it("ignores a malformed ladder rather than crashing the dispatcher", () => {
    process.env["NOTIFICATION_RETRY_BACKOFF_MS"] = "abc,def";
    expect(backoffLadderMs()).toEqual([0, 5_000, 30_000, 120_000, 600_000]);
  });
});

describe("idempotency key", () => {
  const base = { eventId: "GRB1", revisionCount: 0, subscriptionId: 7n, channel: "wechat" };

  it("is stable for the same delivery", () => {
    expect(idempotencyKey(base)).toBe(idempotencyKey({ ...base }));
  });

  it.each([
    ["revision", { revisionCount: 1 }],
    ["subscriber", { subscriptionId: 8n }],
    ["channel", { channel: "email" }],
    ["event", { eventId: "GRB2" }],
  ])("differs by %s", (_label, over) => {
    expect(idempotencyKey({ ...base, ...over })).not.toBe(idempotencyKey(base));
  });
});
