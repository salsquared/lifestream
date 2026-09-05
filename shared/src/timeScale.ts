/**
 * THE canonical time scale — architecture §5.2 (normative), implementation P4.2.1.
 *
 * ## There is exactly one scale
 *
 * The event stratum's `d3.scaleTime` is canonical, and every piece of cross-view or
 * cross-jump math goes through this object: camera fly-to targets (P8), viewport
 * clamping (P4.5), the HUD's date readout (P4.6) and the Tech Tree's X axis (P13).
 * Nothing re-derives it, and no view invents a scale of its own — that is what makes
 * "the Tech Tree shares the Corridor's scale" a fact rather than an aspiration.
 *
 * **P7's parallax multiplier does not live here.** The Corridor's other strata draw at
 * `x_drawn = toX(when) * k(z)`, evaluated in the render pass. `k` is never written back
 * into layout data, no camera target and no cross-view calculation ever sees `x_drawn`,
 * and this module must not learn about it (implementation P7.6). A stratum that stored
 * its own x would desynchronise the two views the first time the parallax curve changed.
 *
 * ## What is fixed and what is derived
 *
 * The map is a straight line in time with a **constant slope**: `WORLD_UNITS_PER_YEAR`
 * world units per mean Gregorian year, always. Only the *origin* depends on the
 * argument — `createTimeScale(earliest)` puts `earliest` at x = 0. Two consequences
 * worth stating, because both are load-bearing:
 *
 *   - Moving {@link CORRIDOR_END} does **not** rescale the world. If the range were a
 *     fixed world length instead, extending the corridor would compress every existing
 *     node and silently invalidate every shared URL and saved camera pose.
 *   - Seeding an *earlier* event translates the world rather than stretching it. Node
 *     spacing — which is what the reader actually perceives — is invariant.
 *
 * ## Precision
 *
 * Instants are the canonical `YYYY-MM-DDTHH:MM:SS.mmmZ` spelling the schema enforces
 * with a `GLOB` CHECK (§2.1), and they are parsed straight to epoch milliseconds. They
 * are never round-tripped through a looser `Date` spelling, where `2084-04-25T23:59:00Z`
 * and `2084-04-25T23:59:00.000Z` would be two encodings of one instant that compare
 * unequal as TEXT.
 *
 * `toDate(toX(t))` returns `t` byte-for-byte across the whole corridor. That costs one
 * deliberate departure from d3: the inversion is done algebraically rather than through
 * `scale.invert`, which loses up to a millisecond on epoch-scale numbers. The reason is
 * spelled out at {@link TimeScale.toDate}'s implementation and measured in
 * `tests/timeScale.test.ts`.
 *
 * No `node:*` and no DOM — the shared workspace is isomorphic by construction
 * (`shared/tsconfig.json` sets `"types": []`).
 */

import { scaleTime } from 'd3-scale';
import type { ScaleTime } from 'd3-scale';

import type { IsoInstant } from './types/enums.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The Bible's last dated bullet, and therefore the upper bound of the corridor.
 *
 * `23:59` rather than midnight for the same reason `precisionToInterval` closes a day
 * window there (`rollDate.ts`): 00:00 reads as the boundary of the *next* day, and an
 * end bound that lands on it would put the cutoff marker one day late.
 */
export const CORRIDOR_END: IsoInstant = '2084-04-25T23:59:00.000Z';

/**
 * World units per year — the scale's slope, and the one number that decides how dense
 * the Corridor feels.
 *
 * At 10 units/year the full 2021 → 2084 corridor is ~633 units long and two events a
 * month apart sit ~0.8 units from each other, which is roughly one node diameter. Events
 * closer together than that are separated on **y**, by the deterministic category-band
 * offset of P4.2.3 — never by nudging x, which would decouple a node's position from its
 * date and break the HUD's inversion.
 */
export const WORLD_UNITS_PER_YEAR = 10;

/**
 * Milliseconds in the mean Gregorian year (365.2425 days).
 *
 * A *mean* year, not a calendar one: the slope has to be a constant, or a leap year
 * would be 0.03 units wider than its neighbours and the scale would stop being linear in
 * time. Nothing here is a calendar computation — `formatWhen.ts` owns those.
 */
const MS_PER_YEAR = 365.2425 * 86_400_000;

/**
 * The canonical instant spelling, exactly: `YYYY-MM-DDTHH:MM:SS.mmmZ`.
 *
 * Deliberately stricter than the reader in `rollDate.ts`, which also accepts the bare
 * dates an *author* types. Every string reaching this module comes out of a database
 * column whose CHECK already pins this shape, so anything looser is a bug upstream and
 * is worth failing on rather than absorbing.
 */
const CANONICAL_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a canonical instant to epoch milliseconds, strictly.
 *
 * Two failures this catches that `Date.parse` alone does not, both silent:
 *
 *   - An unrecognised string falls back to an implementation-defined parser. V8 reads
 *     `"sometime in 2036"` as 2036-01-01 **in the local timezone** — a plausible instant,
 *     machine-dependent, no error. Here it would put a node in the wrong place on one
 *     developer's machine and nowhere else.
 *   - Impossible calendar dates roll over instead of being rejected:
 *     `Date.parse('2035-02-30')` is 2035-03-02.
 *
 * A `NaN` from either would propagate into a node's `position`, and a mesh at `NaN` does
 * not throw — it simply is not drawn.
 */
function parseCanonical(value: string, label: string): number {
  const parts = CANONICAL_INSTANT.exec(value);
  if (!parts) {
    throw new RangeError(
      `createTimeScale: ${label} is not a canonical instant ` +
        `(YYYY-MM-DDTHH:MM:SS.mmmZ): ${JSON.stringify(value)}`,
    );
  }

  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new RangeError(`createTimeScale: ${label} is not a real instant: ${value}`);
  }

  // Round-trip the calendar components, catching the rollover `Date.parse` performs
  // silently. Safe to compare in UTC because the pattern admits no other offset.
  const at = new Date(ms);
  const [, year = '', month = '', day = ''] = parts;
  if (
    at.getUTCFullYear() !== Number(year) ||
    at.getUTCMonth() + 1 !== Number(month) ||
    at.getUTCDate() !== Number(day)
  ) {
    throw new RangeError(`createTimeScale: ${label} is not a real calendar date: ${value}`);
  }

  return ms;
}

// ---------------------------------------------------------------------------
// The scale
// ---------------------------------------------------------------------------

/**
 * The canonical date ⇄ world-x map. One instance per save, built from the save's
 * earliest event; see {@link createTimeScale}.
 */
export interface TimeScale {
  /**
   * Date → world x. The date is a canonical instant — normally `event.when`, the
   * persisted roll, so a reload does not move anything (P4.2.2).
   *
   * Extrapolates outside the domain rather than clamping: an event that predates the one
   * the scale was built from gets a negative x, which is visibly wrong, where a clamp
   * would stack it invisibly on the corridor's first node.
   *
   * @throws RangeError if `whenIso` is not a canonical instant.
   */
  toX(whenIso: IsoInstant): number;

  /**
   * World x → the instant at that position, as a canonical ISO string. This is the
   * inversion the HUD reads the camera's current date through (P4.6).
   *
   * @throws RangeError if `x` is not finite, or lands outside the range JavaScript can
   *         represent as a `Date`.
   */
  toDate(x: number): IsoInstant;

  /** `[x(domainStart), x(domainEnd)]` — what P4.5 pads and clamps the viewport against. */
  range(): readonly [number, number];

  /** `[earliest, CORRIDOR_END]`, both in the canonical spelling. */
  domain(): readonly [IsoInstant, IsoInstant];
}

/**
 * Build the canonical scale for a save.
 *
 * @param earliest The earliest instant the corridor must cover — in practice
 *                 `min(event.when)` across the save's events. `min(event.when_min)` is
 *                 equally valid and slightly roomier; either way the caller picks it
 *                 once and every view shares the result.
 *
 * @throws RangeError if `earliest` is not a canonical instant, or is not strictly before
 *         {@link CORRIDOR_END} — a zero-width or reversed domain has no invertible map,
 *         and `d3` would hand back `NaN` from `invert` rather than complaining.
 */
export function createTimeScale(earliest: IsoInstant): TimeScale {
  const startMs = parseCanonical(earliest, 'earliest');
  const endMs = parseCanonical(CORRIDOR_END, 'CORRIDOR_END');

  if (startMs >= endMs) {
    throw new RangeError(
      `createTimeScale: earliest (${earliest}) is not before CORRIDOR_END (${CORRIDOR_END})`,
    );
  }

  // The range is DERIVED from the domain at a fixed units-per-year, which is what keeps
  // the slope constant — see the module header. `scaleTime` is then a pure linear map;
  // note that if a later phase wants `ticks()` or `nice()` for the Tech Tree's axis it
  // must switch to `scaleUtc`, because `scaleTime` places ticks in LOCAL time and this
  // system has exactly one timezone (§2.1).
  const spanX = ((endMs - startMs) / MS_PER_YEAR) * WORLD_UNITS_PER_YEAR;

  const scale: ScaleTime<number, number> = scaleTime()
    .domain([new Date(startMs), new Date(endMs)])
    .range([0, spanX]);

  const domain: readonly [IsoInstant, IsoInstant] = Object.freeze([
    new Date(startMs).toISOString(),
    new Date(endMs).toISOString(),
  ] as [IsoInstant, IsoInstant]);

  const range: readonly [number, number] = Object.freeze([0, spanX] as [number, number]);

  return {
    toX(whenIso: IsoInstant): number {
      return scale(new Date(parseCanonical(whenIso, 'whenIso')));
    },

    toDate(x: number): IsoInstant {
      if (!Number.isFinite(x)) {
        throw new RangeError(`TimeScale.toDate: x is not finite: ${String(x)}`);
      }
      // NOT `scale.invert(x)` — MEASURED, not assumed. d3's continuous scales invert
      // through `interpolateNumber`, i.e. `t0 * (1 - u) + t1 * u`, and with epoch
      // milliseconds either side of 2e12 the two products cancel badly enough to lose
      // the low bit: over a 500 000-instant sweep of this corridor `invert` comes back
      // up to **1 ms** off, and rounding cannot recover a millisecond that is already
      // gone. The algebraic inverse below — `t0 + u * (t1 - t0)`, the same map read
      // backwards — is exact over that same sweep, which is what makes the HUD's
      // readout and a fly-to target land on the instant they were computed from.
      //
      // It is the true inverse of `toX` and not merely a lookalike, because the range
      // starts at 0: d3's forward is then `spanX * ((t - t0) / (t1 - t0))` with no
      // interpolation term at all. `tests/timeScale.test.ts` asserts the round trip at
      // 0 ms rather than trusting that reasoning.
      const ms = Math.round(startMs + (x / spanX) * (endMs - startMs));
      if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) {
        throw new RangeError(`TimeScale.toDate: x maps outside representable time: ${x}`);
      }
      return new Date(ms).toISOString();
    },

    range: () => range,

    domain: () => domain,
  };
}
