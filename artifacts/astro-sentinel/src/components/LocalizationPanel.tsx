import React, { useEffect, useState } from "react";
import { Layers } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// ── Types ─────────────────────────────────────────────────────────────────────

interface LocalizationRecord {
  id: string;
  eventId: string;
  fitsUrl: string;
  method: string;
  version: number;
  isLatest: boolean;
  nside?: number;
  area50Deg2?: number;
  area90Deg2?: number;
  vol50Mpc3?: number;
  vol90Mpc3?: number;
  hasNsProb?: number;
  createdAt: string;
}

interface Props {
  /** core.events.id (bigserial, stringified) */
  eventId: string;
}

// ── Helper ────────────────────────────────────────────────────────────────────

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between items-baseline gap-2 py-1.5 border-b border-border/40 last:border-0">
      <span className="text-xs text-muted-foreground uppercase tracking-wider shrink-0">
        {label}
      </span>
      <span className="font-mono text-sm text-right">{value}</span>
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export function LocalizationPanel({ eventId }: Props) {
  const [records, setRecords] = useState<LocalizationRecord[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!eventId) return;
    setLoading(true);
    setError(false);

    fetch(`/api/events/${eventId}/localizations`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<LocalizationRecord[]>;
      })
      .then((data) => {
        setRecords(data);
        setLoading(false);
      })
      .catch(() => {
        setError(true);
        setLoading(false);
      });
  }, [eventId]);

  // Latest-first; if none marked is_latest, show the first record
  const latest = records?.find((r) => r.isLatest) ?? records?.[0] ?? null;

  // Localization products are FITS/HEALPix maps, which in practice only GW
  // events carry. Rendering a whole card to announce their absence put two
  // panels in a slot the event page wants one thing in, and it said the same
  // empty sentence on every event in the archive. So the card appears only
  // when there is something in it; Coordinate Data is what occupies the slot
  // the rest of the time.
  //
  // A FAILED fetch still renders. "We could not find out" is not the same
  // claim as "there is nothing here", and collapsing the two would be exactly
  // the sort of quiet absence the rest of this page refuses to produce.
  if (loading) return null;
  if (!error && (records?.length ?? 0) === 0) return null;

  return (
    <Card className="bg-card border-border/50 shadow-none">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Layers className="w-5 h-5 text-primary" />
          Localization Information
        </CardTitle>
      </CardHeader>
      <CardContent>
        {/* Fetch error */}
        {error && (
          <p className="text-sm text-muted-foreground italic">
            Could not load localization data, so whether this event has any is
            unknown here.
          </p>
        )}

        {/* Data */}
        {!error && latest && (
          <div className="space-y-0">
            <Row label="Method"   value={latest.method} />
            <Row label="Version"  value={`v${latest.version}`} />
            <Row
              label="FITS Available"
              value={
                <span className={latest.fitsUrl ? "text-emerald-400" : "text-muted-foreground"}>
                  {latest.fitsUrl ? "Yes" : "No"}
                </span>
              }
            />
            {latest.nside !== undefined && (
              <Row label="Nside" value={latest.nside} />
            )}
            {latest.area50Deg2 !== undefined && (
              <Row
                label="Area 50%"
                value={`${latest.area50Deg2.toFixed(1)} deg²`}
              />
            )}
            {latest.area90Deg2 !== undefined && (
              <Row
                label="Area 90%"
                value={`${latest.area90Deg2.toFixed(1)} deg²`}
              />
            )}
            {latest.vol50Mpc3 !== undefined && (
              <Row
                label="Vol 50%"
                value={`${latest.vol50Mpc3.toExponential(2)} Mpc³`}
              />
            )}
            {latest.vol90Mpc3 !== undefined && (
              <Row
                label="Vol 90%"
                value={`${latest.vol90Mpc3.toExponential(2)} Mpc³`}
              />
            )}
            {latest.hasNsProb !== undefined && (
              <Row
                label="P(NS)"
                value={`${(latest.hasNsProb * 100).toFixed(1)}%`}
              />
            )}
            <Row
              label="Created At"
              value={new Date(latest.createdAt).toISOString().replace("T", " ").replace("Z", " UTC")}
            />
            {/* Revision count badge — only shown when more than one revision exists */}
            {records && records.length > 1 && (
              <p className="text-xs text-muted-foreground mt-3 pt-2 border-t border-border/40">
                {records.length} revision{records.length !== 1 ? "s" : ""} ingested
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
