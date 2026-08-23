/**
 * providers/wechat/wecomWebhook.ts
 * --------------------------------
 * WeChat delivery via the official WeCom (企业微信) group robot webhook.
 *
 * WHY THIS TRANSPORT
 * ──────────────────
 * There is no official API for sending to a *personal* WeChat account. The
 * things that appear to offer one — QR-login automation, itchat-style
 * protocol reimplementations, desktop-client automation — all work by
 * impersonating a real user's session. They violate Tencent's terms, get
 * accounts banned, and break without notice. None of them are in this file.
 *
 * The supported path is WeCom, Tencent's enterprise product. A group robot
 * webhook is an official, documented, first-party integration:
 *
 *   POST https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<KEY>
 *   Content-Type: application/json
 *   {"msgtype":"markdown","markdown":{"content":"..."}}
 *
 *   Success:  {"errcode":0,"errmsg":"ok"}
 *   Failure:  {"errcode":<n>,"errmsg":"..."}   HTTP is still 200.
 *
 * NOTE THE LAST LINE. WeCom returns HTTP 200 for application-level failures;
 * the real status is in the JSON body. Checking `response.ok` alone reports
 * a revoked webhook as a successful delivery.
 *
 * A WeCom user can receive these messages in ordinary WeChat via the
 * WeCom↔WeChat bridge, which is why this satisfies "notify me on WeChat"
 * without touching an unofficial protocol.
 *
 * LIMITS (per WeCom's 群机器人配置说明)
 *   • 20 messages per minute, per robot key
 *   • markdown content is capped in BYTES, not characters
 *
 * The byte cap matters here more than usual: this project's messages are
 * mostly ASCII, but an event name or an operator note may contain Chinese
 * characters at 3 bytes each in UTF-8. Truncating by `String.length` would
 * pass a string of 4096 *characters* that is ~12 KB on the wire and be
 * rejected. Truncation is therefore byte-aware and never splits a codepoint.
 */

import { logger } from "../../../lib/logger.js";
import {
  decryptSecret,
  displayWebhook,
  encryptSecret,
  isEncrypted,
  redactSecrets,
} from "../secrets.js";
import type {
  DeliveryResult,
  NotificationPayload,
  NotificationProvider,
  ProviderHealth,
  ProviderLimits,
  ValidationResult,
} from "../types.js";
import { renderWeComMarkdown, renderWeComTest } from "./formatter.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The ONLY host this provider will ever contact.
 *
 * This is the SSRF control. Without it, "webhook URL" is a
 * server-side-request-forgery primitive: a user could save
 * http://169.254.169.254/latest/meta-data/ or http://postgres:5432 and use
 * the notification service to probe the internal network from inside the
 * Docker bridge. Pinning the host means the field can only ever address
 * Tencent.
 */
const WECOM_HOST = "qyapi.weixin.qq.com";
const WECOM_PATH = "/cgi-bin/webhook/send";

const LIMITS: ProviderLimits = {
  // WeCom documents 20/min per robot. Set at the documented ceiling; the
  // dispatcher's rate limiter is what actually keeps us under it.
  maxMessagesPerMinute: 20,
  // Documented markdown ceiling. Kept as a named constant rather than inline
  // so there is one place to correct if Tencent revises it.
  maxContentBytes: 4096,
  requestTimeoutMs: 10_000,
};

/**
 * WeCom errcode → our failure taxonomy.
 *
 * The distinction that matters: a revoked or mistyped webhook (94000) is
 * PERMANENT. Retrying it five times with backoff accomplishes nothing except
 * delaying the moment the user is told their configuration is broken.
 */
function classify(errcode: number): {
  kind: "configuration" | "invalid_payload" | "rate_limited" | "provider_error";
  hint: string;
} {
  switch (errcode) {
    case 93000:
      return { kind: "configuration", hint: "The robot is not authorised for this webhook." };
    case 94000:
      return { kind: "configuration", hint: "The webhook URL does not exist or has been disabled in WeCom." };
    case 40002:
    case 40014:
    case 42001:
      return { kind: "configuration", hint: "The webhook credential is invalid or has expired." };
    case 45009:
      return { kind: "rate_limited", hint: "WeCom rate limit reached (20 messages/minute per robot)." };
    case 40008:
    case 40066:
    case 44004:
    case 40058:
      return { kind: "invalid_payload", hint: "WeCom rejected the message body." };
    default:
      return { kind: "provider_error", hint: "WeCom returned an unexpected error." };
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Declared as a TYPE ALIAS, not an interface, on purpose.
 *
 * This is persisted into the `channel_config` jsonb column, whose Drizzle type
 * is Record<string, unknown>. TypeScript gives object type aliases an implicit
 * index signature but does NOT give one to interfaces, so an interface here
 * fails to assign and invites an `as any` at the call site — which is the
 * documented technical debt this project is trying to shed.
 */
export type WeComConfig = {
  /** Encrypted webhook URL (v1:…). Never plaintext once stored. */
  webhookUrl: string;
  /** Redacted form, safe to return from the API. */
  display?: string;
  /** "markdown" (default) or "text". */
  format?: "markdown" | "text";
};

/**
 * Byte-aware truncation that never splits a UTF-8 codepoint.
 *
 * Slicing a Buffer mid-sequence yields a replacement character and, for
 * markdown, can leave an unterminated construct. Walking back to a boundary
 * costs nothing and keeps the payload valid.
 */
export function truncateToBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  const suffix = "\n… (truncated)";
  const budget = maxBytes - Buffer.byteLength(suffix, "utf8");
  if (budget <= 0) return suffix.trim().slice(0, maxBytes);
  let end = budget;
  // 10xxxxxx is a UTF-8 continuation byte; step back off it.
  while (end > 0 && (buf[end]! & 0b1100_0000) === 0b1000_0000) end--;
  return buf.subarray(0, end).toString("utf8") + suffix;
}

/**
 * Parse and validate a user-supplied webhook URL.
 *
 * Rejects, with a specific reason each time:
 *   • unparseable input
 *   • non-HTTPS  (the key would travel in cleartext)
 *   • any host other than WeCom  (SSRF)
 *   • wrong path  (it is not a robot webhook)
 *   • missing or implausibly short key
 */
export function parseWebhookUrl(raw: unknown): { url?: URL; errors: string[] } {
  const errors: string[] = [];
  if (typeof raw !== "string" || !raw.trim()) {
    return { errors: ["Webhook URL is required."] };
  }
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { errors: ["Webhook URL is not a valid URL."] };
  }
  if (u.protocol !== "https:") {
    errors.push("Webhook URL must use HTTPS. The key travels in the query string.");
  }
  if (u.hostname.toLowerCase() !== WECOM_HOST) {
    errors.push(
      `Webhook host must be ${WECOM_HOST}. Received "${u.hostname}". ` +
      `Only official WeCom robot webhooks are accepted.`,
    );
  }
  if (!u.pathname.startsWith(WECOM_PATH)) {
    errors.push(
      `Webhook path must be ${WECOM_PATH}. This does not look like a WeCom group robot URL.`,
    );
  }
  const k = u.searchParams.get("key");
  if (!k) errors.push("Webhook URL is missing its ?key= parameter.");
  else if (k.length < 16) errors.push("Webhook key looks too short to be a WeCom robot key.");

  return errors.length ? { errors } : { url: u, errors: [] };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** NOTIFICATION_TEST_MODE=true routes every send to this sink. */
export interface CapturedMessage {
  at: string;
  content: string;
  msgtype: string;
  /** Redacted — the raw URL is never captured. */
  target: string;
}
const captured: CapturedMessage[] = [];
export function capturedMessages(): readonly CapturedMessage[] { return captured; }
export function clearCapturedMessages(): void { captured.length = 0; }

function testMode(): boolean {
  return (process.env["NOTIFICATION_TEST_MODE"] ?? "false").toLowerCase() === "true";
}

export class WeComWebhookProvider implements NotificationProvider {
  readonly channel = "wechat" as const;
  readonly transport = "wecom-webhook";
  readonly limits = LIMITS;

  validateConfiguration(config: unknown): ValidationResult {
    const c = (config ?? {}) as Partial<WeComConfig>;
    const raw = c.webhookUrl;

    // An already-encrypted value is a stored config being re-validated, not a
    // new submission. Decrypt to check it, and never treat the ciphertext
    // itself as a URL.
    let candidate: unknown = raw;
    if (isEncrypted(raw)) {
      try {
        candidate = decryptSecret(raw as string);
      } catch (err) {
        return { valid: false, errors: [(err as Error).message] };
      }
    }

    const { url, errors } = parseWebhookUrl(candidate);
    if (errors.length) return { valid: false, errors };

    if (c.format && c.format !== "markdown" && c.format !== "text") {
      return { valid: false, errors: [`Unsupported format "${c.format}". Use "markdown" or "text".`] };
    }
    return { valid: true, errors: [], display: displayWebhook(url!.toString()) };
  }

  /** Encrypt a freshly-submitted configuration for storage. */
  prepareForStorage(config: unknown): { config: WeComConfig; display: string } {
    const c = (config ?? {}) as Partial<WeComConfig>;
    const v = this.validateConfiguration(c);
    if (!v.valid) throw new Error(v.errors.join(" "));

    const plaintext = isEncrypted(c.webhookUrl)
      ? decryptSecret(c.webhookUrl as string)
      : String(c.webhookUrl);

    return {
      config: {
        webhookUrl: encryptSecret(plaintext),
        display: displayWebhook(plaintext),
        format: c.format ?? "markdown",
      },
      display: displayWebhook(plaintext),
    };
  }

  async send(config: unknown, payload: NotificationPayload): Promise<DeliveryResult> {
    const c = (config ?? {}) as WeComConfig;
    const format = c.format ?? "markdown";
    const content = format === "markdown"
      ? renderWeComMarkdown(payload)
      : renderWeComMarkdown(payload, { plain: true });
    return this.#post(c, format, content, { eventId: payload.eventId });
  }

  async test(config: unknown): Promise<DeliveryResult> {
    const c = (config ?? {}) as WeComConfig;
    return this.#post(c, c.format ?? "markdown", renderWeComTest(), { test: true });
  }

  /**
   * Health without sending.
   *
   * WeCom exposes no "validate this key" endpoint, so liveness cannot be
   * established without posting a message — and posting to the user's group on
   * every settings-page load is spam. Configuration validity is reported
   * honestly as exactly that, and the UI must not paint it as "connected".
   */
  async healthCheck(config: unknown): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    const v = this.validateConfiguration(config);
    if (!v.valid) {
      return { status: "configuration_required", detail: v.errors[0] ?? "Not configured.", checkedAt };
    }
    return {
      status: "unknown",
      detail:
        "Webhook is configured and well-formed. WeCom provides no non-sending " +
        "validation endpoint, so reachability is confirmed by the last delivery " +
        "or by sending a test notification.",
      checkedAt,
    };
  }

  // -------------------------------------------------------------------------

  async #post(
    c: WeComConfig,
    msgtype: "markdown" | "text",
    contentRaw: string,
    logCtx: Record<string, unknown>,
  ): Promise<DeliveryResult> {
    const started = Date.now();
    const content = truncateToBytes(contentRaw, LIMITS.maxContentBytes);

    let url: string;
    try {
      const plaintext = isEncrypted(c.webhookUrl)
        ? decryptSecret(c.webhookUrl)
        : String(c.webhookUrl ?? "");
      const { url: parsed, errors } = parseWebhookUrl(plaintext);
      if (errors.length) {
        return { ok: false, kind: "configuration", message: errors.join(" "), durationMs: 0 };
      }
      url = parsed!.toString();
    } catch (err) {
      return {
        ok: false,
        kind: "configuration",
        message: redactSecrets((err as Error).message),
        durationMs: Date.now() - started,
      };
    }

    const body = msgtype === "markdown"
      ? { msgtype: "markdown", markdown: { content } }
      : { msgtype: "text", text: { content } };

    if (testMode()) {
      captured.push({
        at: new Date().toISOString(),
        content,
        msgtype,
        target: displayWebhook(url),
      });
      logger.info(
        { ...logCtx, provider: "wecom-webhook", bytes: Buffer.byteLength(content, "utf8") },
        "[notifications/wecom] NOTIFICATION_TEST_MODE — message captured, not sent",
      );
      return { ok: true, providerMessageId: "test-mode", durationMs: Date.now() - started };
    }

    // AbortController rather than relying on a global default: an outbound
    // request that hangs would otherwise occupy a queue slot indefinitely.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), LIMITS.requestTimeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ac.signal,
        redirect: "error", // never follow a redirect off the pinned host
      });
      const durationMs = Date.now() - started;

      if (!res.ok) {
        return {
          ok: false,
          kind: res.status >= 500 ? "provider_error" : "configuration",
          code: res.status,
          message: `WeCom returned HTTP ${res.status}.`,
          durationMs,
        };
      }

      // WeCom signals application errors with HTTP 200 + errcode != 0.
      const json = (await res.json().catch(() => null)) as
        | { errcode?: number; errmsg?: string; msgid?: string }
        | null;

      if (!json || typeof json.errcode !== "number") {
        return {
          ok: false, kind: "provider_error",
          message: "WeCom response was not the expected {errcode, errmsg} JSON.",
          durationMs,
        };
      }

      if (json.errcode === 0) {
        return { ok: true, providerMessageId: json.msgid, durationMs };
      }

      const { kind, hint } = classify(json.errcode);
      return {
        ok: false,
        kind,
        code: json.errcode,
        message: redactSecrets(`${hint} (errcode ${json.errcode}: ${json.errmsg ?? "no message"})`),
        // WeCom does not return Retry-After; the dispatcher falls back to its
        // own backoff when this is absent.
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - started;
      const e = err as Error & { name?: string };
      if (e.name === "AbortError") {
        return {
          ok: false, kind: "timeout",
          message: `WeCom did not respond within ${LIMITS.requestTimeoutMs} ms.`,
          durationMs,
        };
      }
      return {
        ok: false, kind: "network",
        message: redactSecrets(e.message || "Network error contacting WeCom."),
        durationMs,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export const wecomProvider = new WeComWebhookProvider();
