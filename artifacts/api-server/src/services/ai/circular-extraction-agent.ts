/**
 * circular-extraction-agent.ts — provider-agnostic GCN Circular extraction
 * ---------------------------------------------------------------------------
 * Depends on `LLMProvider` and nothing else. There is no Gemini import here,
 * no DeepSeek import, no SDK type in any signature. Swapping providers is a
 * configuration change; this file does not know which one ran.
 *
 * The agent's only job is: build the versioned prompt, call the provider,
 * parse, and validate against the Zod schema. It does not decide which event
 * the circular belongs to (that is `circulars/association.ts`, deterministic),
 * it does not write to the database (that is the worker), and it does not
 * retry (that is the worker's bounded, persisted retry policy — an in-agent
 * retry loop would be invisible to the state machine that owns attempts).
 */

import type { LLMProvider } from "./provider.js";
import {
  CircularExtractionSchema,
  EXTRACTION_SCHEMA_VERSION,
  type CircularExtraction,
} from "../../circulars/extractionSchema.js";
import {
  CIRCULAR_EXTRACTION_SYSTEM_PROMPT,
  EXTRACTION_PROMPT_VERSION,
  buildCircularExtractionPrompt,
  type CircularExtractionPromptInput,
} from "./prompts/circular-extraction.js";
import { logger } from "../../lib/logger.js";

export { EXTRACTION_PROMPT_VERSION, EXTRACTION_SCHEMA_VERSION };
export type { CircularExtraction };

/**
 * A model response that could not be turned into a valid extraction.
 *
 * Distinct from a transport failure: nothing about retrying an unparseable
 * response is likely to help, and the worker classifies it as
 * `invalid_response` rather than `transient` for exactly that reason.
 */
export class ExtractionValidationError extends Error {
  constructor(
    message: string,
    /** First 500 chars of the raw response, for diagnosis. Never the API key. */
    readonly rawExcerpt: string,
  ) {
    super(message);
    this.name = "ExtractionValidationError";
  }
}

/**
 * Strip a markdown fence, if the model added one despite the instruction.
 *
 * Some providers ignore a JSON-only instruction under load. Recovering here is
 * cheap and avoids burning a retry on a response whose content was fine.
 */
function stripFence(raw: string): string {
  return raw
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

/**
 * Extract the outermost JSON object from a response with leading or trailing
 * prose. Returns null when there is no balanced object to find.
 */
function carveObject(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return raw.slice(start, end + 1);
}

export class CircularExtractionAgent {
  constructor(private readonly provider: LLMProvider) {}

  /** Identifies the model that produced an extraction, for provenance. */
  get providerName(): string {
    return this.provider.name;
  }

  async extract(input: CircularExtractionPromptInput): Promise<CircularExtraction> {
    const prompt = buildCircularExtractionPrompt(input);

    logger.info(
      {
        provider: this.provider.name,
        circularId: input.circularId,
        version: input.version,
        promptVersion: EXTRACTION_PROMPT_VERSION,
        schemaVersion: EXTRACTION_SCHEMA_VERSION,
        // The body is never logged: it is large, and dumping full circular
        // text into the log stream serves nobody.
        bodyChars: input.body.length,
      },
      "[circulars] AI extraction started",
    );

    const raw = await this.provider.generate(prompt, CIRCULAR_EXTRACTION_SYSTEM_PROMPT);
    return this.parseAndValidate(raw, input);
  }

  private parseAndValidate(raw: string, input: CircularExtractionPromptInput): CircularExtraction {
    const excerpt = raw.slice(0, 500);

    let parsed: unknown;
    const candidates = [raw.trim(), stripFence(raw), carveObject(raw) ?? ""];

    let lastParseError = "";
    let ok = false;
    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        parsed = JSON.parse(candidate);
        ok = true;
        break;
      } catch (err) {
        lastParseError = err instanceof Error ? err.message : String(err);
      }
    }

    if (!ok) {
      throw new ExtractionValidationError(
        `Model response was not JSON: ${lastParseError}`,
        excerpt,
      );
    }

    const result = CircularExtractionSchema.safeParse(parsed);

    if (!result.success) {
      // Report the failing paths, not the whole payload — a validation log
      // that reproduces the model's invented redshift is its own problem.
      const issues = result.error.issues
        .slice(0, 8)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");

      logger.warn(
        {
          circularId: input.circularId,
          version: input.version,
          provider: this.provider.name,
          issues,
        },
        "[circulars] AI extraction rejected by schema — nothing persisted",
      );

      throw new ExtractionValidationError(
        `Model output failed schema validation: ${issues}`,
        excerpt,
      );
    }

    logger.info(
      {
        circularId: input.circularId,
        version: input.version,
        provider: this.provider.name,
        observationCount: result.data.observations.length,
        // Logged because "did the model invent a redshift?" is the single most
        // useful thing to be able to grep for.
        redshiftReported: result.data.redshift !== null,
        confidence: result.data.extractionConfidence,
      },
      "[circulars] AI extraction completed and validated",
    );

    return result.data;
  }
}
