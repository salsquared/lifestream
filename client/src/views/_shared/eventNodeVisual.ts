/**
 * Everything {@link EventNode} decides, as pure functions (P4.3.3, P4.3.5).
 *
 * The component is a mapping from these numbers to JSX and nothing else. That split is
 * not decoration: a node's appearance is the one part of a 3D component that can be
 * asserted without a GPU, and keeping it here means "does `focused` actually look
 * different from `normal`" is a unit test rather than a screenshot.
 *
 * ## The palette is not ours
 *
 * Colour comes from `CATEGORY_COLOR` in `@shared/colors` (P4.3.6) — one source for both
 * 3D views and the export renderer. This module must never hold a hex string for a
 * category: a second palette is exactly the drift that task exists to prevent, and the
 * export renderer would be the one place it showed up, long after anyone was looking.
 */

import { CATEGORY_COLOR } from '@shared/colors';

import type { Category } from '@shared/types/index';

/**
 * How the caller says a node should read. Pinned by P4.3.1 — the component takes this,
 * not a bag of booleans.
 *
 * - `normal` — in the corridor, nothing selected that concerns it.
 * - `focused` — the selection's `primary` (§6). Brightest, largest, always labelled.
 * - `glow` — in the derived `glow.eventIds` set. Additive halo, per §5.2.
 * Filtering is NOT a state — it is the orthogonal `dimmed` flag, because a node can be
 * glowing and filtered out at once and must look like both (§5.2).
 *   never remove, or the corridor reflows on every keystroke and the time axis lies
 *   about density (§5.2).
 *
 * **A known gap, and the caller has to resolve it.** §5.2 says glow and filtering are
 * *orthogonal* — "a node can be both glowing and filtered out, and it should look like
 * exactly that". This four-member enum cannot say that, and it is what P4.3.1 pins, so
 * the component honours the pin and the caller picks a precedence. Nothing here can fix
 * it; a faithful rendering needs the props to carry glow and dim separately.
 */
export type EventNodeState = 'normal' | 'focused' | 'glow';

/** The resolved appearance of one node. Every field is consumed by exactly one JSX prop. */
export interface EventNodeVisual {
  /** `CATEGORY_COLOR[category]`, unchanged by state — state moves brightness, never hue. */
  color: string;
  /** Multiplies {@link EVENT_NODE_RADIUS}. `focused` is bigger; `faded` is not smaller. */
  radiusScale: number;
  emissiveIntensity: number;
  /** Sphere opacity. Below `1` only for `faded`. */
  opacity: number;
  /** Additive halo strength. `0` means the halo mesh is not rendered at all. */
  haloOpacity: number;
  /** Label fill opacity. Coupled to the node so a faded node's text fades with it. */
  labelOpacity: number;
}

/**
 * Base sphere radius in world units.
 *
 * Sized against the canonical scale, where a year is 10 units (`@shared/timeScale`):
 * two events a fortnight apart are ~0.38 units apart, so a radius much above this makes
 * a dense month a solid bar. Density beyond that is the cluster stratum's job (P7), not
 * the node's.
 */
export const EVENT_NODE_RADIUS = 0.35;

/** Halo radius as a multiple of the (already state-scaled) sphere radius. */
export const EVENT_NODE_HALO_SCALE = 2.1;

/** How much bigger a hovered node gets. The tween toward it is {@link approachScale}. */
export const HOVER_SCALE = 1.25;

/**
 * Hover tween length in seconds. `0` under reduced motion, which {@link approachScale}
 * reads as "snap" rather than as a division by zero.
 */
export const HOVER_TWEEN_SECONDS = 0.16;

const VISUALS: Readonly<Record<EventNodeState, Omit<EventNodeVisual, 'color'>>> = {
  normal: {
    radiusScale: 1,
    emissiveIntensity: 0.55,
    opacity: 1,
    haloOpacity: 0,
    labelOpacity: 0.75,
  },
  focused: {
    radiusScale: 1.3,
    emissiveIntensity: 2.4,
    opacity: 1,
    haloOpacity: 0.55,
    labelOpacity: 1,
  },
  glow: {
    radiusScale: 1.1,
    emissiveIntensity: 1.5,
    opacity: 1,
    haloOpacity: 0.35,
    labelOpacity: 0.95,
  },
};

/**
 * The whole visual decision, in one total function over the two inputs that drive it.
 *
 * Total over both closed enums: `Record<EventNodeState, …>` and `CATEGORY_COLOR`'s
 * `Record<Category, string>` both fail to compile if a member is added without an
 * answer here, which is the same guarantee the palette contract asks for (S2).
 */
/**
 * The multiplier a filtered-out node's opacities are scaled by.
 *
 * SUBTRACTIVE, and applied on top of whatever the state says — that is the whole point.
 * §5.2: "Glow is additive (a halo on glow.eventIds); filtering is subtractive (opacity down
 * on non-matches). A node can be both glowing and filtered out, and it should look like
 * exactly that." A single enum could not say that, which is why `dimmed` is its own axis
 * rather than a fourth member. A dimmed node keeps its halo, at reduced strength: it is
 * still a search hit, it is just not passing the current filter.
 */
export const DIMMED_OPACITY = 0.18;

export function eventNodeVisual(
  state: EventNodeState,
  category: Category,
  dimmed = false,
): EventNodeVisual {
  const base = VISUALS[state];
  if (!dimmed) return { color: CATEGORY_COLOR[category], ...base };
  return {
    color: CATEGORY_COLOR[category],
    radiusScale: base.radiusScale,
    // Emissive is what bloom keys on, so it drops hardest — a dimmed node must not bloom.
    emissiveIntensity: base.emissiveIntensity * 0.18,
    opacity: base.opacity * DIMMED_OPACITY,
    haloOpacity: base.haloOpacity * DIMMED_OPACITY,
    labelOpacity: base.labelOpacity * DIMMED_OPACITY,
  };
}

/**
 * One frame of the hover tween: move `current` toward `target`, framerate-independently.
 *
 * Exponential smoothing rather than `lerp(current, target, 0.1)`, because a fixed lerp
 * factor makes the tween twice as fast on a 120 Hz display as on a 60 Hz one — the same
 * gesture then feels different on two machines. Here the half-life is in seconds and the
 * frame rate cancels out.
 *
 * `tweenSeconds <= 0` snaps. That is the reduced-motion path (P4.4.5) and it is a
 * distinct branch rather than a very small time constant, so it cannot ever leave a
 * residual animation running.
 */
export function approachScale(
  current: number,
  target: number,
  deltaSeconds: number,
  tweenSeconds: number,
): number {
  if (tweenSeconds <= 0 || deltaSeconds <= 0) return target;
  // `tweenSeconds` is the time to cover ~95% of the remaining distance; e^-3 ≈ 0.05.
  const decay = Math.exp((-3 * deltaSeconds) / tweenSeconds);
  const next = target + (current - target) * decay;
  // Land exactly, so a node that is done moving stops writing to its transform.
  return Math.abs(next - target) < 1e-4 ? target : next;
}
