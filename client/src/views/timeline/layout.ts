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
 *
 * ## Labels collide where spheres do not, so labels are what give way
 *
 * A sphere is 0.70 world units across. A labelled node is 1.605 tall and — depending on
 * how long its title is — between 3 and 15 wide. The band geometry below was sized for
 * the first number and not the others, and no setting of {@link BAND_GAP} /
 * {@link BAND_FILL} fixes that (see `BAND_FILL`). So this module
 * also decides WHICH nodes may draw a label — {@link CorridorLayout.place} — while
 * leaving every node exactly where the date and the hash put it. That keeps the one
 * property the corridor cannot lose: a node's position is a fact about the event, and
 * only the annotation is negotiable.
 *
 * Importing `../_shared/eventNodeVisual` for the label's geometry is deliberate and is
 * the allowed direction: a view may depend on the shared 3D pieces, but nothing in
 * `_shared/` may depend on a view (see that directory's `index.ts` header).
 */

import { labelHalfWidth, NODE_FOOTPRINT_HEIGHT } from '../_shared/eventNodeVisual';

import { WORLD_UNITS_PER_YEAR } from '@shared/timeScale';

import type { TimeScale } from '@shared/timeScale';
import type { Category, HydratedEvent } from '@shared/types/index';

/**
 * The fields the layout reads. Deliberately narrow, so a fixture row satisfies it.
 *
 * `title` is here for {@link CorridorLayout.place} and nothing else: a label's width is a
 * function of the string it draws, and a de-collision pass that could not see the string
 * would have to assume one width for all of them (see `labelHalfWidth` for why that fails
 * in both directions). Nothing about a node's POSITION reads it — `position` and
 * {@link yOffset} still depend on the id, the category and the date alone.
 */
export type LayoutEvent = Pick<HydratedEvent, 'id' | 'category' | 'when' | 'title'>;

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
 * NOT derived from `scale.range()`, and the reason survives the P4 review even though its
 * original example does not. That example was "the range grows when an earlier event is
 * seeded" — no longer true, since `CORRIDOR_START` fixed the origin and `range()` is now a
 * constant. What is still true is the rule: a band gap read off the scale would couple the
 * corridor's VERTICAL geometry to its horizontal extent, so any later change to
 * `CORRIDOR_START` or `CORRIDOR_END` — both plausible, both authored — would move every
 * node up or down as a side effect of moving the corridor's ends. That is the same class
 * of instability a random jitter has, arriving through a different door.
 *
 * Against the shared chrome's `DEFAULT_CAMERA_POSE` (z = 40, 50° fov) the visible pane is
 * ~37 world units tall, so the stack fills about half of it — the whole category spread is
 * on screen at once without the outer bands sitting on the frame edge. This is the one
 * number in the file that is a look rather than a rule; it is the one to change if the
 * corridor reads as too flat or too tall.
 */
export const BAND_GAP = WORLD_UNITS_PER_YEAR * 0.3;

/**
 * Fraction of the band gap a band's node CENTRES may fill, leaving the rest as a gutter.
 *
 * At 0.8 a band's centres occupy 0.8 x `BAND_GAP` = 2.40 units centred on its own line,
 * so adjacent bands are separated by 0.2 x `BAND_GAP` = 0.60 units. That is what makes
 * "folded into the event's category band" literally true of the centres: the intervals
 * {@link bandExtent} returns are disjoint, and two events of different categories can
 * never share a centre y.
 *
 * **It was never true of the ink, and it is nowhere near true of a label.** The gutter is
 * 0.60 and a sphere is 0.70 across, so even two spheres graze by 0.10 at the same x. A
 * labelled node is `NODE_FOOTPRINT_HEIGHT` = **1.605** tall, 2.7x the gutter: a node at
 * the top of one band puts its title 0.9 units inside the band above, every time, for
 * every corpus. That overlap is structural, not unlucky.
 *
 * **Geometry cannot fix it, and this is settled — do not retune these two numbers to try.**
 * Disjoint label footprints need `BAND_GAP x (1 - BAND_FILL) >= 1.605`, i.e.
 * `BAND_GAP >= 8.025` at this fill — 2.7x today, stacking the seven bands 48 units tall
 * against the ~37-unit visible pane, so the corridor no longer fits on screen. Holding
 * `BAND_GAP = 3` and solving the other way needs `BAND_FILL <= 0.465`, which shrinks the
 * band to 1.395 units — less than a single node's own 1.605 footprint, so every pair
 * inside a band collides and INTRA-band crowding gets strictly worse. There is no third
 * knob. The label is the only lever, and {@link CorridorLayout.place} is what pulls it.
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
 * The closed interval a category's node CENTRES fall in — exactly {@link yOffset}'s range
 * — disjoint from every other category's by {@link BAND_FILL}. Exported because it is the
 * invariant worth asserting.
 *
 * Read the word "centres" strictly. This bounds where a node is placed, not where its ink
 * lands: the sphere adds `EVENT_NODE_RADIUS` = 0.35 on each side against a 0.60 gutter,
 * and the label adds `NODE_FOOTPRINT_ABOVE` = 1.255 above, so a node near the top of its
 * band reliably draws its title across the band above. So the assertable claim is that no
 * two categories share a centre y — NOT that two categories can never visually overlap,
 * which is false and which nothing here tries to make true. Overlap is handled by drawing
 * fewer labels ({@link CorridorLayout.place}), never by moving a node.
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

// ---------------------------------------------------------------------------
// Label de-collision
// ---------------------------------------------------------------------------

/** One event, placed, with the layout's verdict on whether it may name itself. */
export interface PlacedEvent<E extends LayoutEvent = LayoutEvent> {
  readonly event: E;
  /** `[toX(when), yOffset(event), 0]` — P4.2.2. Never adjusted to avoid a neighbour. */
  readonly position: [number, number, number];
  /** False when this node's label box overlaps one already granted a label. */
  readonly labelled: boolean;
}

/** The corridor's placement of an event set, built from THE canonical scale. */
export interface CorridorLayout {
  /**
   * One node's position — `[toX(when), yOffset(event), 0]`, P4.2.2.
   *
   * Kept alongside {@link CorridorLayout.place} because P13 places by its own rules and
   * wants only the single-node form, and because a caller drawing one node has no
   * neighbours to de-collide against.
   */
  position(event: LayoutEvent): [number, number, number];
  /**
   * Place a whole set, and decide which members may draw a label (P4.2.3).
   *
   * ## Why the layout owns this
   *
   * A labelled node is 1.605 world units tall and 3 to 15 wide against a 3-unit band gap
   * and a 0.60-unit gutter, so labels collide both inside a band and across bands, and no
   * band geometry fixes it (see {@link BAND_FILL}). Drawing fewer labels is the only
   * lever, and this module is the only thing that can pull it: `EventNode` is
   * view-agnostic by construction (P4.3.2) and cannot see a single neighbour.
   *
   * ## The sweep
   *
   * Greedy and first-come-first-served in x. Sort by x, ties by id; walk that order; grant
   * a label unless some already-granted node is closer in x than the two labels' half-widths
   * added together AND within `NODE_FOOTPRINT_HEIGHT` in y. The x test is per-PAIR, not
   * against a constant: `labelHalfWidth` is a function of the title, and a five-fold spread
   * of widths means "Adan is born" and "The US government commissions the Disaster Ridge
   * study" cannot share a threshold without one of them getting the wrong answer.
   *
   * A suppressed node still renders in full — the sphere is the event, the label is only
   * its annotation — and a suppressed label comes straight back on hover or selection,
   * which is `labelVisible`'s job, not this one's.
   *
   * ## Order-independence is a requirement, not a nicety
   *
   * The sweep order is derived from the DATA (x, then id) and never from the input array,
   * and the result comes back in the CALLER's order, so `place(events)[i]` describes
   * `events[i]`. Two holders of the same set — the Corridor and a spec, or one corpus
   * before and after a re-sort — therefore grant identical labels. Together with
   * {@link yOffset}'s id hash that makes the whole placement a pure function of the set's
   * contents: same events, same picture, in every process and on every reload. The same
   * four consumers that a moving y would break (fly-to, the viewport stack, arc endpoints,
   * shared URLs) would be broken by a label that depended on fetch order.
   *
   * ## It is already fixing something visible
   *
   * The P4 review expected this pass to be inert until P5, on the grounds that the 13
   * fixture events hold no same-category pair within one world unit of x. That measurement
   * was of SPHERE spacing, and spheres are 0.70 across while labels are 3 to 15 — so it
   * answered a question about a quantity this pass does not use.
   *
   * **Eleven of the thirteen fixture labels are granted.** The two `tech` events that
   * motivated the check are the obvious collision — "Los Angeles' first Megablock breaks
   * ground" (x = 145.81) and "The first Top Ridge–Bottom Ridge elevator is built"
   * (x = 148.00) hash to y = 0.9141 and y = 0.9128, so dy = 0.0013 and dx = 2.19 against half-widths
   * of 5.78 and 6.88 summing to 12.66; those two titles are drawn straight through each
   * other in the corridor as it stands today.
   *
   * But in the full sweep neither of them is what suppresses the other. Both are taken out
   * by "Scientists begin probing the Ridge" (`scientific`, x = 140.85, y = 2.44), which
   * comes first in x and is therefore granted first: dy = 1.53 against the 1.605 footprint,
   * dx = 4.96 and 7.15 against sums of 10.46 and 11.56. That is the CROSS-band case
   * `BAND_FILL` describes — a 0.60 gutter against a label that reaches 1.255 above its own
   * centre — and it is a title drawn across a neighbouring band's sphere rather than across
   * another title. The footprint test catches both, deliberately: a title with a glowing
   * ball through it is no more readable than two titles on top of each other.
   *
   * P5 is where this stops being an occasional fix and becomes the thing that keeps the
   * view readable: P5.1's North Korean War alone is 8 events across 27 days = 0.739 world
   * units, roughly one node diameter, spread over bands that hold about 1.5 labels each.
   *
   * O(n x w) where w is the number of granted labels inside the x-window. At P5's 68
   * events and P15's 500 that is microseconds, and the caller memoizes it anyway.
   */
  place<E extends LayoutEvent>(events: readonly E[]): readonly PlacedEvent<E>[];
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
  const position = (event: LayoutEvent): [number, number, number] => [
    scale.toX(event.when),
    yOffset(event),
    CORRIDOR_DEPTH,
  ];

  /** Implements {@link CorridorLayout.place}; the contract is documented there. */
  function place<E extends LayoutEvent>(events: readonly E[]): readonly PlacedEvent<E>[] {
    // The array that is returned, in the caller's order, built optimistically: everything
    // gets a label and the sweep takes them away.
    const placed = events.map((event) => ({
      event,
      position: position(event),
      labelled: true,
    }));

    // The sweep order, which is NOT the caller's — see the interface docstring. Each
    // record carries its own label half-width, computed once here rather than inside the
    // O(n x w) comparison below. Ties on x break on the id with plain `<`, never
    // `localeCompare`: that one is locale-dependent and would let two machines disagree
    // about which of two simultaneous events keeps its label.
    const sweep = placed
      .map((draft) => ({
        draft,
        x: draft.position[0],
        y: draft.position[1],
        halfWidth: labelHalfWidth(draft.event.title),
      }))
      .sort((a, b) => {
        const dx = a.x - b.x;
        if (dx !== 0) return dx;
        return a.draft.event.id < b.draft.event.id
          ? -1
          : a.draft.event.id > b.draft.event.id
            ? 1
            : 0;
      });

    // The widest label in the set, for the prune below. It has to be the widest of ALL of
    // them and not of the node in hand: half-widths vary five-fold, so a granted label
    // that this node cannot reach may still be reached by a much wider one later in the
    // sweep, and dropping it early would silently let two titles overlap.
    const widestHalfWidth = sweep.reduce((widest, node) => Math.max(widest, node.halfWidth), 0);

    // Labels granted so far, x-ascending because that is the order they are pushed in.
    let granted: { readonly x: number; readonly y: number; readonly halfWidth: number }[] = [];

    for (const node of sweep) {
      // x only ever increases from here, so a granted label this far to the left is out of
      // reach of every node still to come. Pruning is what makes the sweep O(n x window)
      // rather than O(n²).
      granted = granted.filter((other) => node.x - other.x < other.halfWidth + widestHalfWidth);
      // `node.x - other.x` needs no `Math.abs`: the sweep is x-ascending, so it is never
      // negative. The y test does, because band offsets go both ways.
      const blocked = granted.some(
        (other) =>
          node.x - other.x < node.halfWidth + other.halfWidth &&
          Math.abs(node.y - other.y) < NODE_FOOTPRINT_HEIGHT,
      );
      if (blocked) {
        // Suppressed, and deliberately NOT pushed: a node with no label occupies no label
        // box, so it must not go on to suppress a third node on behalf of a label nobody
        // is drawing.
        node.draft.labelled = false;
        continue;
      }
      granted.push({ x: node.x, y: node.y, halfWidth: node.halfWidth });
    }

    return placed;
  }

  return { scale, position, place };
}
