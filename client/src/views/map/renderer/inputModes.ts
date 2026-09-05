/**
 * P2.2 — one gesture, one owner.
 *
 * Zoom-pan and drag-to-rotate both want the pointer's drag. Mounting both is the bug this
 * module exists to prevent: two handlers on one pointer stream fight every frame. So there
 * are exactly two attachers here, each a plain DOM-level function with an explicit
 * teardown, and `useInputMode` calls ONE of them — never both — chosen by
 * `gestureOwnerFor(projection)`.
 *
 *   orthographic  -> {@link attachGlobeRotation}: drag writes `projection.rotate()`, wheel
 *                    writes `projection.scale()`, paths are RECOMPUTED, `d3-zoom` is not
 *                    mounted and the wrapping `<g>` carries no transform.
 *   anything else -> {@link attachZoomPan}: `d3-zoom` owns drag and wheel and writes a
 *                    transform onto the wrapping `<g>`; the projection is static and the
 *                    paths are NOT recomputed.
 *
 * ── THE CARRY (P2.2.3) ────────────────────────────────────────────────────────────────
 * The two modes hold incompatible state — a `ZoomTransform` on one side, a rotation and a
 * radius on the other — so neither can be handed to the other directly. {@link ViewCenter}
 * is the currency between them: the geographic point at the middle of the viewport plus a
 * zoom factor, which both modes can produce and both can be seeded from. Switching
 * projection reads it off the outgoing mode and seeds the incoming one, so the view does
 * not jump.
 *
 * Neither attacher touches React. That is deliberate: it makes "is d3-zoom mounted?" a
 * question answerable by calling the function and looking at the node.
 */

import { select } from 'd3-selection';
import { zoom as d3Zoom, zoomIdentity, type D3ZoomEvent, type ZoomTransform } from 'd3-zoom';

import { SCALE_EXTENT, type GlobeCamera } from './projections';

import type { GeoProjection } from 'd3-geo';

/**
 * What the author is looking at, in terms both input modes can express: the geographic
 * point at the centre of the viewport, and how far in they are relative to the whole-world
 * fit. This — not a transform and not a rotation — is what survives a projection switch.
 */
export interface ViewCenter {
  /** Longitude at the viewport centre, degrees, wrapped to (-180, 180]. */
  lon: number;
  /** Latitude at the viewport centre, degrees, clamped to [-90, 90]. */
  lat: number;
  /** Zoom factor relative to the whole-world fit; the `k` of a `ZoomTransform`. */
  k: number;
}

/** The whole world, centred. What the view opens on before anyone has touched it. */
export const INITIAL_VIEW_CENTER: ViewCenter = { lon: 0, lat: 0, k: 1 };

const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

/** Longitude is cyclic, so it wraps; latitude is not, so it clamps. */
const wrapLongitude = (lon: number): number => {
  const wrapped = ((lon + 180) % 360 + 360) % 360 - 180;
  return wrapped === -180 ? 180 : wrapped;
};

const clampScale = (k: number): number => clamp(k, SCALE_EXTENT[0], SCALE_EXTENT[1]);

/**
 * d3-zoom's own wheel response, lifted out so BOTH modes zoom at the same rate. If they
 * did not, the carry across a projection switch would be continuous in position and
 * discontinuous in feel, which is the same complaint P2.2.3 is about.
 */
export function wheelDelta(event: WheelEvent): number {
  return (
    -event.deltaY *
    (event.deltaMode === 1 ? 0.05 : event.deltaMode === 0 ? 0.002 : 1) *
    (event.ctrlKey ? 10 : 1)
  );
}

/* ------------------------------------------------------------------ *
 * ViewCenter <-> the two modes' native state
 * ------------------------------------------------------------------ */

/** The centre a `ZoomTransform` implies, given the static projection under it. */
export function centerFromTransform(
  projection: GeoProjection,
  transform: ZoomTransform,
  width: number,
  height: number,
  fallback: ViewCenter,
): ViewCenter {
  const point = projection.invert?.([
    (width / 2 - transform.x) / transform.k,
    (height / 2 - transform.y) / transform.k,
  ]);
  // `invert` answers null outside the projected world — the corners of a zoomed-out
  // viewport — and a numeric inverse can answer a non-finite pair at a singularity. Either
  // way the previous centre is the honest answer, not a fabricated one.
  if (point == null || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
    return { ...fallback, k: transform.k };
  }
  return { lon: wrapLongitude(point[0]), lat: clamp(point[1], -90, 90), k: transform.k };
}

/** The `ZoomTransform` that puts `center` in the middle of a `width` x `height` viewport. */
export function transformFromCenter(
  projection: GeoProjection,
  center: ViewCenter,
  width: number,
  height: number,
): ZoomTransform {
  const k = clampScale(center.k);
  const point = projection([center.lon, center.lat]);
  if (point == null || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
    return zoomIdentity;
  }
  return zoomIdentity.translate(width / 2 - k * point[0], height / 2 - k * point[1]).scale(k);
}

/** The globe camera pointed at `center`. `rotate` is the negated geographic centre. */
export function cameraFromCenter(center: ViewCenter): GlobeCamera {
  return { rotate: [-center.lon, -center.lat, 0], k: clampScale(center.k) };
}

/** The inverse of {@link cameraFromCenter}. */
export function centerFromCamera(camera: GlobeCamera): ViewCenter {
  return {
    lon: wrapLongitude(-camera.rotate[0]),
    lat: clamp(-camera.rotate[1], -90, 90),
    k: camera.k,
  };
}

/* ------------------------------------------------------------------ *
 * Mode A — d3-zoom (every flat projection)
 * ------------------------------------------------------------------ */

/** d3-zoom stores its transform on the node itself. Not in `SVGSVGElement`, so it is named here. */
type ZoomStateCarrier = { __zoom?: ZoomTransform };

export interface ZoomPanOptions {
  width: number;
  height: number;
  /** The static, already-fitted projection. Read only, to translate transforms into centres. */
  projection: GeoProjection;
  /** Seed — normally derived from the outgoing mode's {@link ViewCenter}. */
  transform: ZoomTransform;
  onTransform(transform: ZoomTransform, center: ViewCenter): void;
}

/**
 * Give the drag and the wheel to `d3-zoom`, writing a transform onto the wrapping `<g>`.
 *
 * Returns the teardown. It removes every listener d3-zoom added AND deletes the `__zoom`
 * property d3-zoom parks on the node: leaving it behind would let `zoomTransform(node)`
 * report a live transform for a node that no longer has a zoom behaviour, which is exactly
 * the "is it still mounted?" ambiguity this task is about.
 */
export function attachZoomPan(node: SVGSVGElement, options: ZoomPanOptions): () => void {
  const { width, height, projection, onTransform } = options;
  let center = centerFromTransform(projection, options.transform, width, height, {
    ...INITIAL_VIEW_CENTER,
    k: options.transform.k,
  });

  const behavior = d3Zoom<SVGSVGElement, unknown>()
    .scaleExtent([SCALE_EXTENT[0], SCALE_EXTENT[1]])
    .extent([
      [0, 0],
      [width, height],
    ])
    .wheelDelta(wheelDelta)
    .on('zoom', (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
      center = centerFromTransform(projection, event.transform, width, height, center);
      onTransform(event.transform, center);
    });

  const selection = select(node);
  selection.call(behavior);
  // Double-click-to-zoom is d3-zoom's default and it is turned off on purpose: a country
  // click toggles grouping membership (P2.3.2), so a double-click would fire that toggle
  // twice while also zooming. One click, one meaning.
  selection.on('dblclick.zoom', null);
  // Seeded through the behaviour rather than by writing `__zoom` directly, so d3-zoom's own
  // state and the transform React renders cannot disagree.
  behavior.transform(selection, options.transform);

  return () => {
    selection.on('.zoom', null);
    delete (node as unknown as ZoomStateCarrier).__zoom;
  };
}

/* ------------------------------------------------------------------ *
 * Mode B — the globe (orthographic only)
 * ------------------------------------------------------------------ */

export interface GlobeRotationOptions {
  /** The fitted radius at `k === 1`, in px. Sets how many degrees a dragged pixel is worth. */
  baseScale: number;
  /** Seed — normally derived from the outgoing mode's {@link ViewCenter}. */
  camera: GlobeCamera;
  onCamera(camera: GlobeCamera, center: ViewCenter): void;
}

/** Movement past this many px counts as a drag, and the click that ends it is swallowed. */
const DRAG_THRESHOLD = 3;

/**
 * Swallow the click that a drag would otherwise produce, the way `d3-drag` does for
 * `d3-zoom`: one capture-phase listener, removed on the next tick.
 */
function suppressNextClick(): void {
  if (typeof window === 'undefined') return;
  const swallow = (event: Event): void => {
    event.stopImmediatePropagation();
  };
  window.addEventListener('click', swallow, true);
  window.setTimeout(() => {
    window.removeEventListener('click', swallow, true);
  }, 0);
}

/**
 * Give the drag and the wheel to the globe: drag rotates the projection, wheel scales it.
 *
 * Longitude is free and wraps; latitude is clamped to ±90 so the globe cannot roll past its
 * own pole (the rotation angle is the negated centre, so clamping `rotate[1]` to ±90 is
 * what clamps the visible centre latitude).
 *
 * `d3-zoom` is deliberately absent. Nothing here writes a transform, so the wrapping `<g>`
 * stays transform-free and every path is recomputed from the mutated projection instead.
 */
export function attachGlobeRotation(node: SVGSVGElement, options: GlobeRotationOptions): () => void {
  const { baseScale, onCamera } = options;
  let camera: GlobeCamera = { rotate: [...options.camera.rotate], k: clampScale(options.camera.k) };

  let pointerId: number | null = null;
  let originX = 0;
  let originY = 0;
  let originRotate: [number, number, number] = [0, 0, 0];
  let moved = false;

  const emit = (): void => {
    onCamera({ rotate: [...camera.rotate], k: camera.k }, centerFromCamera(camera));
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (pointerId !== null || event.button !== 0) return;
    event.preventDefault();
    pointerId = event.pointerId;
    originX = event.clientX;
    originY = event.clientY;
    originRotate = [...camera.rotate];
    moved = false;
    if (typeof node.setPointerCapture === 'function') node.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (pointerId !== event.pointerId) return;
    const dx = event.clientX - originX;
    const dy = event.clientY - originY;
    if (!moved && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) moved = true;

    // One pixel at the centre of a sphere of radius r subtends 1/r radians.
    const degreesPerPixel = 180 / (Math.PI * Math.max(1, baseScale * camera.k));
    camera = {
      rotate: [
        originRotate[0] + dx * degreesPerPixel,
        clamp(originRotate[1] - dy * degreesPerPixel, -90, 90),
        originRotate[2],
      ],
      k: camera.k,
    };
    emit();
  };

  const endDrag = (event: PointerEvent): void => {
    if (pointerId !== event.pointerId) return;
    pointerId = null;
    if (typeof node.releasePointerCapture === 'function' && node.hasPointerCapture(event.pointerId)) {
      node.releasePointerCapture(event.pointerId);
    }
    if (moved) suppressNextClick();
    moved = false;
  };

  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const next = clampScale(camera.k * Math.pow(2, wheelDelta(event)));
    if (next === camera.k) return;
    camera = { rotate: camera.rotate, k: next };
    emit();
  };

  node.addEventListener('pointerdown', onPointerDown);
  node.addEventListener('pointermove', onPointerMove);
  node.addEventListener('pointerup', endDrag);
  node.addEventListener('pointercancel', endDrag);
  // Not passive: the wheel drives the globe's scale, so the page must not also scroll.
  node.addEventListener('wheel', onWheel, { passive: false });

  return () => {
    node.removeEventListener('pointerdown', onPointerDown);
    node.removeEventListener('pointermove', onPointerMove);
    node.removeEventListener('pointerup', endDrag);
    node.removeEventListener('pointercancel', endDrag);
    node.removeEventListener('wheel', onWheel);
  };
}
