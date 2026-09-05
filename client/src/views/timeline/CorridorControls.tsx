import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';

import { useReducedMotion } from '../_shared';
import { CORRIDOR_DEPTH } from './layout';
import {
  clampPan,
  pushPan,
  stepPan,
  wheelPixels,
  worldPerPixel,
  PAN_FALLBACK_WORLD_PER_PIXEL,
} from './pan';

import type { Camera, PerspectiveCamera } from 'three';
import type { CameraChannel } from './cameraChannel';
import type { PanBounds, PanState } from './pan';

/**
 * The corridor's camera driver — implementation P4.5. Renders nothing; it exists to own
 * the wheel listener and the per-frame integration.
 *
 * **Custom controls, not `OrbitControls`.** The corridor has exactly one degree of
 * freedom in this phase — position along the time axis — and `OrbitControls` would offer
 * orbit, dolly and truck, three of which move the camera off the axis the HUD inverts
 * through. The physics lives in `pan.ts` so it can be exercised without a canvas; this
 * component is the wiring: DOM event in, `camera.position.x` out.
 *
 * The clamp comes from the **canonical** scale's range, padded, computed once by the view
 * and handed down as `bounds` (P4.5, and the canonical-scale decision). It is passed in
 * rather than derived here so that when P7 gives the strata their draw-time parallax
 * multiplier there is still exactly one clamp, expressed in canonical world units.
 */
export interface CorridorControlsProps {
  /** `panBounds(scale)` — the canonical range, padded. */
  bounds: PanBounds;
  /** Where the corridor opens, in world units. Clamped into `bounds`. */
  initialX: number;
  /** Where the camera's x is published for the HUD to read. */
  channel: CameraChannel;
}

/** Narrow R3F's `Camera` to the perspective case without importing three at runtime. */
function asPerspective(camera: Camera): PerspectiveCamera | undefined {
  return (camera as PerspectiveCamera).isPerspectiveCamera
    ? (camera as PerspectiveCamera)
    : undefined;
}

export function CorridorControls({ bounds, initialX, channel }: CorridorControlsProps) {
  const camera = useThree((state) => state.camera);
  const domElement = useThree((state) => state.gl.domElement);
  const width = useThree((state) => state.size.width);
  // From the scene chrome, not from a second `matchMedia` read (P4.4.5). `Scene3D`
  // decides the policy once and publishes it on a context; pan inertia is one of the
  // things `reducedMotion.ts` names as a consumer. A second reader is a second answer.
  const reducedMotion = useReducedMotion();

  const pan = useRef<PanState>({ x: clampPan(initialX, bounds), velocity: 0 });

  // Opening pose, and a re-open whenever the corpus changes the scale underneath us.
  // Only x is touched: the rest of the pose belongs to the shared scene chrome (P4.4.1),
  // and a view that reset the whole camera here would fight it.
  useEffect(() => {
    pan.current = { x: clampPan(initialX, bounds), velocity: 0 };
    camera.position.x = pan.current.x;
    channel.settle(pan.current.x);
  }, [camera, channel, initialX, bounds]);

  useEffect(() => {
    const onWheel = (event: WheelEvent): void => {
      // Non-passive so this can run: without it a horizontal trackpad swipe is a
      // browser back-navigation gesture on the way out of the corridor.
      event.preventDefault();

      const perspective = asPerspective(camera);
      const scale = perspective
        ? worldPerPixel(
            perspective.fov,
            perspective.aspect,
            perspective.position.z - CORRIDOR_DEPTH,
            width,
          )
        : PAN_FALLBACK_WORLD_PER_PIXEL;

      pan.current = pushPan(pan.current, wheelPixels(event) * scale, bounds, !reducedMotion);
    };

    domElement.addEventListener('wheel', onWheel, { passive: false });
    return () => domElement.removeEventListener('wheel', onWheel);
  }, [bounds, camera, domElement, reducedMotion, width]);

  useFrame((_, delta) => {
    const next = stepPan(pan.current, delta, bounds);
    pan.current = next;
    camera.position.x = next.x;

    // While gliding the channel's epsilon gate decides what the HUD hears; once the
    // camera is at rest the exact value is pushed through, so the readout cannot come to
    // a stop a fraction of a day away from where the camera actually is.
    if (next.velocity !== 0) channel.publish(next.x);
    else channel.settle(next.x);
  });

  return null;
}
