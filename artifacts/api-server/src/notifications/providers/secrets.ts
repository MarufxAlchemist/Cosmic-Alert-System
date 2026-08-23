/**
 * providers/secrets.ts
 * --------------------
 * Encryption at rest and redaction for provider credentials.
 *
 * THE THREAT
 * ──────────
 * A WeCom robot webhook URL is not a location — it is a bearer credential.
 * Anyone holding
 *
 *     https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<KEY>
 *
 * can post to that group. There is no second factor and no per-message
 * signature. So the key must be treated exactly like a password:
 *
 *   • encrypted at rest, not stored as plaintext JSON in channel_config
 *   • never returned by any GET endpoint
 *   • never written to a log, an error message or a WebSocket frame
 *
 * The last one is the easy one to get wrong: HTTP clients habitually include
 * the request URL in their error strings, so a failed POST can leak the key
 * into a Pino log line without anyone writing `logger.info(url)`. Every
 * provider error passes through redactSecrets() before it is returned.
 *
 * CRYPTO
 * ──────
 * AES-256-GCM. Authenticated, so tampering with a stored ciphertext is
 * detected rather than producing garbage that gets POSTed somewhere.
 *
 * Stored form (single string, so it drops into the existing jsonb column):
 *
 *     v1:<iv-b64>:<authTag-b64>:<ciphertext-b64>
 *
 * The version prefix exists so the key can be rotated later without guessing
 * at what an old row contains.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;         // 96-bit nonce, the GCM standard
const VERSION = "v1";

export class SecretConfigurationError extends Error {}

/**
 * Derive the 32-byte key from NOTIFICATION_ENCRYPTION_KEY.
 *
 * Accepts either 64 hex characters (32 bytes, the documented form) or any
 * other string, which is hashed to 32 bytes. Hashing a short passphrase does
 * NOT make it strong — it only makes it the right length — so setup docs
 * instruct generating real entropy:
 *
 *     openssl rand -hex 32
 *
 * Read lazily rather than at import time so the module can be imported (and
 * unit-tested) in a process that has no key configured.
 */
function key(): Buffer {
  const raw = process.env["NOTIFICATION_ENCRYPTION_KEY"];
  if (!raw || !raw.trim()) {
    throw new SecretConfigurationError(
      "NOTIFICATION_ENCRYPTION_KEY is not set. Provider credentials cannot be " +
      "stored or read without it. Generate one with: openssl rand -hex 32",
    );
  }
  const t = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return Buffer.from(t, "hex");
  return createHash("sha256").update(t, "utf8").digest();
}

/** True when a key is configured, without throwing. For health reporting. */
export function encryptionAvailable(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    enc.toString("base64"),
  ].join(":");
}

export function decryptSecret(stored: string): string {
  const parts = String(stored).split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SecretConfigurationError(
      "Stored credential is not in the expected format. It may have been " +
      "written with a different NOTIFICATION_ENCRYPTION_KEY or corrupted.",
    );
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv(ALGO, key(), Buffer.from(ivB64!, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64!, "base64"));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64!, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // GCM auth failure: wrong key, or the ciphertext was modified.
    throw new SecretConfigurationError(
      "Stored credential failed authentication. NOTIFICATION_ENCRYPTION_KEY " +
      "may have changed since it was saved.",
    );
  }
}

export function isEncrypted(v: unknown): boolean {
  return typeof v === "string" && v.startsWith(VERSION + ":") &&
    v.split(":").length === 4;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Patterns that must never reach a log or an API response.
 *
 * Ordered most-specific first. `key=` covers the WeCom webhook; the generic
 * token/secret patterns cover provider errors that echo other query strings.
 */
const SECRET_PATTERNS: RegExp[] = [
  /([?&](?:key|access_token|token|secret|sig|signature|password)=)([^&\s"']+)/gi,
  /(Bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi,
];

/**
 * Strip credentials from arbitrary text.
 *
 * Applied to every provider error before it is returned or logged. Cheap
 * enough to apply unconditionally, and applying it unconditionally is the
 * point — a rule that must be remembered at each call site will eventually be
 * forgotten at one.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = String(text);
  for (const re of SECRET_PATTERNS) out = out.replace(re, "$1<redacted>");
  return out;
}

/**
 * Human-readable, non-reversible rendering of a webhook URL for the UI.
 *
 *     https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcd…1a2b
 *
 * Keeps the last 4 characters so a user with several robots can tell which one
 * is configured, which is the whole reason to show anything at all. Four
 * characters of a 36-character key is not enough to be useful to an attacker
 * who does not already have it.
 */
export function displayWebhook(url: string): string {
  try {
    const u = new URL(url);
    const k = u.searchParams.get("key") ?? "";
    const tail = k.length > 4 ? k.slice(-4) : "";
    u.searchParams.set("key", tail ? `••••${tail}` : "••••");
    return decodeURIComponent(u.toString());
  } catch {
    return "••••••••••••••••";
  }
}

/**
 * Constant-time comparison, for any future signature verification.
 * Exposed here so callers never reach for `===` on a credential.
 */
export function safeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
