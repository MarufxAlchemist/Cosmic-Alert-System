/**
 * formatters.ts — Email Template System (Phase 5.3)
 * ---------------------------------------------------
 * Pure scientific value formatters for the email template.
 * No HTML — plain string transformations only.
 *
 * Phase 5.3 — Transient Event Detection
 */

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * Format an ISO-8601 timestamp to a human-readable UTC string.
 * Example: "Wed, 06 Aug 2026 14:32:01 GMT"
 */
export function formatDetectionTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toUTCString();
  } catch {
    return iso;
  }
}

/**
 * Format an ISO-8601 timestamp to compact UTC datetime.
 * Example: "2026-08-06 14:32:01 UTC"
 */
export function formatCompactTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Sky position
// ---------------------------------------------------------------------------

/**
 * Format RA in degrees to HMS notation.
 * Example: 123.456° → "08h 13m 49.4s"
 */
export function formatRA(degrees: number): string {
  const totalSeconds = (degrees / 360) * 86400;
  const h  = Math.floor(totalSeconds / 3600);
  const m  = Math.floor((totalSeconds % 3600) / 60);
  const s  = totalSeconds % 60;
  return `${String(h).padStart(2, "0")}h ${String(m).padStart(2, "0")}m ${s.toFixed(1)}s`;
}

/**
 * Format Dec in degrees to DMS notation.
 * Example: -45.678° → "−45° 40′ 41″"
 */
export function formatDec(degrees: number): string {
  const sign = degrees < 0 ? "−" : "+";
  const abs  = Math.abs(degrees);
  const d    = Math.floor(abs);
  const mRaw = (abs - d) * 60;
  const m    = Math.floor(mRaw);
  const s    = (mRaw - m) * 60;
  return `${sign}${String(d).padStart(2, "0")}° ${String(m).padStart(2, "0")}′ ${s.toFixed(0).padStart(2, "0")}″`;
}

/**
 * Format a sky position as a combined RA/Dec string.
 * Example: "08h 13m 49.4s / −45° 40′ 41″"
 */
export function formatPosition(ra: number, dec: number): string {
  return `${formatRA(ra)} / ${formatDec(dec)}`;
}

/**
 * Format RA and Dec as raw decimal degrees with 4 decimal places.
 */
export function formatPositionDeg(ra: number, dec: number): string {
  const decSign = dec >= 0 ? "+" : "";
  return `RA ${ra.toFixed(4)}°  Dec ${decSign}${dec.toFixed(4)}°`;
}

// ---------------------------------------------------------------------------
// Error / localization
// ---------------------------------------------------------------------------

/**
 * Format error radius in arcmin with unit.
 * Converts to degrees if > 60 arcmin for readability.
 */
export function formatErrorRadius(arcmin: number): string {
  if (arcmin <= 0) return "N/A";
  if (arcmin >= 60) {
    return `${(arcmin / 60).toFixed(2)}° (${arcmin.toFixed(0)} arcmin)`;
  }
  return `${arcmin.toFixed(1)} arcmin`;
}

// ---------------------------------------------------------------------------
// False alarm rate
// ---------------------------------------------------------------------------

/**
 * Format FAR in Hz as a human-readable recurrence rate.
 * Examples:
 *   1e-8 Hz → "~1 per 3.2 years"
 *   1e-4 Hz → "~1 per 2.8 hours"
 *   5e-2 Hz → "2.00×10⁻² Hz"
 */
export function formatFAR(far: number): string {
  if (!far || far <= 0) return "N/A";

  const secsPerEvent = 1 / far;

  if (secsPerEvent >= 3.156e7) {
    const years = secsPerEvent / 3.156e7;
    return `~1 per ${years.toFixed(1)} year${years >= 2 ? "s" : ""}`;
  }
  if (secsPerEvent >= 86400) {
    const days = secsPerEvent / 86400;
    return `~1 per ${days.toFixed(1)} day${days >= 2 ? "s" : ""}`;
  }
  if (secsPerEvent >= 3600) {
    const hours = secsPerEvent / 3600;
    return `~1 per ${hours.toFixed(1)} hour${hours >= 2 ? "s" : ""}`;
  }
  return `${far.toExponential(2)} Hz`;
}

// ---------------------------------------------------------------------------
// Signal quality
// ---------------------------------------------------------------------------

export function formatSNR(snr: number): string {
  if (!snr || snr <= 0) return "N/A";
  return `${snr.toFixed(1)} σ`;
}

// ---------------------------------------------------------------------------
// GW parameters
// ---------------------------------------------------------------------------

export function formatChirpMass(mass: number): string {
  return `${mass.toFixed(2)} M☉`;
}

export function formatDistance(mpc: number): string {
  if (mpc < 1000) return `${mpc.toFixed(0)} Mpc`;
  return `${(mpc / 1000).toFixed(2)} Gpc`;
}

// ---------------------------------------------------------------------------
// FRB parameters
// ---------------------------------------------------------------------------

export function formatDM(dm: number): string {
  return `${dm.toFixed(1)} pc·cm⁻³`;
}

// ---------------------------------------------------------------------------
// GRB parameters
// ---------------------------------------------------------------------------

export function formatFluence(fluence: number): string {
  return `${fluence.toExponential(2)} erg·cm⁻²`;
}

export function formatT90(t90: number): string {
  if (t90 < 0.001) return `${(t90 * 1000).toFixed(1)} ms`;
  if (t90 < 1)     return `${t90.toFixed(3)} s`;
  if (t90 < 100)   return `${t90.toFixed(1)} s`;
  return `${t90.toFixed(0)} s`;
}

// ---------------------------------------------------------------------------
// Latency
// ---------------------------------------------------------------------------

export function formatLatency(us: number | null | undefined): string {
  if (us == null || !Number.isFinite(us) || us <= 0) return "N/A";
  if (us < 1_000)     return `${us.toFixed(0)} μs`;
  if (us < 1_000_000) return `${(us / 1_000).toFixed(1)} ms`;
  return `${(us / 1_000_000).toFixed(2)} s`;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function formatLifecycle(lifecycle: string): string {
  const map: Record<string, string> = {
    preliminary: "Preliminary",
    initial:     "Initial",
    update:      "Update",
    confirmed:   "Confirmed ✓",
  };
  return map[lifecycle?.toLowerCase()] ?? lifecycle;
}
