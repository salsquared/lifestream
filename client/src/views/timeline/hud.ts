/**
 * HUD arithmetic — implementation P4.6. Pure; the overlay that renders it is
 * `CorridorHud.tsx`.
 *
 * Kept apart from the component for two reasons. It is the half worth proving — the date
 * the HUD prints has to be the date the scale would produce for the camera's x, or the
 * readout quietly lies about where the reader is. And it imports nothing at runtime, so
 * it can be exercised without a DOM.
 */

import type { TimeScale } from '@shared/timeScale';

/** How long before the cutoff the warning starts fading in — P4.6. */
export const CUTOFF_WARNING_MONTHS = 6;

/** Milliseconds in a day, for {@link worldUnitsPerDay}. */
const DAY_MS = 86_400_000;

/**
 * The instant at the camera's x, **inverted through the canonical scale** — the same
 * object every node was positioned with, so the readout and the nodes can never disagree.
 *
 * x is clamped into `scale.range()` first. The viewport is padded past the range (P4.5)
 * so the end nodes are not glued to the screen edge, and that padding is visual slack,
 * not extra time: without the clamp the HUD would extrapolate into dates the corridor
 * does not cover and announce a year past the cutoff as if it were canon.
 */
export function cameraDateIso(scale: TimeScale, x: number): string {
  const [a, b] = scale.range();
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return scale.toDate(x < lo ? lo : x > hi ? hi : x);
}

/**
 * The same instant `months` calendar months earlier, in UTC.
 *
 * Calendar arithmetic, not `months * 30 days`: the warning window is stated in months and
 * a fixed-length approximation would start it on a different day every year. `setUTCMonth`
 * rolls a day-of-month that the shorter target month does not have forward into the next
 * one (31 August minus 6 → 3 March, not 28 February) — irrelevant for the corridor's own
 * cutoff, which lands on the 25th, and documented rather than worked around.
 */
function monthsBefore(ms: number, months: number): number {
  const at = new Date(ms);
  at.setUTCMonth(at.getUTCMonth() - months);
  return at.getTime();
}

/**
 * Opacity of the cutoff warning at a given camera date, in `[0, 1]`.
 *
 * Zero until the camera is within {@link CUTOFF_WARNING_MONTHS} of the corridor's end,
 * then a linear ramp to 1 at the cutoff itself, and 1 beyond it. A ramp rather than a
 * toggle because the marker is a warning that the corpus stops here, not an alarm — it
 * should arrive as the reader approaches the edge, not snap on at a threshold.
 *
 * @param cameraIso The instant under the camera, from {@link cameraDateIso}.
 * @param cutoffIso `CORRIDOR_END` — passed in rather than imported so this stays pure.
 */
export function cutoffOpacity(
  cameraIso: string,
  cutoffIso: string,
  months: number = CUTOFF_WARNING_MONTHS,
): number {
  const cutoff = Date.parse(cutoffIso);
  const at = Date.parse(cameraIso);
  if (!Number.isFinite(cutoff) || !Number.isFinite(at)) return 0;

  const warnFrom = monthsBefore(cutoff, months);
  if (at <= warnFrom) return 0;
  if (at >= cutoff) return 1;
  return (at - warnFrom) / (cutoff - warnFrom);
}

/**
 * World units spanned by one day on the canonical scale.
 *
 * This is the HUD's redraw threshold: the readout is rendered at day precision, so a
 * camera movement smaller than a day cannot change it and does not need to wake React
 * (see `cameraChannel.ts`). Measured off the scale rather than computed from
 * `WORLD_UNITS_PER_YEAR` so it stays right if the slope is ever expressed differently.
 */
export function worldUnitsPerDay(scale: TimeScale): number {
  const [start] = scale.domain();
  const nextDay = new Date(Date.parse(start) + DAY_MS).toISOString();
  return Math.abs(scale.toX(nextDay) - scale.toX(start));
}
