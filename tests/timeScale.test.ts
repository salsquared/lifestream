import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CANON_EVENTS } from '@server/seed/events';
import { precisionToInterval, rollDate } from '@shared/rollDate';
import { CORRIDOR_END, WORLD_UNITS_PER_YEAR, createTimeScale } from '@shared/timeScale';

/**
 * P4.2.1 — the canonical time scale (architecture §5.2, NORMATIVE).
 *
 * ── WHY THIS SPEC EXISTS ─────────────────────────────────────────────────────────────
 * There is exactly one scale, and five things depend on it agreeing with itself: node
 * positions, camera fly-to targets, the viewport clamp, the HUD's date readout and the
 * Tech Tree's X axis. Two failure modes matter and neither raises anything:
 *
 *   1. **A lossy inversion.** The HUD reads the camera's date by inverting through this
 *      object. If `toDate(toX(t))` drifts by a millisecond the HUD is merely imprecise;
 *      if it drifts by a minute the cutoff warning fires at the wrong moment and a
 *      fly-to lands off its target. So the round trip is asserted EXACT, with the
 *      measured error bound printed rather than assumed.
 *   2. **A domain that does not cover the corpus.** A node outside the domain still
 *      draws — extrapolated, off the end of the clamped viewport, unreachable. Nothing
 *      reports it. So every seeded event and the stated end date are checked to land
 *      inside `range()`.
 *
 * A third property is asserted because it is a design commitment rather than an
 * accident: the slope is CONSTANT. Moving `CORRIDOR_END` or seeding an earlier event
 * translates the world instead of rescaling it, which is what keeps a shared URL and a
 * saved camera pose meaningful as P5 lands the remaining 68 bullets.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const CANON_SAVE_ID = 'sav_canon';

/** Milliseconds in the mean Gregorian year — the scale's unit, restated independently. */
const MS_PER_YEAR = 365.2425 * 86_400_000;

// ---------------------------------------------------------------------------
// The corpus, derived exactly as `runSeed` derives it (see formatWhen.test.ts)
// ---------------------------------------------------------------------------

const SEEDED = CANON_EVENTS.map((authored) => {
  const [whenMin, whenMax] = precisionToInterval(authored.precision, authored.precisionValue);
  return { id: authored.id, whenMin, whenMax, when: rollDate(authored.id, whenMin, whenMax) };
});

/** What P4.2.2 positions nodes at: the earliest persisted roll. */
const EARLIEST_WHEN = SEEDED.map((e) => e.when).sort()[0] as string;

/** The roomier alternative: the earliest window opening. */
const EARLIEST_WINDOW = SEEDED.map((e) => e.whenMin).sort()[0] as string;

const scale = createTimeScale(EARLIEST_WHEN);

// ---------------------------------------------------------------------------
// Domain and range
// ---------------------------------------------------------------------------

describe('the domain is what the plan says it is', () => {
  it('runs from the earliest seeded event to the Bible’s last dated bullet', () => {
    expect(scale.domain()).toEqual([EARLIEST_WHEN, CORRIDOR_END]);
    expect(CORRIDOR_END).toBe('2084-04-25T23:59:00.000Z');
  });

  it('puts the domain start at x = 0 and the end at the top of the range', () => {
    const [x0, x1] = scale.range();
    expect(x0).toBe(0);
    expect(scale.toX(EARLIEST_WHEN)).toBe(x0);
    expect(scale.toX(CORRIDOR_END)).toBeCloseTo(x1, 9);
    expect(x1).toBeGreaterThan(0);
  });

  it('covers every seeded event when built from the earliest roll', () => {
    const [x0, x1] = scale.range();
    for (const e of SEEDED) {
      const x = scale.toX(e.when);
      expect(Number.isFinite(x), `${e.id} mapped to ${x}`).toBe(true);
      expect(x, `${e.id} is left of the corridor`).toBeGreaterThanOrEqual(x0);
      expect(x, `${e.id} is right of the corridor`).toBeLessThanOrEqual(x1);
    }
  });

  it('covers every event’s whole WINDOW when built from the earliest window opening', () => {
    // Documents the choice the caller makes. Node positions only need `min(when)`; an era
    // ribbon or a project span drawn from `[when_min, when_max]` needs the roomier bound,
    // and the difference is real — the first event's window opens five weeks before its
    // roll, so a scale built from `min(when)` puts that opening at a negative x.
    const roomier = createTimeScale(EARLIEST_WINDOW);
    const [x0, x1] = roomier.range();
    for (const e of SEEDED) {
      expect(roomier.toX(e.whenMin), `${e.id} window opening`).toBeGreaterThanOrEqual(x0);
      expect(roomier.toX(e.whenMax), `${e.id} window close`).toBeLessThanOrEqual(x1);
    }
    expect(scale.toX(EARLIEST_WINDOW)).toBeLessThan(0);
  });

  it('reports range() and domain() as frozen tuples nobody can edit underneath it', () => {
    // The `readonly` tuple is a compile-time guarantee; `Object.freeze` is the runtime
    // one, and only the second survives into a consumer's JS. Both are asserted.
    const range = scale.range() as unknown as number[];
    const domain = scale.domain() as unknown as string[];
    expect(Object.isFrozen(range)).toBe(true);
    expect(Object.isFrozen(domain)).toBe(true);
    expect(() => {
      range[0] = 999;
    }).toThrow(TypeError);
    expect(scale.range()[0]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The round trip — the property the HUD depends on
// ---------------------------------------------------------------------------

describe('toX / toDate round-trip', () => {
  /** Reports the measured bound alongside the assertion, so it is a number not a hope. */
  const roundTripErrorMs = (instants: readonly string[]): number => {
    let worst = 0;
    for (const iso of instants) {
      const back = scale.toDate(scale.toX(iso));
      worst = Math.max(worst, Math.abs(Date.parse(back) - Date.parse(iso)));
    }
    return worst;
  };

  it('is EXACT for every seeded event', () => {
    for (const e of SEEDED) {
      expect(scale.toDate(scale.toX(e.when)), e.id).toBe(e.when);
      expect(scale.toDate(scale.toX(e.whenMin)), `${e.id} min`).toBe(e.whenMin);
      expect(scale.toDate(scale.toX(e.whenMax)), `${e.id} max`).toBe(e.whenMax);
    }
    expect(roundTripErrorMs(SEEDED.flatMap((e) => [e.when, e.whenMin, e.whenMax]))).toBe(0);
  });

  it('is EXACT at both ends of the domain', () => {
    const [start, end] = scale.domain();
    expect(scale.toDate(scale.toX(start))).toBe(start);
    expect(scale.toDate(scale.toX(end))).toBe(end);
    expect(scale.toDate(scale.range()[1])).toBe(CORRIDOR_END);
  });

  /**
   * The error bound, measured rather than assumed. 20 000 minute-aligned instants spread
   * over the whole corridor — minute-aligned because that is the resolution every stored
   * `when` has (`rollDate` emits nothing finer).
   */
  it('is EXACT across 20 000 instants spanning the corridor, |error| = 0 ms', () => {
    const startMs = Date.parse(scale.domain()[0]);
    const endMs = Date.parse(scale.domain()[1]);
    const MINUTE = 60_000;

    const samples: string[] = [];
    const count = 20_000;
    for (let i = 0; i < count; i++) {
      const raw = startMs + ((endMs - startMs) * i) / (count - 1);
      samples.push(new Date(Math.round(raw / MINUTE) * MINUTE).toISOString());
    }

    const worst = roundTripErrorMs(samples);
    expect(worst, `round-trip error bound was ${worst} ms`).toBe(0);
  });

  it('is EXACT for millisecond-resolution instants too, not just minutes', () => {
    // Nothing stores sub-minute `when` today, but the HUD inverts arbitrary camera x and
    // a fly-to may target a computed midpoint. A rounding bug there would show up as the
    // readout stuttering by a millisecond.
    const startMs = Date.parse(scale.domain()[0]);
    const endMs = Date.parse(scale.domain()[1]);
    let worst = 0;
    for (let i = 0; i < 5000; i++) {
      // Deterministic spread, no Math.random — a flaky spec here would be worse than none.
      const ms = startMs + ((i * 2_654_435_761) % (endMs - startMs));
      const iso = new Date(ms).toISOString();
      const back = scale.toDate(scale.toX(iso));
      worst = Math.max(worst, Math.abs(Date.parse(back) - ms));
    }
    expect(worst, `sub-minute round-trip error bound was ${worst} ms`).toBe(0);
  });

  it('rounds to the nearest millisecond rather than truncating toward the epoch', () => {
    // `toDate` has to quantise somehow, and truncation is the tempting one-character
    // alternative. It is wrong by up to a whole millisecond in one direction only, which
    // makes the HUD's readout lag the camera rather than jitter around it — a bias, not
    // noise, and biases are what accumulate over a fly-to's easing. Constructed here from
    // x values that land on a deliberate fraction of a millisecond, because no `toX`
    // output ever does.
    const startMs = Date.parse(scale.domain()[0]);
    const endMs = Date.parse(scale.domain()[1]);
    const spanX = scale.range()[1];
    const xFor = (ms: number): number => ((ms - startMs) / (endMs - startMs)) * spanX;

    const target = Date.parse('2042-06-15T12:34:56.000Z');
    expect(scale.toDate(xFor(target + 0.4))).toBe('2042-06-15T12:34:56.000Z');
    expect(scale.toDate(xFor(target + 0.6))).toBe('2042-06-15T12:34:56.001Z');
    expect(scale.toDate(xFor(target - 0.4))).toBe('2042-06-15T12:34:56.000Z');
    expect(scale.toDate(xFor(target - 0.6))).toBe('2042-06-15T12:34:55.999Z');
  });

  it('inverts in the other direction too: toX(toDate(x)) returns x within a rounding tick', () => {
    // `toDate` quantises to the millisecond, so the return leg can only be exact up to
    // the x that one millisecond spans — about 3.2e-10 world units. Asserted as a bound
    // rather than as equality, and the bound is what a caller may rely on: the camera
    // may pan by a full world unit and still read back the same instant.
    const oneMsInX = WORLD_UNITS_PER_YEAR / MS_PER_YEAR;
    const [x0, x1] = scale.range();
    let worst = 0;
    for (let i = 0; i <= 1000; i++) {
      const x = x0 + ((x1 - x0) * i) / 1000;
      worst = Math.max(worst, Math.abs(scale.toX(scale.toDate(x)) - x));
    }
    expect(worst).toBeLessThanOrEqual(2 * oneMsInX);
    expect(2 * oneMsInX).toBeLessThan(1e-9);
  });
});

// ---------------------------------------------------------------------------
// Linearity — the commitment that keeps saved poses valid
// ---------------------------------------------------------------------------

describe('the scale is a straight line with a fixed slope', () => {
  it('is strictly increasing over the seeded corpus', () => {
    const xs = [...SEEDED]
      .sort((a, b) => a.when.localeCompare(b.when))
      .map((e) => scale.toX(e.when));
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]!, `event ${i} went backwards`).toBeGreaterThan(xs[i - 1]!);
    }
  });

  it('advances WORLD_UNITS_PER_YEAR per mean year, anywhere in the corridor', () => {
    const at = (ms: number): number => scale.toX(new Date(ms).toISOString());
    const t0 = Date.parse('2036-01-01T00:00:00.000Z');
    for (const offsetYears of [0, 1, 10, 30]) {
      const a = t0 + offsetYears * MS_PER_YEAR;
      expect(at(a + MS_PER_YEAR) - at(a)).toBeCloseTo(WORLD_UNITS_PER_YEAR, 9);
    }
    expect(WORLD_UNITS_PER_YEAR).toBe(10);
  });

  it('translates rather than rescales when the domain start moves', () => {
    // Seeding an earlier event must not compress the world. If the range were a fixed
    // world length instead of a fixed units-per-year, every existing node would move and
    // every shared URL and saved camera pose would silently point somewhere else.
    const shifted = createTimeScale('2019-01-01T00:00:00.000Z');
    const a = '2036-10-07T05:55:00.000Z';
    const b = '2040-08-14T01:35:00.000Z';
    expect(shifted.toX(b) - shifted.toX(a)).toBeCloseTo(scale.toX(b) - scale.toX(a), 9);
  });

  it('extrapolates outside the domain instead of clamping', () => {
    // A clamp would stack an out-of-range node invisibly on the corridor's first node.
    // A negative x is visibly wrong, which is the point.
    expect(scale.toX('2015-01-01T00:00:00.000Z')).toBeLessThan(0);
    expect(scale.toX('2090-01-01T00:00:00.000Z')).toBeGreaterThan(scale.range()[1]);
  });
});

// ---------------------------------------------------------------------------
// Failure is loud
// ---------------------------------------------------------------------------

describe('createTimeScale refuses input it cannot trust', () => {
  it('rejects anything but the canonical instant spelling, and says so', () => {
    // The short form is a WRITE error at the column (§2.1). Accepting it here would make
    // this the one place two spellings of an instant coexist.
    //
    // The MESSAGE is asserted, not just the throw: "not a canonical instant" and "not a
    // real calendar date" send a developer to two different bugs — a serialisation that
    // dropped the milliseconds, versus a date that does not exist. A shape check that
    // quietly degrades into the calendar check still throws, and would still pass a bare
    // `toThrow(RangeError)`.
    expect(() => createTimeScale('2021-01-01T00:01:00Z')).toThrow(/not a canonical instant/);
    expect(() => createTimeScale('2021-01-01')).toThrow(/not a canonical instant/);
    expect(() => createTimeScale('sometime in 2036')).toThrow(/not a canonical instant/);
    expect(() => createTimeScale('')).toThrow(/not a canonical instant/);
  });

  it('rejects a date that survives Date.parse but is not a real calendar date', () => {
    // Date.parse('2035-02-30') is 2035-03-02 — a plausible instant, silently two days off.
    expect(() => createTimeScale('2035-02-30T00:01:00.000Z')).toThrow(/real calendar date/);
  });

  it('rejects a domain that is empty or reversed', () => {
    expect(() => createTimeScale(CORRIDOR_END)).toThrow(/not before CORRIDOR_END/);
    expect(() => createTimeScale('2090-01-01T00:00:00.000Z')).toThrow(/not before CORRIDOR_END/);
  });

  it('rejects a non-canonical instant at toX rather than mapping it to NaN', () => {
    // A NaN x does not throw in three.js — the mesh is simply not drawn, and the event
    // disappears from the flagship view with nothing in the console.
    expect(() => scale.toX('2036-01-01')).toThrow(RangeError);
    expect(() => scale.toX('not a date')).toThrow(RangeError);
  });

  it('rejects a non-finite x at toDate, and says which failure it was', () => {
    // The messages are asserted apart because the two guards catch different mistakes:
    // NaN/Infinity is a caller handing over a broken camera x, while 1e30 is a finite x
    // that simply maps past the end of representable time. Collapsing them would let the
    // first guard be deleted without the suite noticing.
    expect(() => scale.toDate(Number.NaN)).toThrow(/is not finite/);
    expect(() => scale.toDate(Number.POSITIVE_INFINITY)).toThrow(/is not finite/);
    expect(() => scale.toDate(1e30)).toThrow(/outside representable time/);
  });
});

// ---------------------------------------------------------------------------
// The rows actually on disk
// ---------------------------------------------------------------------------

const dbPath = `${repoRoot}data/lifestream.db`;
const dbPresent = existsSync(dbPath);

/** Skipped on a fresh clone: `data/*.db` is gitignored and rebuilt (§7.4). */
describe.skipIf(!dbPresent)('the corridor covers the rows actually on disk', () => {
  it('places every stored event inside range(), and none of them at NaN', () => {
    const db = new DatabaseSync(`file:${dbPath}?mode=ro`, { readOnly: true });
    let rows: Array<{ id: string; when: string }>;
    try {
      rows = db
        .prepare(`select id, "when" from event where save_id = ? order by "when"`)
        .all(CANON_SAVE_ID) as unknown as Array<{ id: string; when: string }>;
    } finally {
      db.close();
    }

    expect(rows.length).toBe(SEEDED.length);
    const stored = createTimeScale(rows[0]!.when);
    const [x0, x1] = stored.range();
    for (const row of rows) {
      const x = stored.toX(row.when);
      expect(Number.isNaN(x), `${row.id} mapped to NaN`).toBe(false);
      expect(x).toBeGreaterThanOrEqual(x0);
      expect(x).toBeLessThanOrEqual(x1);
      expect(stored.toDate(x), `${row.id} did not round-trip`).toBe(row.when);
    }
  });
});
