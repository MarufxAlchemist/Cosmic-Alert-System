/**
 * wecomWebhook.test.ts
 * --------------------
 * The WeCom provider: URL validation (which is the SSRF control), byte-aware
 * truncation, message rendering, and health honesty.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  capturedMessages,
  clearCapturedMessages,
  parseWebhookUrl,
  truncateToBytes,
  wecomProvider,
} from "./wecomWebhook.js";
import { renderWeComMarkdown } from "./formatter.js";
import { isEncrypted } from "../secrets.js";
import type { NotificationPayload } from "../types.js";

const KEY = "693a91f6-7xxx-4bc4-97a0-0ec2sifa5aaa";
const GOOD = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${KEY}`;

beforeAll(() => {
  process.env["NOTIFICATION_ENCRYPTION_KEY"] =
    "9f2b7c1e4a8d0356f1b9e7c2a4d68015392b7ce4a1d80f56239b7ce4a1d80f56";
  process.env["NOTIFICATION_TEST_MODE"] = "true";
});

describe("webhook URL validation — the SSRF control", () => {
  it("accepts an official WeCom robot webhook", () => {
    expect(parseWebhookUrl(GOOD).errors).toHaveLength(0);
  });

  it.each([
    ["cleartext http would expose the key in transit", GOOD.replace("https:", "http:")],
    ["cloud metadata endpoint", "https://169.254.169.254/latest/meta-data/"],
    ["internal docker service", `https://postgres:5432/cgi-bin/webhook/send?key=${KEY}`],
    ["localhost", `https://localhost/cgi-bin/webhook/send?key=${KEY}`],
    ["lookalike domain", `https://qyapi.weixin.qq.com.attacker.cn/cgi-bin/webhook/send?key=${KEY}`],
    ["wrong path on the right host", `https://qyapi.weixin.qq.com/cgi-bin/gettoken?key=${KEY}`],
    ["missing key", "https://qyapi.weixin.qq.com/cgi-bin/webhook/send"],
    ["implausibly short key", "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc"],
    ["not a URL", "not a url"],
    ["empty", ""],
  ])("rejects %s", (_label, url) => {
    expect(parseWebhookUrl(url).errors.length).toBeGreaterThan(0);
  });

  it("names the offending host so the user can fix it", () => {
    const { errors } = parseWebhookUrl("https://evil.test/cgi-bin/webhook/send?key=" + KEY);
    expect(errors.join(" ")).toContain("evil.test");
  });
});

describe("byte-aware truncation", () => {
  it("leaves short strings untouched", () => {
    expect(truncateToBytes("hello", 4096)).toBe("hello");
  });

  it("budgets BYTES, not characters", () => {
    // 3 bytes per character in UTF-8: 3000 characters is ~9 KB. Truncating by
    // String.length would produce a payload WeCom rejects.
    const cn = "警报".repeat(3000);
    const out = truncateToBytes(cn, 4096);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(4096);
  });

  it("never splits a UTF-8 codepoint", () => {
    const out = truncateToBytes("警报".repeat(3000), 4095);
    expect(out).not.toContain("�");
  });

  it("marks that content was removed", () => {
    expect(truncateToBytes("x".repeat(9000), 4096)).toContain("truncated");
  });
});

describe("message rendering", () => {
  const payload = (event: Record<string, unknown>): NotificationPayload => ({
    idempotencyKey: "k", eventId: "GRB260813A", revisionCount: 0, priority: "HIGH", event,
  });

  it("omits UNKNOWN measurements instead of printing zero", () => {
    const out = renderWeComMarkdown(payload({
      eventId: "GRB260813A", eventType: "GRB", observatory: "Fermi (GBM)",
      ra: 231.42, dec: -57.75, snr: null, far: null, t90: null, fluence: null,
    }));
    expect(out).not.toMatch(/SNR/);
    expect(out).not.toMatch(/FAR/);
    expect(out).not.toMatch(/T90/);
    expect(out).not.toMatch(/null|undefined|NaN/);
    expect(out).toContain("231.4200");
  });

  it("states when the source did not give a containment convention", () => {
    const out = renderWeComMarkdown(payload({ errorRadius: 148.8 }));
    expect(out).toContain("containment not stated");
  });

  it("quotes the convention when the source did state it", () => {
    const out = renderWeComMarkdown(payload({ errorRadius: 148.8, errorRadiusContainment: "90_2D" }));
    expect(out).toContain("90 2D");
  });

  it("labels a revision so it is not read as a new burst", () => {
    const out = renderWeComMarkdown({ ...payload({ eventType: "GRB" }), revisionCount: 3 });
    expect(out).toMatch(/Revision/);
  });

  it("marks a retraction prominently", () => {
    const out = renderWeComMarkdown(payload({ isRetraction: true }));
    expect(out).toMatch(/RETRACTED/);
  });

  it("distinguishes signalness from SNR", () => {
    // These were conflated in one column before Phase 2: signalness is a
    // probability, SNR is a significance in sigma.
    const out = renderWeComMarkdown(payload({ signalness: 0.87 }));
    expect(out).toContain("astrophysical");
    expect(out).not.toMatch(/\bSNR\b/);
  });
});

describe("storage and sending", () => {
  beforeEach(() => clearCapturedMessages());

  it("encrypts on the way to storage and exposes only a redacted display", () => {
    const { config, display } = wecomProvider.prepareForStorage({ webhookUrl: GOOD });
    expect(isEncrypted(config.webhookUrl)).toBe(true);
    expect(config.webhookUrl).not.toContain(KEY);
    expect(display).not.toContain(KEY);
    expect(display).toContain("••••");
  });

  it("refuses to store an invalid configuration", () => {
    expect(() => wecomProvider.prepareForStorage({ webhookUrl: "http://evil.test" })).toThrow();
  });

  it("captures instead of sending in test mode, with a redacted target", async () => {
    const { config } = wecomProvider.prepareForStorage({ webhookUrl: GOOD });
    const res = await wecomProvider.test(config);
    expect(res.ok).toBe(true);
    expect(capturedMessages()).toHaveLength(1);
    expect(capturedMessages()[0]!.target).not.toContain(KEY);
  });

  it("reports a broken configuration rather than attempting a request", async () => {
    const res = await wecomProvider.send({ webhookUrl: "http://evil.test" }, {
      idempotencyKey: "k", eventId: "E", revisionCount: 0, priority: "LOW", event: {},
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe("configuration");
  });
});

describe("health is honest", () => {
  it("does not claim 'connected' merely because a URL exists", async () => {
    const { config } = wecomProvider.prepareForStorage({ webhookUrl: GOOD });
    const h = await wecomProvider.healthCheck(config);
    // WeCom has no non-sending validation endpoint, so reachability is unknown
    // until something is actually delivered.
    expect(h.status).toBe("unknown");
    expect(h.status).not.toBe("connected");
  });

  it("reports a missing configuration as such", async () => {
    const h = await wecomProvider.healthCheck({ webhookUrl: "" });
    expect(h.status).toBe("configuration_required");
  });
});

describe("declared limits match WeCom's documented ceilings", () => {
  it("20 messages per minute", () => {
    expect(wecomProvider.limits.maxMessagesPerMinute).toBe(20);
  });
  it("markdown byte cap", () => {
    expect(wecomProvider.limits.maxContentBytes).toBe(4096);
  });
  it("bounds outbound requests", () => {
    expect(wecomProvider.limits.requestTimeoutMs).toBeGreaterThan(0);
  });
});
