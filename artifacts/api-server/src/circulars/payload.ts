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
