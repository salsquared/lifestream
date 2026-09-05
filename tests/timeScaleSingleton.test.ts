import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { corridorCorpus } from '@client/views/timeline/corpus';
import { clampPan, panBounds } from '@client/views/timeline/pan';
import { CORRIDOR_END, CORRIDOR_START, TIME_SCALE, createTimeScale } from '@shared/timeScale';

import type { IsoInstant } from '@shared/types/index';

/**
 * Review decision D1 — the corridor's origin is a CONSTANT, and `TIME_SCALE` is one
 * object per process (architecture §5.2, normative).
 *
 * ── WHY THIS SPEC EXISTS ─────────────────────────────────────────────────────────────
 * `tests/timeScale.test.ts` covers `createTimeScale`'s algebra — the round trip, the
 * slope, the refusals — and D1 did not change any of it. What D1 changed is *who builds
 * a scale*: nobody, any more. The origin was `createTimeScale(earliest)` with `earliest`
 * taken from whatever corpus the view happened to hold, and that is the blocker this
 * file guards. Two things follow from it that a spec over the factory cannot see:
 *
 *   - **One object.** `min(when)` over the whole corpus is 2021-02-09; over
 *     `category='tech'` alone — which is exactly what P13.2 fetches — it is 2035-08-01.
 *     Two views deriving their own origin would sit **~145 world units apart** against a
 *     ~66-unit visible pane, and nothing in either view would look wrong on its own. So
 *     the assertion is about object identity, not about two constructions agreeing.
 *   - **A fixed origin means a fixed `range()`.** `panBounds` is derived from it, and
 *     from P8.6 onward camera poses are persisted against it, so the number is pinned
 *     here rather than recomputed.
 *
 * ── THE ACCEPTANCE CONDITION P5 INHERITS ─────────────────────────────────────────────
 * An event before `CORRIDOR_START` maps to a NEGATIVE x, which is outside `range()`,
 * therefore outside `panBounds`, therefore unreachable: the node is drawn and the camera
 * cannot be moved to it. Nothing raises. So the database block below asserts
 * `min(when_min) >= CORRIDOR_START` over the rows actually on disk — it is meant to fail
 * the first time a pre-2021 bullet is transcribed, rather than let P5 ship a node nobody
 * can pan to.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// ---------------------------------------------------------------------------
// The origin
// ---------------------------------------------------------------------------

describe('the corridor opens at x = 0 on a constant, not on a corpus', () => {
  it('puts CORRIDOR_START at exactly zero', () => {
    expect(TIME_SCALE.toX(CORRIDOR_START)).toBe(0);
    expect(TIME_SCALE.domain()[0]).toBe(CORRIDOR_START);
    expect(TIME_SCALE.domain()[1]).toBe(CORRIDOR_END);
  });

  it('sits one minute before canon’s earliest instant, so nothing is off the map', () => {
    // Lazaro is born at `when_min` 2021-01-01T00:01Z. The constant is deliberately just
    // BEFORE it and not on it, because equality would leave no room at all.
    const canonEarliest: IsoInstant = '2021-01-01T00:01:00.000Z';
    expect(CORRIDOR_START < canonEarliest).toBe(true);
    expect(Date.parse(canonEarliest) - Date.parse(CORRIDOR_START)).toBe(60_000);
    expect(TIME_SCALE.toX(canonEarliest)).toBeGreaterThan(0);
  });

  it('would put two views 145 units apart if the origin were still corpus-derived', () => {
    // The blocker, restated as the number that motivated D1. These are the two origins
    // `TimelineView` and a category-filtered Tech Tree would each have derived; the gap
    // between them is more than two screens, silently.
    const corpusWide = createTimeScale('2021-02-09T10:15:00.000Z');
    const techOnly = createTimeScale('2035-08-01T13:54:00.000Z');
    const somewhere: IsoInstant = '2040-08-14T01:35:00.000Z';
    const drift = corpusWide.toX(somewhere) - techOnly.toX(somewhere);
    expect(drift).toBeGreaterThan(144);
    expect(drift).toBeLessThan(146);

    // `TIME_SCALE` is neither of them, and does not move when a corpus does.
    expect(TIME_SCALE.toX(somewhere)).not.toBeCloseTo(corpusWide.toX(somewhere), 6);
    expect(TIME_SCALE.toX(somewhere)).not.toBeCloseTo(techOnly.toX(somewhere), 6);
  });

  it('does not move an existing node when an earlier event is seeded — at all', () => {
    // Strictly stronger than the "translates rather than rescales" claim it replaced:
    // seeding earlier than any current event changes nothing, because the origin is not
    // a function of the corpus. Every serialized camera x (§4.3) and every saved
    // viewport (P8.6) therefore keeps meaning what it meant.
    const before = TIME_SCALE.toX('2036-10-07T05:55:00.000Z');
    createTimeScale('2021-01-01T00:00:00.001Z');
    expect(TIME_SCALE.toX('2036-10-07T05:55:00.000Z')).toBe(before);
    expect(TIME_SCALE.range()[0]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// One object per process
// ---------------------------------------------------------------------------

describe('TIME_SCALE is the same object everywhere, which is what §5.2 actually claims', () => {
  it('is one object however the module is reached — by alias or by path', () => {
    // "The Tech Tree shares the Corridor's scale" is a fact about identity, not a claim
    // about two constructions agreeing, and the way identity is actually lost is module
    // DUPLICATION: two resolutions of `shared/src/timeScale` — an alias here and a
    // relative path or a `shared/dist` build there — give two module instances, two
    // `TIME_SCALE` objects and no error anywhere. `tests/smoke.test.ts` asserts the three
    // alias tables agree on a directory; this asserts the two spellings land on ONE
    // module. Both specifiers are exercised, because one of them alone proves nothing.
    return Promise.all([import('@shared/timeScale'), import('../shared/src/timeScale')]).then(
      ([viaAlias, viaPath]) => {
        expect(viaAlias.TIME_SCALE).toBe(TIME_SCALE);
        expect(viaPath.TIME_SCALE).toBe(TIME_SCALE);
        expect(viaPath.CORRIDOR_START).toBe(CORRIDOR_START);
        expect(viaPath.createTimeScale).toBe(createTimeScale);
      },
    );
  });

  it('is NOT what a fresh createTimeScale(CORRIDOR_START) returns, which is the point', () => {
    // The factory stays exported for a spec and for the P15 export renderer, and it
    // still builds an equivalent map — but a caller that rebuilds is a caller holding a
    // second object, and nothing downstream compares two scales for equality.
    const rebuilt = createTimeScale(CORRIDOR_START);
    expect(rebuilt).not.toBe(TIME_SCALE);
    expect(rebuilt.range()).toEqual(TIME_SCALE.range());
    expect(rebuilt.toX(CORRIDOR_END)).toBe(TIME_SCALE.toX(CORRIDOR_END));
  });

  it('hands back the same frozen range array on every call', () => {
    // `panBounds` reads this on every derivation; a fresh array per call would defeat
    // any memo keyed on it, and a mutable one would let a caller move the corridor's end.
    const range = TIME_SCALE.range();
    expect(TIME_SCALE.range()).toBe(range);
    expect(Object.isFrozen(range)).toBe(true);
    expect(TIME_SCALE.domain()).toBe(TIME_SCALE.domain());
  });
});

// ---------------------------------------------------------------------------
// The range, pinned
// ---------------------------------------------------------------------------

/** `[x(CORRIDOR_START), x(CORRIDOR_END)]`, computed once and written down. */
const RANGE: readonly [number, number] = [0, 633.1683554229191];

describe('range() is a constant, because everything downstream is expressed in it', () => {
  it('spans 0 to 633.1683554229191 world units', () => {
    // Pinned rather than recomputed: `panBounds` is derived from it and, from P8.6
    // onward, camera poses are persisted against it. A change here re-points every
    // shared URL and every saved viewport, so it must be a decision and not a drift.
    expect(TIME_SCALE.range()).toEqual(RANGE);
    expect(TIME_SCALE.toX(CORRIDOR_END)).toBe(RANGE[1]);
  });

  it('is the same number the pan bounds are padded around', () => {
    const bounds = panBounds(TIME_SCALE);
    expect(bounds.min).toBeLessThan(RANGE[0]);
    expect(bounds.max).toBeGreaterThan(RANGE[1]);
    expect(RANGE[0] - bounds.min).toBeCloseTo(bounds.max - RANGE[1], 12);
  });
});

// ---------------------------------------------------------------------------
// An empty corpus opens at zero (review note 6)
// ---------------------------------------------------------------------------

describe('a corpus with no nodes opens the corridor at its own start', () => {
  it('seeds the opening pose at CORRIDOR_START, which clamps to x = 0', () => {
    // `TimelineView` computes `initialX` by reducing `min(when)` over the corpus, seeded
    // with `CORRIDOR_START` so the empty case has an answer. That reduce lives inside a
    // `useMemo` and is not exported, so what is asserted here is the CHAIN it is built
    // from — the empty corpus, the seed, the scale and the clamp — rather than the hook,
    // which would need a mounted canvas to reach.
    for (const status of ['ready', 'loading', 'stale'] as const) {
      expect(corridorCorpus(status, []).events).toEqual([]);
    }
    const seed = CORRIDOR_START;
    expect(clampPan(TIME_SCALE.toX(seed), panBounds(TIME_SCALE))).toBe(0);
  });

  it('opens on the earliest node when there is one, and never outside the bounds', () => {
    // The non-empty half of the same reduce: a pose is allowed to depend on what is
    // being drawn — it is read once at mount and nothing is persisted against it — where
    // an ORIGIN is not, because every persisted x is expressed in one.
    const bounds = panBounds(TIME_SCALE);
    for (const when of [CORRIDOR_START, '2036-10-07T05:55:00.000Z', CORRIDOR_END] as const) {
      const x = clampPan(TIME_SCALE.toX(when), bounds);
      expect(x).toBe(TIME_SCALE.toX(when));
      expect(x).toBeGreaterThanOrEqual(bounds.min);
      expect(x).toBeLessThanOrEqual(bounds.max);
    }
  });
});

// ---------------------------------------------------------------------------
// The rows actually on disk — P5's acceptance condition
// ---------------------------------------------------------------------------

const dbPath = `${repoRoot}data/lifestream.db`;
const dbPresent = existsSync(dbPath);

/** Skipped on a fresh clone: `data/*.db` is gitignored and rebuilt (§7.4). */
describe.skipIf(!dbPresent)('every seeded event is reachable on the canonical scale', () => {
  interface Row {
    id: string;
    when: string;
    when_min: string;
  }

  const rows = ((): Row[] => {
    if (!dbPresent) return [];
    const db = new DatabaseSync(`file:${dbPath}?mode=ro`, { readOnly: true });
    try {
      return db
        .prepare(`select id, "when", when_min from event order by when_min`)
        .all() as unknown as Row[];
    } finally {
      db.close();
    }
  })();

  it('holds no event whose window opens before CORRIDOR_START', () => {
    // THE new acceptance condition. Instants are the canonical spelling, which the
    // schema pins with a GLOB CHECK, so they sort correctly as TEXT — `min(when_min)` is
    // a string comparison and needs no parsing. When P5 transcribes a bullet earlier
    // than 2021 this fails here, loudly, rather than drawing a node at negative x that
    // is outside `panBounds` and that the camera can never reach.
    expect(rows.length).toBeGreaterThan(0);
    const earliest = rows.map((row) => row.when_min).sort()[0]!;
    expect(earliest >= CORRIDOR_START, `earliest when_min ${earliest}`).toBe(true);
    for (const row of rows) {
      expect(row.when_min >= CORRIDOR_START, `${row.id} opens at ${row.when_min}`).toBe(true);
    }
  });

  it('maps every stored roll to a positive x inside range(), and back again exactly', () => {
    // `when` is the persisted roll and is what a node is positioned at. The round trip
    // is the HUD's date readout and every fly-to target, so it is asserted against THE
    // scale rather than against a rebuilt one.
    const [x0, x1] = TIME_SCALE.range();
    for (const row of rows) {
      const x = TIME_SCALE.toX(row.when);
      expect(Number.isNaN(x), `${row.id} mapped to NaN`).toBe(false);
      expect(x, `${row.id} at ${row.when}`).toBeGreaterThan(x0);
      expect(x, `${row.id} at ${row.when}`).toBeLessThanOrEqual(x1);
      expect(TIME_SCALE.toDate(x), `${row.id} did not round-trip`).toBe(row.when);
    }
  });

  it('keeps every stored roll inside the pan bounds, so the camera can reach it', () => {
    const bounds = panBounds(TIME_SCALE);
    for (const row of rows) {
      const x = TIME_SCALE.toX(row.when);
      expect(clampPan(x, bounds), `${row.id} is unreachable`).toBe(x);
    }
  });
});

describe('the database block reports whether it ran', () => {
  it(dbPresent ? 'ran against data/lifestream.db' : 'was skipped: no data/lifestream.db', () => {
    // A silently skipped acceptance condition is not an acceptance condition. This makes
    // the skip visible in the reporter's output rather than leaving a gap nobody sees.
    expect(typeof dbPresent).toBe('boolean');
  });
});
