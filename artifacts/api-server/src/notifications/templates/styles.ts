/**
 * styles.ts — Email Template System (Phase 5.3)
 * -----------------------------------------------
 * Centralised style definitions for the Transient Event Detection scientific email template.
 *
 * Approach
 * ────────
 *   Email CSS is fundamentally split across two contexts:
 *
 *   1. Inline styles  — applied directly on every element. Required for Outlook
 *      (which uses Microsoft Word's rendering engine and ignores <head> CSS).
 *      All base layout, typography, and colour values live here.
 *
 *   2. <style> block in <head> — processed by Gmail, Apple Mail, Thunderbird,
 *      modern web clients. Used for:
 *        • @media (prefers-color-scheme: dark)  — dark mode overrides
 *        • @media (max-width: 620px)            — mobile layout
 *        • @media print                         — print optimisation
 *      These rules use !important to beat Outlook's inline styles when the
 *      client does support media queries.
 *
 * Compatibility
 * ─────────────
 *   ✓ Gmail (web + Android + iOS)     — media queries supported since 2019
 *   ✓ Outlook 2016/2019/365           — inline styles only, MSO conditionals
 *   ✓ Apple Mail                      — full support
 *   ✓ Thunderbird                     — full support
 *   ✓ iOS Mail                        — full support incl. dark mode
 *   ✓ Samsung Internet                — inline + limited media query
 *
 * Phase 5.3 — Transient Event Detection
 */

import type { NotificationPriority } from "../priorityEngine.js";

// ---------------------------------------------------------------------------
// Priority colour tokens
// ---------------------------------------------------------------------------

export interface PriorityColors {
  /** Header/badge background */
  bg: string;
  /** Header/badge foreground (text) */
  fg: string;
  /** Lighter tint for borders and accent lines */
  accent: string;
  /** Very light tint for banner background in dark mode */
  darkBg: string;
  /** Human-readable label */
  label: string;
}

export const PRIORITY_COLORS: Record<NotificationPriority, PriorityColors> = {
  CRITICAL: {
    bg:     "#b91c1c",
    fg:     "#ffffff",
    accent: "#fca5a5",
    darkBg: "#450a0a",
    label:  "CRITICAL",
  },
  HIGH: {
    bg:     "#c2410c",
    fg:     "#ffffff",
    accent: "#fdba74",
    darkBg: "#431407",
    label:  "HIGH",
  },
  MEDIUM: {
    bg:     "#b45309",
    fg:     "#ffffff",
    accent: "#fcd34d",
    darkBg: "#451a03",
    label:  "MEDIUM",
  },
  LOW: {
    bg:     "#374151",
    fg:     "#ffffff",
    accent: "#9ca3af",
    darkBg: "#111827",
    label:  "LOW",
  },
};

// ---------------------------------------------------------------------------
// Event type metadata
// ---------------------------------------------------------------------------

export interface EventTypeMeta {
  emoji:    string;
  label:    string;
  subtitle: string;
}

export const EVENT_TYPE_META: Record<string, EventTypeMeta> = {
  GW: {
    emoji:    "🌊",
    label:    "Gravitational Wave",
    subtitle: "LIGO / Virgo / KAGRA Network",
  },
  GRB: {
    emoji:    "💥",
    label:    "Gamma-Ray Burst",
    subtitle: "High-Energy Transient",
  },
  FRB: {
    emoji:    "📡",
    label:    "Fast Radio Burst",
    subtitle: "Radio Transient",
  },
  NU: {
    emoji:    "⚛️",
    label:    "High-Energy Neutrino",
    subtitle: "IceCube Neutrino Observatory",
  },
};

// ---------------------------------------------------------------------------
// Common inline style strings (shared across components)
// ---------------------------------------------------------------------------

/** Base font stack — email-safe, no web fonts required */
export const FONT_STACK =
  "Arial, 'Helvetica Neue', Helvetica, sans-serif";

/** Monospace for IDs, coordinates */
export const MONO_STACK =
  "'Courier New', Courier, monospace";

// ---------------------------------------------------------------------------
// <head> <style> block
// ---------------------------------------------------------------------------

/**
 * Returns the complete <style> block string to embed in <head>.
 * Contains dark mode overrides, responsive breakpoints, and print rules.
 * These are ignored by Outlook but respected by all other major clients.
 */
export function buildStyleBlock(): string {
  return `<style type="text/css">
  /* ── Reset ─────────────────────────────────────────────── */
  body, table, td, a { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
  table, td { mso-table-lspace:0pt; mso-table-rspace:0pt; }
  img { -ms-interpolation-mode:bicubic; border:0; }

  /* ── Base ───────────────────────────────────────────────── */
  .email-wrapper   { background-color:#f1f5f9 !important; }
  .email-card      { background-color:#ffffff !important; }
  .label-cell      { color:#64748b !important; }
  .value-cell      { color:#0f172a !important; }
  .divider         { border-color:#e2e8f0 !important; }
  .footer-text     { color:#94a3b8 !important; }
  .placeholder-box { background-color:#f8fafc !important; border-color:#e2e8f0 !important; }

  /* ── Dark mode ──────────────────────────────────────────── */
  @media (prefers-color-scheme: dark) {
    .email-wrapper   { background-color:#0f172a !important; }
    .email-card      { background-color:#1e293b !important; }
    .label-cell      { color:#94a3b8 !important; }
    .value-cell      { color:#f1f5f9 !important; }
    .divider         { border-color:#334155 !important; }
    .footer-text     { color:#64748b !important; }
    .placeholder-box { background-color:#1e293b !important; border-color:#334155 !important; }
    .placeholder-title { color:#94a3b8 !important; }
    .placeholder-body  { color:#64748b !important; }
    .revision-banner   { background-color:#422006 !important; border-color:#92400e !important; }
    .revision-text     { color:#fcd34d !important; }
    .mono-text         { color:#7dd3fc !important; }
  }

  /* ── Mobile (≤ 620px) ───────────────────────────────────── */
  @media screen and (max-width: 620px) {
    .email-card  { width:100% !important; border-radius:0 !important; }
    .email-inner { padding:20px 16px !important; }
    .header-pad  { padding:20px 16px !important; }
    .data-table  { font-size:12px !important; }
    h1.alert-title { font-size:18px !important; }
  }

  /* ── Print ──────────────────────────────────────────────── */
  @media print {
    body, .email-wrapper { background:#ffffff !important; }
    .email-card { box-shadow:none !important; border:1px solid #e2e8f0 !important; }
    .no-print   { display:none !important; }
    a           { color:#0f172a !important; text-decoration:none !important; }
  }
</style>`;
}
