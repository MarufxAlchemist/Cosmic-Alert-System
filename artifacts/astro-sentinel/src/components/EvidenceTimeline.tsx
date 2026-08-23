import { useEffect, useState } from "react";
import { Clock, FileText, Radio, Sparkles } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * EvidenceTimeline
 * ────────────────
 * The evolving scientific history of one event on a single axis: every machine
 * Notice received for it, and every human-authored Circular attached to it.
 *
 * NOTHING HERE IS SYNTHESISED. Every row corresponds to a database row that
 * exists. An event with no revision history and no circulars shows an empty
 * timeline and says why — it does not get a fabricated "detected" marker to
 * make the component look populated.
 *
 * THE TIMESTAMP TRAP
 * ──────────────────
 * The two kinds of entry are stamped with different things and the component
 * says so on every row:
 *
 *   Notice    when Transient Event Detection RECEIVED it
 *   Circular  when its authors PUBLISHED it
 *
 * Neither is the event's trigger time, which is shown separately in the header.
 * Reading a circular's publication time as a trigger time is the easiest way to
 * misread this page — a follow-up circular can be published days after the
 * burst — so the meaning travels with the number instead of being implied by
 * the column it sits in.
 *
 * Notices and Circulars are also visually distinct (cyan vs violet, Radio vs
 * FileText) because a machine alert and a human report are different kinds of
 * evidence and should never be skim-read as one stream.
 */

interface TimelineEntry {
  kind: "notice" | "circular";
  timestamp: string;
  timestampMeaning: string;
  title: string;
  detail: string | null;
  provenance: Record<string, unknown>;
}

interface TimelineResponse {
  eventPk: string;
  eventId: string;
  detectionTime: string;
  noticeCount: number;
  circularCount: number;
  entries: TimelineEntry[];
}

function utc(iso: string): string {
  return `${new Date(iso).toISOString().replace("T", " ").slice(0, 19)}Z`;
}

/**
 * Offset from the event's trigger time, in units a reader can hold in mind.
 *
 * Returned as null when the trigger time is unusable, rather than printing a
 * misleading "+0s".
 */
function offsetFrom(detectionTime: string, timestamp: string): string | null {
  const t0 = new Date(detectionTime).getTime();
  const t = new Date(timestamp).getTime();
  if (!Number.isFinite(t0) || !Number.isFinite(t)) return null;

  const seconds = (t - t0) / 1000;
  const sign = seconds < 0 ? "−" : "+";
  const abs = Math.abs(seconds);

  if (abs < 90) return `T${sign}${abs.toFixed(0)}s`;
  if (abs < 5400) return `T${sign}${(abs / 60).toFixed(1)}m`;
  if (abs < 172800) return `T${sign}${(abs / 3600).toFixed(1)}h`;
  return `T${sign}${(abs / 86400).toFixed(1)}d`;
}

const SIGNIFICANCE_CLS: Record<string, string> = {
  CRITICAL: "text-red-400",
  NOTABLE: "text-amber-400",
  ROUTINE: "text-muted-foreground",
  NONE: "text-muted-foreground",
};

function NoticeRow({ entry }: { entry: TimelineEntry }) {
  const p = entry.provenance;
  const significance = p["significance"] as string | null;
  const isRetraction = p["isRetraction"] === true;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Radio className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
        <span className="text-sm font-medium text-foreground">{entry.title}</span>
        {isRetraction && (
          <span className="text-[10px] font-semibold uppercase text-red-400">Retracted</span>
        )}
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-cyan-500/30 bg-cyan-500/10 text-cyan-400 uppercase tracking-wide">
          machine notice
        </span>
      </div>
      {entry.detail && (
        <div className="mt-0.5 text-xs font-mono text-muted-foreground">{entry.detail}</div>
      )}
      {/* null significance means the delta could NOT be computed. It is never
          collapsed into "no changes" — a comparison that failed to run must not
          read as an uneventful revision. */}
      {(p["revisionIndex"] as number) > 0 && (
        <div className={`mt-0.5 text-[10px] ${SIGNIFICANCE_CLS[significance ?? ""] ?? "text-amber-500/80"}`}>
          {significance === null
            ? "Scientific changes carried by this notice are UNKNOWN — the comparison could not be computed."
            : `Change significance: ${significance}`}
        </div>
      )}
    </>
  );
}

function CircularRow({ entry }: { entry: TimelineEntry }) {
  const p = entry.provenance;
  const extractionStatus = p["extractionStatus"] as string;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <FileText className="w-3.5 h-3.5 text-violet-400 shrink-0" />
        <span className="text-sm font-medium text-foreground">{entry.title}</span>
        {p["revisionStatus"] === "revised" && (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-400 uppercase tracking-wide">
            revised · v{String(p["version"])}
          </span>
        )}
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-violet-500/30 bg-violet-500/10 text-violet-400 uppercase tracking-wide">
          human report
        </span>
      </div>
      {entry.detail && (
        <div className="mt-0.5 text-xs text-foreground/80 break-words">{entry.detail}</div>
      )}
      <div className="mt-0.5 flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground">
        <span>{String(p["submitter"] ?? "")}</span>
        {extractionStatus === "completed" && (
          <span className="inline-flex items-center gap-1 text-violet-400">
            <Sparkles className="w-3 h-3" /> AI extraction available
          </span>
        )}
        {extractionStatus === "failed" && (
          <span className="text-amber-500">AI extraction failed — the circular itself is complete</span>
        )}
        {p["gcnUrl"] ? (
          <a
            href={String(p["gcnUrl"])}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            Open source
          </a>
        ) : null}
      </div>
    </>
  );
}

export function EvidenceTimeline({ eventId }: { eventId: string }) {
  const [data, setData] = useState<TimelineResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setFailed(false);
    fetch(`/api/events/${eventId}/timeline`)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((d: TimelineResponse) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  if (failed) {
    return (
      <Card className="bg-card border-border/50 shadow-none">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Clock className="w-5 h-5 text-primary" />
            Evidence Timeline
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-amber-500/80">
            The timeline could not be loaded, so the reporting history for this
            event is unknown here.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!data) return null;

  return (
    <Card className="bg-card border-border/50 shadow-none">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Clock className="w-5 h-5 text-primary" />
          Evidence Timeline
          <span className="text-xs font-normal text-muted-foreground ml-1">
            {data.noticeCount} notice{data.noticeCount === 1 ? "" : "s"} ·{" "}
            {data.circularCount} circular{data.circularCount === 1 ? "" : "s"}
          </span>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Trigger time <span className="font-mono">{utc(data.detectionTime)}</span>. Offsets below
          are measured from it. Notice times are when Transient Event Detection received them;
          circular times are when their authors published them.
        </p>
      </CardHeader>

      <CardContent>
        {data.entries.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No notices or circulars are recorded for this event. Events ingested
            before revision and circular tracking existed have none — this is not
            a statement that nothing was ever reported about it.
          </p>
        ) : (
          <ol className="relative space-y-4 pl-5">
            {/* The spine. Purely decorative; every marker below is a real row. */}
            <div className="absolute left-[5px] top-1.5 bottom-1.5 w-px bg-border" aria-hidden />
            {data.entries.map((entry, i) => {
              const offset = offsetFrom(data.detectionTime, entry.timestamp);
              return (
                <li key={`${entry.kind}-${i}`} className="relative">
                  <span
                    className={`absolute -left-5 top-1.5 w-2.5 h-2.5 rounded-full border-2 border-background ${
                      entry.kind === "notice" ? "bg-cyan-500" : "bg-violet-500"
                    }`}
                    aria-hidden
                  />
                  <div className="flex flex-wrap items-baseline gap-2 mb-0.5">
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {utc(entry.timestamp)}
                    </span>
                    {offset && (
                      <span className="font-mono text-[10px] text-muted-foreground/70">
                        {offset}
                      </span>
                    )}
                    {/* The meaning of the timestamp travels with it. */}
                    <span className="text-[9px] text-muted-foreground/60 italic">
                      {entry.timestampMeaning}
                    </span>
                  </div>
                  {entry.kind === "notice" ? (
                    <NoticeRow entry={entry} />
                  ) : (
                    <CircularRow entry={entry} />
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
