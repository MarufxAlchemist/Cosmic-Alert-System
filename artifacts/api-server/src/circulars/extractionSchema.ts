/**
 * extractionSchema.ts — the structured shape an AI extraction must conform to
 * ---------------------------------------------------------------------------
 * VERSIONED. `EXTRACTION_SCHEMA_VERSION` is stored on every extraction row and
 * forms part of the cache key, so changing this file re-extracts rather than
 * silently mixing shapes, and an older extraction remains readable as the
 * thing it actually was.
 *
 * THREE RULES THIS SCHEMA ENFORCES STRUCTURALLY
 * ---------------------------------------------
 * 1. ABSENCE IS EXPLICIT. Every scientific field is nullable and null means
 *    "the circular did not state this". There is no zero, no empty string, no
 *    "N/A" that a reader could mistake for a measurement. A model that omits
 *    a required key fails validation rather than having a default invented
 *    for it.
 *
 * 2. AN UPPER LIMIT IS NOT A DETECTION. `detection` is an enum with
 *    `upper_limit` as a first-class value distinct from `detected` and
 *    `not_detected`. This is the single most common way a summarising model
 *    corrupts a follow-up report — "R > 21.5 mag" becoming "optical
 *    counterpart found" — and the shape makes the distinction unavoidable.
 *
 * 3. EVERY CLAIM CARRIES ITS SOURCE. `sourceText` is a verbatim span from the
 *    circular. It is what makes an extracted fact checkable against the
 *    original in one glance, and it is why this is an evidence layer rather
 *    than an opaque AI knowledge base.
 *
 * WHAT `extractionConfidence` MEANS — AND DOES NOT
 * ------------------------------------------------
 * It is the model's confidence that the extracted fields are EXPLICITLY
 * SUPPORTED BY THE TEXT of this circular. It is emphatically NOT scientific
 * confidence that the astrophysical interpretation is correct. A circular can
 * state a redshift with total clarity (extraction confidence: high) that the
 * community later revises. The UI must label it accordingly.
 */

import { z } from "zod";

/** Bump when the shape below changes. Part of the extraction cache key. */
export const EXTRACTION_SCHEMA_VERSION = 1;

// ─── Vocabularies ────────────────────────────────────────────────────────────

export const OBSERVATION_BANDS = [
  "gamma_ray",
  "x_ray",
  "uv",
  "optical",
  "infrared",
  "radio",
  "gravitational_wave",
  "neutrino",
  "other",
] as const;

/**
 * The observational outcome.
 *
 * `upper_limit` — the field was observed and nothing was seen above a stated
 *   limiting sensitivity. This is a measurement, and it is NOT `detected`.
 * `not_detected` — nothing seen, no limit quoted.
 * `candidate` — a source is reported but not confirmed as the counterpart.
 * `unknown` — the circular does not say.
 */
export const DETECTION_STATES = [
  "detected",
  "not_detected",
  "upper_limit",
  "candidate",
  "unknown",
] as const;

export const LOCALIZATION_STATES = ["updated", "refined", "unchanged", "unknown"] as const;
export const SPECTROSCOPY_STATES = ["performed", "not_performed", "unknown"] as const;
export const FOLLOWUP_STATES = ["requested", "performed", "planned", "unknown"] as const;
export const REDSHIFT_KINDS = ["spectroscopic", "photometric", "unknown"] as const;
export const EXTRACTION_CONFIDENCE = ["high", "medium", "low"] as const;

// ─── Building blocks ─────────────────────────────────────────────────────────

/**
 * A verbatim span from the circular supporting the claim beside it.
 *
 * Capped at 400 characters: long enough to carry a full sentence with its
 * numbers, short enough that it cannot become a paraphrase of the whole
 * circular. Nullable because some claims (an instrument name in a header) have
 * no single supporting sentence.
 */
const SourceText = z.string().min(1).max(400).nullable();

/**
 * A measured value with the units the circular used.
 *
 * `unit` is required whenever a value is present — a bare number is not a
 * measurement — and units are preserved as written rather than converted, so
 * nothing is lost to a conversion this layer had no mandate to perform.
 */
const Quantity = z
  .object({
    value: z.number(),
    /** 1-sigma uncertainty as stated. null = the circular quoted none. */
    uncertainty: z.number().nullable(),
    /** Exactly as written in the circular, e.g. "mag", "mJy", "erg/cm2", "arcsec". */
    unit: z.string().min(1).max(40),
  })
  .nullable();

const Observation = z.object({
  band: z.enum(OBSERVATION_BANDS),
  /** e.g. "Swift-XRT", "GTC/OSIRIS". null = the circular names no instrument. */
  instrument: z.string().min(1).max(120).nullable(),
  facility: z.string().min(1).max(120).nullable(),
  detection: z.enum(DETECTION_STATES),
  /**
   * The limiting sensitivity for an `upper_limit`, in the circular's own
   * units. Required to be null for any other detection state is NOT enforced
   * here — some circulars quote a limit alongside a detection in another
   * filter — but the pairing is what makes an upper limit legible.
   */
  limit: Quantity,
  /** The measured brightness/flux when something WAS detected. */
  measurement: Quantity,
  /** ISO-8601 as stated by the circular. null = no observation time given. */
  observedAtUtc: z.string().min(4).max(40).nullable(),
  sourceText: SourceText,
});

// ─── The extraction ──────────────────────────────────────────────────────────

export const CircularExtractionSchema = z.object({
  schemaVersion: z.literal(EXTRACTION_SCHEMA_VERSION),

  /**
   * One entry per distinct observation reported. An empty array means the
   * circular reported no observations — a theory paper, an observing request,
   * a correction — and is a valid, meaningful answer.
   */
  observations: z.array(Observation).max(20),

  localization: z.object({
    status: z.enum(LOCALIZATION_STATES),
    /** Decimal degrees, only if the circular states a position for THIS event. */
    raDeg: z.number().min(0).max(360).nullable(),
    decDeg: z.number().min(-90).max(90).nullable(),
    /** As stated. Units in `errorUnit` — never silently converted to arcmin. */
    errorRadius: z.number().positive().nullable(),
    errorUnit: z.string().min(1).max(20).nullable(),
    /** e.g. "90% containment". null = the circular did not say what it contains. */
    containment: z.string().min(1).max(60).nullable(),
    sourceText: SourceText,
  }),

  spectroscopy: z.object({
    status: z.enum(SPECTROSCOPY_STATES),
    facility: z.string().min(1).max(120).nullable(),
    sourceText: SourceText,
  }),

  /**
   * null when the circular reports no redshift. This is the field most likely
   * to be hallucinated, and null here is a hard requirement — a redshift that
   * nobody measured is a fabricated distance, a fabricated energy and a
   * fabricated luminosity downstream.
   */
  redshift: z
    .object({
      value: z.number(),
      uncertainty: z.number().nullable(),
      kind: z.enum(REDSHIFT_KINDS),
      /** Who reported it, if the circular attributes it. */
      reportedBy: z.string().min(1).max(160).nullable(),
      sourceText: SourceText,
    })
    .nullable(),

  followUp: z.object({
    status: z.enum(FOLLOWUP_STATES),
    sourceText: SourceText,
  }),

  /**
   * A classification only if the circular STATES one ("this is a short GRB",
   * "consistent with a Galactic magnetar"). Never inferred from a duration or
   * a spectral index — that would be this layer doing physics it has no
   * mandate to do, and presenting the result as the authors' conclusion.
   */
  classification: z
    .object({
      value: z.string().min(1).max(160),
      sourceText: SourceText,
    })
    .nullable(),

  /**
   * A neutral restatement of what the circular reports, for scanning a long
   * event history. It supplements the original text and never replaces it.
   */
  scientificSummary: z.string().min(20).max(1200),

  /**
   * Confidence that the extracted fields are EXPLICITLY SUPPORTED BY THIS
   * CIRCULAR'S TEXT. Not scientific confidence in the astrophysics. See the
   * file header.
   */
  extractionConfidence: z.enum(EXTRACTION_CONFIDENCE),

  /**
   * Quantities the schema asks about that this circular does not address, in
   * the model's own words. Makes "we did not find it" visibly different from
   * "we did not look", which is the distinction a null alone cannot carry.
   */
  notReported: z.array(z.string().min(1).max(80)).max(20),
});

export type CircularExtraction = z.infer<typeof CircularExtractionSchema>;

/**
 * The JSON skeleton handed to the model.
 *
 * Kept beside the schema so the two cannot drift: a prompt that describes a
 * shape the validator rejects produces an endless retry loop that looks like a
 * provider outage.
 */
export const EXTRACTION_JSON_SHAPE = `{
  "schemaVersion": ${EXTRACTION_SCHEMA_VERSION},
  "observations": [
    {
      "band": "${OBSERVATION_BANDS.join(" | ")}",
      "instrument": "string or null",
      "facility": "string or null",
      "detection": "${DETECTION_STATES.join(" | ")}",
      "limit": { "value": number, "uncertainty": number|null, "unit": "string" } | null,
      "measurement": { "value": number, "uncertainty": number|null, "unit": "string" } | null,
      "observedAtUtc": "ISO-8601 string or null",
      "sourceText": "verbatim quote from the circular, <=400 chars, or null"
    }
  ],
  "localization": {
    "status": "${LOCALIZATION_STATES.join(" | ")}",
    "raDeg": number|null, "decDeg": number|null,
    "errorRadius": number|null, "errorUnit": "string or null",
    "containment": "string or null", "sourceText": "string or null"
  },
  "spectroscopy": { "status": "${SPECTROSCOPY_STATES.join(" | ")}", "facility": "string or null", "sourceText": "string or null" },
  "redshift": { "value": number, "uncertainty": number|null, "kind": "${REDSHIFT_KINDS.join(" | ")}", "reportedBy": "string or null", "sourceText": "string or null" } | null,
  "followUp": { "status": "${FOLLOWUP_STATES.join(" | ")}", "sourceText": "string or null" },
  "classification": { "value": "string", "sourceText": "string or null" } | null,
  "scientificSummary": "20-1200 characters",
  "extractionConfidence": "${EXTRACTION_CONFIDENCE.join(" | ")}",
  "notReported": ["short labels for quantities this circular does not address"]
}`;
