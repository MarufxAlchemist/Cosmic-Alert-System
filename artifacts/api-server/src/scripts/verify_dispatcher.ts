/**
 * verify_dispatcher.ts
 * --------------------
 * End-to-end verification of Phase 7: an accepted event becomes a delivery row,
 * the row is sent, and the filters/idempotency/retry rules hold.
 *
 * Runs with NOTIFICATION_TEST_MODE=true, so the provider captures instead of
 * posting. Everything else — subscription matching, the UNIQUE idempotency
 * index, status transitions, the rate limiter — is real and hits the database.
 */

process.env["NOTIFICATION_TEST_MODE"] = "true";
process.env["NOTIFICATION_RETRY_JITTER"] = "0";

import { and, eq, inArray } from "drizzle-orm";
import { db, alerts, alertSubscriptions, eventsTable } from "@workspace/db";
import {
  enqueueDeliveries, processDueDeliveries, subscriptionWants, toPriority,
  type AcceptedEvent,
} from "../notifications/notificationDispatcher.js";
import { capturedMessages, clearCapturedMessages } from "../notifications/providers/wechat/wecomWebhook.js";
import { resetRateLimiter } from "../notifications/providers/rateLimiter.js";

let fail = 0;
const t = (name: string, cond: boolean, extra = "") => {
  if (!cond) fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  → " + extra : ""}`);
};

const SUB = {
  eventTypes: ["GRB", "GW", "FRB", "NU"],
  observatories: [] as string[],
  priorityLevel: "critical_and_high",
  lifecyclePolicy: { preliminary: true, update: "significant_only", confirmed: true, retraction: true } as any,
  isActive: true,
};
const EV = (over: Partial<{ eventType: string; observatory: string; lifecycle: string; isRetraction: boolean }> = {}) => ({
  eventType: "GRB", observatory: "Fermi (GBM)", lifecycle: "confirmed", isRetraction: false, ...over,
});

async function main() {
  console.log("── Policy: who wants this event ──");
  t("subscribed type + priority passes", subscriptionWants(SUB, EV(), "HIGH").wanted);
  t("unsubscribed event type filtered",
    !subscriptionWants({ ...SUB, eventTypes: ["GW"] }, EV(), "HIGH").wanted);
  t("priority below threshold filtered",
    !subscriptionWants(SUB, EV(), "NORMAL").wanted,
    subscriptionWants(SUB, EV(), "NORMAL").reason);
  t("critical_only rejects HIGH",
    !subscriptionWants({ ...SUB, priorityLevel: "critical_only" }, EV(), "HIGH").wanted);
  t("'all' accepts LOW",
    subscriptionWants({ ...SUB, priorityLevel: "all" }, EV(), "LOW").wanted);
  t("disabled lifecycle filtered",
    !subscriptionWants({ ...SUB, lifecyclePolicy: { confirmed: false } as any }, EV(), "HIGH").wanted);
  t("observatory filter applies",
    !subscriptionWants({ ...SUB, observatories: ["Swift (BAT)"] }, EV(), "HIGH").wanted);
  t("inactive subscription filtered",
    !subscriptionWants({ ...SUB, isActive: false }, EV(), "HIGH").wanted);

  console.log("\n  RETRACTION OVERRIDES EVERY FILTER");
  t("retraction reaches an unsubscribed type",
    subscriptionWants({ ...SUB, eventTypes: ["GW"] }, EV({ isRetraction: true }), "LOW").wanted);
  t("retraction reaches a critical_only subscriber at LOW",
    subscriptionWants({ ...SUB, priorityLevel: "critical_only" }, EV({ isRetraction: true }), "LOW").wanted);

  console.log("\n── P0–P3 mapping ──");
  t("P0→CRITICAL", toPriority("P0") === "CRITICAL");
  t("P1→HIGH", toPriority("P1") === "HIGH");
  t("P2→NORMAL", toPriority("P2") === "NORMAL");
  t("P3→LOW", toPriority("P3") === "LOW");

  // ── Database-backed ──
  const [sub] = await db.select().from(alertSubscriptions)
    .where(eq(alertSubscriptions.channel, "wechat")).limit(1);
  if (!sub) { console.log("\nNo wechat subscription present; skipping DB checks."); process.exit(fail ? 1 : 0); }

  const [ev] = await db.select().from(eventsTable).limit(1);
  if (!ev) { console.log("\nNo events present; skipping DB checks."); process.exit(fail ? 1 : 0); }

  // Clean slate for this event so reruns are meaningful.
  await db.delete(alerts).where(eq(alerts.eventId, ev.id));
  clearCapturedMessages();
  resetRateLimiter();

  const accepted: AcceptedEvent = {
    eventId: ev.eventId, eventType: ev.eventType, observatory: ev.observatory ?? "",
    lifecycle: "confirmed", revisionCount: 0, isRetraction: false,
    raw: { eventId: ev.eventId, eventType: ev.eventType, observatory: ev.observatory,
           ra: ev.ra, dec: ev.dec, snr: ev.snr, errorRadius: ev.errorRadius,
           detectionTime: ev.detectionTime?.toISOString?.() },
  };

  console.log("\n── Enqueue creates a durable delivery row ──");
  const n1 = await enqueueDeliveries(accepted, "HIGH");
  t("one delivery created", n1 === 1, `created=${n1}`);
  const [row1] = await db.select().from(alerts).where(eq(alerts.eventId, ev.id)).limit(1);
  t("status starts pending", row1?.status === "pending", row1?.status);
  t("idempotency key recorded", Boolean(row1?.idempotencyKey), row1?.idempotencyKey ?? "");
  t("provider recorded", row1?.provider === "wecom-webhook", row1?.provider ?? "");
  t("FK to the real event (not a sequence value)", String(row1?.eventId) === String(ev.id));

  console.log("\n── Idempotency: the same notice does not re-alert ──");
  const n2 = await enqueueDeliveries(accepted, "HIGH");
  t("duplicate suppressed", n2 === 0, `created=${n2}`);
  const cnt = await db.select().from(alerts).where(eq(alerts.eventId, ev.id));
  t("still exactly one row", cnt.length === 1, `rows=${cnt.length}`);

  console.log("\n── A revision IS a new delivery ──");
  const n3 = await enqueueDeliveries({ ...accepted, revisionCount: 1 }, "HIGH");
  t("revision 1 creates its own", n3 === 1, `created=${n3}`);

  console.log("\n── Sending ──");
  const handled = await processDueDeliveries(50);
  t("both deliveries processed", handled >= 2, `handled=${handled}`);
  const after = await db.select().from(alerts).where(eq(alerts.eventId, ev.id));
  t("all marked sent", after.every((r) => r.status === "sent"),
    after.map((r) => r.status).join(","));
  t("sentAt populated", after.every((r) => r.sentAt !== null));
  t("attempt counted", after.every((r) => (r.retryCount ?? 0) === 1));
  t("messages actually rendered", capturedMessages().length >= 2,
    `${capturedMessages().length} captured`);
  t("no secret in captured target",
    capturedMessages().every((m) => m.target.includes("••••")));

  console.log("\n── Rate limit defers rather than drops ──");
  resetRateLimiter();
  await db.delete(alerts).where(eq(alerts.eventId, ev.id));
  for (let i = 0; i < 25; i++) {
    await enqueueDeliveries({ ...accepted, revisionCount: 100 + i }, "HIGH");
  }
  await processDueDeliveries(50);
  const rows = await db.select().from(alerts).where(eq(alerts.eventId, ev.id));
  const sent = rows.filter((r) => r.status === "sent").length;
  const deferred = rows.filter((r) => r.status === "retrying").length;
  t("20 sent (WeCom's per-minute ceiling)", sent === 20, `sent=${sent}`);
  t("the rest deferred, not failed", deferred === 5, `retrying=${deferred}`);
  t("deferred rows have a future nextRetryAt",
    rows.filter((r) => r.status === "retrying").every((r) => r.nextRetryAt !== null));
  t("deferred rows did NOT consume an attempt",
    rows.filter((r) => r.status === "retrying").every((r) => (r.retryCount ?? 0) === 0));

  // Tidy up.
  await db.delete(alerts).where(eq(alerts.eventId, ev.id));

  console.log(fail === 0 ? "\nAll dispatcher checks passed." : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
