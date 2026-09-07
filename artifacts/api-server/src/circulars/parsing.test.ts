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
  it.each([null, undefined, "a string", 42, [], true])(
    "degrades non-object hints %s to null instead of throwing",
    (raw) => {
      expect(normalizeRegexpHints(raw)).toBeNull();
    },
  );
});
