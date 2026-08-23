/**
 * extractionRetry.ts — when a failed AI extraction is tried again
 * ---------------------------------------------------------------------------
 * Pure, and separate from extractionWorker.ts for the same reason
 * notifications/retryPolicy.ts is separate from its dispatcher: these are the
 * rules, and rules should be testable without a database.
 *
 * THE RULE THAT IS EASY TO GET WRONG
 * ----------------------------------
 * A missing API key and a response that violates the schema are NOT transient.
 * Walking them up a backoff ladder costs quota, delays every other job behind
 * them, and cannot succeed — the key is still missing on attempt five, and a
 * model that produced prose will produce prose again. They fail immediately.
 *
 * Everything unrecognised is treated as transient, which is the safe
 * direction: a wasted retry is cheaper than permanently abandoning an
 * extraction that a second attempt would have completed.
 */

import type { CircularExtractionFailureKind } from "@workspace/db/schema";
import { ExtractionValidationError } from "../services/ai/circular-extraction-agent.js";

/**
 * Backoff ladder in milliseconds, indexed by attempts already made.
 *
 * 0 · 30 s · 2 min · 10 min · 30 min. Deliberately slower than the
 * notification ladder: nothing about an extraction is urgent. The circular is
 * already stored, associated and readable, so the enrichment arriving half an
 * hour later costs a researcher nothing, while hammering a rate-limited
 * provider costs everyone.
 */
export const EXTRACTION_BACKOFF_MS: readonly number[] = [0, 30_000, 120_000, 600_000, 1_800_000];

export function maxExtractionAttempts(): number {
  const raw = Number(process.env["CIRCULAR_EXTRACTION_MAX_ATTEMPTS"]);
  return Number.isInteger(raw) && raw > 0 ? raw : 4;
}

/** Kinds that cannot succeed by being tried again. */
export const PERMANENT_FAILURE_KINDS: ReadonlySet<CircularExtractionFailureKind> = new Set([
  "configuration",
  "invalid_response",
]);

/**
 * Map an error to a failure kind.
 *
 * Order matters: an `ExtractionValidationError` is checked first because its
 * message can legitimately contain words like "timeout" quoted from a model's
 * own prose, and misreading it as transient would retry a response that will
 * never validate.
 */
export function classifyFailure(err: unknown): CircularExtractionFailureKind {
  if (err instanceof ExtractionValidationError) return "invalid_response";

  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();

  // Checked before the generic transient case, and before "configuration",
  // because a 429 mentioning "quota" is a rate limit, not a broken key.
  if (msg.includes("429") || msg.includes("rate limit") || msg.includes("quota")) return "rate_limit";
  if (msg.includes("timed out") || msg.includes("timeout") || msg.includes("abort")) return "timeout";

  if (
    msg.includes("api_key") ||
    msg.includes("api key") ||
    msg.includes("is not set") ||
    msg.includes("unauthorized") ||
    msg.includes("401") ||
    msg.includes("403") ||
    msg.includes("unknown llm_provider") ||
    msg.includes("requires llm_base_url") ||
    msg.includes("no default is known")
  ) {
    return "configuration";
  }

  return "transient";
}

export interface RetryDecision {
  action: "retry" | "fail";
  /** Present only when action === 'retry'. */
  nextAttemptAt?: Date;
}

/**
 * @param attemptsSoFar attempts already made, INCLUDING the one that just
 *        failed. The claim query increments the counter before the attempt
 *        runs, so this is the value straight off the row.
 */
export function decideExtractionRetry(
  kind: CircularExtractionFailureKind,
  attemptsSoFar: number,
  now = new Date(),
): RetryDecision {
  if (PERMANENT_FAILURE_KINDS.has(kind)) return { action: "fail" };
  if (attemptsSoFar >= maxExtractionAttempts()) return { action: "fail" };

  const index = Math.min(Math.max(attemptsSoFar, 0), EXTRACTION_BACKOFF_MS.length - 1);
  const delay = EXTRACTION_BACKOFF_MS[index] ?? 0;
  return { action: "retry", nextAttemptAt: new Date(now.getTime() + delay) };
}
