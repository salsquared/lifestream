/**
 * Render an event's date **at the precision the author actually stated** — architecture
 * §2.3, implementation P4.7.
 *
 * ## Why this module exists at all
 *
 * `event.when` is a *roll*: a seeded point picked inside `[when_min, when_max]` so that
 * a node has somewhere to sit (`rollDate.ts`). It is layout data, not canon. Printing it
 * for a year-precision bullet — "13 August 2034" for a source that said "2034" — states
 * a fact the Bible never gave, and does it in the reader's face, on the node label. That
 * is the exact failure the fuzzy-date model was adopted to prevent, and it is why the
 * `when_precision` column exists.
 *
 * So: **this function reads `when_precision` and `when_min`. It never reads `when`.**
 * `when` is in the parameter type only because callers hand over the whole event and the
 * P4 interface contract pins the shape; the value is deliberately unused, and the spec
 * asserts that changing it cannot change the output.
 *
 * One implementation, because there are four consumers — node labels (P4.3.4), the
 * detail panel, the HUD (P4.6) and every export builder (§8) — and four copies of a
 * date formatter is four chances for one of them to print the roll.
 *
 * ## Vocabulary
 *
 * The labels are the ones `precisionToInterval` in `rollDate.ts` already *parses*, so a
 * rendered label reads back as the same window rather than as a second dialect. The spec
 * pins that as a round-trip for `decade`, `year`, `season` and `month`; `day` and `time`
 * render as human prose, which is not an input form.
 *
 * No `node:*` and no DOM.
 */

import type { IsoInstant, WhenPrecision } from './types/enums.js';
import type { EventRow } from './types/entities.js';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

const MONTH_NAMES: readonly string[] = [
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

/**
 * Quarter → season label.
 *
 * Q1/Q3/Q4 are `precisionToInterval`'s own `early` / `mid` / `late` members, and Q4 →
 * "Late" is pinned by the docs directly ("Late 2035 becomes a Q4 window", §2.3).
 *
 * **Q2 has no word in that vocabulary** — `early`, `mid` and `late` cover Q1, Q3 and Q4
 * and stop. Rather than invent a fourth qualifier or slip into the parallel
 * winter/spring/summer/autumn family (which would render Q4 as "Autumn 2035" and
 * contradict the pinned example), Q2 renders as the literal quarter `Q2`, which that
 * same table also accepts. It reads as a position, asserts no hemisphere or climate the
 * source never gave, and round-trips like the other three.
 */
const SEASON_LABEL: Readonly<Record<1 | 2 | 3 | 4, string>> = {
  1: 'Early',
  2: 'Q2',
  3: 'Mid',
  4: 'Late',
};

/**
 * Decade band → qualifier, keyed by `[firstYear - decadeStart, lastYear - decadeStart]`.
 *
 * The same three bands `precisionToInterval`'s `DECADE_BAND` narrows a decade window
 * with — early 0–3, mid 4–6, late 7–9 — read in the opposite direction. A window that
 * matches none of them (an author widened it by hand, or it straddles two decades)
 * renders the bare decade rather than the nearest qualifier: an unqualified "2050s" is
 * true of any window inside the decade, where a guessed "Mid" would not be.
 */
const DECADE_QUALIFIER: ReadonlyArray<readonly [number, number, string]> = [
  [0, 3, 'Early'],
  [4, 6, 'Mid'],
  [7, 9, 'Late'],
];

/** Exactly the canonical instant spelling the schema's `GLOB` CHECK enforces (§2.1). */
const CANONICAL_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;

// ---------------------------------------------------------------------------
// Field extraction
// ---------------------------------------------------------------------------

/** The calendar fields of a canonical instant. `month` is 1-based. */
interface InstantFields {
  year: number;
  month: number;
  day: number;
  hour: string;
  minute: string;
}

/**
 * Read the calendar fields straight off the canonical string.
 *
 * Deliberately no `Date`: every field this module prints is already spelled out in the
 * TEXT column, and going through `Date` would introduce a timezone and a parse where
 * neither is needed. It also means a malformed value fails here, loudly, rather than
 * becoming `NaN` and rendering as "NaN undefined NaN".
 *
 * @throws RangeError if `value` is not the canonical spelling. Every row that reaches
 *         this function came through a column whose CHECK already pins that shape, so a
 *         failure here is a bug upstream and guessing at it would put a fabricated date
 *         on a node — the one outcome this module exists to prevent.
 */
function fieldsOf(value: IsoInstant, label: string): InstantFields {
  const parts = CANONICAL_INSTANT.exec(value);
  if (!parts) {
    throw new RangeError(
      `formatWhen: ${label} is not a canonical instant ` +
        `(YYYY-MM-DDTHH:MM:SS.mmmZ): ${JSON.stringify(value)}`,
    );
  }
  const [, year = '', month = '', day = '', hour = '', minute = ''] = parts;
  const monthNumber = Number(month);
  if (monthNumber < 1 || monthNumber > 12) {
    throw new RangeError(`formatWhen: ${label} names no month: ${value}`);
  }
  return {
    year: Number(year),
    month: monthNumber,
    day: Number(day),
    hour,
    minute,
  };
}

/** `1` → `January`. The bounds check in {@link fieldsOf} is what makes this total. */
function monthName(month: number): string {
  return MONTH_NAMES[month - 1] ?? String(month);
}

// ---------------------------------------------------------------------------
// formatWhen
// ---------------------------------------------------------------------------

/**
 * The event fields this function is allowed to see.
 *
 * `when` is part of the contract's shape and is **never read** — see the module header.
 * Written as a `Pick` of {@link EventRow} rather than a fresh interface so a schema
 * change to any of the four columns lands here rather than drifting.
 */
export type FormattableEvent = Pick<EventRow, 'when' | 'whenMin' | 'whenMax' | 'whenPrecision'>;

/**
 * Render an event's date as the source stated it.
 *
 * | `whenPrecision` | renders                  | reads back through `precisionToInterval` |
 * | --------------- | ------------------------ | ---------------------------------------- |
 * | `decade`        | `Early 2050s`, `2050s`   | yes                                      |
 * | `year`          | `2036`                   | yes                                      |
 * | `season`        | `Late 2035`, `Q2 2047`   | yes                                      |
 * | `month`         | `March 2042`             | yes                                      |
 * | `day`           | `13 August 2034`         | no — prose, not an input form            |
 * | `time`          | `10 July 2034, 08:04 UTC`| no — prose, not an input form            |
 *
 * Only `time` shows a clock. Seconds are never shown: `precisionToInterval` collapses a
 * `time` value to its minute, so a seconds field could only ever print `00` and would
 * imply a resolution the corpus does not have.
 *
 * `whenMin` supplies every field except the decade band, which needs `whenMax` too. That
 * is consistent with §2.3's model — the window is primary, the precision is the display
 * hint that says how much of it to show — and it is what keeps `when` out of the render
 * path entirely.
 *
 * @throws RangeError if the instants it reads are not canonical, or if `whenPrecision`
 *         is not a member of the closed enum.
 */
export function formatWhen(event: FormattableEvent): string {
  const min = fieldsOf(event.whenMin, 'whenMin');

  switch (event.whenPrecision) {
    case 'decade': {
      const max = fieldsOf(event.whenMax, 'whenMax');
      const decadeStart = Math.floor(min.year / 10) * 10;
      const lo = min.year - decadeStart;
      const hi = max.year - decadeStart;
      const band = DECADE_QUALIFIER.find(([first, last]) => first === lo && last === hi);
      return band ? `${band[2]} ${decadeStart}s` : `${decadeStart}s`;
    }

    case 'year':
      return String(min.year);

    case 'season': {
      const quarter = (Math.floor((min.month - 1) / 3) + 1) as 1 | 2 | 3 | 4;
      return `${SEASON_LABEL[quarter]} ${min.year}`;
    }

    case 'month':
      return `${monthName(min.month)} ${min.year}`;

    case 'day':
      return `${min.day} ${monthName(min.month)} ${min.year}`;

    case 'time':
      return `${min.day} ${monthName(min.month)} ${min.year}, ${min.hour}:${min.minute} UTC`;

    default: {
      // `whenPrecision` is `never` here; the guard catches an unchecked string at
      // runtime — a row whose precision came from somewhere the CHECK does not cover.
      const unchecked: WhenPrecision = event.whenPrecision;
      throw new RangeError(`formatWhen: unknown when_precision "${String(unchecked)}"`);
    }
  }
}
