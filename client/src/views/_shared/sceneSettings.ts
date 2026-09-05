/**
 * Every number {@link Scene3D} draws with, resolved in one pure function (P4.4).
 *
 * The chrome exists because camera, bloom, starfield and lights are identical in the
 * Corridor and the Tech Tree, and "same as the Corridor" in a task description is how
 * two scenes drift apart (P4.4). The *component* being shared is only half of that: if
 * the defaults lived inside the JSX, the second view would still be free to pass a
 * different bloom threshold by accident and nobody could diff the two scenes. So the
 * defaults are constants, the merge is a function, and both are exported — the Tech
 * Tree's pose in P13.1 is then a visible delta against {@link DEFAULT_CAMERA_POSE}
 * rather than an independent set of magic numbers.
 *
 * It is also the reduced-motion seam. {@link resolveSceneSettings} takes the policy as
 * an argument and returns the settings that policy implies, so "what does reduced
 * motion actually change" is answerable by reading one function instead of hunting for
 * conditionals in a render tree (P4.4.5).
 *
 * ## World units
 *
 * Distances here are the canonical scale's units: `WORLD_UNITS_PER_YEAR = 10`
 * (`@shared/timeScale`), so the whole ~50-year corridor is ~500 units long and two
 * events a fortnight apart sit ~0.38 units apart. The camera defaults are chosen
 * against that, not against an arbitrary unit sphere.
 */

/** Position, aim and frustum of the scene's one camera. */
export interface CameraPose {
  /** World-space camera position. X is time (`timeScale.toX`), Z is depth (§5.2). */
  position: [number, number, number];
  /** What the camera looks at ON MOUNT. Panning (P4.5) owns it from then on. */
  target: [number, number, number];
  fov: number;
  near: number;
  far: number;
}

/** `<Bloom>`'s tuning. Thresholds are props, per P4.4.2. */
export interface BloomSettings {
  intensity: number;
  /** Luminance a fragment must exceed to bloom. The emissive nodes clear it; stars do not. */
  luminanceThreshold: number;
  luminanceSmoothing: number;
  mipmapBlur: boolean;
}

/** drei `<Stars>`, plus the one knob drei does not have. */
export interface StarfieldSettings {
  radius: number;
  depth: number;
  count: number;
  factor: number;
  saturation: number;
  fade: boolean;
  /** drei's own twinkle rate. `0` freezes it. */
  speed: number;
  /**
   * How much of the camera's motion the starfield copies each frame, `0`..`1`.
   *
   * NOT a drei prop — drei's `<Stars>` is a fixed shell around the origin, which is
   * wrong for a corridor the camera flies 500 units along: the backdrop would be left
   * behind within the first era. `1` pins the shell to the camera (a true backdrop,
   * no apparent motion); below `1` the stars lag slightly and read as very distant
   * parallax. Reduced motion forces `1`.
   */
  follow: number;
}

/** Soft ambient + one rim light (P4.4.4). */
export interface LightingSettings {
  ambientIntensity: number;
  rimIntensity: number;
  rimPosition: [number, number, number];
  rimColor: string;
}

/** The fully-resolved scene. No optional members: everything downstream reads a number. */
export interface SceneSettings {
  camera: CameraPose;
  /** `null` when the caller turned bloom off — the composer is then not mounted at all. */
  bloom: BloomSettings | null;
  /** `null` when the caller turned the starfield off. */
  stars: StarfieldSettings | null;
  lighting: LightingSettings;
  /** The policy the settings above were resolved under, republished for the children. */
  reducedMotion: boolean;
}

/**
 * What a caller may hand {@link Scene3D}. Each group is a partial override of its
 * default, or `false` to drop that piece of chrome entirely.
 */
export interface SceneSettingsInput {
  camera?: Partial<CameraPose>;
  bloom?: Partial<BloomSettings> | false;
  stars?: Partial<StarfieldSettings> | false;
  lighting?: Partial<LightingSettings>;
}

/**
 * Looking down −Z at the XY plane, NOT along the time axis.
 *
 * P4.4.1 says "looking down the time axis", which reads naturally but contradicts every
 * other statement about this camera: P4.5 pans by feeding deltas into `camera.x`, and
 * architecture §5.2 makes the camera's **z** the abstraction axis that drives each
 * stratum's opacity envelope. A camera aimed along X would have to pan by translating
 * its own view direction and would have no z left to spend on depth. So: X is time and
 * the camera moves along it, Z is depth and the camera looks down it. The pose is a
 * prop, so a view that genuinely wants the other framing can still ask for it.
 *
 * `z = 40` with a 50° fov shows ~6.5 years of corridor across a 16:9 pane — dense
 * enough that an era reads as a shape, open enough that individual nodes are separable.
 */
export const DEFAULT_CAMERA_POSE: CameraPose = {
  position: [0, 0, 40],
  target: [0, 0, 0],
  fov: 50,
  near: 0.5,
  // The corridor is ~500 units long and the starfield shell rides the camera, so this
  // only has to cover the far end of the shell, not the whole world.
  far: 2000,
};

/**
 * Tuned for emissive nodes on a near-black ground.
 *
 * `luminanceThreshold` is the load-bearing one: at `0.25` a `normal` node's emissive halo
 * blooms and a filtered-out one does not, which is what makes filtering legible
 * (§5.2 — filters fade, they never remove).
 *
 * "Filtered out" is `EventNode`'s `dimmed` prop, NOT a state — there is no `'faded'` node
 * state and there must not be one, because glow and filtering are orthogonal (§5.2) and a
 * single enum cannot say both. `eventNodeVisual` scales a dimmed node's emissive by
 * `DIMMED_EMISSIVE`, and this threshold is the other half of that pair: raising it or
 * lowering `DIMMED_EMISSIVE` changes what a filtered node looks like, so the two are tuned
 * together or not at all.
 */
export const DEFAULT_BLOOM: BloomSettings = {
  intensity: 1.1,
  luminanceThreshold: 0.25,
  luminanceSmoothing: 0.9,
  mipmapBlur: true,
};

/** A shell that rides the camera, so it is a backdrop rather than an object at x = 0. */
export const DEFAULT_STARFIELD: StarfieldSettings = {
  radius: 120,
  depth: 60,
  count: 4000,
  factor: 3,
  saturation: 0,
  fade: true,
  speed: 0.4,
  follow: 0.92,
};

/** Enough ambient to keep an unlit hemisphere readable; one cool rim to give the spheres form. */
export const DEFAULT_LIGHTING: LightingSettings = {
  ambientIntensity: 0.35,
  rimIntensity: 1.1,
  rimPosition: [-30, 40, 60],
  rimColor: '#9fd0ff',
};

// ---------------------------------------------------------------------------
// The defaults are frozen, and the merge below copies their tuples
//
// `resolveSceneSettings` merges with an object spread, and an object spread is SHALLOW:
// the tuple inside a spread default is the SAME array the default holds. Every caller in
// the process therefore shared one `position`, one `target` and one `rimPosition`, so a
// single `settings.camera.position[2] = 60` anywhere — P13's Tech Tree, say — would have
// moved the Corridor's default camera for the rest of the session, with nothing raised
// anywhere. That is precisely the cross-view drift this module exists to prevent,
// arriving through the one door the module was not watching. Found by
// `tests/sceneSettings.test.ts`.
//
// Both halves are needed and they guard different people. The COPY in the merge means no
// consumer of a resolved settings object can reach a default at all. The FREEZE means a
// caller that reaches past the merge and writes to a default directly
// (`DEFAULT_LIGHTING.rimPosition[0] = 5`) gets a TypeError rather than silent success —
// module code is strict mode, so a write to a frozen array throws. `timeScale.ts` freezes
// its `range()` and `domain()` tuples for the same reason.
//
// Frozen in place rather than via `Object.freeze(...)` at the declaration, so the exported
// types stay `CameraPose` and `LightingSettings` rather than becoming `Readonly<...>` and
// forcing every consumer to widen.
// ---------------------------------------------------------------------------
Object.freeze(DEFAULT_CAMERA_POSE.position);
Object.freeze(DEFAULT_CAMERA_POSE.target);
Object.freeze(DEFAULT_CAMERA_POSE);
Object.freeze(DEFAULT_BLOOM);
Object.freeze(DEFAULT_STARFIELD);
Object.freeze(DEFAULT_LIGHTING.rimPosition);
Object.freeze(DEFAULT_LIGHTING);

/**
 * Copy a 3-tuple.
 *
 * Written out rather than `[...tuple]` because spreading a tuple into an array literal
 * widens it to `number[]`, which does not satisfy `[number, number, number]`.
 */
const copy3 = (v: readonly [number, number, number]): [number, number, number] => [
  v[0],
  v[1],
  v[2],
];

/**
 * Merge the caller's overrides onto the defaults, then apply the motion policy.
 *
 * Pure and total: same input, same settings, no reads of `window` (the policy is an
 * argument precisely so this function has no opinion about where it came from).
 *
 * ## What reduced motion changes here
 *
 * Only motion that the scene generates on its own, which at this phase is the
 * starfield: `speed → 0` stops the twinkle and `follow → 1` pins the shell to the
 * camera so panning produces no apparent star drift. Nothing else in the chrome moves.
 * Deliberately unchanged: the frameloop stays `always` and bloom stays on. Dropping to
 * `frameloop="demand"` would look like a saving and would silently break P4.5's pan
 * inertia and P8's fly-to, both of which drive the camera from `useFrame` and would
 * need an `invalidate()` they do not know to call.
 */
export function resolveSceneSettings(
  input: SceneSettingsInput,
  reducedMotion: boolean,
): SceneSettings {
  const stars = input.stars === false ? null : { ...DEFAULT_STARFIELD, ...(input.stars ?? {}) };

  const camera = { ...DEFAULT_CAMERA_POSE, ...(input.camera ?? {}) };
  const lighting = { ...DEFAULT_LIGHTING, ...(input.lighting ?? {}) };

  return {
    // The tuples are copied, never passed through — see the note above the freezes. This
    // also copies a tuple the CALLER supplied, which is the same courtesy in reverse: a
    // caller that keeps a reference to the array it passed in cannot reach into a
    // resolved scene afterwards.
    camera: { ...camera, position: copy3(camera.position), target: copy3(camera.target) },
    bloom: input.bloom === false ? null : { ...DEFAULT_BLOOM, ...(input.bloom ?? {}) },
    stars: stars === null ? null : reducedMotion ? { ...stars, speed: 0, follow: 1 } : stars,
    lighting: { ...lighting, rimPosition: copy3(lighting.rimPosition) },
    reducedMotion,
  };
}
