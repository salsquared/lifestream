import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CATEGORIES, WHEN_PRECISIONS as DB_WHEN_PRECISIONS } from '@server/db/schema';
import { CANON_EVENTS } from '@server/seed/events';
import { formatWhen } from '@shared/formatWhen';
import { WHEN_PRECISIONS, precisionToInterval, rollDate } from '@shared/rollDate';

import type { FormattableEvent } from '@shared/formatWhen';
import type { WhenPrecision } from '@shared/types/index';

/**
 * P4.7 — `formatWhen` renders BY PRECISION, never by the roll.
 *
 * ── WHY THIS SPEC EXISTS ─────────────────────────────────────────────────────────────
 * Every way this module fails is not merely silent but *plausible*. `when` is a real
 * instant inside a real window, so a bug that prints it produces a well-formed date on
 * the node label — "13 August 2034" for a bullet whose source says "2034" — and nothing
 * anywhere reports an error. The reader is simply told a fact the Bible never contained,
 * in the flagship view, on every node. That is the exact failure the fuzzy-date model
 * (§2.3) was adopted to prevent and the entire reason the `when_precision` column exists.
 *
 * So the assertions below are shaped around one question: *could this output have come
 * from `when`?* A year-precision event must render four digits and nothing else — not a
 * month, not a day, not a clock — and the strongest form of that check is the mutation
 * test at the bottom of the "never reads the roll" block, which moves `when` years away
 * and demands the output not move at all.
 *
 * ── WHY THE FIXTURES ARE THE REAL CORPUS ─────────────────────────────────────────────
 * A hand-written fixture cannot catch this class of bug, because the author of the
 * fixture picks the window AND the roll and will naturally make them agree. The thirteen
 * seeded events do not agree: seven bare years whose rolls land in October, February and
 * August; a season whose roll lands in December; three days and one timestamp. They are
 * the corpus the module was written for and they span four of the six precisions.
 *
 * They are derived here from `CANON_EVENTS` — the committed authored source — through
 * the same `precisionToInterval` + `rollDate` the seed runs (`server/src/seed/events.ts`),
 * so these ARE the rows `db:seed` writes rather than a re-typing of them. The final
 * block then opens the real `data/lifestream.db` READ-ONLY and proves that claim row by
 * row; it skips when the file is absent, because `data/*.db` is gitignored and rebuilt
 * from migrations + seed (§7.4), so a fresh clone has no database to read. Everything
 * the module is responsible for is asserted in the always-on blocks above it.
 *
 * ── THE TWO PRECISIONS THE CORPUS DOES NOT REACH ─────────────────────────────────────
 * `month` and `decade` have no seeded event yet (P5 brings more of the World Timeline).
 * They are covered from windows built by `precisionToInterval`, which is the same path
 * a seeded row of that precision would take.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** The one authored world under test — declared in `server/src/seed/inputs.ts` and
 *  mirrored by `client/src/shell/stores/save.ts` (P1.11.1). Not imported: the client
 *  store pulls React state into a node-environment spec for one string. */
const CANON_SAVE_ID = 'sav_canon';

/** How many events the Pre-Big One transcription contains (P3.3). */
const SEEDED_EVENT_COUNT = 13;

// ---------------------------------------------------------------------------
// The real corpus, derived exactly as `runSeed` derives it
// ---------------------------------------------------------------------------

interface SeededEvent extends FormattableEvent {
  id: string;
  title: string;
  /** What the Bible's own text says — the string the render must not exceed. */
  sourceDate: string;
  /**
   * The roll. Deliberately **not** part of {@link FormattableEvent} — the module's
   * parameter type omits it so the one column `formatWhen` may not read cannot be read
   * (see its docstring). The fixtures carry it anyway, because the mutation test below
   * has to move it and prove the output does not follow.
   */
  when: string;
}

const SEEDED: readonly SeededEvent[] = CANON_EVENTS.map((authored) => {
  const [whenMin, whenMax] = precisionToInterval(authored.precision, authored.precisionValue);
  return {
    id: authored.id,
    title: authored.title,
    sourceDate: authored.sourceDate,
    whenMin,
    whenMax,
    whenPrecision: authored.precision,
    // Seeded on the event id — server/src/seed/events.ts does exactly this.
    when: rollDate(authored.id, whenMin, whenMax),
  };
});

const byId = (id: string): SeededEvent => {
  const found = SEEDED.find((e) => e.id === id);
  if (!found) throw new Error(`no seeded event ${id}`);
  return found;
};

/** Build the row a seed would write for `(precision, value)`, with a deliberate roll. */
const authored = (precision: WhenPrecision, value: string, seed = 'ev_synthetic'): SeededEvent => {
  const [whenMin, whenMax] = precisionToInterval(precision, value);
  return {
    id: seed,
    title: value,
    sourceDate: value,
    whenMin,
    whenMax,
    whenPrecision: precision,
    when: rollDate(seed, whenMin, whenMax),
  };
};

/**
 * What each of the thirteen must render. Written out literally rather than computed:
 * a computed expectation would reproduce whatever the implementation does, including
 * its bugs, which is the one thing a spec must not do.
 */
const EXPECTED: Readonly<Record<string, string>> = {
  evt_lazaro_born: '2021',
  evt_ines_born: '2025',
  evt_big_one: '10 July 2034, 08:04 UTC',
  evt_disaster_ridge_study: '13 August 2034',
  evt_ridge_probing_begins: '1 February 2035',
  evt_megablock_1_groundbreaking: '1 August 2035',
  evt_fob_oasis_designation: 'Late 2035',
  evt_ridge_first_elevator: 'Late 2035',
  evt_megablocks_2_8_begin: '2036',
  evt_megablock_early_occupancy: '2037',
  evt_camp_oasis_designation: '2039',
  evt_megablock_1_complete: '2039',
  evt_megablocks_2_4_complete: '2040',
};

describe('the seeded corpus is the shape this spec assumes', () => {
  it('is the thirteen Pre-Big One events', () => {
    expect(SEEDED).toHaveLength(SEEDED_EVENT_COUNT);
    expect(Object.keys(EXPECTED)).toHaveLength(SEEDED_EVENT_COUNT);
    expect(SEEDED.map((e) => e.id).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('spans four precisions, so the render is exercised four different ways', () => {
    const spread = new Map<WhenPrecision, number>();
    for (const e of SEEDED) spread.set(e.whenPrecision, (spread.get(e.whenPrecision) ?? 0) + 1);
    expect(Object.fromEntries(spread)).toEqual({ year: 7, day: 3, season: 2, time: 1 });
  });

  it('rolls AWAY from the window start, or the spec would prove nothing', () => {
    // The whole hazard is that `when` differs from what the source stated. If every roll
    // happened to land on the first instant of its window, printing the roll and printing
    // the year would look identical and every assertion below would pass on a broken
    // implementation. So: no coarse event lands on its window's opening DAY, and most of
    // them land in a different MONTH — which is what makes the month-name assertions bite.
    const coarse = SEEDED.filter((e) => e.whenPrecision === 'year' || e.whenPrecision === 'season');
    expect(coarse.length).toBeGreaterThan(0);
    for (const e of coarse) {
      expect(e.when.slice(0, 10), `${e.id} rolled onto its window start`).not.toBe(
        e.whenMin.slice(0, 10),
      );
    }
    // 7 of the 9 land in a different month; the two that do not (evt_ines_born rolled to
    // January, evt_ridge_first_elevator to October) still land on a different day.
    const differentMonth = coarse.filter((e) => e.when.slice(0, 7) !== e.whenMin.slice(0, 7));
    expect(differentMonth.length).toBeGreaterThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// The real events render at their stated precision
// ---------------------------------------------------------------------------

describe('formatWhen renders the real seeded events', () => {
  for (const event of SEEDED) {
    it(`${event.id} (${event.whenPrecision}, source "${event.sourceDate}") -> ${EXPECTED[event.id]}`, () => {
      expect(formatWhen(event)).toBe(EXPECTED[event.id]);
    });
  }
});

// ---------------------------------------------------------------------------
// The defect this module exists to prevent
// ---------------------------------------------------------------------------

describe('formatWhen never states what the source did not', () => {
  it('renders a year-precision event as four digits and nothing else', () => {
    const years = SEEDED.filter((e) => e.whenPrecision === 'year');
    expect(years).toHaveLength(7);
    for (const e of years) {
      // Exactly the year. No month name, no day number, no clock — there is no room.
      expect(formatWhen(e)).toMatch(/^\d{4}$/);
      expect(formatWhen(e)).toBe(e.whenMin.slice(0, 4));
    }
  });

  it('never shows a clock except at `time` precision', () => {
    for (const e of SEEDED) {
      const rendered = formatWhen(e);
      if (e.whenPrecision === 'time') expect(rendered).toMatch(/\d{2}:\d{2} UTC$/);
      else expect(rendered).not.toMatch(/\d:\d/);
    }
  });

  it('never names the month the roll landed in, for a year- or season-precision event', () => {
    const MONTHS = [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ];
    const coarse = SEEDED.filter((e) => e.whenPrecision === 'year' || e.whenPrecision === 'season');
    for (const e of coarse) {
      const rendered = formatWhen(e);
      for (const month of MONTHS) expect(rendered).not.toContain(month);
    }
  });

  it('holds on the worst case in the corpus, spelled out', () => {
    // "Megablock 2 through 8 begin construction" — the Bible says 2036 and nothing more.
    // The roll put it on 7 October at 05:55, a date and a time that exist nowhere in canon.
    const e = byId('evt_megablocks_2_8_begin');
    expect(e.sourceDate).toBe('2036');
    expect(e.when).toBe('2036-10-07T05:55:00.000Z');

    const rendered = formatWhen(e);
    expect(rendered).toBe('2036');
    expect(rendered).not.toContain('October');
    expect(rendered).not.toContain('05:55');
    expect(rendered).not.toContain('10-07');
  });

  it('holds on the season case, where the roll crosses into another month', () => {
    // "Late 2035" is a Q4 window; this one rolled into December. The label must stay
    // the quarter the source named.
    const e = byId('evt_fob_oasis_designation');
    expect(e.sourceDate).toBe('Late 2035');
    expect(e.when).toBe('2035-12-11T14:30:00.000Z');
    expect(formatWhen(e)).toBe('Late 2035');
  });

  /**
   * THE structural assertion: `when` is not an input.
   *
   * Every other test here could in principle be satisfied by an implementation that
   * reads `when` and happens to round it back to the window. This one cannot: it moves
   * the roll to a different year, month, day and minute and demands byte-identical
   * output.
   */
  it('produces the same string when the roll is moved anywhere inside — or outside — the window', () => {
    for (const e of SEEDED) {
      const baseline = formatWhen(e);
      for (const forged of [
        '1999-12-31T23:58:00.000Z',
        '2077-03-04T17:23:00.000Z',
        e.whenMin,
        e.whenMax,
      ]) {
        // Built as a `SeededEvent`, not as a bare argument: `FormattableEvent` has no
        // `when` at all, so a literal spelling one out is an excess property. That the
        // forgery needs a wider type to even be expressible is the point.
        const forgery: SeededEvent = { ...e, when: forged };
        expect(formatWhen(forgery)).toBe(baseline);
      }
    }
  });

  /**
   * The companion structural assertion: `whenMax` is not an input either, except at
   * `decade` precision where the band is exactly what it is for.
   *
   * Reading the wrong end of the window is the quiet version of this module's defect. On
   * a well-formed row the two ends agree about the year and the month, so a `whenMax`
   * that has been widened by hand — or an era bound stretched to swallow a later event —
   * is the only thing that reveals it, and by then the label says something the source
   * never did.
   */
  it('produces the same string when whenMax is moved, at every precision but decade', () => {
    const rows: readonly SeededEvent[] = [
      ...SEEDED,
      authored('month', 'March 2042'),
      authored('day', '2035-08-01'),
      authored('time', '2034-07-10T08:04Z'),
      authored('season', 'Q2 2047'),
    ];
    for (const e of rows) {
      expect(e.whenPrecision).not.toBe('decade');
      const baseline = formatWhen(e);
      for (const forged of ['2077-03-04T17:23:00.000Z', '2035-01-01T00:01:00.000Z', e.whenMin]) {
        expect(formatWhen({ ...e, whenMax: forged }), `${e.id} @ ${e.whenPrecision}`).toBe(
          baseline,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Every precision, including the two the corpus has not reached
// ---------------------------------------------------------------------------

describe('formatWhen covers the whole closed enum', () => {
  it('renders every member of WhenPrecision', () => {
    const samples: Record<WhenPrecision, string> = {
      decade: '2050s',
      year: '2036',
      season: 'Late 2035',
      month: 'March 2042',
      day: '2035-08-01',
      time: '2034-07-10T08:04Z',
    };
    for (const precision of WHEN_PRECISIONS) {
      const rendered = formatWhen(authored(precision, samples[precision]));
      expect(rendered, `${precision} rendered empty`).not.toBe('');
      expect(rendered).not.toContain('undefined');
      expect(rendered).not.toContain('NaN');
    }
    // The enum the DATABASE constrains, not just the TS union — a member added to the
    // CHECK constraint without a branch here would otherwise reach the default and throw
    // in the render path.
    expect([...DB_WHEN_PRECISIONS].sort()).toEqual([...WHEN_PRECISIONS].sort());
  });

  it('renders the docs\u2019 own examples verbatim', () => {
    // architecture §2.3 / implementation P4.7 / the P4 contract S3 all name these.
    expect(formatWhen(authored('year', '2036'))).toBe('2036');
    expect(formatWhen(authored('season', 'Late 2035'))).toBe('Late 2035');
    expect(formatWhen(authored('month', 'March 2042'))).toBe('March 2042');
    expect(formatWhen(authored('day', '2034-08-13'))).toBe('13 August 2034');
  });

  it('renders a decade band in the "Early 2050s" style precisionToInterval parses', () => {
    expect(formatWhen(authored('decade', 'Early 2050s'))).toBe('Early 2050s');
    expect(formatWhen(authored('decade', 'Mid 2050s'))).toBe('Mid 2050s');
    expect(formatWhen(authored('decade', 'Late 2050s'))).toBe('Late 2050s');
    expect(formatWhen(authored('decade', '2050s'))).toBe('2050s');
    // A decade value is floored, so 2053 and 2050s are one window and one label.
    expect(formatWhen(authored('decade', '2053'))).toBe('2050s');
  });

  it('falls back to the bare decade rather than guessing a qualifier', () => {
    // A hand-widened window that matches no band. "2050s" is true of it; "Mid" is not.
    const e = authored('decade', '2050s');
    expect(formatWhen({ ...e, whenMax: '2055-12-31T23:59:00.000Z' })).toBe('2050s');
    // Straddling two decades: the qualifier would be meaningless, the decade is not.
    expect(formatWhen({ ...e, whenMax: '2061-12-31T23:59:00.000Z' })).toBe('2050s');
  });

  it('reads the quarter from the month the window OPENS in, whatever month that is', () => {
    // `precisionToInterval` always opens a season window on the quarter's first month, so
    // months 1/4/7/10 are the only ones the corpus ever produces — and several wrong
    // quarter formulas agree with the right one on exactly those four. A hand-edited
    // window (or an era bound narrowed to a real event) opens mid-quarter, and that is
    // where an off-by-one starts renaming Q1 to Q2.
    const q4 = authored('season', 'Q4 2035');
    expect(formatWhen({ ...q4, whenMin: '2035-11-15T00:01:00.000Z' })).toBe('Late 2035');
    expect(formatWhen({ ...q4, whenMin: '2035-12-31T00:01:00.000Z' })).toBe('Late 2035');
    expect(formatWhen({ ...q4, whenMin: '2035-03-31T00:01:00.000Z' })).toBe('Early 2035');
    expect(formatWhen({ ...q4, whenMin: '2035-06-30T00:01:00.000Z' })).toBe('Q2 2035');
    expect(formatWhen({ ...q4, whenMin: '2035-09-30T00:01:00.000Z' })).toBe('Mid 2035');
  });

  it('covers all four quarters, including the one the docs never named', () => {
    expect(formatWhen(authored('season', 'Q1 2047'))).toBe('Early 2047');
    expect(formatWhen(authored('season', 'Q2 2047'))).toBe('Q2 2047');
    expect(formatWhen(authored('season', 'Q3 2047'))).toBe('Mid 2047');
    expect(formatWhen(authored('season', 'Q4 2047'))).toBe('Late 2047');
    // The same four windows reached through the season words the parser also accepts.
    expect(formatWhen(authored('season', 'Winter 2047'))).toBe('Early 2047');
    expect(formatWhen(authored('season', 'Fall 2047'))).toBe('Late 2047');
  });

  it('shows minute resolution and a timezone at `time` precision, never seconds', () => {
    const e = authored('time', '2034-07-10T08:04Z');
    expect(formatWhen(e)).toBe('10 July 2034, 08:04 UTC');
    // precisionToInterval collapses a time value to its minute, so a seconds field could
    // only ever print `00` and would imply a resolution the corpus does not have.
    expect(formatWhen(e)).not.toMatch(/:\d{2}:\d{2}/);
  });

  it('does not pad the day of month', () => {
    expect(formatWhen(authored('day', '2035-02-01'))).toBe('1 February 2035');
  });
});

// ---------------------------------------------------------------------------
// The label reads back as the window it came from
// ---------------------------------------------------------------------------

describe('a rendered label is a value precisionToInterval understands', () => {
  /**
   * The coarse labels are deliberately drawn from `precisionToInterval`'s own
   * vocabulary, so parsing one returns the window it was rendered from. That is what
   * stops the display growing a second dialect the editor cannot read back — and it is
   * a much sharper check than "the string looks right", because it fails if the
   * qualifier, the quarter or the decade band is off by one.
   *
   * `day` and `time` are excluded on purpose: they render as prose ("13 August 2034"),
   * which is not an input form. Their fidelity is asserted componentwise above.
   */
  const roundTrippable: readonly WhenPrecision[] = ['decade', 'year', 'season', 'month'];

  const cases: ReadonlyArray<readonly [WhenPrecision, string]> = [
    ['decade', 'Early 2050s'],
    ['decade', 'Mid 2050s'],
    ['decade', 'Late 2050s'],
    ['decade', '2050s'],
    ['year', '2036'],
    ['year', '2084'],
    ['season', 'Q1 2047'],
    ['season', 'Q2 2047'],
    ['season', 'Q3 2047'],
    ['season', 'Late 2035'],
    ['month', 'March 2042'],
    ['month', '2042-12'],
  ];

  for (const [precision, value] of cases) {
    it(`${precision} "${value}" round-trips`, () => {
      expect(roundTrippable).toContain(precision);
      const event = authored(precision, value);
      const rendered = formatWhen(event);
      expect(precisionToInterval(precision, rendered)).toEqual([event.whenMin, event.whenMax]);
    });
  }

  it('round-trips every seeded event whose precision is coarser than a day', () => {
    for (const e of SEEDED) {
      if (!roundTrippable.includes(e.whenPrecision)) continue;
      expect(precisionToInterval(e.whenPrecision, formatWhen(e))).toEqual([e.whenMin, e.whenMax]);
    }
  });
});

// ---------------------------------------------------------------------------
// Failure is loud
// ---------------------------------------------------------------------------

describe('formatWhen refuses to guess', () => {
  const base = authored('year', '2036');

  it('rejects a whenMin that is not the canonical spelling', () => {
    // The short form is a WRITE error at the column (§2.1); if one ever reaches here the
    // row is broken, and rendering something plausible from it hides that.
    expect(() => formatWhen({ ...base, whenMin: '2036-01-01T00:01:00Z' })).toThrow(RangeError);
    expect(() => formatWhen({ ...base, whenMin: '2036-01-01' })).toThrow(RangeError);
    expect(() => formatWhen({ ...base, whenMin: 'sometime in 2036' })).toThrow(RangeError);
    expect(() => formatWhen({ ...base, whenMin: '' })).toThrow(RangeError);
  });

  it('rejects a whenMax that is not canonical, at the precision that reads it', () => {
    const decade = authored('decade', '2050s');
    expect(() => formatWhen({ ...decade, whenMax: 'the 2050s' })).toThrow(RangeError);
  });

  it('rejects a precision outside the closed enum', () => {
    const rogue = { ...base, whenPrecision: 'century' as unknown as WhenPrecision };
    expect(() => formatWhen(rogue)).toThrow(/unknown when_precision/);
  });

  it('rejects a month field outside 1..12 rather than rendering it', () => {
    expect(() =>
      formatWhen({ ...base, whenPrecision: 'month', whenMin: '2036-13-01T00:01:00.000Z' }),
    ).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// The real file: data/lifestream.db, opened read-only
// ---------------------------------------------------------------------------

const dbPath = `${repoRoot}data/lifestream.db`;
const dbPresent = existsSync(dbPath);

/**
 * `data/*.db` is gitignored and rebuilt from migrations + seed (§7.4), so this block is
 * skipped on a fresh clone. It is a CROSS-CHECK, not the spec's only teeth: everything
 * above runs from `CANON_EVENTS`, which is committed, and this block's job is to prove
 * those derived rows really are the rows on disk.
 */
describe.skipIf(!dbPresent)('the rows actually on disk render the same way', () => {
  interface StoredRow {
    id: string;
    when: string;
    when_min: string;
    when_max: string;
    when_precision: string;
    category: string;
  }

  const readRows = (): StoredRow[] => {
    // Opened READ-ONLY twice over: the `mode=ro` URI and the `readOnly` flag. This is the
    // authored world; nothing in the suite may mutate it.
    const db = new DatabaseSync(`file:${dbPath}?mode=ro`, { readOnly: true });
    try {
      return db
        .prepare(
          `select id, "when", when_min, when_max, when_precision, category
             from event where save_id = ? order by id`,
        )
        .all(CANON_SAVE_ID) as unknown as StoredRow[];
    } finally {
      db.close();
    }
  };

  const rows = readRows();

  it('holds the thirteen events the fixtures above were derived from', () => {
    expect(rows).toHaveLength(SEEDED_EVENT_COUNT);
    expect(rows.map((r) => r.id)).toEqual([...SEEDED].map((e) => e.id).sort());
  });

  it('matches the derived fixtures field for field', () => {
    for (const row of rows) {
      const derived = byId(row.id);
      expect({
        when: row.when,
        whenMin: row.when_min,
        whenMax: row.when_max,
        whenPrecision: row.when_precision,
      }).toEqual({
        when: derived.when,
        whenMin: derived.whenMin,
        whenMax: derived.whenMax,
        whenPrecision: derived.whenPrecision,
      });
    }
  });

  it('renders each stored row at its stored precision', () => {
    for (const row of rows) {
      expect(CATEGORIES).toContain(row.category);
      const rendered = formatWhen({
        id: row.id,
        when: row.when,
        whenMin: row.when_min,
        whenMax: row.when_max,
        whenPrecision: row.when_precision as WhenPrecision,
      } as SeededEvent);
      expect(rendered).toBe(EXPECTED[row.id]);
      if (row.when_precision !== 'time') expect(rendered).not.toMatch(/\d:\d/);
    }
  });
});

describe('the read-only cross-check', () => {
  it(dbPresent ? 'ran against data/lifestream.db' : 'was skipped: no data/lifestream.db', () => {
    // Stated as a passing assertion so the skip is visible in the report rather than
    // being a silent hole. `npm run db:reset && npm run db:migrate && npm run db:seed`
    // is what fills it.
    expect(typeof dbPresent).toBe('boolean');
  });
});
