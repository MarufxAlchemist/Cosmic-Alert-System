/**
 * client.ts — Astro-COLIBRI optical afterglow client
 * ---------------------------------------------------------------------------
 * Astro-COLIBRI is a third-party multi-messenger follow-up platform. It holds
 * photometry extracted from GCN circulars and renders an optical afterglow
 * lightcurve figure per event. That figure is CONTEXT, not our measurement:
 * it is served to the UI as an image with an attribution link, never merged
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
 * UPSTREAM SHAPE — VERIFIED 2026-09-06
 * ------------------------------------
 * An earlier revision of this file was written from a specification rather
 * than from the API, and every one of its assumptions was wrong. Measured
 * against the live service with source_name=GRB210822A:
 *
 *   https://astro-colibri.science/api/...            → 404 (no /api prefix)
 *   /optical_afterglow_lightcurve?name=GRB210822A    → 200 {"img_url": "..."}
 *   /event?name=...                                  → 400
 *   /event?source_name=GRB210822A                    → 200, a single object
 *
 * Consequences now baked in below:
 *
 *   * The base URL carries no path prefix.
 *   * There is NO resolve step. /optical_afterglow_lightcurve takes the
 *     human-readable name directly, so the former two-call sequence through
 *     /event was pure overhead — and its parameter and id-field guesses were
 *     both wrong, which made the whole feature return 502 for every event.
 *   * The afterglow response has exactly one key, `img_url`. There is no
 *     observation count in it, so observationCount is a hard 0 here; it is
 *     kept on the interface to be filled from /followup_summary later.
 *
 * Beware when extending this file: the parameter name is NOT consistent
 * across Astro-COLIBRI's API. /optical_afterglow_lightcurve and
 * /followup_summary take `name`; /event takes `source_name` and rejects
 * `name` with a 400.
 */

import { logger } from "../../lib/logger.js";

const API_BASE =
  process.env["ASTRO_COLIBRI_API_BASE"] ?? "https://astro-colibri.science";

/** The afterglow product renders a figure upstream, so it is given longer. */
const AFTERGLOW_TIMEOUT_MS = 8000;

export interface ColibriAfterglow {
  /** True only when a figure URL was actually returned. */
  available: boolean;
  /** Publicly accessible PNG URL from Astro-COLIBRI. */
  figureUrl: string | null;
  /** The name Astro-COLIBRI resolved this event to. */
  eventName: string | null;
  /**
   * How many photometry rows they hold for this event.
   *
   * Always 0 from this endpoint — the afterglow response carries no count.
   * Retained for /followup_summary, whose `reports` array does supply one.
   */
  observationCount: number;
}

/** Astro-COLIBRI answered, and holds nothing for this event. */
function noData(eventName: string | null, observationCount = 0): ColibriAfterglow {
  return { available: false, figureUrl: null, eventName, observationCount };
}

/**
 * GET a JSON document, returning null on every failure mode — network error,
 * non-2xx, timeout, or a body that is not JSON. Each call gets its own
 * AbortController so that one request's timeout can never cancel another's.
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

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return null;
}

/**
 * Fetch the optical afterglow context figure for one event.
 *
 * @param eventId The HUMAN-READABLE event name (e.g. "GRB210822A"), which is
 *                what Astro-COLIBRI indexes on — never our database id.
 * @returns null when Astro-COLIBRI could not be reached at all.
 */
export async function fetchAfterglow(eventId: string): Promise<ColibriAfterglow | null> {
  const url = `${API_BASE}/optical_afterglow_lightcurve?name=${encodeURIComponent(eventId)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AFTERGLOW_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    // 404 = Astro-COLIBRI answered; they have no afterglow for this event.
    // That is `{ available: false }`, not an upstream failure.
    if (res.status === 404) return noData(eventId);
    if (!res.ok) {
      logger.warn(
        { step: "afterglow", status: res.status, url },
        "[astro-colibri] upstream returned a non-2xx response",
      );
      return null;
    }
    const payload = asRecord(await res.json());
    if (!payload) return noData(eventId);
    // `img_url` is what the live API returns; `figure_url` is accepted only
    // because an earlier spec claimed it. Drop the fallback once that is retired.
    const figureUrl =
      readString(payload, "img_url") ?? readString(payload, "figure_url");
    if (!figureUrl) return noData(eventId);
    return { available: true, figureUrl, eventName: eventId, observationCount: 0 };
  } catch (err) {
    logger.warn(
      {
        step: "afterglow",
        url,
        err: err instanceof Error ? err.message : String(err),
        timedOut: controller.signal.aborted,
      },
      "[astro-colibri] request failed",
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** How long the follow-up summary is given; it aggregates many circulars. */
const FOLLOWUP_TIMEOUT_MS = 10000;

export interface ColibriReport {
  reportId: string;
  reportUrl: string;
  subject: string;
  /** observatory_short_name when non-empty, else observatory. */
  observatory: string;
  instrument: string;
  observationCategory: string;
  /**
   * The measured findings the circular reported. Upstream sends an array of
   * separate statements; they are joined with newlines rather than commas so
   * each stays a distinct claim, and the UI renders them line by line.
   */
  reportedResults: string;
  authors: string;
  contacts: string;
  redshift: number | null;
  hasOpticalFollowup: boolean;
  hasPhotometry: boolean;
  parsedAt: string;
  /** LLM-generated — must be displayed with an explicit provenance label. */
  aiSummary: string | null;
  /** The model that wrote aiSummary. Shown beside it, never on its own. */
  aiModel: string | null;
}

export interface ColibriFollowup {
  available: boolean;
  figureUrl: string | null;
  reports: ColibriReport[];
  /** Extracted from summary.contacts — real people, from circular headers. */
  contacts: Array<{ name: string; email: string }>;
  reportCount: number;
}

/** Astro-COLIBRI answered, and holds no follow-up for this event. */
function noFollowup(): ColibriFollowup {
  return { available: false, figureUrl: null, reports: [], contacts: [], reportCount: 0 };
}

/**
 * Coerce an upstream value to display text.
 *
 * MEASURED SHAPES (verified 2026-09-06): `authors` and `reported_results` are
 * arrays of strings, and `contacts` is an array of {name, email, ...} objects
 * — NOT the plain strings an earlier spec described. Passing those through
 * unchanged would render "[object Object]" in the UI, so each is normalised
 * here. `separator` is a newline for reported_results so distinct findings do
 * not merge into one run-on claim.
 */
function readText(value: unknown, separator = ", "): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";

  return value
    .map((item) => {
      if (typeof item === "string") return item.trim();
      const record = asRecord(item);
      if (!record) return "";
      return readString(record, "name") ?? readString(record, "email") ?? "";
    })
    .filter((s) => s !== "")
    .join(separator);
}

/** A contact is only useful to a researcher if it carries a name or an email. */
function readContacts(value: unknown): Array<{ name: string; email: string }> {
  if (!Array.isArray(value)) return [];

  const contacts: Array<{ name: string; email: string }> = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const name = readString(record, "name") ?? "";
    const email = readString(record, "email") ?? "";
    if (name === "" && email === "") continue;
    contacts.push({ name, email });
  }
  return contacts;
}

function toReport(value: unknown): ColibriReport | null {
  const item = asRecord(value);
  if (!item) return null;

  const shortName = readString(item, "observatory_short_name");
  const redshift = item["redshift"];

  return {
    reportId: readString(item, "report_id") ?? "",
    reportUrl: readString(item, "report_url") ?? "",
    subject: readString(item, "subject") ?? "",
    observatory: shortName ?? readString(item, "observatory") ?? "",
    instrument: readString(item, "instrument") ?? "",
    observationCategory: readString(item, "observation_category") ?? "",
    reportedResults: readText(item["reported_results"], "\n"),
    authors: readText(item["authors"]),
    contacts: readText(item["contacts"]),
    redshift: typeof redshift === "number" && Number.isFinite(redshift) ? redshift : null,
    hasOpticalFollowup: Boolean(item["has_optical_followup"]),
    hasPhotometry: Boolean(item["has_photometry"]),
    parsedAt: readString(item, "parsed_at") ?? "",
    aiSummary: readString(item, "summary"),
    aiModel: readString(item, "model"),
  };
}

const FOLLOWUP_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
// Astro-COLIBRI: ~100 units/day; /followup_summary costs ~5 units per call
const followupCache = new Map<string, { data: ColibriFollowup; expiresAt: number }>();

/**
 * Fetch the aggregated follow-up summary for one event.
 *
 * The fetch is inlined rather than delegated to getJson for the same reason as
 * fetchAfterglow: a 404 from this endpoint means "we hold nothing for this
 * event", which is an answer, not an outage. getJson collapses every non-2xx
 * into null and so cannot express that distinction.
 *
 * CACHING
 * -------
 * Confirmed data is held in-process for six hours. Only { available: true }
 * results are stored: an upstream failure and a definite negative both stay
 * uncached so the next request retries them, which keeps a transient outage
 * from being frozen into a six-hour "no data" for an event that has some.
 * The cache is memory-only and dies with the process — deliberately, since
 * this is a rate-limit shield rather than a source of truth.
 *
 * @param eventId The HUMAN-READABLE event name (e.g. "GRB210822A").
 * @returns null when Astro-COLIBRI could not be reached at all.
 */
export async function fetchFollowupSummary(
  eventId: string,
): Promise<ColibriFollowup | null> {
  const cached = followupCache.get(eventId);
  if (cached && Date.now() < cached.expiresAt) {
    logger.debug({ eventId }, "[astro-colibri] followup cache hit");
    return cached.data;
  }

  const url = `${API_BASE}/followup_summary?name=${encodeURIComponent(eventId)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FOLLOWUP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    // 404 = Astro-COLIBRI answered; they have no follow-up for this event.
    if (res.status === 404) return noFollowup();
    if (!res.ok) {
      logger.warn(
        { step: "followup", status: res.status, url },
        "[astro-colibri] upstream returned a non-2xx response",
      );
      return null;
    }

    const payload = asRecord(await res.json());
    if (!payload) return noFollowup();

    const figure = asRecord(payload["figure"]);
    const figureUrl = figure ? readString(figure, "url") : null;

    const rawReports = payload["reports"];
    const reports = Array.isArray(rawReports)
      ? rawReports.map(toReport).filter((r): r is ColibriReport => r !== null)
      : [];

    const summary = asRecord(payload["summary"]);
    const contacts = summary ? readContacts(summary["contacts"]) : [];

    const result: ColibriFollowup = {
      available: true,
      figureUrl,
      reports,
      contacts,
      reportCount: reports.length,
    };
    followupCache.set(eventId, {
      data: result,
      expiresAt: Date.now() + FOLLOWUP_CACHE_TTL_MS,
    });
    return result;
  } catch (err) {
    logger.warn(
      {
        step: "followup",
        url,
        err: err instanceof Error ? err.message : String(err),
        timedOut: controller.signal.aborted,
      },
      "[astro-colibri] request failed",
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}
