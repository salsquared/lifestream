/**
 * ONE palette — implementation P4.3.6, architecture §5 / §8.
 *
 * Both 3D views read these (the Corridor's category-coloured event nodes, the Tech
 * Tree's lanes and relation arcs) **and so does the server-side export renderer**, which
 * emits the same hex strings into HTML. That second consumer is why the values are plain
 * `#rrggbb` strings rather than `THREE.Color` instances or CSS variables: a colour that
 * only exists inside a WebGL context cannot be written into an export, and a colour that
 * only exists in a stylesheet cannot be handed to a material.
 *
 * ## Totality is the point
 *
 * Every record is annotated as a **total** `Record` over a closed enum from
 * `@shared/types`. That annotation is the whole mechanism: add a member to `Category`
 * and `tsc` fails here, instead of the new member rendering as `undefined` — which in
 * three.js is not an error but a black node on a black starfield, i.e. an event that
 * silently vanishes from the flagship view.
 *
 * ## The palette
 *
 * Seven category hues spread around the wheel (≈40–60° apart) at roughly matched
 * lightness, so no category reads as more important than another and none of them
 * collapses into a neighbour once bloom blurs it. `Category` has **seven** members:
 * there is deliberately no `project` — it duplicated the `projectId` FK (§2.1).
 *
 * No `node:*` and no DOM.
 */

import type { Category, RelationType, TechLane } from './types/enums.js';

/**
 * `event.category` → node colour, for both 3D views and every export builder.
 *
 * Two mappings are conventional rather than arbitrary and are worth naming, because a
 * later reader will otherwise "fix" them: **military is olive drab**, not a second red
 * beside `disaster`, and **personal is rose** — the human register, and the one category
 * that is about a person rather than about the world.
 */
export const CATEGORY_COLOR: Readonly<Record<Category, string>> = Object.freeze({
  /** An artifact or capability SHIPS. The Tech Tree's only category (§5.3). */
  tech: '#3ddad0',
  /** Statecraft — gold. */
  political: '#efb23c',
  /** Olive drab, held well away from `disaster`'s red. */
  military: '#a8c878',
  /** The one visceral hue; the Big One and everything shaped like it. */
  disaster: '#f2554a',
  /** A result is ESTABLISHED — distinct from `tech`, and the distinction deletes a node
   *  from the Tech Tree if it is got wrong (§5.3). */
  scientific: '#5b9dfb',
  cultural: '#b07cf0',
  personal: '#ec6ea8',
});

/**
 * `event.tech_lane` → lane colour. Only meaningful when `category === 'tech'`, and the
 * Tech Tree's Y axis is a fixed lane number, so this palette colours the lane bands and
 * their nodes rather than encoding anything positional.
 *
 * Its own hue family, distinct from {@link CATEGORY_COLOR}: in the Tech Tree every node
 * is already `tech`, so category colour carries no information there and lane colour is
 * the only channel left.
 */
export const TECH_LANE_COLOR: Readonly<Record<TechLane, string>> = Object.freeze({
  energy: '#ffd24a',
  propulsion: '#ff8a3d',
  computing: '#4fd1e0',
  neural: '#c07af0',
  biomedical: '#5ddb92',
  megastructure: '#8fa8c8',
});

/**
 * `relation.type` → arc colour, for the Corridor's relation arcs and the Tech Tree's
 * edges.
 *
 * Deliberately DIMMER than the node palettes — every one of these sits below the darkest
 * category colour in luma, and `tests/colors.test.ts` asserts it. An arc is context for
 * the nodes it joins, and under bloom an arc that out-glows its endpoints inverts the
 * reading order: the reader's eye lands on the relationship instead of on the events.
 * Same hue triad as the nodes, two thirds of the value.
 *
 * Stored with a canonical direction (§2.6), so one colour per type covers both the
 * forward view and the derived reverse one.
 */
export const RELATION_COLOR: Readonly<Record<RelationType, string>> = Object.freeze({
  precedes: '#516e8f',
  partOf: '#4c8264',
  renames: '#87684c',
});
