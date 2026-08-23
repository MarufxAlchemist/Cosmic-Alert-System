/* Verification harness for the WeCom provider foundation. */
process.env["NOTIFICATION_ENCRYPTION_KEY"] =
  "9f2b7c1e4a8d0356f1b9e7c2a4d68015392b7ce4a1d80f56239b7ce4a1d80f56";
process.env["NOTIFICATION_TEST_MODE"] = "true";

import {
  encryptSecret, decryptSecret, redactSecrets, displayWebhook, isEncrypted,
} from "../notifications/providers/secrets.js";
import {
  wecomProvider, parseWebhookUrl, truncateToBytes,
  capturedMessages, clearCapturedMessages,
} from "../notifications/providers/wechat/wecomWebhook.js";
import { renderWeComMarkdown } from "../notifications/providers/wechat/formatter.js";

const KEY = "693a91f6-7xxx-4bc4-97a0-0ec2sifa5aaa";
const GOOD = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${KEY}`;

let fail = 0;
const t = (name: string, cond: boolean, extra = "") => {
  if (!cond) fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  → " + extra : ""}`);
};

console.log("── URL validation / SSRF ──");
t("accepts official WeCom webhook", parseWebhookUrl(GOOD).errors.length === 0);
for (const [label, url] of [
  ["rejects http (cleartext key)", GOOD.replace("https:", "http:")],
  ["rejects AWS metadata IP", "https://169.254.169.254/latest/meta-data/"],
  ["rejects internal docker host", "https://postgres:5432/cgi-bin/webhook/send?key=" + KEY],
  ["rejects lookalike host", `https://qyapi.weixin.qq.com.evil.tld/cgi-bin/webhook/send?key=${KEY}`],
  ["rejects wrong path", "https://qyapi.weixin.qq.com/cgi-bin/gettoken?key=" + KEY],
  ["rejects missing key", "https://qyapi.weixin.qq.com/cgi-bin/webhook/send"],
  ["rejects garbage", "not a url"],
] as const) {
  t(label, parseWebhookUrl(url).errors.length > 0);
}

console.log("\n── Encryption ──");
const enc = encryptSecret(GOOD);
t("ciphertext is not plaintext", !enc.includes(KEY));
t("marked as encrypted", isEncrypted(enc));
t("round-trips", decryptSecret(enc) === GOOD);
t("nondeterministic (fresh IV)", encryptSecret(GOOD) !== encryptSecret(GOOD));
try {
  const tampered = enc.slice(0, -4) + "AAAA";
  decryptSecret(tampered);
  t("tampering detected", false, "decrypt succeeded on modified ciphertext");
} catch { t("tampering detected", true); }

console.log("\n── Redaction ──");
t("redacts key= in error text", !redactSecrets(`POST ${GOOD} failed`).includes(KEY));
t("redacts bearer token", !redactSecrets("Authorization: Bearer abcdef1234567890").includes("abcdef1234567890"));
const disp = displayWebhook(GOOD);
t("display hides key body", !disp.includes(KEY));
t("display keeps last 4 for disambiguation", disp.includes("5aaa"), disp);

console.log("\n── Byte-aware truncation ──");
const cn = "警报".repeat(3000); // 3 bytes per char in UTF-8
const cut = truncateToBytes(cn, 4096);
t("respects BYTE budget not char count", Buffer.byteLength(cut, "utf8") <= 4096,
  `${Buffer.byteLength(cut, "utf8")} bytes`);
t("no replacement char (clean codepoint boundary)", !cut.includes("�"));
t("short strings untouched", truncateToBytes("hello", 4096) === "hello");

console.log("\n── Formatter: UNKNOWN is omitted, never faked ──");
const sparse = renderWeComMarkdown({
  idempotencyKey: "k", eventId: "GRB260813A", revisionCount: 0, priority: "HIGH",
  event: { eventId: "GRB260813A", eventType: "GRB", observatory: "Fermi (GBM)",
           detectionTime: "2026-08-13T19:16:22Z",
           ra: 231.42, dec: -57.75, errorRadius: 148.8,
           snr: null, far: null, t90: null, fluence: null, dm: null },
});
t("omits null SNR entirely", !/SNR/.test(sparse));
t("omits null FAR entirely", !/FAR/.test(sparse));
t("never prints null/undefined/NaN", !/(null|undefined|NaN)/.test(sparse));
t("shows position that exists", sparse.includes("231.4200"));
t("states containment is unstated", sparse.includes("containment not stated"));

const full = renderWeComMarkdown({
  idempotencyKey: "k", eventId: "GRB1", revisionCount: 2, priority: "CRITICAL",
  event: { eventId: "GRB1", eventType: "GRB", observatory: "Fermi (GBM)",
           snr: 17.2, far: 1.2e-7, t90: 2.31, errorRadius: 148.8,
           errorRadiusContainment: "90_2D", isRetraction: true },
  eventUrl: "https://example.org/events/1",
});
t("marks revision explicitly", full.includes("Revision"));
t("marks retraction explicitly", /RETRACTED/.test(full));
t("quotes stated containment", full.includes("90 2D"));

console.log("\n── Test mode: nothing leaves the process ──");
clearCapturedMessages();
const stored = wecomProvider.prepareForStorage({ webhookUrl: GOOD });
t("stored config is encrypted", isEncrypted(stored.config.webhookUrl));
t("stored config carries redacted display", !stored.display.includes(KEY));
const r = await wecomProvider.test(stored.config);
t("test send reports ok", r.ok === true);
t("message captured, not sent", capturedMessages().length === 1);
t("captured target is redacted", !capturedMessages()[0]!.target.includes(KEY));

console.log("\n── Health is honest ──");
const h = await wecomProvider.healthCheck(stored.config);
t("configured-but-unverified is NOT 'connected'", h.status === "unknown", h.status);
const h2 = await wecomProvider.healthCheck({ webhookUrl: "http://evil.tld" });
t("bad config → configuration_required", h2.status === "configuration_required");

console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
