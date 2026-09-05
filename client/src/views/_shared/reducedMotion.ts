/**
 * `prefers-reduced-motion`, read once at the chrome level (P4.4.5).
 *
 * The whole point of putting it here is that neither 3D view has to remember it.
 * {@link Scene3D} reads the media query, decides the scene's motion policy, and
 * publishes the answer on {@link ReducedMotionContext}; everything inside the canvas —
 * {@link EventNode}'s hover tween today, P8's camera fly-to and P4.5's pan inertia
 * later — asks {@link useReducedMotion} rather than querying the browser again. A
 * second reader is a second answer, and the two drift the first time one of them is
 * given an override.
 *
 * The default OUTSIDE a provider is the live media query, not `false`. A component
 * rendered in isolation (a test, a Storybook-shaped harness, a future 2D reuse) then
 * still honours the user's setting instead of silently opting them into motion.
 */

import { createContext, useContext, useSyncExternalStore } from 'react';

/** The one media query. Declared once so the subscribe and the read cannot disagree. */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Read the media query right now.
 *
 * Guarded because the shared 3D components are imported by non-DOM environments — the
 * export renderer (P15) and any headless check — where `matchMedia` does not exist.
 * The safe answer there is `false`: an environment with no display has no motion to
 * reduce, and returning `true` would make a screenshot renderer emit the reduced-motion
 * variant of the scene.
 */
export function readSystemReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/**
 * Subscribe to changes of the media query. Exported alongside the read so
 * {@link useSystemReducedMotion} can hand both to `useSyncExternalStore` and so a test
 * can drive them without a React tree.
 */
export function subscribeSystemReducedMotion(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const list = window.matchMedia(REDUCED_MOTION_QUERY);
  list.addEventListener('change', onChange);
  return () => {
    list.removeEventListener('change', onChange);
  };
}

/**
 * The live system preference, re-rendering when the user changes it mid-session.
 *
 * `useSyncExternalStore` rather than `useState` + an effect: the value is read during
 * render from the same source the subscription watches, so there is no first frame
 * drawn with the wrong policy.
 */
export function useSystemReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeSystemReducedMotion,
    readSystemReducedMotion,
    // Server / non-DOM snapshot. Same reasoning as the guard above.
    () => false,
  );
}

/**
 * The scene's motion policy. `undefined` means "no scene above me" — see
 * {@link useReducedMotion}, which falls back to the live query rather than to a
 * hard-coded `false`.
 */
export const ReducedMotionContext = createContext<boolean | undefined>(undefined);

/**
 * What every component inside a scene calls. Returns the policy {@link Scene3D}
 * published, or the live system preference when there is no scene above.
 *
 * Both hooks are called unconditionally — the fallback is chosen from their values, not
 * by branching on which hook to run.
 */
export function useReducedMotion(): boolean {
  const fromScene = useContext(ReducedMotionContext);
  const fromSystem = useSystemReducedMotion();
  return fromScene ?? fromSystem;
}
