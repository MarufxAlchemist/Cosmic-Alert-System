/**
 * eventGroups.ts — the messenger taxonomy the Event Archive browses by
 * ---------------------------------------------------------------------------
 * ONE DEFINITION, SERVER-SIDE. The archive's group counts, its filtering and
 * its drill-in all read from here, so a card that says "218 events" and the
 * list you get when you click it cannot disagree. The previous grouping lived
 * in the React page and only reorganised the 24 events on the current page —
 * "8 on this page" was not a category count and could not be used to reason
 * about the archive.
 *
 * WHY A GROUP IS NOT THE SAME AS AN event_type
 * --------------------------------------------
 * `core.events.event_type` records what the INGEST PATH called an event, and
 * the two paths disagree for the same instrument:
 *
 *   Einstein Probe alerts arriving live  -> event_type 'GRB'  (topics.py TOPIC_METADATA)
 *   the same mission via the archive importer -> event_type 'EP'  (ingest_gcn_archive.py)
 *
 * So 52 Einstein Probe transients sit under 'EP' while their live-ingested
 * counterparts sit under 'GRB'. A scientist browsing gamma-ray bursts must see
 * both — splitting them would hide 52 events behind a labelling artefact that
 * has nothing to do with the astrophysics.
 *
 * The merge is therefore deliberate, but it is never silent: every group
 * publishes its `memberTypes` and a per-type breakdown, and the UI shows both,
 * so the composition of a group is always visible rather than assumed.
 */

/** A browsable category in the Event Archive. */
export interface EventGroup {
  /** Stable URL-safe key. Appears in `?group=` — do not rename casually. */
  key: string;
  label: string;
  /** What this group contains, in a scientist's terms. */
  description: string;
  /**
   * The `core.events.event_type` values this group selects.
   *
   * More than one entry means the group deliberately spans labels that the
   * ingest paths assign inconsistently. `note` must then explain it.
   */
  memberTypes: readonly string[];
  /**
   * Stated only when `memberTypes` has more than one entry, or when the group's
   * membership would otherwise surprise someone. Rendered in the UI.
   */
  note?: string;
}

export const EVENT_GROUPS: readonly EventGroup[] = [
  {
    key: "GRB",
    label: "Gamma-ray Bursts",
    description:
      "Prompt high-energy transients: gamma-ray bursts and the X-ray transients reported alongside them.",
    memberTypes: ["GRB", "EP"],
    note:
      "Includes Einstein Probe X-ray transients. This archive labels the same mission 'GRB' when a " +
      "notice arrives live and 'EP' when it came from the circular archive import, so both are " +
      "shown together rather than hiding one behind a labelling difference.",
  },
  {
    key: "GW",
    label: "Gravitational Waves",
    description: "Compact-binary and burst candidates from the LIGO/Virgo/KAGRA network.",
    memberTypes: ["GW"],
  },
  {
    key: "FRB",
    label: "Fast Radio Bursts",
    description: "Millisecond-duration radio transients, predominantly from CHIME.",
    memberTypes: ["FRB"],
  },
  {
    key: "NU",
    label: "Neutrinos",
    description: "High-energy neutrino candidates, predominantly IceCube track alerts.",
    memberTypes: ["NU"],
  },
  {
    key: "OTHER",
    label: "Unclassified Transients",
    description:
      "Events whose identifier matched no known messenger convention on ingest — survey transients and the like.",
    memberTypes: ["OTHER"],
    note:
      "'Unclassified' describes what the ingest pipeline could determine from the identifier, not " +
      "the nature of the source. These are not low-quality events.",
  },
] as const;

export function findGroup(key: string | undefined | null): EventGroup | null {
  if (!key) return null;
  const k = key.trim().toUpperCase();
  return EVENT_GROUPS.find((g) => g.key === k) ?? null;
}

/**
 * Every event_type the taxonomy accounts for.
 *
 * Used to detect types that exist in the database but belong to no group —
 * those events would be invisible in the archive, which is precisely the class
 * of bug this module exists to prevent.
 */
export function groupedTypes(): Set<string> {
  return new Set(EVENT_GROUPS.flatMap((g) => [...g.memberTypes]));
}
