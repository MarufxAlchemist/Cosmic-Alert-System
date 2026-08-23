/**
 * identity.ts — GCN Circular ⇄ event identifier normalisation
 * ---------------------------------------------------------------------------
 * Pure functions. No database, no network, no model. Everything here is
 * deterministic string handling, which is why event association can depend on
 * it and a language model cannot be allowed to.
 *
 * THE PROBLEM
 * -----------
 * The same astrophysical event is written differently by different producers.
 * Measured against the real archive (44,766 circulars) and the real
 * core.events rows in this deployment:
 *
 *   circular eventId          core.events.event_id
 *   ────────────────────      ────────────────────
 *   "GRB 141031B"             GRB260609A          (space vs no space)
 *   "LIGO/Virgo S190510g"     S260605a            (survey prefix vs bare id)
 *   "IceCube-201014A"         IC260603A  AND  ICECUBE-251225A   (both forms!)
 *   "EP250215a"               EP260605A           (suffix case)
 *   "FRB 20250316A"           FRB20260816T133005Z
 *
 * A single "canonical form" therefore cannot work on its own: the archive
 * importer upper-cased IceCube names to ICECUBE-… while the live normaliser
 * emits IC…, and both forms are present in the same table today.
 *
 * THE APPROACH
 * ------------
 * Each identifier expands to a small ordered SET of renderings. Association
 * tries every rendering. A rendering is a mechanical re-spelling of one
 * identifier — never a claim that two different events are the same object.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * It does not map GW170817 ↔ S170817a, or a GRB name to an instrument trigger
 * number. Those are real astrophysical aliases that require a catalogue
 * lookup or a human, and inventing them here would silently attach one event's
 * scientific record to another. Such links belong in core.event_aliases with
 * alias_source = 'OPERATOR' and a stated reason.
 */

/**
 * The naming family an identifier belongs to.
 *
 * `family` describes the identifier's SPELLING, not the physics. "GRB141031B"
 * is family GRB whatever the burst turns out to be; a circular about an
 * Einstein Probe transient that GCN named EP250215a is family EP even though
 * core.events records its event_type as EP or GRB depending on the ingest
 * path. Association never requires the families to agree — only the strings.
 */
export type IdentifierFamily =
  | "GRB"
  | "GW"
  | "FRB"
  | "NU"
  | "EP"
  | "SGR"
  | "XRF"
  | "TRANSIENT"
  | "OTHER";

export interface NormalizedIdentifier {
  /** The primary key used for matching and stored on the circular row. */
  canonical: string;
  /**
   * Every spelling worth trying, canonical first, de-duplicated. Uppercase
   * except where a form is case-significant by convention (GW superevent
   * suffixes are lowercase: S190510g, not S190510G).
   */
  renderings: string[];
  family: IdentifierFamily;
  /** The input, untouched. Kept so the source's own words survive. */
  raw: string;
}

// ─── Primitives ──────────────────────────────────────────────────────────────

/** Collapse whitespace runs to a single space and trim. */
function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Remove all whitespace. */
function despace(s: string): string {
  return s.replace(/\s+/g, "");
}

function pushUnique(out: string[], value: string | null | undefined): void {
  if (!value) return;
  const v = value.trim();
  if (v && !out.includes(v)) out.push(v);
}

// ─── Recognisers ─────────────────────────────────────────────────────────────
//
// Ordered by specificity: the GW superevent pattern must be tried before the
// generic ones because "LIGO/Virgo S190510g" also contains letters and digits
// that a looser pattern would happily mangle.

/**
 * LVK superevent: S or MS followed by YYMMDD and a short alphabetic suffix.
 *
 * Matched case-insensitively even though the suffix is lowercase by
 * convention. A producer writing "LIGO/Virgo S260605A" names the same
 * superevent, and a case-sensitive pattern silently fails to recognise it —
 * dropping the circular into the unrecognised branch, where it can never match
 * core.events. The suffix is lower-cased on the way out, so the canonical form
 * still matches the "S260605a" the igwn.gwalert normaliser writes.
 */
const GW_SUPEREVENT = /\b(MS|S)(\d{6})([a-z]{1,3})\b/i;
/** Published GW detection name: GW150914, GW170817, GW190425z. */
const GW_DETECTION = /\bGW\s?(\d{6})([a-zA-Z]{0,3})\b/;
/** GRB YYMMDDX — the dominant case, 34,615 of 41,420 archive identifiers. */
const GRB_NAME = /\bGRB\s?(\d{6})([A-Za-z]{0,3})\b/;
/** Einstein Probe transient: EP250215a. */
const EP_NAME = /\bEP\s?(\d{6})([A-Za-z]{0,3})\b/;
/** IceCube alert, either spelling: IceCube-250302A or IC250302A. */
const ICECUBE_NAME = /\b(?:ICECUBE|IC)[-\s]?(\d{6})([A-Za-z]{0,3})\b/i;
/** FRB, TNS-style (FRB 20250316A) or short (FRB250316A). */
const FRB_NAME = /\bFRB\s?(\d{6,8})([A-Za-z]{0,3})\b/;
/** Soft gamma repeater: SGR 1935+2154, SGR J1935+2154. */
const SGR_NAME = /\bSGR\s?J?(\d{4}[+-]\d{2,4})\b/i;
/** X-ray flash: XRF 040912. */
const XRF_NAME = /\bXRF\s?(\d{6})([A-Za-z]{0,3})\b/i;
/** Survey transients that GCN carries verbatim: AT2026nik, ZTF21aayokph. */
const TRANSIENT_NAME = /\b(AT|ZTF)\s?(\d{2,4}[A-Za-z0-9]{2,12})\b/i;

/**
 * Normalise one raw identifier string into a canonical form plus every
 * spelling worth trying.
 *
 * Returns null when the string contains nothing that looks like an event
 * identifier. Null is a real answer — "this circular names no event" — and
 * the caller must record it as UNMATCHED rather than guessing.
 */
export function normalizeEventIdentifier(raw: string | null | undefined): NormalizedIdentifier | null {
  if (typeof raw !== "string") return null;
  const input = squash(raw);
  if (!input) return null;

  const renderings: string[] = [];

  // ── GW superevent ─────────────────────────────────────────────────────────
  // "LIGO/Virgo S190510g", "Virgo/KAGRA S250206dm", "S230605o" all reduce to
  // the bare superevent id, which is exactly what the igwn.gwalert normaliser
  // writes into core.events.event_id.
  //
  // The suffix stays lowercase: LVK superevent ids are case-significant by
  // convention and core.events holds "S260605a". An uppercase rendering is
  // added too, because the archive importer upper-cased some rows.
  const gwSuper = GW_SUPEREVENT.exec(input);
  if (gwSuper) {
    const prefix = gwSuper[1]!.toUpperCase();
    const date = gwSuper[2]!;
    const suffix = gwSuper[3]!.toLowerCase();
    const canonical = `${prefix}${date}${suffix}`;
    pushUnique(renderings, canonical);
    pushUnique(renderings, canonical.toUpperCase());
    return { canonical, renderings, family: "GW", raw };
  }

  // ── GW published detection name ───────────────────────────────────────────
  // Note this is NOT linked to any superevent id. GW170817 and S170817a refer
  // to the same physical event, but that correspondence is catalogue
  // knowledge, not a spelling rule, and asserting it here would attach a
  // circular to an event on an assumption. See the header.
  const gwDet = GW_DETECTION.exec(input);
  if (gwDet) {
    const canonical = `GW${gwDet[1]!}${(gwDet[2] ?? "").toUpperCase()}`;
    pushUnique(renderings, canonical);
    return { canonical, renderings, family: "GW", raw };
  }

  // ── GRB ───────────────────────────────────────────────────────────────────
  const grb = GRB_NAME.exec(input);
  if (grb) {
    const canonical = `GRB${grb[1]!}${(grb[2] ?? "").toUpperCase()}`;
    pushUnique(renderings, canonical);
    return { canonical, renderings, family: "GRB", raw };
  }

  // ── Einstein Probe ────────────────────────────────────────────────────────
  // GCN writes the suffix lowercase (EP250215a); this archive's importer
  // stored EP260605A. Both spellings are tried.
  const ep = EP_NAME.exec(input);
  if (ep) {
    const digits = ep[1]!;
    const suffix = ep[2] ?? "";
    const canonical = `EP${digits}${suffix.toUpperCase()}`;
    pushUnique(renderings, canonical);
    pushUnique(renderings, `EP${digits}${suffix.toLowerCase()}`);
    return { canonical, renderings, family: "EP", raw };
  }

  // ── IceCube ───────────────────────────────────────────────────────────────
  // Both spellings genuinely coexist in core.events right now (IC260603A and
  // ICECUBE-251225A), so both are emitted. This is a re-spelling of one
  // identifier, not a claim about two events.
  const ic = ICECUBE_NAME.exec(input);
  if (ic) {
    const digits = ic[1]!;
    const suffix = (ic[2] ?? "").toUpperCase();
    const canonical = `ICECUBE-${digits}${suffix}`;
    pushUnique(renderings, canonical);
    pushUnique(renderings, `IC${digits}${suffix}`);
    pushUnique(renderings, `ICECUBE${digits}${suffix}`);
    return { canonical, renderings, family: "NU", raw };
  }

  // ── FRB ───────────────────────────────────────────────────────────────────
  // TNS names carry the century ("20250316A"); some producers drop it. Both
  // are emitted when the input is the 8-digit form.
  const frb = FRB_NAME.exec(input);
  if (frb) {
    const digits = frb[1]!;
    const suffix = (frb[2] ?? "").toUpperCase();
    const canonical = `FRB${digits}${suffix}`;
    pushUnique(renderings, canonical);
    if (digits.length === 8) pushUnique(renderings, `FRB${digits.slice(2)}${suffix}`);
    if (digits.length === 6) pushUnique(renderings, `FRB20${digits}${suffix}`);
    return { canonical, renderings, family: "FRB", raw };
  }

  // ── SGR ───────────────────────────────────────────────────────────────────
  const sgr = SGR_NAME.exec(input);
  if (sgr) {
    const body = sgr[1]!;
    const canonical = `SGR${body}`;
    pushUnique(renderings, canonical);
    pushUnique(renderings, `SGRJ${body}`);
    return { canonical, renderings, family: "SGR", raw };
  }

  // ── XRF ───────────────────────────────────────────────────────────────────
  const xrf = XRF_NAME.exec(input);
  if (xrf) {
    const canonical = `XRF${xrf[1]!}${(xrf[2] ?? "").toUpperCase()}`;
    pushUnique(renderings, canonical);
    return { canonical, renderings, family: "XRF", raw };
  }

  // ── Survey transients (AT / ZTF) ──────────────────────────────────────────
  const transient = TRANSIENT_NAME.exec(input);
  if (transient) {
    const canonical = `${transient[1]!.toUpperCase()}${transient[2]!.toUpperCase()}`;
    pushUnique(renderings, canonical);
    return { canonical, renderings, family: "TRANSIENT", raw };
  }

  // ── Unrecognised ──────────────────────────────────────────────────────────
  // GCN publishes identifiers this module has no rule for — "Baksan Neutrino
  // Observatory Alert 201027.41", "sb25042207". Rather than discard them, the
  // string is carried through in two mechanical spellings so an exact match
  // against core.events can still succeed. Nothing is inferred from it.
  const upper = input.toUpperCase();
  pushUnique(renderings, upper);
  pushUnique(renderings, despace(upper));
  const canonical = renderings[0]!;
  return { canonical, renderings, family: "OTHER", raw };
}

// ─── Subject-line fallback ───────────────────────────────────────────────────

/**
 * Patterns tried against a subject line, most specific first.
 *
 * Used only when GCN supplied no `eventId` — 3,346 of 44,766 archived
 * circulars (7.5%). The subject is far less reliable than the eventId field
 * because a circular often mentions several events ("GRB 250101A: further
 * observations, cf. GRB 241231B"), so the FIRST match wins and the decision is
 * recorded in the association rationale as subject-derived.
 */
const SUBJECT_PATTERNS: readonly RegExp[] = [
  GW_SUPEREVENT,
  GRB_NAME,
  EP_NAME,
  ICECUBE_NAME,
  FRB_NAME,
  GW_DETECTION,
  SGR_NAME,
  XRF_NAME,
  TRANSIENT_NAME,
];

/**
 * Extract an event identifier from a circular's subject line.
 *
 * Returns null when the subject names nothing recognisable. Null is recorded
 * as UNMATCHED — never resolved by guessing from the body text, which is
 * where other events are most often cited in passing.
 */
export function identifierFromSubject(subject: string | null | undefined): NormalizedIdentifier | null {
  if (typeof subject !== "string") return null;
  const text = squash(subject);
  if (!text) return null;

  for (const pattern of SUBJECT_PATTERNS) {
    const m = pattern.exec(text);
    if (m) {
      const found = normalizeEventIdentifier(m[0]);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Resolve the identifier for a circular: GCN's own `eventId` when present,
 * otherwise the subject line.
 *
 * The two sources are distinguished in the return value because they do not
 * carry the same weight — `eventId` is GCN's structured assertion, a subject
 * match is this module's reading of free text — and the association rationale
 * must say which one was used.
 */
export function resolveCircularIdentifier(circular: {
  eventId?: string | null;
  subject?: string | null;
}): { identifier: NormalizedIdentifier; origin: "eventId" | "subject" } | null {
  const fromField = normalizeEventIdentifier(circular.eventId);
  if (fromField) return { identifier: fromField, origin: "eventId" };

  const fromSubject = identifierFromSubject(circular.subject);
  if (fromSubject) return { identifier: fromSubject, origin: "subject" };

  return null;
}

// ─── Alias renderings for an existing event ──────────────────────────────────

/**
 * Every spelling of a `core.events.event_id` that a circular might use.
 *
 * Seeded into core.event_aliases so association Level 2 is an index lookup
 * rather than a scan. Purely mechanical: the canonical id plus the same
 * re-spellings normalizeEventIdentifier() would produce for it.
 */
export function renderingsForEventId(eventId: string): string[] {
  const out: string[] = [];
  pushUnique(out, eventId.trim().toUpperCase());
  const normalized = normalizeEventIdentifier(eventId);
  if (normalized) for (const r of normalized.renderings) pushUnique(out, r.toUpperCase());
  return out;
}
