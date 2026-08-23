import { useState, useMemo } from "react";
import { Database, ChevronRight } from "lucide-react";

/**
 * ArchiveCoverage
 * ───────────────
 * How much of the archive is actually measured, as opposed to merely present.
 *
 * The stats strip reports "Total: 304". Read alone that implies 304 usable
 * events, and it does not: 279 of them are GCN circulars whose free text was
 * never parsed, so they carry no position, no SNR, no FAR and no localization.
 * The Phase 3-7 layer records that honestly as UNKNOWN rather than fabricating
 * zeros — but nothing in the interface ever showed the shape of the gap, so a
 * researcher could sort, filter and plan against an archive that is 92% empty
 * without ever being told.
 *
 * This panel is the counterweight to the total. It answers "what do we
 * actually know?" instead of "how many rows are there?".
 *
 * Two rules it follows, both inherited from the layer it reports on:
 *
 *   1. Denominators are scoped to applicability. Fluence is a GRB quantity and
 *      dispersion measure an FRB one; counting them against every event would
 *      manufacture a shortfall that is not real. A field is only ever counted
 *      against the events for which it is meaningful.
 *
 *   2. Absent is not zero, and it is not failure. An unmeasured field is
 *      reported as unmeasured. This panel deliberately does NOT score, grade
 *      or rank the archive — a sparse archive is a fact about the upstream
 *      notices, not a defect to be flagged red.
 */

/** A field is "known" when the pipeline holds a real value for it. */
function known(v: unknown): boolean {
  // latencyUs arrives as a string from REST (bigint) and a number over the
  // WebSocket, so this deliberately tests presence, not type.
  return v !== null && v !== undefined && v !== "";
}

export interface FieldCoverage {
  key: string;
  label: string;
  /** Events for which this quantity is meaningful. */
  applicable: number;
  /** Of those, how many carry a measured value. */
  measured: number;
  /** Present only for type-scoped fields, for the "of N GRB" caption. */
  scope?: string;
}

export interface CoverageSummary {
  total: number;
  /** All four core measurements present. */
  complete: number;
  /** Some but not all. */
  partial: number;
  /** No core measurement at all — present in name only. */
  empty: number;
  fields: FieldCoverage[];
}

/**
 * Pure, so it can be tested against the real archive without a browser.
 *
 * "Core" is the four quantities every messenger reports and every downstream
 * consumer assumes: sky position, its uncertainty, significance, and false
 * alarm rate. Type-specific quantities are reported per field but deliberately
 * excluded from the tiering, so a GRB is never penalised for lacking a DM.
 */
export function computeCoverage(events: readonly any[]): CoverageSummary {
  const list = Array.isArray(events) ? events : [];
  const total = list.length;

  const grbs = list.filter((e) => e?.eventType === "GRB").length;
  const frbs = list.filter((e) => e?.eventType === "FRB").length;

  const count = (pred: (e: any) => boolean, from: readonly any[] = list) =>
    from.reduce((n, e) => (pred(e) ? n + 1 : n), 0);

  const hasPosition = (e: any) => known(e?.ra) && known(e?.dec);

  const fields: FieldCoverage[] = [
    { key: "position", label: "Sky position", applicable: total, measured: count(hasPosition) },
    { key: "errorRadius", label: "Localization", applicable: total, measured: count((e) => known(e?.errorRadius)) },
    { key: "snr", label: "Significance (SNR)", applicable: total, measured: count((e) => known(e?.snr)) },
    { key: "far", label: "False alarm rate", applicable: total, measured: count((e) => known(e?.far)) },
    { key: "latencyUs", label: "Ingestion latency", applicable: total, measured: count((e) => known(e?.latencyUs)) },
    {
      key: "fluence",
      label: "Fluence",
      applicable: grbs,
      measured: count((e) => known(e?.fluence), list.filter((e) => e?.eventType === "GRB")),
      scope: "GRB",
    },
    {
      key: "dm",
      label: "Dispersion measure",
      applicable: frbs,
      measured: count((e) => known(e?.dm), list.filter((e) => e?.eventType === "FRB")),
      scope: "FRB",
    },
  ];

  let complete = 0;
  let partial = 0;
  let empty = 0;
  for (const e of list) {
    const n =
      (hasPosition(e) ? 1 : 0) +
      (known(e?.errorRadius) ? 1 : 0) +
      (known(e?.snr) ? 1 : 0) +
      (known(e?.far) ? 1 : 0);
    if (n === 4) complete++;
    else if (n === 0) empty++;
    else partial++;
  }

  return { total, complete, partial, empty, fields };
}

function pct(n: number, d: number): number {
  return d > 0 ? (n / d) * 100 : 0;
}

/** One field row: a proportional bar plus the raw counts behind it. */
function FieldRow({ f }: { f: FieldCoverage }) {
  const p = pct(f.measured, f.applicable);
  const missing = f.applicable - f.measured;
  return (
    <div className="flex items-center gap-2">
      <span className="w-32 shrink-0 truncate text-muted-foreground" title={f.label}>
        {f.label}
      </span>
      <div
        className="relative h-2 flex-1 min-w-0 overflow-hidden rounded-sm bg-muted"
        role="img"
        aria-label={`${f.label}: ${f.measured} of ${f.applicable} measured`}
      >
        <div className="absolute inset-y-0 left-0 bg-sky-500/80" style={{ width: `${p}%` }} />
      </div>
      <span className="w-24 shrink-0 text-right tabular-nums text-foreground">
        {f.measured}/{f.applicable}
        {f.scope && <span className="ml-1 text-muted-foreground/70">{f.scope}</span>}
      </span>
      <span
        className={`w-12 shrink-0 text-right tabular-nums ${missing > 0 ? "text-amber-500 dark:text-amber-400" : "text-muted-foreground/40"}`}
        title={`${missing} unmeasured`}
      >
        {missing > 0 ? `−${missing}` : "—"}
      </span>
    </div>
  );
}

export function ArchiveCoverage({ events }: { events: readonly any[] }) {
  const [open, setOpen] = useState(false);
  const c = useMemo(() => computeCoverage(events), [events]);

  if (c.total === 0) return null;

  const emptyPct = pct(c.empty, c.total);
  const completePct = pct(c.complete, c.total);
  const partialPct = pct(c.partial, c.total);

  return (
    <div className="shrink-0 border-b border-border bg-[hsl(var(--navbar-bg))] text-[11px] font-mono">
      {/* Always-visible summary — the counterweight to "Total: N" */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex h-7 w-full items-center gap-2 px-3 text-left text-muted-foreground transition-colors hover:bg-accent/40"
      >
        <Database className="h-3 w-3 shrink-0 opacity-70" />
        <span className="shrink-0">Measured coverage:</span>

        {/* Proportional bar: complete / partial / no measurements */}
        <span className="flex h-2 w-28 shrink-0 overflow-hidden rounded-sm bg-muted" aria-hidden="true">
          <span className="bg-emerald-500" style={{ width: `${completePct}%` }} />
          <span className="bg-sky-500/70" style={{ width: `${partialPct}%` }} />
          <span className="bg-amber-500/70" style={{ width: `${emptyPct}%` }} />
        </span>

        <span className="shrink-0 text-emerald-600 dark:text-emerald-400">
          {c.complete} complete
        </span>
        <span className="shrink-0 text-border">·</span>
        <span className="shrink-0 text-sky-600 dark:text-sky-400">{c.partial} partial</span>
        <span className="shrink-0 text-border">·</span>
        <span className="shrink-0 text-amber-600 dark:text-amber-400">
          {c.empty} no measurements ({emptyPct.toFixed(0)}%)
        </span>

        <ChevronRight
          className={`ml-auto h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>

      {open && (
        <div className="space-y-1.5 border-t border-border/60 px-3 py-2.5">
          <div className="flex flex-col gap-1.5">
            {c.fields.map((f) => (
              <FieldRow key={f.key} f={f} />
            ))}
          </div>

          <p className="pt-1.5 text-[10px] leading-relaxed text-muted-foreground/80">
            Counts are of events currently loaded ({c.total}). A field is counted only
            against the events for which it is meaningful — fluence against GRBs, dispersion
            measure against FRBs. &ldquo;Complete&rdquo; means all four core quantities are
            present: position, localization, significance and false alarm rate.
          </p>
          <p className="text-[10px] leading-relaxed text-muted-foreground/70">
            Unmeasured is not zero. GCN circulars are free text and were never parsed for
            structured measurements, so those events carry UNKNOWN rather than a fabricated
            value. This is a property of the upstream notices, not a data fault.
          </p>
        </div>
      )}
    </div>
  );
}
