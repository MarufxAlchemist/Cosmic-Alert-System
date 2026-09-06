import { useState, useEffect } from "react";
import type { AstroEvent } from "@workspace/api-client-react";
import { ExternalLink } from "lucide-react";

interface Props { event: AstroEvent; }

/**
 * TODO: move to @workspace/api-client-react once /events/:id/colibri/afterglow
 * is added to the OpenAPI spec and the client is regenerated. Defined locally
 * for now rather than importing across the workspace boundary from the
 * api-server, which the frontend does not depend on.
 */
interface ColibriAfterglow {
  available: boolean;
  figureUrl: string | null;
  eventName: string | null;
  observationCount: number;
}

const DETECTORS: Record<string, string[]> = {
  GRB: ["NaI-0", "NaI-1", "NaI-2", "BGO-0", "BGO-1"],
  GW: ["H1", "L1", "V1", "K1"],
  FRB: ["Beam-0", "Beam-1", "Beam-2"],
};

export function Lightcurves({ event }: Props) {
  const detectors = DETECTORS[event.eventType] ?? DETECTORS.GRB;
  const [selected, setSelected] = useState(detectors[0]);

  const [colibri, setColibri] = useState<ColibriAfterglow | null>(null);
  const [colibriLoading, setColibriLoading] = useState(true);
  const [colibriError, setColibriError] = useState(false);

  // Our own API is addressed by the database id; the api-server translates it
  // to the event name before querying Astro-COLIBRI.
  useEffect(() => {
    const controller = new AbortController();

    setColibriLoading(true);
    setColibriError(false);
    setColibri(null);

    fetch(`/api/events/${event.id}/colibri/afterglow`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as ColibriAfterglow;
      })
      .then((data) => {
        setColibri(data);
        setColibriLoading(false);
      })
      .catch((err: Error) => {
        // An aborted request is a tab switch, not a failure — the component is
        // unmounting and must not set state.
        if (err.name === "AbortError") return;
        setColibriError(true);
        setColibriLoading(false);
      });

    return () => controller.abort();
  }, [event.id]);

  return (
    <div className="flex flex-col h-full p-3 gap-4 overflow-y-auto scrollbar-thin">
      {/* ── Optical afterglow context (Astro-COLIBRI) ───────────────────── */}
      <div>
        <div className="flex items-center gap-1.5 mb-1.5">
          <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
            Optical afterglow context · Astro-COLIBRI
          </span>
          <a
            href={`https://astro-colibri.science/sources/${encodeURIComponent(event.eventId)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-primary transition-colors"
            aria-label={`Open ${event.eventId} on Astro-COLIBRI`}
          >
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>

        {colibriLoading && (
          <div className="h-40 w-full rounded bg-muted/30 animate-pulse" />
        )}

        {!colibriLoading && colibriError && (
          <div className="text-[11px] text-muted-foreground">
            Astro-COLIBRI context unavailable
          </div>
        )}

        {!colibriLoading && !colibriError && colibri?.available && colibri.figureUrl && (
          <div>
            <img
              src={colibri.figureUrl}
              alt={`Optical afterglow context for ${event.eventId}`}
              className="w-full rounded object-contain max-h-56"
            />
            <div className="mt-1 text-[10px] text-muted-foreground">
              {colibri.observationCount} extracted observations · Astro-COLIBRI
            </div>
          </div>
        )}

        {!colibriLoading && !colibriError && colibri && !colibri.available && (
          <div className="text-[11px] text-muted-foreground">
            No optical afterglow data in Astro-COLIBRI for this event
          </div>
        )}
      </div>

      {/* ── Prompt emission ─────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <div>
          <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider mb-1.5">Detector</div>
          <div className="flex flex-wrap gap-1">
            {detectors.map(d => (
              <button
                key={d}
                onClick={() => setSelected(d)}
                className={`px-2 py-0.5 text-[10px] font-mono rounded border transition-all ${
                  selected === d
                    ? "bg-primary/20 border-primary/60 text-primary"
                    : "bg-card border-border text-muted-foreground hover:border-muted-foreground hover:text-foreground"
                }`}
              >
                {d}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col rounded border border-border bg-card overflow-hidden">
          <div className="px-2.5 py-1.5 border-b border-border flex items-center justify-between shrink-0">
            <span className="text-[10px] font-mono text-foreground font-semibold">Lightcurve — {selected}</span>
            <span className="text-[9px] font-mono text-muted-foreground">{event.eventId}</span>
          </div>
          <div className="p-2">
            <div className="h-28 rounded border border-dashed border-border flex items-center justify-center text-[11px] text-muted-foreground">
              Prompt-emission lightcurve not yet available
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
