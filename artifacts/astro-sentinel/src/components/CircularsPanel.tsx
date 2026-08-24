import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  HelpCircle,
  Loader2,
  Sparkles,
  User,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * CircularsPanel
 * ──────────────
 * The human-authored scientific history of an event: every GCN Circular
 * attached to it, oldest first.
 *
 * THE RULE THIS COMPONENT EXISTS TO ENFORCE
 * ─────────────────────────────────────────
 * Three kinds of statement appear here and they are never merged into one
 * indistinguishable block:
 *
 *   SOURCE            what the circular's authors wrote. The original text,
 *                     verbatim, always reachable.
 *   AI-EXTRACTED      structured fields a model read out of that text, each
 *                     one traceable to the span that supports it.
 *   AI SUMMARY        a model's restatement. Clearly an interpretation, and
 *                     visually subordinate to the source it came from.
 *
 * An AI-extracted fact is styled distinctly (violet, with a Sparkles mark) and
 * is never presented in the same voice as an observatory report. Presenting a
 * model's reading as an observatory-confirmed measurement is the specific
 * failure this layout prevents.
 *
 * TWO ABSENCES THAT MUST NOT LOOK THE SAME
 * ────────────────────────────────────────
 *   "Not reported"    the circular does not mention this. A real statement.
 *   "Not extracted"   the AI never ran, or failed. NOT a statement about the
 *                     science, and never rendered as though it were.
 *
 * SECURITY
 * ────────
 * A circular body is untrusted third-party text. It is rendered as a text node
 * inside <pre> — never via dangerouslySetInnerHTML — so markup in a body is
 * displayed, not executed.
 */

// ─── Wire types ──────────────────────────────────────────────────────────────

type DetectionState = "detected" | "not_detected" | "upper_limit" | "candidate" | "unknown";

interface Quantity {
  value: number;
  uncertainty: number | null;
  unit: string;
}

interface Observation {
  band: string;
  instrument: string | null;
  facility: string | null;
  detection: DetectionState;
  limit: Quantity | null;
  measurement: Quantity | null;
  observedAtUtc: string | null;
  sourceText: string | null;
}

interface ExtractionData {
  observations: Observation[];
  localization: {
    status: string;
    raDeg: number | null;
    decDeg: number | null;
    errorRadius: number | null;
    errorUnit: string | null;
    containment: string | null;
    sourceText: string | null;
  };
  spectroscopy: { status: string; facility: string | null; sourceText: string | null };
  redshift: {
    value: number;
    uncertainty: number | null;
    kind: string;
    reportedBy: string | null;
    sourceText: string | null;
  } | null;
  followUp: { status: string; sourceText: string | null };
  classification: { value: string; sourceText: string | null } | null;
  scientificSummary: string;
  extractionConfidence: "high" | "medium" | "low";
  notReported: string[];
}

export interface Extraction {
  status: "none" | "pending" | "processing" | "completed" | "failed";
  data?: ExtractionData | null;
  model?: string | null;
  schemaVersion?: number;
  promptVersion?: number;
  extractedAt?: string | null;
  attempts?: number;
  failureKind?: string | null;
  error?: string | null;
  note?: string;
}

interface CircularSummary {
  id: string;
  circularId: number;
  version: number;
  isLatest: boolean;
  revisionStatus: "original" | "revised";
  gcnEventId: string | null;
  subject: string;
  submitter: string;
  createdOn: string;
  editedOn: string | null;
  editedBy: string | null;
  gcnUrl: string | null;
  association: { method: string; rationale: string | null };
  extraction: Extraction;
}

interface CircularFull extends CircularSummary {
  body: string;
  versionCount: number;
}

// ─── Presentation helpers ────────────────────────────────────────────────────

const BAND_LABEL: Record<string, string> = {
  gamma_ray: "Gamma-ray",
  x_ray: "X-ray",
  uv: "Ultraviolet",
  optical: "Optical",
  infrared: "Infrared",
  radio: "Radio",
  gravitational_wave: "Gravitational wave",
  neutrino: "Neutrino",
  other: "Other",
};

/**
 * An upper limit is NOT a detection, and the styling says so at a glance.
 * Collapsing the two is the single most damaging misreading of a follow-up
 * report, so they never share a colour.
 */
const DETECTION_STYLE: Record<DetectionState, { label: string; cls: string }> = {
  detected: { label: "Detected", cls: "text-emerald-400 border-emerald-500/40 bg-emerald-500/10" },
  candidate: { label: "Candidate", cls: "text-amber-400 border-amber-500/40 bg-amber-500/10" },
  upper_limit: { label: "Upper limit", cls: "text-sky-400 border-sky-500/40 bg-sky-500/10" },
  not_detected: { label: "Not detected", cls: "text-zinc-400 border-zinc-500/30 bg-zinc-500/10" },
  unknown: { label: "Not stated", cls: "text-muted-foreground border-border/60 bg-muted/20" },
};

export const ASSOCIATION_NOTE: Record<string, { label: string; cls: string; note: string | null }> = {
  EXACT: { label: "Matched by identifier", cls: "text-muted-foreground", note: null },
  ALIAS: {
    label: "Matched by alternate spelling",
    cls: "text-muted-foreground",
    note: null,
  },
  PROBABILISTIC: {
    label: "Probabilistic match",
    cls: "text-amber-400",
    note: "This circular was linked by timing, not by a stated event identifier. Treat the association itself as uncertain.",
  },
  PENDING_REVIEW: {
    label: "Held for review",
    cls: "text-amber-400",
    note: "The identifier matched more than one event, so this circular is not attached to any of them.",
  },
  UNMATCHED: { label: "Not attached", cls: "text-amber-400", note: null },
};

export function utc(iso: string): string {
  return `${new Date(iso).toISOString().replace("T", " ").slice(0, 16)}Z`;
}

function quantityText(q: Quantity): string {
  const unc = q.uncertainty !== null ? ` ± ${q.uncertainty}` : "";
  return `${q.value}${unc} ${q.unit}`;
}

// ─── AI provenance chrome ────────────────────────────────────────────────────

/** Marks a region as model output. Never used around source text. */
function AiBlock({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div className="rounded-md border border-violet-500/25 bg-violet-500/[0.04] p-3">
      <div className="flex items-center gap-1.5 mb-2">
        <Sparkles className="w-3 h-3 text-violet-400 shrink-0" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-violet-400">
          {label}
        </span>
      </div>
      {children}
    </div>
  );
}

export function ExtractionStatusLine({ extraction }: { extraction: Extraction }) {
  switch (extraction.status) {
    case "completed":
      return (
        <span className="inline-flex items-center gap-1 text-[10px] text-violet-400">
          <Sparkles className="w-3 h-3" /> AI extraction available
        </span>
      );
    case "pending":
    case "processing":
      return (
        <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
          <Loader2 className="w-3 h-3 animate-spin" /> AI extraction processing
        </span>
      );
    case "failed":
      return (
        <span className="inline-flex items-center gap-1 text-[10px] text-amber-500">
          <AlertTriangle className="w-3 h-3" /> AI extraction failed
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
          <HelpCircle className="w-3 h-3" /> No AI extraction
        </span>
      );
  }
}

/**
 * The structured extraction, or an honest account of why there isn't one.
 *
 * Every non-completed state renders as a statement about the ENRICHMENT, never
 * about the circular. "AI extraction failed" must not be mistakable for "this
 * circular reported nothing".
 */
export function ExtractionView({ extraction }: { extraction: Extraction }) {
  if (extraction.status !== "completed" || !extraction.data) {
    const message =
      extraction.status === "failed"
        ? "AI extraction failed for this circular. The original text above is complete and unaffected — nothing scientific is missing from this page."
        : extraction.status === "pending" || extraction.status === "processing"
          ? "AI extraction has not finished yet. The original text above is complete."
          : "No AI extraction has been run for this circular. The original text above is complete.";

    return (
      <div className="rounded-md border border-border/50 bg-muted/10 p-3">
        <p className="text-xs text-muted-foreground">{message}</p>
        {extraction.status === "failed" && extraction.error && (
          <p className="mt-1.5 text-[10px] font-mono text-muted-foreground/70 break-words">
            {extraction.error}
          </p>
        )}
      </div>
    );
  }

  const d = extraction.data;

  return (
    <div className="space-y-3">
      <AiBlock label="AI-extracted observations">
        {d.observations.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            The model found no reported observations in this circular. Circulars
            that request observations, correct an earlier report, or discuss
            interpretation legitimately contain none.
          </p>
        ) : (
          <ul className="space-y-2">
            {d.observations.map((o, i) => {
              const style = DETECTION_STYLE[o.detection] ?? DETECTION_STYLE.unknown;
              return (
                <li key={i} className="text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">
                      {BAND_LABEL[o.band] ?? o.band}
                    </span>
                    <span
                      className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-mono uppercase tracking-wide ${style.cls}`}
                    >
                      {style.label}
                    </span>
                    {o.instrument && (
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {o.instrument}
                      </span>
                    )}
                  </div>
                  {/* An upper limit is shown as a limit, with its units as the
                      circular wrote them. Never converted, never restated as a
                      measured brightness. */}
                  {o.detection === "upper_limit" && o.limit && (
                    <div className="mt-0.5 font-mono text-[11px] text-sky-300/90">
                      limit &gt; {quantityText(o.limit)}
                    </div>
                  )}
                  {o.measurement && (
                    <div className="mt-0.5 font-mono text-[11px] text-emerald-300/90">
                      {quantityText(o.measurement)}
                    </div>
                  )}
                  {o.sourceText && (
                    <blockquote className="mt-1 border-l-2 border-border pl-2 text-[10px] italic text-muted-foreground">
                      “{o.sourceText}”
                    </blockquote>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </AiBlock>

      <AiBlock label="AI-extracted measurements">
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <ExtractedField
            label="Redshift"
            /* null is rendered as "Not reported" — a statement about the
               circular — and never as 0 or a blank. */
            value={
              d.redshift
                ? `z = ${d.redshift.value}${d.redshift.uncertainty !== null ? ` ± ${d.redshift.uncertainty}` : ""}${
                    d.redshift.kind !== "unknown" ? ` (${d.redshift.kind})` : ""
                  }`
                : null
            }
            sourceText={d.redshift?.sourceText ?? null}
          />
          <ExtractedField
            label="Localization"
            value={
              d.localization.status === "unknown"
                ? null
                : d.localization.raDeg !== null && d.localization.decDeg !== null
                  ? `${d.localization.status} — RA ${d.localization.raDeg}°, Dec ${d.localization.decDeg}°` +
                    (d.localization.errorRadius !== null
                      ? ` ± ${d.localization.errorRadius}${d.localization.errorUnit ?? ""}` +
                        (d.localization.containment ? ` (${d.localization.containment})` : "")
                      : "")
                  : d.localization.status
            }
            sourceText={d.localization.sourceText}
          />
          <ExtractedField
            label="Spectroscopy"
            value={
              d.spectroscopy.status === "unknown"
                ? null
                : d.spectroscopy.status.replace("_", " ") +
                  (d.spectroscopy.facility ? ` — ${d.spectroscopy.facility}` : "")
            }
            sourceText={d.spectroscopy.sourceText}
          />
          <ExtractedField
            label="Follow-up"
            value={d.followUp.status === "unknown" ? null : d.followUp.status}
            sourceText={d.followUp.sourceText}
          />
          <ExtractedField
            label="Classification"
            /* Present only when the circular STATES one. Never inferred from a
               duration or a spectral index. */
            value={d.classification?.value ?? null}
            sourceText={d.classification?.sourceText ?? null}
          />
        </dl>

        {d.notReported.length > 0 && (
          <p className="mt-2 pt-2 border-t border-violet-500/15 text-[10px] text-muted-foreground">
            <span className="font-semibold">Not addressed by this circular:</span>{" "}
            {d.notReported.join(", ")}
          </p>
        )}
      </AiBlock>

      <AiBlock label="AI summary — an interpretation, not a source">
        <p className="text-xs leading-relaxed text-foreground/85">{d.scientificSummary}</p>
      </AiBlock>

      {/* Provenance. Without this the extraction is an anonymous assertion. */}
      <p className="text-[10px] text-muted-foreground/70 leading-relaxed">
        Extracted by <span className="font-mono">{extraction.model ?? "unknown model"}</span>
        {extraction.extractedAt ? ` on ${utc(extraction.extractedAt)}` : ""} · schema v
        {extraction.schemaVersion} · prompt v{extraction.promptVersion} · extraction confidence{" "}
        <span className="font-medium">{d.extractionConfidence}</span>.{" "}
        {/* The distinction that stops a confidence score being read as physics. */}
        Extraction confidence means how well the extracted fields are supported by
        this circular&rsquo;s wording. It is not a judgement about whether the
        astrophysics is correct.
      </p>
    </div>
  );
}

function ExtractedField({
  label,
  value,
  sourceText,
}: {
  label: string;
  value: string | null;
  sourceText: string | null;
}) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className={value ? "font-mono text-foreground" : "text-muted-foreground italic"}>
        {value ?? "Not reported"}
      </dd>
      {value && sourceText && (
        <blockquote className="mt-0.5 border-l-2 border-border pl-2 text-[10px] italic text-muted-foreground">
          “{sourceText}”
        </blockquote>
      )}
    </div>
  );
}

// ─── One circular ────────────────────────────────────────────────────────────

function CircularEntry({ summary }: { summary: CircularSummary }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState<CircularFull | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    if (!open || full || loadFailed) return;
    let cancelled = false;
    fetch(`/api/circulars/${summary.circularId}?version=${summary.version}`)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((d: CircularFull) => {
        if (!cancelled) setFull(d);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, full, loadFailed, summary.circularId, summary.version]);

  const assoc = ASSOCIATION_NOTE[summary.association.method] ?? ASSOCIATION_NOTE.UNMATCHED;

  return (
    <li className="rounded-md border border-border/50 bg-muted/10">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left p-3 flex items-start gap-2 hover:bg-accent/20 transition-colors rounded-md"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="w-4 h-4 shrink-0 mt-0.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="w-4 h-4 shrink-0 mt-0.5 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs font-bold text-primary">
              GCN Circular #{summary.circularId}
            </span>
            {/* Original vs Revised, from the version number — not a guess. */}
            {summary.revisionStatus === "revised" && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-400 uppercase tracking-wide">
                revised · v{summary.version}
              </span>
            )}
            <span className="text-[10px] font-mono text-muted-foreground">
              {utc(summary.createdOn)}
            </span>
          </div>
          <div className="mt-1 text-sm text-foreground/90 break-words">{summary.subject}</div>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
              <User className="w-3 h-3" /> {summary.submitter}
            </span>
            <ExtractionStatusLine extraction={summary.extraction} />
          </div>
        </div>
      </button>

      {open && (
        <div className="px-3 pb-3 pl-9 space-y-3">
          {assoc.note && (
            <p className={`text-[10px] ${assoc.cls}`}>
              <AlertTriangle className="w-3 h-3 inline mr-1 -mt-0.5" />
              {assoc.note}
            </p>
          )}

          {/* ── SOURCE ───────────────────────────────────────────────────── */}
          <div className="rounded-md border border-border/60 bg-background/40 p-3">
            <div className="flex items-center gap-1.5 mb-2">
              <FileText className="w-3 h-3 text-muted-foreground shrink-0" />
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Original circular — source of record
              </span>
            </div>
            {loadFailed ? (
              <p className="text-xs text-amber-500/80">
                The original text could not be loaded. It is stored — this is a
                display failure, not a missing circular.
              </p>
            ) : !full ? (
              <p className="text-xs text-muted-foreground animate-pulse">Loading original text…</p>
            ) : (
              /* Untrusted third-party text rendered as a text node. React
                 escapes it; dangerouslySetInnerHTML is never used here. */
              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/80 max-h-96 overflow-y-auto scrollbar-thin">
                {full.body}
              </pre>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground">
              {summary.gcnUrl && (
                <a
                  href={summary.gcnUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  <ExternalLink className="w-3 h-3" /> Open at gcn.nasa.gov
                </a>
              )}
              {summary.gcnEventId && (
                <span>
                  GCN event id: <span className="font-mono">{summary.gcnEventId}</span>
                </span>
              )}
              {summary.editedOn && (
                <span>
                  Revised {utc(summary.editedOn)}
                  {summary.editedBy ? ` by ${summary.editedBy}` : ""}
                </span>
              )}
              {full && full.versionCount > 1 && (
                <span>
                  {full.versionCount} versions — earlier text is retained and remains readable.
                </span>
              )}
            </div>
          </div>

          {/* ── AI LAYER ─────────────────────────────────────────────────── */}
          <ExtractionView extraction={summary.extraction} />
        </div>
      )}
    </li>
  );
}

// ─── Panel ───────────────────────────────────────────────────────────────────

export function CircularsPanel({ eventId }: { eventId: string }) {
  const [rows, setRows] = useState<CircularSummary[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setFailed(false);
    fetch(`/api/events/${eventId}/circulars`)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((d: { circulars: CircularSummary[] }) => {
        if (!cancelled) setRows(d.circulars ?? []);
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
            <FileText className="w-5 h-5 text-primary" />
            GCN Circulars
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-amber-500/80">
            The circulars for this event could not be loaded, so whether any have
            been published is unknown.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (rows === null) return null;

  return (
    <Card className="bg-card border-border/50 shadow-none">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <FileText className="w-5 h-5 text-primary" />
          GCN Circulars
          <span className="text-xs font-normal text-muted-foreground ml-1">
            {rows.length} circular{rows.length === 1 ? "" : "s"}
          </span>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Human-authored scientific reports about this event, oldest first. The
          original text of each is always shown; anything an AI read out of it is
          marked as such.
        </p>
      </CardHeader>

      <CardContent>
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No GCN Circulars are attached to this event. Circulars are written by
            people in the hours to weeks after a detection — many events never
            receive one, and an event ingested before circular tracking was added
            may have circulars that are not yet linked here.
          </p>
        ) : (
          <ol className="space-y-2">
            {rows.map((c) => (
              <CircularEntry key={c.id} summary={c} />
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
