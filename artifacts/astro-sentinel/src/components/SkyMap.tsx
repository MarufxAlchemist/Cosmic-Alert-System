import { useEffect, useId, useRef, useState } from 'react';
import type { AstroEvent } from '@workspace/api-client-react';
import { useTheme } from '@/lib/ThemeContext';

interface SkyMapProps {
  events: AstroEvent[];
  selectedEvent?: AstroEvent | null;
  onSelectEvent?: (event: AstroEvent) => void;
}

function aitoff(lonDeg: number, latDeg: number): [number, number] {
  const lon = (lonDeg * Math.PI) / 180;
  const lat = (latDeg * Math.PI) / 180;
  const cosLat = Math.cos(lat);
  const sinLat = Math.sin(lat);
  const cosLon2 = Math.cos(lon / 2);
  const sinLon2 = Math.sin(lon / 2);
  const alpha = Math.acos(Math.max(-1, Math.min(1, cosLat * cosLon2)));
  const sincAlpha = Math.abs(alpha) < 1e-9 ? 1 : Math.sin(alpha) / alpha;
  const x = (2 * cosLat * sinLon2) / sincAlpha;
  const y = sinLat / sincAlpha;
  return [x, y];
}

function toSvg(ax: number, ay: number, W: number, H: number): [number, number] {
  const px = ((ax / 2 + 1) / 2) * W;
  const py = ((1 - ay) / 2) * H;
  return [px, py];
}

function getEventColor(type: string, isDark: boolean): string {
  if (isDark) {
    switch (type) {
      case 'GRB': return '#f59e0b';
      case 'GW':  return '#34d399';
      case 'FRB': return '#fbbf24';
      default:    return '#60a5fa';
    }
  } else {
    switch (type) {
      case 'GRB': return '#ea580c'; // vivid orange-600
      case 'GW':  return '#16a34a'; // vivid green-600
      case 'FRB': return '#ca8a04'; // vivid yellow-600
      default:    return '#0284c7'; // sky-600
    }
  }
}

export function SkyMap({ events, selectedEvent, onSelectEvent }: SkyMapProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { isDark } = useTheme();

  // The clip path and glow filter are referenced by id. Two maps on one page
  // sharing those ids would both resolve to the first one's ellipse, clipping
  // the second map to the wrong shape, so each instance gets its own.
  // (useId can contain ':', which is legal in an id but awkward in a url(#...)
  // reference, so it is stripped.)
  const uid = useId().replace(/:/g, '');

  /**
   * The container's measured size, kept in state purely so that a resize
   * re-runs the drawing effect below.
   *
   * The map is drawn imperatively into a cleared <svg>, so nothing redraws it
   * on its own. Callers that change the box around it — the event page grows
   * the card when the map is enlarged — would otherwise leave the sky at the
   * size it happened to be measured at on mount, marooned inside a big empty
   * card.
   */
  const [box, setBox] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      // Same size means same drawing — bail before touching state, so an
      // observer callback can never feed itself a render loop.
      setBox((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const svg = svgRef.current;
    const container = containerRef.current;
    if (!svg || !container) return;

    const CW = container.clientWidth || 600;
    const CH = container.clientHeight || 340;

    // Aitoff is a 2:1 projection. Fit that shape inside whatever box the card
    // gives us and centre it, rather than stretching the sky to the card's own
    // aspect ratio. A stretched graticule misstates the shape of the sky: the
    // apparent separation between two plotted events stops matching their real
    // angular separation, which is the one thing a localization map is for.
    const W = Math.min(CW, CH * 2);
    const H = W / 2;
    const ox = (CW - W) / 2;
    const oy = (CH - H) / 2;

    svg.setAttribute('viewBox', `0 0 ${CW} ${CH}`);
    svg.setAttribute('width', String(CW));
    svg.setAttribute('height', String(CH));

    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const ns = 'http://www.w3.org/2000/svg';

    // Everything below is drawn in projection coordinates (0..W, 0..H) and
    // shifted into place once by this group, so the geometry maths stays as it
    // was and only the framing changed.
    const root = document.createElementNS(ns, 'g');
    root.setAttribute('transform', `translate(${ox}, ${oy})`);

    // Theme-aware colours
    const colors = isDark ? {
      bg:       'hsl(220 55% 6%)',
      grid:     'hsl(220 40% 22%)',
      galactic: 'hsl(48 80% 35%)',
      ecliptic: 'hsl(200 80% 55%)',
      labels:   'hsl(215 20% 50%)',
      border:   'hsl(220 35% 22%)',
      legend:   'hsl(215 20% 60%)',
    } : {
      bg:       'hsl(38 40% 88%)',   // warm parchment
      grid:     'hsl(36 25% 68%)',   // tan grid lines
      galactic: 'hsl(32 65% 44%)',   // warm amber dashes
      ecliptic: 'hsl(196 55% 42%)',  // muted teal arc
      labels:   'hsl(30 25% 46%)',   // toasted brown labels
      border:   'hsl(36 28% 62%)',   // tan border
      legend:   'hsl(30 22% 40%)',   // warm brown legend
    };

    // Defs
    const defs = document.createElementNS(ns, 'defs');
    const clipId = `sky-clip-${uid}`;
    const glowId = `glow-${uid}`;
    const clip = document.createElementNS(ns, 'clipPath');
    clip.setAttribute('id', clipId);
    const clipEllipse = document.createElementNS(ns, 'ellipse');
    clipEllipse.setAttribute('cx', String(W / 2));
    clipEllipse.setAttribute('cy', String(H / 2));
    clipEllipse.setAttribute('rx', String(W / 2 - 2));
    clipEllipse.setAttribute('ry', String(H / 2 - 2));
    clip.appendChild(clipEllipse);
    defs.appendChild(clip);

    const filter = document.createElementNS(ns, 'filter');
    filter.setAttribute('id', glowId);
    filter.setAttribute('x', '-50%'); filter.setAttribute('y', '-50%');
    filter.setAttribute('width', '200%'); filter.setAttribute('height', '200%');
    const feBlur = document.createElementNS(ns, 'feGaussianBlur');
    feBlur.setAttribute('stdDeviation', isDark ? '2.5' : '1.5');
    feBlur.setAttribute('result', 'blur');
    const feMerge = document.createElementNS(ns, 'feMerge');
    const m1 = document.createElementNS(ns, 'feMergeNode'); m1.setAttribute('in', 'blur');
    const m2 = document.createElementNS(ns, 'feMergeNode'); m2.setAttribute('in', 'SourceGraphic');
    feMerge.appendChild(m1); feMerge.appendChild(m2);
    filter.appendChild(feBlur); filter.appendChild(feMerge);
    defs.appendChild(filter);
    svg.appendChild(defs);
    svg.appendChild(root);

    // Sky group (clipped)
    const skyGroup = document.createElementNS(ns, 'g');
    skyGroup.setAttribute('clip-path', `url(#${clipId})`);

    // Background ellipse
    const bg = document.createElementNS(ns, 'ellipse');
    bg.setAttribute('cx', String(W / 2)); bg.setAttribute('cy', String(H / 2));
    bg.setAttribute('rx', String(W / 2 - 2)); bg.setAttribute('ry', String(H / 2 - 2));
    bg.setAttribute('fill', colors.bg);
    skyGroup.appendChild(bg);

    // Graticule grid
    const gridGroup = document.createElementNS(ns, 'g');
    gridGroup.setAttribute('stroke', colors.grid);
    gridGroup.setAttribute('stroke-width', '0.5');
    gridGroup.setAttribute('fill', 'none');
    for (let lon = -180; lon <= 180; lon += 30) {
      const pts: string[] = [];
      for (let lat = -90; lat <= 90; lat += 2) {
        const [ax, ay] = aitoff(lon, lat);
        const [px, py] = toSvg(ax, ay, W, H);
        pts.push(`${px.toFixed(1)},${py.toFixed(1)}`);
      }
      const line = document.createElementNS(ns, 'polyline');
      line.setAttribute('points', pts.join(' '));
      gridGroup.appendChild(line);
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const pts: string[] = [];
      for (let lon = -180; lon <= 180; lon += 2) {
        const [ax, ay] = aitoff(lon, lat);
        const [px, py] = toSvg(ax, ay, W, H);
        pts.push(`${px.toFixed(1)},${py.toFixed(1)}`);
      }
      const line = document.createElementNS(ns, 'polyline');
      line.setAttribute('points', pts.join(' '));
      gridGroup.appendChild(line);
    }
    skyGroup.appendChild(gridGroup);

    // Galactic plane
    const galPts: string[] = [];
    for (let l = 0; l <= 360; l += 2) {
      const lRad = (l * Math.PI) / 180;
      const raNGP = (192.85948 * Math.PI) / 180;
      const decNGP = (27.12825 * Math.PI) / 180;
      const lNCP = (122.93192 * Math.PI) / 180;
      const ra = raNGP + Math.atan2(Math.cos(lRad - lNCP), Math.sin(lRad - lNCP) * Math.sin(decNGP));
      const dec = Math.asin(Math.cos(lRad - lNCP) * Math.cos(decNGP));
      let lonDeg = (ra * 180) / Math.PI;
      if (lonDeg > 180) lonDeg -= 360;
      const [ax, ay] = aitoff(lonDeg, (dec * 180) / Math.PI);
      const [px, py] = toSvg(ax, ay, W, H);
      galPts.push(`${px.toFixed(1)},${py.toFixed(1)}`);
    }
    const galLine = document.createElementNS(ns, 'polyline');
    galLine.setAttribute('points', galPts.join(' '));
    galLine.setAttribute('stroke', colors.galactic);
    galLine.setAttribute('stroke-width', '1.5');
    galLine.setAttribute('fill', 'none');
    galLine.setAttribute('opacity', isDark ? '0.5' : '0.7');
    galLine.setAttribute('stroke-dasharray', '4 3');
    skyGroup.appendChild(galLine);

    // Ecliptic
    const eclPts: string[] = [];
    const eps = 23.439 * Math.PI / 180;
    for (let l = 0; l <= 360; l += 2) {
      const lRad = (l * Math.PI) / 180;
      const ra = Math.atan2(Math.sin(lRad) * Math.cos(eps), Math.cos(lRad));
      const dec = Math.asin(Math.sin(lRad) * Math.sin(eps));
      let lonDeg = (ra * 180) / Math.PI;
      if (lonDeg > 180) lonDeg -= 360;
      const [ax, ay] = aitoff(lonDeg, (dec * 180) / Math.PI);
      const [px, py] = toSvg(ax, ay, W, H);
      eclPts.push(`${px.toFixed(1)},${py.toFixed(1)}`);
    }
    const eclLine = document.createElementNS(ns, 'polyline');
    eclLine.setAttribute('points', eclPts.join(' '));
    eclLine.setAttribute('stroke', colors.ecliptic);
    eclLine.setAttribute('stroke-width', '1.5');
    eclLine.setAttribute('fill', 'none');
    eclLine.setAttribute('opacity', isDark ? '0.6' : '0.7');
    skyGroup.appendChild(eclLine);

    // RA/Dec labels
    const labelGroup = document.createElementNS(ns, 'g');
    labelGroup.setAttribute('font-family', 'JetBrains Mono, monospace');
    labelGroup.setAttribute('font-size', String(Math.max(9, W * 0.015)));
    labelGroup.setAttribute('fill', colors.labels);
    labelGroup.setAttribute('text-anchor', 'middle');
    for (let lon = -150; lon <= 180; lon += 30) {
      const [ax, ay] = aitoff(lon, 0);
      const [px, py] = toSvg(ax, ay, W, H);
      const label = document.createElementNS(ns, 'text');
      label.textContent = `${lon < 0 ? lon + 360 : lon}°`;
      label.setAttribute('x', String(px));
      label.setAttribute('y', String(py + 12));
      labelGroup.appendChild(label);
    }
    for (const lat of [-60, -30, 30, 60]) {
      const [ax, ay] = aitoff(0, lat);
      const [px, py] = toSvg(ax, ay, W, H);
      const label = document.createElementNS(ns, 'text');
      label.textContent = `${lat > 0 ? '+' : ''}${lat}°`;
      label.setAttribute('x', String(px - 4));
      label.setAttribute('y', String(py + 3));
      labelGroup.appendChild(label);
    }
    skyGroup.appendChild(labelGroup);

    // Events
    const eventGroup = document.createElementNS(ns, 'g');
    events.forEach(event => {
      // An event with no reported position cannot be plotted. Skipping is the
      // honest behaviour — a null coordinate would coerce to 0 and draw the
      // event at (0, 0), which is a real place on the sky.
      if (event.ra == null || event.dec == null) return;
      const lon = event.ra > 180 ? event.ra - 360 : event.ra;
      const lat = event.dec;
      if (lat < -90 || lat > 90) return;
      const [ax, ay] = aitoff(lon, lat);
      const [px, py] = toSvg(ax, ay, W, H);
      const color = getEventColor(event.eventType, isDark);
      const isSelected = selectedEvent?.id === event.id;

      const g = document.createElementNS(ns, 'g');
      g.setAttribute('data-id', event.id);
      g.style.cursor = 'pointer';

      if (isSelected) {
        const ring = document.createElementNS(ns, 'circle');
        ring.setAttribute('cx', String(px)); ring.setAttribute('cy', String(py));
        ring.setAttribute('r', '12');
        ring.setAttribute('fill', 'none');
        ring.setAttribute('stroke', color);
        ring.setAttribute('stroke-width', '1.5');
        ring.setAttribute('opacity', '0.5');
        g.appendChild(ring);
        const ring2 = document.createElementNS(ns, 'circle');
        ring2.setAttribute('cx', String(px)); ring2.setAttribute('cy', String(py));
        ring2.setAttribute('r', '7');
        ring2.setAttribute('fill', 'none');
        ring2.setAttribute('stroke', color);
        ring2.setAttribute('stroke-width', '2');
        ring2.setAttribute('opacity', '0.9');
        g.appendChild(ring2);
      }

      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('cx', String(px)); dot.setAttribute('cy', String(py));
      dot.setAttribute('r', isSelected ? '5' : '3.5');
      dot.setAttribute('fill', color);
      dot.setAttribute('opacity', isSelected ? '1' : '0.85');
      dot.setAttribute('filter', `url(#${glowId})`);
      g.appendChild(dot);

      const title = document.createElementNS(ns, 'title');
      title.textContent = `${event.eventId} (${event.eventType})\nRA: ${event.ra.toFixed(2)}°  Dec: ${event.dec.toFixed(2)}°\n${event.observatory}`;
      g.appendChild(title);

      g.addEventListener('click', () => onSelectEvent?.(event));
      eventGroup.appendChild(g);
    });
    skyGroup.appendChild(eventGroup);
    root.appendChild(skyGroup);

    // Oval border
    const border = document.createElementNS(ns, 'ellipse');
    border.setAttribute('cx', String(W / 2)); border.setAttribute('cy', String(H / 2));
    border.setAttribute('rx', String(W / 2 - 2)); border.setAttribute('ry', String(H / 2 - 2));
    border.setAttribute('fill', 'none');
    border.setAttribute('stroke', colors.border);
    border.setAttribute('stroke-width', '1.5');
    root.appendChild(border);

    // Legend
    const legendY = H - 16;
    const legendItems = isDark
      ? [
          { type: 'GRB', color: '#f59e0b', x: W * 0.25 },
          { type: 'GW',  color: '#34d399', x: W * 0.45 },
          { type: 'FRB', color: '#fbbf24', x: W * 0.65 },
        ]
      : [
          { type: 'GRB', color: '#c2410c', x: W * 0.25 },
          { type: 'GW',  color: '#166534', x: W * 0.45 },
          { type: 'FRB', color: '#92400e', x: W * 0.65 },
        ];
    legendItems.forEach(({ type, color, x }) => {
      const lg = document.createElementNS(ns, 'g');
      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('cx', String(x)); dot.setAttribute('cy', String(legendY));
      dot.setAttribute('r', '4'); dot.setAttribute('fill', color);
      lg.appendChild(dot);
      const lbl = document.createElementNS(ns, 'text');
      lbl.textContent = type;
      lbl.setAttribute('x', String(x + 8)); lbl.setAttribute('y', String(legendY + 4));
      lbl.setAttribute('font-family', 'JetBrains Mono, monospace');
      lbl.setAttribute('font-size', '10');
      lbl.setAttribute('fill', colors.legend);
      lg.appendChild(lbl);
      root.appendChild(lg);
    });

  }, [events, selectedEvent, onSelectEvent, isDark, box, uid]);

  return (
    <div ref={containerRef} className="w-full h-full">
      <svg ref={svgRef} className="w-full h-full" />
    </div>
  );
}
