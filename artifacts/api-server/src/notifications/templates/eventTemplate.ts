/**
 * eventTemplate.ts — Email Template System (Phase 5.3)
 * ------------------------------------------------------
 * Main template assembler. Composes reusable components from components.ts
 * into a complete, professional scientific alert email.
 *
 * Structure
 * ─────────
 *   <!DOCTYPE html>
 *   <html>
 *     <head>  ← meta tags, style block (dark mode / responsive / print)
 *     <body>
 *       [wrapper table]
 *         [card table]
 *           HEADER        ← priority colour band, event type, event ID
 *           REVISION      ← warning banner (only if revisionCount > 0)
 *           ─────────────────────────────────────────────────
 *           DETECTION     ← core parameters section
 *             · Event ID
 *             · Event Type
 *             · Observatory
 *             · Detection Time
 *             · Lifecycle / Alert Type
 *             · Priority / Score
 *           ─────────────────────────────────────────────────
 *           ASTROMETRY    ← position section
 *             · RA (HMS + decimal)
 *             · Dec (DMS + decimal)
 *             · Error Radius
 *           ─────────────────────────────────────────────────
 *           SIGNAL        ← quality metrics
 *             · SNR
 *             · FAR
 *             · Confidence / Classification Tier
 *           ─────────────────────────────────────────────────
 *           PHYSICS       ← type-specific parameters
 *             GW:  Chirp Mass, Distance
 *             GRB: T90, Fluence
 *             FRB: Dispersion Measure
 *             NU:  IceCube Tier
 *           ─────────────────────────────────────────────────
 *           SCIENTIFIC SUMMARY   ← placeholder
 *           CORRELATION          ← placeholder
 *           RECOMMENDED FOLLOW-UP ← placeholder
 *           ─────────────────────────────────────────────────
 *           FOOTER        ← timestamp, version, config hint
 *
 * Phase 5.3 — Transient Event Detection
 */

import type { NotificationPriority } from "../priorityEngine.js";
import type { CorrelationResult }     from "../../science/correlationEngine/index.js";
import type { ScientificSummary }     from "../../science/summaryEngine/index.js";
import {
  PRIORITY_COLORS,
  EVENT_TYPE_META,
  FONT_STACK,
  buildStyleBlock,
} from "./styles.js";
import {
  headerBlock,
  revisionBanner,
  sectionHeading,
  dataRow,
  dataTable,
  placeholderSection,
  aiSummarySection,
  spacer,
  hrule,
  footerBlock,
} from "./components.js";
import {
  formatDetectionTime,
  formatPosition,
  formatPositionDeg,
  formatErrorRadius,
  formatFAR,
  formatSNR,
  formatChirpMass,
  formatDistance,
  formatDM,
  formatFluence,
  formatT90,
  formatLatency,
  formatLifecycle,
} from "./formatters.js";

// ---------------------------------------------------------------------------
// Template input type
// ---------------------------------------------------------------------------

export interface EventTemplateInput {
  // Core identification
  eventId:            string;
  triggerId?:         string | null;
  eventType:          string;
  observatory:        string;
  detectionTime:      string;   // ISO-8601

  // Lifecycle
  lifecycle:          string;
  alertType:          string | null;
  classificationTier: string | null;
  revisionCount:      number;

  // Priority classification (from Phase 5.2 engine)
  priorityLevel:      string;   // "P0" | "P1" | "P2" | "P3"
  priorityScore:      number;
  priorityReasons:    string[];
  recommendation:     string;

  // Astrometry
  ra:                 number;
  dec:                number;
  errorRadius:        number;

  // Signal quality
  snr:                number;
  far:                number;

  // GW parameters
  chirpMass?:         number | null;
  luminosityDistance?: number | null;

  // GRB parameters
  fluence?:           number | null;
  t90?:               number | null;

  // FRB parameters
  dm?:                number | null;

  // Metadata
  /** null = never received live (archive import); rendered as "N/A". */
  latencyUs:          number | null;

  // Phase 5.4 correlation result
  correlationResult:  CorrelationResult;

  // Phase 5.6 AI scientific summary
  aiSummary:          ScientificSummary | null;

  // Template metadata
  generatedAt:        string;   // ISO-8601 (when email was built)
  appVersion:         string;
}

export interface EmailContent {
  subject: string;
  html:    string;
  text:    string;
}

// ---------------------------------------------------------------------------
// Subject line
// ---------------------------------------------------------------------------

function buildSubject(
  input: EventTemplateInput,
  notifPriority: NotificationPriority,
): string {
  const type = input.eventType?.toUpperCase();
  const meta = EVENT_TYPE_META[type] ?? { emoji: "🔭", label: type, subtitle: "" };
  const tier = input.classificationTier ? ` [${input.classificationTier}]` : "";
  const rev  = input.revisionCount > 0 ? ` (Rev.${input.revisionCount})` : "";
  return `${meta.emoji} [${notifPriority}]${tier} ${meta.label} Alert — ${input.eventId}${rev}`;
}

// ---------------------------------------------------------------------------
// Type-specific physics rows
// ---------------------------------------------------------------------------

function physicsSection(input: EventTemplateInput): string {
  const type = input.eventType?.toUpperCase();
  const rows: string[] = [];

  if (type === "GW") {
    if (input.chirpMass != null)
      rows.push(dataRow({ label: "Chirp Mass",   value: formatChirpMass(input.chirpMass) }));
    if (input.luminosityDistance != null)
      rows.push(dataRow({ label: "Distance",     value: formatDistance(input.luminosityDistance) }));
  }

  if (type === "GRB") {
    if (input.t90 != null)
      rows.push(dataRow({ label: "Duration (T90)", value: formatT90(input.t90) }));
    if (input.fluence != null)
      rows.push(dataRow({ label: "Fluence",      value: formatFluence(input.fluence) }));
  }

  if (type === "FRB") {
    if (input.dm != null)
      rows.push(dataRow({ label: "Dispersion Measure", value: formatDM(input.dm) }));
  }

  if (rows.length === 0) return "";

  return [
    hrule(),
    sectionHeading("Physics Parameters", "⚗️"),
    dataTable(rows.join("")),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Correlation section (Phase 5.4)
// ---------------------------------------------------------------------------

const CONFIDENCE_COLORS: Record<string, string> = {
  HIGH:   "#065f46",
  MEDIUM: "#92400e",
  LOW:    "#1e3a5f",
  NONE:   "#374151",
};

const CONFIDENCE_BG: Record<string, string> = {
  HIGH:   "#d1fae5",
  MEDIUM: "#fef3c7",
  LOW:    "#dbeafe",
  NONE:   "#f3f4f6",
};

function correlationSection(result: CorrelationResult): string {
  if (result.confidence === "NONE") return "";

  const color  = CONFIDENCE_COLORS[result.confidence] ?? "#374151";
  const bg     = CONFIDENCE_BG[result.confidence]     ?? "#f3f4f6";
  const hasBestMatch = result.bestMatch !== null;

  const candidateList = result.matches.length > 0
    ? result.matches.map(m => `${m.candidate.eventType} ${m.candidate.eventId}`).join(", ")
    : "None";

  const matchRow = hasBestMatch && result.bestMatch
    ? dataRow({ label: "Best Match",  value: `${result.bestMatch.candidate.eventType} ${result.bestMatch.candidate.eventId} (${result.bestMatch.candidate.observatory})` })
    + dataRow({ label: "Score",       value: `${result.bestMatch.score}/100` })
    + dataRow({ label: "\u0394T",      value: `${result.bestMatch.deltaTimeSec >= 0 ? "+" : ""}${result.bestMatch.deltaTimeSec.toFixed(1)} s` })
    + dataRow({ label: "Separation",  value: `${result.bestMatch.angularSeparationDeg.toFixed(2)}\u00b0` })
    + dataRow({ label: "Candidates",  value: candidateList })
    : "";

  return `<tr>
  <td style="padding:0 32px;font-family:Arial,'Helvetica Neue',Helvetica,sans-serif;">
    <table cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td style="background-color:${bg};border:1px solid ${color};padding:14px 16px;">
          <p style="margin:0 0 6px 0;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:${color};">🔗 Multi-Messenger Correlation — ${result.confidence}</p>
          <p style="margin:0 0 8px 0;font-size:13px;color:#111827;line-height:1.5;">${result.scientific_assessment}</p>
          ${hasBestMatch ? `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:8px;">${matchRow}</table>` : ""}
          <p style="margin:${hasBestMatch ? "8px" : "0"} 0 0;font-size:11px;color:#6b7280;font-style:italic;line-height:1.4;">${result.reasoning}</p>
        </td>
      </tr>
    </table>
  </td>
</tr>`;
}

// ---------------------------------------------------------------------------
// Reasons list (from Phase 5.2 classifier)
// ---------------------------------------------------------------------------

function reasonsList(reasons: string[]): string {
  if (!reasons || reasons.length === 0) return "";
  const items = reasons
    .map((r) => `<li style="margin:0 0 3px 0;font-size:12px;color:#475569;line-height:1.4;">${r}</li>`)
    .join("\n");
  return `<tr>
  <td style="padding:0 32px 0;font-family:${FONT_STACK};">
    <ul style="margin:8px 0 0 0;padding:0 0 0 18px;">
      ${items}
    </ul>
  </td>
</tr>`;
}

// ---------------------------------------------------------------------------
// HTML assembler
// ---------------------------------------------------------------------------

function buildHtml(
  input: EventTemplateInput,
  notifPriority: NotificationPriority,
): string {
  const type   = input.eventType?.toUpperCase();
  const colors = PRIORITY_COLORS[notifPriority];
  const meta   = EVENT_TYPE_META[type] ?? { emoji: "🔭", label: type, subtitle: "Astrophysical Transient" };

  // ── Sections ─────────────────────────────────────────────────────────────

  const detectionRows = [
    dataRow({ label: "Event ID",        value: input.eventId,        mono: true }),
    input.triggerId ? dataRow({ label: "Trigger ID",      value: input.triggerId,      mono: true }) : "",
    dataRow({ label: "Event Type",      value: `${meta.emoji}  ${meta.label}` }),
    dataRow({ label: "Observatory",     value: input.observatory }),
    dataRow({ label: "Detection Time",  value: formatDetectionTime(input.detectionTime) }),
    dataRow({ label: "Lifecycle",       value: formatLifecycle(input.lifecycle) }),
    input.alertType
      ? dataRow({ label: "Alert Type",  value: input.alertType })
      : "",
    dataRow({ label: "Latency",         value: formatLatency(input.latencyUs) }),
  ].join("");

  const astrometryRows = [
    dataRow({ label: "Right Ascension", value: formatPosition(input.ra, input.dec).split(" / ")[0], mono: true }),
    dataRow({ label: "Declination",     value: formatPosition(input.ra, input.dec).split(" / ")[1], mono: true }),
    dataRow({ label: "Decimal Coords",  value: formatPositionDeg(input.ra, input.dec), mono: true }),
    dataRow({ label: "Error Radius",    value: formatErrorRadius(input.errorRadius) }),
  ].join("");

  const signalRows = [
    dataRow({ label: "SNR",             value: formatSNR(input.snr) }),
    dataRow({ label: "False Alarm Rate",value: formatFAR(input.far) }),
    input.classificationTier
      ? dataRow({ label: "Classification", value: input.classificationTier })
      : "",
  ].join("");

  const priorityRows = [
    dataRow({ label: "Priority Level",  value: `${notifPriority} (${input.priorityLevel}) — Score ${input.priorityScore}/100` }),
  ].join("");

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>Transient Event Detection Alert — ${input.eventId}</title>
  <!--[if mso]>
  <noscript>
    <xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml>
  </noscript>
  <![endif]-->
  ${buildStyleBlock()}
</head>
<body style="margin:0;padding:0;background-color:#f1f5f9;font-family:${FONT_STACK};" class="email-wrapper">

  <!-- Outer wrapper -->
  <table cellpadding="0" cellspacing="0" border="0" width="100%" class="email-wrapper" style="background-color:#f1f5f9;padding:24px 8px;">
    <tr><td align="center">

      <!-- Card -->
      <!--[if mso]><table cellpadding="0" cellspacing="0" border="0" width="600"><tr><td><![endif]-->
      <table cellpadding="0" cellspacing="0" border="0" width="600" class="email-card"
             style="background-color:#ffffff;max-width:600px;width:100%;">

        ${headerBlock({ colors, meta, eventId: input.eventId, revisionCount: input.revisionCount })}
        ${revisionBanner(input.revisionCount)}
        ${spacer(20)}

        <!-- DETECTION PARAMETERS -->
        ${sectionHeading("Detection Parameters", "📡")}
        ${dataTable(detectionRows)}
        ${spacer(4)}

        <!-- ASTROMETRY -->
        ${hrule()}
        ${sectionHeading("Astrometry", "🌐")}
        ${dataTable(astrometryRows)}
        ${spacer(4)}

        <!-- SIGNAL QUALITY -->
        ${hrule()}
        ${sectionHeading("Signal Quality", "📊")}
        ${dataTable(signalRows)}
        ${spacer(4)}

        <!-- PRIORITY CLASSIFICATION -->
        ${hrule()}
        ${sectionHeading("Scientific Priority", "⚡")}
        ${dataTable(priorityRows)}
        ${reasonsList(input.priorityReasons)}
        ${spacer(4)}

        <!-- TYPE-SPECIFIC PHYSICS -->
        ${physicsSection(input)}
        ${spacer(4)}

        <!-- AI SCIENTIFIC SUMMARY (Phase 5.6) -->
        ${hrule()}
        ${spacer(4)}
        ${input.aiSummary ? aiSummarySection(input.aiSummary) : placeholderSection({
          icon:    "🔬",
          title:   "Scientific Summary",
          message: "AI summary generation timed out or failed. The raw event data continues below.",
        })}
        ${spacer(8)}

        <!-- MULTI-MESSENGER CORRELATION (Phase 5.4 — live data) -->
        ${correlationSection(input.correlationResult)}
        ${input.correlationResult.confidence !== "NONE" ? spacer(8) : ""}

        ${placeholderSection({
          icon:    "🔭",
          title:   "Recommended Follow-up",
          message: input.correlationResult.confidence !== "NONE"
            ? input.correlationResult.followup_recommendation
            : `${input.recommendation} Suggested facilities, filter bands, and exposure times based on event type and localization will appear here.`,
        })}
        ${spacer(20)}

        <!-- FOOTER -->
        ${hrule()}
        ${footerBlock({ generatedAt: input.generatedAt, version: input.appVersion })}

      </table>
      <!--[if mso]></td></tr></table><![endif]-->

    </td></tr>
  </table>

</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Plain-text builder
// ---------------------------------------------------------------------------

function buildText(
  input: EventTemplateInput,
  notifPriority: NotificationPriority,
): string {
  const type = input.eventType?.toUpperCase();
  const hr   = "─".repeat(60);
  const rev  = input.revisionCount > 0
    ? `\n⚠  REVISION ${input.revisionCount} — Updated notice for existing event.\n`
    : "";

  const lines: string[] = [
    "═".repeat(60),
    `ASTROSENTINEL AUTOMATED ALERT  ·  ${notifPriority} PRIORITY`,
    "═".repeat(60),
    rev,
    `Event ID     : ${input.eventId}`,
    input.triggerId ? `Trigger ID   : ${input.triggerId}` : null,
    `Event Type   : ${input.eventType?.toUpperCase()}`,
    `Observatory  : ${input.observatory}`,
    `Detected     : ${formatDetectionTime(input.detectionTime)}`,
    `Lifecycle    : ${formatLifecycle(input.lifecycle)}`,
    input.alertType ? `Alert Type   : ${input.alertType}` : "",
    "",
    hr,
    "ASTROMETRY",
    hr,
    `RA           : ${formatPosition(input.ra, input.dec).split(" / ")[0]}`,
    `Dec          : ${formatPosition(input.ra, input.dec).split(" / ")[1]}`,
    `Coordinates  : ${formatPositionDeg(input.ra, input.dec)}`,
    `Error Radius : ${formatErrorRadius(input.errorRadius)}`,
    "",
    hr,
    "SIGNAL QUALITY",
    hr,
    `SNR          : ${formatSNR(input.snr)}`,
    `FAR          : ${formatFAR(input.far)}`,
    input.classificationTier ? `Classification: ${input.classificationTier}` : "",
    "",
    hr,
    "SCIENTIFIC PRIORITY",
    hr,
    `Level        : ${notifPriority} (${input.priorityLevel}) — Score ${input.priorityScore}/100`,
    "Reasons:",
    ...input.priorityReasons.map((r) => `  • ${r}`),
    "",
    `Recommendation: ${input.recommendation}`,
  ];

  // Type-specific physics
  const physics: string[] = [];
  if (type === "GW") {
    if (input.chirpMass != null)      physics.push(`Chirp Mass   : ${formatChirpMass(input.chirpMass)}`);
    if (input.luminosityDistance != null) physics.push(`Distance     : ${formatDistance(input.luminosityDistance)}`);
  }
  if (type === "GRB") {
    if (input.t90 != null)            physics.push(`Duration T90 : ${formatT90(input.t90)}`);
    if (input.fluence != null)        physics.push(`Fluence      : ${formatFluence(input.fluence)}`);
  }
  if (type === "FRB" && input.dm != null) physics.push(`DM           : ${formatDM(input.dm)}`);

  if (physics.length > 0) {
    lines.push("", hr, "PHYSICS PARAMETERS", hr, ...physics);
  }

  lines.push(
    "",
    hr,
    "SCIENTIFIC SUMMARY",
    hr,
    ...(input.aiSummary ? [
      `Significance : ${input.aiSummary.significance}`,
      `Origin       : ${input.aiSummary.origin}`,
      `Highlights   : ${input.aiSummary.characteristics}`,
      `Confidence   : ${input.aiSummary.confidence}`,
      `Follow-up    : ${input.aiSummary.followUp}`
    ] : [
      "AI summary generation timed out or failed."
    ]),
    ...(input.correlationResult.confidence !== "NONE" ? [
      "",
      hr,
      `MULTI-MESSENGER CORRELATION — ${input.correlationResult.confidence}`,
      hr,
      input.correlationResult.scientific_assessment,
      ...(input.correlationResult.bestMatch ? [
        "",
        `Best Match   : ${input.correlationResult.bestMatch.candidate.eventType} ${input.correlationResult.bestMatch.candidate.eventId}`,
        `Observatory  : ${input.correlationResult.bestMatch.candidate.observatory}`,
        `Score        : ${input.correlationResult.bestMatch.score}/100`,
        `ΔT           : ${input.correlationResult.bestMatch.deltaTimeSec >= 0 ? "+" : ""}${input.correlationResult.bestMatch.deltaTimeSec.toFixed(1)} s`,
        `Separation   : ${input.correlationResult.bestMatch.angularSeparationDeg.toFixed(2)}°`,
        `Candidates   : ${input.correlationResult.matches.length > 0 ? input.correlationResult.matches.map(m => m.candidate.eventType + ' ' + m.candidate.eventId).join(", ") : "None"}`,
        "",
        `Technical    : ${input.correlationResult.reasoning}`,
      ] : [])
    ] : []),
    "",
    hr,
    "RECOMMENDED FOLLOW-UP",
    hr,
    input.correlationResult.confidence !== "NONE"
      ? input.correlationResult.followup_recommendation
      : input.recommendation,
    "",
    hr,
    `Generated : ${formatDetectionTime(input.generatedAt)}`,
    `Version   : ${input.appVersion}`,
    "Transient Event Detection Automated Alert System",
    hr,
  );

  return lines.filter((l) => l !== undefined).join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the complete scientific email (subject, HTML, plain-text).
 *
 * @param input          - All event data and priority classification result.
 * @param notifPriority  - Notification-layer priority label (CRITICAL / HIGH).
 */
export function buildEventEmail(
  input: EventTemplateInput,
  notifPriority: NotificationPriority,
): EmailContent {
  return {
    subject: buildSubject(input, notifPriority),
    html:    buildHtml(input, notifPriority),
    text:    buildText(input, notifPriority),
  };
}
