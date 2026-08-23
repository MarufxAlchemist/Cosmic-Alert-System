/**
 * providers/types.ts
 * ------------------
 * The notification provider contract.
 *
 * WHY THIS EXISTS
 * ───────────────
 * emailService.ts already defines an EmailProvider interface with four
 * implementations (none/smtp/resend/sendgrid). That abstraction is email-
 * shaped: it takes {to, subject, html, text}, which means nothing to a chat
 * webhook. Adding WeChat by widening EmailOptions would have made every
 * provider carry every other provider's fields.
 *
 * This is the channel-agnostic layer above it. Email remains a provider whose
 * transport happens to be the existing EmailProvider stack.
 *
 * DESIGN RULES
 *
 * 1. A provider NEVER computes scientific values. It receives an already
 *    validated event and renders it. The scientific pipeline is the single
 *    source of truth; a provider that did its own arithmetic would be a second
 *    implementation to drift out of sync — which is exactly how the Phase 2
 *    correlation scorer went wrong.
 *
 * 2. A provider declares its own limits (rate, payload size) rather than
 *    scattering magic numbers through the dispatcher.
 *
 * 3. Failures are classified, not just reported. "Retry this in 30 s" and
 *    "this webhook is revoked, stop trying" are different outcomes, and
 *    retrying a permanent failure forever is how a queue wedges.
 *
 * 4. Nothing here ever carries a secret back out. Configuration goes IN;
 *    results carry status, never credentials.
 */

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/**
 * The active notification channels.
 *
 * `telegram` and `discord` were placeholder cards in the frontend with no
 * backend, no database rows and no delivery path. They are deliberately NOT in
 * this union: a channel exists here only when it can actually deliver.
 */
export type NotificationChannel = "email" | "wechat" | "qq" | "webhook";

export const NOTIFICATION_CHANNELS: readonly NotificationChannel[] = [
  "email",
  "wechat",
  "qq",
  "webhook",
] as const;

export function isNotificationChannel(v: unknown): v is NotificationChannel {
  return typeof v === "string" &&
    (NOTIFICATION_CHANNELS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/**
 * Why a delivery failed, in the terms the retry policy needs.
 *
 * The dispatcher decides retry behaviour from this alone, so the mapping from
 * a provider's own error codes into these categories is the provider's job and
 * belongs in its adapter.
 */
export type DeliveryFailureKind =
  /** Bad credentials, revoked webhook, malformed config. Never retry. */
  | "configuration"
  /** Provider rejected the message itself (too long, bad format). Never retry. */
  | "invalid_payload"
  /** Provider-side 5xx. Retry with backoff. */
  | "provider_error"
  /** Connection reset, DNS failure, TLS error. Retry with backoff. */
  | "network"
  /** Request exceeded the configured timeout. Retry with backoff. */
  | "timeout"
  /** Provider rate limit hit. Retry, honouring retryAfterMs when supplied. */
  | "rate_limited";

/** Failure kinds that must never be retried. */
export const PERMANENT_FAILURES: readonly DeliveryFailureKind[] = [
  "configuration",
  "invalid_payload",
] as const;

export function isPermanentFailure(kind: DeliveryFailureKind): boolean {
  return (PERMANENT_FAILURES as readonly string[]).includes(kind);
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface DeliverySuccess {
  ok: true;
  /** Provider-assigned ID where the provider returns one. */
  providerMessageId?: string;
  /** Round-trip time, for the delivery log. */
  durationMs?: number;
}

export interface DeliveryFailure {
  ok: false;
  kind: DeliveryFailureKind;
  /**
   * Provider's own error code, kept verbatim for diagnosis
   * (e.g. WeCom errcode 94000). Never a credential.
   */
  code?: string | number;
  /**
   * Operator-facing message. Implementations MUST pass this through
   * redactSecrets() before returning it — provider errors sometimes echo the
   * request URL, which for a webhook transport contains the key.
   */
  message: string;
  /** Honoured by the dispatcher for `rate_limited`. */
  retryAfterMs?: number;
  durationMs?: number;
}

export type DeliveryResult = DeliverySuccess | DeliveryFailure;

export interface ValidationResult {
  valid: boolean;
  /** Field-level problems, safe to show the user. Never echoes the secret. */
  errors: string[];
  /**
   * Redacted rendering for the UI, e.g. "https://qyapi.weixin.qq.com/…?key=••••1a2b".
   * This is the ONLY form of a configured secret that may leave the server.
   */
  display?: string;
}

export interface ProviderHealth {
  status: "connected" | "configuration_required" | "degraded" | "unknown";
  /** Human-readable detail for the UI. Never a credential. */
  detail: string;
  checkedAt: string;
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/**
 * What a provider is asked to deliver.
 *
 * `event` is the validated, normalized Transient Event Detection event — the same object
 * the dashboard renders. Providers format it; they never recompute from it.
 */
export interface NotificationPayload {
  /** Stable key for idempotency: eventId + revision + subscription + channel. */
  idempotencyKey: string;
  eventId: string;
  revisionCount: number;
  priority: "CRITICAL" | "HIGH" | "NORMAL" | "LOW";
  /** The validated event, exactly as the scientific pipeline produced it. */
  event: Record<string, unknown>;
  /** Absolute URL to the event in the dashboard, when a base URL is configured. */
  eventUrl?: string | null;
}

// ---------------------------------------------------------------------------
// Provider limits
// ---------------------------------------------------------------------------

export interface ProviderLimits {
  /** Provider-enforced ceiling, per credential. */
  maxMessagesPerMinute: number;
  /** Largest renderable body, in BYTES (not characters — see the WeCom note). */
  maxContentBytes: number;
  /** Outbound request timeout. */
  requestTimeoutMs: number;
}

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

export interface NotificationProvider {
  readonly channel: NotificationChannel;
  /** Transport identity for logs, e.g. "wecom-webhook". */
  readonly transport: string;
  readonly limits: ProviderLimits;

  /**
   * Check a configuration without contacting the provider.
   * Pure and synchronous in spirit: no network, so it is safe to call on every
   * save and cannot be used to probe internal hosts.
   */
  validateConfiguration(config: unknown): ValidationResult;

  /** Deliver a real notification. */
  send(config: unknown, payload: NotificationPayload): Promise<DeliveryResult>;

  /** Send a clearly-marked test message. */
  test(config: unknown): Promise<DeliveryResult>;

  /**
   * Report health WITHOUT sending a message.
   *
   * Deliberately does not send: a health check that posts to the user's group
   * every time the settings page loads is spam. A provider that cannot
   * determine liveness without sending returns "unknown" rather than
   * pretending, and the UI must not render a configured-but-unverified
   * provider as "connected".
   */
  healthCheck(config: unknown): Promise<ProviderHealth>;
}
