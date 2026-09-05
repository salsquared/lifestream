import { describe, expect, it } from 'vitest';

import { CORRIDOR_FIXTURE } from '@client/views/timeline/fixture';
import { byWhenThenId, corridorCorpus } from '@client/views/timeline/corpus';

import type { CorridorSource } from '@client/views/timeline/corpus';
import type { WorldStatus } from '@client/shell/stores/world';
import type { HydratedEvent, IsoInstant } from '@shared/types/index';

/**
 * P4.1 / review decision D2 — what the Corridor draws for each phase of the shell's load.
 *
 * ── WHY THIS SPEC EXISTS ─────────────────────────────────────────────────────────────
 * The finding this module closes was a MISSING case, not a wrong one. `TimelineView`
 * gated the fixture on `rows.length === 0`, which is true of two states that mean
 * opposite things: *not loaded yet* and *loaded, and genuinely empty*. `loadSave`
 * returns `events: []` for a save with no timelines and `hydrate` then sets
 * `status: 'ready'`, so the reader saw thirteen fictional canon events under a badge
 * reading "Fixture data — no save hydrated yet." while the store said ready — a false
 * statement about a corpus the user is entitled to believe is theirs. Nothing raised.
 * It becomes reachable in normal use the moment P6 lands a second save.
 *
 * A missing case is only closed by enumerating them, so the table below asserts all TEN
 * combinations of `WorldStatus` x (empty | non-empty) rather than a representative
 * sample: five statuses, both row counts, every one of them named. The table is typed as
 * a total `Record<WorldStatus, …>`, so a sixth status cannot be added to the store
 * without this file failing to compile alongside `corpus.ts`'s own `never` default.
 *
 * Three properties beyond the table, each of which a plausible "simplification" loses:
 *
 *   - **`pending` and `empty` hand back the SAME array object** every call. That is
 *     deliberate — `TimelineView` memoizes its layout on `events`, so a fresh `[]` per
 *     call would rebuild the whole placement on every status tick. Asserted with `toBe`.
 *   - **Rows are sorted, and the caller's array is not touched.** `useWorld.events` is a
 *     `Record` and `Object.values` returns insertion order, which is an artefact of how
 *     the payload was assembled rather than a fact about the corpus; the layout's
 *     de-collision then depends on that order being stable.
 *   - **An unknown status throws.** The `never` default is a compile-time guard, and a
 *     cast gets past it, so the runtime half is asserted too.
 */

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** A minimal `HydratedEvent`; only `id` and `when` are read by anything under test. */
const row = (id: string, when: IsoInstant): HydratedEvent => ({
  id,
  saveId: 'sav_spec',
  title: id,
  description: '',
  whenMin: when,
  whenMax: when,
  whenPrecision: 'time',
  when,
  category: 'personal',
  actorIds: [],
  tagIds: [],
});

/**
 * Deliberately NOT in `when` order, and carrying a `when` tie so the id tiebreak is
 * exercised: this is the shape `Object.values(useWorld.events)` actually arrives in.
 */
const UNSORTED: readonly HydratedEvent[] = [
  row('evt_c', '2040-01-01T00:00:00.000Z'),
  row('evt_a', '2030-06-01T12:00:00.000Z'),
  row('evt_b_second', '2035-01-01T00:00:00.000Z'),
  row('evt_b_first', '2035-01-01T00:00:00.000Z'),
];

const SORTED_IDS = ['evt_a', 'evt_b_first', 'evt_b_second', 'evt_c'];

const EMPTY: readonly HydratedEvent[] = [];

// ---------------------------------------------------------------------------
// The rule, all ten cases
// ---------------------------------------------------------------------------

/** What the corridor draws — the question `source` answers, restated independently. */
type Draws = 'the fixture' | "the caller's rows" | 'nothing';

interface Expected {
  readonly source: CorridorSource;
  readonly notice: string | undefined;
  readonly draws: Draws;
}

const FIXTURE_IDLE: Expected = {
  source: 'fixture',
  notice: 'Fixture data — no save loaded.',
  draws: 'the fixture',
};

const FIXTURE_ERROR: Expected = {
  source: 'fixture',
  notice: 'World load failed — drawing the seeded fixture.',
  draws: 'the fixture',
};

const RELOADING: Expected = { source: 'pending', notice: 'Reloading…', draws: 'nothing' };

/**
 * The rule from D2, as a total `Record` over the status union.
 *
 * Ten entries because the decision is a function of two inputs, and the bug was a pair
 * of them being collapsed into one. `idle`, `error` and `stale` genuinely ignore the row
 * count — they are written out twice anyway, because "this status ignores rows" is
 * itself a claim worth failing on.
 */
const RULE: Readonly<
  Record<WorldStatus, { readonly empty: Expected; readonly nonEmpty: Expected }>
> = {
  idle: { empty: FIXTURE_IDLE, nonEmpty: FIXTURE_IDLE },
  error: { empty: FIXTURE_ERROR, nonEmpty: FIXTURE_ERROR },
  loading: {
    empty: { source: 'pending', notice: 'Loading world…', draws: 'nothing' },
    nonEmpty: { source: 'world', notice: 'Reloading…', draws: "the caller's rows" },
  },
  stale: { empty: RELOADING, nonEmpty: RELOADING },
  ready: {
    empty: { source: 'empty', notice: 'This save has no events.', draws: 'nothing' },
    nonEmpty: { source: 'world', notice: undefined, draws: "the caller's rows" },
  },
};

/** The ten cases, flattened, so each one is its own `it`. */
const CASES = Object.entries(RULE).flatMap(([status, byRows]) =>
  [['empty', EMPTY] as const, ['nonEmpty', UNSORTED] as const].map(([count, rows]) => ({
    status: status as WorldStatus,
    label: count === 'empty' ? 'no rows' : `${UNSORTED.length} rows`,
    rows,
    expected: byRows[count],
  })),
);

/** The ids a case is expected to draw, given what `draws` names. */
const expectedIds = (draws: Draws): readonly string[] =>
  draws === 'the fixture'
    ? CORRIDOR_FIXTURE.map((event) => event.id)
    : draws === "the caller's rows"
      ? SORTED_IDS
      : [];

describe('corridorCorpus decides on the load status, over all ten (status x rows) cases', () => {
  expect(CASES.length).toBe(10);

  for (const { status, label, rows, expected } of CASES) {
    it(`draws ${expected.draws} for '${status}' with ${label}`, () => {
      const corpus = corridorCorpus(status, rows);
      expect(corpus.source).toBe(expected.source);
      expect(corpus.notice).toBe(expected.notice);
      expect(corpus.events.map((event) => event.id)).toEqual(expectedIds(expected.draws));
    });
  }
});

// ---------------------------------------------------------------------------
// The cases the table exists for
// ---------------------------------------------------------------------------

describe('the fixture never stands in for a real load', () => {
  it("shows an empty save as empty, not as the fixture's thirteen canon events", () => {
    // THE regression. Before D2 this returned `CORRIDOR_FIXTURE` under the notice
    // "Fixture data — no save hydrated yet." while the store reported `ready`.
    const corpus = corridorCorpus('ready', EMPTY);
    expect(corpus.events).toEqual([]);
    expect(corpus.source).toBe('empty');
    expect(corpus.notice).toBe('This save has no events.');
    expect(corpus.events).not.toBe(CORRIDOR_FIXTURE);
  });

  it("keeps the previous save's rows on screen while the next save loads", () => {
    // `useSaveLoad` deliberately does not blank the store before a refetch, so a save
    // switch redraws instead of flashing empty. Gating on rows alone would have shown
    // the FIXTURE here — canon events, mid-switch, over a real world.
    const corpus = corridorCorpus('loading', UNSORTED);
    expect(corpus.source).toBe('world');
    expect(corpus.events.map((event) => event.id)).toEqual(SORTED_IDS);
    expect(corpus.notice).toBe('Reloading…');
  });

  it('hands back the fixture array itself for idle and error, rows or no rows', () => {
    // Identity, not equality: the fixture is a module constant and copying it per call
    // would defeat the caller's memo the same way a fresh `[]` would.
    expect(corridorCorpus('idle', EMPTY).events).toBe(CORRIDOR_FIXTURE);
    expect(corridorCorpus('idle', UNSORTED).events).toBe(CORRIDOR_FIXTURE);
    expect(corridorCorpus('error', EMPTY).events).toBe(CORRIDOR_FIXTURE);
    expect(corridorCorpus('error', UNSORTED).events).toBe(CORRIDOR_FIXTURE);
  });

  it('leaves the notice undefined for exactly one of the ten cases', () => {
    // A notice is a caveat, and `ready` + rows is the only case with nothing to caveat.
    // Written as a count so a second silent case cannot be introduced unnoticed.
    const silent = CASES.filter(
      ({ status, rows }) => corridorCorpus(status, rows).notice === undefined,
    );
    expect(silent.map(({ status, label }) => `${status} / ${label}`)).toEqual([
      `ready / ${UNSORTED.length} rows`,
    ]);
  });
});

describe('the two zero-row corpora are one shared frozen array', () => {
  it('returns the identical array for pending and empty, on every call', () => {
    // `TimelineView` memoizes `place(events)` on this reference. A fresh `[]` per call
    // would re-place the whole corpus on every status tick — which is why this is `toBe`
    // and not `toEqual`, and why "simplifying" it back to `[]` has to fail here.
    const first = corridorCorpus('ready', EMPTY).events;
    expect(corridorCorpus('ready', EMPTY).events).toBe(first);
    expect(corridorCorpus('loading', EMPTY).events).toBe(first);
    expect(corridorCorpus('stale', EMPTY).events).toBe(first);
    expect(corridorCorpus('stale', UNSORTED).events).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
  });
});

describe('rows are ordered by the corpus, not by the store', () => {
  it('sorts by when, then by id, whatever order the store hands them over in', () => {
    // `Object.values` on `useWorld.events` returns payload-assembly order. Two loads of
    // one save must produce one array, because the layout's label de-collision derives
    // its own sweep order from the data and its determinism assumes this is stable.
    const forward = corridorCorpus('ready', UNSORTED).events.map((event) => event.id);
    const reversed = corridorCorpus('ready', [...UNSORTED].reverse()).events.map((e) => e.id);
    expect(forward).toEqual(SORTED_IDS);
    expect(reversed).toEqual(SORTED_IDS);
  });

  it('breaks a tie on when with the id, so simultaneous events have one order', () => {
    // `evt_b_first` and `evt_b_second` share an instant to the millisecond; without the
    // id tiebreak their relative order would be whatever `Array.sort` happened to do.
    const ids = corridorCorpus('ready', UNSORTED).events.map((event) => event.id);
    expect(ids.indexOf('evt_b_first')).toBeLessThan(ids.indexOf('evt_b_second'));
    expect(byWhenThenId(UNSORTED[2]!, UNSORTED[3]!)).toBeGreaterThan(0);
    expect(byWhenThenId(UNSORTED[3]!, UNSORTED[2]!)).toBeLessThan(0);
    expect(byWhenThenId(UNSORTED[0]!, UNSORTED[0]!)).toBe(0);
  });

  it('does not reorder the array it was given', () => {
    // The parameter is `readonly`, and a bare `rows.sort()` would sort the store's own
    // array in place — a mutation of state the view is currently rendering from.
    const caller = [...UNSORTED];
    corridorCorpus('ready', caller);
    expect(caller.map((event) => event.id)).toEqual(UNSORTED.map((event) => event.id));
  });
});

describe('an unknown status is refused rather than absorbed', () => {
  it('throws, naming the status, when handed a member WorldStatus does not have', () => {
    // The `never` default is a COMPILE-time guard and a cast walks straight past it, so
    // the runtime half is asserted here. A sixth status added to the store therefore
    // fails twice: at `tsc`, and here.
    expect(() => corridorCorpus('hydrating' as WorldStatus, EMPTY)).toThrow(RangeError);
    expect(() => corridorCorpus('hydrating' as WorldStatus, EMPTY)).toThrow(/hydrating/);
  });
});
