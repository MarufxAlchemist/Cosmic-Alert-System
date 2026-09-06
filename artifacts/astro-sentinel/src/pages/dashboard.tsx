import React, { useState, useMemo } from "react";
import { useAstroWebSocket } from "@/hooks/useAstroWebSocket";
import { useListEvents } from "@workspace/api-client-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { AstroEvent } from "@workspace/api-client-react/src/generated/api.schemas";
import { formatMicrosecondDate, formatLatency, formatMeasured, formatExp, formatDerived } from "@/lib/formatters";
import { useScienceMode } from "@/lib/ScienceModeContext";
import { SciencePanel } from "@/components/SciencePanel";
import { MissionControlBar } from "@/components/MissionControlBar";

function typeColor(type: string) {
  switch (type) {
    case "GRB": return { bg: "bg-orange-500/15", border: "border-orange-600/60", text: "text-orange-800 dark:text-amber-400", dot: "bg-orange-600 dark:bg-amber-500" };
    case "GW":  return { bg: "bg-green-500/15",  border: "border-green-600/60",  text: "text-green-800  dark:text-emerald-400", dot: "bg-green-700  dark:bg-emerald-500" };
    case "FRB": return { bg: "bg-amber-400/15",  border: "border-amber-600/60",  text: "text-amber-900 dark:text-yellow-300",  dot: "bg-amber-600  dark:bg-yellow-400" };
    default:    return { bg: "bg-blue-500/15",   border: "border-blue-600/50",   text: "text-blue-800   dark:text-blue-400",   dot: "bg-blue-600" };
  }
}

function typeLabel(type: string) {
  switch (type) {
    case "GRB": return "Gamma-ray burst";
    case "GW":  return "Gravitational wave";
    case "FRB": return "Fast radio burst";
    default:    return type;
  }
}

function lifecycleBadge(lifecycle?: string) {
  switch (lifecycle) {
    case "initial":   return { label: "INITIAL",   cls: "bg-blue-500/15 text-blue-400 border-blue-500/40" };
    case "update":    return { label: "UPDATE",     cls: "bg-amber-500/15 text-amber-400 border-amber-500/40" };
    case "confirmed": return { label: "CONFIRMED",  cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/40" };
    default:          return { label: "PRELIM",     cls: "bg-zinc-500/10 text-zinc-400 border-zinc-500/30" };
  }
}

function SidebarItem({ event, selected, isNew, onClick, scienceMode }: { event: AstroEvent; selected: boolean; isNew: boolean; onClick: () => void; scienceMode: boolean; }) {
  const c = typeColor(event.eventType);
  const lc = lifecycleBadge((event as any).lifecycle);
  const tier          = (event as any).classificationTier as "GOLD" | "BRONZE" | undefined;
  const revisionCount = (event as any).revisionCount as number | undefined;
  const isHistorical  = (event as any).isHistorical  as boolean | undefined;
  return (
    <div onClick={onClick} className={`flex items-center gap-2.5 px-2.5 cursor-pointer transition-all border-l-2 ${scienceMode ? "py-2.5" : "py-2"} ${selected ? `bg-primary/10 border-l-primary` : `border-l-transparent hover:bg-accent/50`} ${isNew ? "animate-in fade-in slide-in-from-top-2 duration-400" : ""}`}>
      <div className={`w-9 h-9 rounded-md border ${c.border} ${c.bg} flex items-center justify-center shrink-0`}>
        <div className={`w-3 h-3 rounded-full ${c.dot} shadow-[0_0_6px_currentColor]`} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-mono text-xs font-bold text-foreground truncate">{event.eventId}</div>
        <div className={`text-[10px] ${c.text} truncate`}>{typeLabel(event.eventType)}</div>
        {/* Lifecycle + tier + historical + revision badges */}
        <div className="flex items-center gap-1 mt-0.5 flex-wrap">
          <span className={`inline-flex items-center px-1.5 py-px text-[8px] font-mono font-semibold rounded border ${lc.cls} leading-none`}>
            {lc.label}
          </span>
          {tier === "GOLD" && (
            <span className="inline-flex items-center px-1.5 py-px text-[8px] font-mono font-semibold rounded border bg-yellow-400/15 text-yellow-300 border-yellow-400/40 leading-none">
              GOLD
            </span>
          )}
          {tier === "BRONZE" && (
            <span className="inline-flex items-center px-1.5 py-px text-[8px] font-mono font-semibold rounded border bg-orange-700/15 text-orange-400 border-orange-600/40 leading-none">
              BRONZE
            </span>
          )}
          {isHistorical && (
            <span
              className="inline-flex items-center px-1.5 py-px text-[8px] font-mono font-semibold rounded border bg-stone-500/10 text-stone-400 border-stone-500/30 leading-none"
              title="Historical event loaded at startup — not a live Kafka alert"
            >
              Historical
            </span>
          )}
          {revisionCount !== undefined && revisionCount > 0 && (
            <span
              className="inline-flex items-center px-1.5 py-px text-[8px] font-mono font-semibold rounded border bg-violet-500/10 text-violet-400 border-violet-500/30 leading-none"
              title={`Updated ${revisionCount} time${revisionCount === 1 ? "" : "s"} by follow-up notices`}
            >
              rev {revisionCount}
            </span>
          )}
        </div>
        {scienceMode && (
          <div className="mt-0.5 grid grid-cols-2 gap-x-1 text-[9px] font-mono text-muted-foreground">
            <span>RA {formatMeasured(event.ra, 1, "°")}</span>
            <span>Dec {formatMeasured(event.dec, 1, "°")}</span>
            <span>SNR {formatMeasured(event.snr, 1, "σ")}</span>
            <span>FAR {formatExp(event.far, 1)}</span>
          </div>
        )}
      </div>
      {isNew && <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse shrink-0" />}
    </div>
  );
}

function EventBrief({ event }: { event: AstroEvent }) {
  const c = typeColor(event.eventType);
  const dateStr = formatMicrosecondDate(event.detectionTime);
  const { scienceMode } = useScienceMode();
  return (
    <div className="flex gap-3 p-2.5 border-b border-border bg-[hsl(var(--sidebar))] shrink-0">
      <div className={`w-11 h-11 rounded-lg border ${c.border} ${c.bg} flex items-center justify-center shrink-0`}>
        <div className={`w-4 h-4 rounded-full ${c.dot}`} />
      </div>
      <div className="shrink-0">
        <div className="font-mono text-sm font-bold text-foreground">{event.eventId}</div>
        <div className={`text-xs ${c.text}`}>{typeLabel(event.eventType)}</div>
        <button className={`mt-1 px-2.5 py-0.5 text-[10px] font-mono rounded border ${c.border} ${c.text} ${c.bg} hover:opacity-80 transition-opacity`}>
          Zoom
        </button>
      </div>
      <div className={`flex-1 grid gap-x-4 gap-y-0.5 text-[11px] font-mono ${scienceMode ? "grid-cols-3" : "grid-cols-2"}`}>
        <div><span className="text-muted-foreground">Date [UTC]: </span><span className="text-foreground">{dateStr.slice(0, 19).replace("T", " ")}</span></div>
        <div><span className="text-muted-foreground">Right ascension [deg]: </span><span className="text-foreground">{formatMeasured(event.ra, 2)}</span></div>
        <div><span className="text-muted-foreground">Declination [deg]: </span><span className="text-foreground">{formatMeasured(event.dec, 2)}</span></div>
        <div><span className="text-muted-foreground">observatory: </span><span className="text-foreground">{event.observatory}</span></div>
        <div><span className="text-muted-foreground">instrument: </span><span className="text-foreground">{event.observatory}/{event.eventType}</span></div>
        <div><span className="text-muted-foreground">SNR: </span><span className="text-foreground">{formatMeasured(event.snr, 1, " σ")}</span></div>
        {scienceMode && <>
          <div><span className="text-muted-foreground">FAR: </span><span className="text-foreground">{formatExp(event.far, 3, " Hz")}</span></div>
          <div><span className="text-muted-foreground">Err radius: </span><span className="text-foreground">{formatMeasured(event.errorRadius, 2, "'")}</span></div>
          <div><span className="text-muted-foreground">Latency: </span><span className="text-foreground">{formatLatency(event.latencyUs)}</span></div>
          <div><span className="text-muted-foreground">Gal. lon: </span><span className="text-foreground">{formatDerived(event.galLon, 2)}</span></div>
          <div><span className="text-muted-foreground">Gal. lat: </span><span className="text-foreground">{formatDerived(event.galLat, 2)}</span></div>
          <div><span className="text-muted-foreground">Sun dist: </span><span className="text-foreground">{formatDerived(event.sunDistance, 1)}</span></div>
          {event.fluence != null && <div><span className="text-muted-foreground">Fluence: </span><span className="text-foreground">{event.fluence.toExponential(3)} erg/cm²</span></div>}
          {event.dm != null && <div><span className="text-muted-foreground">DM: </span><span className="text-foreground">{event.dm.toFixed(1)} pc/cm³</span></div>}
        </>}
      </div>
    </div>
  );
}

function generateSummary(event: AstroEvent): string {
  const dateStr = formatMicrosecondDate(event.detectionTime).slice(0, 19).replace("T", " ");
  const type = typeLabel(event.eventType);
  const hasPosition = event.ra != null && event.dec != null;
  const raDec = hasPosition
    ? `(RA: ${event.ra!.toFixed(2)}°, Dec: ${event.dec!.toFixed(2)}°)`
    : "(position not reported)";
  const err = formatMeasured(event.errorRadius, 2);
  const snr = formatMeasured(event.snr, 1);
  const far = formatExp(event.far, 2);
  let body = `On ${dateStr} UTC, the ${event.observatory} instrument detected a ${type} (${event.eventType}) named ${event.eventId}. This event was observed at coordinates ${raDec} ${event.errorRadius != null ? `with a localization uncertainty of approximately ${err} arcminutes` : "with no localization uncertainty reported"}.`;
  if (event.eventType === "GRB" && event.fluence != null) {
    body += ` The measured fluence of this burst was ${event.fluence.toExponential(3)} erg/cm², placing it among the detected gamma-ray transients in this observation window. The signal-to-noise ratio of ${snr}σ and false alarm rate of ${far} Hz indicate a statistically significant detection.`;
    body += ` Gamma-ray bursts of this nature are thought to originate from the collapse of massive stars or the merger of compact binary systems, releasing enormous energy on cosmological scales. Follow-up multi-wavelength observations are recommended to constrain the afterglow and host environment.`;
  } else if (event.eventType === "GW") {
    body += ` The gravitational wave signal exhibited a signal-to-noise ratio of ${snr}σ across the detector network. The false alarm rate of ${far} Hz corresponds to a highly significant astrophysical event candidate.`;
    body += ` Gravitational wave detections of this class are consistent with compact binary coalescence, representing a key target for multi-messenger follow-up. Electromagnetic counterpart searches in the localization region are strongly encouraged.`;
  } else if (event.eventType === "FRB" && event.dm != null) {
    body += ` The dispersion measure for this event was calculated to be ${event.dm.toFixed(1)} pc/cm³, which helps in estimating the distance and intergalactic electron content along the line of sight. FRBs are brief but intense bursts of radio waves, and this initial alert provides key insights into their mysterious origins.`;
    body += ` Fast Radio Bursts like this one are important in the field of multi-messenger astronomy as they may hold clues about the extreme conditions in distant galaxies. This particular FRB was detected with a latency of ${formatLatency(event.latencyUs)}, contributing to the growing catalog of these enigmatic astrophysical phenomena.`;
  }
  return body;
}

function TeamDetails() {
  return (
    <div className="rounded border border-border bg-card p-3 mb-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Team details</div>
        <div className="text-[9px] font-mono text-emerald-600 dark:text-emerald-400">Active</div>
      </div>
      <div className="grid grid-cols-2 gap-1.5 text-[10px] font-mono">
        <div className="flex justify-between border-b border-border/50 pb-0.5"><span className="text-muted-foreground">PI</span><span className="text-foreground">active</span></div>
        <div className="flex justify-between border-b border-border/50 pb-0.5"><span className="text-muted-foreground">Co-I</span><span className="text-foreground">active</span></div>
        <div className="flex justify-between border-b border-border/50 pb-0.5"><span className="text-muted-foreground">Observer</span><span className="text-foreground">active</span></div>
        <div className="flex justify-between border-b border-border/50 pb-0.5"><span className="text-muted-foreground">Analyst</span><span className="text-foreground">active</span></div>
      </div>
    </div>
  );
}

function RightPanel({ event }: { event: AstroEvent | null }) {
  if (!event) {
    return <div className="flex-1 flex flex-col items-center justify-center p-6 text-center"><div className="text-muted-foreground text-sm">Select an event from the list to view details</div></div>;
  }
  const summary = generateSummary(event);
  // Aladin/FOV links need a concrete position; fall back to the sky origin
  // ONLY for building the external URL, never for display.
  const ra  = formatMeasured(event.ra, 6);
  const dec = formatMeasured(event.dec, 6);
  const hasPosition = event.ra != null && event.dec != null;
  const raNum  = event.ra ?? 0;
  const decNum = event.dec ?? 0;
  const fov = 2;
  // Sky-atlas links are only meaningful with a real position. When the event
  // has none, they are omitted rather than pointed at (0, 0) — which is a
  // real place on the sky and would send a researcher to the wrong field.
  const externalLinks = [
    {
      name: "GCN", icon: "📡", desc: "Search GCN for this event",
      href: `https://gcn.nasa.gov/circulars?query=${encodeURIComponent(event.eventId)}&startDate=&endDate=`,
    },
    {
      name: "Astro-COLIBRI", icon: "🌐", desc: "Multi-messenger follow-up platform",
      href: `https://astro-colibri.science/sources/${encodeURIComponent(event.eventId)}`,
    },
    ...(hasPosition
      ? [
          {
            name: "ALADIN", icon: "🌌", desc: "Displays event in an interactive sky atlas",
            href: `https://aladin.u-strasbg.fr/AladinLite/?target=${encodeURIComponent(`${raNum} ${decNum}`)}&fov=${fov}&survey=P%2FDSS2%2Fcolor`,
          },
          {
            name: "ESASky", icon: "🔭", desc: "Displays event in an interactive sky atlas",
            href: `https://sky.esa.int/?target=${encodeURIComponent(`${raNum} ${decNum}`)}&hips=DSS2+color&fov=${fov}&cooframe=ICRSd&sci=false`,
          },
          {
            name: "TNS", icon: "🌟", desc: "Transient Name Server (search)",
            href: `https://www.wis-tns.org/search?ra=${raNum}&decl=${decNum}&radius=1&coords_unit=arcsec`,
          },
        ]
      : []),
  ];
  return (
    <div className="flex flex-col h-full">
      <ScrollArea className="flex-1 scrollbar-thin">
        <div className="p-3">
          <TeamDetails />
          <h3 className="text-xs font-semibold text-foreground mb-2 uppercase tracking-wider">Selected source:</h3>
          <p className="text-[11px] text-muted-foreground leading-relaxed font-sans">{summary}</p>
          <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] font-mono">
            <div className="flex justify-between border-b border-border/50 pb-0.5"><span className="text-muted-foreground">Gal. Lon</span><span className="text-foreground">{formatDerived(event.galLon, 2)}</span></div>
            <div className="flex justify-between border-b border-border/50 pb-0.5"><span className="text-muted-foreground">Gal. Lat</span><span className="text-foreground">{formatDerived(event.galLat, 2)}</span></div>
            <div className="flex justify-between border-b border-border/50 pb-0.5"><span className="text-muted-foreground">Sun dist.</span><span className="text-foreground">{formatDerived(event.sunDistance, 1)}</span></div>
            <div className="flex justify-between border-b border-border/50 pb-0.5"><span className="text-muted-foreground">Moon dist.</span><span className="text-foreground">{formatDerived(event.moonDistance, 1)}</span></div>
            <div className="flex justify-between border-b border-border/50 pb-0.5"><span className="text-muted-foreground">FAR</span><span className="text-foreground">{formatExp(event.far, 2, " Hz")}</span></div>
            <div className="flex justify-between border-b border-border/50 pb-0.5"><span className="text-muted-foreground">Err radius</span><span className="text-foreground">{formatMeasured(event.errorRadius, 2, "'")}</span></div>
            {event.fluence != null && (<div className="flex justify-between border-b border-border/50 pb-0.5 col-span-2"><span className="text-muted-foreground">Fluence</span><span className="text-foreground">{event.fluence.toExponential(3)} erg/cm²</span></div>)}
            {event.dm != null && (<div className="flex justify-between border-b border-border/50 pb-0.5 col-span-2"><span className="text-muted-foreground">DM</span><span className="text-foreground">{event.dm.toFixed(1)} pc/cm³</span></div>)}
            <div className="flex justify-between border-b border-border/50 pb-0.5 col-span-2"><span className="text-muted-foreground">Latency</span><span className="text-foreground">{formatLatency(event.latencyUs)}</span></div>
          </div>
        </div>
      </ScrollArea>
      <div className="border-t border-border p-2 shrink-0">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider">External information:</span>
          <div className="flex gap-1">{externalLinks.map((_, i) => <div key={i} className={`w-1.5 h-1.5 rounded-full ${i === 0 ? 'bg-primary' : 'bg-border'}`} />)}</div>
        </div>
        <div className="grid grid-cols-2 gap-1.5">{externalLinks.map(link => (<a key={link.name} href={link.href} target="_blank" rel="noopener noreferrer" className="flex gap-2 p-2 rounded border border-border bg-card hover:border-muted-foreground hover:bg-accent/30 transition-colors cursor-pointer no-underline"><span className="text-base leading-none shrink-0">{link.icon}</span><div><div className="text-[11px] font-semibold text-foreground">{link.name}</div><div className="text-[9px] text-muted-foreground leading-tight">{link.desc}</div></div></a>))}</div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { scienceMode } = useScienceMode();
  const { events: liveEvents, isConnected } = useAstroWebSocket();
  const { data: initialData } = useListEvents({ limit: 300 });
  const [selectedEvent, setSelectedEvent] = useState<AstroEvent | null>(null);
  
  const allEvents = useMemo(() => {
    const map = new Map<string, AstroEvent>();
    
    if (initialData) {
      const eventsList = (initialData as any).events || (Array.isArray(initialData) ? initialData : []);
      if (Array.isArray(eventsList)) {
        eventsList.forEach((e: AstroEvent) => {
          if (e && e.eventId) map.set(e.eventId, e);
        });
      }
    }
    
    if (Array.isArray(liveEvents)) {
      liveEvents.forEach((e: AstroEvent) => {
        if (e && e.eventId) map.set(e.eventId, e);
      });
    }
    
    return Array.from(map.values()).sort((a, b) => {
      const timeA = a.detectionTime ? new Date(a.detectionTime).getTime() : 0;
      const timeB = b.detectionTime ? new Date(b.detectionTime).getTime() : 0;
      return timeB - timeA;
    });
  }, [liveEvents, initialData]);
  
  const liveIds = useMemo(() => new Set(Array.isArray(liveEvents) ? liveEvents.map(e => e.id) : []), [liveEvents]);
  const SIDEBAR_LIMIT = 50;

  // NO LIFECYCLE FILTER — and this must not be reintroduced.
  //
  // This previously kept only {preliminary, confirmed}, on the assumption that
  // INITIAL and UPDATE were separate intermediate rows worth collapsing. They
  // are not: revisions of one burst share a trigger ID and are UPSERTED into a
  // single row whose `lifecycle` column changes as the position is refined.
  //
  // So the filter was not hiding duplicates — it was hiding BURSTS. A Fermi
  // trigger that has received a ground-recalculated position sits at
  // lifecycle="update" and disappeared from the live feed entirely, until a
  // final notice arrived, which may be many minutes later or never. Exactly
  // the events a researcher is watching for were the ones removed.
  //
  // Every event is now listed, and the per-item badge shows which stage it is
  // at. The revision count is on the card, so a refined burst is visibly a
  // revision rather than a new one.
  const sidebarEvents = useMemo(
    () => allEvents.slice(0, SIDEBAR_LIMIT),
    [allEvents],
  );
  React.useEffect(() => {
    if (!selectedEvent && allEvents.length > 0) {
      setSelectedEvent(allEvents[0]);
    }
  }, [allEvents, selectedEvent]);
  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* One header, not three strips. Totals, composition, activity and
          measured coverage in a single instrument, with the per-observatory
          and per-field detail one click away rather than always on screen. */}
      <MissionControlBar events={allEvents} isConnected={isConnected} />
      <div className="flex flex-1 overflow-hidden">
        <div className="w-52 shrink-0 border-r border-border flex flex-col overflow-hidden bg-[hsl(var(--sidebar))]">
          <div className="px-2.5 py-1.5 border-b border-border shrink-0 flex items-center justify-between">
            <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">Live events</span>
            <div className="flex items-center gap-1.5">
              {allEvents.length > SIDEBAR_LIMIT && (<span className="text-[9px] font-mono text-muted-foreground/60" title={`${allEvents.length} total archived in database`}>of {allEvents.length}</span>)}
              <span className="text-[10px] font-mono text-primary">{Math.min(allEvents.length, SIDEBAR_LIMIT)}</span>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto scrollbar-thin">
            {sidebarEvents.map(event => (<SidebarItem key={event.id} event={event} selected={selectedEvent?.id === event.id} isNew={liveIds.has(event.id)} onClick={() => setSelectedEvent(event)} scienceMode={scienceMode} />))}
            {sidebarEvents.length === 0 && (<div className="p-4 text-center text-[11px] text-muted-foreground font-mono">Awaiting signals…</div>)}
            {allEvents.length > SIDEBAR_LIMIT && (<div className="px-3 py-2 text-center text-[9px] text-muted-foreground/50 font-mono border-t border-border">+{allEvents.length - SIDEBAR_LIMIT} archived → Event Archive</div>)}
          </div>
        </div>
        <div className="flex-1 flex flex-col overflow-hidden">
          {selectedEvent && <EventBrief event={selectedEvent} />}
          <div className="flex-1 min-h-0 p-2 bg-[hsl(var(--sidebar))] overflow-hidden">
            <SciencePanel event={selectedEvent} />
          </div>
        </div>
        <div className="w-72 shrink-0 border-l border-border flex flex-col overflow-hidden bg-[hsl(var(--sidebar))]">
          <RightPanel event={selectedEvent} />
        </div>
      </div>
    </div>
  );
}
