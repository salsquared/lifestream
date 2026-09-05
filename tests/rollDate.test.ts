import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { WHEN_PRECISIONS, precisionToInterval, rollDate } from '@shared/rollDate';
import type { WhenPrecision } from '@shared/rollDate';

/**
 * P1.8.4 — one of the four targeted specs (architecture §4.1).
 *
 * `rollDate` earns a spec because it is silent when wrong. Roughly 46% of the corpus is
 * coarser than `day` precision, so most events' `when` comes from here rather than from
 * the Bible text; and `when` is *persisted*, so a roll that is not reproducible does not
 * throw, it just moves every node in the Corridor on the next reseed and invalidates
 * every shared URL. Nothing else in the suite would notice.
 *
 * The spec is also the first real consumer of the `@shared/*` alias — `tests/smoke.test.ts`
 * proves the three alias tables agree, and this import is the thing that agreement is for.
 *
 * What is asserted, and why each case is here:
 *
 *   - **Determinism**, in-process and *across processes* — the property the whole design
 *     rests on. A `Math.random()` implementation passes every other test in this file.
 *   - **A frozen golden vector** — determinism alone is satisfied by any stable function.
 *     The goldens make an accidental change to the hash constants, the PRNG, the warm-up
 *     count or the index mapping fail loudly, because such a change silently re-rolls
 *     every event in every existing save.
 *   - **Nonce re-roll** — a bumped nonce must actually move the point.
 *   - **Containment** — the result is always inside `[whenMin, whenMax]`.
 *   - **The `whenMin === whenMax` boundary**, including the sub-minute and midnight
 *     degenerate windows, where the documented precedence is "the window beats the clamp".
 *   - **The 00:01–23:59 time-of-day clamp**, including a window straddling midnight.
 *   - **Distribution** — the case that fails a degenerate `return whenMin`, which would
 *     otherwise satisfy determinism *and* containment and collapse the whole timeline
 *     onto the first instant of every window.
 *   - **`precisionToInterval` boundaries** for all six precisions, against the real
 *     phrasings the Bible uses.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** Instants are compared as instants AND as strings; see the sortability test. */
const ms = (iso: string): number => Date.parse(iso);

/** Minute-of-day of an ISO instant, 0 (00:00) … 1439 (23:59). */
const minuteOfDay = (iso: string): number => {
  const d = new Date(iso);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

/** A deterministic spread of plausible event ids — the shape the seed script produces. */
const eventIds = (count: number, prefix = 'ev'): string[] =>
  Array.from({ length: count }, (_, i) => `${prefix}_${i.toString(36)}_${(i * 7919) % 104729}`);

const YEAR_2036 = precisionToInterval('year', '2036');
const [Y_MIN, Y_MAX] = YEAR_2036;

// ---------------------------------------------------------------------------
// Determinism — the property everything else depends on
// ---------------------------------------------------------------------------

describe('rollDate is deterministic', () => {
  it('returns the same instant for the same id, call after call', () => {
    const first = rollDate('ev_big_one', Y_MIN, Y_MAX);
    for (let i = 0; i < 50; i++) {
      expect(rollDate('ev_big_one', Y_MIN, Y_MAX)).toBe(first);
    }
  });

  it('returns the same instant for every id on a repeated pass', () => {
    const ids = eventIds(500);
    const pass1 = ids.map((id) => rollDate(id, Y_MIN, Y_MAX));
    const pass2 = ids.map((id) => rollDate(id, Y_MIN, Y_MAX));
    expect(pass2).toEqual(pass1);
  });

  it('returns a string, never a Date — event.when is a TEXT column', () => {
    const when: unknown = rollDate('ev_big_one', Y_MIN, Y_MAX);
    expect(typeof when).toBe('string');
    expect(when).not.toBeInstanceOf(Date);
    // Canonical fixed-width UTC, so the TEXT column sorts chronologically.
    expect(when).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('agrees with a separate process — no dependence on process-local state', () => {
    // The seed script and the UI editor are different processes; if the roll drew on
    // `Math.random`, `Date.now`, module load order or a mutable module-level cursor,
    // every assertion above would still pass and this one would not.
    const tsx = resolve(repoRoot, 'node_modules/.bin/tsx');
    expect(existsSync(tsx), 'tsx (a root devDependency) is required by this spec').toBe(true);

    const ids = ['ev_big_one', 'ev_ines_symptoms', 'ev_big_one:1', 'ev_big_one:2'];
    const modulePath = resolve(repoRoot, 'shared/src/rollDate.ts');
    const dir = mkdtempSync(join(tmpdir(), 'lifestream-rolldate-'));
    try {
      const script = join(dir, 'roll.mts');
      writeFileSync(
        script,
        [
          `import { rollDate } from ${JSON.stringify(modulePath)};`,
          `const ids = ${JSON.stringify(ids)};`,
          `console.log(JSON.stringify(ids.map((id) => rollDate(id, ${JSON.stringify(Y_MIN)}, ${JSON.stringify(Y_MAX)}))));`,
        ].join('\n'),
      );
      const stdout = execFileSync(tsx, [script], { encoding: 'utf8', cwd: repoRoot });
      const childResults: unknown = JSON.parse(stdout.trim().split('\n').slice(-1)[0] ?? '[]');
      expect(childResults).toEqual(ids.map((id) => rollDate(id, Y_MIN, Y_MAX)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('the persisted roll is a frozen contract', () => {
  // `when` is written to the database and never recomputed on read. Changing the hash
  // constants, the PRNG, the warm-up count or the index mapping re-rolls every event in
  // every save — so it must be a deliberate act with a visible diff, not a refactor.
  const goldens: ReadonlyArray<readonly [string, WhenPrecision, string, string]> = [
    ['ev_big_one', 'time', '2034-07-10T08:04Z', '2034-07-10T08:04:00.000Z'],
    ['ev_nk_war_start', 'year', '2036', '2036-03-17T22:54:00.000Z'],
    ['ev_black_fever_outbreak', 'season', 'Late 2035', '2035-10-21T16:43:00.000Z'],
    ['ev_enceladus_etna', 'year', '2071', '2071-07-27T00:33:00.000Z'],
    ['ev_ines_symptoms', 'season', 'Late 2071', '2071-10-11T19:30:00.000Z'],
    ['ev_hv_v3_ships', 'decade', '2050s', '2051-03-16T03:26:00.000Z'],
    ['ev_etna_disaster', 'month', 'March 2042', '2042-03-17T23:04:00.000Z'],
    ['ev_lazaro_selected', 'day', '2035-08-01', '2035-08-01T12:59:00.000Z'],
  ];

  it.each(goldens.map(([id, precision, value, when]) => ({ id, precision, value, when })))(
    '$id ($precision $value) still rolls to $when',
    ({ id, precision, value, when }) => {
      const [min, max] = precisionToInterval(precision, value);
      expect(rollDate(id, min, max)).toBe(when);
    },
  );
});

// ---------------------------------------------------------------------------
// The nonce re-roll
// ---------------------------------------------------------------------------

describe('an explicit re-roll moves the point', () => {
  it('gives a different instant for a bumped nonce', () => {
    const base = rollDate('ev_big_one', Y_MIN, Y_MAX);
    expect(rollDate('ev_big_one:1', Y_MIN, Y_MAX)).not.toBe(base);
  });

  it('gives a distinct instant for each of a run of nonces, all reproducible', () => {
    const rolls = ['', ':1', ':2', ':3', ':4', ':5', ':6', ':7'].map((n) =>
      rollDate(`ev_ines_symptoms${n}`, Y_MIN, Y_MAX),
    );
    expect(new Set(rolls).size).toBe(rolls.length);
    // Reproducible, not merely different: a re-roll must survive a reseed.
    expect(
      rolls.map((_, i) => rollDate(`ev_ines_symptoms${i === 0 ? '' : `:${i}`}`, Y_MIN, Y_MAX)),
    ).toEqual(rolls);
  });

  it('keeps neighbouring ids independent — no clustering by shared prefix', () => {
    // A weak string hash maps `ev_1`, `ev_2`, `ev_3` to adjacent seeds and therefore to
    // adjacent instants, which would visibly stripe the Corridor.
    const rolls = eventIds(200, 'ev_seq').map((id) => rollDate(id, Y_MIN, Y_MAX));
    expect(new Set(rolls).size).toBe(rolls.length);
  });
});

// ---------------------------------------------------------------------------
// Containment
// ---------------------------------------------------------------------------

describe('the roll is inside the window', () => {
  const windows: ReadonlyArray<readonly [string, [string, string]]> = [
    ['decade 2050s', precisionToInterval('decade', '2050s')],
    ['year 2036', precisionToInterval('year', '2036')],
    ['season Late 2035', precisionToInterval('season', 'Late 2035')],
    ['month March 2042', precisionToInterval('month', 'March 2042')],
    ['day 2035-08-01', precisionToInterval('day', '2035-08-01')],
    ['time 2034-07-10T08:04Z', precisionToInterval('time', '2034-07-10T08:04Z')],
  ];

  it.each(windows.map(([label, window]) => ({ label, window })))(
    '$label contains every roll, for 400 ids',
    ({ window }) => {
      const [min, max] = window;
      for (const id of eventIds(400)) {
        const when = rollDate(id, min, max);
        expect(ms(when)).toBeGreaterThanOrEqual(ms(min));
        expect(ms(when)).toBeLessThanOrEqual(ms(max));
        // The canonical form is fixed-width, so lexicographic order is chronological
        // order — which is what `ORDER BY when` in SQLite relies on.
        expect(when >= min && when <= max).toBe(true);
      }
    },
  );

  it('honours a window narrowed by the bracket FKs', () => {
    // §2.3: given brackets, the window becomes [max(when_min, before.when),
    // min(when_max, after.when)]. rollDate never sees the brackets, only the result.
    const before = rollDate('ev_enceladus_etna', ...precisionToInterval('year', '2071'));
    const [, wide] = precisionToInterval('year', '2071');
    for (const id of eventIds(200)) {
      const when = rollDate(id, before, wide);
      expect(ms(when)).toBeGreaterThanOrEqual(ms(before));
      expect(ms(when)).toBeLessThanOrEqual(ms(wide));
    }
  });
});

// ---------------------------------------------------------------------------
// Degenerate windows
// ---------------------------------------------------------------------------

describe('degenerate windows', () => {
  it('returns the single instant when whenMin === whenMax', () => {
    const at = '2034-07-10T08:04:00.000Z';
    for (const id of eventIds(100)) {
      expect(rollDate(id, at, at)).toBe(at);
    }
  });

  it('collapses a time-precision event onto exactly its authored minute', () => {
    const [min, max] = precisionToInterval('time', '2034-07-10T08:04Z');
    expect(min).toBe(max);
    expect(rollDate('ev_big_one', min, max)).toBe('2034-07-10T08:04:00.000Z');
  });

  it('returns whenMin for a sub-minute window that contains no minute instant', () => {
    const min = '2042-03-01T12:00:30.000Z';
    const max = '2042-03-01T12:00:45.000Z';
    const when = rollDate('ev_etna_disaster', min, max);
    expect(when).toBe(min);
    expect(ms(when)).toBeLessThanOrEqual(ms(max));
  });

  it('lets the window beat the clamp when the only instant available is midnight', () => {
    // Documented precedence: the result is always inside [whenMin, whenMax]; the
    // 00:01–23:59 clamp is best-effort on top of that. An event the author timestamped
    // at exactly midnight keeps the minute they wrote rather than being nudged off it.
    const at = '2042-03-01T00:00:00.000Z';
    expect(rollDate('ev_etna_disaster', at, at)).toBe(at);
  });

  it('rejects an inverted window — the same rule as the when_max >= when_min CHECK', () => {
    expect(() => rollDate('ev_big_one', Y_MAX, Y_MIN)).toThrow(RangeError);
  });

  it('rejects an unparseable bound rather than rolling from NaN', () => {
    expect(() => rollDate('ev_big_one', 'sometime in 2036', Y_MAX)).toThrow(RangeError);
    expect(() => rollDate('ev_big_one', Y_MIN, 'later')).toThrow(RangeError);
  });
});

describe('bounds are parsed strictly, because Date.parse is not', () => {
  // Each case below is something `Date.parse` accepts and quietly gets wrong. None of
  // them would throw anywhere else in the stack: they would land an event at a
  // plausible-looking but incorrect instant, and `when` is persisted, so the mistake
  // outlives the process that made it.

  it('rejects prose that Date.parse resolves against the local timezone', () => {
    // V8: Date.parse('sometime in 2036') === 2036-01-01T00:00 *local*. Seeding the same
    // corpus in Madrid and in Los Angeles would otherwise produce two different worlds.
    expect(Number.isNaN(Date.parse('sometime in 2036'))).toBe(false);
    expect(() => rollDate('ev_big_one', 'sometime in 2036', Y_MAX)).toThrow(/ISO-8601 UTC/);
  });

  it('rejects a date-time with no UTC designator', () => {
    // Per the ES Date Time String Format this form is *local* time, so it is exactly the
    // same machine-dependence hazard wearing an ISO-looking shape. Both docs abbreviate
    // the window to `2036-01-01T00:01` in prose; the stored value must carry the Z.
    expect(() => rollDate('ev_big_one', '2036-01-01T00:01', Y_MAX)).toThrow(/ISO-8601 UTC/);
    expect(() => rollDate('ev_big_one', Y_MIN, '2036-12-31T23:59')).toThrow(/ISO-8601 UTC/);
  });

  it('rejects an impossible calendar date instead of rolling it into the next month', () => {
    // V8: Date.parse('2035-02-30') === 2035-03-02. A mistyped seed would silently move
    // the event into March.
    expect(new Date(Date.parse('2035-02-30')).toISOString()).toBe('2035-03-02T00:00:00.000Z');
    expect(() => rollDate('ev_big_one', '2035-02-30', '2035-12-31T23:59:00.000Z')).toThrow(
      /real calendar date/,
    );
    expect(() => precisionToInterval('day', '2035-02-30')).toThrow(/real calendar date/);
    expect(() => precisionToInterval('day', '2042-02-29')).toThrow(/real calendar date/);
    // The same day in a leap year is fine.
    expect(precisionToInterval('day', '2044-02-29')[0]).toBe('2044-02-29T00:01:00.000Z');
  });

  it('accepts a bare date, which ISO-8601 already fixes to UTC', () => {
    expect(() => rollDate('ev_big_one', '2036-01-01', '2036-12-31')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The time-of-day clamp
// ---------------------------------------------------------------------------

describe('the 00:01-23:59 time-of-day clamp', () => {
  it('never lands on midnight, over 3000 ids across a decade', () => {
    const [min, max] = precisionToInterval('decade', '2050s');
    for (const id of eventIds(3000)) {
      const when = rollDate(id, min, max);
      const m = minuteOfDay(when);
      expect(m).toBeGreaterThanOrEqual(1);
      expect(m).toBeLessThanOrEqual(1439);
    }
  });

  it('emits whole minutes — no fabricated seconds', () => {
    for (const id of eventIds(300)) {
      expect(rollDate(id, Y_MIN, Y_MAX)).toMatch(/T\d{2}:\d{2}:00\.000Z$/);
    }
  });

  it('skips the midnight minute inside a window that straddles it', () => {
    // Window is exactly five minutes: 23:57, 23:58, 23:59, 00:00, 00:01. The clamp must
    // remove 00:00 and leave the other four reachable — a naive "clamp afterwards"
    // implementation piles every midnight roll onto 00:01 instead.
    const min = '2042-03-01T23:57:00.000Z';
    const max = '2042-03-02T00:01:00.000Z';
    const seen = new Set(eventIds(600).map((id) => rollDate(id, min, max)));
    expect(seen.has('2042-03-02T00:00:00.000Z')).toBe(false);
    expect([...seen].sort()).toEqual([
      '2042-03-01T23:57:00.000Z',
      '2042-03-01T23:58:00.000Z',
      '2042-03-01T23:59:00.000Z',
      '2042-03-02T00:01:00.000Z',
    ]);
  });

  it('spreads evenly over the four reachable minutes of that window', () => {
    // The midnight skip must not bias its neighbours: a rejection-then-retry that reused
    // the same draw, or an off-by-one in the index mapping, shows up as a lopsided count.
    const min = '2042-03-01T23:57:00.000Z';
    const max = '2042-03-02T00:01:00.000Z';
    const counts = new Map<string, number>();
    const n = 4000;
    for (const id of eventIds(n)) {
      const when = rollDate(id, min, max);
      counts.set(when, (counts.get(when) ?? 0) + 1);
    }
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(n / 4 - n / 20);
      expect(count).toBeLessThan(n / 4 + n / 20);
    }
  });
});

// ---------------------------------------------------------------------------
// Distribution — the case a degenerate implementation fails
// ---------------------------------------------------------------------------

describe('the roll is spread across the window', () => {
  const ids = eventIds(2000);
  const rolls = ids.map((id) => rollDate(id, Y_MIN, Y_MAX));

  it('does not collapse onto whenMin', () => {
    // `return whenMin` satisfies determinism and containment and every boundary case
    // above. It is the failure this describe block exists for.
    expect(rolls.filter((r) => r === Y_MIN).length).toBeLessThan(5);
    expect(rolls.filter((r) => r === Y_MAX).length).toBeLessThan(5);
  });

  it('produces almost entirely distinct instants', () => {
    // A year holds ~525k rollable minutes, so 2000 draws should barely collide.
    expect(new Set(rolls).size).toBeGreaterThan(ids.length * 0.99);
  });

  it('reaches every month of the year', () => {
    const months = new Set(rolls.map((r) => new Date(r).getUTCMonth()));
    expect(months.size).toBe(12);
  });

  it('puts a plausible share in each month', () => {
    const counts = new Array<number>(12).fill(0);
    for (const r of rolls)
      counts[new Date(r).getUTCMonth()] = (counts[new Date(r).getUTCMonth()] ?? 0) + 1;
    for (const count of counts) {
      expect(count).toBeGreaterThan(ids.length / 24);
      expect(count).toBeLessThan(ids.length / 6);
    }
  });

  it('reaches every hour of the day', () => {
    // Uniformity in time-of-day as well as in date: a roll that only ever used the date
    // part and stamped a fixed clock would pass every containment test.
    const hours = new Set(rolls.map((r) => new Date(r).getUTCHours()));
    expect(hours.size).toBe(24);
  });

  it('centres near the middle of the window', () => {
    const mean = rolls.reduce((acc, r) => acc + ms(r), 0) / rolls.length;
    const centre = (ms(Y_MIN) + ms(Y_MAX)) / 2;
    const span = ms(Y_MAX) - ms(Y_MIN);
    expect(Math.abs(mean - centre)).toBeLessThan(span * 0.03);
  });

  it('places an id at the same relative position regardless of window width', () => {
    // The draw is seeded on the id alone, not on the window — §2.6's "a save can be
    // re-seeded without every node in the Corridor jumping". Widening a precision must
    // move a node proportionally, not arbitrarily.
    const [dMin, dMax] = precisionToInterval('decade', '2030s');
    const fraction = (when: string, min: string, max: string) =>
      (ms(when) - ms(min)) / (ms(max) - ms(min));
    for (const id of eventIds(100)) {
      const inYear = fraction(rollDate(id, Y_MIN, Y_MAX), Y_MIN, Y_MAX);
      const inDecade = fraction(rollDate(id, dMin, dMax), dMin, dMax);
      expect(Math.abs(inYear - inDecade)).toBeLessThan(0.01);
    }
  });
});

// ---------------------------------------------------------------------------
// precisionToInterval — P1.8.3
// ---------------------------------------------------------------------------

describe('precisionToInterval derives the documented boundaries', () => {
  it('year 2036 -> the interval both docs quote verbatim', () => {
    expect(precisionToInterval('year', '2036')).toEqual([
      '2036-01-01T00:01:00.000Z',
      '2036-12-31T23:59:00.000Z',
    ]);
  });

  it('accepts a numeric value as readily as a string', () => {
    expect(precisionToInterval('year', 2036)).toEqual(precisionToInterval('year', '2036'));
  });

  it('decade floors to the decade, however it is written', () => {
    const expected = ['2050-01-01T00:01:00.000Z', '2059-12-31T23:59:00.000Z'];
    expect(precisionToInterval('decade', '2050s')).toEqual(expected);
    expect(precisionToInterval('decade', '2050')).toEqual(expected);
    expect(precisionToInterval('decade', '2053')).toEqual(expected);
  });

  it('a decade qualifier narrows the window rather than decorating the label', () => {
    // "Early 2050s" that could roll to 2059 would contradict the Bible's own text.
    // when_min/when_max are primary and when_precision is a display hint, so the
    // interval shrinks while the event still renders as a decade — no new enum member.
    const band = (v: string) =>
      precisionToInterval('decade', v).map((d) => new Date(d).getUTCFullYear());

    expect(band('Early 2050s')).toEqual([2050, 2053]);
    expect(band('Mid 2050s')).toEqual([2054, 2056]);
    expect(band('Late 2050s')).toEqual([2057, 2059]);
    expect(band('2050s')).toEqual([2050, 2059]);

    // and the roll actually stays inside the narrowed band
    const [lo, hi] = precisionToInterval('decade', 'Early 2050s');
    const years = new Set(
      Array.from({ length: 400 }, (_, i) => new Date(rollDate(`ev_${i}`, lo, hi)).getUTCFullYear()),
    );
    expect([...years].sort()).toEqual([2050, 2051, 2052, 2053]);
  });

  it('rejects an unknown decade qualifier instead of silently widening', () => {
    expect(() => precisionToInterval('decade', 'Sometime 2050s')).toThrow(/qualifier/i);
  });

  it('season "Late 2035" is a Q4 window — architecture §2.3, verbatim', () => {
    expect(precisionToInterval('season', 'Late 2035')).toEqual([
      '2035-10-01T00:01:00.000Z',
      '2035-12-31T23:59:00.000Z',
    ]);
  });

  it('treats quarter, season-name and Early/Mid/Late spellings as one vocabulary', () => {
    const q4 = precisionToInterval('season', 'Late 2035');
    for (const spelling of ['Q4 2035', '2035-Q4', 'Fall 2035', 'autumn 2035', 'q4 2035']) {
      expect(precisionToInterval('season', spelling), spelling).toEqual(q4);
    }
    expect(precisionToInterval('season', 'Early 2035')).toEqual(
      precisionToInterval('season', 'Q1 2035'),
    );
    expect(precisionToInterval('season', 'Winter 2035')).toEqual(
      precisionToInterval('season', 'Q1 2035'),
    );
    expect(precisionToInterval('season', 'Spring 2035')).toEqual(
      precisionToInterval('season', 'Q2 2035'),
    );
    expect(precisionToInterval('season', 'Summer 2035')).toEqual(
      precisionToInterval('season', 'Q3 2035'),
    );
    expect(precisionToInterval('season', 'Mid 2035')).toEqual(
      precisionToInterval('season', 'Q3 2035'),
    );
  });

  it('gives each quarter its own three months', () => {
    expect(precisionToInterval('season', 'Q1 2047')).toEqual([
      '2047-01-01T00:01:00.000Z',
      '2047-03-31T23:59:00.000Z',
    ]);
    expect(precisionToInterval('season', 'Q2 2047')).toEqual([
      '2047-04-01T00:01:00.000Z',
      '2047-06-30T23:59:00.000Z',
    ]);
    expect(precisionToInterval('season', 'Q3 2047')).toEqual([
      '2047-07-01T00:01:00.000Z',
      '2047-09-30T23:59:00.000Z',
    ]);
    expect(precisionToInterval('season', 'Fall 2047')).toEqual([
      '2047-10-01T00:01:00.000Z',
      '2047-12-31T23:59:00.000Z',
    ]);
  });

  it('month accepts the numeric and the spelled forms alike', () => {
    const march = ['2042-03-01T00:01:00.000Z', '2042-03-31T23:59:00.000Z'];
    expect(precisionToInterval('month', '2042-03')).toEqual(march);
    expect(precisionToInterval('month', 'March 2042')).toEqual(march);
    expect(precisionToInterval('month', 'Mar 2042')).toEqual(march);
    expect(precisionToInterval('month', 'march 2042')).toEqual(march);
  });

  it('ends a month on its real last day, leap years included', () => {
    expect(precisionToInterval('month', '2044-02')[1]).toBe('2044-02-29T23:59:00.000Z');
    expect(precisionToInterval('month', '2042-02')[1]).toBe('2042-02-28T23:59:00.000Z');
    expect(precisionToInterval('month', '2042-04')[1]).toBe('2042-04-30T23:59:00.000Z');
    expect(precisionToInterval('month', '2100-02')[1]).toBe('2100-02-28T23:59:00.000Z');
  });

  it('day spans one calendar day, 00:01 to 23:59', () => {
    expect(precisionToInterval('day', '2035-08-01')).toEqual([
      '2035-08-01T00:01:00.000Z',
      '2035-08-01T23:59:00.000Z',
    ]);
    // A fuller timestamp entered at day precision is widened to the whole day, not kept.
    expect(precisionToInterval('day', '2035-08-01T09:30:00.000Z')).toEqual([
      '2035-08-01T00:01:00.000Z',
      '2035-08-01T23:59:00.000Z',
    ]);
  });

  it('time collapses to the stated minute, discarding seconds', () => {
    expect(precisionToInterval('time', '2034-07-10T08:04Z')).toEqual([
      '2034-07-10T08:04:00.000Z',
      '2034-07-10T08:04:00.000Z',
    ]);
    expect(precisionToInterval('time', '2034-07-10T08:04:37.500Z')).toEqual([
      '2034-07-10T08:04:00.000Z',
      '2034-07-10T08:04:00.000Z',
    ]);
  });

  it('rejects a value the precision cannot read, rather than guessing', () => {
    expect(() => precisionToInterval('season', 'Harvest 2035')).toThrow(RangeError);
    expect(() => precisionToInterval('season', '2035')).toThrow(RangeError);
    expect(() => precisionToInterval('year', 'the 2030s')).toThrow(RangeError);
    expect(() => precisionToInterval('month', 'Smarch 2042')).toThrow(RangeError);
    expect(() => precisionToInterval('day', 'Aug 1st, 2035')).toThrow(RangeError);
    expect(() => precisionToInterval('decade', 'soon')).toThrow(RangeError);
    expect(() => precisionToInterval('nearly' as WhenPrecision, '2036')).toThrow(RangeError);
  });
});

describe('precisionToInterval feeds rollDate for the whole enum', () => {
  const sample: Readonly<Record<WhenPrecision, string>> = {
    // The phrasings implementation P3.3.1 / P5.3.5 / P10.1.2 take straight off the Bible.
    decade: '2040s', // "Late 2040s"
    year: '2036',
    season: 'Late 2071',
    month: 'January 2042',
    day: '2035-08-01', // "Aug 1st, 2035"
    time: '2034-07-10T08:04Z', // "July 10th, 2034, 8:04am"
  };

  it('covers every member of the closed enum', () => {
    expect([...WHEN_PRECISIONS].sort()).toEqual(Object.keys(sample).sort());
  });

  it.each(WHEN_PRECISIONS.map((precision) => ({ precision, value: sample[precision] })))(
    '$precision "$value" yields a well-formed window that contains its roll',
    ({ precision, value }) => {
      const [min, max] = precisionToInterval(precision, value);
      expect(ms(max)).toBeGreaterThanOrEqual(ms(min));
      for (const id of eventIds(100)) {
        const when = rollDate(id, min, max);
        expect(when >= min && when <= max, `${when} outside [${min}, ${max}]`).toBe(true);
      }
    },
  );
});
