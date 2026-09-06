import type { AstroEvent } from "@workspace/api-client-react";
import { formatMicrosecondDate, formatLatency, formatMeasured, formatExp, formatDerived } from "@/lib/formatters";

interface Props { event: AstroEvent; }

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-baseline border-b border-border/40 py-1 gap-2">
      <span className="text-[10px] text-muted-foreground font-mono shrink-0">{label}</span>
      <span className="text-[10px] text-foreground font-mono text-right">{value}</span>
    </div>
  );
}

/** Build real external URLs from the selected event. */
export function buildExternalLinks(event: AstroEvent) {
  const ra  = formatMeasured(event.ra, 6);
  const dec = formatMeasured(event.dec, 6);
  const fov = 2; // degrees – reasonable default for all event types

  return [
    {
      name: "GCN",
      desc: "Search GCN for this event",
      icon: "📡",
      // GCN Viewer search URL – searches circulars by event ID keyword
      href: `https://gcn.nasa.gov/circulars?query=${encodeURIComponent(event.eventId)}&startDate=&endDate=`,
    },
    {
      name: "ALADIN",
      desc: "Displays event in an interactive sky atlas",
      icon: "🌌",
      // Aladin Lite — target= accepts "RA Dec" in degrees
      href: `https://aladin.u-strasbg.fr/AladinLite/?target=${encodeURIComponent(`${ra} ${dec}`)}&fov=${fov}&survey=P%2FDSS2%2Fcolor`,
    },
    {
      name: "ESASky",
      desc: "Displays event in an interactive sky atlas",
      icon: "🔭",
      // ESASky sky view centred on coordinates
      href: `https://sky.esa.int/?target=${encodeURIComponent(`${ra} ${dec}`)}&hips=DSS2+color&fov=${fov}&cooframe=ICRSd&sci=false`,
    },
    {
      name: "TNS",
      desc: "Transient Name Server (search)",
      icon: "🌟",
      // TNS cone search — 1 arcmin radius around the event position
      href: `https://www.wis-tns.org/search?ra=${ra}&decl=${dec}&radius=1&coords_unit=arcsec`,
    },
    {
      name: "Astro-COLIBRI",
      desc: "Multi-messenger follow-up platform",
      icon: "🌐",
      // Astro-COLIBRI source page, keyed by the human-readable event ID
      href: `https://astro-colibri.science/sources/${encodeURIComponent(event.eventId)}`,
    },
  ];
}

export function BasicInfo({ event }: Props) {
  const externalLinks = buildExternalLinks(event);

  return (
    <div className="flex flex-col">
      <div className="p-3 space-y-0.5">
        <Row label="Event ID" value={event.eventId} />
        <Row label="Type" value={event.eventType === "GRB" ? "Gamma-ray burst" : event.eventType === "GW" ? "Gravitational wave" : "Fast radio burst"} />
        <Row label="Date [UTC]" value={formatMicrosecondDate(event.detectionTime).slice(0, 19).replace("T", " ")} />
        <Row label="Observatory" value={event.observatory} />
        <Row label="Instrument" value={`${event.observatory}/${event.eventType}`} />
        <Row label="RA [deg]" value={formatMeasured(event.ra, 4, "°")} />
        <Row label="Dec [deg]" value={formatMeasured(event.dec, 4, "°")} />
        <Row label="Err radius" value={formatMeasured(event.errorRadius, 2, "'")} />
        <Row label="Gal. lon" value={formatDerived(event.galLon, 2)} />
        <Row label="Gal. lat" value={formatDerived(event.galLat, 2)} />
        <Row label="SNR" value={formatMeasured(event.snr, 2, " σ")} />
        <Row label="FAR" value={formatExp(event.far, 3, " Hz")} />
        <Row label="Sun dist." value={formatDerived(event.sunDistance, 1)} />
        <Row label="Moon dist." value={formatDerived(event.moonDistance, 1)} />
        <Row label="Latency" value={formatLatency(event.latencyUs)} />
        {event.fluence != null && <Row label="Fluence" value={event.fluence.toExponential(3) + " erg/cm²"} />}
        {event.dm != null && <Row label="DM" value={event.dm.toFixed(1) + " pc/cm³"} />}
      </div>
      <div className="border-t border-border p-2 shrink-0">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider">External information:</span>
          <div className="flex gap-1">
            {externalLinks.map((_, i) => (
              <div key={i} className={`w-1.5 h-1.5 rounded-full ${i === 0 ? "bg-primary" : "bg-border"}`} />
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {externalLinks.map(link => (
            <a
              key={link.name}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="flex gap-2 p-2 rounded border border-border bg-card hover:border-muted-foreground hover:bg-accent/30 transition-colors cursor-pointer no-underline"
            >
              <span className="text-base leading-none shrink-0">{link.icon}</span>
              <div>
                <div className="text-[11px] font-semibold text-foreground">{link.name}</div>
                <div className="text-[9px] text-muted-foreground leading-tight">{link.desc}</div>
              </div>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
