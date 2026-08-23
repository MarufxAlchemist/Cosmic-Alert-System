import React, { useState, useEffect } from "react";
import { useParams, Link } from "wouter";
import { useGetEvent, getGetEventQueryKey } from "@workspace/api-client-react";
import { EventBadge } from "@/components/EventBadge";
import { formatMicrosecondDate, formatLatency, formatDerived, formatMeasured, formatExp, formatFarInterval } from "@/lib/formatters";
import { ArrowLeft, Target, Map, Activity, Clock, Zap, Database, FlaskConical, Bookmark, BookmarkCheck } from "lucide-react";
import { CorrelationAnalysisPanel } from "@/components/CorrelationAnalysisPanel";
import { ValidationPanel } from "@/components/ValidationPanel";
import { DerivedSciencePanel } from "@/components/DerivedSciencePanel";
import { RevisionTimeline } from "@/components/RevisionTimeline";
import { CircularsPanel } from "@/components/CircularsPanel";
import { EvidenceTimeline } from "@/components/EvidenceTimeline";
import { ResearchInterestPanel } from "@/components/ResearchInterestPanel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { SkyMap } from "@/components/SkyMap";
import { LocalizationPanel } from "@/components/LocalizationPanel";
import { FitsLocalizationViewer } from "@/components/FitsLocalizationViewer";
import { useAuth } from "@/lib/AuthContext";
import { useScienceMode } from "@/lib/ScienceModeContext";
import { Network } from "lucide-react";

type CorrelationType = "multi_messenger" | "cross_detection" | "speculative";

interface Correlation {
  id: string;
  eventId: string;
  eventType: string;
  observatory: string;
  score: number;
  angularSeparationDeg: number;
  deltaTSeconds: number;
  correlationType: CorrelationType;
}

function lifecycleBadge(lifecycle?: string) {
  switch (lifecycle) {
    case "initial":   return { label: "INITIAL",   cls: "bg-blue-500/15 text-blue-400 border-blue-500/40" };
    case "update":    return { label: "UPDATE",    cls: "bg-amber-500/15 text-amber-400 border-amber-500/40" };
    case "confirmed": return { label: "CONFIRMED", cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/40" };
    default:          return { label: "PRELIM",    cls: "bg-zinc-500/10 text-zinc-400 border-zinc-500/30" };
  }
}

export default function EventDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { token } = useAuth();
  const { scienceMode } = useScienceMode();
  const [bookmarked, setBookmarked] = useState(false);
  const [bookmarkLoading, setBookmarkLoading] = useState(false);
  const [mapView, setMapView] = useState<"skymap" | "aladin">("skymap");
  const [correlations, setCorrelations] = useState<Correlation[]>([]);
  const [correlationsLoading, setCorrelationsLoading] = useState(false);

  const { data: event, isLoading } = useGetEvent(id, {
    query: {
      enabled: !!id,
      queryKey: getGetEventQueryKey(id)
    }
  });

  // Check bookmark status once event is loaded
  useEffect(() => {
    if (!token || !event?.id) return;
    fetch(`/api/events/${event.id}/bookmark`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((data: { bookmarked?: boolean }) => setBookmarked(!!data.bookmarked))
      .catch(() => {});
      
    // Fetch correlations
    setCorrelationsLoading(true);
    fetch(`/api/events/${event.id}/correlations`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((data: Correlation[]) => {
        if (Array.isArray(data)) setCorrelations(data);
      })
      .catch(() => {})
      .finally(() => setCorrelationsLoading(false));
  }, [token, event?.id]);

  async function toggleBookmark() {
    if (!token || !event?.id || bookmarkLoading) return;
    setBookmarkLoading(true);
    try {
      const method = bookmarked ? "DELETE" : "POST";
      const res = await fetch(`/api/events/${event.id}/bookmark`, {
        method,
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setBookmarked((v) => !v);
    } catch {
      // silent
    } finally {
      setBookmarkLoading(false);
    }
  }

  if (isLoading) {
    return (
      <div className="container max-w-screen-xl mx-auto p-4 space-y-6">
        <Skeleton className="h-8 w-24 mb-6" />
        <Skeleton className="h-24 w-full" />
        <div className="grid md:grid-cols-2 gap-6">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  if (!event) {
    return (
      <div className="container max-w-screen-xl mx-auto p-4 flex flex-col items-center justify-center min-h-[50vh]">
        <h1 className="text-2xl font-bold mb-4">Event Not Found</h1>
        <Link href="/events" className="text-primary hover:underline">
          Return to Event Log
        </Link>
      </div>
    );
  }

  const lc = lifecycleBadge(event.lifecycle);
  const tier = event.classificationTier as "GOLD" | "BRONZE" | undefined;

  return (
    <div className="h-full overflow-y-auto">
    <div className="container max-w-screen-xl mx-auto p-4 space-y-6">
      <Link href="/events" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-2">
        <ArrowLeft className="w-4 h-4" />
        Back to Log
      </Link>

      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-card border border-border/50 p-6 rounded-xl shadow-sm">
        <div>
          <div className="flex items-center gap-3 mb-2 flex-wrap">
            <EventBadge type={event.eventType} />
            <h1 className="text-3xl font-bold font-mono tracking-tight">{event.eventId}</h1>
            <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-mono font-semibold rounded border uppercase tracking-wider ${lc.cls}`}>
              {lc.label}
            </span>
            {tier === "GOLD" && (
              <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-mono font-semibold rounded border uppercase tracking-wider bg-yellow-400/15 text-yellow-300 border-yellow-400/40">
                GOLD
              </span>
            )}
            {tier === "BRONZE" && (
              <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-mono font-semibold rounded border uppercase tracking-wider bg-orange-700/15 text-orange-400 border-orange-600/40">
                BRONZE
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 text-muted-foreground font-mono text-sm">
            <Clock className="w-4 h-4" />
            {formatMicrosecondDate(event.detectionTime)}
            {scienceMode && event.alertType && (
              <span className="text-xs text-muted-foreground/70">&middot; {event.alertType}</span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <div className="flex flex-col items-end">
            <span className="text-muted-foreground uppercase text-xs tracking-wider">Observatory</span>
            <span className="font-mono font-bold text-primary">{event.observatory}</span>
          </div>
          <div className="h-10 w-px bg-border"></div>
          <div className="flex flex-col items-end">
            <span className="text-muted-foreground uppercase text-xs tracking-wider">Latency</span>
            <span className="font-mono">{formatLatency(event.latencyUs)}</span>
          </div>
          <div className="h-10 w-px bg-border"></div>
          <button
            onClick={toggleBookmark}
            disabled={bookmarkLoading}
            title={bookmarked ? "Remove bookmark" : "Bookmark this event"}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg border text-xs font-semibold transition-colors disabled:opacity-50 ${
              bookmarked
                ? "bg-primary/20 border-primary/50 text-primary hover:bg-primary/10"
                : "bg-card border-border text-muted-foreground hover:text-foreground hover:border-border"
            }`}
          >
            {bookmarked
              ? <BookmarkCheck className="w-3.5 h-3.5" />
              : <Bookmark className="w-3.5 h-3.5" />}
            {bookmarked ? "Bookmarked" : "Bookmark"}
          </button>
          <div className="h-10 w-px bg-border"></div>
          <Link
            href={`/events/${event.id}/workspace`}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary/10 border border-primary/30 text-primary text-xs font-semibold hover:bg-primary/20 transition-colors"
          >
            <FlaskConical className="w-3.5 h-3.5" />
            Open Research Workspace
          </Link>
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <Card className="bg-card border-border/50 shadow-none">
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="flex items-center gap-2 text-lg">
                <Map className="w-5 h-5 text-primary" />
                Localization Map
              </CardTitle>
              {/* View toggle */}
              <div className="flex items-center gap-1 bg-muted/50 rounded-lg p-0.5">
                <button
                  onClick={() => setMapView("skymap")}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                    mapView === "skymap"
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  SkyMap
                </button>
                <button
                  onClick={() => setMapView("aladin")}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                    mapView === "aladin"
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Aladin
                </button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="bg-black/50 rounded-lg overflow-hidden border border-border/50">
                {mapView === "skymap" ? (
                  <SkyMap events={[event]} />
                ) : (
                  <FitsLocalizationViewer
                    event={event}
                    height={500}
                  />
                )}
              </div>
            </CardContent>
          </Card>

          {/* Localization metadata panel — appears for GW events that have FITS products */}
          <LocalizationPanel eventId={event.id} />

          <Card className="bg-card border-border/50 shadow-none">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Target className="w-5 h-5 text-primary" />
                Coordinate Data
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-6">
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Right Ascension</p>
                  <p className="font-mono text-lg">{formatMeasured(event.ra, 4, "°")}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Declination</p>
                  <p className="font-mono text-lg">{formatMeasured(event.dec, 4, "°")}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Error Radius</p>
                  <p className="font-mono text-lg text-amber-500">{formatMeasured(event.errorRadius, 2, "'")}</p>
                </div>
                {scienceMode && (
                  <>
                    <div>
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Galactic Lon</p>
                      <p className="font-mono text-lg">{formatDerived(event.galLon, 4)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Galactic Lat</p>
                      <p className="font-mono text-lg">{formatDerived(event.galLat, 4)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Sun Distance</p>
                      <p className="font-mono text-lg">{formatDerived(event.sunDistance, 1)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Moon Distance</p>
                      <p className="font-mono text-lg">{formatDerived(event.moonDistance, 1)}</p>
                    </div>
                  </>
                )}
              </div>
            </CardContent>
          </Card>

          {/* The evolving scientific history of this event: every machine
              notice and every human-authored circular on one axis. Placed in
              the wide column because circular subjects and AI extractions are
              long-form content that a narrow sidebar would make unreadable. */}
          <EvidenceTimeline eventId={String(event.id)} />

          {/* The circulars themselves, with the original text always reachable
              and anything an AI read out of it clearly marked as such. */}
          <CircularsPanel eventId={String(event.id)} />
        </div>

        <div className="space-y-6">
          <Card className="bg-card border-border/50 shadow-none">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Activity className="w-5 h-5 text-primary" />
                Signal Metrics
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Signal-to-Noise Ratio (SNR)</p>
                <div className="flex items-end gap-2">
                  <p className="font-mono text-3xl font-bold">{formatMeasured(event.snr, 2)}</p>
                  <span className="text-sm text-muted-foreground mb-1">&sigma;</span>
                </div>
                <div className="w-full h-1.5 bg-muted mt-2 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-primary" 
                    style={{ width: `${Math.min(100, ((event.snr ?? 0) / 20) * 100)}%` }}
                  />
                </div>
              </div>

              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">False Alarm Rate (FAR)</p>
                <p className="font-mono text-lg">{formatExp(event.far, 2, " Hz")}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {formatFarInterval(event.far)}
                </p>
              </div>

              {scienceMode && (event.fluence != null || event.dm != null || event.t90 != null ||
                event.peakFlux != null || event.chirpMass != null || event.luminosityDistance != null) && (
                <div className="pt-4 border-t border-border grid grid-cols-2 gap-4">
                  {event.fluence != null && (
                    <div>
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1">
                        <Zap className="w-3 h-3" /> Fluence
                      </p>
                      <p className="font-mono text-sm">{event.fluence.toExponential(3)} erg/cm&sup2;</p>
                    </div>
                  )}
                  {event.t90 != null && (
                    <div>
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">T90 Duration</p>
                      <p className="font-mono text-sm">{event.t90.toFixed(2)} s</p>
                    </div>
                  )}
                  {event.peakFlux != null && (
                    <div>
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Peak Flux</p>
                      <p className="font-mono text-sm">{event.peakFlux.toExponential(3)}</p>
                    </div>
                  )}
                  {event.dm != null && (
                    <div>
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1">
                        <Database className="w-3 h-3" /> Dispersion Measure
                      </p>
                      <p className="font-mono text-sm">{event.dm.toFixed(1)} pc/cm&sup3;</p>
                    </div>
                  )}
                  {event.chirpMass != null && (
                    <div>
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Chirp Mass</p>
                      <p className="font-mono text-sm">{event.chirpMass.toFixed(2)} M&#8857;</p>
                    </div>
                  )}
                  {event.luminosityDistance != null && (
                    <div>
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Luminosity Distance</p>
                      <p className="font-mono text-sm">{event.luminosityDistance.toFixed(1)} Mpc</p>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
          
          {scienceMode && (
            <Card className="bg-card border-border/50 shadow-none">
              <CardHeader className="py-4">
                <CardTitle className="text-sm text-muted-foreground uppercase tracking-wider">System Metadata</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Internal ID</span>
                  <span className="font-mono truncate w-32 text-right">{event.id}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Ingested At</span>
                  <span className="font-mono">{new Date(event.createdAt).toISOString().split('T')[1].replace('Z', '')} UTC</span>
                </div>
              </CardContent>
            </Card>
          )}


          {/* Research interest — shown in both modes: whether an event is
              worth studying is not a specialist-only question. */}
          <ResearchInterestPanel interest={event.researchInterest} />

          {/* Derived quantities with their methods and assumptions */}
          {scienceMode && <DerivedSciencePanel derived={event.derived} />}

          {/* What each notice changed. Shown outside Science Mode too: a
              retraction or an inconsistent position is not a specialist
              detail — anyone acting on this event needs to see it. */}
          <RevisionTimeline eventId={String(event.id)} />

          {/* Scientific validation — full detail in Science Mode */}
          {scienceMode && (
            <ValidationPanel
              validation={event.validation as never}
              quality={event.quality as never}
            />
          )}

          {/* Multi-Messenger Correlations */}
          <Card className="bg-card border-border/50 shadow-none">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg">
                <Network className="w-5 h-5 text-primary" />
                Multi-Messenger Correlations
              </CardTitle>
            </CardHeader>
            <CardContent>
              {correlationsLoading ? (
                <div className="flex justify-center p-4">
                  <span className="text-sm text-muted-foreground animate-pulse">Computing on-demand counterparts...</span>
                </div>
              ) : correlations.length === 0 ? (
                <div className="flex justify-center p-4">
                  <span className="text-sm text-muted-foreground">No strong correlations found in the vicinity.</span>
                </div>
              ) : (
                <div className="space-y-3">
                  {correlations.map((corr) => {
                    const isMultiMessenger = corr.correlationType === "multi_messenger";
                    const isCrossDetection = corr.correlationType === "cross_detection";
                    const scoreColor =
                      isCrossDetection ? "text-sky-400" :
                      corr.score > 70  ? "text-emerald-400" :
                      corr.score > 40  ? "text-amber-400" :
                                         "text-muted-foreground";

                    return (
                      <div
                        key={corr.id}
                        className={`flex items-start justify-between p-3 rounded-lg border bg-muted/20 ${
                          isCrossDetection ? "border-sky-500/20" : "border-border/50"
                        }`}
                      >
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <EventBadge type={corr.eventType} />
                            <Link
                              href={`/events/${corr.id}`}
                              className="font-mono font-bold hover:underline text-sm"
                            >
                              {corr.eventId}
                            </Link>
                          </div>
                          <div className="text-xs text-muted-foreground flex flex-wrap gap-3">
                            <span>{corr.observatory}</span>
                            <span>Sep: {corr.angularSeparationDeg.toFixed(2)}&deg;</span>
                            <span>
                              &Delta;T:{" "}
                              {corr.deltaTSeconds > 0 ? "+" : ""}
                              {Math.abs(corr.deltaTSeconds) > 86400
                                ? (corr.deltaTSeconds / 3600).toFixed(1) + "h"
                                : corr.deltaTSeconds.toFixed(1) + "s"}
                            </span>
                          </div>
                          {/* Correlation type badge */}
                          <span
                            className={`inline-block text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                              isMultiMessenger
                                ? "border-primary/30 bg-primary/10 text-primary/80"
                                : isCrossDetection
                                  ? "border-sky-500/30 bg-sky-500/10 text-sky-400"
                                  : "border-border/50 bg-muted/30 text-muted-foreground"
                            }`}
                          >
                            {isCrossDetection ? "cross-detection" : isMultiMessenger ? "multi-messenger" : "speculative"}
                          </span>
                        </div>
                        <div className="flex flex-col items-end shrink-0 pl-3">
                          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Score</span>
                          <span className={`font-mono text-lg font-bold ${scoreColor}`}>
                            {corr.score}%
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ── AI Correlation Analysis ─────────────────────────────────────────── */}
      <CorrelationAnalysisPanel
        eventId={event.id}
        hasCorrelations={correlations.length > 0}
      />
    </div>
    </div>
  );
}
