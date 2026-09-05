/**
 * Corridor layout — implementation P4.2.2, P4.2.3, P4.2.4; the node-position decision.
 *
 * An event node's world position is
 *
 * ```
 * [ timeScale.toX(event.when), yOffset(event), CORRIDOR_DEPTH ]
 * ```
 *
 * and this module is the only place that computes it. `EventNode` renders what it is
 * handed and never derives a position of its own (P4.3.2) — the Tech Tree places the
 * same component by completely different rules (time x lane, P13.4), so a node that
 * computed its own y from a category band would be in the wrong lane over there.
 *
 * ## Why y is a hash and not a jitter
 *
 * `yOffset` is a **deterministic function of `event.id`** — same id, same pixel, forever.
 * A random jitter computed at mount moves every node on every reload, which silently
 * breaks the four things that read a node's position back: camera fly-to targets (P8.4),
 * the viewport stack that replays a camera pose (P8.6), relation arc endpoints (P9.1),
 * and any shared URL. It is the same reasoning that makes `rollDate` seeded on the event
 * id rather than on wall-clock randomness — see `shared/src/rollDate.ts`.
 *
 * The hash is deliberately *not* `rollDate`'s PRNG. That one is a **persisted** contract
 * — its output is written to `event.when` and changing its arithmetic re-rolls the whole
 * corpus — so it is documented as frozen and exports nothing but `rollDate` itself. This
 * one is a **render-time** function whose output is never stored, and the two are free to
 * change independently. What they share is the property that matters: `Math.imul` over
 * UTF-16 code units is byte-for-byte identical in every JS engine, so node and the
 * browser agree.
 *
 * ## Why x never moves to avoid a collision
 *
 * Two events a day apart sit ~0.03 world units from each other. They are separated on
 * **y**, by the band offset below, and never by nudging x: x is the event's date, the
 * HUD inverts the camera's x back through the same scale (P4.6), and a node displaced
 * along x would be a node whose position lies about when it happened.
 */

import { WORLD_UNITS_PER_YEAR } from '@shared/timeScale';

import type { TimeScale } from '@shared/timeScale';
import type { Category, HydratedEvent } from '@shared/types/index';

/** The fields the layout reads. Deliberately narrow, so a fixture row satisfies it. */
export type LayoutEvent = Pick<HydratedEvent, 'id' | 'category' | 'when'>;

// ---------------------------------------------------------------------------
// Geometry constants
// ---------------------------------------------------------------------------

/**
 * Depth of every node in this phase — **literally zero**, P4.2.4.
 *
 * The strata and their z-dependent parallax multiplier arrive in P7.6, and that
 * multiplier is applied **at draw time only**: `x_drawn = toX(when) * k(z)` is evaluated
 * in the render pass and is never written back here. Nothing in this module may learn
 * about it, or the two views stop sharing a scale the first time the curve changes.
 */
export const CORRIDOR_DEPTH = 0;

/**
 * Distance between adjacent category bands, in world units.
 *
 * Expressed as a fraction of {@link WORLD_UNITS_PER_YEAR} rather than as a bare number
 * so the corridor's proportions survive a change to the scale's slope: at the current
 * 10 units/year a band gap is 3 units, which is the same x-distance as ~3.6 months. The
 * seven bands therefore stack across 6 x 3 = 18 world units, centred on y = 0.
 *
 * NOT derived from `scale.range()`. The range grows when an earlier event is seeded, and
 * a corpus-dependent band gap would move every node vertically the moment the corpus
 * gained a new earliest event — the same class of instability a random jitter has.
 *
 * Against the shared chrome's `DEFAULT_CAMERA_POSE` (z = 40, 50° fov) the visible pane is
 * ~37 world units tall, so the stack fills about half of it — the whole category spread is
 * on screen at once without the outer bands sitting on the frame edge. This is the one
 * number in the file that is a look rather than a rule; it is the one to change if the
 * corridor reads as too flat or too tall.
 */
export const BAND_GAP = WORLD_UNITS_PER_YEAR * 0.3;

/**
 * Fraction of the band gap a band's nodes may fill, leaving the rest as a gutter.
 *
 * At 0.8 a band occupies 0.8 x `BAND_GAP` centred on its own line, so adjacent bands are
 * separated by a clear 0.2 x `BAND_GAP` of empty space. That is what makes "folded into
 * the event's category band" literally true: the bands are disjoint intervals and two
 * events of different categories can never share a y.
 */
export const BAND_FILL = 0.8;

/**
 * Which band each category occupies, ordered world-scale → personal.
 *
 * A **total** `Record` over the closed enum, so `tsc` rejects a new `Category` member
 * that forgets a band rather than dropping its events onto band `undefined`. The order
 * is a display choice and nothing reads the numbers except {@link bandCenter}.
 */
export const CATEGORY_BAND: Readonly<Record<Category, number>> = {
  disaster: 0,
  military: 1,
  political: 2,
  tech: 3,
  scientific: 4,
  cultural: 5,
  personal: 6,
};

/** Number of bands, read off the table so the two can never disagree. */
const BAND_COUNT = Object.keys(CATEGORY_BAND).length;

/** Band index that maps to y = 0, so the stack is centred on the corridor's axis. */
const BAND_MIDPOINT = (BAND_COUNT - 1) / 2;

/** Half-width of the interval a band's nodes are drawn in. */
const BAND_HALF_WIDTH = (BAND_GAP * BAND_FILL) / 2;

// ---------------------------------------------------------------------------
// The hash
// ---------------------------------------------------------------------------

/**
 * FNV-1a over UTF-16 code units, finished with murmur3's `fmix32` avalanche.
 *
 * Every operation is a 32-bit integer op (`Math.imul`, xor, shift), so the result is
 * identical in every JS engine and in every process — which is the whole point. `seed`
 * selects an independent hash function; {@link unitHash} uses two.
 */
function hash32(text: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 16_777_619);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 2_246_822_507);
  h ^= h >>> 13;
  h = Math.imul(h, 3_266_489_909);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * A unit float in `[0, 1)` derived from `text`, with a full 53 bits of entropy.
 *
 * Two independently seeded 32-bit hashes are combined into one double — 27 high bits
 * plus 26, the standard construction. The width matters: it is what makes an exact
 * collision between two distinct ids a ~1-in-9e15 event rather than a 1-in-N-slots one,
 * so two events in the same category band land on distinguishable lines.
 */
export function unitHash(text: string): number {
  const hi = hash32(text, 2_166_136_261) >>> 5;
  const lo = hash32(text, 1_566_083_941) >>> 6;
  return (hi * 67_108_864 + lo) / 9_007_199_254_740_992;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Centre line of a category's band, in world units. */
export function bandCenter(category: Category): number {
  return (CATEGORY_BAND[category] - BAND_MIDPOINT) * BAND_GAP;
}

/**
 * The closed interval a category's nodes are drawn in — disjoint from every other
 * category's, by {@link BAND_FILL}. Exported because it is the invariant worth asserting.
 */
export function bandExtent(category: Category): readonly [number, number] {
  const centre = bandCenter(category);
  return [centre - BAND_HALF_WIDTH, centre + BAND_HALF_WIDTH];
}

/**
 * A node's y: its category's band centre, offset by a deterministic hash of `event.id`
 * within that band (P4.2.3).
 *
 * Depends on the id and the category and on nothing else — not on the render, not on the
 * corpus, not on the scale. Two processes, two reloads and two machines all produce the
 * same number.
 */
export function yOffset(event: LayoutEvent): number {
  return bandCenter(event.category) + (unitHash(event.id) - 0.5) * 2 * BAND_HALF_WIDTH;
}

/** The corridor's placement of an event set, built from THE canonical scale. */
export interface CorridorLayout {
  /** `[toX(when), yOffset(event), 0]` — P4.2.2. */
  position(event: LayoutEvent): [number, number, number];
  /** The canonical scale this layout places against. */
  readonly scale: TimeScale;
}

/**
 * Bind the layout to a scale.
 *
 * The scale is passed in rather than built here: there is exactly one canonical scale
 * per save (architecture §5.2) and the view that owns the corpus owns its construction.
 */
export function createCorridorLayout(scale: TimeScale): CorridorLayout {
  return {
    scale,
    position: (event) => [scale.toX(event.when), yOffset(event), CORRIDOR_DEPTH],
  };
}
