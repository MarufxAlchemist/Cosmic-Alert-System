/**
 * identity.test.ts
 * ----------------
 * Identifier normalisation is the load-bearing part of circular association:
 * get it wrong and a human-authored scientific report lands on the wrong
 * burst. Every case below is a real string — either an eventId observed in the
 * 44,766-circular GCN archive, or an event_id observed in core.events.
 */

import { describe, expect, it } from "vitest";
import {
  identifierFromSubject,
  normalizeEventIdentifier,
  renderingsForEventId,
  resolveCircularIdentifier,
} from "./identity.js";

describe("GRB names", () => {
  it("collapses the space GCN puts in its eventId", () => {
    // Archive writes "GRB 141031B"; core.events holds "GRB260609A".
    expect(normalizeEventIdentifier("GRB 141031B")?.canonical).toBe("GRB141031B");
    expect(normalizeEventIdentifier("GRB141031B")?.canonical).toBe("GRB141031B");
  });

  it("upper-cases the suffix so GRB 250101a and GRB 250101A are one event", () => {
    expect(normalizeEventIdentifier("GRB 250101a")?.canonical).toBe("GRB250101A");
  });

  it("keeps multi-letter suffixes, which do occur", () => {
    expect(normalizeEventIdentifier("GRB 250101AB")?.canonical).toBe("GRB250101AB");
  });

  it("reports the GRB family", () => {
    expect(normalizeEventIdentifier("GRB 141031B")?.family).toBe("GRB");
  });
});

describe("GW superevents", () => {
  it.each([
    ["LIGO-Virgo S190510g", "S190510g"],
    ["LIGO/Virgo S191129u", "S191129u"],
    ["Virgo/KAGRA S250206dm", "S250206dm"],
    ["S260605a", "S260605a"],
    ["MS260605a", "MS260605a"],
  ])("strips the survey prefix: %s -> %s", (input, expected) => {
    expect(normalizeEventIdentifier(input)?.canonical).toBe(expected);
  });

  it("keeps the suffix lowercase, because core.events holds S260605a", () => {
    // Upper-casing it would stop the bare superevent id from matching the row
    // the igwn.gwalert normaliser actually wrote.
    expect(normalizeEventIdentifier("LIGO/Virgo S260605A")?.canonical).toBe("S260605a");
  });

  it("also offers an upper-case rendering, because the archive importer used one", () => {
    expect(normalizeEventIdentifier("S260605a")?.renderings).toContain("S260605A");
  });

  it("does NOT equate GW170817 with a superevent id", () => {
    // GW170817 and S170817a are the same physical event, but that is catalogue
    // knowledge. Asserting it here would attach circulars on an assumption.
    const gw = normalizeEventIdentifier("GW170817");
    expect(gw?.canonical).toBe("GW170817");
    expect(gw?.renderings.some((r) => r.startsWith("S"))).toBe(false);
  });
});

describe("IceCube", () => {
  it("offers both spellings, because core.events genuinely holds both", () => {
    // IC260603A and ICECUBE-251225A are both present in this deployment.
    const r = normalizeEventIdentifier("IceCube-250302A")?.renderings ?? [];
    expect(r).toContain("ICECUBE-250302A");
    expect(r).toContain("IC250302A");
  });

  it("normalises the short spelling to the same candidate set", () => {
    const long = normalizeEventIdentifier("IceCube-250302A")?.renderings ?? [];
    const short = normalizeEventIdentifier("IC250302A")?.renderings ?? [];
    expect(short).toContain("ICECUBE-250302A");
    expect(long).toContain("IC250302A");
  });

  it("classifies IceCube as the neutrino family", () => {
    expect(normalizeEventIdentifier("IceCube-201014A")?.family).toBe("NU");
  });

  it("does not match a catalogue name like IC443", () => {
    // Six digits are required; IC443 is a supernova remnant, not an alert.
    expect(normalizeEventIdentifier("IC443")?.family).toBe("OTHER");
  });
});

describe("Einstein Probe", () => {
  it("offers both suffix cases, because GCN and the importer disagree", () => {
    // GCN writes EP250215a; the archive importer stored EP260605A.
    const r = normalizeEventIdentifier("EP250215a")?.renderings ?? [];
    expect(r).toContain("EP250215A");
    expect(r).toContain("EP250215a");
  });
});

describe("FRB", () => {
  it("handles the TNS century-prefixed form", () => {
    expect(normalizeEventIdentifier("FRB 20250316A")?.canonical).toBe("FRB20250316A");
  });

  it("offers the short form as an alternate rendering", () => {
    expect(normalizeEventIdentifier("FRB 20250316A")?.renderings).toContain("FRB250316A");
  });

  it("offers the long form when given the short one", () => {
    expect(normalizeEventIdentifier("FRB250316A")?.renderings).toContain("FRB20250316A");
  });
});

describe("other identifier families in the archive", () => {
  it("SGR, with and without the J", () => {
    expect(normalizeEventIdentifier("SGR 1935+2154")?.canonical).toBe("SGR1935+2154");
    expect(normalizeEventIdentifier("SGR J1935+2154")?.canonical).toBe("SGR1935+2154");
  });

  it("XRF", () => {
    expect(normalizeEventIdentifier("XRF 040912")?.canonical).toBe("XRF040912");
  });

  it("survey transients", () => {
    expect(normalizeEventIdentifier("AT2026nik")?.canonical).toBe("AT2026NIK");
    expect(normalizeEventIdentifier("ZTF21aayokph")?.canonical).toBe("ZTF21AAYOKPH");
  });

  it("carries an unrecognised identifier through rather than discarding it", () => {
    // "Baksan Neutrino Observatory Alert 201027.41" is a real archive eventId.
    // No rule covers it, so it is passed through verbatim in two mechanical
    // spellings — an exact match can still succeed and nothing is inferred.
    const r = normalizeEventIdentifier("Baksan Neutrino Observatory Alert 201027.41");
    expect(r?.family).toBe("OTHER");
    expect(r?.renderings).toContain("BAKSAN NEUTRINO OBSERVATORY ALERT 201027.41");
    expect(r?.renderings).toContain("BAKSANNEUTRINOOBSERVATORYALERT201027.41");
  });
});

describe("empty and malformed input", () => {
  it.each([null, undefined, "", "   "])("returns null for %s", (input) => {
    expect(normalizeEventIdentifier(input as string | null)).toBeNull();
  });

  it("preserves the source's own words in `raw`", () => {
    expect(normalizeEventIdentifier("GRB 141031B")?.raw).toBe("GRB 141031B");
  });
});

describe("subject-line fallback", () => {
  it("finds the event when GCN supplied no eventId", () => {
    // 7.5% of the archive has no eventId field.
    expect(identifierFromSubject("GRB 250101A: Swift-XRT observations")?.canonical).toBe("GRB250101A");
  });

  it("takes the FIRST event named, when a subject cites several", () => {
    const s = "GRB 250101A: further observations, cf. GRB 241231B";
    expect(identifierFromSubject(s)?.canonical).toBe("GRB250101A");
  });

  it("finds a superevent in a subject", () => {
    expect(identifierFromSubject("LIGO/Virgo S190510g: no counterpart")?.canonical).toBe("S190510g");
  });

  it("returns null for a subject naming nothing recognisable", () => {
    expect(identifierFromSubject("Request for observations of a nearby galaxy")).toBeNull();
  });
});

describe("resolveCircularIdentifier", () => {
  it("prefers GCN's eventId over the subject", () => {
    const r = resolveCircularIdentifier({
      eventId: "GRB 250101A",
      subject: "GRB 241231B: unrelated mention",
    });
    expect(r?.origin).toBe("eventId");
    expect(r?.identifier.canonical).toBe("GRB250101A");
  });

  it("falls back to the subject and says so", () => {
    const r = resolveCircularIdentifier({ eventId: null, subject: "GRB 250101A: XRT" });
    expect(r?.origin).toBe("subject");
    expect(r?.identifier.canonical).toBe("GRB250101A");
  });

  it("returns null when neither names an event", () => {
    expect(resolveCircularIdentifier({ eventId: null, subject: "General announcement" })).toBeNull();
  });
});

describe("renderingsForEventId", () => {
  it("always includes the canonical id itself", () => {
    expect(renderingsForEventId("GRB260609A")).toContain("GRB260609A");
  });

  it("bridges the two IceCube spellings present in core.events", () => {
    expect(renderingsForEventId("IC260603A")).toContain("ICECUBE-260603A");
    expect(renderingsForEventId("ICECUBE-251225A")).toContain("IC251225A");
  });

  it("passes an unparsed identifier through unchanged", () => {
    // CHIME's live event_id form has no matching rule; it must still be
    // registered so an exact match works.
    expect(renderingsForEventId("FRB20260816T133005Z")).toContain("FRB20260816T133005Z");
  });
});
