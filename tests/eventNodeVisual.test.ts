import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CORRIDOR_FIXTURE } from '@client/views/timeline/fixture';
import {
  approachScale,
  eventNodeVisual,
  labelHalfWidth,
  labelVisible,
  DATE_FONT_SIZE,
  DIMMED_EMISSIVE,
  DIMMED_OPACITY,
  EVENT_NODE_RADIUS,
  HOVER_SCALE,
  HOVER_TWEEN_SECONDS,
  LABEL_ADVANCE_RATIO,
  LABEL_DATE_OFFSET_Y,
  LABEL_MIN_HALF_WIDTH,
  LABEL_OFFSET_Y,
  NODE_FOOTPRINT_ABOVE,
  NODE_FOOTPRINT_BELOW,
  NODE_FOOTPRINT_HEIGHT,
  TITLE_FONT_SIZE,
} from '@client/views/_shared/eventNodeVisual';
import { DEFAULT_BLOOM } from '@client/views/_shared/sceneSettings';
import { CATEGORY_COLOR } from '@shared/colors';

import type { EventNodeState } from '@client/views/_shared/eventNodeVisual';
import type { Category } from '@shared/types/index';

/**
 * P4.3.3 / P4.3.5 and review decisions D3a, D3c, D4, D5 — everything `EventNode` decides,
 * asserted without a GPU.
 *
 * ── WHY THIS SPEC EXISTS ─────────────────────────────────────────────────────────────
 * This module exists *specifically* so a node's appearance is a unit test rather than a
 * screenshot, and until now nothing referenced it. Three things it holds are load-bearing
 * and would fail quietly:
 *
 *   1. **The two axes compose.** §5.2 is normative: "Glow is additive …; filtering is
 *      subtractive … A node can be both glowing and filtered out, and it should look like
 *      exactly that." One enum cannot say two things at once, which is why the superseded
 *      four-member `EventNodeState` was split into `state` x `dimmed`. The single sharpest
 *      assertion in this file is therefore that a `glow` node which is also `dimmed`
 *      keeps a NON-ZERO halo: re-collapsing the axes (a `'faded'` member, an early return
 *      that zeroes the halo when filtered) reopens exactly the gap the split closed.
 *   2. **The label geometry is one set of numbers.** `views/timeline/layout.ts`
 *      de-collides with the constants `EventNode` draws with. A second copy would drift
 *      silently — the layout would keep suppressing labels the component had stopped
 *      overlapping — so `NODE_FOOTPRINT_HEIGHT` is asserted at the value the layout, the
 *      `BAND_FILL` docstring and the architecture doc all quote: **1.605**.
 *   3. **The hover tween is frame-rate independent.** A fixed per-frame lerp makes the
 *      same gesture twice as fast on a 144 Hz display as on a 60 Hz one, which no test
 *      that runs one frame at a time would notice.
 *
 * ── ONE THING THIS SPEC DELIBERATELY DOES NOT CLAIM ──────────────────────────────────
 * `DIMMED_EMISSIVE`'s docstring reasons that a dimmed node must not bloom, and that is
 * true today only of a `normal` node. `focused` (2.4) and `glow` (1.5) still land above
 * `DEFAULT_BLOOM.luminanceThreshold` after being scaled by 0.18. The assertions below
 * pin all three against the real threshold rather than asserting the docstring's
 * aspiration, so a future change to either number is a decision someone has to make
 * rather than a side effect. See the note reported alongside this spec.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// ---------------------------------------------------------------------------
// The two closed enums
// ---------------------------------------------------------------------------

/**
 * Every member of the SELECTION axis. A total `Record`, so a fourth member — a
 * re-introduced `'faded'`, say — fails to compile here as well as in `VISUALS`.
 */
const STATE_MEANING: Readonly<Record<EventNodeState, string>> = {
  normal: 'in the corridor, nothing selected that concerns it',
  focused: "the selection's primary",
  glow: 'a relation of the primary',
};

const STATES = Object.keys(STATE_MEANING) as EventNodeState[];

/** Read off the palette's own total `Record`, so a new category appears here too. */
const CATEGORIES = Object.keys(CATEGORY_COLOR) as Category[];

const EVERY_COMBINATION = STATES.flatMap((state) =>
  CATEGORIES.flatMap((category) => [
    { state, category, dimmed: false },
    { state, category, dimmed: true },
  ]),
);

// ---------------------------------------------------------------------------
// Totality and hue
// ---------------------------------------------------------------------------

describe('eventNodeVisual answers for every state x category x dimmed', () => {
  it('returns a finite, in-range visual for all forty-two combinations', () => {
    expect(EVERY_COMBINATION.length).toBe(3 * 7 * 2);
    for (const { state, category, dimmed } of EVERY_COMBINATION) {
      const visual = eventNodeVisual(state, category, dimmed);
      const where = `${state}/${category}${dimmed ? '/dimmed' : ''}`;
      expect(visual.color, where).toBe(CATEGORY_COLOR[category]);
      for (const [field, value] of Object.entries(visual)) {
        if (field === 'color') continue;
        expect(Number.isFinite(value), `${where}.${field}`).toBe(true);
        expect(value as number, `${where}.${field}`).toBeGreaterThanOrEqual(0);
      }
      for (const field of ['opacity', 'labelOpacity', 'haloOpacity'] as const) {
        expect(visual[field], `${where}.${field}`).toBeLessThanOrEqual(1);
      }
      expect(visual.radiusScale, where).toBeGreaterThan(0);
    }
  });

  it('moves brightness with the state and never the hue', () => {
    // The palette is `@shared/colors`' and this module must never hold a hex string of
    // its own (P4.3.6): a second palette is drift the export renderer would surface long
    // after anyone was looking. A state that tinted a node would be that second palette.
    for (const category of CATEGORIES) {
      const colors = new Set(
        EVERY_COMBINATION.filter((c) => c.category === category).map(
          (c) => eventNodeVisual(c.state, category, c.dimmed).color,
        ),
      );
      expect([...colors]).toEqual([CATEGORY_COLOR[category]]);
    }
    expect(new Set(CATEGORIES.map((c) => eventNodeVisual('normal', c).color)).size).toBe(7);
  });

  it('makes the two selected states brighter and bigger than an ordinary node', () => {
    // Without this a `focused` node that read identically to a `normal` one would pass
    // every other assertion in this file.
    const normal = eventNodeVisual('normal', 'tech');
    for (const state of ['focused', 'glow'] as const) {
      const selected = eventNodeVisual(state, 'tech');
      expect(selected.emissiveIntensity).toBeGreaterThan(normal.emissiveIntensity);
      expect(selected.radiusScale).toBeGreaterThan(normal.radiusScale);
      expect(selected.haloOpacity).toBeGreaterThan(0);
    }
    expect(normal.haloOpacity).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §5.2: additive and subtractive at once
// ---------------------------------------------------------------------------

describe('glow and filtering are orthogonal, which is the whole reason for two axes', () => {
  it('keeps a glowing node’s halo when it is also filtered out', () => {
    // THE assertion. A dimmed `glow` node is still a search hit; it is just not passing
    // the current filter, and it has to look like both at once. A four-member enum
    // could not express this, and any change that collapses the axes back into one —
    // zeroing the halo when dimmed, re-adding a `'faded'` member — fails here.
    const glowDimmed = eventNodeVisual('glow', 'tech', true);
    expect(glowDimmed.haloOpacity).toBeGreaterThan(0);
    expect(glowDimmed.haloOpacity).toBeCloseTo(
      eventNodeVisual('glow', 'tech').haloOpacity * DIMMED_OPACITY,
      12,
    );
    // …and it is unmistakably filtered at the same time.
    expect(glowDimmed.opacity).toBeCloseTo(DIMMED_OPACITY, 12);
    expect(glowDimmed.opacity).toBeLessThan(eventNodeVisual('glow', 'tech').opacity);
  });

  it('gives a dimmed ordinary node no halo, so the halo still means "selected"', () => {
    // The complement of the case above: dimming does not INVENT a halo, it only scales
    // one that the state already asked for.
    expect(eventNodeVisual('normal', 'tech', true).haloOpacity).toBe(0);
  });

  it('fades a filtered node without resizing it, so density never lies', () => {
    // §5.2: filtering fades and never removes. A size that tracked the filter would
    // make the corridor's apparent density a function of the search box.
    for (const { state, category } of EVERY_COMBINATION) {
      const lit = eventNodeVisual(state, category);
      const dim = eventNodeVisual(state, category, true);
      expect(dim.radiusScale, `${state}/${category}`).toBe(lit.radiusScale);
      expect(dim.opacity).toBeLessThan(lit.opacity);
      expect(dim.labelOpacity).toBeLessThan(lit.labelOpacity);
      expect(dim.emissiveIntensity).toBeLessThan(lit.emissiveIntensity);
    }
  });

  it('scales opacity and emissive by their own constants, not by one shared literal', () => {
    // D5: the two coincide at 0.18 today and are different numbers in principle —
    // opacity decides how much of a node you see through, emissive decides whether it
    // BLOOMS. Each is used in exactly one place, so tuning the bloom cannot silently
    // change what filtering looks like.
    const lit = eventNodeVisual('focused', 'disaster');
    const dim = eventNodeVisual('focused', 'disaster', true);
    expect(dim.opacity).toBeCloseTo(lit.opacity * DIMMED_OPACITY, 12);
    expect(dim.emissiveIntensity).toBeCloseTo(lit.emissiveIntensity * DIMMED_EMISSIVE, 12);
  });

  it('takes a dimmed ordinary node under the bloom threshold, a selected one only nearer', () => {
    // Emissive luminance is `emissiveIntensity x luma(colour)` and luma is at most 1, so
    // an intensity below `DEFAULT_BLOOM.luminanceThreshold` cannot bloom whatever the
    // hue — a sufficient condition, read from the constant rather than retyped.
    //
    // That holds for `normal` and NOT for the two selected states, which is the current
    // behaviour rather than the one `DIMMED_EMISSIVE`'s docstring argues for. Pinned so
    // a change to either number has to be argued.
    const threshold = DEFAULT_BLOOM.luminanceThreshold;
    expect(eventNodeVisual('normal', 'tech').emissiveIntensity).toBeGreaterThan(threshold);
    expect(eventNodeVisual('normal', 'tech', true).emissiveIntensity).toBeLessThan(threshold);
    expect(eventNodeVisual('glow', 'tech', true).emissiveIntensity).toBeGreaterThan(threshold);
    expect(eventNodeVisual('focused', 'tech', true).emissiveIntensity).toBeGreaterThan(threshold);
  });
});

// ---------------------------------------------------------------------------
// The label the layout suppressed comes back
// ---------------------------------------------------------------------------

describe('labelVisible: density hides labels the reader did not ask for, and no others', () => {
  /** The whole truth table — three states x labelled x hovered. */
  const TRUTH: ReadonlyArray<readonly [EventNodeState, boolean, boolean, boolean]> = [
    ['normal', true, false, true],
    ['normal', true, true, true],
    ['normal', false, false, false],
    ['normal', false, true, true],
    ['focused', true, false, true],
    ['focused', true, true, true],
    ['focused', false, false, true],
    ['focused', false, true, true],
    ['glow', true, false, true],
    ['glow', true, true, true],
    ['glow', false, false, true],
    ['glow', false, true, true],
  ];

  it('hides a label in exactly one of the twelve cases: unlabelled, unhovered, normal', () => {
    for (const [state, labelled, hovered, expected] of TRUTH) {
      expect(labelVisible(state, labelled, hovered), `${state}/${labelled}/${hovered}`).toBe(
        expected,
      );
    }
    expect(TRUTH.filter(([, , , visible]) => !visible).length).toBe(1);
  });

  it('brings a suppressed label back the moment the reader points at the node', () => {
    // Without the `hovered` term a suppressed node is an unidentifiable dot with no way
    // to find out what it is — a worse corridor than an overlapping one.
    expect(labelVisible('normal', false, false)).toBe(false);
    expect(labelVisible('normal', false, true)).toBe(true);
  });

  it('never lets the layout suppress a label the selection asked for', () => {
    // `focused` is the primary and `glow` is a relation of it; both are things the
    // reader deliberately asked to see named, so the layout's verdict is a default and
    // not a veto.
    for (const state of ['focused', 'glow'] as const) {
      expect(labelVisible(state, false, false)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Label geometry — one set of numbers, shared with the layout
// ---------------------------------------------------------------------------

describe('the label geometry composes to the 1.605 footprint the layout de-collides on', () => {
  it('measures a labelled node at exactly 1.605 world units, sphere bottom to title top', () => {
    // `layout.ts`, `BAND_FILL`'s docstring and the architecture doc all quote this
    // number. All three have to move together, so it is asserted as a literal and not
    // recomputed from the parts it is made of.
    expect(NODE_FOOTPRINT_HEIGHT).toBe(1.605);
    expect(NODE_FOOTPRINT_ABOVE).toBe(1.255);
    expect(NODE_FOOTPRINT_BELOW).toBe(EVENT_NODE_RADIUS);
    expect(NODE_FOOTPRINT_ABOVE + NODE_FOOTPRINT_BELOW).toBe(NODE_FOOTPRINT_HEIGHT);
    expect(NODE_FOOTPRINT_ABOVE).toBe(LABEL_OFFSET_Y + TITLE_FONT_SIZE / 2);
  });

  it('puts the date line between the sphere and the title, bounding neither end', () => {
    // The second line is why the footprint is not simply "title box"; it is also why it
    // sets neither bound, which is what lets the box be described by two numbers.
    const dateBaseline = LABEL_OFFSET_Y + LABEL_DATE_OFFSET_Y;
    const dateBottom = dateBaseline - DATE_FONT_SIZE / 2;
    const dateTop = dateBaseline + DATE_FONT_SIZE / 2;
    expect(dateBottom).toBeCloseTo(0.315, 12);
    expect(dateBottom).toBeGreaterThan(-NODE_FOOTPRINT_BELOW);
    expect(dateTop).toBeLessThan(NODE_FOOTPRINT_ABOVE);
    expect(DATE_FONT_SIZE).toBeLessThan(TITLE_FONT_SIZE);
  });

  it('clears the largest a node ever gets, so a state change cannot move the label', () => {
    // `LABEL_OFFSET_Y` is deliberately independent of `state`: a label that moved when a
    // node was focused would make the layout's answer depend on the selection, and
    // labels would appear and vanish as the reader clicked around.
    const focusedRadius = EVENT_NODE_RADIUS * eventNodeVisual('focused', 'tech').radiusScale;
    expect(LABEL_OFFSET_Y - TITLE_FONT_SIZE / 2).toBeGreaterThan(focusedRadius * HOVER_SCALE);
  });
});

describe('labelHalfWidth tracks the string, with a floor for titles narrower than a date', () => {
  it('grows with the title, so a five-fold spread of widths is not one constant', () => {
    // The fixed 3.3 this replaced was wrong in both directions at once: it over-
    // suppressed "The Big One" and under-suppressed the 54-character study title.
    const widths = [10, 20, 40, 80].map((n) => labelHalfWidth('x'.repeat(n)));
    for (let i = 1; i < widths.length; i++) expect(widths[i]!).toBeGreaterThan(widths[i - 1]!);
    expect(labelHalfWidth('x'.repeat(40))).toBeCloseTo(
      (40 * TITLE_FONT_SIZE * LABEL_ADVANCE_RATIO) / 2,
      12,
    );
  });

  it('floors at a typical date line for titles of nine characters or fewer', () => {
    // A title shorter than its own date line would understate the box the reader sees.
    // Nine characters is where the two cross: 9 x 0.1375 = 1.2375, just under the floor.
    expect(labelHalfWidth('x'.repeat(9))).toBe(LABEL_MIN_HALF_WIDTH);
    expect(labelHalfWidth('')).toBe(LABEL_MIN_HALF_WIDTH);
    expect(labelHalfWidth('x'.repeat(10))).toBeGreaterThan(LABEL_MIN_HALF_WIDTH);
    expect(LABEL_MIN_HALF_WIDTH).toBeCloseTo((12 * DATE_FONT_SIZE * LABEL_ADVANCE_RATIO) / 2, 12);
  });

  it('is inert on today’s corpus, so the floor is a P5 guard and not an active rule', () => {
    // The shortest fixture title, "The Big One", is 11 characters and estimates 1.51.
    const shortest = Math.min(...CORRIDOR_FIXTURE.map((event) => event.title.length));
    expect(shortest).toBe('The Big One'.length);
    for (const event of CORRIDOR_FIXTURE) {
      expect(labelHalfWidth(event.title), event.id).toBeGreaterThan(LABEL_MIN_HALF_WIDTH);
    }
  });
});

// ---------------------------------------------------------------------------
// The hover tween
// ---------------------------------------------------------------------------

/** Integrate `frames` steps of `dt` from `from` toward `to`, as `useFrame` would. */
const integrate = (from: number, to: number, dt: number, frames: number, tween: number): number => {
  let current = from;
  for (let i = 0; i < frames; i++) current = approachScale(current, to, dt, tween);
  return current;
};

describe('approachScale covers the same ground per SECOND, not per frame', () => {
  it('reaches the same size on a 60 Hz and a 144 Hz display after the same wall time', () => {
    // The failure a fixed `lerp(current, target, 0.1)` has: on a 144 Hz display the same
    // gesture completes 2.4x faster, so the hover feels different on two machines and
    // nothing reports it. 1/12 s and 1/6 s are whole numbers of frames at both rates.
    for (const twelfths of [1, 2]) {
      const slow = integrate(1, HOVER_SCALE, 1 / 60, 5 * twelfths, HOVER_TWEEN_SECONDS);
      const fast = integrate(1, HOVER_SCALE, 1 / 144, 12 * twelfths, HOVER_TWEEN_SECONDS);
      expect(fast).toBeCloseTo(slow, 9);
      // Still mid-tween, so this is not two values that both simply landed on target.
      expect(slow).toBeGreaterThan(1);
      expect(slow).toBeLessThan(HOVER_SCALE);
    }
  });

  it('is nevertheless further along after the same number of frames at 60 Hz', () => {
    // The other half of the same claim: equal FRAMES are not equal time, and a
    // frame-rate-independent tween must show that.
    const slow = integrate(1, HOVER_SCALE, 1 / 60, 5, HOVER_TWEEN_SECONDS);
    const fast = integrate(1, HOVER_SCALE, 1 / 144, 5, HOVER_TWEEN_SECONDS);
    expect(slow).toBeGreaterThan(fast);
  });

  it('snaps exactly when the tween length is zero — the reduced-motion path', () => {
    // A distinct branch rather than a very small time constant, so it can never leave a
    // residual animation running (P4.4.5).
    expect(approachScale(1, HOVER_SCALE, 1 / 60, 0)).toBe(HOVER_SCALE);
    expect(approachScale(HOVER_SCALE, 1, 1 / 60, 0)).toBe(1);
    expect(approachScale(1, HOVER_SCALE, 1 / 60, -0.5)).toBe(HOVER_SCALE);
  });

  it('holds at `current` when NO time has passed — the opposite of the zero-tween case', () => {
    // A regression test for a real defect this spec found. The two zero cases used to
    // share one branch (`tweenSeconds <= 0 || deltaSeconds <= 0`) and return the target,
    // but they want opposite answers: a zero tween length means "arrive now", a zero frame
    // delta means "no time has passed, so no progress has been made".
    //
    // The function's own arithmetic already said so — at `deltaSeconds = 0` the decay is
    // `e^0 = 1` and `next` works out to exactly `current` — so the guard contradicted the
    // three lines beneath it.
    //
    // Reachable, not theoretical: `EventNode` drives this from r3f's `useFrame` delta,
    // which is 0 on a duplicated frame and on the first frame after a tab regains focus.
    // Under the old guard a hover tween that was mid-flight when the tab lost focus
    // completed instantly on return — precisely the frame-dependent behaviour the
    // exponential smoothing exists to prevent.
    const midFlight = 1.1;
    expect(approachScale(midFlight, HOVER_SCALE, 0, HOVER_TWEEN_SECONDS)).toBe(midFlight);
    expect(approachScale(midFlight, 1, 0, HOVER_TWEEN_SECONDS)).toBe(midFlight);
    expect(approachScale(midFlight, HOVER_SCALE, -0.004, HOVER_TWEEN_SECONDS)).toBe(midFlight);

    // A zero-length frame must not advance the tween AT ALL, so any number of them in a
    // row leaves the value exactly where it started.
    let held = midFlight;
    for (let i = 0; i < 50; i++) held = approachScale(held, HOVER_SCALE, 0, HOVER_TWEEN_SECONDS);
    expect(held).toBe(midFlight);

    // Reduced motion still wins over it: a zero tween length snaps even on a zero frame.
    expect(approachScale(midFlight, HOVER_SCALE, 0, 0)).toBe(HOVER_SCALE);
  });

  it('lands exactly on the target so a node that is done moving stops writing', () => {
    // Exponential decay never arrives, so without this the transform is rewritten every
    // frame for the life of the node.
    expect(approachScale(HOVER_SCALE - 1e-5, HOVER_SCALE, 1 / 60, HOVER_TWEEN_SECONDS)).toBe(
      HOVER_SCALE,
    );
    const settled = integrate(1, HOVER_SCALE, 1 / 60, 120, HOVER_TWEEN_SECONDS);
    expect(settled).toBe(HOVER_SCALE);
    expect(approachScale(settled, HOVER_SCALE, 1 / 60, HOVER_TWEEN_SECONDS)).toBe(HOVER_SCALE);
  });

  it('never overshoots, in either direction', () => {
    let up = 1;
    let down = HOVER_SCALE;
    for (let i = 0; i < 40; i++) {
      up = approachScale(up, HOVER_SCALE, 1 / 60, HOVER_TWEEN_SECONDS);
      down = approachScale(down, 1, 1 / 60, HOVER_TWEEN_SECONDS);
      expect(up).toBeLessThanOrEqual(HOVER_SCALE);
      expect(down).toBeGreaterThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// The shared barrel
// ---------------------------------------------------------------------------

describe('_shared/index re-exports everything a view has to reason about (D5)', () => {
  it('names the label geometry and the dimming constants in its export clause', () => {
    // `views/timeline/layout.ts` de-collides using these, and the allowed direction is
    // the view reaching in — a constant that stays module-private is a constant the
    // layout has to copy, which is exactly the drift moving them here prevents.
    //
    // Asserted against the export CLAUSE rather than by importing the barrel: the barrel
    // re-exports `EventNode` and `Scene3D`, so pulling it into this program would pull
    // two `.tsx` files into `tests/tsconfig.json`, which sets no `jsx`. The regex reads
    // the real `export { … } from './eventNodeVisual'` list, so a dropped name fails.
    const barrel = readFileSync(`${repoRoot}client/src/views/_shared/index.ts`, 'utf8');
    const clause = /export \{([^}]*)\} from '\.\/eventNodeVisual';/.exec(barrel);
    expect(clause, "no `export { … } from './eventNodeVisual'` in _shared/index.ts").not.toBe(null);

    const reExported = new Set(
      clause![1]!
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean),
    );
    for (const name of [
      'approachScale',
      'eventNodeVisual',
      'labelHalfWidth',
      'labelVisible',
      'DATE_FONT_SIZE',
      'DIMMED_EMISSIVE',
      'DIMMED_OPACITY',
      'LABEL_DATE_OFFSET_Y',
      'LABEL_MIN_HALF_WIDTH',
      'LABEL_OFFSET_Y',
      'NODE_FOOTPRINT_ABOVE',
      'NODE_FOOTPRINT_BELOW',
      'NODE_FOOTPRINT_HEIGHT',
      'TITLE_FONT_SIZE',
    ]) {
      expect([...reExported], name).toContain(name);
    }
  });
});
