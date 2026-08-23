import { format } from "date-fns";

/** Rendered in place of a DERIVED quantity that could not be computed. */
export const UNKNOWN_LABEL = "—";

/**
 * Format a possibly-null DERIVED scientific quantity.
 *
 * A null value means UNKNOWN: the pipeline could not responsibly derive it.
 * It must never be rendered as 0, 90, or any other stand-in number, so this
 * returns a visually distinct placeholder instead.
 */
export function formatDerived(
  value: number | null | undefined,
  digits: number,
  unit = "°",
): string {
  if (value == null || !Number.isFinite(value)) return UNKNOWN_LABEL;
  return `${value.toFixed(digits)}${unit}`;
}

/**
 * Format a possibly-null OBSERVED source measurement.
 *
 * null means the upstream notice did not report the quantity. It must never
 * render as 0 — a missing SNR is not an SNR of zero, and a missing position
 * is not the coordinate (0, 0).
 */
export function formatMeasured(
  value: number | null | undefined,
  digits: number,
  unit = "",
): string {
  if (value == null || !Number.isFinite(value)) return UNKNOWN_LABEL;
  return `${value.toFixed(digits)}${unit}`;
}

/** Exponential-notation variant of formatMeasured (for FAR, fluence, ...). */
export function formatExp(
  value: number | null | undefined,
  digits: number,
  unit = "",
): string {
  if (value == null || !Number.isFinite(value)) return UNKNOWN_LABEL;
  return `${value.toExponential(digits)}${unit}`;
}

/**
 * Render a false alarm rate as a human-readable recurrence interval.
 *
 * Returns UNKNOWN rather than "1 per Infinity years", which is what the old
 * unguarded `1 / far` produced when FAR was the fabricated 0 — a division-by-
 * zero artifact rendered as though it were a scientific statement.
 */
export function formatFarInterval(far: number | null | undefined): string {
  if (far == null || !Number.isFinite(far) || far <= 0) return UNKNOWN_LABEL;
  const years = 1 / far / (3600 * 24 * 365);
  if (!Number.isFinite(years)) return UNKNOWN_LABEL;
  if (years >= 1000) return `1 per ${years.toExponential(2)} years`;
  if (years >= 1) return `1 per ${years.toFixed(1)} years`;
  return `1 per ${(years * 365).toFixed(1)} days`;
}

export function formatMicrosecondDate(isoString: string) {
  // e.g. "2026-05-03T04:21:59.000084" -> "2026-05-03 04:21:59.000084 UTC"
  try {
    const parts = isoString.split('T');
    if (parts.length !== 2) return isoString;
    const datePart = parts[0];
    const timePart = parts[1].replace('Z', '');
    return `${datePart} ${timePart} UTC`;
  } catch (e) {
    return isoString;
  }
}

/**
 * Format a MEASURED ingestion latency.
 *
 * null means the latency was never measurable — an archive import was not
 * received live, so it has no arrival time. It must never render as "0 μs",
 * which asserts the notice arrived at the instant of detection.
 */
export function formatLatency(
  microseconds: number | string | null | undefined,
): string {
  // latency_us is a bigint: the REST API serialises it as a string
  // ("2500000") while the WebSocket bridge sends a JSON number. Coerce
  // explicitly — a bare Number.isFinite() check rejects the string form.
  if (microseconds == null) return UNKNOWN_LABEL;
  const us = typeof microseconds === "string" ? Number(microseconds) : microseconds;
  if (!Number.isFinite(us)) return UNKNOWN_LABEL;

  if (us < 1_000) return `${us} μs`;
  if (us < 1_000_000) return `${(us / 1_000).toFixed(2)} ms`;
  // Replayed historical events sit hours-to-days behind their detection time;
  // without these tiers they rendered as e.g. "1137543329.00 ms".
  if (us < 60 * 1_000_000) return `${(us / 1_000_000).toFixed(2)} s`;
  if (us < 3600 * 1_000_000) return `${(us / (60 * 1_000_000)).toFixed(1)} min`;
  return `${(us / (3600 * 1_000_000)).toFixed(1)} h`;
}
