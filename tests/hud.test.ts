import { describe, expect, it } from 'vitest';

import {
  CUTOFF_WARNING_MONTHS,
  cameraDateIso,
  cutoffOpacity,
  worldUnitsPerDay,
} from '@client/views/timeline/hud';
import { PAN_PAD, panBounds } from '@client/views/timeline/pan';
import {
  CORRIDOR_END,
  CORRIDOR_START,
  TIME_SCALE,
  WORLD_UNITS_PER_YEAR,
  createTimeScale,
} from '@shared/timeScale';

import type { TimeScale } from '@shared/timeScale';

/**
 * P4.6 — the HUD's arithmetic (D7 of the P4 review fix contract).
 *
 * ── WHY THIS SPEC EXISTS ─────────────────────────────────────────────────────────────
 * `hud.ts` says it is "the half worth proving — the date the HUD prints has to be the
 * date the scale would produce for the camera's x, or the readout quietly lies about
 * where the reader is", and that it "imports nothing at runtime, so it can be exercised
 * without a DOM". It had no spec. Every failure mode here is a *plausible date*, which
 * is the worst kind: nothing throws, nothing looks broken, the corridor simply reports
 * the reader is somewhere they are not.
 *
 * The three things asserted, and the specific lie each one prevents:
 *
 *   1. **The readout never leaves the corridor.** `panBounds` deliberately lets the
 *      camera travel {@link PAN_PAD} — eighteen months — past the last instant, so the
 *      final node is not glued to the screen edge. That padding is visual slack, not
 *      extra time. Without the clamp in `cameraDateIso` the HUD extrapolates into it and
 *      announces a year past the cutoff as though the corpus covered it. The sharp
 *      assertion is therefore not "it clamps" but "at the exact x the pan clamp allows,
 *      it still says {@link CORRIDOR_END}" — the two modules are checked against each
 *      other, which is the only way this can be caught.
 *   2. **The cutoff warning ramps on calendar months.** A `months × 30 days`
 *      approximation would start the fade on a different day every year, and the drift
 *      is far too small to notice by eye.
 *   3. **`worldUnitsPerDay` really is one day.** It is the epsilon `cameraChannel` gates
 *      re-renders on. Too large and the readout freezes while the camera moves; too
 *      small and the HUD re-renders every frame, which is the whole reason the channel
 *      exists.
 */

/** One day of corridor, derived independently of the module under test. */
const EXPECTED_UNITS_PER_DAY = WORLD_UNITS_PER_YEAR / 365.2425;

/** The calendar day of an instant, for comparisons that do not care about the clock. */
const dayOf = (iso: string): string => iso.slice(0, 10);

/**
 * A scale whose range runs backwards. `createTimeScale` cannot build one, and
 * `cameraDateIso` takes `Math.min`/`Math.max` of the range specifically so that a future
 * descending scale would not silently invert the clamp.
 */
function descendingScale(): TimeScale {
  const forward = TIME_SCALE;
  const [a, b] = forward.range();
  return {
    toX: (iso) => -forward.toX(iso),
    toDate: (x) => forward.toDate(-x),
    range: () => [-b, -a] as const,
    domain: () => forward.domain(),
  };
}

// ---------------------------------------------------------------------------
// cameraDateIso
// ---------------------------------------------------------------------------

describe('cameraDateIso inverts through the canonical scale', () => {
  it('agrees with the scale everywhere inside the range', () => {
    // The property the module exists for: the HUD's date and a node's position are the
    // same computation read in two directions.
    const [x0, x1] = TIME_SCALE.range();
    for (let i = 0; i <= 500; i++) {
      const x = x0 + ((x1 - x0) * i) / 500;
      expect(cameraDateIso(TIME_SCALE, x)).toBe(TIME_SCALE.toDate(x));
    }
  });

  it('reads x = 0 as CORRIDOR_START and the range’s end as CORRIDOR_END', () => {
    expect(cameraDateIso(TIME_SCALE, 0)).toBe(CORRIDOR_START);
    expect(cameraDateIso(TIME_SCALE, TIME_SCALE.range()[1])).toBe(CORRIDOR_END);
  });

  it('refuses to name a date past the cutoff even at the far edge of the PAN CLAMP', () => {
    // The assertion this whole file is for. `panBounds` permits x up to `range()[1] +
    // PAN_PAD`; an unclamped readout there would print mid-2085, eighteen months of canon
    // that does not exist, with total confidence and no error.
    const bounds = panBounds(TIME_SCALE);
    expect(cameraDateIso(TIME_SCALE, bounds.max)).toBe(CORRIDOR_END);
    expect(cameraDateIso(TIME_SCALE, bounds.min)).toBe(CORRIDOR_START);

    // And the padding really is large enough for the lie to matter — this is not a
    // hypothetical fraction of a second.
    const unclamped = TIME_SCALE.toDate(bounds.max);
    expect(Date.parse(unclamped) - Date.parse(CORRIDOR_END)).toBeGreaterThan(365 * 86_400_000);
    expect(PAN_PAD).toBeGreaterThan(0);
  });

  it('clamps rather than extrapolating, however far outside x lands', () => {
    expect(cameraDateIso(TIME_SCALE, -1e6)).toBe(CORRIDOR_START);
    expect(cameraDateIso(TIME_SCALE, 1e6)).toBe(CORRIDOR_END);
  });

  it('clamps correctly when the scale’s range runs BACKWARDS', () => {
    // `Math.min`/`Math.max` rather than positional destructuring. Without them the clamp
    // would compare against `[hi, lo]` and pin every x to one end of the corridor.
    const scale = descendingScale();
    const [a, b] = scale.range();
    expect(a).toBeLessThan(b);
    expect(cameraDateIso(scale, -1e6)).toBe(CORRIDOR_END);
    expect(cameraDateIso(scale, 1e6)).toBe(CORRIDOR_START);
    expect(cameraDateIso(scale, a)).toBe(CORRIDOR_END);
  });
});

// ---------------------------------------------------------------------------
// cutoffOpacity
// ---------------------------------------------------------------------------

describe('cutoffOpacity ramps in over the last six months of corridor', () => {
  it('is silent through the whole corridor before the warning window', () => {
    for (const iso of [
      CORRIDOR_START,
      '2040-01-01T00:00:00.000Z',
      '2083-01-01T00:00:00.000Z',
      '2083-10-25T23:58:00.000Z',
    ]) {
      expect(cutoffOpacity(iso, CORRIDOR_END), iso).toBe(0);
    }
  });

  it('opens the window exactly six CALENDAR months before the cutoff', () => {
    // `2084-04-25T23:59` minus six calendar months is `2083-10-25T23:59`. A `6 × 30 days`
    // approximation lands on 2083-10-28 — three days out, and a different three days
    // every time the cutoff moves. Nothing about the rendered fade would look wrong.
    expect(CUTOFF_WARNING_MONTHS).toBe(6);
    expect(cutoffOpacity('2083-10-25T23:59:00.000Z', CORRIDOR_END)).toBe(0);
    expect(cutoffOpacity('2083-10-26T00:00:00.000Z', CORRIDOR_END)).toBeGreaterThan(0);
  });

  it('reaches exactly 1 at the cutoff and stays there beyond it', () => {
    expect(cutoffOpacity(CORRIDOR_END, CORRIDOR_END)).toBe(1);
    expect(cutoffOpacity('2085-01-01T00:00:00.000Z', CORRIDOR_END)).toBe(1);
  });

  it('is half lit at the midpoint of the window, i.e. a LINEAR ramp not a step', () => {
    // A toggle would satisfy "0 before, 1 after" and still be the wrong thing: the marker
    // warns that the corpus stops, it is not an alarm that fires at a threshold.
    expect(cutoffOpacity('2084-01-25T23:59:00.000Z', CORRIDOR_END)).toBeCloseTo(0.5, 2);
  });

  it('never decreases as the camera advances', () => {
    // The property a reader actually perceives. Sampled minute-aligned across the window
    // and well past both ends.
    const from = Date.parse('2083-06-01T00:00:00.000Z');
    const to = Date.parse('2084-08-01T00:00:00.000Z');
    let previous = -1;
    for (let i = 0; i <= 2000; i++) {
      const at = new Date(from + ((to - from) * i) / 2000).toISOString();
      const opacity = cutoffOpacity(at, CORRIDOR_END);
      expect(opacity, `out of [0,1] at ${at}`).toBeGreaterThanOrEqual(0);
      expect(opacity, `out of [0,1] at ${at}`).toBeLessThanOrEqual(1);
      expect(opacity, `went backwards at ${at}`).toBeGreaterThanOrEqual(previous);
      previous = opacity;
    }
    expect(previous).toBe(1);
  });

  it('honours a caller-supplied window width', () => {
    // One month before the cutoff: dark under a 6-month window's arithmetic is wrong —
    // it should be well lit — so this also pins that `months` is actually threaded through.
    const oneMonthBefore = '2084-03-25T23:59:00.000Z';
    expect(cutoffOpacity(oneMonthBefore, CORRIDOR_END, 6)).toBeCloseTo(0.833, 2);
    expect(cutoffOpacity(oneMonthBefore, CORRIDOR_END, 1)).toBe(0);
    expect(cutoffOpacity(oneMonthBefore, CORRIDOR_END, 12)).toBeCloseTo(0.917, 2);
  });

  it('rolls a day-of-month the target month does not have FORWARD, as documented', () => {
    // `setUTCMonth` behaviour, stated in the docstring and asserted rather than left to a
    // reader's assumption: 31 August minus six months is 3 March in a non-leap year, not
    // 28 February. Irrelevant to `CORRIDOR_END`, which lands on the 25th — but a future
    // cutoff on a 29th/30th/31st would inherit it, and this is where they will find out.
    const cutoff = '2083-08-31T12:00:00.000Z';
    expect(cutoffOpacity('2083-03-03T12:00:00.000Z', cutoff)).toBe(0);
    expect(cutoffOpacity('2083-03-04T12:00:00.000Z', cutoff)).toBeGreaterThan(0);
    // …and specifically NOT the last day of February, which is the intuitive answer.
    expect(cutoffOpacity('2083-02-28T12:00:00.000Z', cutoff)).toBe(0);
  });

  it('returns 0 rather than NaN when either instant is unparseable', () => {
    // A NaN opacity does not throw in three.js; the material simply renders wrong. Zero
    // is the safe answer — the warning is absent rather than permanently full-strength.
    expect(cutoffOpacity('not a date', CORRIDOR_END)).toBe(0);
    expect(cutoffOpacity(CORRIDOR_END, 'not a date')).toBe(0);
    expect(cutoffOpacity('', '')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// worldUnitsPerDay
// ---------------------------------------------------------------------------

describe('worldUnitsPerDay is the HUD’s redraw threshold', () => {
  it('is one mean-year slope divided by the days in a mean year', () => {
    expect(worldUnitsPerDay(TIME_SCALE)).toBeCloseTo(EXPECTED_UNITS_PER_DAY, 15);
    expect(worldUnitsPerDay(TIME_SCALE)).toBeCloseTo(0.0273790700698, 10);
  });

  it('does not depend on where the scale’s origin is', () => {
    // It is measured off the domain start, so an origin-dependent answer would be an easy
    // regression — and it would make the HUD's epsilon differ between two views.
    const shifted = createTimeScale('2040-06-01T00:00:00.000Z');
    expect(worldUnitsPerDay(shifted)).toBe(worldUnitsPerDay(TIME_SCALE));
  });

  it('really is the x a day spans, measured ANYWHERE in the corridor', () => {
    // The definition, checked against the scale directly rather than against the constant.
    const day = worldUnitsPerDay(TIME_SCALE);
    for (const iso of ['2021-06-01', '2042-11-30', '2060-02-29', '2084-01-01']) {
      const a = `${iso}T00:00:00.000Z`;
      const b = new Date(Date.parse(a) + 86_400_000).toISOString();
      expect(TIME_SCALE.toX(b) - TIME_SCALE.toX(a), iso).toBeCloseTo(day, 12);
    }
  });

  it('is small enough that a sub-threshold move cannot skip a day of readout', () => {
    // Why this number is the right epsilon. Gating re-renders on it means the printed date
    // can never be more than one day stale — the readout stays honest between notifications.
    const day = worldUnitsPerDay(TIME_SCALE);
    const [x0, x1] = TIME_SCALE.range();
    for (let i = 0; i < 300; i++) {
      const x = x0 + ((x1 - x0) * i) / 300;
      const before = Date.parse(`${dayOf(cameraDateIso(TIME_SCALE, x))}T00:00:00.000Z`);
      const after = Date.parse(
        `${dayOf(cameraDateIso(TIME_SCALE, x + day * 0.999))}T00:00:00.000Z`,
      );
      const daysSkipped = (after - before) / 86_400_000;
      expect(daysSkipped, `skipped ${daysSkipped} days at x = ${x}`).toBeLessThanOrEqual(1);
      expect(daysSkipped).toBeGreaterThanOrEqual(0);
    }
  });

  it('is positive, so it can be used as a threshold at all', () => {
    // `createCameraChannel` substitutes `Number.EPSILON` for a non-positive epsilon, which
    // would silently restore the per-frame re-render this module exists to prevent.
    expect(worldUnitsPerDay(TIME_SCALE)).toBeGreaterThan(0);
  });
});
