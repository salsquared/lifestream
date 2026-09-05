/**
 * The 3D scene chrome — camera, bloom, starfield, lights — built once (P4.4).
 *
 * The Corridor mounts it in P4 and the Tech Tree mounts the SAME component in P13.1.
 * That is the whole reason it exists: "same as the Corridor" in a later task description
 * is how two scenes drift apart, so there is one canvas, one composer, one starfield and
 * one set of defaults, and a second view differs from the first only by the props it
 * passes. Every number is in {@link resolveSceneSettings}, so the delta between the two
 * views is readable as a diff rather than as two piles of magic numbers.
 *
 * ## What it does NOT own
 *
 * Input. There are no `OrbitControls` here and there never will be: the Corridor's pan
 * is custom (P4.5 — d3-zoom deltas fed into `camera.x`, clamped against the canonical
 * scale) and the Tech Tree's navigation is its own. A control scheme baked into shared
 * chrome would have to be fought by both views. Consequently this component sets the
 * camera's pose ONCE, on mount, and then leaves the camera alone.
 *
 * ## `prefers-reduced-motion`
 *
 * Honoured here, at the chrome level, so both 3D views inherit it rather than each
 * remembering to ask (P4.4.5, contract S5). The policy is resolved once and published on
 * {@link ReducedMotionContext}; the chrome applies it to its own motion (the starfield)
 * and every child — {@link EventNode}'s hover tween today, P8's fly-to later — reads the
 * same value through `useReducedMotion`. Passing `reducedMotion` explicitly overrides
 * the media query, which is what an export render (P15) needs.
 */

import { PerspectiveCamera, Stars } from '@react-three/drei';
import { Canvas, useFrame } from '@react-three/fiber';
import { Bloom, EffectComposer } from '@react-three/postprocessing';
import { useLayoutEffect, useMemo, useRef } from 'react';

import { ReducedMotionContext, useSystemReducedMotion } from './reducedMotion';
import { resolveSceneSettings } from './sceneSettings';

import type {
  CameraPose,
  SceneSettings,
  SceneSettingsInput,
  StarfieldSettings,
} from './sceneSettings';
import type { ReactNode } from 'react';
import type { Group, PerspectiveCamera as PerspectiveCameraImpl } from 'three';

export interface Scene3DProps extends SceneSettingsInput {
  children?: ReactNode;
  /**
   * Overrides the `prefers-reduced-motion` media query for this scene. Leave unset in
   * the app; set it to render deterministically (P15's export renderer).
   */
  reducedMotion?: boolean;
  /**
   * Passed to the `<Canvas>`'s wrapper element. The wrapper is `width: 100%; height:
   * 100%`, so THE HOST MUST HAVE A SIZE — a canvas in an auto-height parent measures
   * zero and renders nothing, with no error.
   */
  className?: string;
}

/**
 * The corridor's ground. Near-black rather than the shell's `--bg` (#14171c): the
 * starfield and the bloom threshold are both calibrated against a dark ground, and a
 * lighter one washes the faint end of the star distribution out entirely. Chrome, not
 * category colour.
 */
const SCENE_BACKGROUND = '#0a0c11';

export function Scene3D({
  children,
  camera,
  bloom,
  stars,
  lighting,
  reducedMotion,
  className,
}: Scene3DProps): React.JSX.Element {
  const systemReducedMotion = useSystemReducedMotion();
  const motion = reducedMotion ?? systemReducedMotion;

  const settings = useMemo(
    () => resolveSceneSettings({ camera, bloom, stars, lighting }, motion),
    [camera, bloom, stars, lighting, motion],
  );

  return (
    <Canvas
      className={className}
      // Always, never `demand`. Reduced motion removes the chrome's own animation
      // (see `resolveSceneSettings`); it must not stop the loop, because P4.5's pan
      // inertia and P8's fly-to both drive the camera from `useFrame` and would have to
      // know to call `invalidate()` — a coupling from a shared component into two views
      // that have not been written yet.
      frameloop="always"
      dpr={[1, 2]}
      gl={{ antialias: true }}
    >
      <color attach="background" args={[SCENE_BACKGROUND]} />
      {/* Inside the canvas on purpose: R3F renders its children through its own
          reconciler root, so a provider mounted around <Canvas> is not guaranteed to be
          visible to them. A provider that IS a scene child always is. */}
      <ReducedMotionContext.Provider value={settings.reducedMotion}>
        <SceneChrome settings={settings} />
        {children}
      </ReducedMotionContext.Provider>
    </Canvas>
  );
}

/** Everything that has to live inside the canvas to use R3F's hooks. */
function SceneChrome({ settings }: { settings: SceneSettings }): React.JSX.Element {
  const { lighting } = settings;
  return (
    <>
      <CameraRig pose={settings.camera} />
      <ambientLight intensity={lighting.ambientIntensity} />
      <directionalLight
        position={lighting.rimPosition}
        intensity={lighting.rimIntensity}
        color={lighting.rimColor}
      />
      {settings.stars !== null && <Starfield settings={settings.stars} />}
      {settings.bloom !== null && (
        <EffectComposer>
          <Bloom
            intensity={settings.bloom.intensity}
            luminanceThreshold={settings.bloom.luminanceThreshold}
            luminanceSmoothing={settings.bloom.luminanceSmoothing}
            mipmapBlur={settings.bloom.mipmapBlur}
          />
        </EffectComposer>
      )}
    </>
  );
}

/**
 * The one camera, posed once.
 *
 * `position` is applied IMPERATIVELY rather than as a prop, and that is not a style
 * choice. R3F re-applies props on every commit, so `<PerspectiveCamera position={…}>`
 * would silently snap the camera back to its initial x on the next render — undoing
 * P4.5's pan every time the view re-rendered for an unrelated reason. Pose is an INITIAL
 * condition here (P4.4.1: "configurable initial pose"); from mount onward the camera
 * belongs to whichever view is driving it.
 *
 * The effect is keyed on the pose's VALUES, not on the object's identity, so a caller
 * passing an inline `{ position: [...] }` literal — which is a new object every render —
 * does not re-pose the camera on every render.
 */
function CameraRig({ pose }: { pose: CameraPose }): React.JSX.Element {
  const cameraRef = useRef<PerspectiveCameraImpl>(null);
  const poseKey = [...pose.position, ...pose.target].join(',');

  useLayoutEffect(() => {
    const cam = cameraRef.current;
    if (cam === null) return;
    cam.position.set(pose.position[0], pose.position[1], pose.position[2]);
    cam.lookAt(pose.target[0], pose.target[1], pose.target[2]);
    cam.updateProjectionMatrix();
    // `poseKey`, not `pose`: see above. `pose` is read inside and is current whenever
    // the key changes, because the key is derived from exactly those numbers.
  }, [poseKey]);

  return (
    <PerspectiveCamera ref={cameraRef} makeDefault fov={pose.fov} near={pose.near} far={pose.far} />
  );
}

/**
 * The starfield, riding the camera.
 *
 * drei's `<Stars>` is a fixed shell around the origin, which is the wrong shape for a
 * corridor the camera travels ~500 world units along: the backdrop would be behind the
 * viewer before the first era ended. The shell therefore follows the camera by
 * `settings.follow` — `1` is a true backdrop with no apparent motion (the reduced-motion
 * setting), and below `1` the lag reads as very distant parallax.
 */
function Starfield({ settings }: { settings: StarfieldSettings }): React.JSX.Element {
  const groupRef = useRef<Group>(null);

  useFrame((state) => {
    const group = groupRef.current;
    if (group === null) return;
    group.position.copy(state.camera.position).multiplyScalar(settings.follow);
  });

  return (
    <group ref={groupRef}>
      <Stars
        radius={settings.radius}
        depth={settings.depth}
        count={settings.count}
        factor={settings.factor}
        saturation={settings.saturation}
        fade={settings.fade}
        speed={settings.speed}
      />
    </group>
  );
}
