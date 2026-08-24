import React, { useEffect, useMemo, useState } from "react";
import { Activity, ChevronDown, Database, Radio, Telescope } from "lucide-react";
import { useGetEventStats } from "@workspace/api-client-react";
import { useScienceMode } from "@/lib/ScienceModeContext";
import { FieldRow, computeCoverage, pct } from "@/components/ArchiveCoverage";

/**
 * MissionControlBar — the dashboard header, as one instrument rather than three.
 *
 * WHAT IT REPLACED, AND WHY
 * ─────────────────────────
 * This was three stacked strips totalling 92px:
 *
 *   StatsStrip       "Total: N | Rate: N/hr | GRB: n GW: n FRB: n"
 *   ArchiveCoverage  the measured-vs-present bar
 *   TimelineBar      eight circles joined by a rule
 *
 * Two of the three were misreporting, and the third was nearly information-free:
 *
 *   1. THE TYPE COUNTS WERE HARDCODED to GRB/GW/FRB. `byType` is whatever
 *      event_type values exist in the table — it also carries EP, NU and
 *      OTHER — so events of any other type were simply absent from a row that
 *      sat directly beside "Total". The numbers on one line did not add up to
 *      the number on the same line, with nothing to say why. The distribution
 *      here is built from the response, so a new messenger type appears the
 *      day it first arrives, and an `unlabelled` segment closes any residual
 *      between the sum and the total rather than hiding it.
 *
 *   2. THE TIMELINE THREW ITS DATA AWAY. It counted events per day and then
 *      used the count only as a boolean — one event and fifty events rendered
 *      the identical dot. It also built its day labels in LOCAL time while
 *      keying its counts by the UTC date inside the ISO timestamp, so east of
 *      Greenwich the dot under a label belonged to the previous day. The
 *      sparkline below is proportional and built entirely in UTC, which is the
 *      only time this archive uses anywhere else.
 *
 *   3. Science mode dumped every observatory inline, which is what made the
 *      strip feel crowded. That breakdown, and the coverage detail, now live
 *      in one drawer under the bar — available to everyone, in the way, never.
 *
 * WHAT IT DOES NOT DO
 * ───────────────────
 * It does not grade the archive. A sparse day is a quiet sky, not a fault, and
 * an unmeasured field is a property of the upstream notice — the same rule
 * ArchiveCoverage documents at length, inherited here unchanged.
 */

// ─── Type styling ────────────────────────────────────────────────────────────
//
// Class strings are written out in full rather than composed, because Tailwind
// scans source text and a constructed class name is never emitted.

interface TypeStyle {
  bar: string;
  dot: string;
  text: string;
  label: string;
}

const TYPE_STYLE: Record<string, TypeStyle> = {
  GRB: {
    bar: "bg-orange-600 dark:bg-amber-400",
    dot: "bg-orange-600 dark:bg-amber-400",
    text: "text-orange-800 dark:text-amber-300",
    label: "Gamma-ray bursts",
  },
  EP: {
    bar: "bg-rose-600 dark:bg-rose-400",
    dot: "bg-rose-600 dark:bg-rose-400",
    text: "text-rose-800 dark:text-rose-300",
    label:
      "Einstein Probe X-ray transients. Browsed under Gamma-ray Bursts in the Event Archive, " +
      "because the same mission is labelled GRB when a notice arrives live and EP when it came " +
      "from the circular archive import.",
  },
  GW: {
    bar: "bg-green-700 dark:bg-emerald-400",
    dot: "bg-green-700 dark:bg-emerald-400",
    text: "text-green-800 dark:text-emerald-300",
    label: "Gravitational waves",
  },
  FRB: {
    bar: "bg-amber-600 dark:bg-yellow-300",
    dot: "bg-amber-600 dark:bg-yellow-300",
    text: "text-amber-900 dark:text-yellow-200",
    label: "Fast radio bursts",
  },
  NU: {
    bar: "bg-violet-600 dark:bg-violet-400",
    dot: "bg-violet-600 dark:bg-violet-400",
    text: "text-violet-800 dark:text-violet-300",
    label: "Neutrino candidates",
  },
  OTHER: {
    bar: "bg-sky-600 dark:bg-sky-400",
    dot: "bg-sky-600 dark:bg-sky-400",
    text: "text-sky-800 dark:text-sky-300",
    label:
      "Unclassified transients. The identifier matched no known messenger convention on ingest, " +
      "which is a statement about the identifier and not about the quality of the event.",
  },
};

/** An event_type this interface has not been taught yet still renders. */
const UNKNOWN_STYLE: TypeStyle = {
  bar: "bg-slate-500 dark:bg-slate-400",
  dot: "bg-slate-500 dark:bg-slate-400",
  text: "text-slate-700 dark:text-slate-300",
  label: "An event type this interface has no description for. It is still counted.",
};

/** The residual between the sum of the type counts and the reported total. */
const RESIDUAL_KEY = "unlabelled";
const RESIDUAL_STYLE: TypeStyle = {
  bar: "bg-muted-foreground/40",
  dot: "bg-muted-foreground/40",
  text: "text-muted-foreground",
  label:
    "Counted in the total but carrying no event_type this breakdown received. Shown so the " +
    "segments always sum to the total.",
};

function styleFor(type: string): TypeStyle {
  if (type === RESIDUAL_KEY) return RESIDUAL_STYLE;
  return TYPE_STYLE[type] ?? UNKNOWN_STYLE;
}

// ─── Time ────────────────────────────────────────────────────────────────────

function shortAgo(ms: number): string {
  if (ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ago`;
}

// ─── Layout primitives ───────────────────────────────────────────────────────

function Cell({
  label,
  title,
  className = "",
  children,
}: {
  label: string;
  title?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`flex min-w-0 flex-col justify-center gap-1 px-3.5 ${className}`} title={title}>
      <span className="whitespace-nowrap font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/70">
        {label}
      </span>
      {children}
    </div>
  );
}

function Divider() {
  return <span className="my-2.5 w-px shrink-0 self-stretch bg-border" aria-hidden="true" />;
}

// ─── Type distribution ───────────────────────────────────────────────────────

function TypeMix({
  entries,
  total,
  hot,
  setHot,
}: {
  entries: readonly (readonly [string, number])[];
  total: number;
  hot: string | null;
  setHot: (t: string | null) => void;
}) {
  if (entries.length === 0) {
    return <span className="font-mono text-[11px] text-muted-foreground">no events yet</span>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-3 overflow-hidden">
        {entries.map(([type, count]) => {
          const st = styleFor(type);
          const dim = hot !== null && hot !== type;
          return (
            <button
              key={type}
              type="button"
              onMouseEnter={() => setHot(type)}
              onMouseLeave={() => setHot(null)}
              onFocus={() => setHot(type)}
              onBlur={() => setHot(null)}
              title={`${st.label}\n${count} of ${total} (${pct(count, total).toFixed(1)}%)`}
              className={`flex shrink-0 items-center gap-1.5 font-mono text-[11px] transition-opacity ${
                dim ? "opacity-40" : "opacity-100"
              }`}
            >
              <span className={`h-2 w-2 shrink-0 rounded-[2px] ${st.dot}`} />
              <span className="text-muted-foreground">{type}</span>
              <span className={`font-bold tabular-nums ${st.text}`}>
                {hot === type ? `${pct(count, total).toFixed(0)}%` : count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Proportional, and complete by construction: the segments ARE the
          entries, and the entries are made to sum to the total. */}
      <div
        className="flex h-1.5 w-full min-w-[180px] overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={entries.map(([t, n]) => `${t}: ${n}`).join(", ")}
      >
        {entries.map(([type, count]) => {
          const st = styleFor(type);
          const dim = hot !== null && hot !== type;
          return (
            <span
              key={type}
              className={`h-full transition-opacity ${st.bar} ${dim ? "opacity-25" : "opacity-100"}`}
              style={{ width: `${pct(count, total)}%` }}
            />
          );
        })}
      </div>
    </div>
  );
}

// ─── Activity sparkline ──────────────────────────────────────────────────────

const SPARK_DAYS = 30;
const SPARK_HEIGHT_PX = 26;

interface Day {
  key: string;
  count: number;
  isToday: boolean;
}

function buildDays(events: readonly any[]): Day[] {
  const counts = new Map<string, number>();
  for (const e of events) {
    const t = e?.detectionTime;
    // The ISO string already carries the UTC calendar date in its first ten
    // characters. Parsing it into a Date would reintroduce the local-time
    // shift this function exists to avoid.
    if (typeof t === "string" && t.length >= 10) {
      const k = t.slice(0, 10);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }

  const now = new Date();
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days: Day[] = [];
  for (let i = SPARK_DAYS - 1; i >= 0; i--) {
    const key = new Date(todayMs - i * 86_400_000).toISOString().slice(0, 10);
    days.push({ key, count: counts.get(key) ?? 0, isToday: i === 0 });
  }
  return days;
}

/**
 * Bars are flex-sized rather than fixed-width so the chart fills whatever the
 * header has left over. A wide window gets a wide chart instead of a fixed
 * stub beside dead space.
 */
function Sparkline({ days }: { days: readonly Day[] }) {
  const peak = Math.max(1, ...days.map((d) => d.count));
  return (
    <div className="flex w-full items-end gap-[3px]" style={{ height: SPARK_HEIGHT_PX }}>
      {days.map((d) => {
        const h = d.count === 0 ? 2 : Math.max(3, Math.round((d.count / peak) * SPARK_HEIGHT_PX));
        const tone = d.isToday
          ? "bg-primary"
          : d.count === 0
            ? "bg-border"
            : "bg-primary/45 hover:bg-primary/80";
        return (
          <span
            key={d.key}
            title={`${d.key} UTC — ${d.count} event${d.count === 1 ? "" : "s"}${d.isToday ? " (today)" : ""}`}
            className={`min-w-[3px] flex-1 rounded-[1px] transition-all ${tone}`}
            style={{ height: h }}
          />
        );
      })}
    </div>
  );
}

// ─── The bar ─────────────────────────────────────────────────────────────────

export function MissionControlBar({
  events,
  isConnected,
}: {
  events: readonly any[];
  isConnected: boolean;
}) {
  const { data: stats } = useGetEventStats({
    query: { refetchInterval: 10000, queryKey: ["event-stats"] },
  });
  const { scienceMode } = useScienceMode();
  const [open, setOpen] = useState(false);
  const [hot, setHot] = useState<string | null>(null);

  // Re-renders the "last detection" counter. It refetches nothing.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const s = stats as any;
  const total: number = Number(s?.totalEvents ?? s?.total ?? 0);
  const ingestedLastHour: number = Number(s?.recentRate ?? 0);
  const byType: Record<string, number> = s?.byType ?? {};
  const byObservatory: { observatory: string; count: number }[] = s?.byObservatory ?? [];
  const latest = s?.latestEvent ?? null;

  /**
   * Every type present, largest first, plus the residual if the counts do not
   * reach the total. Nothing is dropped for not being one of three.
   */
  const byTypeKey = JSON.stringify(byType);
  const entries = useMemo<[string, number][]>(() => {
    const list = Object.entries(byType)
      .map(([t, n]) => [t, Number(n)] as [string, number])
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1]);
    const accounted = list.reduce((n, [, c]) => n + c, 0);
    if (total > accounted) list.push([RESIDUAL_KEY, total - accounted]);
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byTypeKey, total]);

  const barTotal = entries.reduce((n, [, c]) => n + c, 0);
  const days = useMemo(() => buildDays(events), [events]);
  const windowCount = days.reduce((n, d) => n + d.count, 0);
  const coverage = useMemo(() => computeCoverage(events), [events]);
  const observatoryPeak = Math.max(1, ...byObservatory.map((o) => o.count));

  const latestMs = latest?.detectionTime
    ? Date.now() - new Date(latest.detectionTime).getTime()
    : null;

  // Hold the height rather than collapsing the layout under it while the first
  // request is in flight.
  if (!stats) {
    return <div className="h-14 shrink-0 border-b border-border bg-[hsl(var(--navbar-bg))]" />;
  }

  return (
    <header className="relative shrink-0 border-b border-border bg-[hsl(var(--navbar-bg))]">
      <div className="flex h-14 items-stretch overflow-x-auto scrollbar-thin">
        {/* ── Feed state and total ───────────────────────────────────────── */}
        <Cell
          label={isConnected ? "Live feed" : "Feed offline"}
          title={
            isConnected
              ? "Connected to the GCN WebSocket bridge."
              : "Not connected. The archive below is still accurate, but new notices are not arriving."
          }
          className="shrink-0"
        >
          <div className="flex items-baseline gap-2">
            <span className="relative flex h-2 w-2 shrink-0 self-center">
              {isConnected && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-70" />
              )}
              <span
                className={`relative inline-flex h-2 w-2 rounded-full ${
                  isConnected ? "bg-emerald-500" : "bg-amber-500"
                }`}
              />
            </span>
            <span className="font-mono text-lg font-bold leading-none tabular-nums text-foreground">
              {total.toLocaleString()}
            </span>
            <span className="text-[10px] text-muted-foreground">events</span>
          </div>
        </Cell>

        <Divider />

        {/* ── Ingest rate ─────────────────────────────────────────────────── */}
        <Cell
          label="Ingested · 1 h"
          title="Rows written to the archive in the last hour, counted by ingest time. This is pipeline throughput, not a rate of detection on the sky."
          className="shrink-0"
        >
          <div className="flex items-baseline gap-1.5">
            <span
              className={`font-mono text-lg font-bold leading-none tabular-nums ${
                ingestedLastHour > 0 ? "text-primary" : "text-muted-foreground"
              }`}
            >
              {ingestedLastHour}
            </span>
            <span className="text-[10px] text-muted-foreground">/hr</span>
          </div>
        </Cell>

        <Divider />

        {/* ── Last detection ──────────────────────────────────────────────── */}
        <Cell
          label="Last detection"
          title={latest?.detectionTime ? `${latest.detectionTime} UTC` : undefined}
          className="hidden shrink-0 xl:flex"
        >
          {latest && latestMs !== null ? (
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-[13px] font-bold leading-none text-foreground">
                {shortAgo(latestMs)}
              </span>
              <span className="max-w-[150px] truncate font-mono text-[10px] text-muted-foreground">
                {latest.eventId}
              </span>
            </div>
          ) : (
            <span className="font-mono text-[11px] text-muted-foreground">—</span>
          )}
        </Cell>

        <Divider />

        {/* ── Composition ─────────────────────────────────────────────────── */}
        {/* Sized to its contents, not to the slack in the row: a distribution
            bar stretched across half the header reads as a progress bar. */}
        <Cell label="Composition" className="max-w-[560px] shrink-0">
          <TypeMix entries={entries} total={barTotal} hot={hot} setHot={setHot} />
        </Cell>

        <Divider />

        {/* ── Activity ────────────────────────────────────────────────────── */}
        <Cell
          label={`Activity · ${SPARK_DAYS} d`}
          title={`Events by UTC day over the last ${SPARK_DAYS} days, among the ${events.length} loaded on this page.`}
          className="hidden w-[250px] shrink-0 lg:flex"
        >
          <div className="flex items-end gap-2">
            <Sparkline days={days} />
            <span className="mb-px shrink-0 font-mono text-[10px] leading-none text-muted-foreground">
              {windowCount}
            </span>
          </div>
        </Cell>

        <Divider />

        {/* ── Coverage ────────────────────────────────────────────────────── */}
        <Cell
          label="Measured"
          title="How much of the loaded archive carries real measurements, rather than merely existing as a row."
          className="ml-auto hidden shrink-0 md:flex"
        >
          <div className="flex items-center gap-2">
            <span className="flex h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-muted">
              <span
                className="bg-emerald-500"
                style={{ width: `${pct(coverage.complete, coverage.total)}%` }}
              />
              <span
                className="bg-sky-500/70"
                style={{ width: `${pct(coverage.partial, coverage.total)}%` }}
              />
              <span
                className="bg-amber-500/70"
                style={{ width: `${pct(coverage.empty, coverage.total)}%` }}
              />
            </span>
            <span className="font-mono text-[11px] leading-none tabular-nums">
              <span className="font-bold text-emerald-600 dark:text-emerald-400">
                {coverage.complete}
              </span>
              <span className="text-muted-foreground">/{coverage.total}</span>
            </span>
          </div>
        </Cell>

        {/* ── Researcher badge and drawer toggle ──────────────────────────── */}
        {/* Sticky so the toggle stays reachable when the row scrolls: on a
            narrow window it was the first thing clipped off the right edge. */}
        <div className="sticky right-0 z-10 ml-auto flex shrink-0 items-center gap-2 border-l border-border bg-[hsl(var(--navbar-bg))] pl-3 pr-2">
          {scienceMode && (
            <span
              className="hidden rounded border border-violet-500/40 bg-violet-500/10 px-2 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-violet-700 dark:text-violet-300 sm:inline"
              title="Science mode is on: derived quantities are shown with their methods and assumptions."
            >
              Researcher
            </span>
          )}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="flex items-center gap-1.5 rounded border border-transparent px-2 py-1 font-mono text-[10px] text-muted-foreground transition-colors hover:border-border hover:bg-accent/40 hover:text-foreground"
          >
            Breakdown
            <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
        </div>
      </div>

      {/* A still line means the feed is down. See the note in index.css. */}
      {isConnected && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px overflow-hidden">
          <div className="mc-scan h-px w-1/4 bg-gradient-to-r from-transparent via-primary to-transparent" />
        </div>
      )}

      {open && (
        <div className="grid gap-5 border-t border-border/60 px-4 py-3 font-mono text-[11px] lg:grid-cols-2">
          {/* ── Coverage detail ──────────────────────────────────────────── */}
          <section>
            <h2 className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              <Database className="h-3 w-3" /> Measured coverage
            </h2>
            <div className="flex flex-col gap-1.5">
              {coverage.fields.map((f) => (
                <FieldRow key={f.key} f={f} />
              ))}
            </div>
            <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground/80">
              Counts are of the {coverage.total} events loaded on this page, not of the whole
              archive. A field is counted only against the events for which it is meaningful:
              fluence against GRBs, dispersion measure against FRBs. &ldquo;Complete&rdquo; means
              all four core quantities are present, being position, localization, significance and
              false alarm rate.
            </p>
            <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground/70">
              Unmeasured is not zero. GCN circulars are free text and were never parsed for
              structured measurements, so those events carry UNKNOWN rather than a fabricated
              value. This is a property of the upstream notices, not a data fault.
            </p>
          </section>

          {/* ── Observatories and activity ───────────────────────────────── */}
          <section>
            <h2 className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              <Telescope className="h-3 w-3" /> Detections by observatory
            </h2>
            {byObservatory.length === 0 ? (
              <p className="text-[10px] text-muted-foreground">No observatories reported yet.</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {byObservatory.map((o) => (
                  <div key={o.observatory} className="flex items-center gap-2">
                    <span
                      className="w-40 shrink-0 truncate text-muted-foreground"
                      title={o.observatory}
                    >
                      {o.observatory}
                    </span>
                    <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-sm bg-muted">
                      <div
                        className="h-full bg-primary/70"
                        style={{ width: `${pct(o.count, observatoryPeak)}%` }}
                      />
                    </div>
                    <span className="w-10 shrink-0 text-right tabular-nums text-foreground">
                      {o.count}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <h2 className="mb-2 mt-4 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              <Activity className="h-3 w-3" /> Activity, {SPARK_DAYS} days
            </h2>
            <div className="flex items-end gap-3">
              <div className="w-64 shrink-0">
                <Sparkline days={days} />
              </div>
              <span className="text-[10px] text-muted-foreground">
                {windowCount} of the {events.length} loaded events fall in this window.
              </span>
            </div>
            <p className="mt-2 flex items-start gap-1.5 text-[10px] leading-relaxed text-muted-foreground/70">
              <Radio className="mt-px h-3 w-3 shrink-0" />
              Days are UTC, matching the timestamps everywhere else in this interface. A bar height
              is its event count against the tallest day in the window, and an empty day is drawn
              as a baseline tick rather than omitted.
            </p>
          </section>
        </div>
      )}
    </header>
  );
}
