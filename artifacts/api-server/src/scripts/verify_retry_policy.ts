/* Verification harness for the retry policy and rate limiter. */
process.env["NOTIFICATION_RETRY_JITTER"] = "0"; // deterministic

import { decideRetry, backoffLadderMs, maxAttempts, idempotencyKey } from "../notifications/retryPolicy.js";
import { tryConsume, inspect, resetRateLimiter } from "../notifications/providers/rateLimiter.js";
import type { DeliveryFailureKind } from "../notifications/providers/types.js";

let fail = 0;
const t = (name: string, cond: boolean, extra = "") => {
  if (!cond) fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  → " + extra : ""}`);
};

console.log("── Permanent failures are never retried ──");
for (const kind of ["configuration", "invalid_payload"] as DeliveryFailureKind[]) {
  const d = decideRetry(kind, 0);
  t(`${kind} → fail immediately on attempt 0`, d.action === "fail");
}
t("revoked webhook explains itself",
  (decideRetry("configuration", 0) as any).reason.includes("revoked"));

console.log("\n── Transient failures follow the ladder ──");
const ladder = backoffLadderMs();
t("ladder matches spec (0,5s,30s,2m,10m)",
  JSON.stringify(ladder) === JSON.stringify([0, 5000, 30000, 120000, 600000]),
  JSON.stringify(ladder));
for (const kind of ["provider_error", "network", "timeout"] as DeliveryFailureKind[]) {
  const delays: number[] = [];
  for (let a = 0; a < ladder.length; a++) {
    const d = decideRetry(kind, a);
    if (d.action === "retry") delays.push(d.delayMs);
  }
  t(`${kind} walks the ladder`, JSON.stringify(delays) === JSON.stringify(ladder), JSON.stringify(delays));
}

console.log("\n── Attempts are bounded ──");
const exhausted = decideRetry("network", maxAttempts());
t("stops at maxAttempts", exhausted.action === "fail",
  exhausted.action === "fail" ? exhausted.reason : "");
t("does not retry forever", decideRetry("network", 99).action === "fail");

console.log("\n── Rate limiting does NOT consume the attempt budget ──");
const rl = decideRetry("rate_limited", 3, 12_000);
t("rate limit reschedules", rl.action === "retry");
t("attempt count unchanged", rl.action === "retry" && rl.nextAttempt === 3,
  rl.action === "retry" ? `nextAttempt=${rl.nextAttempt}` : "");
t("does not count as an attempt", rl.action === "retry" && rl.countsAsAttempt === false);
t("honours provider retryAfter", rl.action === "retry" && rl.delayMs === 12_000,
  rl.action === "retry" ? `${rl.delayMs}ms` : "");
t("rate limit at max attempts still retries",
  decideRetry("rate_limited", 99).action === "retry");

console.log("\n── Provider retryAfter wins when longer ──");
const longer = decideRetry("provider_error", 1, 60_000);
t("uses 60s over ladder's 5s", longer.action === "retry" && longer.delayMs === 60_000,
  longer.action === "retry" ? `${longer.delayMs}ms` : "");

console.log("\n── Jitter spreads a thundering herd ──");
process.env["NOTIFICATION_RETRY_JITTER"] = "0.2";
const seen = new Set<number>();
for (let i = 0; i < 50; i++) {
  const d = decideRetry("network", 2, undefined, Math.random);
  if (d.action === "retry") seen.add(d.delayMs);
}
t("jittered delays are not identical", seen.size > 10, `${seen.size} distinct values`);
const all = [...seen];
t("stays within ±20% of 30s", all.every((v) => v >= 24_000 && v <= 36_000),
  `min=${Math.min(...all)} max=${Math.max(...all)}`);
process.env["NOTIFICATION_RETRY_JITTER"] = "0";

console.log("\n── Idempotency key ──");
const k1 = idempotencyKey({ eventId: "GRB1", revisionCount: 0, subscriptionId: 7n, channel: "wechat" });
const k2 = idempotencyKey({ eventId: "GRB1", revisionCount: 0, subscriptionId: 7n, channel: "wechat" });
t("stable for the same delivery", k1 === k2, k1);
t("differs by revision",
  k1 !== idempotencyKey({ eventId: "GRB1", revisionCount: 1, subscriptionId: 7n, channel: "wechat" }));
t("differs by subscriber",
  k1 !== idempotencyKey({ eventId: "GRB1", revisionCount: 0, subscriptionId: 8n, channel: "wechat" }));
t("differs by channel",
  k1 !== idempotencyKey({ eventId: "GRB1", revisionCount: 0, subscriptionId: 7n, channel: "email" }));

console.log("\n── Rate limiter: sliding window ──");
resetRateLimiter();
const T0 = 1_000_000;
let admitted = 0;
for (let i = 0; i < 25; i++) if (tryConsume("robotA", 20, T0 + i).allowed) admitted++;
t("admits exactly the limit in one window", admitted === 20, `${admitted}/25`);
const blocked = tryConsume("robotA", 20, T0 + 30);
t("blocks the 21st", !blocked.allowed);
t("reports when a slot frees", blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 60_000,
  `${blocked.retryAfterMs}ms`);
t("separate credentials have separate budgets", tryConsume("robotB", 20, T0 + 30).allowed);
t("window slides — allowed after 60s", tryConsume("robotA", 20, T0 + 60_001).allowed);
t("inspect is non-mutating",
  inspect("robotB", T0 + 30).used === inspect("robotB", T0 + 30).used);

console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
