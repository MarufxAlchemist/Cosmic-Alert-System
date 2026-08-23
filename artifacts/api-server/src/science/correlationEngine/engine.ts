/**
 * engine.ts — Multi-Messenger Correlation Engine (Phase 6.0A)
 * -----------------------------------------------------------
 * Main orchestrator. Runs scorePair() for every candidate, picks the best
 * match, maps score to confidence, and generates the CorrelationResult.
 *
 * Flow
 * ────
 *   correlate(input)
 *     │
 *     ├─ 1. Load coincidence windows (getCoincidenceWindows)
 *     ├─ 2. Score every candidate pair (scorePair) — Gaussian geometric mean
 *     ├─ 3. Sort matches by score descending
 *     ├─ 4. Pick best match (highest score, must have temporalMatch)
 *     ├─ 5. Map score → CorrelationConfidence
 *     ├─ 6. Generate scientific_assessment, followup_recommendation, reasoning
 *     └─ 7. Return CorrelationResult with nCandidates
 *
 * Output matches docs/correlation.txt schema exactly.
 *
 * Phase 6.0A — Transient Event Detection
 */

import type {
  CorrelationInput,
  CorrelationResult,
  CorrelationMatch,
  CorrelationConfidence,
} from "./types.js";
import { getCoincidenceWindows }  from "./windows.js";
import { scorePair }              from "./scorer.js";

// ---------------------------------------------------------------------------
// Confidence mapping
// ---------------------------------------------------------------------------

function scoreToConfidence(
  score: number,
  match: CorrelationMatch | null,
  scoreHigh: number,
  scoreMedium: number,
  scoreLow: number,
): CorrelationConfidence {
  if (!match || !match.temporalMatch) return "NONE";
  if (score >= scoreHigh)   return "HIGH";
  if (score >= scoreMedium) return "MEDIUM";
  if (score >= scoreLow)    return "LOW";
  return "NONE";
}

// ---------------------------------------------------------------------------
// Narrative generators
// ---------------------------------------------------------------------------

function buildAssessment(
  primary: CorrelationInput["primary_event"],
  best: CorrelationMatch | null,
  confidence: CorrelationConfidence,
): string {
  if (confidence === "NONE" || !best) {
    return (
      `No significant multi-messenger counterpart found for ${primary.eventType} event ` +
      `${primary.eventId} within coincidence windows. ` +
      "This may indicate an isolated event or that counterpart emission has not yet been detected."
    );
  }

  const pType = primary.eventType.toUpperCase();
  const cType = best.candidate.eventType.toUpperCase();
  const pairKey = [pType, cType].sort().join("+");

  const narratives: Record<string, string> = {
    "GRB+GW":
      `Temporal and spatial coincidence between ${pType} ${primary.eventId} and ${cType} ` +
      `${best.candidate.eventId} is consistent with a compact binary merger (NS-NS or NS-BH). ` +
      "This is the same physical scenario as the GW170817/GRB 170817A multi-messenger event.",
    "EP+GW":
      `Coincidence between ${pType} ${primary.eventId} and ${cType} ${best.candidate.eventId} ` +
      "may represent an Einstein Probe X-ray counterpart to a gravitational wave merger. " +
      "Off-axis kilonova or cocoon emission could account for the X-ray delay.",
    "GRB+NU":
      `Coincidence between ${pType} and ${cType} ${best.candidate.eventId} suggests a ` +
      "collapsar / long GRB origin with associated neutrino burst emission via internal shock proton acceleration.",
    "EP+GRB":
      `Temporal coincidence between ${pType} ${primary.eventId} and ${cType} ${best.candidate.eventId} ` +
      "is consistent with joint detection of prompt X-ray afterglow and gamma-ray emission from the same relativistic jet.",
    "GW+NU":
      `Coincidence between ${pType} and ${cType} ${best.candidate.eventId} may indicate a ` +
      "core-collapse event with both gravitational wave and neutrino emission, analogous to SN 1987A.",
    "GW+FRB":
      `Tentative coincidence between ${pType} ${primary.eventId} and ${cType} ` +
      `${best.candidate.eventId}. A compact binary merger origin for the FRB is proposed ` +
      "by several theoretical models but remains unconfirmed.",
  };

  return (
    narratives[pairKey] ??
    `${confidence} confidence coincidence between ${pType} ${primary.eventId} and ` +
    `${cType} ${best.candidate.eventId} within temporal and spatial windows ` +
    `(score ${best.score}/100).`
  );
}

function buildRecommendation(
  primary: CorrelationInput["primary_event"],
  best: CorrelationMatch | null,
  confidence: CorrelationConfidence,
): string {
  if (confidence === "NONE" || !best) {
    return "No targeted multi-messenger follow-up warranted by correlation analysis. Standard single-event follow-up applies.";
  }

  const pType = primary.eventType.toUpperCase();
  const cType = best.candidate.eventType.toUpperCase();
  const pairKey = [pType, cType].sort().join("+");

  const recs: Record<string, string> = {
    "GRB+GW":
      "Immediate optical/near-infrared follow-up of the GW sky localisation region. " +
      "Prioritise searching for kilonova emission (r-process nucleosynthesis transient). " +
      "X-ray and radio afterglow monitoring recommended.",
    "EP+GW":
      "Rapid X-ray monitoring of the EP source with follow-up spectroscopy. " +
      "Optical/NIR search for kilonova counterpart in the GW sky region. " +
      "Additional EP pointings to trace X-ray light curve evolution.",
    "GRB+NU":
      "Continued X-ray/optical afterglow monitoring of the GRB. " +
      "Extended neutrino detector window monitoring recommended.",
    "EP+GRB":
      "Monitor the EP X-ray source for afterglow decay. " +
      "Optical spectroscopy to measure redshift and classify transient. " +
      "Radio follow-up for afterglow synchrotron emission.",
    "GW+NU":
      "Optical transient search of GW localisation region. " +
      "Rapid spectroscopic classification of any optical counterpart. " +
      "Additional neutrino detector cross-check recommended.",
    "GW+FRB":
      "Monitor GW sky region at radio frequencies for repeated or delayed FRB emission. " +
      "Optical follow-up of FRB host galaxy candidate.",
  };

  return (
    recs[pairKey] ??
    `Multi-messenger follow-up of the ${pType} localisation region recommended. ` +
    "Coordinate with counterpart instrument teams."
  );
}

function buildReasoning(
  best: CorrelationMatch | null,
  nCandidates: number,
): string {
  if (!best || best.score === 0) {
    return `${nCandidates} candidate event(s) evaluated. No temporal coincidence found within configured windows.`;
  }
  return (
    `Best match: ${best.candidate.eventType} ${best.candidate.eventId} — ` +
    `score ${best.score}/100 (weight=${best.pairingWeight}, ` +
    `tScore=${best.temporalScore.toFixed(3)}, sScore=${best.spatialScore.toFixed(3)}). ` +
    best.reasoning
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the multi-messenger correlation engine.
 *
 * @param input - Primary event + candidate events + optional pre-scores.
 * @returns CorrelationResult matching docs/correlation.txt output schema.
 */
export function correlate(input: CorrelationInput): CorrelationResult {
  const windows = getCoincidenceWindows();

  // ── Score all candidates ──────────────────────────────────────────────────
  const matches: CorrelationMatch[] = input.candidate_events
    .filter((c) => c.eventId !== input.primary_event.eventId) // exclude self
    .map((candidate) => scorePair(input.primary_event, candidate, windows));

  const nCandidates = input.candidate_events.length;

  // Blend in external scores if provided (future AI integration)
  if (input.correlation_scores) {
    for (const match of matches) {
      const externalScore = input.correlation_scores[match.candidate.eventId];
      if (externalScore !== undefined) {
        match.score = Math.min(100, Math.round((match.score + externalScore) / 2));
      }
    }
  }

  // ── Sort by score descending ──────────────────────────────────────────────
  matches.sort((a, b) => b.score - a.score);

  // ── Pick best match (must have temporal coincidence) ─────────────────────
  const bestMatch = matches.find((m) => m.temporalMatch && m.score > 0) ?? null;
  const topScore  = bestMatch?.score ?? 0;

  // ── Confidence ────────────────────────────────────────────────────────────
  const confidence = scoreToConfidence(
    topScore,
    bestMatch,
    windows.scoreHigh,
    windows.scoreMedium,
    windows.scoreLow,
  );

  // ── Narrative ─────────────────────────────────────────────────────────────
  return {
    confidence,
    nCandidates,
    scientific_assessment:   buildAssessment(input.primary_event, bestMatch, confidence),
    followup_recommendation: buildRecommendation(input.primary_event, bestMatch, confidence),
    reasoning:               buildReasoning(bestMatch, nCandidates),
    matches,
    bestMatch,
  };
}
