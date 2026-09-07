/**
 * parsing.test.ts
 * ---------------
 * What a circular must carry to be storable, and what it may legitimately omit.
 *
 * The rule that matters most is the `version` default: GCN omits the field
 * entirely on an original circular. Treating absent as "unknown" rather than
 * as 1 would make every original collide with every other on the
 * (circular_id, version) unique index, and the archive would refuse to load.
 */

import { describe, expect, it } from "vitest";
import {
  parseCircular,
  circularContentHash,
  normalizeRegexpHints,
  shouldSkipExtraction,
  CircularValidationError,
} from "./payload.js";

/** A real archive record (GCN Circular 35176), body abbreviated. */
const VALID = {
  subject: "GRB 231124A: CALET Gamma-Ray Burst Monitor detection",
  eventId: "GRB 231124A",
  submittedHow: "web",
  bibcode: "2023GCN.35176....1T",
  createdOn: 1700834480583,
  submitter: "Yuta Kawakubo at Louisiana State University <kawakubo1@lsu.edu>",
  circularId: 35176,
  body: "The long GRB 231124A triggered the CALET Gamma-ray Burst Monitor at 08:38:12.68 UTC.",
};

describe("a valid circular", () => {
  it("parses the real archive shape", () => {
    const c = parseCircular(VALID);
    expect(c.circularId).toBe(35176);
    expect(c.eventId).toBe("GRB 231124A");
    expect(c.submitter).toContain("Kawakubo");
  });

  it("defaults an absent version to 1, because GCN omits it on originals", () => {
    // 43,494 of 44,766 archived circulars have no version field.
    expect(parseCircular(VALID).version).toBe(1);
  });

  it("keeps an explicit version", () => {
    expect(parseCircular({ ...VALID, version: 3 }).version).toBe(3);
  });

  it("preserves unmodelled fields so nothing in the payload is lost", () => {
    const c = parseCircular({ ...VALID, someFutureField: "keep me" });
    expect(c["someFutureField"]).toBe("keep me");
  });
});

describe("optional fields", () => {
  it("accepts a circular with no eventId — 7.5% of the archive has none", () => {
    const { eventId: _drop, ...noEvent } = VALID;
    expect(parseCircular(noEvent).eventId).toBeNull();
  });

  it("normalises a missing format to null rather than assuming plain text", () => {
    // 85.7% of the archive states no format. null means "unstated".
    expect(parseCircular(VALID).format).toBeNull();
  });

  it("accepts revision metadata", () => {
    const c = parseCircular({ ...VALID, version: 2, editedOn: 1731005189257, editedBy: "Leo Singer" });
    expect(c.version).toBe(2);
    expect(c.editedOn).toBe(1731005189257);
    expect(c.editedBy).toBe("Leo Singer");
  });
});

describe("malformed circulars are refused, not stored half-formed", () => {
  it.each([
    ["missing subject", { ...VALID, subject: undefined }],
    ["empty subject", { ...VALID, subject: "   " }],
    ["missing body", { ...VALID, body: undefined }],
    ["empty body", { ...VALID, body: "" }],
    ["missing submitter", { ...VALID, submitter: undefined }],
  ])("%s", (_label, payload) => {
    expect(() => parseCircular(payload)).toThrow(CircularValidationError);
  });

  it("rejects a missing circularId — there would be no identity to dedupe on", () => {
    const { circularId: _drop, ...noId } = VALID;
    expect(() => parseCircular(noId)).toThrow(/circularId/);
  });

  it("rejects a non-numeric circularId", () => {
    expect(() => parseCircular({ ...VALID, circularId: "35176abc" })).toThrow(CircularValidationError);
    expect(() => parseCircular({ ...VALID, circularId: null })).toThrow(CircularValidationError);
    expect(() => parseCircular({ ...VALID, circularId: "" })).toThrow(CircularValidationError);
  });

  it.each([-1, -4, 0, 18448.5, 18453.5])(
    "ACCEPTS the real archive's unusual id %s",
    (id) => {
      // These seven exist. -4 is "GRB 970228: Keck/LRIS Optical Observations",
      // the first GRB with an optical counterpart; 18448.5 was slotted between
      // two already-numbered circulars. Requiring a positive integer discarded
      // all of them, which is discarding original source material.
      expect(parseCircular({ ...VALID, circularId: id }).circularId).toBe(id);
    },
  );

  it("rejects a missing createdOn — a timeline entry needs a timestamp", () => {
    const { createdOn: _drop, ...noTime } = VALID;
    expect(() => parseCircular(noTime)).toThrow(/createdOn/);
  });

  it("rejects version 0 and negative versions", () => {
    expect(() => parseCircular({ ...VALID, version: 0 })).toThrow(CircularValidationError);
    expect(() => parseCircular({ ...VALID, version: -1 })).toThrow(CircularValidationError);
  });

  it.each([null, undefined, "a string", 42, []])("rejects non-object payload %s", (payload) => {
    expect(() => parseCircular(payload)).toThrow(CircularValidationError);
  });
});

describe("content hash", () => {
  it("is stable for identical content", () => {
    expect(circularContentHash("s", "b")).toBe(circularContentHash("s", "b"));
  });

  it("changes when the body changes, so a revision is not served a stale extraction", () => {
    expect(circularContentHash("s", "b")).not.toBe(circularContentHash("s", "b2"));
  });

  it("changes when the subject changes", () => {
    expect(circularContentHash("s", "b")).not.toBe(circularContentHash("s2", "b"));
  });

  it("does not collide across the subject/body boundary", () => {
    // Without a separator, ("ab","c") and ("a","bc") would hash identically
    // and one circular would be served another's extraction.
    expect(circularContentHash("ab", "c")).not.toBe(circularContentHash("a", "bc"));
  });
});

describe("regexp hints (Priority #5 — astro-colibri-circular-parser)", () => {
  it("passes through a plain object from the Python consumer unchanged", () => {
    const hints = { likely_redshift_report: true, matched_terms: ["redshift"] };
    expect(normalizeRegexpHints(hints)).toEqual(hints);
  });

  // The Python side sends null whenever the parser package is unavailable or
  // the archive backfill (which never runs the Python step) supplies nothing.
  // Both must degrade to null, never throw — a hints problem must never be
  // why an otherwise-good circular gets rejected.
  // Labelled rather than raw values: `%s` renders [] as "undefined", so the
  // empty-array case was indistinguishable from the undefined case in the
  // reporter — two tests with the same name, one of them silently unverifiable.
  it.each([
    { label: "null", raw: null },
    { label: "undefined", raw: undefined },
    { label: "a string", raw: "a string" },
    { label: "a number", raw: 42 },
    { label: "an empty array", raw: [] },
    { label: "an array of entries", raw: [{ a: 1 }] },
    { label: "a boolean", raw: true },
  ])("degrades $label to null instead of throwing", ({ raw }) => {
    expect(normalizeRegexpHints(raw)).toBeNull();
  });
});

describe("extraction cost prefilter (shouldSkipExtraction)", () => {
  /** Every content flag false, no contacts — the skippable shape. */
  const INERT = {
    likely_optical_followup: false,
    likely_redshift_report: false,
    likely_retraction: false,
    likely_correction: false,
    likely_upper_limit: false,
    likely_high_energy_detection: false,
    local_likely_xray_radio_followup: false,
    contact_email_count: 0,
  };

  it("skips a routine GRB circular whose hints show no scientific content", () => {
    expect(shouldSkipExtraction("GRB240218A", INERT)).toBe(true);
  });

  // SAFETY PROPERTY 1. Measured over the real archive, a flags-only rule
  // skipped 99.2% of GW, 100% of FRB and 99.4% of neutrino circulars —
  // including the LVK compact-binary-merger identification circulars that
  // carry the FAR, the BNS/BBH/NSBH probabilities and the credible area. The
  // hint vocabulary simply does not cover that language, so the event family
  // gates the filter, not the flags.
  describe("never skips a non-GRB circular, whatever the flags say", () => {
    it.each([
      { label: "a GW superevent id", id: "S240705AT" },
      { label: "a GW event id", id: "GW170817" },
      { label: "an IceCube neutrino id", id: "ICECUBE-251225A" },
      { label: "an FRB id", id: "FRB20240114A" },
      { label: "an Einstein Probe id", id: "EP250215A" },
      { label: "an SGR id", id: "SGR1935+2154" },
      { label: "no identifier at all", id: null },
      { label: "an empty identifier", id: "" },
    ])("$label", ({ id }) => {
      expect(shouldSkipExtraction(id, INERT)).toBe(false);
    });
  });

  // SAFETY PROPERTY 2. null means "not computed" — the parser was
  // unavailable, or the row came through the archive backfill, which never
  // runs the Python hints step. It does NOT mean "the regex found nothing".
  // All 44,777 rows predating migration 0022 have null hints.
  describe("never skips when the hint set is absent or unusable", () => {
    it.each([
      { label: "null hints", raw: null },
      { label: "undefined hints", raw: undefined },
      { label: "a string", raw: "hints" },
      { label: "an array", raw: [] },
    ])("$label", ({ raw }) => {
      expect(shouldSkipExtraction("GRB240218A", raw)).toBe(false);
    });
  });

  describe("never skips when any single content flag fires", () => {
    it.each([
      "likely_optical_followup",
      "likely_redshift_report",
      "likely_retraction",
      "likely_correction",
      "likely_upper_limit",
      "likely_high_energy_detection",
      "local_likely_xray_radio_followup",
    ])("%s", (flag) => {
      expect(shouldSkipExtraction("GRB240218A", { ...INERT, [flag]: true })).toBe(false);
    });
  });

  it("never skips when the circular names contacts", () => {
    expect(shouldSkipExtraction("GRB240218A", { ...INERT, contact_email_count: 3 })).toBe(false);
  });

  // REGRESSION — GCN Circulars 22372 and 22374.
  //
  // Chandra X-ray monitoring of GW170817/GRB170817A, the first GW/GRB
  // coincidence. Their identifier is GRB170817A (GCN's own eventId reads
  // "GRB 170817A"), so they ARE in scope for skipping, and they set none of
  // the six upstream flags: X-ray monitoring language is not optical, quotes
  // no redshift, retracts nothing and is not an upper limit. Before the
  // local_likely_xray_radio_followup flag existed, both were skipped.
  //
  // If this test fails, the X-ray/radio guard has been dropped and the
  // archive is quietly losing X-ray follow-up of its most important event.
  describe("regression: the GW170817/GRB170817A Chandra circulars are not skipped", () => {
    it.each([
      { circularId: 22372, subject: "GW170817/GRB170817A: Preliminary results of Chandra monitoring" },
      { circularId: 22374, subject: "GW170817/GRB170817A: Updated results from the full Chandra dataset" },
    ])("circular $circularId", ({ subject }) => {
      expect(subject).toMatch(/Chandra/);
      // The Python hints step sets this flag for exactly this language.
      const hints = { ...INERT, local_likely_xray_radio_followup: true };
      expect(shouldSkipExtraction("GRB170817A", hints)).toBe(false);
    });
  });

  it("matches the GRB prefix case-insensitively", () => {
    expect(shouldSkipExtraction("grb240218a", INERT)).toBe(true);
  });

  // A flag that is present but not literally `true` is not a licence to skip:
  // only an explicit false-or-absent set qualifies, and anything truthy-but-
  // odd (a string, a number) must be treated as content rather than ignored.
  it("treats a non-boolean truthy flag as content, not as absent", () => {
    expect(shouldSkipExtraction("GRB240218A", { ...INERT, likely_upper_limit: "yes" })).toBe(false);
  });
});
