import { describe, expect, it } from 'vitest';

import { CORRIDOR_FIXTURE } from '@client/views/timeline/fixture';
import {
  PAN_FALLBACK_WORLD_PER_PIXEL,
  PAN_FRICTION_PER_SECOND,
  PAN_IMPULSE_SECONDS,
  PAN_PAD,
  PAN_REST_SPEED,
  WHEEL_PIXELS_PER_LINE,
  WHEEL_PIXELS_PER_PAGE,
  clampPan,
  panBounds,
  pushPan,
  stepPan,
  wheelPixels,
  worldPerPixel,
} from '@client/views/timeline/pan';
import { DEFAULT_CAMERA_POSE } from '@client/views/_shared/sceneSettings';
import { CORRIDOR_START, TIME_SCALE, WORLD_UNITS_PER_YEAR } from '@shared/timeScale';

import type { PanBounds, PanState, WheelDelta } from '@client/views/timeline/pan';
import type { TimeScale } from '@shared/timeScale';

/**
 * P4.5 — the corridor's pan physics (D7 of the P4 review fix contract).
 *
 * ── WHY THIS SPEC EXISTS ─────────────────────────────────────────────────────────────
 * `pan.ts` says in its own header that it "holds the physics so the clamp and the
 * inertia can be exercised headlessly, without a canvas". Until now nothing did. The P4
 * execution evidence for both properties was gathered by hand and never committed, so
 * the module that exists specifically to be testable was the one module with no test.
 *
 * Three properties are load-bearing, and every one of them fails silently:
 *
 *   1. **The clamp LANDS.** A pan that overshoots must come to rest *exactly* on the
 *      bound, not asymptotically near it. The tempting alternative — bleed the velocity
 *      off and let the position converge — leaves the camera a fraction of a unit short
 *      forever, and `panBounds` is what the HUD trusts when it refuses to name a date
 *      past the cutoff. Asserted with `toBe`, never `toBeCloseTo`: "close to the wall"
 *      is precisely the bug.
 *   2. **Inertia is frame-rate independent.** The same gesture must reach the same
 *      resting x whether it is integrated at 30, 60 or 240 Hz, because P8.6's viewport
 *      stack replays camera positions and a dropped frame must not relocate the camera.
 *      The exact integral of `v0 · f^t` composes; `x += v · dt` does not, and a spec that
 *      only ever steps at one rate cannot tell them apart.
 *   3. **The corridor stays reachable.** Every event must sit inside the padded bounds,
 *      or its node is drawn somewhere the camera cannot be moved to. This is the failure
 *      D1 made structural by pinning the origin to {@link CORRIDOR_START}, and it is
 *      cheapest to assert from this side, where the bounds actually live.
 *
 * The rest — `wheelPixels`'s dominant-axis rule, `worldPerPixel`'s fallbacks — is input
 * normalisation, where every wrong answer is a plausible number rather than an error.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Natural log of the friction constant; the integral's denominator. Negative. */
const LN_FRICTION = Math.log(PAN_FRICTION_PER_SECOND);

/**
 * World units in one day at the canonical slope, restated independently of `hud.ts`.
 * Used only as a *unit* for the frame-rate tolerance: the HUD renders at day precision,
 * so an inter-frame-rate discrepancy is only meaningful when compared against a day.
 */
const WORLD_UNITS_PER_DAY = WORLD_UNITS_PER_YEAR / 365.2425;

/** The corridor's real bounds — what `CorridorControls` clamps against in production. */
const BOUNDS = panBounds(TIME_SCALE);

/**
 * A `TimeScale` that only answers `range()`. `panBounds` reads nothing else, and a stub
 * is the only way to present it with the descending range its docstring guards against —
 * `createTimeScale` cannot produce one.
 */
function rangeOnlyScale(a: number, b: number): TimeScale {
  return {
    toX: () => 0,
    toDate: () => CORRIDOR_START,
    range: () => [a, b] as const,
    domain: () => [CORRIDOR_START, CORRIDOR_START] as const,
  };
}

/** Integrate `state` for `seconds` at a fixed `hz`, the way `useFrame` would. */
function integrate(state: PanState, seconds: number, hz: number, bounds: PanBounds): PanState {
  const dt = 1 / hz;
  let at = state;
  for (let i = 0; i < Math.round(seconds * hz); i++) at = stepPan(at, dt, bounds);
  return at;
}

// ---------------------------------------------------------------------------
// panBounds
// ---------------------------------------------------------------------------

describe('panBounds pads the canonical range and nothing else', () => {
  it('is the scale’s range widened by PAN_PAD at each end', () => {
    const [x0, x1] = TIME_SCALE.range();
    expect(BOUNDS.min).toBe(x0 - PAN_PAD);
    expect(BOUNDS.max).toBe(x1 + PAN_PAD);
  });

  it('pads by eighteen months of corridor, stated as time rather than as a magic number', () => {
    // The docstring's claim. If `PAN_PAD` is ever retuned this line says what changed.
    expect(PAN_PAD).toBe(WORLD_UNITS_PER_YEAR * 1.5);
    expect(PAN_PAD / WORLD_UNITS_PER_YEAR).toBeCloseTo(1.5, 12);
  });

  it('honours an explicit pad, including a pad of zero', () => {
    const [x0, x1] = TIME_SCALE.range();
    expect(panBounds(TIME_SCALE, 0)).toEqual({ min: x0, max: x1 });
    expect(panBounds(TIME_SCALE, 100)).toEqual({ min: x0 - 100, max: x1 + 100 });
  });

  it('does not invert when handed a DESCENDING range', () => {
    // A descending range is a legal d3 scale. A clamp built as `{ min: a, max: b }` would
    // produce min > max, which `clampPan` resolves by pinning x to `min` — the camera
    // would be frozen at one end of an empty interval with nothing raised.
    const bounds = panBounds(rangeOnlyScale(500, 0), 10);
    expect(bounds).toEqual({ min: -10, max: 510 });
    expect(bounds.min).toBeLessThan(bounds.max);
  });

  it('keeps every fixture event inside the reachable interval', () => {
    // The D1 invariant, asserted where it bites: an event outside `panBounds` is drawn at
    // a position the camera can never be moved to. `CORRIDOR_START` sits one minute before
    // canon's earliest instant precisely so this holds.
    for (const event of CORRIDOR_FIXTURE) {
      const x = TIME_SCALE.toX(event.when);
      expect(x, `${event.id} is left of the reachable corridor`).toBeGreaterThanOrEqual(BOUNDS.min);
      expect(x, `${event.id} is right of the reachable corridor`).toBeLessThanOrEqual(BOUNDS.max);
    }
  });
});

describe('clampPan', () => {
  it('pins outside and returns inside values untouched', () => {
    const bounds: PanBounds = { min: -5, max: 5 };
    expect(clampPan(-100, bounds)).toBe(-5);
    expect(clampPan(100, bounds)).toBe(5);
    expect(clampPan(0, bounds)).toBe(0);
  });

  it('leaves a value sitting exactly ON a bound where it is', () => {
    const bounds: PanBounds = { min: -5, max: 5 };
    expect(clampPan(-5, bounds)).toBe(-5);
    expect(clampPan(5, bounds)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// The clamp lands
// ---------------------------------------------------------------------------

describe('the clamp LANDS on the bound rather than approaching it', () => {
  it('comes to rest EXACTLY on max after a flick that overshoots it', () => {
    const flicked = pushPan({ x: BOUNDS.max - 1, velocity: 0 }, 50, BOUNDS, true);
    const rested = integrate(flicked, 10, 60, BOUNDS);
    // `toBe`, deliberately. `toBeCloseTo` would pass for an integrator that converges on
    // the wall without ever reaching it, which is the failure this asserts against.
    expect(rested.x).toBe(BOUNDS.max);
    expect(rested.velocity).toBe(0);
  });

  it('comes to rest EXACTLY on min after a flick the other way', () => {
    const flicked = pushPan({ x: BOUNDS.min + 1, velocity: 0 }, -50, BOUNDS, true);
    const rested = integrate(flicked, 10, 60, BOUNDS);
    expect(rested.x).toBe(BOUNDS.min);
    expect(rested.velocity).toBe(0);
  });

  it('lands on the very frame it crosses the bound, not over several', () => {
    // Momentum must stop dead at the wall (the header's words). An implementation that
    // clamped position but kept the velocity would sit at `max` with stored momentum and
    // then refuse to move inward until that momentum bled off.
    let state = pushPan({ x: BOUNDS.max - 0.5, velocity: 0 }, 20, BOUNDS, true);
    let frames = 0;
    while (state.x < BOUNDS.max && frames < 600) {
      state = stepPan(state, 1 / 60, BOUNDS);
      frames++;
    }
    expect(frames).toBeLessThan(600);
    expect(state.x).toBe(BOUNDS.max);
    expect(state.velocity).toBe(0);
  });

  it('never lets x leave the bounds across a long mixed sequence of pushes and steps', () => {
    // Deterministic pseudo-random gestures — no Math.random, a flaky spec here would be
    // worse than none. The impulses are large enough to slam both walls repeatedly.
    let state: PanState = { x: 0, velocity: 0 };
    let seed = 1;
    for (let i = 0; i < 4000; i++) {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      const unit = seed / 2_147_483_648;
      if (i % 3 === 0) state = pushPan(state, (unit - 0.5) * 400, BOUNDS, true);
      state = stepPan(state, 1 / 60, BOUNDS);
      expect(Number.isFinite(state.x), `x went non-finite at step ${i}`).toBe(true);
      expect(state.x, `escaped min at step ${i}`).toBeGreaterThanOrEqual(BOUNDS.min);
      expect(state.x, `escaped max at step ${i}`).toBeLessThanOrEqual(BOUNDS.max);
    }
  });

  it('pulls a resting camera back in when the bounds move under it', () => {
    // The recovery path: bounds are derived from the scale, and a caller may hand `stepPan`
    // a state left over from wider bounds. A resting state takes the early return, so this
    // is the branch that would be easiest to drop.
    const bounds: PanBounds = { min: 0, max: 10 };
    expect(stepPan({ x: 99, velocity: 0 }, 1 / 60, bounds)).toEqual({ x: 10, velocity: 0 });
    expect(stepPan({ x: -99, velocity: 0 }, 0, bounds)).toEqual({ x: 0, velocity: 0 });
  });

  it('returns the SAME object for an idle in-bounds camera, allocating nothing per frame', () => {
    // This runs sixty times a second forever. The identity is the documented reason the
    // early return exists, and `toEqual` would not notice it being lost.
    const resting: PanState = { x: 100, velocity: 0 };
    expect(stepPan(resting, 1 / 60, BOUNDS)).toBe(resting);
    expect(stepPan(resting, 0, BOUNDS)).toBe(resting);
    expect(stepPan(resting, -1, BOUNDS)).toBe(resting);
  });
});

// ---------------------------------------------------------------------------
// Frame-rate independence
// ---------------------------------------------------------------------------

describe('inertia is frame-rate independent', () => {
  it('lands ten 10 ms steps within a couple of ULP of one 100 ms step', () => {
    // The header's exact claim. It is "exact" as mathematics; in floating point the
    // residual is the rounding of one `Math.pow`, so the bound is stated in ULP rather
    // than as a tolerance somebody could widen until a real regression fitted under it.
    const start: PanState = { x: 0, velocity: 1000 };
    const oneStep = stepPan(start, 0.1, BOUNDS);
    const tenSteps = integrate(start, 0.1, 100, BOUNDS);

    const ulp = Number.EPSILON * Math.abs(oneStep.x);
    const error = Math.abs(oneStep.x - tenSteps.x);
    expect(error, `composition error was ${error} (${error / ulp} ULP)`).toBeLessThanOrEqual(
      8 * ulp,
    );
    expect(tenSteps.velocity).toBeCloseTo(oneStep.velocity, 9);
  });

  it('lands the same gesture at 60 Hz and at 144 Hz, within a hundredth of a day', () => {
    // The headline claim, on the two rates a real reader actually has. Stated against a
    // day because that is the HUD's redraw epsilon (`worldUnitsPerDay`): a drift smaller
    // than one day cannot make the two frame rates print a different date, and this one
    // is a hundredth of that.
    const gesture = (hz: number): number =>
      integrate(pushPan({ x: 100, velocity: 0 }, 10, BOUNDS, true), 5, hz, BOUNDS).x;

    const drift = Math.abs(gesture(60) - gesture(144));
    expect(drift, `60 Hz and 144 Hz differed by ${drift} world units`).toBeLessThan(
      WORLD_UNITS_PER_DAY / 100,
    );
  });

  it('reaches the same resting x at 30, 60, 90, 120, 144 and 240 Hz', () => {
    // The property P8.6 depends on. A `x += v * dt` integrator fails this by whole world
    // units: at 30 Hz it would overshoot the exact integral by ~1.5% of the glide.
    const gesture = (hz: number): number =>
      integrate(pushPan({ x: 100, velocity: 0 }, 10, BOUNDS, true), 5, hz, BOUNDS).x;

    const rates = [30, 60, 90, 120, 144, 240];
    const landings = rates.map(gesture);
    const spread = Math.max(...landings) - Math.min(...landings);

    // Tolerance in the unit that matters: the HUD reads at day precision, and the whole
    // spread across an 8x range of frame rates is under a tenth of one day of corridor.
    expect(spread, `spread across ${rates.join('/')} Hz was ${spread} world units`).toBeLessThan(
      WORLD_UNITS_PER_DAY / 10,
    );
    // …and the residual is not the integration at all — it is the rest-speed cutoff firing
    // one frame earlier at a high rate. That discards a tail bounded by `v/-ln f`, which
    // is why the spread can never grow past this however the rates are chosen.
    expect(spread).toBeLessThanOrEqual(PAN_REST_SPEED / -LN_FRICTION);
  });

  it('is unmoved by a dropped frame', () => {
    // A 60 Hz run against the same run with frame 15 dropped — one 2/60 step in place of
    // two 1/60 steps. Same total time, same landing.
    const flicked = pushPan({ x: 100, velocity: 0 }, 10, BOUNDS, true);
    const clean = integrate(flicked, 0.5, 60, BOUNDS);

    let dropped = flicked;
    for (let frame = 0; frame < 30; frame++) {
      if (frame === 15) continue;
      dropped = stepPan(dropped, frame === 16 ? 2 / 60 : 1 / 60, BOUNDS);
    }

    const ulp = Number.EPSILON * Math.abs(clean.x);
    expect(Math.abs(clean.x - dropped.x)).toBeLessThanOrEqual(8 * ulp);
  });

  it('glides the distance the friction integral predicts, short only by the rest cutoff', () => {
    // Anchors the feel constants to arithmetic. Total glide of an impulse `d` is
    // `d / (PAN_IMPULSE_SECONDS · -ln f)`; the docstring rounds that to `d * 1.28`.
    const impulse = 10;
    const ideal = impulse / (PAN_IMPULSE_SECONDS * -LN_FRICTION);
    const travelled =
      integrate(pushPan({ x: 100, velocity: 0 }, impulse, BOUNDS, true), 5, 60, BOUNDS).x - 100;

    expect(ideal / impulse).toBeCloseTo(1.28, 2);
    // Short of the ideal — never past it — by at most the tail the rest cutoff discards.
    expect(travelled).toBeLessThanOrEqual(ideal);
    expect(ideal - travelled).toBeLessThanOrEqual(PAN_REST_SPEED / -LN_FRICTION);
  });

  it('stops rather than drifting: velocity reaches exactly zero, not merely a small number', () => {
    const rested = integrate(pushPan({ x: 100, velocity: 0 }, 10, BOUNDS, true), 5, 60, BOUNDS);
    expect(rested.velocity).toBe(0);
    // And once stopped it is genuinely idle — the identity check above then applies.
    expect(stepPan(rested, 1 / 60, BOUNDS)).toBe(rested);
  });
});

// ---------------------------------------------------------------------------
// pushPan
// ---------------------------------------------------------------------------

describe('pushPan turns a gesture into either momentum or a jump', () => {
  it('with inertia adds velocity and moves nothing yet', () => {
    const pushed = pushPan({ x: 100, velocity: 0 }, 6, BOUNDS, true);
    expect(pushed.x).toBe(100);
    expect(pushed.velocity).toBe(6 / PAN_IMPULSE_SECONDS);
  });

  it('with inertia ACCUMULATES across a burst of notches', () => {
    let state: PanState = { x: 100, velocity: 0 };
    for (let i = 0; i < 3; i++) state = pushPan(state, 2, BOUNDS, true);
    expect(state.velocity).toBeCloseTo(6 / PAN_IMPULSE_SECONDS, 9);
  });

  it('without inertia jumps exactly delta and carries nothing', () => {
    // The reduced-motion path: same distance travelled, no glide (P4.4.5).
    const jumped = pushPan({ x: 100, velocity: 0 }, 6, BOUNDS, false);
    expect(jumped).toEqual({ x: 106, velocity: 0 });
  });

  it('without inertia discards momentum that was already there', () => {
    expect(pushPan({ x: 100, velocity: 500 }, 6, BOUNDS, false).velocity).toBe(0);
  });

  it('refuses to bank momentum against a wall it is already touching', () => {
    // Otherwise a reader who keeps scrolling at the end of the corridor builds up a
    // charge that fires the moment they scroll back — the camera would leap.
    const atMax: PanState = { x: BOUNDS.max, velocity: 0 };
    expect(pushPan(atMax, 50, BOUNDS, true).velocity).toBe(0);
    expect(pushPan(atMax, 50, BOUNDS, true).x).toBe(BOUNDS.max);

    const atMin: PanState = { x: BOUNDS.min, velocity: 0 };
    expect(pushPan(atMin, -50, BOUNDS, true).velocity).toBe(0);
  });

  it('lets a reader reverse off a wall IMMEDIATELY, keeping inward velocity', () => {
    // The other half of the same rule, and the reason `settle` tests the sign rather than
    // zeroing unconditionally.
    const atMax: PanState = { x: BOUNDS.max, velocity: 0 };
    const reversed = pushPan(atMax, -50, BOUNDS, true);
    expect(reversed.velocity).toBe(-50 / PAN_IMPULSE_SECONDS);
    expect(stepPan(reversed, 1 / 60, BOUNDS).x).toBeLessThan(BOUNDS.max);
  });

  it('clamps a no-inertia jump that would leave the corridor', () => {
    expect(pushPan({ x: BOUNDS.max - 1, velocity: 0 }, 999, BOUNDS, false).x).toBe(BOUNDS.max);
    expect(pushPan({ x: BOUNDS.min + 1, velocity: 0 }, -999, BOUNDS, false).x).toBe(BOUNDS.min);
  });
});

// ---------------------------------------------------------------------------
// wheelPixels
// ---------------------------------------------------------------------------

describe('wheelPixels lets the dominant axis drive time', () => {
  const wheel = (deltaX: number, deltaY: number, deltaMode = 0): WheelDelta => ({
    deltaX,
    deltaY,
    deltaMode,
  });

  it('reads a plain mouse wheel, which only ever produces deltaY', () => {
    // The case the docstring says ignoring deltaY would break: a mouse could not pan at all.
    expect(wheelPixels(wheel(0, -120))).toBe(-120);
    expect(wheelPixels(wheel(0, 120))).toBe(120);
  });

  it('reads a trackpad’s horizontal swipe from deltaX', () => {
    expect(wheelPixels(wheel(42, 0))).toBe(42);
    expect(wheelPixels(wheel(-42, 0))).toBe(-42);
  });

  it('picks the LARGER axis on a diagonal gesture, in either direction', () => {
    expect(wheelPixels(wheel(30, -100))).toBe(-100);
    expect(wheelPixels(wheel(-100, 30))).toBe(-100);
  });

  it('breaks an exact tie toward deltaX — which decides the SIGN, not just the size', () => {
    // Worth pinning: at `deltaX = 5, deltaY = -5` the two candidates differ by more than a
    // rounding, they point opposite ways. The `>=` in the comparison is what settles it.
    expect(wheelPixels(wheel(5, -5))).toBe(5);
    expect(wheelPixels(wheel(-5, 5))).toBe(-5);
    expect(wheelPixels(wheel(0, 0))).toBe(0);
  });

  it('normalises Firefox’s line and page delta modes to pixels', () => {
    expect(wheelPixels(wheel(0, -3, 1))).toBe(-3 * WHEEL_PIXELS_PER_LINE);
    expect(wheelPixels(wheel(0, -1, 2))).toBe(-1 * WHEEL_PIXELS_PER_PAGE);
    expect(WHEEL_PIXELS_PER_LINE).toBe(16);
    expect(WHEEL_PIXELS_PER_PAGE).toBe(400);
  });

  it('chooses the axis BEFORE converting the unit, so the mode cannot flip the choice', () => {
    // Both axes always carry the same `deltaMode`, so comparing raw values is correct —
    // but only if the conversion is applied afterwards, as it is here.
    expect(wheelPixels(wheel(3, -100, 1))).toBe(-100 * WHEEL_PIXELS_PER_LINE);
    expect(wheelPixels(wheel(-100, 3, 2))).toBe(-100 * WHEEL_PIXELS_PER_PAGE);
  });

  it('treats an unknown delta mode as pixels rather than as zero', () => {
    expect(wheelPixels(wheel(0, -120, 3))).toBe(-120);
  });
});

// ---------------------------------------------------------------------------
// worldPerPixel
// ---------------------------------------------------------------------------

describe('worldPerPixel converts a gesture into corridor distance', () => {
  it('makes the default pose show the ~6.5 years its docstring claims', () => {
    // Cross-checks `sceneSettings`'s prose against this module's arithmetic. The two are
    // written independently and nothing else would notice them disagreeing.
    const widthPx = 1400;
    const perPixel = worldPerPixel(
      DEFAULT_CAMERA_POSE.fov,
      16 / 9,
      DEFAULT_CAMERA_POSE.position[2],
      widthPx,
    );
    const years = (perPixel * widthPx) / WORLD_UNITS_PER_YEAR;
    expect(years, `default pose shows ${years} years`).toBeGreaterThan(6);
    expect(years).toBeLessThan(7);
  });

  it('scales linearly with distance and inversely with canvas width', () => {
    const base = worldPerPixel(50, 16 / 9, 40, 1400);
    expect(worldPerPixel(50, 16 / 9, 80, 1400)).toBeCloseTo(base * 2, 12);
    expect(worldPerPixel(50, 16 / 9, 40, 2800)).toBeCloseTo(base / 2, 12);
    expect(worldPerPixel(50, 32 / 9, 40, 1400)).toBeCloseTo(base * 2, 12);
  });

  it('ignores the SIGN of the distance', () => {
    // A camera at z = -40 looks at the plane from the other side; the pixel scale is the
    // same, and a missing `Math.abs` would return a negative and invert every gesture.
    expect(worldPerPixel(50, 16 / 9, -40, 1400)).toBe(worldPerPixel(50, 16 / 9, 40, 1400));
  });

  it('falls back when the camera sits IN the corridor plane', () => {
    // The documented degenerate case: zero distance means zero frustum width at the plane
    // and an undefined ratio. Returning 0 would make every gesture move the camera nowhere.
    expect(worldPerPixel(50, 16 / 9, 0, 1400)).toBe(PAN_FALLBACK_WORLD_PER_PIXEL);
  });

  it('falls back on every degenerate frustum rather than returning NaN or Infinity', () => {
    // Each of these would otherwise propagate into `camera.position.x`, and a camera at
    // NaN does not throw in three.js — the scene simply stops drawing.
    const cases: ReadonlyArray<readonly [string, number]> = [
      ['zero width', worldPerPixel(50, 16 / 9, 40, 0)],
      ['negative width', worldPerPixel(50, 16 / 9, 40, -1400)],
      ['NaN width', worldPerPixel(50, 16 / 9, 40, Number.NaN)],
      ['zero aspect', worldPerPixel(50, 0, 40, 1400)],
      ['negative aspect', worldPerPixel(50, -1.78, 40, 1400)],
      ['NaN distance', worldPerPixel(50, 16 / 9, Number.NaN, 1400)],
      ['infinite distance', worldPerPixel(50, 16 / 9, Number.POSITIVE_INFINITY, 1400)],
      ['zero fov', worldPerPixel(0, 16 / 9, 40, 1400)],
      ['negative fov', worldPerPixel(-50, 16 / 9, 40, 1400)],
      ['180° fov', worldPerPixel(180, 16 / 9, 40, 1400)],
      ['fov past 180°', worldPerPixel(200, 16 / 9, 40, 1400)],
    ];
    for (const [label, value] of cases) {
      expect(value, label).toBe(PAN_FALLBACK_WORLD_PER_PIXEL);
    }
  });

  it('catches a 180° fov, which the finiteness guard alone did not', () => {
    // A regression test for a real gap, closed after this spec found it. The old guard was
    // `perPixel > 0 && isFinite(perPixel)`, and a 180° fov cleared both: `Math.tan(Math.PI
    // / 2)` is 1.6e16 rather than Infinity, because π/2 is not exactly representable. The
    // result was a finite, positive and completely meaningless ~1.7e15 world units per
    // pixel, so one wheel notch would have thrown the camera past representable time.
    //
    // The fix is a DOMAIN check on fov (`0 < fov < 180`), not a wider isFinite test — no
    // amount of finiteness checking catches a number that is genuinely finite. Assert the
    // fallback rather than merely a small number, so widening the guard back cannot pass.
    expect(worldPerPixel(180, 16 / 9, 40, 1400)).toBe(PAN_FALLBACK_WORLD_PER_PIXEL);
    expect(worldPerPixel(179.999, 16 / 9, 40, 1400)).not.toBe(PAN_FALLBACK_WORLD_PER_PIXEL);
    expect(worldPerPixel(360, 16 / 9, 40, 1400)).toBe(PAN_FALLBACK_WORLD_PER_PIXEL);
    expect(worldPerPixel(Number.POSITIVE_INFINITY, 16 / 9, 40, 1400)).toBe(
      PAN_FALLBACK_WORLD_PER_PIXEL,
    );
    expect(worldPerPixel(Number.NaN, 16 / 9, 40, 1400)).toBe(PAN_FALLBACK_WORLD_PER_PIXEL);
  });

  it('states the fallback as a fraction of the corridor, not as a loose constant', () => {
    expect(PAN_FALLBACK_WORLD_PER_PIXEL).toBe(WORLD_UNITS_PER_YEAR * 0.003);
    // The docstring's own sanity figure: ~42 units across a 1400 px canvas.
    expect(PAN_FALLBACK_WORLD_PER_PIXEL * 1400).toBeCloseTo(42, 9);
  });
});
