/**
 * The projection registry (P2.1.3) — the six projections the sidebar's picker offers, and
 * the one place that decides which gesture owner each of them mounts (P2.2).
 *
 * ── WHY THREE PROJECTIONS ARE DEFINED HERE RATHER THAN IMPORTED ───────────────────────
 * `d3-geo` ships Equal-Earth, Mercator and orthographic. Natural Earth II, Robinson and
 * Winkel Tripel live in `d3-geo-projection`, which is NOT a dependency of this workspace
 * and could not be added without an install. They are therefore built on `geoProjection()`
 * — d3-geo's own public factory for exactly this — from their published raw forms, each
 * cited below. Nothing about the rest of the renderer changes if `d3-geo-projection` is
 * added later: swap the three `create()` bodies and delete the raw functions.
 *
 * ── WHY THE INVERSES ARE NUMERIC ──────────────────────────────────────────────────────
 * A raw projection needs an `invert` for `projection.invert()` to exist, and the renderer
 * needs `projection.invert()` for exactly one thing: reading the geographic point under
 * the centre of the viewport when the author switches away from a flat projection (P2.2.3,
 * "carry the visual centre across"). The published closed-form inverses for these three
 * are iterative anyway, so {@link numericInvert} solves the same equation generically with
 * a damped Newton step rather than transcribing three sets of constants that cannot be
 * checked by eye. It runs on a projection switch, not per frame.
 */

import {
  geoEqualEarth,
  geoMercator,
  geoOrthographic,
  geoProjection,
  type GeoProjection,
  type GeoRawProjection,
  type GeoSphere,
} from 'd3-geo';

/** The projection ids the container's picker and the URL may use. Pinned by the P2 contract. */
export type ProjectionId =
  | 'equalEarth'
  | 'mercator'
  | 'naturalEarth2'
  | 'robinson'
  | 'winkel3'
  | 'orthographic';

/**
 * Which input mode a projection mounts (P2.2). There are two and they are MUTUALLY
 * EXCLUSIVE: `'zoom'` gives the drag and the wheel to `d3-zoom`, which writes a transform
 * onto the wrapping `<g>` and leaves the projection alone; `'rotate'` gives them to the
 * globe controller, which writes `projection.rotate()` / `projection.scale()` and leaves
 * the `<g>` with no transform at all. Two owners on one pointer stream fight every frame,
 * so the mapping below is the single place the choice is made.
 */
export type GestureOwner = 'zoom' | 'rotate';

/** Where the orthographic globe is pointed, and how far in. Meaningless for a flat projection. */
export interface GlobeCamera {
  /** `projection.rotate()` in degrees — the geographic centre is `[-rotate[0], -rotate[1]]`. */
  rotate: [number, number, number];
  /** Zoom factor relative to the whole-world fit; the same `k` a `ZoomTransform` carries. */
  k: number;
}

/** One entry of the registry. `create()` returns a FRESH projection — d3 projections are mutable. */
export interface ProjectionEntry {
  id: ProjectionId;
  /** Sidebar label. The picker is the container's (P2.4.5); the vocabulary is the renderer's. */
  label: string;
  gesture: GestureOwner;
  create(): GeoProjection;
}

const HALF_PI = Math.PI / 2;

/** `{ type: 'Sphere' }` — the whole world, which every projection is fitted against. */
export const SPHERE: GeoSphere = { type: 'Sphere' };

/**
 * Zoom range shared by BOTH input modes, so a `k` carried across a projection switch means
 * the same thing on either side of it and never has to be clamped mid-carry (which would
 * read as the jump P2.2.3 exists to prevent).
 */
export const SCALE_EXTENT: readonly [number, number] = [0.8, 40];

/** Inset of the fitted world inside the viewport, in px. Keeps the sphere's stroke off the edge. */
const FIT_PADDING = 4;

/** `fitExtent` divides by the extent, so a zero-sized viewport (pre-measurement) must not reach it. */
const MIN_VIEWPORT = 16;

/* ------------------------------------------------------------------ *
 * Raw projections d3-geo does not ship
 * ------------------------------------------------------------------ */

/** A raw forward projection: radians in, unit-square-ish coordinates out. */
type RawForward = (lambda: number, phi: number) => [number, number];

/*
 * WHY THESE THREE ARE HAND-BUILT, AND WHY THAT IS THE RIGHT CALL (settled 2026-09-05)
 *
 * `d3-geo` ships Equal-Earth, Mercator and orthographic. Natural Earth II, Robinson and
 * Winkel Tripel live in `d3-geo-projection`, so the obvious move is to add that dependency
 * and delete the three raw forms below.
 *
 * It was tried and reverted. `d3-geo-projection@4` ships **no type declarations** and
 * `@types/d3-geo-projection` **does not exist on the registry**. Adopting it therefore means
 * hand-writing and maintaining an ambient declaration for someone else's untyped API —
 * trading three verified, fully-typed functions for an untyped dependency plus a shim.
 *
 * These implementations are checked against published values (Winkel equator half-width
 * (pi+2)/2; Robinson X = 1.0 at the equator, 0.8962 at 45 degrees, 0.5322 at the pole;
 * Natural Earth II pole height 1.4243) and by 595-point invert round-trips to under 1e-8
 * degrees. If `@types/d3-geo-projection` ever ships, swapping is three `create()` bodies.
 */

/**
 * Natural Earth II (Šavrič, Patterson & Jenny 2015) — the published polynomial, the same
 * one `d3-geo-projection`'s `naturalEarth2Raw` evaluates.
 */
const naturalEarth2Raw: RawForward = (lambda, phi) => {
  const phi2 = phi * phi;
  const phi4 = phi2 * phi2;
  const phi6 = phi2 * phi4;
  return [
    lambda *
      (0.84719 -
        0.13063 * phi2 +
        phi6 * phi6 * (-0.04515 + 0.05494 * phi2 - 0.02326 * phi4 + 0.00331 * phi6)),
    phi * (1.01183 + phi4 * phi4 * (-0.02625 + 0.01926 * phi2 - 0.00396 * phi4)),
  ];
};

/**
 * Robinson's interpolation table, at 5° of latitude per row. Row `i` is latitude
 * `(i - 1) * 5°` — the leading row is the mirrored -5° entry the quadratic interpolation
 * near the equator reads, and the last is the pole. The Y column carries Robinson's
 * published values, scaled by {@link ROBINSON_Y_SCALE} on the way into
 * {@link ROBINSON_TABLE}.
 */
const ROBINSON_SOURCE: ReadonlyArray<readonly [number, number]> = [
  [0.9986, -0.062],
  [1.0, 0.0],
  [0.9986, 0.062],
  [0.9954, 0.124],
  [0.99, 0.186],
  [0.9822, 0.248],
  [0.973, 0.31],
  [0.96, 0.372],
  [0.9427, 0.434],
  [0.9216, 0.4958],
  [0.8962, 0.5571],
  [0.8679, 0.6176],
  [0.835, 0.6769],
  [0.7986, 0.7346],
  [0.7597, 0.7903],
  [0.7186, 0.8435],
  [0.6732, 0.8936],
  [0.6213, 0.9394],
  [0.5722, 0.9761],
  [0.5322, 1.0],
];

/** Robinson's own Y values, scaled so `y = ±π/2 · Y` puts the pole line where d3 wants it. */
const ROBINSON_Y_SCALE = 1.0144;

const ROBINSON_TABLE: ReadonlyArray<readonly [number, number]> = ROBINSON_SOURCE.map(
  (row): readonly [number, number] => [row[0], row[1] * ROBINSON_Y_SCALE],
);

/** Row `i` of {@link ROBINSON_TABLE}, clamped — `noUncheckedIndexedAccess` is on. */
const robinsonRow = (index: number): readonly [number, number] => {
  const row = ROBINSON_TABLE[Math.max(0, Math.min(ROBINSON_TABLE.length - 1, index))];
  // Unreachable: the index is clamped into a non-empty constant table.
  return row ?? [1, 0];
};

/** Robinson (1974), evaluated by the same quadratic interpolation d3-geo-projection uses. */
const robinsonRaw: RawForward = (lambda, phi) => {
  const i = Math.min(18, (Math.abs(phi) * 36) / Math.PI);
  const i0 = Math.floor(i);
  const di = i - i0;
  const [ax, ay] = robinsonRow(i0);
  const [bx, by] = robinsonRow(i0 + 1);
  const [cx, cy] = robinsonRow(i0 + 2);
  return [
    lambda * (bx + (di * (cx - ax)) / 2 + (di * di * (cx - 2 * bx + ax)) / 2),
    (phi > 0 ? HALF_PI : -HALF_PI) *
      (by + (di * (cy - ay)) / 2 + (di * di * (cy - 2 * by + ay)) / 2),
  ];
};

/** `x / sin x`, continuous at 0. */
const sinci = (x: number): number => (x === 0 ? 1 : x / Math.sin(x));

/** `Math.acos` with the argument clamped, so floating-point drift past ±1 cannot produce NaN. */
const safeAcos = (x: number): number => (x > 1 ? 0 : x < -1 ? Math.PI : Math.acos(x));

/** Aitoff (1889) — Winkel Tripel's other half. */
const aitoffRaw: RawForward = (lambda, phi) => {
  const halfLambda = lambda / 2;
  const cosPhi = Math.cos(phi);
  const s = sinci(safeAcos(cosPhi * Math.cos(halfLambda)));
  return [2 * cosPhi * Math.sin(halfLambda) * s, Math.sin(phi) * s];
};

/**
 * Winkel Tripel (1921) — the arithmetic mean of Aitoff and an equirectangular whose
 * standard parallel is `acos(2/π)`, i.e. `x = λ/(π/2)`. Equator half-length is `(π + 2)/2`.
 */
const winkel3Raw: RawForward = (lambda, phi) => {
  const [ax, ay] = aitoffRaw(lambda, phi);
  return [(ax + lambda / HALF_PI) / 2, (ay + phi) / 2];
};

/* ------------------------------------------------------------------ *
 * Generic inverse
 * ------------------------------------------------------------------ */

const INVERT_ITERATIONS = 40;
const INVERT_TOLERANCE = 1e-10;
/** Finite-difference step for the Jacobian, in radians. */
const INVERT_EPSILON = 1e-7;
/** Largest step one Newton iteration may take, in radians. Damping, so a bad Jacobian cannot bolt. */
const INVERT_MAX_STEP = 0.5;

const dampen = (step: number): number =>
  step > INVERT_MAX_STEP ? INVERT_MAX_STEP : step < -INVERT_MAX_STEP ? -INVERT_MAX_STEP : step;

/**
 * A numeric inverse for `forward`, by damped Newton iteration on a finite-difference
 * Jacobian, seeded from the projection's own equator width and pole height.
 *
 * Points outside the projected world (the corners of a zoomed-out viewport, say) have no
 * inverse; iteration is capped and `phi` is held inside ±π/2, so those return the nearest
 * representable edge rather than diverging. The single caller — the viewport centre at a
 * projection switch — clamps the result anyway.
 */
function numericInvert(forward: RawForward): (x: number, y: number) => [number, number] {
  const equatorHalfWidth = forward(Math.PI, 0)[0];
  const poleHeight = forward(0, HALF_PI)[1];

  return (x, y) => {
    let lambda = equatorHalfWidth === 0 ? x : (x * Math.PI) / equatorHalfWidth;
    let phi = poleHeight === 0 ? y : (y * HALF_PI) / poleHeight;

    for (let step = 0; step < INVERT_ITERATIONS; step += 1) {
      const [fx, fy] = forward(lambda, phi);
      const dx = fx - x;
      const dy = fy - y;
      if (Math.abs(dx) < INVERT_TOLERANCE && Math.abs(dy) < INVERT_TOLERANCE) break;

      const [fx1, fy1] = forward(lambda + INVERT_EPSILON, phi);
      const [fx2, fy2] = forward(lambda, phi + INVERT_EPSILON);
      const a = (fx1 - fx) / INVERT_EPSILON;
      const b = (fx2 - fx) / INVERT_EPSILON;
      const c = (fy1 - fy) / INVERT_EPSILON;
      const d = (fy2 - fy) / INVERT_EPSILON;
      const det = a * d - b * c;
      if (!Number.isFinite(det) || Math.abs(det) < 1e-12) break;

      lambda -= dampen((d * dx - b * dy) / det);
      phi -= dampen((a * dy - c * dx) / det);
      if (phi > HALF_PI) phi = HALF_PI;
      else if (phi < -HALF_PI) phi = -HALF_PI;
    }

    return [lambda, phi];
  };
}

/** Pair a raw forward with its numeric inverse, in the shape `geoProjection()` wants. */
const invertible = (forward: RawForward): GeoRawProjection =>
  Object.assign(forward, { invert: numericInvert(forward) });

/* ------------------------------------------------------------------ *
 * The registry
 * ------------------------------------------------------------------ */

/**
 * The six projections, in picker order. Equal-Earth is the default (P2.1.3).
 *
 * `gesture` is the only field the input-mode layer reads, and `'rotate'` appears exactly
 * once. Adding a seventh projection therefore cannot forget to declare an owner: the
 * record is total over `ProjectionId` and `tsc` says so.
 */
export const PROJECTIONS: Readonly<Record<ProjectionId, ProjectionEntry>> = {
  equalEarth: {
    id: 'equalEarth',
    label: 'Equal Earth',
    gesture: 'zoom',
    create: () => geoEqualEarth(),
  },
  mercator: { id: 'mercator', label: 'Mercator', gesture: 'zoom', create: () => geoMercator() },
  naturalEarth2: {
    id: 'naturalEarth2',
    label: 'Natural Earth II',
    gesture: 'zoom',
    create: () => geoProjection(invertible(naturalEarth2Raw)).scale(175.295),
  },
  robinson: {
    id: 'robinson',
    label: 'Robinson',
    gesture: 'zoom',
    create: () => geoProjection(invertible(robinsonRaw)).scale(152.63),
  },
  winkel3: {
    id: 'winkel3',
    label: 'Winkel Tripel',
    gesture: 'zoom',
    create: () => geoProjection(invertible(winkel3Raw)).scale(158.837),
  },
  orthographic: {
    id: 'orthographic',
    label: 'Orthographic (globe)',
    gesture: 'rotate',
    // geoOrthographic() already clips at 90°, so the far hemisphere never draws.
    create: () => geoOrthographic(),
  },
};

/** Picker order. */
export const PROJECTION_IDS: readonly ProjectionId[] = [
  'equalEarth',
  'mercator',
  'naturalEarth2',
  'robinson',
  'winkel3',
  'orthographic',
];

/** The default projection (P2.1.3). */
export const DEFAULT_PROJECTION: ProjectionId = 'equalEarth';

/** Narrow an arbitrary string — a URL parameter, a stored preference — to a `ProjectionId`. */
export function isProjectionId(value: string): value is ProjectionId {
  return Object.prototype.hasOwnProperty.call(PROJECTIONS, value);
}

/** Which input mode `id` mounts. The whole of P2.2's decision, in one lookup. */
export function gestureOwnerFor(id: ProjectionId): GestureOwner {
  return PROJECTIONS[id].gesture;
}

/**
 * The projection the renderer draws with — and the ONLY input the path generator takes,
 * which is what makes "paths are not recomputed under a zoom transform" structural rather
 * than a promise: a `ZoomTransform` cannot reach this function, because it is not one of
 * the parameters.
 *
 * `camera` is consulted only when `id`'s gesture owner is `'rotate'`; for every flat
 * projection it is ignored, so a flat projection built twice with different cameras is the
 * same projection.
 */
export function projectionFor(
  id: ProjectionId,
  width: number,
  height: number,
  camera?: GlobeCamera,
): GeoProjection {
  const projection = PROJECTIONS[id].create();
  const w = Math.max(width, MIN_VIEWPORT);
  const h = Math.max(height, MIN_VIEWPORT);
  projection.fitExtent(
    [
      [FIT_PADDING, FIT_PADDING],
      [w - FIT_PADDING, h - FIT_PADDING],
    ],
    SPHERE,
  );

  if (gestureOwnerFor(id) !== 'rotate' || camera === undefined) return projection;

  // Orthographic scales about `translate`, which `fitExtent` has just put at the centre of
  // the viewport, so the globe zooms around its own middle and the rotation does not move it.
  return projection.rotate(camera.rotate).scale(projection.scale() * camera.k);
}
