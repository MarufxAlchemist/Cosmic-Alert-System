/**
 * extractionRetry.test.ts
 * -----------------------
 * The two counter-intuitive rules are the ones worth protecting:
 * a permanent failure must NOT be retried, and a rate limit MUST be.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  EXTRACTION_BACKOFF_MS,
  classifyFailure,
  decideExtractionRetry,
  maxExtractionAttempts,
} from "./extractionRetry.js";
import { ExtractionValidationError } from "../services/ai/circular-extraction-agent.js";

beforeEach(() => {
  delete process.env["CIRCULAR_EXTRACTION_MAX_ATTEMPTS"];
});

describe("classifying failures", () => {
  it("a schema violation is permanent, not transient", () => {
    // A model that produced prose will produce prose again.
    expect(classifyFailure(new ExtractionValidationError("bad", ""))).toBe("invalid_response");
  });

  it("a missing key is a configuration failure", () => {
    expect(classifyFailure(new Error("GEMINI_API_KEY is not set."))).toBe("configuration");
    expect(classifyFailure(new Error("LLM_API_KEY is not set."))).toBe("configuration");
  });

  it("an unauthorized response is a configuration failure, not a transient one", () => {
    expect(classifyFailure(new Error("HTTP 401: invalid api key"))).toBe("configuration");
    expect(classifyFailure(new Error("HTTP 403: forbidden"))).toBe("configuration");
  });

  it("a rate limit is a rate limit even though it mentions quota", () => {
    // Checked before the configuration patterns on purpose: "quota" must not
    // be mistaken for a broken key and permanently abandoned.
    expect(classifyFailure(new Error("HTTP 429: quota exceeded"))).toBe("rate_limit");
    expect(classifyFailure(new Error("rate limit reached"))).toBe("rate_limit");
  });

  it("a timeout is a timeout", () => {
    expect(classifyFailure(new Error("mock request timed out after 45000ms"))).toBe("timeout");
    expect(classifyFailure(new Error("The operation was aborted"))).toBe("timeout");
  });

  it("an unrecognised error is transient — the safe direction", () => {
    // A wasted retry is cheaper than permanently abandoning an extraction a
    // second attempt would have completed.
    expect(classifyFailure(new Error("HTTP 503: service unavailable"))).toBe("transient");
    expect(classifyFailure(new Error("fetch failed"))).toBe("transient");
    expect(classifyFailure("something odd")).toBe("transient");
  });
});

describe("permanent failures are never retried", () => {
  it.each(["configuration", "invalid_response"] as const)(
    "%s fails on the very first attempt",
    (kind) => {
      expect(decideExtractionRetry(kind, 1).action).toBe("fail");
    },
  );

  it("a missing API key does not burn four attempts", () => {
    const d = decideExtractionRetry(classifyFailure(new Error("LLM_API_KEY is not set.")), 1);
    expect(d.action).toBe("fail");
    expect(d.nextAttemptAt).toBeUndefined();
  });
});

describe("transient failures walk the ladder", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");

  it.each([
    [1, EXTRACTION_BACKOFF_MS[1]!],
    [2, EXTRACTION_BACKOFF_MS[2]!],
    [3, EXTRACTION_BACKOFF_MS[3]!],
  ])("attempt %i schedules +%ims", (attempts, delay) => {
    const d = decideExtractionRetry("transient", attempts, now);
    expect(d.action).toBe("retry");
    expect(d.nextAttemptAt!.getTime()).toBe(now.getTime() + delay);
  });

  it("gives up once the attempt budget is spent", () => {
    expect(decideExtractionRetry("transient", maxExtractionAttempts()).action).toBe("fail");
    expect(decideExtractionRetry("transient", maxExtractionAttempts() + 1).action).toBe("fail");
  });

  it("retries a rate limit rather than abandoning the circular", () => {
    expect(decideExtractionRetry("rate_limit", 1).action).toBe("retry");
  });

  it("retries a timeout", () => {
    expect(decideExtractionRetry("timeout", 1).action).toBe("retry");
  });

  it("honours CIRCULAR_EXTRACTION_MAX_ATTEMPTS", () => {
    process.env["CIRCULAR_EXTRACTION_MAX_ATTEMPTS"] = "2";
    expect(decideExtractionRetry("transient", 1).action).toBe("retry");
    expect(decideExtractionRetry("transient", 2).action).toBe("fail");
  });

  it("does not run off the end of the ladder", () => {
    // An out-of-range attempt count must not index past the array and produce
    // NaN, which would write an invalid next_attempt_at and strand the row.
    process.env["CIRCULAR_EXTRACTION_MAX_ATTEMPTS"] = "99";
    const d = decideExtractionRetry("transient", 50, new Date(0));
    expect(d.action).toBe("retry");
    expect(Number.isFinite(d.nextAttemptAt!.getTime())).toBe(true);
    expect(d.nextAttemptAt!.getTime()).toBe(EXTRACTION_BACKOFF_MS[EXTRACTION_BACKOFF_MS.length - 1]!);
  });
});
