/**
 * pairingRules.ts — Multi-Messenger Correlation Engine (Phase 6.0A)
 * -----------------------------------------------------------------
 * Defines which event type pairs are physically meaningful, assigns a
 * pairing weight and a correlation type classification.
 *
 * Each rule is a pure record — no logic, easy to extend for new event types.
 *
 * Scientific basis references
 * ───────────────────────────
 *   GW  + GRB : GW170817 + GRB 170817A — confirmed NS-NS multi-messenger. Weight: 1.0
 *   EP  + GW  : X-ray afterglow from off-axis merger (EP/Swift kilonova).  Weight: 0.9
 *   GRB + NU  : Long GRB / collapsar hadronic jets (IceCube limits).       Weight: 0.8
 *   EP  + NU  : Delayed X-ray + neutrino from disk winds.                  Weight: 0.7
 *   GRB + EP  : Prompt X-ray afterglow from same relativistic jet.         Weight: 0.6
 *   GW  + NU  : Core-collapse SN 1987A precedent; compact mergers.         Weight: 0.55
 *   GW  + FRB : Theoretical compact merger → coherent radio (unconfirmed). Weight: 0.4
 *   FRB + GW  : Same as above (alias).
 *   FRB + NU  : Speculative; no established physical model.                Weight: 0.3
 *   GRB + FRB : Speculative GRB remnant magnetar FRB emission.             Weight: 0.2
 *   EP  + FRB : Speculative.                                               Weight: 0.15
 *   same type : Cross-instrument detection of same physical event.         Weight: 0.5
 *
 * Phase 6.0A — Transient Event Detection
 */

import type { CorrelationType } from "./types.js";

export interface PairingRule {
  /** Scientific explanation of why this pair may be physically correlated */
  physicalBasis: string;
  /** Pairing weight multiplier [0–1] applied to the combined geometric score */
  weight: number;
  /** Physical nature of this pair */
  correlationType: CorrelationType;
}

/** Canonical key format: sorted alphabetically, joined with "+" */
function pairKey(a: string, b: string): string {
  return [a.toUpperCase(), b.toUpperCase()].sort().join("+");
}

/**
 * All known physically motivated event type pairings.
 * Key: canonical pair key (e.g. "GRB+GW")
 */
const PAIRING_RULES: Record<string, PairingRule> = {
  // ── Tier 1: Confirmed multi-messenger associations ────────────────────────

  [pairKey("GW", "GRB")]: {
    weight: 1.0,
    correlationType: "multi_messenger",
    physicalBasis:
      "Confirmed multi-messenger counterpart type (GW170817 + GRB 170817A). " +
      "NS-NS or NS-BH merger produces both gravitational wave emission and short GRB prompt emission. " +
      "ΔT = +1.74 s in the confirmed event.",
  },

  // ── Tier 2: Strongly motivated associations ───────────────────────────────

  [pairKey("EP", "GW")]: {
    weight: 0.9,
    correlationType: "multi_messenger",
    physicalBasis:
      "Einstein Probe X-ray counterparts to GW events expected for off-axis NS-NS mergers. " +
      "Delayed X-ray emission from kilonova ejecta, cocoon, or structured jet viewed off-axis. " +
      "EP/Swift XRT joint observations probe hours-delayed counterparts.",
  },

  [pairKey("GRB", "NU")]: {
    weight: 0.8,
    correlationType: "multi_messenger",
    physicalBasis:
      "Long GRBs produced by collapsars are expected to emit high-energy neutrinos via " +
      "internal shock proton acceleration (hadronic jet model). " +
      "IceCube upper limits exist for several GRBs; no confirmed detection yet.",
  },

  [pairKey("EP", "NU")]: {
    weight: 0.7,
    correlationType: "multi_messenger",
    physicalBasis:
      "Delayed X-ray emission and high-energy neutrinos expected from disk wind-driven outflows " +
      "in NS-NS/NS-BH merger remnants. EP extended mission overlaps with late-time neutrino emission.",
  },

  [pairKey("EP", "GRB")]: {
    weight: 0.6,
    correlationType: "multi_messenger",
    physicalBasis:
      "Einstein Probe WXT/FXT detect prompt and early X-ray afterglow from the same relativistic jet " +
      "responsible for the gamma-ray burst. Temporal coincidence expected within hours.",
  },

  [pairKey("GW", "NU")]: {
    weight: 0.55,
    correlationType: "multi_messenger",
    physicalBasis:
      "Core-collapse supernovae emit both gravitational waves and a neutrino burst (SN 1987A precedent). " +
      "Compact binary mergers may also produce neutrino emission from remnant accretion disk.",
  },

  // ── Tier 3: Speculative associations ─────────────────────────────────────

  [pairKey("GW", "FRB")]: {
    weight: 0.4,
    correlationType: "speculative",
    physicalBasis:
      "Several theoretical models predict coherent radio emission coincident with compact binary mergers " +
      "(Totani 2013; Lyutikov 2013; CHIME/FRB). No confirmed detection yet; association remains speculative.",
  },

  [pairKey("FRB", "NU")]: {
    weight: 0.3,
    correlationType: "speculative",
    physicalBasis:
      "Speculative coincident emission from energetic transients. " +
      "Magnetar flare models predict both coherent radio and high-energy particle emission.",
  },

  [pairKey("GRB", "FRB")]: {
    weight: 0.2,
    correlationType: "speculative",
    physicalBasis:
      "Proposed coherent radio emission associated with GRB remnant magnetars or engine activity. " +
      "Speculative; no confirmed association.",
  },

  [pairKey("EP", "FRB")]: {
    weight: 0.15,
    correlationType: "speculative",
    physicalBasis:
      "Speculative: X-ray and coherent radio emission from the same magnetar-powered transient. " +
      "No established physical model.",
  },
};

// ---------------------------------------------------------------------------
// Cross-detection rule (same event type, different observatory)
// ---------------------------------------------------------------------------

const CROSS_DETECTION_RULE: PairingRule = {
  weight: 0.5,
  correlationType: "cross_detection",
  physicalBasis:
    "Same event type detected by multiple instruments within a short time window. " +
    "This is likely a cross-instrument detection of the same physical event (not a new multi-messenger association). " +
    "Scientifically valuable for cross-calibration and localization improvement.",
};

// ---------------------------------------------------------------------------
// Default fallback (unknown pair)
// ---------------------------------------------------------------------------

const DEFAULT_RULE: PairingRule = {
  weight: 0.2,
  correlationType: "speculative",
  physicalBasis:
    "No established physical model connecting these event types. " +
    "Included as a speculative coincidence check.",
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the pairing rule for two event types.
 * Returns a cross-detection rule for same-type pairs.
 * Returns a low-weight speculative rule for unknown pairs (never null).
 *
 * @param typeA - First event type (e.g. "GW")
 * @param typeB - Second event type (e.g. "GRB")
 */
export function getPairingRule(typeA: string, typeB: string): PairingRule {
  const a = typeA.toUpperCase();
  const b = typeB.toUpperCase();

  // Same-type pair → cross-instrument detection
  if (a === b) return CROSS_DETECTION_RULE;

  const key = pairKey(a, b);
  return PAIRING_RULES[key] ?? DEFAULT_RULE;
}

/**
 * Check if two event types have a physically motivated pairing
 * (i.e. not just a speculative fallback and not cross-detection).
 */
export function isPhysicallyMotivatedPair(typeA: string, typeB: string): boolean {
  const rule = getPairingRule(typeA, typeB);
  return rule.correlationType === "multi_messenger";
}

/**
 * Get all defined pairing rules (for introspection / admin endpoints).
 */
export function getAllPairingRules(): Record<string, PairingRule> {
  return { ...PAIRING_RULES };
}
