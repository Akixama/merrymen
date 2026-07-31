/**
 * Equity-curve geometry, separated from the SVG so it can be tested.
 *
 * The failure modes here are all silent — a divide-by-zero puts every point at
 * NaN and React Native draws nothing, which looks exactly like "no data" rather
 * than "we broke the maths". A flat balance is a completely ordinary state for an
 * agent that hasn't traded today, so it has to render as a flat line, not a blank
 * card.
 */

export interface AreaGeometry {
  /** SVG path for the stroked line. */
  line: string;
  /** SVG path for the filled region, closed to the baseline. */
  area: string;
  /** y of the starting value — the "above water" reference. */
  base: number;
  /** Whether the series ends at or above where it began. */
  up: boolean;
}

export function areaGeometry(
  series: readonly number[],
  width: number,
  height: number,
  pad = 6,
): AreaGeometry | null {
  // One point is not a curve. Returning null lets the caller reserve the space
  // rather than draw a degenerate shape.
  if (series.length < 2 || width <= 0 || height <= pad * 2) return null;

  const first = series[0];
  const last = series[series.length - 1];
  const up = last >= first;

  // The baseline participates in the range even if the curve never returns to
  // it, or a series that only fell would clip its own reference line.
  const min = Math.min(...series, first);
  const max = Math.max(...series, first);

  // A flat series has zero range. Fall back to a fraction of the value so it
  // renders as a line through the middle; the final `|| 1` covers a series that
  // is flat AT zero, where even the proportional fallback is 0.
  const span = max - min || Math.abs(first) * 0.01 || 1;

  const h = height - pad * 2;
  const y = (v: number) => pad + (1 - (v - min) / span) * h;
  const x = (i: number) => (i / (series.length - 1)) * width;

  let line = "";
  for (let i = 0; i < series.length; i++) {
    line += `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(series[i]).toFixed(1)}`;
  }

  const base = y(first);
  // Closed to the BASELINE rather than the bottom edge, so the shaded area means
  // "distance from where you started" instead of "distance from zero".
  const area = `${line}L${width.toFixed(1)} ${base.toFixed(1)}L0 ${base.toFixed(1)}Z`;

  return { line, area, base, up };
}
