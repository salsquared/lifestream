import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BLOOM,
  DEFAULT_CAMERA_POSE,
  DEFAULT_LIGHTING,
  DEFAULT_STARFIELD,
  resolveSceneSettings,
} from '@client/views/_shared/sceneSettings';

import type { SceneSettingsInput } from '@client/views/_shared/sceneSettings';

/**
 * P4.4 — the shared scene chrome's settings merge (D7 of the P4 review fix contract).
 *
 * ── WHY THIS SPEC EXISTS ─────────────────────────────────────────────────────────────
 * The module's own argument for its shape is that "same as the Corridor" in a task
 * description is how two scenes drift apart, so the defaults are constants and the merge
 * is a function — which makes P13.1's Tech Tree pose "a visible delta against
 * `DEFAULT_CAMERA_POSE` rather than an independent set of magic numbers". That argument
 * only holds if the merge behaves: a partial override that silently dropped the rest of
 * a group would hand the second view a *different* camera while still looking like a
 * one-line delta, and nothing renders differently enough to notice in review.
 *
 * It is also the reduced-motion seam (P4.4.5) — "what does reduced motion actually
 * change" is meant to be answerable by reading one function. So this spec pins the full
 * answer: starfield `speed → 0` and `follow → 1`, and **nothing else**. The tempting
 * additions (drop bloom, switch the frameloop to `demand`) are asserted *not* to happen,
 * because the docstring says dropping the frameloop would silently break P4.5's inertia
 * and P8's fly-to, and a future author would otherwise have only prose stopping them.
 *
 * This file found a real defect — `resolveSceneSettings` handed back the module
 * defaults' own arrays — and carried it as an `it.fails` tripwire until production
 * fixed it in the same review round. Those tests are now ordinary regression guards.
 */

/** Deep-frozen snapshot of a default, to detect a call mutating module state. */
const snapshot = <T>(value: T): string => JSON.stringify(value);

const CAMERA_BEFORE = snapshot(DEFAULT_CAMERA_POSE);
const BLOOM_BEFORE = snapshot(DEFAULT_BLOOM);
const STARFIELD_BEFORE = snapshot(DEFAULT_STARFIELD);
const LIGHTING_BEFORE = snapshot(DEFAULT_LIGHTING);

// ---------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------

describe('resolveSceneSettings merges over the defaults', () => {
  it('returns exactly the defaults for empty input', () => {
    const settings = resolveSceneSettings({}, false);
    expect(settings.camera).toEqual(DEFAULT_CAMERA_POSE);
    expect(settings.bloom).toEqual(DEFAULT_BLOOM);
    expect(settings.stars).toEqual(DEFAULT_STARFIELD);
    expect(settings.lighting).toEqual(DEFAULT_LIGHTING);
    expect(settings.reducedMotion).toBe(false);
  });

  it('keeps every unmentioned field of a group a caller partially overrides', () => {
    // The failure this catches is a `camera: input.camera ?? DEFAULT_CAMERA_POSE`, which
    // reads almost identically and gives the Tech Tree a camera with an undefined `near`
    // and `far`. three.js substitutes its own; the scene renders, wrongly.
    const settings = resolveSceneSettings({ camera: { fov: 70 } }, false);
    expect(settings.camera.fov).toBe(70);
    expect(settings.camera.near).toBe(DEFAULT_CAMERA_POSE.near);
    expect(settings.camera.far).toBe(DEFAULT_CAMERA_POSE.far);
    expect(settings.camera.position).toEqual(DEFAULT_CAMERA_POSE.position);
    expect(settings.camera.target).toEqual(DEFAULT_CAMERA_POSE.target);
  });

  it('overrides each group independently', () => {
    const input: SceneSettingsInput = {
      camera: { position: [100, 0, 60] },
      bloom: { luminanceThreshold: 0.4 },
      stars: { count: 10 },
      lighting: { rimColor: '#ff0000' },
    };
    const settings = resolveSceneSettings(input, false);

    expect(settings.camera.position).toEqual([100, 0, 60]);
    expect(settings.camera.fov).toBe(DEFAULT_CAMERA_POSE.fov);
    expect(settings.bloom?.luminanceThreshold).toBe(0.4);
    expect(settings.bloom?.intensity).toBe(DEFAULT_BLOOM.intensity);
    expect(settings.stars?.count).toBe(10);
    expect(settings.stars?.radius).toBe(DEFAULT_STARFIELD.radius);
    expect(settings.lighting.rimColor).toBe('#ff0000');
    expect(settings.lighting.ambientIntensity).toBe(DEFAULT_LIGHTING.ambientIntensity);
  });

  it('drops a group entirely when the caller passes false', () => {
    // `null` rather than defaults, because the composer is then not mounted at all — the
    // difference between "bloom with intensity 0" and "no post-processing pass".
    expect(resolveSceneSettings({ bloom: false }, false).bloom).toBeNull();
    expect(resolveSceneSettings({ stars: false }, false).stars).toBeNull();
  });

  it('does not confuse `false` with an empty override', () => {
    expect(resolveSceneSettings({ bloom: {} }, false).bloom).toEqual(DEFAULT_BLOOM);
    expect(resolveSceneSettings({ stars: {} }, false).stars).toEqual(DEFAULT_STARFIELD);
  });

  it('is deterministic: the same input yields deep-equal settings every time', () => {
    // "Pure and total" is the docstring's claim, and the reason the policy is an argument.
    const input: SceneSettingsInput = { camera: { fov: 61 }, stars: { speed: 0.7 } };
    expect(resolveSceneSettings(input, false)).toEqual(resolveSceneSettings(input, false));
    expect(resolveSceneSettings(input, true)).toEqual(resolveSceneSettings(input, true));
  });
});

// ---------------------------------------------------------------------------
// Reduced motion
// ---------------------------------------------------------------------------

describe('reduced motion changes the starfield and NOTHING else', () => {
  it('freezes the twinkle and pins the shell to the camera', () => {
    const settings = resolveSceneSettings({}, true);
    expect(settings.stars?.speed).toBe(0);
    expect(settings.stars?.follow).toBe(1);
    expect(settings.reducedMotion).toBe(true);
  });

  it('overrides a caller’s own speed and follow — the policy wins', () => {
    // Reduced motion is a user setting, not a default. A caller asking for drifting stars
    // must not be able to reintroduce the motion for a reader who turned it off.
    const settings = resolveSceneSettings({ stars: { speed: 2, follow: 0.1 } }, true);
    expect(settings.stars?.speed).toBe(0);
    expect(settings.stars?.follow).toBe(1);
  });

  it('leaves every other starfield field alone', () => {
    const motion = resolveSceneSettings({}, true).stars;
    const still = resolveSceneSettings({}, false).stars;
    expect({ ...motion, speed: null, follow: null }).toEqual({
      ...still,
      speed: null,
      follow: null,
    });
  });

  it('does not touch the camera, the bloom or the lights', () => {
    // The explicit non-changes. Dropping bloom under reduced motion is a plausible-looking
    // "accessibility" edit that would change what filtering looks like (§5.2) for reasons
    // unrelated to motion.
    const settings = resolveSceneSettings({}, true);
    expect(settings.camera).toEqual(DEFAULT_CAMERA_POSE);
    expect(settings.bloom).toEqual(DEFAULT_BLOOM);
    expect(settings.lighting).toEqual(DEFAULT_LIGHTING);
  });

  it('still returns null stars when the caller dropped them, rather than resurrecting them', () => {
    // The order of the two decisions matters: `stars: false` then reduced motion must not
    // spread `{ speed: 0, follow: 1 }` onto a `null`.
    expect(resolveSceneSettings({ stars: false }, true).stars).toBeNull();
  });

  it('republishes the policy for the children to read', () => {
    expect(resolveSceneSettings({}, true).reducedMotion).toBe(true);
    expect(resolveSceneSettings({}, false).reducedMotion).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The defaults are module state — the merge must not corrupt them
// ---------------------------------------------------------------------------

describe('the exported defaults survive being merged over', () => {
  it('is not mutated by any of the calls this file has made', () => {
    // Whole-file check, deliberately last-ish: every describe above has already run a
    // merge with reduced motion on and off, with overrides and with `false`.
    expect(snapshot(DEFAULT_CAMERA_POSE)).toBe(CAMERA_BEFORE);
    expect(snapshot(DEFAULT_BLOOM)).toBe(BLOOM_BEFORE);
    expect(snapshot(DEFAULT_STARFIELD)).toBe(STARFIELD_BEFORE);
    expect(snapshot(DEFAULT_LIGHTING)).toBe(LIGHTING_BEFORE);
  });

  it('is not mutated when the CALLER edits the settings it was handed', () => {
    // Scalars are safe: the object spread copies them by value.
    const settings = resolveSceneSettings({}, false);
    settings.camera.fov = 999;
    settings.lighting.ambientIntensity = 999;
    if (settings.bloom) settings.bloom.intensity = 999;
    if (settings.stars) settings.stars.count = 999;

    expect(DEFAULT_CAMERA_POSE.fov).toBe(50);
    expect(DEFAULT_LIGHTING.ambientIntensity).toBe(0.35);
    expect(DEFAULT_BLOOM.intensity).toBe(1.1);
    expect(DEFAULT_STARFIELD.count).toBe(4000);
  });

  it('hands two callers settings objects that are not each other', () => {
    const a = resolveSceneSettings({}, false);
    const b = resolveSceneSettings({}, false);
    expect(a).not.toBe(b);
    expect(a.camera).not.toBe(b.camera);
    expect(a.lighting).not.toBe(b.lighting);
  });

  /**
   * The regression guard for a real defect this spec found and production then fixed.
   *
   * `resolveSceneSettings` merged with a single object spread, and an object spread is
   * SHALLOW: the `position`, `target` and `rimPosition` arrays inside the returned
   * settings WERE the arrays held by `DEFAULT_CAMERA_POSE` and `DEFAULT_LIGHTING` — one
   * set of references shared by every caller in the process. A single
   * `settings.camera.position[2] = 60` in the Tech Tree would have moved the Corridor's
   * default camera for the rest of the session, silently. That is the cross-view drift
   * this module exists to prevent, reintroduced through the one door it did not watch.
   *
   * Both halves of the fix are asserted below, because they guard different callers: the
   * merge copies, so nobody holding a resolved settings object can reach a default; the
   * defaults are frozen, so anybody who reaches past the merge and writes to one directly
   * gets a TypeError instead of silent success.
   */
  it('does not hand back the module defaults’ own arrays', () => {
    const settings = resolveSceneSettings({}, false);
    expect(settings.camera.position).not.toBe(DEFAULT_CAMERA_POSE.position);
    expect(settings.camera.target).not.toBe(DEFAULT_CAMERA_POSE.target);
    expect(settings.lighting.rimPosition).not.toBe(DEFAULT_LIGHTING.rimPosition);
    // Copied, not emptied — the values still have to arrive.
    expect(settings.camera.position).toEqual(DEFAULT_CAMERA_POSE.position);
    expect(settings.lighting.rimPosition).toEqual(DEFAULT_LIGHTING.rimPosition);
  });

  it('gives two callers arrays that are not each other, so a write cannot cross views', () => {
    const a = resolveSceneSettings({}, false);
    const b = resolveSceneSettings({ camera: { fov: 70 } }, false);
    expect(a.camera.position).not.toBe(b.camera.position);

    // The failure this whole pair exists for, driven rather than argued.
    a.camera.position[2] = 60;
    expect(b.camera.position[2]).toBe(40);
    expect(DEFAULT_CAMERA_POSE.position[2]).toBe(40);
    expect(resolveSceneSettings({}, false).camera.position[2]).toBe(40);
  });

  it('copies the CALLER’s tuple too, so a caller cannot reach into a resolved scene', () => {
    const mine: [number, number, number] = [1, 2, 3];
    const settings = resolveSceneSettings({ camera: { position: mine } }, false);
    expect(settings.camera.position).not.toBe(mine);
    mine[0] = 99;
    expect(settings.camera.position[0]).toBe(1);
  });

  it('freezes the defaults, so writing to one throws rather than succeeding quietly', () => {
    expect(Object.isFrozen(DEFAULT_CAMERA_POSE)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CAMERA_POSE.position)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CAMERA_POSE.target)).toBe(true);
    expect(Object.isFrozen(DEFAULT_LIGHTING)).toBe(true);
    expect(Object.isFrozen(DEFAULT_LIGHTING.rimPosition)).toBe(true);
    expect(Object.isFrozen(DEFAULT_BLOOM)).toBe(true);
    expect(Object.isFrozen(DEFAULT_STARFIELD)).toBe(true);

    // Modules are strict mode, so this is a TypeError and not a silent no-op. That is the
    // point of freezing on top of copying: the copy protects consumers of the merge, the
    // freeze protects against anyone who bypasses it.
    expect(() => {
      DEFAULT_CAMERA_POSE.position[2] = 60;
    }).toThrow(TypeError);
    expect(() => {
      DEFAULT_LIGHTING.ambientIntensity = 999;
    }).toThrow(TypeError);
  });
});
