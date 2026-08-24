import React, { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Database, Info, Loader2, Sparkles } from "lucide-react";

/**
 * Diagnostics panels for the Settings page.
 *
 * These answer operational questions that previously had no answer short of
 * reading server logs or opening psql:
 *
 *   Pipeline    "Why has no GRB appeared today?" — /api/filter-report has
 *               carried received/accepted/rejected counts and per-reason
 *               breakdowns since long before this UI existed.
 *   Extraction  "Why does this circular say AI extraction failed?" — one
 *               timeout and no provider configured look identical on an event
 *               page and call for completely different actions.
 *   Archive     What the archive actually holds, and how much of it carries
 *               human follow-up.
 *
 * Every panel distinguishes "we could not load this" from "the value is zero".
 * A diagnostics screen that renders a confident 0 when its own request failed
 * is worse than one that renders nothing.
 */

// ─── Shared ──────────────────────────────────────────────────────────────────

function useJson<T>(url: string): { data: T | null; failed: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((d: T) => !cancelled && setData(d))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [url]);

  return { data, failed };
}

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-bold text-foreground">{title}</h3>
      {subtitle && <p className="mt-0.5 mb-3 text-xs text-muted-foreground">{subtitle}</p>}
      {children}
    </section>
  );
}

function Stat({
  label,
  value,
  tone = "default",
  hint,
}: {
  label: string;
  value: React.ReactNode;
  tone?: "default" | "good" | "warn" | "bad";
  hint?: string;
}) {
  const cls =
    tone === "good"
      ? "text-emerald-400"
      : tone === "warn"
        ? "text-amber-400"
        : tone === "bad"
          ? "text-red-400"
          : "text-foreground";
  return (
    <div title={hint}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`font-mono text-xl font-bold leading-tight ${cls}`}>{value}</div>
    </div>
  );
}

function LoadFailed({ what }: { what: string }) {
  return (
    <p className="text-xs text-amber-500/90 flex gap-1.5">
      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
      <span>
        {what} could not be loaded. This is a request failure — it is not a statement that the
        values are zero.
      </span>
    </p>
  );
}

function Loading() {
  return <p className="text-xs text-muted-foreground animate-pulse">Loading…</p>;
}

function duration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${(seconds / 60).toFixed(1)}m`;
  if (seconds < 172800) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

// ─── Pipeline health ─────────────────────────────────────────────────────────

interface FilterReport {
  startedAt: string;
  generatedAt: string;
  uptimeSeconds: number;
  totalReceived: number;
  totalAccepted: number;
  totalRejected: number;
  acceptRate: string;
  byTopic: Record<string, { received: number; accepted: number; rejected: number }>;
  rejectedByCategory: Record<string, number>;
  rejectedByReason: { reason: string; count: number }[];
}

export function PipelineTab() {
  const { data, failed } = useJson<FilterReport>("/api/filter-report");

  if (failed) return <LoadFailed what="The pipeline report" />;
  if (!data) return <Loading />;

  const topics = Object.entries(data.byTopic ?? {}).sort((a, b) => b[1].received - a[1].received);
  const categories = Object.entries(data.rejectedByCategory ?? {}).sort((a, b) => b[1] - a[1]);

  return (
    <div className="max-w-4xl space-y-4">
      <h2 className="text-sm font-bold text-foreground">Ingestion pipeline</h2>
      <p className="text-xs text-muted-foreground -mt-3">
        What the scientific quality filter has done since the server started. Counts reset on
        restart — they describe this process, not the archive.
      </p>

      <Panel title="Since startup">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Stat label="Uptime" value={duration(data.uptimeSeconds)} />
          <Stat label="Received" value={data.totalReceived.toLocaleString()} />
          <Stat
            label="Accepted"
            value={data.totalAccepted.toLocaleString()}
            tone={data.totalAccepted > 0 ? "good" : "default"}
          />
          <Stat
            label="Rejected"
            value={data.totalRejected.toLocaleString()}
            tone={data.totalRejected > 0 ? "warn" : "default"}
          />
        </div>

        {data.totalReceived === 0 && (
          <p className="mt-3 pt-3 border-t border-border/50 text-xs text-muted-foreground flex gap-1.5">
            <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>
              No notices have arrived since this server started. That is normal — the consumer
              reads from the live offset, so a quiet broker produces nothing. It does{" "}
              <strong>not</strong> mean ingestion is broken; existing events come from the
              database.
            </span>
          </p>
        )}
      </Panel>

      {topics.length > 0 && (
        <Panel
          title="By topic"
          subtitle="A subscribed topic with zero received is a stream that is quiet, not one that is misconfigured — but a topic missing entirely is neither subscribed nor consumed."
        >
          <div className="space-y-1.5">
            {topics.map(([topic, s]) => (
              <div key={topic} className="flex items-center gap-3 text-xs">
                <span className="font-mono text-[10px] text-muted-foreground flex-1 truncate">
                  {topic}
                </span>
                <span className="font-mono text-foreground w-14 text-right">{s.received}</span>
                <span className="font-mono text-emerald-400 w-14 text-right">{s.accepted}</span>
                <span className="font-mono text-amber-400 w-14 text-right">{s.rejected}</span>
              </div>
            ))}
            <div className="flex items-center gap-3 pt-1.5 border-t border-border/50 text-[9px] uppercase tracking-wider text-muted-foreground">
              <span className="flex-1">topic</span>
              <span className="w-14 text-right">recv</span>
              <span className="w-14 text-right">accept</span>
              <span className="w-14 text-right">reject</span>
            </div>
          </div>
        </Panel>
      )}

      {(categories.length > 0 || data.rejectedByReason?.length > 0) && (
        <Panel
          title="Why alerts were rejected"
          subtitle="A rejection is the filter working, not an error. Retractions, MDC test alerts and sub-threshold triggers are meant to be dropped."
        >
          <div className="flex flex-wrap gap-1.5 mb-3">
            {categories.map(([cat, n]) => (
              <span
                key={cat}
                className="text-[10px] font-mono px-2 py-0.5 rounded border border-border bg-muted/30"
              >
                {cat} {n}
              </span>
            ))}
          </div>
          <ol className="space-y-1">
            {(data.rejectedByReason ?? []).slice(0, 8).map((r, i) => (
              <li key={i} className="flex gap-2 text-[11px]">
                <span className="font-mono text-amber-400 w-8 shrink-0 text-right">{r.count}</span>
                <span className="text-muted-foreground">{r.reason}</span>
              </li>
            ))}
          </ol>
        </Panel>
      )}
    </div>
  );
}

// ─── AI extraction ───────────────────────────────────────────────────────────

interface ExtractionStatus {
  enabled: boolean;
  configured: boolean;
  model: string;
  byStatus: Record<string, number>;
  failuresByKind: { kind: string; count: number }[];
  coverage: { circulars: number; extracted: number };
}

/** Retrying a configuration problem or a schema violation cannot ever succeed. */
const PERMANENT_KINDS = new Set(["configuration", "invalid_response"]);

export function ExtractionTab() {
  const { data, failed } = useJson<ExtractionStatus>("/api/circulars/extraction-status");

  if (failed) return <LoadFailed what="The extraction status" />;
  if (!data) return <Loading />;

  const pct =
    data.coverage.circulars > 0
      ? (data.coverage.extracted / data.coverage.circulars) * 100
      : 0;

  return (
    <div className="max-w-4xl space-y-4">
      <h2 className="text-sm font-bold text-foreground">AI extraction</h2>
      <p className="text-xs text-muted-foreground -mt-3">
        The enrichment layer that reads structured facts out of circular text. It is{" "}
        <strong>not</strong> the scientific record: a circular is stored, associated and fully
        readable whether or not this ever runs.
      </p>

      <Panel title="Provider">
        <div className="flex flex-wrap items-center gap-4">
          <Stat
            label="Worker"
            value={data.enabled ? "Running" : "Disabled"}
            tone={data.enabled ? "good" : "warn"}
            hint="CIRCULAR_AI_EXTRACTION"
          />
          <Stat
            label="Credentials"
            value={data.configured ? "Configured" : "Missing"}
            tone={data.configured ? "good" : "warn"}
          />
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Model</div>
            <div className="font-mono text-sm text-foreground">{data.model}</div>
          </div>
        </div>
        {/* The key itself is never sent to the browser — only whether one exists. */}
        <p className="mt-3 pt-3 border-t border-border/50 text-[10px] text-muted-foreground">
          The API key stays on the server and is never sent to this page. Change the provider with{" "}
          <span className="font-mono">LLM_PROVIDER</span> /{" "}
          <span className="font-mono">LLM_API_KEY</span> in the server environment.
        </p>
      </Panel>

      <Panel title="Queue">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Stat label="Pending" value={data.byStatus.pending ?? 0} />
          <Stat
            label="Processing"
            value={
              <span className="inline-flex items-center gap-1.5">
                {(data.byStatus.processing ?? 0) > 0 && (
                  <Loader2 className="w-4 h-4 animate-spin" />
                )}
                {data.byStatus.processing ?? 0}
              </span>
            }
          />
          <Stat
            label="Completed"
            value={data.byStatus.completed ?? 0}
            tone={(data.byStatus.completed ?? 0) > 0 ? "good" : "default"}
          />
          <Stat
            label="Failed"
            value={data.byStatus.failed ?? 0}
            tone={(data.byStatus.failed ?? 0) > 0 ? "bad" : "default"}
          />
        </div>

        {data.failuresByKind.length > 0 && (
          <div className="mt-3 pt-3 border-t border-border/50">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
              Failures by kind
            </div>
            <ul className="space-y-1">
              {data.failuresByKind.map((f) => (
                <li key={f.kind} className="flex items-center gap-2 text-[11px]">
                  <span className="font-mono text-red-400 w-8 text-right">{f.count}</span>
                  <span className="font-mono text-foreground">{f.kind}</span>
                  <span className="text-muted-foreground">
                    {PERMANENT_KINDS.has(f.kind)
                      ? "— permanent; retrying cannot help, the configuration or the schema is the problem"
                      : "— transient; retried with backoff"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Panel>

      <Panel
        title="Coverage"
        subtitle="Circulars with a completed extraction. A low number is expected: the historical backfill deliberately does not queue tens of thousands of paid model calls."
      >
        <div className="flex items-center gap-4">
          <Stat
            label="Extracted"
            value={`${data.coverage.extracted.toLocaleString()} / ${data.coverage.circulars.toLocaleString()}`}
          />
          <div className="flex-1">
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-violet-500"
                style={{ width: `${Math.max(pct, pct > 0 ? 1 : 0)}%` }}
              />
            </div>
            <div className="mt-1 text-[10px] text-muted-foreground">{pct.toFixed(1)}%</div>
          </div>
        </div>
      </Panel>
    </div>
  );
}

// ─── Archive coverage ────────────────────────────────────────────────────────

interface GroupsResponse {
  totalEvents: number;
  groups: {
    key: string;
    label: string;
    count: number;
    withCirculars: number;
    byType: { eventType: string; count: number }[];
  }[];
  ungrouped: { eventType: string; count: number }[];
}

export function ArchiveTab() {
  const groups = useJson<GroupsResponse>("/api/events/groups");
  const extraction = useJson<ExtractionStatus>("/api/circulars/extraction-status");

  if (groups.failed) return <LoadFailed what="The archive summary" />;
  if (!groups.data) return <Loading />;

  const d = groups.data;
  const totalWithCirculars = d.groups.reduce((a, g) => a + g.withCirculars, 0);

  return (
    <div className="max-w-4xl space-y-4">
      <h2 className="text-sm font-bold text-foreground">Archive</h2>
      <p className="text-xs text-muted-foreground -mt-3">
        What this deployment actually holds. These are archive-wide totals, not a page.
      </p>

      <Panel title="Totals">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <Stat label="Events" value={d.totalEvents.toLocaleString()} />
          <Stat
            label="Events with circulars"
            value={totalWithCirculars.toLocaleString()}
            tone="good"
          />
          <Stat
            label="Circulars stored"
            value={
              extraction.data
                ? extraction.data.coverage.circulars.toLocaleString()
                : extraction.failed
                  ? "unknown"
                  : "…"
            }
          />
        </div>
      </Panel>

      <Panel title="By messenger">
        <div className="space-y-2">
          {d.groups.map((g) => (
            <div key={g.key} className="flex items-center gap-3">
              <span className="text-xs text-foreground w-44 shrink-0 truncate">{g.label}</span>
              <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full bg-primary"
                  style={{
                    width: `${d.totalEvents > 0 ? (g.count / d.totalEvents) * 100 : 0}%`,
                  }}
                />
              </div>
              <span className="font-mono text-xs text-foreground w-12 text-right">{g.count}</span>
              <span
                className="font-mono text-[10px] text-muted-foreground w-24 text-right"
                title="Events in this group carrying at least one GCN Circular"
              >
                {g.withCirculars} w/ circ.
              </span>
            </div>
          ))}
        </div>

        {/* Should never render. If it does, those events are in the database and
            unreachable from the archive UI — say so rather than hide it. */}
        {d.ungrouped.length > 0 && (
          <p className="mt-3 pt-3 border-t border-border/50 text-xs text-amber-500 flex gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>
              {d.ungrouped.reduce((a, u) => a + u.count, 0)} events have an event type in no
              category ({d.ungrouped.map((u) => `${u.eventType}: ${u.count}`).join(", ")}) and
              cannot be browsed.
            </span>
          </p>
        )}
      </Panel>

      <Panel title="Historical backfill">
        <p className="text-xs text-muted-foreground leading-relaxed">
          {extraction.data && extraction.data.coverage.circulars > 1000 ? (
            <>
              <CheckCircle2 className="w-3.5 h-3.5 inline mr-1 -mt-0.5 text-emerald-400" />
              The GCN circular archive has been imported. Re-running the backfill is safe and
              idempotent; it refreshes associations, which is useful after importing more events.
            </>
          ) : (
            <>
              <Database className="w-3.5 h-3.5 inline mr-1 -mt-0.5" />
              Only circulars received live are present. To import the historical archive, run{" "}
              <span className="font-mono text-[10px]">
                tsx src/scripts/backfill_gcn_circulars.ts --resume
              </span>{" "}
              from <span className="font-mono text-[10px]">artifacts/api-server</span>.
            </>
          )}
        </p>
        <p className="mt-2 text-[10px] text-muted-foreground">
          <Sparkles className="w-3 h-3 inline mr-1 -mt-0.5 text-violet-400" />
          Add <span className="font-mono">--extract</span> only deliberately: the full archive is
          tens of thousands of paid model calls.
        </p>
      </Panel>
    </div>
  );
}
