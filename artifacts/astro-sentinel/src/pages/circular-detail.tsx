import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "wouter";
import { AlertTriangle, ArrowLeft, ExternalLink, FileText, History, User } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ASSOCIATION_NOTE,
  ExtractionStatusLine,
  ExtractionView,
  utc,
  type Extraction,
} from "@/components/CircularsPanel";

/**
 * CircularDetailPage — one GCN Circular, on its own page.
 *
 * WHY THIS EXISTS
 * ───────────────
 * A circular is normally read on its event's page, in the context of the whole
 * history. But a circular does not always HAVE an event: 43,166 of the 44,766
 * in this archive are UNMATCHED, because the burst they describe was never
 * ingested here. Search returns them, and the palette had nowhere to send
 * them — it linked to /circulars/:id, which existed as an API route and not as
 * a page, so every unattached result landed on 404.
 *
 * The extraction rendering is imported from CircularsPanel rather than copied.
 * Those panels carry the source-vs-AI-extracted-vs-AI-inferred distinction,
 * and a second implementation would drift from it.
 */

interface CircularDetail {
  id: string;
  circularId: number;
  version: number;
  isLatest: boolean;
  revisionStatus: "original" | "revised";
  gcnEventId: string | null;
  normalizedEventId: string | null;
  subject: string;
  submitter: string;
  submittedHow: string | null;
  bibcode: string | null;
  createdOn: string;
  editedOn: string | null;
  editedBy: string | null;
  gcnUrl: string | null;
  bodyFormat: string | null;
  body: string;
  source: string;
  ingestedAt: string;
  versionCount: number;
  association: { method: string; rationale: string | null; candidateEventPk: string | null };
  event: { id: string; eventId: string; eventType: string } | null;
  extraction: Extraction;
}

export default function CircularDetailPage() {
  const { circularId } = useParams<{ circularId: string }>();
  const [searchParams] = useSearchParams();
  const version = searchParams.get("version");

  const [data, setData] = useState<CircularDetail | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "notfound" | "failed">("loading");

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    const url = `/api/circulars/${encodeURIComponent(circularId)}${version ? `?version=${encodeURIComponent(version)}` : ""}`;
    fetch(url)
      .then(async (r) => {
        if (r.status === 404) {
          if (!cancelled) setStatus("notfound");
          return null;
        }
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((d: CircularDetail | null) => {
        if (cancelled || !d) return;
        setData(d);
        setStatus("ok");
      })
      .catch(() => {
        if (!cancelled) setStatus("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [circularId, version]);

  if (status === "loading") {
    return (
      <div className="h-full overflow-y-auto">
        <div className="container max-w-4xl mx-auto p-4 space-y-4">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (status === "notfound") {
    return (
      <div className="container max-w-2xl mx-auto p-8 text-center">
        <h1 className="text-xl font-bold mb-2">Circular not found</h1>
        <p className="text-sm text-muted-foreground mb-4">
          No GCN Circular <span className="font-mono">#{circularId}</span> is stored in this
          archive. It may not have been ingested — that is not a statement that GCN never
          published it.
        </p>
        <a
          href={`https://gcn.nasa.gov/circulars/${encodeURIComponent(circularId)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-primary hover:underline inline-flex items-center gap-1"
        >
          <ExternalLink className="w-3.5 h-3.5" /> Look it up at gcn.nasa.gov
        </a>
      </div>
    );
  }

  if (status === "failed" || !data) {
    return (
      <div className="container max-w-2xl mx-auto p-8 text-center">
        <p className="text-sm text-amber-500/90">
          This circular could not be loaded. That is a request failure — the circular itself is
          unaffected.
        </p>
      </div>
    );
  }

  const assoc = ASSOCIATION_NOTE[data.association.method] ?? ASSOCIATION_NOTE.UNMATCHED;

  return (
    <div className="h-full overflow-y-auto">
      <div className="container max-w-4xl mx-auto p-4 space-y-4">
        {/* Back to the event when there is one; otherwise to the archive, since
            an unattached circular has no event page to return to. */}
        {data.event ? (
          <Link
            href={`/events/${data.event.id}`}
            className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to {data.event.eventId}
          </Link>
        ) : (
          <Link
            href="/events"
            className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Event Archive
          </Link>
        )}

        {/* Header */}
        <div className="bg-card border border-border/50 p-5 rounded-xl">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <FileText className="w-4 h-4 text-violet-400" />
            <h1 className="text-xl font-bold font-mono">GCN Circular #{data.circularId}</h1>
            {data.revisionStatus === "revised" && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-400 uppercase tracking-wide">
                revised · v{data.version}
              </span>
            )}
            {!data.isLatest && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-border text-muted-foreground uppercase tracking-wide">
                superseded
              </span>
            )}
          </div>

          <p className="text-base text-foreground/90 mb-3">{data.subject}</p>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <User className="w-3 h-3" /> {data.submitter}
            </span>
            <span title="When the authors published it — NOT the event's trigger time">
              Published {utc(data.createdOn)}
            </span>
            {data.editedOn && (
              <span>
                Revised {utc(data.editedOn)}
                {data.editedBy ? ` by ${data.editedBy}` : ""}
              </span>
            )}
            {data.bibcode && <span className="font-mono">{data.bibcode}</span>}
            <ExtractionStatusLine extraction={data.extraction} />
          </div>

          <div className="mt-3 pt-3 border-t border-border/50 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
            {data.event ? (
              <span className="text-muted-foreground">
                Event:{" "}
                <Link
                  href={`/events/${data.event.id}`}
                  className="font-mono text-primary hover:underline"
                >
                  {data.event.eventId}
                </Link>{" "}
                <span className="text-[10px]">({assoc.label.toLowerCase()})</span>
              </span>
            ) : (
              <span className={`inline-flex items-start gap-1.5 text-[11px] ${assoc.cls}`}>
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>
                  <strong>Not attached to any event.</strong>{" "}
                  {data.association.rationale ?? assoc.note ?? ""}
                </span>
              </span>
            )}

            {data.versionCount > 1 && (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <History className="w-3 h-3" />
                {data.versionCount} versions stored
              </span>
            )}

            {data.gcnUrl && (
              <a
                href={data.gcnUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                <ExternalLink className="w-3 h-3" /> Open at gcn.nasa.gov
              </a>
            )}
          </div>
        </div>

        {/* ── SOURCE ─────────────────────────────────────────────────────── */}
        <Card className="bg-card border-border/50 shadow-none">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <FileText className="w-4 h-4 text-muted-foreground" />
              Original circular — source of record
            </CardTitle>
          </CardHeader>
          <CardContent>
            {/* Untrusted third-party text as a text node. React escapes it;
                dangerouslySetInnerHTML is never used here. */}
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/85">
              {data.body}
            </pre>
            <p className="mt-3 pt-3 border-t border-border/50 text-[10px] text-muted-foreground">
              {data.gcnEventId && (
                <>
                  GCN event id: <span className="font-mono">{data.gcnEventId}</span> ·{" "}
                </>
              )}
              Ingested {utc(data.ingestedAt)} from{" "}
              {data.source === "archive" ? "the historical archive" : "the live GCN stream"}.
            </p>
          </CardContent>
        </Card>

        {/* ── AI LAYER ───────────────────────────────────────────────────── */}
        <ExtractionView extraction={data.extraction} />
      </div>
    </div>
  );
}
