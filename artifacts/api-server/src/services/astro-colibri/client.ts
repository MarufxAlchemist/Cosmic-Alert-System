/**
 * client.ts — Astro-COLIBRI optical afterglow client
 * ---------------------------------------------------------------------------
 * Astro-COLIBRI is a third-party multi-messenger follow-up platform. It holds
 * photometry extracted from GCN circulars and renders an optical afterglow
 * lightcurve figure per event. That figure is CONTEXT, not our measurement:
 * it is served to the UI as an image with an attribution line, never merged
 * into our own derived parameters.
 *
 * FAILURE POLICY
 * --------------
 * This is optional enrichment on a panel that must render without it, so the
 * client follows the null-on-failure shape used by science/aiGuard.ts: every
 * network error, non-2xx and timeout returns null and nothing throws to the
 * caller. The caller distinguishes two outcomes that are NOT the same thing:
 *
 *   null                  — we could not reach Astro-COLIBRI, so we know
 *                           nothing. The UI must say so.
 *   { available: false }  — Astro-COLIBRI answered and holds no afterglow
 *                           for this event. That is a real, citable answer.
 *
 * Collapsing those two into one empty state would present an outage as an
 * absence of observations, which is a claim about the sky we cannot support.
 *
 * UPSTREAM SHAPE — PARTLY UNCONFIRMED
 * -----------------------------------
 * The request URLs below come from the feature specification. Astro-COLIBRI's
 * published API doc (astro-colibri.science/apidoc) disagrees with it on three
 * points, none of which has been exercised against a live response yet:
 *
 *   spec                              published doc
 *   /event?name=                      /event takes trigger_id, archive_id or
 *                                     source_name — no `name` parameter
 *   ?event_id= on the afterglow       /optical_afterglow_lightcurve takes
 *                                     trigger_id or name
 *   figure_url in the response        the response is {"img_url": ...}
 *
 * Until that is settled against a real call, parsing is deliberately wide:
 * both `figure_url` and `img_url` are accepted, the resolve step takes either
 * a bare object or an array of matches, and the row count falls back through
 * several spellings. The doc also describes no observation-count field on the
 * afterglow response, so observationCount may legitimately stay 0.
 */

import { logger } from "../../lib/logger.js";

const API_BASE =
  process.env["ASTRO_COLIBRI_API_BASE"] ?? "https://astro-colibri.science/api";

/** Name resolution is a plain lookup. */
const RESOLVE_TIMEOUT_MS = 5000;

/** The afterglow product renders a figure upstream, so it is given longer. */
const AFTERGLOW_TIMEOUT_MS = 8000;

export interface ColibriAfterglow {
  /** True only when a figure URL was actually returned. */
  available: boolean;
  /** Publicly accessible PNG URL from Astro-COLIBRI. */
  figureUrl: string | null;
  /** The name Astro-COLIBRI resolved this event to. */
  eventName: string | null;
  /** How many photometry rows they hold for this event. */
  observationCount: number;
}

/** Astro-COLIBRI answered, and holds nothing for this event. */
function noData(eventName: string | null, observationCount = 0): ColibriAfterglow {
  return { available: false, figureUrl: null, eventName, observationCount };
}

/**
 * GET a JSON document, returning null on every failure mode — network error,
 * non-2xx, timeout, or a body that is not JSON. Each call gets its own
 * AbortController; sharing one would let the resolve step's timeout cancel
 * the afterglow request that follows it.
 */
async function getJson(url: string, timeoutMs: number, step: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn(
        { step, status: res.status, url },
        "[astro-colibri] upstream returned a non-2xx response",
      );
      return null;
    }
    return await res.json();
  } catch (err) {
    logger.warn(
      { step, url, err: err instanceof Error ? err.message : String(err), timedOut: controller.signal.aborted },
      "[astro-colibri] request failed",
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Narrow an unknown JSON value to an indexable record. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The resolve endpoint may answer with a single object or with a list of
 * matches; take the first result either way. An empty list means no match.
 */
function firstResult(payload: unknown): Record<string, unknown> | null {
  if (Array.isArray(payload)) {
    return payload.length > 0 ? asRecord(payload[0]) : null;
  }
  const record = asRecord(payload);
  if (!record) return null;

  // Some APIs wrap the list under a key rather than returning it bare.
  for (const key of ["results", "data", "events"]) {
    const nested = record[key];
    if (Array.isArray(nested)) {
      return nested.length > 0 ? asRecord(nested[0]) : null;
    }
  }
  return record;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return null;
}

/** The upstream id may be numeric or a string; both are usable in a query. */
function readId(record: Record<string, unknown>): string | null {
  const value = record["id"];
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return null;
}

/** Row count, tried across the plausible spellings, defaulting to 0. */
function readObservationCount(record: Record<string, unknown>): number {
  const direct = record["observation_count"];
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;

  for (const key of ["observations", "photometry", "data"]) {
    const rows = record[key];
    if (Array.isArray(rows)) return rows.length;
  }
  return 0;
}

/**
 * Fetch the optical afterglow context figure for one event.
 *
 * @param eventId The HUMAN-READABLE event name (e.g. "GRB260503A"), which is
 *                what Astro-COLIBRI indexes on — never our database id.
 * @returns null when Astro-COLIBRI could not be reached at all.
 */
export async function fetchAfterglow(eventId: string): Promise<ColibriAfterglow | null> {
  // ── Step A: resolve the event name to an Astro-COLIBRI internal id ───────
  const resolvePayload = await getJson(
    `${API_BASE}/event?name=${encodeURIComponent(eventId)}`,
    RESOLVE_TIMEOUT_MS,
    "resolve",
  );
  if (resolvePayload === null) return null;

  const match = firstResult(resolvePayload);
  if (!match) return noData(null);

  const resolvedId = readId(match);
  if (!resolvedId) return noData(null);

  const resolvedName = readString(match, "name") ?? eventId;

  // ── Step B: fetch the afterglow product ─────────────────────────────────
  const afterglowPayload = await getJson(
    `${API_BASE}/optical_afterglow_lightcurve?event_id=${encodeURIComponent(resolvedId)}`,
    AFTERGLOW_TIMEOUT_MS,
    "afterglow",
  );
  if (afterglowPayload === null) return null;

  const afterglow = asRecord(afterglowPayload);
  if (!afterglow) return noData(resolvedName);

  const observationCount = readObservationCount(afterglow);
  // `figure_url` per the spec, `img_url` per Astro-COLIBRI's published doc.
  const figureUrl =
    readString(afterglow, "figure_url") ?? readString(afterglow, "img_url");
  if (!figureUrl) return noData(resolvedName, observationCount);

  return {
    available: true,
    figureUrl,
    eventName: resolvedName,
    observationCount,
  };
}
