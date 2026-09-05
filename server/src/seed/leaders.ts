/**
 * The union leader — the one authored fact in the map import that the map export cannot
 * supply (P1.11.2, architecture §2.4).
 *
 * `data/map_saves/*.json` has no leader field whatsoever: 0 of 103 groups carry one. Canon
 * marks a leader on ten of the unions, written `… (Leader)` in the National Consolidation
 * section of `data/story_docs/LIFEstream Bible.txt`. An importer that reads only the map
 * export writes `is_leader = 0` everywhere and drops the fact silently, so the Bible is
 * parsed here and the markers are checked against an explicit table.
 *
 * TWO HALVES, on purpose:
 *
 *   · {@link readBibleLeaderMarkers} parses the file. It is the check, not the source —
 *     if canon gains, loses or renames a marker the seed fails instead of quietly writing
 *     a different number of leader rows.
 *   · {@link BIBLE_UNION_LEADERS} is the authored table. It carries the one thing the
 *     Bible cannot: the alpha-3 code behind a prose country name. Ten entries, matching
 *     the ten markers one for one.
 *
 * ── THE TENTH MARKER HAS NOWHERE TO GO ────────────────────────────────────────────────
 * Nine of the ten name a country that is a member of a union in the authored map save, and
 * those nine are written. The tenth — `Unified Korea` / `North & South Korea (Leader)` —
 * cannot be, for two independent reasons, and BOTH would have to be resolved by the author:
 *
 *   1. `Unified Korea` does not exist in `lifestream_map_v1.json`. The authored map is a
 *      later revision of canon (it also moves Bangladesh into Greater India, which the
 *      Bible lists as remaining independent), and in it North and South Korea are members
 *      of `East Asian Alliance` alongside Japan, Taiwan and the Philippines — a grouping
 *      the Bible never names and for which canon states no leader.
 *   2. `North & South Korea` is not one country. It resolves to two codes, `PRK` and
 *      `KOR`, and `grouping_country_leader_unique` allows exactly one leader per grouping,
 *      so there is no way to write both and no basis in canon for picking one.
 *
 * So the entry is present, `alpha3` is `null`, and the reason travels with it. The seed
 * reports it every run rather than rounding 9 up to 10 in a comment.
 */

/** One `(Leader)` marker as it appears in the Bible. */
export interface BibleLeaderMarker {
  /** 1-based line number, for the log. */
  line: number;
  /** The `* <Union>` bullet the marker sits under. */
  union: string;
  /** The country name the marker is attached to, verbatim. */
  leaderName: string;
}

/** An authored table row: a marker plus the country code the prose name stands for. */
export interface BibleUnionLeader {
  /** Matches {@link BibleLeaderMarker.union} exactly. */
  union: string;
  /** Matches {@link BibleLeaderMarker.leaderName} exactly. */
  leaderName: string;
  /** The alpha-3 the map saves key on, or `null` when the name does not name one country. */
  alpha3: string | null;
  /** Why `alpha3` is null. Present iff `alpha3` is null. */
  unresolvable?: string;
}

/**
 * The ten markers, with their codes. Order follows the Bible.
 *
 * The union names are canon's, NOT the map export's — two of them differ, because the
 * authored map renamed the union after the Bible was written (`Estados Unidos de America
 * Central` → `Estados Unidos de Central America`, `New Pakistan` → `Pakistan`). That is
 * exactly why a leader is located by its COUNTRY's membership below and never by matching
 * union names: the name is the half that drifted, the membership is not.
 */
export const BIBLE_UNION_LEADERS: readonly BibleUnionLeader[] = [
  { union: 'Estados Unidos de America Central', leaderName: 'Panama', alpha3: 'PAN' },
  { union: 'Nueva Colombia', leaderName: 'Colombia', alpha3: 'COL' },
  { union: 'Argentina', leaderName: 'Argentina', alpha3: 'ARG' },
  { union: 'New Turkey', leaderName: 'Turkey', alpha3: 'TUR' },
  { union: 'New Pakistan', leaderName: 'Pakistan', alpha3: 'PAK' },
  { union: 'Greater India', leaderName: 'India', alpha3: 'IND' },
  { union: 'Greater Indo-China', leaderName: 'Vietnam', alpha3: 'VNM' },
  { union: 'Greater China', leaderName: 'China', alpha3: 'CHN' },
  {
    union: 'Unified Korea',
    leaderName: 'North & South Korea',
    // AUTHORED DECISION (2026-09-04). Canon's marker names two countries for a union that
    // does not exist in the authored map: `Unified Korea` was superseded by the five-member
    // `East Asian Alliance` (JPN, KOR, PRK, PHL, TWN), which the Bible never names.
    //
    // The author's ruling is that the alliance HAS a leader, and it is South Korea. The
    // choice is canon-internal rather than arbitrary: the tier system that governs this
    // whole stage ranks nations by GDP (Bible L234-236), and of the two Koreas only the
    // South is a major economy — so it is the member that would plausibly lead under
    // canon's own logic.
    //
    // Reversible in one line: change this code to 'JPN' or 'TWN' and re-run the seed.
    alpha3: 'KOR',
  },
  { union: 'New Indonesia', leaderName: 'Indonesia', alpha3: 'IDN' },
];

/** A `* <Union>` bullet: one asterisk at the start of the line, an optional trailing colon. */
const UNION_HEADER = /^\*[ \t]+(.+?):?[ \t]*$/;

/**
 * A `(Leader)` marker and the name in front of it. The name stops at `,`, `:` or `*` so it
 * picks up `Panama` out of `… Costa Rica, Panama (Leader), Cuba …` and `North & South
 * Korea` out of `* Countries: North & South Korea (Leader)`.
 */
const LEADER_MARKER = /([^,:*\n]+?)[ \t]*\(Leader\)/g;

/** Every `(Leader)` marker in the Bible, in document order. */
export function readBibleLeaderMarkers(bibleText: string): BibleLeaderMarker[] {
  const markers: BibleLeaderMarker[] = [];
  let union = '';

  bibleText.split(/\r?\n/).forEach((line, index) => {
    const header = UNION_HEADER.exec(line);
    if (header?.[1] !== undefined) {
      union = header[1].trim();
      return;
    }
    for (const match of line.matchAll(LEADER_MARKER)) {
      const leaderName = match[1]?.trim();
      if (leaderName !== undefined && leaderName !== '') {
        markers.push({ line: index + 1, union, leaderName });
      }
    }
  });

  return markers;
}

/** `union — leaderName`, the key the table and the parsed markers are compared on. */
const markerKey = (entry: { union: string; leaderName: string }): string =>
  `${entry.union} — ${entry.leaderName}`;

/**
 * Assert that {@link BIBLE_UNION_LEADERS} still describes the Bible, and return the table
 * with the line each entry was found on.
 *
 * This is the "assert exactly 10" gate. A marker canon adds, drops or rewords fails here,
 * naming the difference, rather than turning into a silently different number of
 * `is_leader = 1` rows — which is the shape this bug takes when nothing checks: a count
 * nobody looks at.
 *
 * @throws if the parsed marker set is not exactly the table's.
 */
export function resolveBibleLeaders(bibleText: string): (BibleUnionLeader & { line: number })[] {
  const markers = readBibleLeaderMarkers(bibleText);
  const found = new Map(markers.map((marker) => [markerKey(marker), marker]));

  const missing = BIBLE_UNION_LEADERS.filter((entry) => !found.has(markerKey(entry)));
  const expected = new Set(BIBLE_UNION_LEADERS.map(markerKey));
  const unexpected = markers.filter((marker) => !expected.has(markerKey(marker)));

  if (
    missing.length > 0 ||
    unexpected.length > 0 ||
    markers.length !== BIBLE_UNION_LEADERS.length
  ) {
    const detail = [
      `expected ${BIBLE_UNION_LEADERS.length} (Leader) markers, parsed ${markers.length}`,
      ...missing.map((entry) => `  in the table but not in the Bible: ${markerKey(entry)}`),
      ...unexpected.map((m) => `  in the Bible but not in the table: L${m.line} ${markerKey(m)}`),
    ].join('\n');
    throw new Error(
      `seed: the union-leader table no longer matches data/story_docs/LIFEstream Bible.txt.\n` +
        `${detail}\n` +
        `  the map export has no leader field, so the Bible is the only source there is — ` +
        `update BIBLE_UNION_LEADERS in server/src/seed/leaders.ts deliberately.`,
    );
  }

  return BIBLE_UNION_LEADERS.map((entry) => ({
    ...entry,
    // Non-null by construction: `missing` is empty, so every entry has a marker.
    line: found.get(markerKey(entry))?.line ?? 0,
  }));
}
