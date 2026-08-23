/**
 * providers/wechat/formatter.ts
 * -----------------------------
 * Renders a validated Transient Event Detection event as a WeCom markdown message.
 *
 * TWO RULES, BOTH INHERITED FROM THE SCIENCE LAYER
 *
 * 1. This file COMPUTES NOTHING. Every value is read from the validated event
 *    the scientific pipeline produced. A formatter that derived its own
 *    rest-frame quantity or re-scaled a localization would be a second
 *    implementation of the physics, free to drift from the dashboard — which
 *    is exactly how the Phase 2 correlation scorer ended up disagreeing with
 *    itself.
 *
 * 2. A field that is UNKNOWN is OMITTED, never printed as 0, "null",
 *    "undefined" or "N/A". The whole Scientific Intelligence Layer exists so
 *    absence is representable; a notification that prints "SNR: 0" for a
 *    burst with no reported SNR undoes that at the last step, in the one
 *    artefact the researcher actually reads on their phone.
 *
 * WeCom markdown is a restricted subset: headings, **bold**, links,
 * `inline code`, and <font color="..."> for colour. No tables, no images by
 * URL, no nested lists. Anything richer degrades to plain text on mobile.
 */

import type { NotificationPayload } from "../types.js";

// ---------------------------------------------------------------------------
// Safe readers — absent stays absent
// ---------------------------------------------------------------------------

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s && s !== "null" && s !== "undefined" ? s : null;
}

/** A row is emitted only when there is a real value to put in it. */
function row(label: string, value: string | null): string | null {
  return value === null ? null : `**${label}:** ${value}`;
}

const TYPE_LABEL: Record<string, string> = {
  GRB: "Gamma-ray burst",
  GW: "Gravitational wave",
  FRB: "Fast radio burst",
  NU: "Neutrino",
};

/** WeCom renders a small palette; these map to its supported colours. */
const PRIORITY_COLOR: Record<string, string> = {
  CRITICAL: "warning", // red in WeCom's palette
  HIGH: "warning",
  NORMAL: "info",
  LOW: "comment",
};

function fmtExp(n: number, digits = 2): string {
  return n.toExponential(digits);
}

// ---------------------------------------------------------------------------
// Event message
// ---------------------------------------------------------------------------

export function renderWeComMarkdown(
  payload: NotificationPayload,
  opts: { plain?: boolean } = {},
): string {
  const e = payload.event ?? {};
  const lines: string[] = [];

  const eventId = str(e["eventId"]) ?? payload.eventId;
  const type = str(e["eventType"]) ?? "";
  const typeLabel = TYPE_LABEL[type] ?? type;
  const color = PRIORITY_COLOR[payload.priority] ?? "info";

  // ── Header ──
  if (opts.plain) {
    lines.push(`ASTROSENTINEL ALERT — ${payload.priority}`, "", eventId);
  } else {
    lines.push(`## <font color="${color}">ASTROSENTINEL ALERT</font>`);
    lines.push(`### ${eventId}`);
  }
  lines.push("");

  // ── Identity ──
  const ident = [
    row("Type", typeLabel || null),
    row("Observatory", str(e["observatory"])),
    row("Lifecycle", str(e["lifecycle"])?.toUpperCase() ?? null),
    row("Priority", payload.priority),
  ].filter(Boolean) as string[];
  lines.push(...ident);

  // A revision is the single most misread thing in an alert: without saying so,
  // the reader assumes a new burst.
  if (payload.revisionCount > 0) {
    lines.push(row("Revision", `#${payload.revisionCount} — updated notice`)!);
  }
  if (e["isRetraction"] === true) {
    lines.push("", opts.plain
      ? "!! RETRACTED — the source has withdrawn this detection."
      : `> <font color="warning">**RETRACTED** — the source has withdrawn this detection.</font>`);
  }
  lines.push("");

  // ── Detection time ──
  const det = str(e["detectionTime"]);
  if (det) {
    lines.push(row("Detected", `${det.replace("T", " ").replace("Z", "")} UTC`)!);
  }

  // ── Position ──
  const ra = num(e["ra"]);
  const dec = num(e["dec"]);
  if (ra !== null && dec !== null) {
    lines.push(row("Position", `RA ${ra.toFixed(4)}° · Dec ${dec.toFixed(4)}°`)!);
  }

  // errorRadius is arcmin throughout this codebase. Shown in degrees only when
  // large enough that arcmin would be unreadable — the unit is always stated.
  const errArcmin = num(e["errorRadius"]);
  if (errArcmin !== null) {
    const containment = str(e["errorRadiusContainment"]);
    const region = errArcmin >= 60
      ? `${(errArcmin / 60).toFixed(2)}°`
      : `${errArcmin.toFixed(2)}′`;
    // The containment convention is quoted when the source stated it, and its
    // absence is stated too: a 1-sigma and a 90% radius differ by >2x.
    lines.push(row("Localization", containment
      ? `${region} (${containment.replace("_", " ")})`
      : `${region} (containment not stated by source)`)!);
  }
  const area90 = num(e["area90Deg2"]);
  if (area90 !== null) lines.push(row("90% area", `${area90.toFixed(1)} deg²`)!);

  // ── Measurements ──
  const snr = num(e["snr"]);
  if (snr !== null) lines.push(row("SNR", `${snr.toFixed(1)} σ`)!);

  const signalness = num(e["signalness"]);
  if (signalness !== null) {
    // Deliberately labelled distinctly from SNR: it is a probability, not a
    // significance, and the two were conflated in one column before Phase 2.
    lines.push(row("Signalness", `${(signalness * 100).toFixed(0)}% astrophysical`)!);
  }

  const far = num(e["far"]);
  if (far !== null && far > 0) lines.push(row("FAR", `${fmtExp(far)} Hz`)!);

  const t90 = num(e["t90"]);
  if (t90 !== null) lines.push(row("T90", `${t90.toFixed(2)} s`)!);

  const fluence = num(e["fluence"]);
  if (fluence !== null) lines.push(row("Fluence", `${fmtExp(fluence)} erg/cm²`)!);

  const dm = num(e["dm"]);
  if (dm !== null) lines.push(row("DM", `${dm.toFixed(1)} pc/cm³`)!);

  const chirp = num(e["chirpMass"]);
  if (chirp !== null) lines.push(row("Chirp mass", `${chirp.toFixed(2)} M☉`)!);

  const dl = num(e["luminosityDistance"]);
  if (dl !== null) lines.push(row("Distance", `${dl.toFixed(0)} Mpc`)!);

  // ── Scientific status, straight from the pipeline ──
  const validation = e["validation"] as { status?: string } | undefined;
  const qualityScore = num(e["qualityScore"]);
  if (validation?.status || qualityScore !== null) {
    lines.push("");
    const bits: string[] = [];
    if (validation?.status) bits.push(String(validation.status));
    if (qualityScore !== null) bits.push(`quality ${qualityScore}/100`);
    lines.push(row("Data status", bits.join(" · "))!);
  }
  const interest = num(e["interestScore"]);
  const interestBand = (e["derived"] as any)?.researchInterest?.band;
  if (interestBand || interest !== null) {
    lines.push(row("Research interest",
      interestBand ? `${interestBand}${interest !== null ? ` (${interest}/100)` : ""}`
                   : `${interest}/100`)!);
  }

  // ── Link ──
  if (payload.eventUrl) {
    lines.push("");
    lines.push(opts.plain ? payload.eventUrl : `[Open event in Transient Event Detection](${payload.eventUrl})`);
  }

  return lines.filter((l) => l !== null).join("\n");
}

// ---------------------------------------------------------------------------
// Test message
// ---------------------------------------------------------------------------

export function renderWeComTest(): string {
  const now = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
  return [
    `## ASTROSENTINEL TEST ALERT`,
    "",
    "Connection successful.",
    "",
    `**Channel:** WeChat`,
    `**Provider:** WeCom group robot`,
    `**Time:** ${now} UTC`,
    "",
    "Transient Event Detection notification service is configured correctly.",
    "",
    "> This is a test. No astrophysical event is associated with it.",
  ].join("\n");
}
