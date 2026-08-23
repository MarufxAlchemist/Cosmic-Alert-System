/**
 * scoringRules.ts — Scientific Priority Classification Engine
 * -----------------------------------------------------------
 * Individual scoring rule evaluators.
 *
 * Architecture
 * ────────────
 *   • Every rule is a named pure function.
 *   • Signature: (event, thresholds) → ScoringFactor
 *   • Rules are completely independent — no rule reads another rule's output.
 *   • All rules are exported for unit testing without the full classifier.
 *   • Adding a new rule: implement the function, export it, add it to
 *     ALL_RULES in classifier.ts. No other files change.
 *
 * Score conventions
 * ─────────────────
 *   +40   Dominant positive signal (GW event type)
 *   +15   Strong positive (observatory, classification tier BRONZE)
 *   +25   Strongest positive (GOLD tier)
 *    0    Rule does not apply → `contributed: false`
 *   −15   Significant penalty (heavy revision, very poor localization)
 *   −100  Vetoes the event entirely (retraction) → P3 immediately
 *
 * Phase 5.2 — Transient Event Detection
 */

import type { EventClassificationInput } from "./types.js";
import type { ScoringFactor }            from "./types.js";
import type { Thresholds }               from "./thresholds.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function factor(
  name: string,
  score: number,
  reason: string,
): ScoringFactor {
  return { name, score, reason, contributed: score !== 0 && reason !== "" };
}

function noContribution(name: string): ScoringFactor {
  return { name, score: 0, reason: "", contributed: false };
}

// ---------------------------------------------------------------------------
// Rule 1 — Retraction veto
// ---------------------------------------------------------------------------

/**
 * A retraction notice immediately forces P3.
 * Score −100 ensures no combination of positive rules can overcome it.
 */
export function evaluateRetraction(
  event: EventClassificationInput,
): ScoringFactor {
  if (event.isRetraction) {
    return factor(
      "retraction_veto",
      -100,
      "Event is a retraction — previous alert was withdrawn",
    );
  }
  return noContribution("retraction_veto");
}

// ---------------------------------------------------------------------------
// Rule 2 — Historical / bootstrap event
// ---------------------------------------------------------------------------

/**
 * Historical events are useful for research but not for immediate notifications.
 * Apply a strong penalty so they land in P3 unless other factors are extreme.
 */
export function evaluateHistorical(
  event: EventClassificationInput,
): ScoringFactor {
  if (event.isHistorical) {
    return factor(
      "historical_penalty",
      -30,
      "Historical/bootstrap event — not a live detection",
    );
  }
  return noContribution("historical_penalty");
}

// ---------------------------------------------------------------------------
// Rule 3 — Event type (astrophysical significance)
// ---------------------------------------------------------------------------

/**
 * Gravitational waves are the rarest and highest-impact events.
 * Neutrinos are rare multi-messenger signals.
 * GRBs and FRBs are more common but still important.
 */
export function evaluateEventType(
  event: EventClassificationInput,
): ScoringFactor {
  const type = event.eventType?.toUpperCase();

  switch (type) {
    case "GW":
      return factor("event_type", 40, "Gravitational wave event");
    case "NU":
      return factor("event_type", 30, "High-energy neutrino event");
    case "GRB":
      return factor("event_type", 20, "Gamma-ray burst");
    case "FRB":
      return factor("event_type", 15, "Fast radio burst");
    default:
      return factor("event_type", 10, `Astrophysical transient (${type ?? "unknown"})`);
  }
}

// ---------------------------------------------------------------------------
// Rule 4 — Lifecycle / alert maturity
// ---------------------------------------------------------------------------

/**
 * Confirmed events have passed multi-instrument cross-checks.
 * Preliminary notices are tentative — important but unverified.
 */
export function evaluateLifecycle(
  event: EventClassificationInput,
): ScoringFactor {
  switch (event.lifecycle?.toLowerCase()) {
    case "confirmed":
      return factor("lifecycle", 20, "Confirmed detection");
    case "initial":
      return factor("lifecycle", 15, "Initial detection notice");
    case "update":
      return factor("lifecycle", 10, "Updated alert notice");
    case "preliminary":
      return factor("lifecycle", 5,  "Preliminary detection (unconfirmed)");
    default:
      return noContribution("lifecycle");
  }
}

// ---------------------------------------------------------------------------
// Rule 5 — Observatory prestige / reliability
// ---------------------------------------------------------------------------

/**
 * Instruments with stricter quality pipelines and higher detection thresholds
 * receive a higher score contribution.
 */
export function evaluateObservatory(
  event: EventClassificationInput,
): ScoringFactor {
  const obs = event.observatory?.toLowerCase() ?? "";

  // LIGO / Virgo / KAGRA — gravitational wave network
  if (obs.includes("ligo") || obs.includes("virgo") || obs.includes("kagra")) {
    return factor("observatory", 15, `${event.observatory} (GW network)`);
  }

  // IceCube — high-energy neutrino detector
  if (obs.includes("icecube")) {
    return factor("observatory", 12, "IceCube Neutrino Observatory");
  }

  // Swift BAT — gold-standard GRB localization
  if (obs.includes("swift")) {
    return factor("observatory", 10, "Swift (BAT) — precise GRB localizer");
  }

  // Einstein Probe — new X-ray wide-field monitor
  if (obs.includes("einstein probe") || obs.includes("einstein_probe")) {
    return factor("observatory", 8, "Einstein Probe (WXT)");
  }

  // CHIME — leading FRB survey telescope
  if (obs.includes("chime")) {
    return factor("observatory", 6, "CHIME/FRB");
  }

  // Fermi GBM / LAT
  if (obs.includes("fermi")) {
    return factor("observatory", 5, "Fermi (GBM/LAT)");
  }

  return factor("observatory", 2, `${event.observatory}`);
}

// ---------------------------------------------------------------------------
// Rule 6 — Classification tier (IceCube GOLD / BRONZE)
// ---------------------------------------------------------------------------

/**
 * IceCube GOLD events have the highest probability of astrophysical origin.
 * BRONZE events are still significant but with lower confidence.
 */
export function evaluateClassificationTier(
  event: EventClassificationInput,
): ScoringFactor {
  const tier = event.classificationTier?.toUpperCase();

  switch (tier) {
    case "GOLD":
      return factor("classification_tier", 25, "IceCube GOLD tier — high astrophysical probability");
    case "BRONZE":
      return factor("classification_tier", 12, "IceCube BRONZE tier — moderate astrophysical probability");
    default:
      return noContribution("classification_tier");
  }
}

// ---------------------------------------------------------------------------
// Rule 7 — Signal quality (SNR)
// ---------------------------------------------------------------------------

/**
 * Higher SNR → more confident detection.
 * Very low SNR may be noise — applies a small penalty.
 */
export function evaluateSignalQuality(
  event: EventClassificationInput,
  thresholds: Thresholds,
): ScoringFactor {
  const snr = event.snr ?? 0;

  if (snr === 0) return noContribution("signal_quality");

  if (snr >= thresholds.snrHigh) {
    return factor("signal_quality", 15, `High SNR (${snr.toFixed(1)})`);
  }
  if (snr >= thresholds.snrMedium) {
    return factor("signal_quality", 5, `Moderate SNR (${snr.toFixed(1)})`);
  }
  // Sub-threshold SNR — small penalty
  return factor("signal_quality", -5, `Low SNR (${snr.toFixed(1)}) — detection quality uncertain`);
}

// ---------------------------------------------------------------------------
// Rule 8 — Localization accuracy
// ---------------------------------------------------------------------------

/**
 * Smaller error radius → better sky localization → feasible telescope follow-up.
 * Large error regions make optical/X-ray follow-up impractical.
 */
export function evaluateLocalization(
  event: EventClassificationInput,
  thresholds: Thresholds,
): ScoringFactor {
  const r = event.errorRadius ?? 0;
  if (r <= 0) return noContribution("localization");

  if (r <= thresholds.localizationGood) {
    return factor(
      "localization",
      10,
      `Good localization (${r.toFixed(1)} arcmin) — follow-up feasible`,
    );
  }
  if (r >= thresholds.localizationPoor) {
    return factor(
      "localization",
      -5,
      `Poor localization (${r.toFixed(0)} arcmin) — follow-up challenging`,
    );
  }
  return factor("localization", 2, `Localization: ${r.toFixed(0)} arcmin`);
}

// ---------------------------------------------------------------------------
// Rule 9 — Revision penalty
// ---------------------------------------------------------------------------

/**
 * Repeated updates to the same event are important but not as urgent as the
 * first notice. Each revision subtracts a configurable score, capped at max.
 */
export function evaluateRevision(
  event: EventClassificationInput,
  thresholds: Thresholds,
): ScoringFactor {
  const count = event.revisionCount ?? 0;
  if (count <= 0) return noContribution("revision");

  const penalty = Math.min(
    count * thresholds.revisionPenaltyPerCount,
    thresholds.revisionPenaltyMax,
  );

  return factor(
    "revision",
    -penalty,
    `Revision ${count} of existing event (−${penalty} score)`,
  );
}

// ---------------------------------------------------------------------------
// Rule 10 — GW False Alarm Rate
// ---------------------------------------------------------------------------

/**
 * FAR is the rate at which noise produces events as loud as this detection.
 * Lower FAR = rarer = more significant = higher priority.
 * Only applied for GW events.
 */
export function evaluateFARScore(
  event: EventClassificationInput,
  thresholds: Thresholds,
): ScoringFactor {
  if (event.eventType?.toUpperCase() !== "GW") return noContribution("far_score");
  const far = event.far ?? 0;
  if (far <= 0) return noContribution("far_score");

  if (far <= thresholds.gwFarCritical) {
    const yearsPerEvent = 1 / (far * 3.156e7);
    return factor(
      "far_score",
      20,
      `Exceptionally low FAR (1 per ${yearsPerEvent.toFixed(0)} yr) — extremely rare event`,
    );
  }
  if (far <= thresholds.gwFarHigh) {
    return factor("far_score", 10, `Low FAR (${far.toExponential(1)} Hz) — significant detection`);
  }
  return factor("far_score", 0, `FAR ${far.toExponential(1)} Hz`);
}

// ---------------------------------------------------------------------------
// Rule 11 — GRB properties (fluence + duration)
// ---------------------------------------------------------------------------

/**
 * High-fluence, long-duration GRBs are the most energetic and most likely
 * to have detectable afterglows — highest scientific value.
 */
export function evaluateGRBProperties(
  event: EventClassificationInput,
  thresholds: Thresholds,
): ScoringFactor {
  if (event.eventType?.toUpperCase() !== "GRB") return noContribution("grb_properties");

  const reasons: string[] = [];
  let score = 0;

  const fluence = event.fluence ?? null;
  if (fluence != null && fluence > 0) {
    if (fluence >= thresholds.grbFluenceHigh) {
      score += 10;
      reasons.push(`High fluence (${fluence.toExponential(1)} erg/cm²)`);
    } else if (fluence >= thresholds.grbFluenceMedium) {
      score += 5;
      reasons.push(`Moderate fluence (${fluence.toExponential(1)} erg/cm²)`);
    }
  }

  const t90 = event.t90 ?? null;
  if (t90 != null && t90 > 0) {
    if (t90 >= thresholds.grbT90Long) {
      score += 5;
      reasons.push(`Long-duration GRB (T90 = ${t90.toFixed(1)} s)`);
    } else {
      reasons.push(`Short-duration GRB (T90 = ${t90.toFixed(2)} s)`);
    }
  }

  if (score === 0 && reasons.length === 0) return noContribution("grb_properties");

  return factor("grb_properties", score, reasons.join("; "));
}
