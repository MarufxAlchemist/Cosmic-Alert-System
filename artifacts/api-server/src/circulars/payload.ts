/**
 * payload.ts — the GCN Circular wire shape, validated
 * ---------------------------------------------------------------------------
 * Pure. No database import, deliberately: vitest.config.ts documents that the
 * unit suite runs with no database, broker or network, and importing
 * @workspace/db throws at module load when DATABASE_URL is unset. Keeping
 * parsing here means the rules that decide whether a circular is storable can
 * be tested on a laptop with nothing running.
 *
 * ingestion.ts re-exports everything below, so callers have one import site.
 */

import { createHash } from "node:crypto";

/**
 * A GCN Circular exactly as published on the `gcn.circulars` Kafka topic and
 * in `archive.json.tar.gz`.
 *
 * Field presence measured over the full 44,766-circular archive:
 *   subject, createdOn, circularId, submitter, body   100%
 *   bibcode 99.5% · eventId 92.5% · email 74.9% · submittedHow 23.7%
 *   format 14.3% · editedOn/version/editedBy 2.8%
 */
export interface RawGcnCircular {
  circularId: number;
  subject: string;
  body: string;
  submitter: string;
  /** Unix epoch milliseconds. Publication time, NOT the event's trigger time. */
  createdOn: number;
  eventId?: string | null;
  bibcode?: string | null;
  submittedHow?: string | null;
  format?: string | null;
  version?: number | null;
  editedOn?: number | null;
  editedBy?: string | null;
  [key: string]: unknown;
}

export class CircularValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CircularValidationError";
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CircularValidationError(`Circular is missing a usable "${field}".`);
  }
  return value;
}

/**
 * Turn an untrusted payload into a `RawGcnCircular`, or refuse it.
 *
 * Refusal is limited to the five fields GCN always sends. A circular with no
 * `eventId` is perfectly normal — 3,346 of 44,766 archived circulars have none
 * — and is accepted, then recorded as UNMATCHED if nothing resolves from its
 * subject. Refusing those would discard 7.5% of the scientific record over a
 * missing convenience field.
 */
export function parseCircular(payload: unknown): RawGcnCircular {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CircularValidationError("Circular payload is not an object.");
  }
  const p = payload as Record<string, unknown>;

  // Finite, but NOT necessarily a positive integer.
  //
  // Seven circulars in the real 44,766-record archive have ids of -1, -2, -3,
  // -4, 0, 18448.5 and 18453.5 — pseudo-ids for 1997 circulars added
  // retroactively, and fractional ids used to slot a circular between two
  // already numbered. Requiring a positive integer discarded all seven,
  // including "GRB 970228: Keck/LRIS Optical Observations", the first GRB with
  // an optical counterpart. The column is NUMERIC for the same reason.
  //
  // Number("35176abc") is NaN, so a non-numeric string is still refused.
  const circularId =
    typeof p["circularId"] === "number" ? p["circularId"] : Number(p["circularId"]);
  if (
    p["circularId"] === null ||
    p["circularId"] === undefined ||
    p["circularId"] === "" ||
    !Number.isFinite(circularId)
  ) {
    throw new CircularValidationError(
      `Circular has no valid numeric "circularId" (got ${JSON.stringify(p["circularId"])}).`,
    );
  }

  const createdOn = Number(p["createdOn"]);
  if (!Number.isFinite(createdOn) || createdOn <= 0) {
    throw new CircularValidationError(
      `Circular ${circularId} has no valid "createdOn" epoch-milliseconds timestamp.`,
    );
  }

  // ABSENT MEANS 1. GCN omits `version` entirely on an original circular
  // (43,494 of 44,766). Treating absent as unknown would make every original
  // collide with every other on the (circular_id, version) unique index.
  const rawVersion = p["version"];
  let version = 1;
  if (rawVersion !== undefined && rawVersion !== null) {
    const v = Number(rawVersion);
    if (!Number.isInteger(v) || v < 1) {
      throw new CircularValidationError(
        `Circular ${circularId} has an invalid "version" (${JSON.stringify(rawVersion)}).`,
      );
    }
    version = v;
  }

  return {
    ...p,
    circularId,
    createdOn,
    version,
    subject: requireString(p["subject"], "subject"),
    body: requireString(p["body"], "body"),
    submitter: requireString(p["submitter"], "submitter"),
    eventId: typeof p["eventId"] === "string" ? p["eventId"] : null,
    bibcode: typeof p["bibcode"] === "string" ? p["bibcode"] : null,
    submittedHow: typeof p["submittedHow"] === "string" ? p["submittedHow"] : null,
    format: typeof p["format"] === "string" ? p["format"] : null,
    editedOn: typeof p["editedOn"] === "number" ? p["editedOn"] : null,
    editedBy: typeof p["editedBy"] === "string" ? p["editedBy"] : null,
  };
}

/**
 * Only the two formats GCN actually publishes survive; anything else is null.
 *
 * A CHECK constraint rejects other values, and an unguarded write would take
 * the whole circular down with it — the same lesson migration 0014 records for
 * credible-region areas.
 */
export function normalizeFormat(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const f = raw.trim().toLowerCase();
  return f === "text/plain" || f === "text/markdown" ? f : null;
}

/**
 * SHA-256 over the scientific content. Drives the AI extraction cache.
 *
 * The blank line between subject and body is a separator, not decoration:
 * without it ("ab", "c") and ("a", "bc") would hash identically, and one
 * circular could be served another's extraction.
 */
export function circularContentHash(subject: string, body: string): string {
  return createHash("sha256").update(`${subject}\n\n${body}`).digest("hex");
}

export function gcnUrlFor(circularId: number): string {
  return `https://gcn.nasa.gov/circulars/${circularId}`;
}

/**
 * Validate the `regexp_hints` sibling field on a `circular` WebSocket frame
 * (see backend/app/gcn/circular_hints.py). Never throws — unlike the five
 * fields above, a malformed or absent hints object is not a reason to reject
 * an otherwise-good circular, so this returns null instead of raising.
 *
 * Deliberately untyped beyond "plain object": the hint set is regex output
 * from a third-party package we do not own the schema of, and pinning its
 * shape here would break silently on the package's next minor version.
 */
export function normalizeRegexpHints(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

// ─── Extraction cost prefilter ───────────────────────────────────────────────

/**
 * The content flags that make a circular worth an AI extraction.
 *
 * The first six come from astro-colibri-circular-parser's
 * `build_regexp_hints`. The seventh is OURS — see
 * backend/app/gcn/circular_hints.py — and its `local_` prefix marks it as
 * such wherever the hint set is read back.
 *
 * It exists because the upstream vocabulary's 17 named facilities are GRB
 * trigger instruments and OPTICAL telescopes only: it names no X-ray
 * follow-up observatory and no radio facility at all. Measured consequence:
 * GCN Circulars 22372 and 22374, the Chandra X-ray monitoring of
 * GW170817/GRB170817A, set none of the upstream flags.
 */
const SCIENTIFIC_CONTENT_FLAGS = [
  "likely_optical_followup",
  "likely_redshift_report",
  "likely_retraction",
  "likely_correction",
  "likely_upper_limit",
  "likely_high_energy_detection",
  "local_likely_xray_radio_followup",
] as const;

/**
 * Whether a circular may be denied an AI extraction to save a model call.
 *
 * Pure, and deliberately conservative: every uncertain case returns false
 * (extract it). Two safety properties are structural rather than incidental,
 * because both were established by measurement rather than assumption:
 *
 * 1. GRB ONLY. The hint vocabulary was built for GRB follow-up language and
 *    covers nothing else. Measured over real archive circulars, a
 *    "no content flags" rule skipped 99.2% of GW, 100% of FRB and 99.4% of
 *    neutrino circulars — including the LVK collaboration's own compact
 *    binary merger identification circulars, which carry the FAR, the
 *    BNS/BBH/NSBH probabilities, the luminosity distance and the 90%
 *    credible area. Those flags are silent on that language, so a
 *    non-GRB circular is NEVER skipped here, whatever its flags say.
 *
 * 2. NULL HINTS NEVER SKIP. A null hint set means "not computed" — the
 *    parser was unavailable, or this row came through the archive backfill,
 *    which does not run the Python hints step. It does NOT mean "the regex
 *    found nothing". All 44,777 rows that predate migration 0022 have null
 *    hints, and treating null as skippable would silently disable extraction
 *    for the entire existing archive.
 *
 * `contact_email_count` is included for parity with the upstream triage, not
 * because our extraction captures contacts — it does not; the contacts shown
 * in the UI come from Astro-COLIBRI's own /followup_summary endpoint.
 */
export function shouldSkipExtraction(
  normalizedEventId: string | null | undefined,
  regexpHints: unknown,
): boolean {
  // Safety property 1 — see above.
  if (!normalizedEventId || !normalizedEventId.toUpperCase().startsWith("GRB")) {
    return false;
  }

  // Safety property 2 — see above. normalizeRegexpHints returns null for
  // anything that is not a plain object, so a malformed hint set is treated
  // exactly like an absent one.
  const hints = normalizeRegexpHints(regexpHints);
  if (hints === null) return false;

  // Any TRUTHY value blocks the skip, not just a literal `true`. The upstream
  // package returns booleans today, but a future version returning a match
  // count or a matched-term string must read as "there is content here",
  // never as "not literally true, therefore absent". The asymmetry is
  // deliberate: the cost of a needless extraction is one model call; the cost
  // of a wrong skip is a silently missing scientific record.
  for (const flag of SCIENTIFIC_CONTENT_FLAGS) {
    if (hints[flag]) return false;
  }

  // Same rule: 0 and absent are skippable, anything else is content.
  if (hints["contact_email_count"]) return false;

  return true;
}
