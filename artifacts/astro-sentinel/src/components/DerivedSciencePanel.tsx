import { useState } from "react";
import {
  Sigma, Globe2, Telescope, Ruler, ChevronRight, AlertCircle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * DerivedSciencePanel
 * ───────────────────
 * Renders quantities Transient Event Detection computed rather than received
 * (spec sections 19-24, 33-34).
 *
 * The panel's job is as much to show what could NOT be derived as what could.
 * A quantity with `value === null` is rendered as UNKNOWN together with the
 * reason and what would be needed — never as a blank cell, a dash, or a zero,
 * any of which reads as "small" rather than "unknown".
 *
 * Every derived number is shown with its method and its assumptions. A
 * luminosity distance without its cosmology is not reproducible, and an E_iso
 * without its band caveat invites comparison against catalogue values that
 * were computed differently.
 */

type Provenance = "OBSERVED" | "DERIVED" | "INFERRED" | "CATALOG" | "UNKNOWN";

interface DerivedQuantity {
  value: number | null;
  unit: string | null;
  provenance: Provenance;
  sigma?: number | null;
  uncertaintyKnown?: boolean;
  method?: string | null;
  assumptions?: string[];
  inputs?: Record<string, unknown>;
  requires?: string[];
  note?: string | null;
}

interface CosmologyStamp {
  name: string;
  H0: number;
  Om0: number;
  flat: boolean;
  reference: string;
  available: boolean;
  reason?: string;
}

interface Observability {
  available: boolean;
  site: { name: string; latDeg: number; lonDeg: number; elevM: number } | null;
  atTime: string | null;
  altitudeDeg: number | null;
  azimuthDeg: number | null;
  airmass: number | null;
  aboveHorizon: boolean | null;
  reason: string | null;
  note: string | null;
}

interface Derived {
  restFrame?: Record<string, DerivedQuantity>;
  cosmological?: { cosmology: CosmologyStamp } & Record<string, DerivedQuantity | CosmologyStamp>;
  localization?: {
    reported?: {
      radiusArcmin: number | null;
      radiusDeg: number | null;
      containment: string | null;
      containmentStated: boolean;
      note?: string | null;
    };
  } & Record<string, unknown>;
  observability?: Observability;
}

const LABELS: Record<string, string> = {
  t90Rest: "Rest-frame T90",
  epeakRest: "Rest-frame Epeak",
  luminosityDistance: "Luminosity distance",
  lookbackTime: "Lookback time",
  eIsoBand: "Isotropic energy (band-limited)",
  area50Deg2: "50% region — equivalent radius",
  area90Deg2: "90% region — equivalent radius",
};

/** Human labels for the containment conventions (see uncertainty.py). */
const CONTAINMENT_LABELS: Record<string, string> = {
  "1SIGMA_1D": "1σ (68.27%, 1-D)",
  "1SIGMA_2D": "1σ radius of a 2-D Gaussian (39.35%)",
  "50_2D": "50% credible region",
  "68_2D": "68.27% containment (2-D)",
  "90_2D": "90% credible region",
  "95_2D": "95% credible region",
};

function fmt(v: number): string {
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e5)) return v.toExponential(3);
  return v.toLocaleString(undefined, { maximumSignificantDigits: 5 });
}

function QuantityRow({ name, q }: { name: string; q: DerivedQuantity }) {
  const [open, setOpen] = useState(false);
  const label = LABELS[name] ?? name;
  const known = q.value !== null && q.value !== undefined;

  return (
    <div className="border-b border-border/40 last:border-0 py-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-start justify-between gap-3 text-left group"
      >
        <span className="text-sm text-muted-foreground shrink-0">{label}</span>
        <span className="flex items-center gap-2 min-w-0">
          {known ? (
            <span className="font-mono text-sm text-foreground text-right">
              {fmt(q.value as number)}
              {q.sigma != null && (
                <span className="text-muted-foreground"> ± {fmt(q.sigma)}</span>
              )}
              {q.unit && <span className="text-muted-foreground ml-1">{q.unit}</span>}
            </span>
          ) : (
            /* Absence is stated in words. A dash would read as "zero-ish". */
            <span className="text-xs uppercase tracking-wider text-amber-500/80 font-medium">
              Unknown
            </span>
          )}
          <ChevronRight
            className={`w-3.5 h-3.5 text-muted-foreground/60 transition-transform ${
              open ? "rotate-90" : ""
            }`}
          />
        </span>
      </button>

      {open && (
        <div className="mt-2 space-y-2 text-xs text-muted-foreground pl-1">
          {known && q.uncertaintyKnown === false && (
            <p className="text-amber-500/80">
              No uncertainty is reported for the inputs, so this value carries no
              error bar. It is a central value, not an exact one.
            </p>
          )}
          {q.method && (
            <p>
              <span className="text-foreground/70">Method: </span>
              <span className="font-mono">{q.method}</span>
            </p>
          )}
          {q.note && <p>{q.note}</p>}
          {!known && q.requires?.length ? (
            <p>
              <span className="text-foreground/70">Requires: </span>
              {q.requires.join(", ")}
            </p>
          ) : null}
          {q.assumptions?.map((a, i) => (
            <p key={i} className="flex gap-1.5">
              <AlertCircle className="w-3 h-3 mt-0.5 shrink-0 text-amber-500/70" />
              <span>{a}</span>
            </p>
          ))}
          {q.inputs && Object.keys(q.inputs).length > 0 && (
            <p className="font-mono">
              <span className="text-foreground/70 font-sans">Inputs: </span>
              {Object.entries(q.inputs)
                .filter(([, v]) => v !== null && v !== undefined)
                .map(([k, v]) => `${k}=${String(v)}`)
                .join("  ")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Section({
  icon, title, children,
}: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <h4 className="text-xs uppercase tracking-wider text-muted-foreground font-medium">
          {title}
        </h4>
      </div>
      {children}
    </div>
  );
}

export function DerivedSciencePanel({ derived }: { derived?: Derived | null }) {
  if (!derived) return null;

  const rest = derived.restFrame ?? {};
  const cosmo = derived.cosmological ?? ({} as Record<string, unknown>);
  const stamp = (cosmo as { cosmology?: CosmologyStamp }).cosmology;
  const loc = derived.localization ?? {};
  const reported = loc.reported;
  const obs = derived.observability;

  const cosmoQuantities = Object.entries(cosmo).filter(
    ([k]) => k !== "cosmology",
  ) as [string, DerivedQuantity][];
  const locQuantities = Object.entries(loc).filter(
    ([k]) => k !== "reported",
  ) as [string, DerivedQuantity][];

  return (
    <Card className="bg-card border-border/50 shadow-none">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Sigma className="w-5 h-5 text-primary" />
          Derived Quantities
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Computed by Transient Event Detection, not reported by the observatory. Each value
          carries the method and assumptions it depends on.
        </p>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* ── Rest frame ─────────────────────────────────────────────────── */}
        {Object.keys(rest).length > 0 && (
          <Section
            icon={<Ruler className="w-3.5 h-3.5 text-muted-foreground" />}
            title="Rest frame"
          >
            {Object.entries(rest).map(([k, q]) => (
              <QuantityRow key={k} name={k} q={q} />
            ))}
          </Section>
        )}

        {/* ── Cosmological ───────────────────────────────────────────────── */}
        {cosmoQuantities.length > 0 && (
          <Section
            icon={<Globe2 className="w-3.5 h-3.5 text-muted-foreground" />}
            title="Cosmological"
          >
            {/* The stamp is shown before the numbers, never as a footnote:
                these values are meaningless without it. */}
            {stamp && (
              <p className="text-xs text-muted-foreground mb-1.5">
                {stamp.available ? (
                  <>
                    Assuming{" "}
                    <span className="text-foreground/80 font-medium">
                      {stamp.name}
                    </span>{" "}
                    — H₀ = {stamp.H0} km/s/Mpc, Ω<sub>m</sub> = {stamp.Om0}
                    {stamp.flat ? ", flat" : ""}.
                  </>
                ) : (
                  <span className="text-amber-500/80">{stamp.reason}</span>
                )}
              </p>
            )}
            {cosmoQuantities.map(([k, q]) => (
              <QuantityRow key={k} name={k} q={q} />
            ))}
          </Section>
        )}

        {/* ── Localization ───────────────────────────────────────────────── */}
        <Section
          icon={<Ruler className="w-3.5 h-3.5 text-muted-foreground" />}
          title="Localization"
        >
          {reported && reported.radiusArcmin != null && (
            <div className="border-b border-border/40 py-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Reported radius</span>
                <span className="font-mono text-foreground">
                  {fmt(reported.radiusArcmin)}′
                  <span className="text-muted-foreground ml-1">
                    ({fmt(reported.radiusDeg ?? 0)}°)
                  </span>
                </span>
              </div>
              <div className="mt-1 text-xs">
                {reported.containmentStated ? (
                  <span className="text-muted-foreground">
                    Contains:{" "}
                    <span className="text-foreground/80">
                      {CONTAINMENT_LABELS[reported.containment ?? ""] ??
                        reported.containment}
                    </span>
                  </span>
                ) : (
                  /* The single most important sentence on this panel. */
                  <span className="text-amber-500/80">{reported.note}</span>
                )}
              </div>
            </div>
          )}
          {locQuantities.map(([k, q]) => (
            <QuantityRow key={k} name={k} q={q} />
          ))}
          {!reported?.radiusArcmin && locQuantities.length === 0 && (
            <p className="text-xs text-muted-foreground py-1">
              No localization uncertainty was reported for this event.
            </p>
          )}
        </Section>

        {/* ── Observability ──────────────────────────────────────────────── */}
        {obs && (
          <Section
            icon={<Telescope className="w-3.5 h-3.5 text-muted-foreground" />}
            title="Observability"
          >
            {obs.available ? (
              <div className="text-sm space-y-1 py-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Site</span>
                  <span className="font-mono text-foreground">
                    {obs.site?.name}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Altitude</span>
                  <span className="font-mono text-foreground">
                    {fmt(obs.altitudeDeg ?? 0)}°
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Azimuth</span>
                  <span className="font-mono text-foreground">
                    {fmt(obs.azimuthDeg ?? 0)}°
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Airmass</span>
                  <span className="font-mono text-foreground">
                    {obs.airmass != null ? fmt(obs.airmass) : "below horizon"}
                  </span>
                </div>
                {obs.note && (
                  <p className="text-xs text-muted-foreground pt-1">{obs.note}</p>
                )}
              </div>
            ) : (
              /* No site configured is a configuration fact, stated plainly,
                 rather than an altitude computed from an invented location. */
              <p className="text-xs text-amber-500/80 py-1">{obs.reason}</p>
            )}
          </Section>
        )}
      </CardContent>
    </Card>
  );
}
