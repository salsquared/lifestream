import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// @ts-expect-error — plain ESM with JSDoc types, deliberately not a TS module: P5 runs it
// as a seeding gate (`node scripts/fontCoverage.mjs`) and it must not need a build step.
import { formatCodepoint, readCoveredCodepoints, uncovered } from '../scripts/fontCoverage.mjs';

import { CORRIDOR_FIXTURE } from '@client/views/timeline/fixture';
import { formatWhen } from '@shared/formatWhen';

/**
 * P4 review, major finding 5 — the vendored label font must cover every glyph the
 * corridor draws.
 *
 * ── WHY THIS SPEC EXISTS ─────────────────────────────────────────────────────────────
 * `client/public/fonts/Sora-SemiBold.ttf` was vendored so drei's `<Text>` stops fetching
 * a face from jsdelivr. That closed one network dependency and left a second one open,
 * and the second one is worse.
 *
 * troika bundles `@unicode-font-resolver/client` and calls `getFontsForString()` for any
 * codepoint **the supplied font does not cover**, against a hardcoded jsdelivr URL.
 * `resolveFallbacks()` has no `.catch`. So offline, one uncovered codepoint means: the
 * promise rejects, `allDone()` never fires, and **the entire label fails to render** —
 * not the missing glyph, the whole line — plus an unhandled rejection. Pointing
 * `unicodeFontsURL` at a local copy does not disable the path; it falls back to the CDN.
 *
 * The consequence is a silent, per-label blanking triggered by a single character. The
 * review parsed the cmap and found **378 codepoints**, Google's latin subset — enough for
 * today's corpus and for the punctuation P5 is likely to produce, and short of `→`
 * (U+2192) or any symbol or CJK. One arrow in one of P5's 68 titles blanks that node's
 * label and nothing reports it.
 *
 * So four things are asserted:
 *
 *   a. the coverage set has not SHRUNK — re-vendoring a smaller subset fails loudly here
 *      rather than in a reader's offline session;
 *   b. every codepoint the corridor draws today is covered — both the `title` and the
 *      `formatWhen(event)` date line, which are the two strings `EventNode` renders;
 *   c. the punctuation P5 will plausibly emit is covered, named explicitly, so the gate
 *      is forward-looking rather than a restatement of the current fixture;
 *   d. the guard actually DETECTS a gap. A coverage checker that returned an empty array
 *      for everything would satisfy (b) and (c) perfectly, so (d) is what makes them mean
 *      anything.
 *
 * The reader is `scripts/fontCoverage.mjs`, a script rather than a helper because P5
 * needs to run it over the seeded database as a gate.
 */

const FONT = fileURLToPath(new URL('../client/public/fonts/Sora-SemiBold.ttf', import.meta.url));

const covered: Set<number> = readCoveredCodepoints(FONT);

/** Renders a missing-codepoint list into something a failure message can be read from. */
const describeMissing = (missing: number[]): string =>
  missing.map((cp: number) => formatCodepoint(cp)).join(', ');

// ---------------------------------------------------------------------------
// (a) The coverage set has not shrunk
// ---------------------------------------------------------------------------

describe('the vendored face still covers what it was vendored for', () => {
  it('parses as a real font with a real cmap', () => {
    // If the parser silently returned an empty set, every other test in this file would
    // fail — but it is worth failing on the cause rather than on 378 symptoms.
    expect(covered.size).toBeGreaterThan(0);
    expect(covered.has(0x41)).toBe(true); // 'A'
    expect(covered.has(0x20)).toBe(true); // space
  });

  it('covers at least the 378 codepoints the review measured', () => {
    // The lower bound, not an equality: re-vendoring a FULLER face is the fix for an
    // uncovered codepoint and must not fail this. Re-vendoring a smaller subset — the
    // easy mistake, since Google's font API hands out whatever subset the request asked
    // for — is what this catches.
    expect(
      covered.size,
      `the vendored font now covers ${covered.size} codepoints`,
    ).toBeGreaterThanOrEqual(378);
  });

  it('covers the whole of printable ASCII, without which nothing renders', () => {
    const missing: number[] = [];
    for (let cp = 0x20; cp <= 0x7e; cp++) if (!covered.has(cp)) missing.push(cp);
    expect(missing, `missing ASCII: ${describeMissing(missing)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (b) Everything the corridor draws today
// ---------------------------------------------------------------------------

describe('every string the corridor draws today is fully covered', () => {
  it('covers every codepoint of every fixture TITLE', () => {
    // The title is the label's main line. `Lazaro Castañeda` (U+00F1) and `Top
    // Ridge–Bottom Ridge` (an EN DASH, U+2013 — not a hyphen) are the two that already
    // reach past ASCII, and either would blank its whole label if the subset moved.
    for (const event of CORRIDOR_FIXTURE) {
      const missing = uncovered(event.title, covered);
      expect(
        missing,
        `${event.id}: ${describeMissing(missing)} in ${JSON.stringify(event.title)}`,
      ).toEqual([]);
    }
  });

  it('covers every codepoint of every fixture DATE LINE', () => {
    // The label's second line, and a different source of characters: `formatWhen` emits
    // month names and a `Q2`/`Early`/`Mid`/`Late` vocabulary rather than author text.
    for (const event of CORRIDOR_FIXTURE) {
      const rendered = formatWhen(event);
      const missing = uncovered(rendered, covered);
      expect(
        missing,
        `${event.id}: ${describeMissing(missing)} in ${JSON.stringify(rendered)}`,
      ).toEqual([]);
    }
  });

  it('actually looked at a non-ASCII title, so this is not a vacuous pass', () => {
    // Guards the guard: if the fixture were ever regenerated into pure ASCII these tests
    // would keep passing while proving much less.
    const beyondAscii = CORRIDOR_FIXTURE.flatMap((event) =>
      [...event.title].map((ch) => ch.codePointAt(0)!).filter((cp) => cp > 0x7f),
    );
    expect(beyondAscii.length).toBeGreaterThan(0);
    expect(beyondAscii).toContain(0x00f1); // ñ in "Lazaro Castañeda"
    expect(beyondAscii).toContain(0x2013); // – in "Top Ridge–Bottom Ridge"
  });
});

// ---------------------------------------------------------------------------
// (c) What P5 will plausibly emit
// ---------------------------------------------------------------------------

describe('the punctuation P5 is likely to produce is already covered', () => {
  /**
   * Named rather than derived. P5 seeds 68 bullets of prose written in a word processor,
   * so smart quotes, dashes and Spanish diacritics arrive whether or not anyone intends
   * them — and the corpus is full of Spanish names (Castañeda, Cárdenas, Lázaro).
   */
  const EXPECTED: ReadonlyArray<readonly [string, string]> = [
    ['em dash', '—'],
    ['en dash', '–'],
    ['ellipsis', '…'],
    ['right single quote / apostrophe', '’'],
    ['left single quote', '‘'],
    ['left double quote', '“'],
    ['right double quote', '”'],
    ['straight apostrophe', "'"],
    ['straight double quote', '"'],
    ['degree sign', '°'],
    ['middle dot', '·'],
    ['multiplication sign', '×'],
    ['n with tilde', 'ñ'],
    ['e acute', 'é'],
    ['i acute', 'í'],
    ['a acute', 'á'],
    ['o acute', 'ó'],
    ['u acute', 'ú'],
    ['u diaeresis', 'ü'],
    ['c cedilla', 'ç'],
  ];

  it.each(EXPECTED)('covers the %s (%s)', (_name, glyph) => {
    const cp = glyph.codePointAt(0)!;
    expect(covered.has(cp), `${formatCodepoint(cp)} is not in the vendored subset`).toBe(true);
  });

  it('covers the uppercase and inverted-punctuation forms Spanish prose brings with them', () => {
    for (const glyph of ['Ñ', 'Á', 'É', 'Í', 'Ó', 'Ú', 'Ü', '¿', '¡']) {
      const cp = glyph.codePointAt(0)!;
      expect(covered.has(cp), `${formatCodepoint(cp)} (${glyph})`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// (d) The guard detects a real gap
// ---------------------------------------------------------------------------

describe('the guard actually detects an uncovered codepoint', () => {
  it('reports the rightwards arrow, the review’s own example', () => {
    // Without this the three describes above prove nothing: a checker that reported
    // everything as covered would pass all of them.
    expect(covered.has(0x2192)).toBe(false);
    expect(uncovered('→', covered)).toEqual([0x2192]);
  });

  it('reports the arrow embedded in a realistic P5-shaped title', () => {
    // The failure mode is not "an arrow does not draw" — it is that this ENTIRE title
    // renders as nothing, offline, silently.
    const title = 'COP Isotope → FOB Oasis';
    expect(uncovered(title, covered)).toEqual([0x2192]);
  });

  it('reports CJK and emoji, which no latin subset will ever carry', () => {
    expect(uncovered('一', covered)).toEqual([0x4e00]);
    // Astral plane: iterated by codepoint, so this is ONE missing codepoint, not two
    // lone surrogates — which is what troika will ask the resolver about.
    expect(uncovered('🙂', covered)).toEqual([0x1f642]);
  });

  it('deduplicates and preserves first-appearance order', () => {
    expect(uncovered('→ 一 → 一', covered)).toEqual([0x2192, 0x4e00]);
  });

  it('returns an empty array for text that is entirely covered', () => {
    expect(uncovered('Megablock 1 is completed', covered)).toEqual([]);
    expect(uncovered('', covered)).toEqual([]);
  });

  it('reports a NEWLINE as uncovered — a real hazard for a multi-line P5 title', () => {
    // Not a parser quirk: the face genuinely has no U+000A mapping (it does map U+000D).
    // Recorded because a title pasted out of a document with a hard line break inside it
    // would be reported here as a gap, and P5's gate should treat that as "strip the
    // break", not as "re-vendor the font".
    expect(uncovered('\n', covered)).toEqual([0x0a]);
  });
});

// ---------------------------------------------------------------------------
// The reader itself
// ---------------------------------------------------------------------------

describe('readCoveredCodepoints', () => {
  it('refuses a file that is not an sfnt font, rather than reporting zero coverage', () => {
    // A WOFF2 or a truncated download must fail loudly. Silently returning an empty set
    // would make the corpus checks above fail with 68 confusing messages instead of one
    // clear one — and, worse, a `> 0` guard elsewhere would read it as "nothing covered".
    const notAFont = fileURLToPath(new URL('./fontCoverage.test.ts', import.meta.url));
    expect(() => readCoveredCodepoints(notAFont)).toThrow(/not an sfnt font/);
  });

  it('formats a codepoint the way a failure message needs to read', () => {
    expect(formatCodepoint(0x2192)).toBe('U+2192 →');
    expect(formatCodepoint(0x41)).toBe('U+0041 A');
    // Control characters print no glyph — a raw newline in a message would break the line.
    expect(formatCodepoint(0x0a)).toBe('U+000A');
  });
});
