/**
 * components.ts — Email Template System (Phase 5.3)
 * ---------------------------------------------------
 * Reusable HTML component functions.
 *
 * Every visual element of the email is a named pure function.
 * No component duplicates HTML from another component.
 *
 * Compatibility guarantees
 * ───────────────────────
 *   • All layout uses tables — Outlook safe.
 *   • Inline styles on every element — Outlook safe.
 *   • class= attributes for dark mode / responsive overrides from styles.ts.
 *   • MSO conditional comments where required for VML backgrounds.
 *   • No CSS gradients, no border-radius on table cells (Outlook ignores).
 *
 * Phase 5.3 — Transient Event Detection
 */

import type { PriorityColors, EventTypeMeta } from "./styles.js";
import { FONT_STACK, MONO_STACK } from "./styles.js";
import type { ScientificSummary } from "../../science/summaryEngine/index.js";

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Escape HTML entities in user-controlled strings */
function esc(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Render a value only when it is not null/undefined/empty */
function whenDefined(value: string | number | null | undefined, render: (v: string) => string): string {
  if (value === null || value === undefined || value === "") return "";
  return render(String(value));
}

// ---------------------------------------------------------------------------
// Component: Priority badge (inline span)
// ---------------------------------------------------------------------------

/**
 * Inline priority badge rendered inside the header.
 * Uses table cell (not border-radius) for Outlook compatibility.
 */
export function priorityBadge(colors: PriorityColors): string {
  return `<table cellpadding="0" cellspacing="0" border="0" style="display:inline-table;">
  <tr>
    <td style="background-color:rgba(255,255,255,0.2);padding:3px 10px;font-family:${FONT_STACK};font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:${colors.fg};">
      ${esc(colors.label)}
    </td>
  </tr>
</table>`;
}

// ---------------------------------------------------------------------------
// Component: Email header
// ---------------------------------------------------------------------------

export interface HeaderOptions {
  colors:      PriorityColors;
  meta:        EventTypeMeta;
  eventId:     string;
  revisionCount: number;
}

export function headerBlock(opts: HeaderOptions): string {
  const { colors, meta, eventId, revisionCount } = opts;
  const isRevision = revisionCount > 0;
  const revLabel   = isRevision ? ` — Revision ${revisionCount}` : "";

  return `<tr>
  <td class="header-pad" style="background-color:${colors.bg};padding:28px 32px 24px;font-family:${FONT_STACK};">
    <!--[if mso]><table cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td><![endif]-->
    <p style="margin:0 0 8px 0;color:${colors.fg};font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;line-height:1;">
      ASTROSENTINEL AUTOMATED ALERT &nbsp;·&nbsp; ${esc(colors.label)} PRIORITY
    </p>
    <h1 class="alert-title" style="margin:0 0 6px 0;color:${colors.fg};font-size:22px;font-weight:700;line-height:1.2;font-family:${FONT_STACK};">
      ${esc(meta.emoji)} ${esc(meta.label)} Alert${esc(revLabel)}
    </h1>
    <p style="margin:0 0 12px 0;color:${colors.fg};font-size:13px;opacity:0.85;font-family:${MONO_STACK};">
      ${esc(eventId)}
    </p>
    <p style="margin:0;color:${colors.fg};font-size:12px;opacity:0.7;font-style:italic;">
      ${esc(meta.subtitle)}
    </p>
    <!--[if mso]></td></tr></table><![endif]-->
  </td>
</tr>`;
}

// ---------------------------------------------------------------------------
// Component: Revision warning banner
// ---------------------------------------------------------------------------

export function revisionBanner(revisionCount: number): string {
  if (revisionCount <= 0) return "";
  return `<tr>
  <td class="email-inner" style="padding:16px 32px 0;font-family:${FONT_STACK};">
    <table cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td class="revision-banner" style="background-color:#fffbeb;border:1px solid #f59e0b;padding:10px 14px;">
          <p class="revision-text" style="margin:0;font-size:13px;color:#92400e;line-height:1.4;">
            <strong>⚠ Revision ${revisionCount}</strong> &mdash; This is an updated notice for a previously reported event. Parameters may have changed.
          </p>
        </td>
      </tr>
    </table>
  </td>
</tr>`;
}

// ---------------------------------------------------------------------------
// Component: Section heading
// ---------------------------------------------------------------------------

export function sectionHeading(title: string, icon: string = ""): string {
  return `<tr>
  <td style="padding:20px 32px 6px;font-family:${FONT_STACK};">
    <p style="margin:0;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#64748b;">
      ${icon ? esc(icon) + "&nbsp; " : ""}${esc(title)}
    </p>
    <table cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr><td class="divider" style="border-top:1px solid #e2e8f0;padding-top:8px;font-size:0;">&nbsp;</td></tr>
    </table>
  </td>
</tr>`;
}

// ---------------------------------------------------------------------------
// Component: Data row (label / value pair)
// ---------------------------------------------------------------------------

export interface DataRowOptions {
  label:   string;
  value:   string;
  /** Render value in monospace font (coordinates, IDs) */
  mono?:   boolean;
  /** Omit if value is empty/null */
  omitIfEmpty?: boolean;
}

export function dataRow(opts: DataRowOptions): string {
  if (opts.omitIfEmpty && (!opts.value || opts.value === "N/A")) return "";

  const valueStyle = opts.mono
    ? `font-family:${MONO_STACK};font-size:12px;color:#0f172a;font-weight:400;`
    : `font-family:${FONT_STACK};font-size:13px;color:#0f172a;font-weight:500;`;

  return `<tr>
    <td class="label-cell" style="padding:7px 12px 7px 0;font-family:${FONT_STACK};font-size:12px;color:#64748b;white-space:nowrap;vertical-align:top;width:38%;border-bottom:1px solid #f1f5f9;">
      ${esc(opts.label)}
    </td>
    <td class="value-cell divider" style="${valueStyle}padding:7px 0;vertical-align:top;border-bottom:1px solid #f1f5f9;">
      ${esc(opts.value)}
    </td>
  </tr>`;
}

// ---------------------------------------------------------------------------
// Component: Data table wrapper
// ---------------------------------------------------------------------------

export function dataTable(rows: string): string {
  if (!rows.trim()) return "";
  return `<tr>
  <td class="email-inner" style="padding:0 32px;font-family:${FONT_STACK};">
    <table cellpadding="0" cellspacing="0" border="0" width="100%" class="data-table">
      ${rows}
    </table>
  </td>
</tr>`;
}

// ---------------------------------------------------------------------------
// Component: Placeholder section
// ---------------------------------------------------------------------------

export interface PlaceholderOptions {
  icon:    string;
  title:   string;
  message: string;
}

export function placeholderSection(opts: PlaceholderOptions): string {
  return `<tr>
  <td class="email-inner" style="padding:0 32px;font-family:${FONT_STACK};">
    <table cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td class="placeholder-box" style="background-color:#f8fafc;border:1px dashed #cbd5e1;padding:14px 16px;">
          <p class="placeholder-title" style="margin:0 0 4px 0;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#94a3b8;">
            ${esc(opts.icon)} ${esc(opts.title)}
          </p>
          <p class="placeholder-body" style="margin:0;font-size:13px;color:#94a3b8;font-style:italic;line-height:1.5;">
            ${esc(opts.message)}
          </p>
        </td>
      </tr>
    </table>
  </td>
</tr>`;
}

// ---------------------------------------------------------------------------
// Component: AI Scientific Summary
// ---------------------------------------------------------------------------

export function aiSummarySection(summary: ScientificSummary): string {
  // Use dataRow to format the sections neatly, but since values can be long, 
  // maybe just block paragraphs is better.
  return `<tr>
  <td style="padding:0 32px;font-family:${FONT_STACK};">
    <table cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td style="background-color:#f8fafc;border-left:4px solid #6366f1;padding:14px 16px;">
          <p style="margin:0 0 6px 0;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#4f46e5;">🔬 AI Scientific Summary</p>
          <p style="margin:0 0 8px 0;font-size:13px;color:#1e293b;line-height:1.5;"><strong>Significance:</strong> ${esc(summary.significance)}</p>
          <p style="margin:0 0 8px 0;font-size:13px;color:#1e293b;line-height:1.5;"><strong>Origin:</strong> ${esc(summary.origin)}</p>
          <p style="margin:0 0 8px 0;font-size:13px;color:#1e293b;line-height:1.5;"><strong>Characteristics:</strong> ${esc(summary.characteristics)}</p>
          <p style="margin:0 0 8px 0;font-size:13px;color:#1e293b;line-height:1.5;"><strong>Confidence:</strong> ${esc(summary.confidence)}</p>
          <p style="margin:0;font-size:13px;color:#1e293b;line-height:1.5;"><strong>Follow-up:</strong> ${esc(summary.followUp)}</p>
        </td>
      </tr>
    </table>
  </td>
</tr>`;
}

// ---------------------------------------------------------------------------
// Component: Spacer row
// ---------------------------------------------------------------------------

export function spacer(px: number = 16): string {
  return `<tr><td style="padding:0;font-size:${px}px;line-height:${px}px;">&nbsp;</td></tr>`;
}

// ---------------------------------------------------------------------------
// Component: Horizontal rule
// ---------------------------------------------------------------------------

export function hrule(): string {
  return `<tr>
  <td style="padding:0 32px;">
    <table cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr><td class="divider" style="border-top:1px solid #e2e8f0;font-size:0;line-height:0;">&nbsp;</td></tr>
    </table>
  </td>
</tr>`;
}

// ---------------------------------------------------------------------------
// Component: Footer
// ---------------------------------------------------------------------------

export interface FooterOptions {
  generatedAt: string;   // ISO-8601
  version:     string;   // e.g. "1.0.0"
}

export function footerBlock(opts: FooterOptions): string {
  const genTime = (() => {
    try { return new Date(opts.generatedAt).toUTCString(); }
    catch { return opts.generatedAt; }
  })();

  return `<tr>
  <td class="email-inner no-print" style="padding:20px 32px 28px;font-family:${FONT_STACK};">
    <table cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td>
          <p class="footer-text" style="margin:0 0 4px 0;font-size:12px;color:#94a3b8;line-height:1.5;">
            This alert was generated automatically by <strong style="color:#64748b;">Transient Event Detection</strong>
            after passing scientific quality filters and priority classification.
          </p>
          <p class="footer-text" style="margin:0 0 4px 0;font-size:11px;color:#94a3b8;">
            Generated: ${esc(genTime)} &nbsp;·&nbsp; Version: ${esc(opts.version)}
          </p>
          <p class="footer-text" style="margin:0;font-size:11px;color:#94a3b8;">
            To adjust alert thresholds, update <span style="font-family:${MONO_STACK};font-size:10px;color:#94a3b8;">NOTIFY_MIN_PRIORITY</span>
            or <span style="font-family:${MONO_STACK};font-size:10px;color:#94a3b8;">PRIORITY_SCORE_P0</span> in your environment configuration.
          </p>
        </td>
      </tr>
    </table>
  </td>
</tr>`;
}
