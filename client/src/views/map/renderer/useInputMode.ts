/**
 * P2.2 in React terms: mount exactly one gesture owner, tear it down on a projection
 * change, and carry the visual centre across the swap.
 *
 * The hook holds three things and nothing else:
 *
 *   1. `viewCenterRef` — the {@link ViewCenter} the CURRENT mode last reported. It is a ref,
 *      not state, because it is the carry's memory rather than anything rendered: it must
 *      survive the mode switch that replaces the state.
 *   2. `state` — the active mode's own state, a `ZoomTransform` or a {@link GlobeCamera}.
 *      Exactly one of them exists at a time; the union makes "both are mounted" unspellable.
 *   3. one effect, whose body is a single `if` over the gesture owner.
 *
 * The state is re-seeded DURING RENDER when the projection or the viewport changes, not in
 * an effect. That is the difference between switching projections and *jumping*: an effect
 * runs after paint, so a seed applied there would show one frame of the old transform under
 * the new projection.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import {
  attachGlobeRotation,
  attachZoomPan,
  cameraFromCenter,
  centerFromCamera,
  centerFromTransform,
  transformFromCenter,
  INITIAL_VIEW_CENTER,
  type ViewCenter,
} from './inputModes';
import {
  gestureOwnerFor,
  projectionFor,
  type GestureOwner,
  type GlobeCamera,
  type ProjectionId,
} from './projections';

import type { GeoProjection } from 'd3-geo';
import type { RefObject } from 'react';
import type { ZoomTransform } from 'd3-zoom';

/** The active mode's own state. One member per gesture owner — never both. */
export type ModeState =
  | { owner: 'zoom'; transform: ZoomTransform }
  | { owner: 'rotate'; camera: GlobeCamera };

export interface UseInputModeArgs {
  projection: ProjectionId;
  width: number;
  height: number;
  /** The `<svg>` the gestures are read from. Both attachers listen here, never on the `<g>`. */
  svgRef: RefObject<SVGSVGElement | null>;
}

export interface InputModeResult {
  /** Which mode is mounted. `'rotate'` if and only if the projection is orthographic. */
  owner: GestureOwner;
  /**
   * The wrapping `<g>`'s transform. A `translate(...) scale(...)` string under `'zoom'`, and
   * ALWAYS `undefined` under `'rotate'` — React omits the attribute entirely for `undefined`,
   * which is what "the `<g>` carries no transform" means in the rendered DOM.
   */
  groupTransform: string | undefined;
  /** The globe camera the projection is rebuilt from. `undefined` under `'zoom'`. */
  camera: GlobeCamera | undefined;
}

/**
 * Point a fresh mode at `center`. Pure, and exported so the carry can be checked
 * numerically rather than by eye: seeding rotate from a zoom centre and back must land on
 * the same place.
 */
export function seedModeState(
  owner: GestureOwner,
  projection: GeoProjection,
  center: ViewCenter,
  width: number,
  height: number,
): ModeState {
  return owner === 'rotate'
    ? { owner: 'rotate', camera: cameraFromCenter(center) }
    : { owner: 'zoom', transform: transformFromCenter(projection, center, width, height) };
}

export function useInputMode(args: UseInputModeArgs): InputModeResult {
  const { projection: projectionId, width, height, svgRef } = args;

  const owner = gestureOwnerFor(projectionId);
  const key = `${projectionId}|${String(width)}|${String(height)}`;

  /**
   * The projection WITHOUT the camera applied — the flat mode's static projection, and the
   * globe's un-zoomed radius. It is never the one paths are drawn with (that is `WorldMap`'s
   * `projectionFor(..., camera)`); it exists so the two modes can translate between screen
   * space and geography without depending on the camera they are about to replace.
   */
  const staticProjection = useMemo(
    () => projectionFor(projectionId, width, height),
    [projectionId, width, height],
  );

  const viewCenterRef = useRef<ViewCenter>(INITIAL_VIEW_CENTER);

  const [state, setState] = useState<ModeState>(() =>
    seedModeState(owner, staticProjection, viewCenterRef.current, width, height),
  );
  const [seededKey, setSeededKey] = useState(key);

  // Re-seed during render when the projection or the viewport changed. `current` is what
  // this pass renders; the setState pair is what the next pass starts from.
  let current = state;
  if (seededKey !== key) {
    current = seedModeState(owner, staticProjection, viewCenterRef.current, width, height);
    setSeededKey(key);
    setState(current);
  }

  // The effect must not re-run when the mode's state changes — that would remount the
  // gesture owner on every frame of a drag — so it reads the seed from a ref instead of
  // closing over it.
  const seedRef = useRef(current);
  seedRef.current = current;

  useEffect(() => {
    const node = svgRef.current;
    if (node === null) return undefined;

    const seed = seedRef.current;

    // EXACTLY ONE BRANCH RUNS. Each returns its own teardown, so the switch that changes
    // `key` unmounts one owner before the other is attached.
    if (seed.owner === 'rotate') {
      return attachGlobeRotation(node, {
        baseScale: staticProjection.scale(),
        camera: seed.camera,
        onCamera: (camera) => {
          viewCenterRef.current = centerFromCamera(camera);
          setState({ owner: 'rotate', camera });
        },
      });
    }

    return attachZoomPan(node, {
      width,
      height,
      projection: staticProjection,
      transform: seed.transform,
      onTransform: (transform) => {
        viewCenterRef.current = centerFromTransform(
          staticProjection,
          transform,
          width,
          height,
          viewCenterRef.current,
        );
        setState({ owner: 'zoom', transform });
      },
    });
  }, [key, staticProjection, width, height, svgRef]);

  return {
    owner,
    groupTransform: current.owner === 'zoom' ? current.transform.toString() : undefined,
    camera: current.owner === 'rotate' ? current.camera : undefined,
  };
}
