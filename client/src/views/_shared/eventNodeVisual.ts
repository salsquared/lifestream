/**
 * Everything {@link EventNode} decides, as pure functions (P4.3.3, P4.3.5).
 *
 * The component is a mapping from these numbers to JSX and nothing else. That split is
 * not decoration: a node's appearance is the one part of a 3D component that can be
 * asserted without a GPU, and keeping it here means "does `focused` actually look
 * different from `normal`" is a unit test rather than a screenshot.
 *
 * ## Label geometry lives here too (D3a)
 *
 * The label's offsets and font sizes were `EventNode.tsx` locals until the P4 review. They
 * moved here because a second module now has to reason about them: `views/timeline/layout.ts`
 * decides which labels may be drawn at all (P4.2.3), and it cannot do that without knowing
 * how tall and how wide a labelled node actually is. A layout holding its own copy of those numbers
 * would drift from the renderer silently — it would keep de-colliding boxes the component
 * had stopped drawing. So there is one set of numbers, exported, and `EventNode` imports
 * them back. Layout geometry is appearance, which is exactly what this file is for.
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
 * How the caller says a node should read — the SELECTION axis, and only that.
 *
 * - `normal` — in the corridor, nothing selected that concerns it.
 * - `focused` — the selection's `primary` (§6). Brightest, largest, always labelled.
 * - `glow` — in the derived `glow.eventIds` set. Additive halo, per §5.2.
 *
 * **Filtering is not a member of this enum, and must never become one.** §5.2 requires
 * that glow and filtering be orthogonal — "a node can be both glowing and filtered out,
 * and it should look like exactly that" — and one enum cannot say two things at once. So
 * filtering is the separate `dimmed` boolean that {@link eventNodeVisual} takes alongside
 * this: `state` picks a row of the appearance table, `dimmed` then scales that row by
 * {@link DIMMED_OPACITY} and {@link DIMMED_EMISSIVE}. A `glow` node that is also `dimmed`
 * keeps its halo at reduced strength, which is precisely the reading §5.2 asks for.
 *
 * There used to be a fourth member here, `'faded'`, and there used to be a paragraph
 * explaining that a four-member enum could not express the orthogonality. Both are gone:
 * the `dimmed` axis is the fix, and re-adding a `'faded'` member would collapse the two
 * axes back into one and reopen the gap. Filtering fades and never removes, or the
 * corridor reflows on every keystroke and the time axis lies about density (§5.2).
 */
export type EventNodeState = 'normal' | 'focused' | 'glow';

/** The resolved appearance of one node. Every field is consumed by exactly one JSX prop. */
export interface EventNodeVisual {
  /** `CATEGORY_COLOR[category]`, unchanged by state — state moves brightness, never hue. */
  color: string;
  /**
   * Multiplies {@link EVENT_NODE_RADIUS}. `focused` and `glow` are bigger than `normal`;
   * `dimmed` leaves it alone, because filtering must fade a node and never resize it —
   * a size that tracked the filter would make the corridor's density lie.
   */
  radiusScale: number;
  emissiveIntensity: number;
  /** Sphere opacity. Below `1` only when `dimmed`; no `state` on its own is translucent. */
  opacity: number;
  /** Additive halo strength. `0` means the halo mesh is not rendered at all. */
  haloOpacity: number;
  /** Label fill opacity. Coupled to the node so a dimmed node's text fades with it. */
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

// ---------------------------------------------------------------------------
// Label geometry
//
// `EventNode` draws with these; `views/timeline/layout.ts` de-collides with them. One
// set of numbers, so the two can never disagree about where a label is.
// ---------------------------------------------------------------------------

/**
 * Height of the title line above the node's centre, in world units, deliberately
 * independent of `state`.
 *
 * Clears a `focused` node (the largest a node ever gets) so the text never sits inside
 * the sphere — and because it does not vary, changing `state` cannot move the label.
 */
export const LABEL_OFFSET_Y = EVENT_NODE_RADIUS * 1.3 + 0.55;

/** Second line, below the title, relative to {@link LABEL_OFFSET_Y}. */
export const LABEL_DATE_OFFSET_Y = -0.5;

/** Title cap height in world units — the line the layout de-collides on. */
export const TITLE_FONT_SIZE = 0.5;

/** Date cap height in world units. Smaller: it is the annotation's annotation. */
export const DATE_FONT_SIZE = 0.38;

/**
 * Node centre to the top of the title, in world units.
 *
 * `LABEL_OFFSET_Y` (1.005) + half the title's cap height (0.25) = **1.255**. The date
 * line sits between the sphere and the title — its lowest ink is at
 * `1.005 − 0.5 − 0.19 = 0.315` — so it sets neither the top nor the bottom of the box.
 */
export const NODE_FOOTPRINT_ABOVE = LABEL_OFFSET_Y + TITLE_FONT_SIZE / 2;

/**
 * Node centre to the bottom of the sphere, in world units.
 *
 * Nothing is drawn below the sphere, so this is just the radius. It is deliberately the
 * BASE radius rather than a state-scaled one: `focused` swells the sphere by 1.3 and
 * would put its bottom at −0.455, but making the footprint depend on `state` would make
 * the layout's answer depend on the current selection, and labels would then appear and
 * vanish as the reader clicked around. The extra 0.105 stays inside the gutter.
 */
export const NODE_FOOTPRINT_BELOW = EVENT_NODE_RADIUS;

/**
 * A labelled node's full vertical extent — **1.605 world units**, sphere bottom to title
 * top.
 *
 * This is the number that forces `views/timeline/layout.ts` to have a de-collision pass
 * at all. The corridor's bands are 2.40 units tall with a 0.60-unit gutter between them
 * (`BAND_GAP` 3 × `BAND_FILL` 0.8), so a band holds only 1.5 of these, and a node sitting
 * at the top of one band reaches 0.9 units into the band above. No choice of band gap or
 * band fill closes that — see `BAND_FILL`'s docstring for the arithmetic — so the layout
 * draws fewer labels instead. See `CorridorLayout.place` and {@link labelVisible}.
 */
export const NODE_FOOTPRINT_HEIGHT = NODE_FOOTPRINT_ABOVE + NODE_FOOTPRINT_BELOW;

/**
 * Average glyph advance as a fraction of the font size, for {@link labelHalfWidth}.
 *
 * Sora SemiBold at mixed case runs a little over half an em per character once spaces and
 * narrow letters are counted in. Named rather than written inline because it is the one
 * number in the width estimate that is a property of the FONT: change the face in
 * `EventNode`'s `NODE_FONT` and this is what has to be re-measured.
 */
export const LABEL_ADVANCE_RATIO = 0.55;

/**
 * Floor for {@link labelHalfWidth}, in world units.
 *
 * A node's label is two lines, and the title is only the upper one — the date sits below
 * it at {@link DATE_FONT_SIZE}. A title of nine characters or fewer ("Ana dies", "The
 * Flood") is therefore NARROWER than its own date line, and estimating the node's label
 * box from the title alone would understate the box the reader actually sees. Sized as a
 * typical day-precision date, "10 July 2034", i.e. 12 characters:
 * `12 × 0.38 × 0.55 / 2 ≈ 1.254`.
 *
 * It binds on nothing in the current corpus — the shortest fixture title, "The Big One",
 * is 11 characters and estimates 1.51 — so this is a guard against a corpus P5 has not
 * seeded yet, not an active rule.
 *
 * Deliberately not sized against the longest date `formatWhen` can produce — a
 * `time`-precision "31 December 2041, 14:30 UTC" is 27 characters and would force a 2.82
 * floor onto every short title in the corridor. That precision is the rarest, and paying
 * for it everywhere would suppress far more labels than the occasional overhanging date
 * costs.
 */
export const LABEL_MIN_HALF_WIDTH = (12 * DATE_FONT_SIZE * LABEL_ADVANCE_RATIO) / 2;

/**
 * Estimated half-width of a node's label in x, in world units — how far its title reaches
 * to either side of the node.
 *
 * A MEASURED width needs the glyph metrics troika only has after it has laid the text out
 * — asynchronously, on a worker, long after the layout has to answer — so this stays an
 * estimate. But it is an estimate that tracks the actual string, which is a different
 * quality of thing from the fixed 3.3 this replaced. Across the thirteen fixture titles
 * the true half-widths run from 1.51 ("The Big One") to 7.43 ("The US government
 * commissions the Disaster Ridge study") — a factor of five — so ONE constant is wrong in
 * both directions at once: it over-suppresses the short labels and under-suppresses the
 * long ones. P5 makes that worse rather than better, because its personal band is mostly
 * short titles ("Adan is born", 1.65) that a fixed 3.3 would have hidden against
 * neighbours they come nowhere near.
 *
 * Still deliberately generous, because the two failure modes are not symmetric:
 * over-estimating hides a label that would have fitted, which costs the reader one
 * annotation they get back by hovering; under-estimating draws two titles on top of each
 * other, which is the defect this whole mechanism exists to prevent and which the reader
 * cannot undo.
 */
export function labelHalfWidth(title: string): number {
  const titleHalfWidth = (title.length * TITLE_FONT_SIZE * LABEL_ADVANCE_RATIO) / 2;
  return Math.max(titleHalfWidth, LABEL_MIN_HALF_WIDTH);
}

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

/**
 * The multiplier a filtered-out node's EMISSIVE intensity is scaled by.
 *
 * Equal to {@link DIMMED_OPACITY} today, and a different number in principle — which is
 * why it has its own name rather than being that constant reused, or (as it was until the
 * P4 review) a bare `0.18` written thirteen lines below it. Opacity decides how much of
 * the node you can see through; emissive decides whether it BLOOMS, because the bloom pass
 * thresholds on luminance (`sceneSettings.ts`'s `luminanceThreshold`, 0.25). Keeping them
 * separate means tuning the bloom cannot silently change what filtering looks like.
 *
 * ## What 0.18 actually does, which is not what this comment used to claim
 *
 * It used to say a dimmed node "may well have to drop harder than the opacity does",
 * implying a dimmed node does not bloom. Measured against the real threshold, only one of
 * the three states is taken under it:
 *
 * | state | emissive | x 0.18 | vs 0.25 |
 * | --- | --- | --- | --- |
 * | `normal` | 0.55 | 0.099 | under — cannot bloom |
 * | `glow` | 1.50 | 0.270 | over |
 * | `focused` | 2.40 | 0.432 | over, by 1.7x |
 *
 * **That is left as it is, deliberately, and it is an open question rather than a bug.**
 * §5.2 makes glow additive and filtering subtractive precisely so a node can be both, and
 * a `glow` node that is filtered out is still a search hit — arguably it SHOULD keep
 * blooming, with the dropped opacity carrying the "filtered" reading on its own. The same
 * argument is stronger for `focused`, which is the reader's own selection (§6): a
 * selection that vanishes because a filter moved is worse than one that stays legible.
 *
 * Nothing exercises `dimmed` yet — P9 is its first caller — so settling this now would be
 * settling it blind. `tests/eventNodeVisual.test.ts` pins all three products against the
 * real `DEFAULT_BLOOM.luminanceThreshold`, so changing either number forces the question
 * rather than letting it drift. Taking `focused` under the threshold needs this below
 * 0.104; taking `glow` under needs below 0.167.
 */
export const DIMMED_EMISSIVE = 0.18;

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
    // Emissive is what bloom keys on, so it gets its own factor — a dimmed node must not
    // bloom, however translucent its sphere already is.
    emissiveIntensity: base.emissiveIntensity * DIMMED_EMISSIVE,
    opacity: base.opacity * DIMMED_OPACITY,
    haloOpacity: base.haloOpacity * DIMMED_OPACITY,
    labelOpacity: base.labelOpacity * DIMMED_OPACITY,
  };
}

/**
 * May this node draw its label right now? (P4.2.3, D3c.)
 *
 * `labelled` is the LAYOUT's verdict — the only thing that can see a node's neighbours —
 * and it is a default, not a veto. A suppressed label comes back the instant the reader
 * shows interest in the node, whether by pointing at it (`hovered`) or by putting it in
 * the selection (any `state` other than `normal`: `focused` is the primary, `glow` is a
 * relation of the primary, and both are things the reader asked to see named).
 *
 * The rule that shape encodes: density hides labels the reader did not ask for. It never
 * hides the one they are pointing at. Without the `hovered` term, a suppressed node would
 * be an unidentifiable dot with no way to find out what it is, which is a worse corridor
 * than an overlapping one.
 */
export function labelVisible(state: EventNodeState, labelled: boolean, hovered: boolean): boolean {
  return labelled || hovered || state !== 'normal';
}

/**
 * One frame of the hover tween: move `current` toward `target`, framerate-independently.
 *
 * Exponential smoothing rather than `lerp(current, target, 0.1)`, because a fixed lerp
 * factor makes the tween twice as fast on a 120 Hz display as on a 60 Hz one — the same
 * gesture then feels different on two machines. Here the half-life is in seconds and the
 * frame rate cancels out.
 *
 * ## Two zero cases, and they are opposites
 *
 * `tweenSeconds <= 0` **snaps to the target**. That is the reduced-motion path (P4.4.5),
 * and it is a distinct branch rather than a very small time constant so it cannot ever
 * leave a residual animation running.
 *
 * `deltaSeconds <= 0` **holds at `current`**, which is the opposite answer, and the two
 * used to share a branch. No time has passed, so no progress has been made — that is the
 * whole premise of a function whose contract is that elapsed time and not frame arrival
 * decides how far a tween has come. It is also what this function's own arithmetic
 * already says: at `deltaSeconds = 0` the decay is `e^0 = 1` and `next` works out to
 * exactly `current`, so the old guard contradicted the three lines below it.
 *
 * It is reachable, not theoretical. `EventNode` drives this from
 * `useFrame((_state, delta) => …)`, and r3f hands over a delta of 0 on a duplicated frame
 * and on the first frame after a tab regains focus. Under the old guard a hover tween
 * that was mid-flight when the tab lost focus completed instantly on return, which is
 * exactly the frame-dependent behaviour the exponential smoothing exists to prevent.
 * Found by `tests/eventNodeVisual.test.ts`.
 */
export function approachScale(
  current: number,
  target: number,
  deltaSeconds: number,
  tweenSeconds: number,
): number {
  if (tweenSeconds <= 0) return target;
  if (deltaSeconds <= 0) return current;
  // `tweenSeconds` is the time to cover ~95% of the remaining distance; e^-3 ≈ 0.05.
  const decay = Math.exp((-3 * deltaSeconds) / tweenSeconds);
  const next = target + (current - target) * decay;
  // Land exactly, so a node that is done moving stops writing to its transform.
  return Math.abs(next - target) < 1e-4 ? target : next;
}
