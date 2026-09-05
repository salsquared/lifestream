/**
 * The seeded date roller behind `event.when` — architecture §2.6, implementation P1.8.
 *
 * Under the fuzzy-date decision (§2.3) an event stores the window the author actually
 * knows — `when_min` / `when_max` / `when_precision` — and derives a single point inside
 * it for layout. `rollDate()` is that derivation, and `precisionToInterval()` is the
 * window derivation that feeds it. Roughly 46% of the corpus is coarser than `day`
 * precision, so this module, not the source text, is where most events' `when` comes
 * from.
 *
 * Two properties make it load-bearing rather than convenient:
 *
 *   1. **It is seeded on the event id, never on wall-clock randomness.** The same event
 *      always rolls to the same instant — in the seed script, in the UI editor, and in
 *      any later process — which is what keeps node positions stable across reloads and
 *      across a shared URL. An explicit re-roll bumps a nonce
 *      (`rollDate(eventId + ':' + n, …)`) so the author can shuffle a date deliberately
 *      without giving up reproducibility.
 *   2. **It returns TEXT ISO-8601 UTC, not a `Date`.** `event.when` is a TEXT column; a
 *      `Date` return would break at the column boundary.
 *
 * ## The output is a persisted contract
 *
 * `when` is written to the database and is *not* recomputed on read. Changing the hash
 * constants, the PRNG, the warm-up count or the index mapping below therefore silently
 * re-rolls every event in every save the next time one is seeded — every node in the
 * Corridor moves. Treat this file's arithmetic as frozen; add behaviour beside it rather
 * than editing it in place.
 *
 * No `node:*` and no DOM. The shared workspace is isomorphic by construction
 * (`shared/tsconfig.json` sets `"types": []`), which is why the PRNG is hand-rolled here
 * instead of reaching for `node:crypto`.
 */

// ---------------------------------------------------------------------------
// Time constants
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Minutes in a day. */
const MINUTES_PER_DAY = 1440;

/**
 * Minutes in a day that a roll may land on: 00:01 through 23:59 inclusive.
 *
 * The clamp in P1.8.1 ("time-of-day clamped 00:01–23:59") excludes exactly one minute
 * per day — midnight — because 00:00 reads as a day boundary rather than as a time, and
 * `precisionToInterval` uses 00:01/23:59 as its own span endpoints for the same reason.
 */
const ROLLABLE_MINUTES_PER_DAY = MINUTES_PER_DAY - 1;

/** Offset of 00:01 within a UTC day. */
const DAY_FIRST_ROLLABLE_MS = MINUTE_MS;

/** Offset of 23:59 within a UTC day. */
const DAY_LAST_ROLLABLE_MS = ROLLABLE_MINUTES_PER_DAY * MINUTE_MS;

// ---------------------------------------------------------------------------
// Seeded PRNG — cyrb128 (string → 128-bit seed) + sfc32 (counter-based generator)
// ---------------------------------------------------------------------------

/**
 * Hash an arbitrary seed string to four 32-bit words.
 *
 * Operates on UTF-16 code units, so it is byte-for-byte identical in every JS engine —
 * the seed script (node) and the editor (browser) must agree, and they do.
 */
function cyrb128(seed: string): [number, number, number, number] {
  let h1 = 1_779_033_703;
  let h2 = 3_144_134_277;
  let h3 = 1_013_904_242;
  let h4 = 2_773_480_762;

  for (let i = 0; i < seed.length; i++) {
    const k = seed.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597_399_067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2_869_860_233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951_274_213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2_716_044_179);
  }

  h1 = Math.imul(h3 ^ (h1 >>> 18), 597_399_067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2_869_860_233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951_274_213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2_716_044_179);

  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
}

/** Draws consumed after seeding so neighbouring seeds decorrelate before first use. */
const SFC32_WARMUP = 12;

/**
 * A unit float in [0, 1) derived from `seed`, with a full 53 bits of entropy.
 *
 * sfc32 is a small counter-based generator with a proven period; two draws are combined
 * into one double so that even a decade-wide window (~5.3M minutes) is sampled without
 * the quantisation a single 32-bit draw would impose.
 */
function seededUnitFloat(seed: string): number {
  let [a, b, c, d] = cyrb128(seed);

  const next = (): number => {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };

  for (let i = 0; i < SFC32_WARMUP; i++) next();

  // 27 high bits + 26 high bits => a 53-bit mantissa, the standard construction.
  const hi = next() >>> 5;
  const lo = next() >>> 6;
  return (hi * 67_108_864 + lo) / 9_007_199_254_740_992;
}

// ---------------------------------------------------------------------------
// Instant helpers
// ---------------------------------------------------------------------------

/**
 * `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm[:ss[.sss]]Z`.
 *
 * The `Z` is mandatory whenever a time is present, and no other offset is accepted. Per
 * the ES Date Time String Format a date-time with *no* designator is **local time** —
 * so `Date.parse('2036-01-01T00:01')` yields a different instant on a machine in Madrid
 * than on one in Los Angeles, and seeding the same corpus twice would produce two
 * different worlds. A bare date is unambiguously UTC and is therefore allowed.
 */
const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?Z)?$/;

/**
 * Parse a TEXT ISO-8601 UTC instant to epoch ms, strictly.
 *
 * `Date.parse` alone is not enough, and the two ways it fails here are both silent:
 *
 *   - It falls back to an implementation-defined parser for anything it does not
 *     recognise. V8 reads `"sometime in 2036"` as 2036-01-01 **in the local timezone** —
 *     a plausible-looking instant, machine-dependent, no error.
 *   - It rolls impossible calendar dates over instead of rejecting them:
 *     `Date.parse('2035-02-30')` is 2035-03-02, which would move a mistyped seed event
 *     into the wrong month with nothing to show for it.
 *
 * So the shape is matched first, and the components are then checked to round-trip.
 */
function parseInstant(value: string, label: string, fn: string): number {
  const parts = ISO_UTC.exec(value);
  if (!parts) {
    throw new RangeError(
      `${fn}: ${label} is not TEXT ISO-8601 UTC (YYYY-MM-DD or YYYY-MM-DDTHH:mm[:ss[.sss]]Z): ${value}`,
    );
  }

  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new RangeError(`${fn}: ${label} is not a real instant: ${value}`);
  }

  // Round-trip the calendar components, catching the rollover Date.parse performs
  // silently. Safe to compare in UTC because the pattern admits no other offset.
  const at = new Date(ms);
  const [, year = '', month = '', day = ''] = parts;
  if (
    at.getUTCFullYear() !== Number(year) ||
    at.getUTCMonth() + 1 !== Number(month) ||
    at.getUTCDate() !== Number(day)
  ) {
    throw new RangeError(`${fn}: ${label} is not a real calendar date: ${value}`);
  }

  return ms;
}

/**
 * Canonical serialisation for every instant this module emits.
 *
 * `toISOString()` is fixed-width UTC (`2036-01-01T00:01:00.000Z`), so the TEXT column
 * sorts lexicographically in the same order it sorts chronologically — which every
 * `ORDER BY when` depends on. The docs abbreviate this to `2036-01-01T00:01` in prose;
 * the stored form is the full canonical one.
 */
function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Smallest minute-aligned instant at or after `ms`. */
function ceilToMinute(ms: number): number {
  return Math.ceil(ms / MINUTE_MS) * MINUTE_MS;
}

/** Largest minute-aligned instant at or before `ms`. */
function floorToMinute(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/**
 * Number of rollable (non-midnight) minute instants in `[epoch, ms]`, for minute-aligned
 * `ms`. Writing `ms = D·DAY + m·MINUTE` with `0 <= m < 1440`, every day contributes its
 * 1439 non-midnight minutes, so this is `D·1439 + m` — which inverts in closed form and
 * is what lets a uniform draw skip midnight without enumerating the window.
 */
function rollableMinutesUpTo(ms: number): number {
  return ms / MINUTE_MS - Math.floor(ms / DAY_MS);
}

/** Inverse of {@link rollableMinutesUpTo}: the `rank`-th rollable minute since the epoch. */
function rollableMinuteAt(rank: number): number {
  const day = Math.floor((rank - 1) / ROLLABLE_MINUTES_PER_DAY);
  const minuteOfDay = rank - day * ROLLABLE_MINUTES_PER_DAY;
  return day * DAY_MS + minuteOfDay * MINUTE_MS;
}

/** True when `ms` (minute-aligned) is exactly 00:00 UTC. */
function isMidnight(ms: number): boolean {
  return ms - Math.floor(ms / DAY_MS) * DAY_MS === 0;
}

// ---------------------------------------------------------------------------
// rollDate
// ---------------------------------------------------------------------------

/**
 * Roll a stable point inside the closed window `[whenMin, whenMax]`.
 *
 * @param seed  The event id. Pass `eventId + ':' + n` to re-roll deliberately — a
 *              different seed is a different point, and the same seed is the same point
 *              forever.
 * @param whenMin  `event.when_min`, TEXT ISO-8601 UTC.
 * @param whenMax  `event.when_max`, TEXT ISO-8601 UTC. Must be `>= whenMin`, the same
 *                 rule the column's CHECK constraint enforces.
 * @returns `event.when` as TEXT ISO-8601 UTC — never a `Date`.
 *
 * Uniform over the minute instants in the window, skipping midnight so the result obeys
 * the 00:01–23:59 time-of-day clamp. The draw depends on `seed` alone, not on the
 * window: widening a window moves the point proportionally rather than arbitrarily, so
 * an author who loosens a precision does not see the node jump across the Corridor.
 *
 * **Two documented precedences**, both cases the seed corpus actually reaches:
 *
 *   - *The window beats the clamp.* A window with no rollable minute in it — a `time`
 *     precision event authored at exactly midnight, say — returns `whenMin` rather than
 *     stepping outside the range the author stated. The result is always within
 *     `[whenMin, whenMax]`; the clamp is best-effort on top of that.
 *   - *A sub-minute window returns its lower bound.* If no minute instant falls inside
 *     the window at all, `whenMin` is the only point that is certainly inside it.
 */
export function rollDate(seed: string, whenMin: string, whenMax: string): string {
  const min = parseInstant(whenMin, 'whenMin', 'rollDate');
  const max = parseInstant(whenMax, 'whenMax', 'rollDate');

  if (max < min) {
    throw new RangeError(`rollDate: whenMax (${whenMax}) precedes whenMin (${whenMin})`);
  }

  const lo = ceilToMinute(min);
  const hi = floorToMinute(max);

  // Sub-minute window: no minute instant lies inside it.
  if (lo > hi) return toIso(min);

  const minuteCount = (hi - lo) / MINUTE_MS + 1;
  const firstMidnight = Math.ceil(lo / DAY_MS) * DAY_MS;
  const midnightCount = firstMidnight > hi ? 0 : Math.floor((hi - firstMidnight) / DAY_MS) + 1;
  const rollableCount = minuteCount - midnightCount;

  // Every minute in the window is midnight — only reachable when the window is the
  // single instant 00:00. The window wins; see the precedence note above.
  if (rollableCount <= 0) return toIso(min);

  // `rank` is 1-based within the window; `base` shifts it into epoch-relative rollable
  // space, where the closed-form inverse lives.
  const draw = Math.floor(seededUnitFloat(seed) * rollableCount);
  const rank = Math.min(draw, rollableCount - 1) + 1;
  const base = rollableMinutesUpTo(lo) - (isMidnight(lo) ? 0 : 1);

  return toIso(rollableMinuteAt(base + rank));
}

// ---------------------------------------------------------------------------
// precisionToInterval
// ---------------------------------------------------------------------------

/**
 * `event.when_precision` — the closed enum from architecture §2.3.
 *
 * Declared here because `rollDate.ts` was written alongside `shared/src/types/` rather
 * than after it. `shared/src/types/enums.ts` now carries a structurally identical
 * `WhenPrecision`, so the two interoperate freely — but they are two declarations of one
 * closed enum, which is the drift this codebase otherwise works hard to avoid.
 *
 * FOLLOW-UP (one line, once both landings have settled): delete this declaration and
 * `export type { WhenPrecision } from './types/enums';` instead. Deferred only because
 * that file was still in flight when this module was written.
 */
// Declared once in `@shared/types` — the schema's CHECK constraint and this roller must
// never be able to disagree about the member list.
export type { WhenPrecision } from './types/enums.js';
import type { WhenPrecision } from './types/enums.js';

/** All members of {@link WhenPrecision}, in coarse-to-fine order. */
export const WHEN_PRECISIONS: readonly WhenPrecision[] = [
  'decade',
  'year',
  'season',
  'month',
  'day',
  'time',
];

/**
 * The season vocabulary, as quarters.
 *
 * A season *is* a quarter in this model — implementation P10.1 says so outright ("a
 * quarter is a season") and architecture §2.3 pins one mapping directly: "Late 2035
 * becomes a Q4 window". The rest of the table is a convention chosen here, not one the
 * docs fix:
 *
 *   - **Northern-hemisphere meteorological quarters** for the named seasons — winter
 *     Jan–Mar, spring Apr–Jun, summer Jul–Sep, autumn Oct–Dec. This is the alignment
 *     that makes "Fall 2047" (implementation P10.1.2) and Q4 the same window, which
 *     "Late 2035 → Q4" already requires.
 *   - **early / mid / late** as Q1 / Q3 / Q4. `late → Q4` is fixed by the docs;
 *     `early → Q1` follows it; `mid → Q3` picks the quarter that opens at the exact
 *     midpoint of the year (1 July).
 *
 * Anything not in this table is rejected rather than guessed at, so a Bible phrasing
 * nobody has taught the parser fails loudly at seed time instead of silently landing in
 * Q1.
 */
/**
 * How a decade qualifier narrows the window. The bands are deliberately uneven at the
 * edges: "early" and "late" read as the first and last few years, "mid" as the middle
 * third. Unqualified decades use the full span and never reach this table.
 */
const DECADE_BAND: Record<string, [number, number] | undefined> = {
  early: [0, 3],
  mid: [4, 6],
  late: [7, 9],
};

const SEASON_QUARTER: Readonly<Record<string, 1 | 2 | 3 | 4>> = {
  q1: 1,
  q2: 2,
  q3: 3,
  q4: 4,
  winter: 1,
  spring: 2,
  summer: 3,
  fall: 4,
  autumn: 4,
  early: 1,
  mid: 3,
  late: 4,
};

/** Month names and their common abbreviations, for the `month` parser. */
const MONTH_NAMES: readonly string[] = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

const DAYS_IN_MONTH: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 1 && isLeapYear(year)) return 29;
  return DAYS_IN_MONTH[month] ?? 31;
}

/**
 * Midnight UTC of a calendar date, as epoch ms.
 *
 * `Date.UTC` maps years 0–99 onto 1900–1999; the correction keeps the helper honest for
 * any year even though this world only runs 2030–2080.
 */
function utcMidnight(year: number, month: number, day: number): number {
  const ms = Date.UTC(year, month, day);
  if (year >= 0 && year <= 99) {
    const d = new Date(ms);
    d.setUTCFullYear(year);
    return d.getTime();
  }
  return ms;
}

/** `[00:01, 23:59]` spanning the inclusive calendar range `first` … `last`. */
function span(
  first: readonly [number, number, number],
  last: readonly [number, number, number],
): [string, string] {
  const [fy, fm, fd] = first;
  const [ly, lm, ld] = last;
  return [
    toIso(utcMidnight(fy, fm, fd) + DAY_FIRST_ROLLABLE_MS),
    toIso(utcMidnight(ly, lm, ld) + DAY_LAST_ROLLABLE_MS),
  ];
}

function requireInt(text: string, label: string, raw: string): number {
  if (!/^\d+$/.test(text)) {
    throw new RangeError(`precisionToInterval: ${label} in "${raw}" is not a number`);
  }
  return Number(text);
}

function parseMonthToken(token: string, raw: string): number {
  const lower = token.toLowerCase();
  const index = MONTH_NAMES.findIndex((name) => name === lower || name.slice(0, 3) === lower);
  if (index === -1) {
    throw new RangeError(`precisionToInterval: "${raw}" names no month`);
  }
  return index;
}

/**
 * Derive `[when_min, when_max]` from the precision and value the author entered —
 * implementation P1.8.3. The author never types two endpoints; they say what they know
 * and the window follows, which is what stops a year-precision Bible bullet from
 * acquiring a fabricated datetime.
 *
 * Accepted `value` forms, all case-insensitive and whitespace-tolerant:
 *
 * | precision | forms                                          | example window                                   |
 * | --------- | ---------------------------------------------- | ------------------------------------------------ |
 * | `decade`  | `2050s`, `2050`, `2053`                        | `2050-01-01T00:01` … `2059-12-31T23:59`          |
 * | `year`    | `2036`                                         | `2036-01-01T00:01` … `2036-12-31T23:59`          |
 * | `season`  | `Late 2035`, `Q4 2035`, `2035-Q4`, `Fall 2047` | `2035-10-01T00:01` … `2035-12-31T23:59`          |
 * | `month`   | `2042-03`, `March 2042`, `Mar 2042`            | `2042-03-01T00:01` … `2042-03-31T23:59`          |
 * | `day`     | `2035-08-01`, `2035-08-01T09:30Z`              | `2035-08-01T00:01` … `2035-08-01T23:59`          |
 * | `time`    | `2034-07-10T08:04Z`                            | collapses to that one minute (min === max)       |
 *
 * A `decade` value is floored to its decade, so `2053` and `2050s` are the same window.
 * A `time` value collapses to `[minute, minute]` rather than to a minute-wide span: the
 * author stated that instant, and rolling a second offset inside it would invent detail
 * the source does not have. That is also the one shape that makes `whenMin === whenMax`,
 * which {@link rollDate} handles as the degenerate case.
 *
 * @throws RangeError on any value the precision cannot read. Guessing would put an event
 *         in the wrong era with nothing to show for it.
 */
export function precisionToInterval(
  precision: WhenPrecision,
  value: string | number,
): [string, string] {
  const raw = String(value).trim();

  switch (precision) {
    case 'decade': {
      // A qualifier NARROWS the window; it does not merely decorate the label.
      // "Early 2050s" that could roll to 2059 would contradict the source text, and the
      // fix needs no new enum member: `when_min`/`when_max` are the primary
      // representation and `when_precision` is a DISPLAY hint (§2.3), so the interval
      // shrinks while the event still renders as "Early 2050s".
      //   early → years 0-3 · mid → 4-6 · late → 7-9 · unqualified → the full ten.
      const parts = raw.split(/[\s\-/]+/).filter(Boolean);
      const qualifier = parts.length > 1 ? parts[0]!.toLowerCase() : undefined;
      const yearText = (parts.length > 1 ? parts[1]! : parts[0]!).replace(/s$/i, '');
      const year = requireInt(yearText, 'decade', raw);
      const start = Math.floor(year / 10) * 10;

      const band = DECADE_BAND[qualifier ?? ''];
      if (qualifier !== undefined && band === undefined) {
        throw new RangeError(
          `precisionToInterval: "${raw}" — unknown decade qualifier "${parts[0]}". ` +
            `Expected one of ${Object.keys(DECADE_BAND).filter(Boolean).join(', ')}, or none.`,
        );
      }
      const [lo, hi] = band ?? [0, 9];
      return span([start + lo, 0, 1], [start + hi, 11, 31]);
    }

    case 'year': {
      const year = requireInt(raw, 'year', raw);
      return span([year, 0, 1], [year, 11, 31]);
    }

    case 'season': {
      // `2035-Q4` | `Q4 2035` | `Late 2035` — a label and a year in either order.
      const parts = raw.split(/[\s\-/]+/).filter(Boolean);
      if (parts.length !== 2) {
        throw new RangeError(`precisionToInterval: "${raw}" is not a "<season> <year>" value`);
      }
      const [a = '', b = ''] = parts;
      const yearText = /^\d{3,}$/.test(a) ? a : b;
      const labelText = yearText === a ? b : a;
      const quarter = SEASON_QUARTER[labelText.toLowerCase()];
      if (quarter === undefined) {
        throw new RangeError(
          `precisionToInterval: "${labelText}" is not a known season; expected one of ` +
            `${Object.keys(SEASON_QUARTER).join(', ')}`,
        );
      }
      const year = requireInt(yearText, 'year', raw);
      const firstMonth = (quarter - 1) * 3;
      const lastMonth = firstMonth + 2;
      return span([year, firstMonth, 1], [year, lastMonth, daysInMonth(year, lastMonth)]);
    }

    case 'month': {
      // `2042-03` | `March 2042` | `Mar 2042`.
      const numeric = /^(\d{3,})-(\d{1,2})$/.exec(raw);
      let year: number;
      let month: number;
      if (numeric) {
        const [, yearText = '', monthText = ''] = numeric;
        year = requireInt(yearText, 'year', raw);
        month = requireInt(monthText, 'month', raw) - 1;
      } else {
        const parts = raw.split(/[\s,]+/).filter(Boolean);
        if (parts.length !== 2) {
          throw new RangeError(`precisionToInterval: "${raw}" is not a "<month> <year>" value`);
        }
        const [a = '', b = ''] = parts;
        const yearText = /^\d{3,}$/.test(a) ? a : b;
        month = parseMonthToken(yearText === a ? b : a, raw);
        year = requireInt(yearText, 'year', raw);
      }
      if (month < 0 || month > 11) {
        throw new RangeError(`precisionToInterval: "${raw}" names no month`);
      }
      return span([year, month, 1], [year, month, daysInMonth(year, month)]);
    }

    case 'day': {
      const ms = parseInstant(raw, 'value', 'precisionToInterval');
      const d = new Date(ms);
      const y = d.getUTCFullYear();
      const m = d.getUTCMonth();
      const day = d.getUTCDate();
      return span([y, m, day], [y, m, day]);
    }

    case 'time': {
      // Collapse to the stated minute. `when_max >= when_min` still holds at equality.
      const minute = toIso(floorToMinute(parseInstant(raw, 'value', 'precisionToInterval')));
      return [minute, minute];
    }

    default: {
      // `precision` is `never` here; the guard catches an unchecked string at runtime.
      throw new RangeError(`precisionToInterval: unknown precision "${String(precision)}"`);
    }
  }
}
