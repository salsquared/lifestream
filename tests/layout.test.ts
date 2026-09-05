import { describe, expect, it } from 'vitest';

import { CORRIDOR_FIXTURE } from '@client/views/timeline/fixture';
import {
  bandCenter,
  bandExtent,
  createCorridorLayout,
  unitHash,
  yOffset,
  BAND_FILL,
  BAND_GAP,
  CATEGORY_BAND,
  CORRIDOR_DEPTH,
} from '@client/views/timeline/layout';
import {
  labelHalfWidth,
  EVENT_NODE_RADIUS,
  NODE_FOOTPRINT_ABOVE,
  NODE_FOOTPRINT_HEIGHT,
  TITLE_FONT_SIZE,
} from '@client/views/_shared/eventNodeVisual';
import { TIME_SCALE } from '@shared/timeScale';

import type { LayoutEvent, PlacedEvent } from '@client/views/timeline/layout';
import type { Category, IsoInstant } from '@shared/types/index';

/**
 * P4.2.2–P4.2.4 / review decision D3 — corridor placement, and which nodes may name
 * themselves.
 *
 * ── WHY THIS SPEC EXISTS ─────────────────────────────────────────────────────────────
 * `place()` is the only thing standing between P5's 68 events and a band of titles drawn
 * through one another, and it has no other guard: `EventNode` is view-agnostic by
 * construction and cannot see a single neighbour, so nothing downstream would notice the
 * sweep going wrong. It fails silently in four independent ways, and each one is a
 * separate section below:
 *
 *   1. **It stops suppressing.** A `place()` that granted every label would pass any
 *      spec that only checked "the array comes back the right length". So the invariant
 *      asserted here is the sweep's actual postcondition — *no two granted labels
 *      overlap* — which a no-op implementation fails on the very first crowded corpus.
 *   2. **It becomes order-dependent.** The sweep order is derived from the DATA (x, then
 *      id) precisely so two holders of the same set grant the same labels. Sorting by
 *      input order instead is a one-word change that no visual check catches, and it
 *      would make a node's label depend on fetch order — the same class of instability
 *      as a y that moved on reload.
 *   3. **It stops mapping positionally.** `place(events)[i]` must describe `events[i]`,
 *      even though the sweep runs in a different order. Returning the sweep's own order
 *      would silently re-key every node in `TimelineView`'s render.
 *   4. **The prune bound gets "simplified".** With per-title widths the sweep may not
 *      drop a granted label as soon as `dx` exceeds the CURRENT node's reach — half
 *      widths vary five-fold across one corpus, and a much wider label later in the
 *      sweep can still reach it. This is the subtlest line in the module; the case that
 *      catches it is built explicitly below.
 *
 * Determinism across processes is asserted the only way it can be from inside one
 * process: against a **committed** expected set. The eleven granted fixture ids and the
 * `yOffset` / `unitHash` goldens below were computed once and written down, so a fresh
 * process that disagrees fails, and so does a change to the hash arithmetic — which
 * would otherwise move every node and every label in every existing save with no error.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const layout = createCorridorLayout(TIME_SCALE);

/** All seven categories, read off the total band table so a new member appears here. */
const CATEGORIES = Object.keys(CATEGORY_BAND) as Category[];

/**
 * The instant that lands a node at world x — the scale read backwards.
 *
 * Constructed scenarios below are stated in world units, because that is the unit
 * `place()` reasons in; going through `toDate` keeps them honest rather than letting a
 * hand-picked date drift away from the x it is supposed to produce.
 */
const at = (x: number): IsoInstant => TIME_SCALE.toDate(x);

const event = (id: string, category: Category, x: number, title: string): LayoutEvent => ({
  id,
  category,
  when: at(x),
  title,
});

const grantedIds = (placed: readonly PlacedEvent<LayoutEvent>[]): string[] =>
  placed.filter((node) => node.labelled).map((node) => node.event.id);

/**
 * Every pair of GRANTED labels whose boxes overlap — the sweep's postcondition, as a
 * list rather than a boolean so a failure names the two titles that collided.
 *
 * The test is the module's own: closer in x than the two half-widths added together AND
 * within one `NODE_FOOTPRINT_HEIGHT` in y. Restated here rather than imported, so a
 * change to the rule has to be made twice and argued for once.
 */
function overlappingGrantedPairs(placed: readonly PlacedEvent<LayoutEvent>[]): string[] {
  const granted = placed.filter((node) => node.labelled);
  const pairs: string[] = [];
  for (let i = 0; i < granted.length; i++) {
    for (let j = i + 1; j < granted.length; j++) {
      const a = granted[i]!;
      const b = granted[j]!;
      const dx = Math.abs(a.position[0] - b.position[0]);
      const dy = Math.abs(a.position[1] - b.position[1]);
      const reach = labelHalfWidth(a.event.title) + labelHalfWidth(b.event.title);
      if (dx < reach && dy < NODE_FOOTPRINT_HEIGHT) {
        pairs.push(`${a.event.id} / ${b.event.id}`);
      }
    }
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// The fixture, pinned
// ---------------------------------------------------------------------------

/**
 * The eleven ids that keep a label on today's corpus, written down.
 *
 * The P4 review predicted thirteen — it expected this pass to be inert until P5, having
 * measured SPHERE spacing (0.70 across) rather than label spacing (3 to 15). This list is
 * the correction, and it is the assertion that says when the behaviour changed and by how
 * much: a change to the sweep, to `labelHalfWidth`, to the band geometry or to the hash
 * moves it, and none of those would otherwise report anything.
 */
const GRANTED_ON_FIXTURE = [
  'evt_lazaro_born',
  'evt_ines_born',
  'evt_big_one',
  'evt_disaster_ridge_study',
  'evt_ridge_probing_begins',
  'evt_fob_oasis_designation',
  'evt_megablocks_2_8_begin',
  'evt_megablock_early_occupancy',
  'evt_camp_oasis_designation',
  'evt_megablock_1_complete',
  'evt_megablocks_2_4_complete',
];

/** The two the sweep takes away, both `tech`, both blocked by the same scientific node. */
const SUPPRESSED_ON_FIXTURE = ['evt_megablock_1_groundbreaking', 'evt_ridge_first_elevator'];

const BLOCKER = 'evt_ridge_probing_begins';

describe('place() on the corridor as it stands today', () => {
  const placed = layout.place(CORRIDOR_FIXTURE);
  const byId = new Map(placed.map((node) => [node.event.id, node]));

  it('grants eleven of the thirteen fixture labels, and exactly these eleven', () => {
    expect(grantedIds(placed)).toEqual(GRANTED_ON_FIXTURE);
    expect(placed.filter((node) => !node.labelled).map((node) => node.event.id)).toEqual(
      SUPPRESSED_ON_FIXTURE,
    );
  });

  it('suppresses the two tech titles a scientific node is drawn through, not each other', () => {
    // The obvious collision is between the two `tech` events themselves — same y to
    // three decimals, 2.19 units apart in x against half-widths summing to 12.65. But
    // neither is what suppresses the other: both are taken out by the SCIENTIFIC node,
    // which is earlier in x and therefore granted first. Asserting the blocker (rather
    // than just the count) is what makes this a claim about the cross-band case.
    const blocker = byId.get(BLOCKER)!;
    expect(blocker.labelled).toBe(true);
    expect(blocker.event.category).toBe('scientific');

    for (const id of SUPPRESSED_ON_FIXTURE) {
      const victim = byId.get(id)!;
      expect(victim.event.category).toBe('tech');
      // Earlier in x, so it is reached first by the sweep and keeps its label.
      expect(blocker.position[0]).toBeLessThan(victim.position[0]);
      const dx = victim.position[0] - blocker.position[0];
      const dy = Math.abs(victim.position[1] - blocker.position[1]);
      expect(dx).toBeLessThan(
        labelHalfWidth(victim.event.title) + labelHalfWidth(blocker.event.title),
      );
      expect(dy).toBeLessThan(NODE_FOOTPRINT_HEIGHT);
    }
  });

  it('overlaps a title against a SPHERE there, which is why the cross-band case bites', () => {
    // The two titles never touch: their baselines are ~1.52 apart and a title is
    // TITLE_FONT_SIZE tall. What overlaps is the tech title's top edge against the
    // scientific node's sphere — deliberate, because a title with a glowing ball through
    // it reads no better than two titles on top of each other. If the footprint were
    // ever narrowed to "title box only", this case would stop being caught and nothing
    // else in the suite would notice.
    const blocker = byId.get(BLOCKER)!;
    const victim = byId.get('evt_megablock_1_groundbreaking')!;
    const dy = blocker.position[1] - victim.position[1];

    expect(dy).toBeGreaterThan(TITLE_FONT_SIZE);

    const victimTitleTop = victim.position[1] + NODE_FOOTPRINT_ABOVE;
    const blockerSphereBottom = blocker.position[1] - EVENT_NODE_RADIUS;
    expect(victimTitleTop).toBeGreaterThan(blockerSphereBottom);
  });

  it('leaves every node exactly where the date and the hash put it, labelled or not', () => {
    // x is the event's date and y is a hash of its id. A suppressed node is a node with
    // no annotation, never a node that was moved out of the way — the HUD inverts the
    // camera's x back through the same scale, so a displaced node would be a node whose
    // position lies about when it happened.
    for (const node of placed) {
      expect(node.position).toEqual(layout.position(node.event));
      expect(node.position[0]).toBe(TIME_SCALE.toX(node.event.when));
      expect(node.position[1]).toBe(yOffset(node.event));
      expect(node.position[2]).toBe(CORRIDOR_DEPTH);
    }
  });
});

// ---------------------------------------------------------------------------
// A function of the set, not of the array
// ---------------------------------------------------------------------------

describe('place() depends on the set of events and never on the order they arrive in', () => {
  /** Five orderings of one set: none of them is the sweep's own (x, then id). */
  const ORDERS: ReadonlyArray<readonly [string, readonly LayoutEvent[]]> = [
    ['as authored', CORRIDOR_FIXTURE],
    ['reversed', [...CORRIDOR_FIXTURE].reverse()],
    ['by id', [...CORRIDOR_FIXTURE].sort((a, b) => (a.id < b.id ? -1 : 1))],
    [
      'by title length',
      [...CORRIDOR_FIXTURE].sort(
        (a, b) => a.title.length - b.title.length || (a.id < b.id ? -1 : 1),
      ),
    ],
    ['rotated', [...CORRIDOR_FIXTURE.slice(7), ...CORRIDOR_FIXTURE.slice(0, 7)]],
  ];

  for (const [name, events] of ORDERS) {
    it(`grants the same eleven labels when the corpus arrives ${name}`, () => {
      expect([...grantedIds(layout.place(events))].sort()).toEqual([...GRANTED_ON_FIXTURE].sort());
    });
  }

  it('returns the placements in the CALLER order, so place(events)[i] describes events[i]', () => {
    // The sweep runs in x order; the result must not. `TimelineView` maps the returned
    // array straight onto its nodes, so a result in sweep order would hand every node
    // its neighbour's position and label.
    for (const [, events] of ORDERS) {
      const placed = layout.place(events);
      expect(placed.length).toBe(events.length);
      placed.forEach((node, i) => {
        expect(node.event).toBe(events[i]);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// The postcondition
// ---------------------------------------------------------------------------

/**
 * A corpus dense enough that a sweep which quietly stopped suppressing would be caught:
 * 240 events over the corridor's first 60 years, all seven categories, positions and
 * categories drawn from the same engine-independent hash the layout itself uses so the
 * corpus is identical in every process.
 */
const DENSE_CORPUS: readonly LayoutEvent[] = Array.from({ length: 240 }, (_, i) => {
  const x = 10 + unitHash(`spec_dense_x_${i}`) * 600;
  const category = CATEGORIES[Math.floor(unitHash(`spec_dense_cat_${i}`) * CATEGORIES.length)]!;
  const words = 2 + Math.floor(unitHash(`spec_dense_title_${i}`) * 9);
  return event(`evt_dense_${i}`, category, x, Array(words).fill('Ridge').join(' '));
});

describe('no two granted labels overlap — the postcondition of the whole sweep', () => {
  it('holds on the corridor fixture', () => {
    expect(overlappingGrantedPairs(layout.place(CORRIDOR_FIXTURE))).toEqual([]);
  });

  it('holds on a 240-event corpus spread across all seven bands', () => {
    // This is the assertion a no-op `place()` fails: with 240 events over 600 units and
    // half-widths of 1.4 to 12, granting every label produces hundreds of overlaps.
    const placed = layout.place(DENSE_CORPUS);
    expect(overlappingGrantedPairs(placed)).toEqual([]);
    // …and it must not have got there by suppressing everything.
    expect(grantedIds(placed).length).toBeGreaterThan(40);
    expect(grantedIds(placed).length).toBeLessThan(DENSE_CORPUS.length);
  });

  it('grants the same labels on the dense corpus however it is ordered', () => {
    const forward = [...grantedIds(layout.place(DENSE_CORPUS))].sort();
    const reversed = [...grantedIds(layout.place([...DENSE_CORPUS].reverse()))].sort();
    const byTitle = [...DENSE_CORPUS].sort((a, b) => a.title.length - b.title.length);
    expect(reversed).toEqual(forward);
    expect([...grantedIds(layout.place(byTitle))].sort()).toEqual(forward);
  });
});

// ---------------------------------------------------------------------------
// The cases the sweep is subtle about
// ---------------------------------------------------------------------------

/** Eleven characters; half-width 1.5125, the narrow end of a real corpus. */
const NARROW_TITLE = 'Narrow name';
/** Ten characters, so this node's own reach is short too. */
const GAP_TITLE = 'Gap marker';
/** Fifty-seven characters; half-width 7.8375, the wide end of a real corpus. */
const WIDE_TITLE = 'A title long enough to reach across most of a decade of x';

/** Somewhere well inside `range()`, so nothing here is testing the corridor's ends. */
const BASE_X = 300;

describe('the prune bound is the widest label in the set, not the label in hand', () => {
  it('still suppresses a wide label that reaches a narrow one across a wide gap', () => {
    // THE case, and the one with no other guard. Three nodes:
    //
    //   narrow  x = 300.0  tech      half-width 1.5125
    //   gap     x = 304.0  personal  half-width 1.3750   — 8.4 units away in y, inert
    //   wide    x = 308.0  tech      half-width 7.8375   — 0.53 units away from `narrow`
    //
    // `wide` reaches back 9.35 units, so it overlaps `narrow` and must lose its label.
    // But the sweep prunes its granted list as it walks, and by the time it reaches
    // `gap` the distance from `narrow` (4.0) already exceeds what `narrow` and `gap`
    // could reach between them (2.89). A prune written against the CURRENT node's width
    // drops `narrow` there — permanently, because the list is reassigned — and `wide`
    // is then granted with nothing left to block it. Pruning against
    // `other.halfWidth + widestHalfWidth` (9.35) keeps it.
    const narrow = event('evt_prune_narrow', 'tech', BASE_X, NARROW_TITLE);
    const gap = event('evt_prune_gap', 'personal', BASE_X + 4, GAP_TITLE);
    const wide = event('evt_prune_wide', 'tech', BASE_X + 8, WIDE_TITLE);

    // The construction's own arithmetic, asserted rather than assumed: if a change to
    // the hash or to `labelHalfWidth` moved any of these, the case would stop being the
    // case and would still pass.
    expect(labelHalfWidth(NARROW_TITLE) + labelHalfWidth(GAP_TITLE)).toBeLessThan(4);
    expect(labelHalfWidth(NARROW_TITLE) + labelHalfWidth(WIDE_TITLE)).toBeGreaterThan(8);
    expect(Math.abs(yOffset(narrow) - yOffset(wide))).toBeLessThan(NODE_FOOTPRINT_HEIGHT);
    expect(Math.abs(yOffset(gap) - yOffset(narrow))).toBeGreaterThan(NODE_FOOTPRINT_HEIGHT);

    const placed = layout.place([narrow, gap, wide]);
    expect(grantedIds(placed)).toEqual(['evt_prune_narrow', 'evt_prune_gap']);
    expect(overlappingGrantedPairs(placed)).toEqual([]);
  });
});

describe('a suppressed label occupies no space of its own', () => {
  it('does not go on to suppress a third node on behalf of a label nobody is drawing', () => {
    // `first` blocks `blocked`; `blocked` would block `third` if it were still holding a
    // label box, and it is not. The node is drawn either way — only the annotation is
    // negotiable — so a suppressed node that kept suppressing would thin the corridor
    // twice for one collision.
    const first = event('evt_chain_first', 'tech', BASE_X, WIDE_TITLE);
    const blocked = event('evt_chain_blocked', 'tech', BASE_X + 9, WIDE_TITLE);
    const third = event('evt_chain_third', 'tech', BASE_X + 18, NARROW_TITLE);

    expect(Math.abs(yOffset(first) - yOffset(blocked))).toBeLessThan(NODE_FOOTPRINT_HEIGHT);
    expect(Math.abs(yOffset(blocked) - yOffset(third))).toBeLessThan(NODE_FOOTPRINT_HEIGHT);
    // `third` is out of `first`'s reach (9.35) but inside `blocked`'s.
    expect(labelHalfWidth(WIDE_TITLE) + labelHalfWidth(NARROW_TITLE)).toBeLessThan(18);
    expect(labelHalfWidth(WIDE_TITLE) + labelHalfWidth(NARROW_TITLE)).toBeGreaterThan(9);

    expect(grantedIds(layout.place([first, blocked, third]))).toEqual([
      'evt_chain_first',
      'evt_chain_third',
    ]);
  });
});

describe('collisions across a band boundary are caught, not just inside a band', () => {
  it('suppresses a label 0.6 units above another — the whole gutter, in one step', () => {
    // Adjacent bands leave BAND_GAP x (1 - BAND_FILL) = 0.60 units between their node
    // centres. A labelled node is NODE_FOOTPRINT_HEIGHT = 1.605 tall, so a node at the
    // top of one band and one at the bottom of the next are inside each other's
    // footprint by a factor of nearly three. The two ids below were chosen to sit at
    // those extremes; `bandExtent` says the centres are disjoint, and they are — which
    // is exactly why the SPHERE claim is not the LABEL claim.
    const below = event('evt_gutter_below_xc', 'tech', BASE_X, NARROW_TITLE);
    const above = event('evt_gutter_above_iy', 'scientific', BASE_X + 0.5, NARROW_TITLE);

    expect(BAND_GAP * (1 - BAND_FILL)).toBeCloseTo(0.6, 12);
    expect(BAND_GAP * (1 - BAND_FILL)).toBeLessThan(NODE_FOOTPRINT_HEIGHT);

    const gap = yOffset(above) - yOffset(below);
    expect(gap).toBeGreaterThan(BAND_GAP * (1 - BAND_FILL));
    expect(gap).toBeLessThan(0.7);
    expect(gap).toBeLessThan(NODE_FOOTPRINT_HEIGHT);

    expect(grantedIds(layout.place([below, above]))).toEqual(['evt_gutter_below_xc']);
  });
});

describe('a P5-shaped pile-up is actually thinned', () => {
  /**
   * P5.1's North Korean War: eight bullets from 31 Dec 2041 to 27 Jan 2042 — 27 days,
   * **0.739 world units**, about one node diameter — spread over three category bands
   * that hold roughly 1.5 labelled nodes each.
   */
  const CLUSTER_SPAN = 0.739;
  const CLUSTER = Array.from({ length: 8 }, (_, i) =>
    event(
      `evt_nk_war_${i + 1}`,
      (['military', 'political', 'disaster'] as const)[i % 3]!,
      BASE_X + (i * CLUSTER_SPAN) / 7,
      `North Korean war bullet ${i + 1}`,
    ),
  );

  it('grants strictly fewer than eight labels to eight events inside 0.739 units', () => {
    // The assertion a no-op `place()` fails. Eight titles of half-width ~3.5 inside 0.74
    // units of x is every pair overlapping in x, so only y can separate them — and three
    // bands 2.4 units tall hold about four 1.605-unit footprints between them.
    const placed = layout.place(CLUSTER);
    const granted = grantedIds(placed);
    expect(granted.length).toBeLessThan(8);
    expect(granted.length).toBeGreaterThanOrEqual(1);
    expect(overlappingGrantedPairs(placed)).toEqual([]);
  });

  it('always keeps the earliest of the pile-up, whichever order it is handed over in', () => {
    // Greedy and first-come-first-served in x: the leftmost node has nothing granted to
    // its left, so it can never be the one that gives way. That is the property that
    // makes the outcome a function of the data rather than of the traversal.
    for (const order of [CLUSTER, [...CLUSTER].reverse(), [...CLUSTER].sort()]) {
      expect(grantedIds(layout.place(order))).toContain('evt_nk_war_1');
    }
  });
});

// ---------------------------------------------------------------------------
// y is a hash, and the hash is the same everywhere
// ---------------------------------------------------------------------------

describe('unitHash is the same number in every engine and every process', () => {
  /**
   * Goldens. `Math.imul`, xor and shift are exact 32-bit integer ops, so node and the
   * browser must agree to the last bit; these were computed once and written down.
   * A change to the hash constants re-lays out every save, and moves every camera fly-to
   * target, every relation arc endpoint and every shared URL with it.
   */
  const GOLDENS: ReadonlyArray<readonly [string, number]> = [
    ['evt_lazaro_born', 0.022654056336485984],
    ['evt_big_one', 0.4884498885614684],
    ['evt_ridge_probing_begins', 0.26528814296699976],
    ['a', 0.10352621377637405],
    ['', 0.6689221932137981],
  ];

  it('reproduces its committed goldens exactly, including for the empty string', () => {
    for (const [text, expected] of GOLDENS) {
      expect(unitHash(text), `unitHash(${JSON.stringify(text)})`).toBe(expected);
    }
  });

  it('stays inside [0, 1) and spreads across it', () => {
    // A hash that collapsed — a truncation bug, a lost high word — would still be
    // deterministic and would still be in range, and would stack a whole band on one
    // line. So the spread is asserted: 4000 samples, every decile occupied, and the mean
    // near a half.
    const samples = Array.from({ length: 4000 }, (_, i) => unitHash(`evt_spread_${i}`));
    for (const value of samples) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
    const deciles = new Set(samples.map((value) => Math.floor(value * 10)));
    expect(deciles.size).toBe(10);
    expect(samples.reduce((sum, value) => sum + value, 0) / samples.length).toBeCloseTo(0.5, 1);
    expect(new Set(samples).size).toBeGreaterThan(3990);
  });

  it('gives two ids that differ by one character completely different offsets', () => {
    // The avalanche finish is what stops `evt_x_1` and `evt_x_2` landing on top of each
    // other, which is the shape ids in this corpus actually have.
    expect(Math.abs(unitHash('evt_nk_war_1') - unitHash('evt_nk_war_2'))).toBeGreaterThan(0.05);
  });
});

describe('yOffset is a pure function of the id and the category', () => {
  /** Written down, for the same reason `unitHash`'s goldens are. */
  const Y_GOLDENS: ReadonlyArray<readonly [string, number]> = [
    ['evt_lazaro_born', 7.854369735207566],
    ['evt_big_one', -9.027720267452477],
    ['evt_ridge_probing_begins', 2.4366915431207996],
    ['evt_megablock_1_groundbreaking', 0.9141188447384841],
  ];

  it('reproduces its committed goldens, so a reload never moves a node', () => {
    const byId = new Map(CORRIDOR_FIXTURE.map((e) => [e.id, e]));
    for (const [id, expected] of Y_GOLDENS) {
      expect(yOffset(byId.get(id)!), id).toBe(expected);
    }
  });

  it('ignores everything about an event except its id and its category', () => {
    // Not the date, not the title, not the corpus it was placed with. A y that read the
    // date would move when a date was re-rolled; one that read the title would move on
    // an edit.
    const base = event('evt_pure', 'tech', BASE_X, 'One title');
    expect(yOffset({ ...base, when: at(500), title: 'A completely different title' })).toBe(
      yOffset(base),
    );
    expect(yOffset({ ...base, category: 'personal' })).not.toBe(yOffset(base));
  });

  it('keeps every node inside its own category band', () => {
    for (const category of CATEGORIES) {
      const [low, high] = bandExtent(category);
      for (let i = 0; i < 500; i++) {
        const y = yOffset({ id: `evt_band_${i}`, category, when: at(1), title: 't' });
        expect(y).toBeGreaterThanOrEqual(low);
        expect(y).toBeLessThanOrEqual(high);
      }
    }
  });
});

describe('the bands are disjoint in their CENTRES and nowhere else', () => {
  it('gives every category a band of its own, centred on the corridor axis', () => {
    const centres = CATEGORIES.map(bandCenter).sort((a, b) => a - b);
    expect(centres.length).toBe(7);
    expect(centres.reduce((sum, c) => sum + c, 0)).toBeCloseTo(0, 12);
    for (let i = 1; i < centres.length; i++) {
      expect(centres[i]! - centres[i - 1]!).toBeCloseTo(BAND_GAP, 12);
    }
  });

  it('leaves no overlap between two bands centre intervals', () => {
    // This is `bandExtent`'s real claim and all of it: two events of different
    // categories can never share a centre y.
    const extents = CATEGORIES.map(bandExtent).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < extents.length; i++) {
      expect(extents[i]![0]).toBeGreaterThan(extents[i - 1]![1]);
    }
  });

  it('is nevertheless overlapped by the labels, which is why place() has to exist', () => {
    // The claim `bandExtent`'s docstring used to make — that disjoint centres mean two
    // categories never visually overlap — is false, and the arithmetic is the reason no
    // retuning of BAND_GAP / BAND_FILL fixes it. Asserted here so a future author who
    // reaches for the geometry knob is contradicted by the suite rather than by a
    // screenshot.
    const gutter = BAND_GAP * (1 - BAND_FILL);
    expect(gutter).toBeLessThan(NODE_FOOTPRINT_HEIGHT);
    expect(gutter).toBeLessThan(2 * EVENT_NODE_RADIUS);
    // Disjoint footprints would need a gap 2.7x the current one, stacking the seven
    // bands well past the ~37-unit visible pane.
    expect(NODE_FOOTPRINT_HEIGHT / (1 - BAND_FILL)).toBeGreaterThan(2.5 * BAND_GAP);
    // Holding BAND_GAP and shrinking the fill instead makes a band narrower than one
    // node's own footprint, so intra-band crowding gets strictly worse.
    expect(BAND_GAP - NODE_FOOTPRINT_HEIGHT).toBeLessThan(NODE_FOOTPRINT_HEIGHT);
  });
});
