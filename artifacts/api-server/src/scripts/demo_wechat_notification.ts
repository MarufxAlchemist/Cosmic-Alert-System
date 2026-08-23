/**
 * demo_wechat_notification.ts
 * ---------------------------
 * End-to-end demonstration of the WeChat channel using the mock transport.
 *
 * Runs with NOTIFICATION_TEST_MODE=true, so nothing leaves the process. This
 * exercises the real provider, the real formatter, the real rate limiter and
 * the real retry policy — only the outbound HTTP call is captured instead of
 * sent.
 *
 * Run:
 *   tsx src/scripts/demo_wechat_notification.ts
 */

process.env["NOTIFICATION_ENCRYPTION_KEY"] ??=
  "9f2b7c1e4a8d0356f1b9e7c2a4d68015392b7ce4a1d80f56239b7ce4a1d80f56";
process.env["NOTIFICATION_TEST_MODE"] = "true";
process.env["NOTIFICATION_RETRY_JITTER"] = "0";

import { wecomProvider } from "../notifications/providers/wechat/wecomWebhook.js";
import { capturedMessages, clearCapturedMessages } from "../notifications/providers/wechat/wecomWebhook.js";
import { tryConsume, resetRateLimiter } from "../notifications/providers/rateLimiter.js";
import { decideRetry, idempotencyKey } from "../notifications/retryPolicy.js";
import type { NotificationPayload } from "../notifications/providers/types.js";

const rule = (s: string) => console.log(`\n${"═".repeat(72)}\n${s}\n${"═".repeat(72)}`);

// A demonstration webhook. Structurally valid, deliberately NOT a real robot:
// no message can reach a real group without a credential from the WeCom console.
const DEMO_WEBHOOK =
  "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=demo0000-0000-4000-a000-000000000001";

// GRB 260813A — the real Fermi GBM burst from GCN Circular 45377, as the
// pipeline normalises it. Note snr/far/t90 are genuinely absent for this
// notice; the formatter must omit them rather than print zeros.
const EVENT = {
  eventId: "GRB808341387",
  eventType: "GRB",
  observatory: "Fermi (GBM)",
  detectionTime: "2026-08-13T19:16:22.090Z",
  lifecycle: "confirmed",
  ra: 231.42,
  dec: -57.75,
  errorRadius: 148.8,            // arcmin  = 2.48°, matches the circular
  errorRadiusContainment: null,  // Fermi does not state one
  snr: 17.2,
  far: null,
  t90: null,
  fluence: null,
  qualityScore: 89,
  validation: { status: "WARNING" },
  interestScore: 45,
};

async function main() {
  rule("1. STORING THE CREDENTIAL");
  const { config, display } = wecomProvider.prepareForStorage({ webhookUrl: DEMO_WEBHOOK });
  console.log("What the user pasted     :", DEMO_WEBHOOK);
  console.log("What is stored in the DB :", config.webhookUrl.slice(0, 48) + "…  (AES-256-GCM)");
  console.log("What the UI ever shows   :", display);
  console.log("What any GET returns     :", display, " ← the key never comes back");

  rule("2. VALIDATION REJECTS WHAT IT SHOULD");
  for (const bad of [
    "http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x0123456789abcdef",
    "https://169.254.169.254/latest/meta-data/",
    "https://qyapi.weixin.qq.com.attacker.cn/cgi-bin/webhook/send?key=x0123456789abcdef",
  ]) {
    const v = wecomProvider.validateConfiguration({ webhookUrl: bad });
    console.log(`  ${v.valid ? "ACCEPT" : "REJECT"}  ${bad.slice(0, 58)}`);
    if (!v.valid) console.log(`          → ${v.errors[0]}`);
  }

  rule("3. THE MESSAGE A WECHAT SUBSCRIBER RECEIVES");
  clearCapturedMessages();
  const payload: NotificationPayload = {
    idempotencyKey: idempotencyKey({
      eventId: EVENT.eventId, revisionCount: 0, subscriptionId: 42n, channel: "wechat",
    }),
    eventId: EVENT.eventId,
    revisionCount: 0,
    priority: "HIGH",
    event: EVENT,
    eventUrl: "https://astrosentinel.example.org/events/GRB808341387",
  };
  const res = await wecomProvider.send(config, payload);
  const msg = capturedMessages()[0]!;
  console.log(`delivery: ${res.ok ? "accepted" : "failed"}   msgtype: ${msg.msgtype}   ` +
              `${Buffer.byteLength(msg.content, "utf8")} bytes / ${wecomProvider.limits.maxContentBytes} max`);
  console.log(`target  : ${msg.target}\n`);
  console.log("┌─ WeCom message ".padEnd(72, "─"));
  for (const line of msg.content.split("\n")) console.log("│ " + line);
  console.log("└".padEnd(72, "─"));
  console.log("\nNote: FAR, T90 and fluence are absent from this notice and are");
  console.log("OMITTED — not rendered as 0. Containment is stated as unstated.");

  rule("4. IDEMPOTENCY — A REDELIVERED NOTICE DOES NOT RE-ALERT");
  const k = (rev: number, sub: bigint) =>
    idempotencyKey({ eventId: EVENT.eventId, revisionCount: rev, subscriptionId: sub, channel: "wechat" });
  console.log("same notice, same subscriber :", k(0, 42n));
  console.log("                             :", k(0, 42n), "← identical, UNIQUE index rejects the 2nd insert");
  console.log("revision 1 (new information) :", k(1, 42n), "← distinct, this one alerts");
  console.log("different subscriber         :", k(0, 43n), "← distinct, they get their own");

  rule("5. RATE LIMIT — A GCN BURST CANNOT FLOOD THE GROUP");
  resetRateLimiter();
  const t0 = Date.now();
  let sent = 0, throttled = 0, firstRetry = 0;
  for (let i = 0; i < 25; i++) {
    const d = tryConsume("demo-robot", wecomProvider.limits.maxMessagesPerMinute, t0 + i);
    if (d.allowed) sent++;
    else { throttled++; if (!firstRetry) firstRetry = d.retryAfterMs; }
  }
  console.log(`25 alerts arrive at once → ${sent} sent, ${throttled} deferred`);
  console.log(`WeCom's limit is ${wecomProvider.limits.maxMessagesPerMinute}/min; the rest retry in ~${Math.round(firstRetry / 1000)}s.`);
  console.log("Deferred alerts are NOT dropped and do NOT consume their retry budget.");

  rule("6. FAILURE HANDLING");
  const scenarios = [
    ["WeCom errcode 94000 (webhook deleted)", "configuration" as const, undefined],
    ["WeCom errcode 45009 (rate limited)",    "rate_limited" as const,  8_000],
    ["WeCom 500 (Tencent-side outage)",       "provider_error" as const, undefined],
    ["connection timeout",                    "timeout" as const,       undefined],
  ];
  for (const [label, kind, hint] of scenarios) {
    const d = decideRetry(kind, 1, hint as number | undefined);
    if (d.action === "fail") console.log(`  ${label}\n     → STOP. ${d.reason}`);
    else console.log(`  ${label}\n     → retry in ${d.delayMs} ms` +
                     `${d.countsAsAttempt ? "" : "  (does not consume an attempt)"}`);
  }

  rule("WHAT THIS DEMO CANNOT PROVE");
  console.log("Every step above ran against the mock transport. The one thing");
  console.log("still unverified is that Tencent accepts the payload, which needs");
  console.log("a real robot webhook from the WeCom console. Everything up to the");
  console.log("HTTP boundary is exercised here.");
}

void main();
