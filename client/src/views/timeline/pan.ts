/**
 * Corridor pan — implementation P4.5. Custom controls, deliberately not `OrbitControls`.
 *
 * Everything here is a pure function of `(state, input)`. The R3F component that owns the
 * camera and the wheel listener is `CorridorControls.tsx`; this module holds the physics
 * so the clamp and the inertia can be exercised headlessly, without a canvas.
 *
 * ## The model
 *
 * A wheel notch is an **impulse**: it adds to a velocity, and {@link stepPan} integrates
 * that velocity with exponential friction on every frame. Position is only ever changed
 * by the integrator, which is what keeps the clamp in one place.
 *
 * Integration is the exact integral of `v0 * f^t`, not `x += v * dt`, so the result is
 * frame-rate independent: ten 10 ms steps land exactly where one 100 ms step does. A
 * dropped frame therefore cannot make the camera travel a different distance, which
 * matters because the viewport stack (P8.6) replays camera positions.
 *
 * ## The clamp
 *
 * The bounds come from **the canonical scale's `range()`**, padded — never from a
 * per-stratum scale, which would make the clamp move as the camera changes depth (P7.6,
 * and the canonical-scale decision). Hitting a bound stops the camera dead rather than
 * letting momentum carry it into empty space: {@link settle} pins x to the bound and
 * zeroes any velocity still pointing outward.
 *
 * ## Deviation from the task text, stated out loud
 *
 * P4.5 says "`d3-zoom` reads wheel/touchpad". It does not here. `d3-zoom` owns a
 * transform with its own extent and constraint machinery, and layering our own inertia
 * and our own scale-derived clamp on top of it means two state machines fighting over
 * one axis — with the authoritative clamp (`timeScale.range()` padded) living in the one
 * that d3 does not know about. All this needs from it is wheel normalisation, which is
 * {@link wheelPixels} below. See the report accompanying this task.
 */

import { WORLD_UNITS_PER_YEAR } from '@shared/timeScale';

import type { TimeScale } from '@shared/timeScale';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * How far past the first and last instant of the corridor the camera may travel, in
 * world units — 18 months at the canonical slope.
 *
 * Padding exists so the outermost node is not glued to the edge of the screen. It is
 * deliberately small: it is visual slack, not extra time, and the HUD clamps its readout
 * to the scale's actual range so the corridor never claims a date it does not cover.
 */
export const PAN_PAD = WORLD_UNITS_PER_YEAR * 1.5;

/**
 * Fraction of the pan velocity that survives one second of friction.
 *
 * At 0.0015 a flick decays to a stop in a little under a second — long enough to read as
 * momentum, short enough that the camera never feels like it is sliding away.
 */
export const PAN_FRICTION_PER_SECOND = 0.0015;

/**
 * The time a single wheel impulse is treated as spreading over, in seconds.
 *
 * A notch of `d` world units becomes `d / PAN_IMPULSE_SECONDS` of velocity; with the
 * friction above, that glides a total of `d * 1.28` — near 1:1 with the gesture, plus a
 * little carry.
 */
export const PAN_IMPULSE_SECONDS = 0.12;

/** Speed below which the camera is treated as stopped, in world units per second. */
export const PAN_REST_SPEED = WORLD_UNITS_PER_YEAR * 0.002;

/**
 * World units per pixel when the true value cannot be read off the camera.
 *
 * {@link worldPerPixel} derives the real figure from the camera's frustum, which needs
 * the camera to be looking at the corridor plane from a distance. A camera sitting *in*
 * the plane (one aimed down the time axis rather than at it) has no such distance, and
 * this constant stands in. Roughly one screen pixel per 0.03 world units, i.e. a
 * 1400 px-wide canvas showing ~42 units of corridor.
 */
export const PAN_FALLBACK_WORLD_PER_PIXEL = WORLD_UNITS_PER_YEAR * 0.003;

/** `WheelEvent.deltaMode` is in lines; assume this many pixels per line. */
export const WHEEL_PIXELS_PER_LINE = 16;

/** `WheelEvent.deltaMode` is in pages; assume this many pixels per page. */
export const WHEEL_PIXELS_PER_PAGE = 400;

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** The closed interval the camera's x is confined to. */
export interface PanBounds {
  readonly min: number;
  readonly max: number;
}

/**
 * The canonical scale's range, padded — the viewport clamp of P4.5.
 *
 * `range()` is `[x(earliest), x(CORRIDOR_END)]` and is ordered by construction, but the
 * min/max are taken anyway: a descending range is a legal `d3` scale and a clamp that
 * assumed otherwise would silently invert.
 */
export function panBounds(scale: TimeScale, pad: number = PAN_PAD): PanBounds {
  const [a, b] = scale.range();
  return { min: Math.min(a, b) - pad, max: Math.max(a, b) + pad };
}

/** Pin `x` into `bounds`. */
export function clampPan(x: number, bounds: PanBounds): number {
  if (x < bounds.min) return bounds.min;
  if (x > bounds.max) return bounds.max;
  return x;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Camera x plus the momentum carrying it, in world units and world units per second. */
export interface PanState {
  readonly x: number;
  readonly velocity: number;
}

/**
 * Pin a candidate position into the bounds, killing any velocity still pointing out of
 * them. Inward velocity survives, so a flick into a wall can be reversed immediately
 * rather than after the momentum has bled off.
 */
function settle(x: number, velocity: number, bounds: PanBounds): PanState {
  if (x <= bounds.min) return { x: bounds.min, velocity: velocity < 0 ? 0 : velocity };
  if (x >= bounds.max) return { x: bounds.max, velocity: velocity > 0 ? 0 : velocity };
  return { x, velocity };
}

/**
 * Apply one wheel / trackpad impulse of `delta` world units.
 *
 * With `inertia` the impulse becomes velocity and {@link stepPan} does the moving. Without
 * it — `prefers-reduced-motion` — the camera jumps by `delta` and carries nothing, which
 * is the same distance travelled with no glide.
 */
export function pushPan(
  state: PanState,
  delta: number,
  bounds: PanBounds,
  inertia: boolean,
): PanState {
  if (!inertia) return settle(state.x + delta, 0, bounds);
  return settle(state.x, state.velocity + delta / PAN_IMPULSE_SECONDS, bounds);
}

/**
 * Advance `dt` seconds of inertia.
 *
 * Displacement is the exact integral of `v0 * f^t` over `[0, dt]`, so stepping is
 * frame-rate independent. Below {@link PAN_REST_SPEED} the velocity is zeroed outright,
 * which stops the state from drifting by sub-pixel amounts forever.
 */
export function stepPan(state: PanState, dt: number, bounds: PanBounds): PanState {
  if (dt <= 0 || state.velocity === 0) {
    // Return the same object when a resting camera is already in bounds. This runs on
    // every frame of an idle corridor, and a fresh state object per frame is garbage
    // collected sixty times a second for no reason.
    if (state.x >= bounds.min && state.x <= bounds.max) return state;
    return settle(state.x, state.velocity, bounds);
  }

  const decay = Math.pow(PAN_FRICTION_PER_SECOND, dt);
  const travel = (state.velocity * (decay - 1)) / Math.log(PAN_FRICTION_PER_SECOND);
  const velocity = state.velocity * decay;

  return settle(state.x + travel, Math.abs(velocity) < PAN_REST_SPEED ? 0 : velocity, bounds);
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** The half of `WheelEvent` this module reads. */
export type WheelDelta = Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode'>;

/**
 * One wheel event as a signed pixel distance along the time axis.
 *
 * The dominant axis wins: a trackpad's two-finger horizontal swipe arrives as `deltaX`,
 * while a mouse wheel only ever produces `deltaY`. Ignoring `deltaY` would leave the
 * corridor unpannable with a mouse; preferring it would make a diagonal trackpad gesture
 * pan the wrong way. `deltaMode` is normalised to pixels, because Firefox reports lines.
 *
 * **P7 reverses the justification above, and this rule has to go with it.** P7.7 maps
 * vertical scroll to camera *depth* — continuously, no snapping — so `deltaY` stops being
 * a substitute for `deltaX` and becomes a different axis of the scene. Folding it into
 * the time pan then makes one gesture drive two axes at once, and the mouse argument
 * inverts: rather than being the only way a mouse can pan time, `deltaY` becomes the one
 * thing a mouse *cannot* spend on time, leaving a plain wheel with no time pan at all.
 * P7 owns the replacement (a modifier key, a drag, or a horizontal-only rule with an
 * explicit mouse affordance) because it owns the depth axis; this comment only records
 * that the reasoning here expires there. The code is six pure lines and is deliberately
 * left as it is at P4 — changing it now would guess at P7's input model.
 */
export function wheelPixels(event: WheelDelta): number {
  const raw = Math.abs(event.deltaX) >= Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  if (event.deltaMode === 1) return raw * WHEEL_PIXELS_PER_LINE;
  if (event.deltaMode === 2) return raw * WHEEL_PIXELS_PER_PAGE;
  return raw;
}

/**
 * World units spanned by one screen pixel at the corridor plane, for a perspective
 * camera — the conversion that makes a gesture move the corridor by the distance the
 * fingers moved.
 *
 * Derived from the live camera rather than from a tuned constant, so it stays correct
 * whatever initial pose the shared scene chrome (P4.4.1) picks and whatever the canvas
 * is resized to. Returns {@link PAN_FALLBACK_WORLD_PER_PIXEL} when the camera is in the
 * corridor plane, where the frustum width at that plane is zero and the ratio is
 * undefined.
 */
export function worldPerPixel(
  fovDegrees: number,
  aspect: number,
  distance: number,
  widthPx: number,
): number {
  // The fov test is a DOMAIN check, not a finiteness one, and that distinction is the
  // whole of it. `perPixel > 0 && Number.isFinite(perPixel)` looks like it covers every
  // degenerate frustum and does not: `Math.tan(Math.PI / 2)` evaluates to 1.6e16 rather
  // than Infinity, because pi/2 is not exactly representable, so a 180-degree fov clears
  // both tests and returns a finite, positive, meaningless 1.7e15 world units per pixel —
  // one wheel notch past the end of representable time. Only `0 < fov < 180` catches it.
  // Found by tests/pan.test.ts, which had pinned the gap before this closed it.
  if (
    !(widthPx > 0) ||
    !(aspect > 0) ||
    !Number.isFinite(distance) ||
    !(fovDegrees > 0 && fovDegrees < 180)
  ) {
    return PAN_FALLBACK_WORLD_PER_PIXEL;
  }
  const visibleHeight = 2 * Math.tan((fovDegrees * Math.PI) / 360) * Math.abs(distance);
  const perPixel = (visibleHeight * aspect) / widthPx;
  return perPixel > 0 && Number.isFinite(perPixel) ? perPixel : PAN_FALLBACK_WORLD_PER_PIXEL;
}
