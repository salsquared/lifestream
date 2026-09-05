import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CanonCitationError,
  WEAK_QUOTE_MATCHES,
  formatCitationReport,
  verifyCitations,
} from '@server/seed/citations';
import { CANON_EVENT_CITATIONS } from '@server/seed/events';
import { CANON_REGISTRY_CITATIONS } from '@server/seed/registry';
import { CANON_TIMELINE_CITATIONS } from '@server/seed/timelines';

import type { LocatedCitation } from '@server/seed/citations';

/**
 * P4B.1 — the citation checker matches on the QUOTE, not on the line number.
 *
 * ── THE FAILURE THIS SPEC GUARDS ──────────────────────────────────────────────────────
 * `verifyCitations` used to assert `lines[cite.line - 1]` carried the quote. Run against
 * the 21 June Google Doc original of the Bible — the same document as the repo's exported
 * copy, 28 lines longer — it failed 142 of 142 citations while every single quote was
 * still present and correct. One insertion, counted 142 times, blocking the seed. Its own
 * error message even printed the line each quote had moved to.
 *
 * So the spec's centre of gravity is the first `describe`: insert lines above a citation
 * and the check must still PASS, reporting the moved line as drift. Everything else exists
 * so that "passes" does not quietly become "passes everything":
 *
 *   - **A rewritten quote still fails, by name.** A checker that stops catching drift is
 *     indistinguishable from one that passes, which is the specific way this fix could go
 *     wrong — loosen the match until nothing is ever wrong. Editing the quoted sentence
 *     and deleting it outright are both asserted to fail and to name the row.
 *   - **Ambiguity is reported, not thrown.** A quote matching several lines cannot say
 *     which line a row was read off, but it was already ambiguous before anyone edited the
 *     document; failing the seed for it would punish the wrong commit.
 *   - **Typography still folds.** The source is a pasted Google Doc. Every assertion here
 *     would pass a checker that compared bytes — right up until it met a curly quote — so
 *     the folding is exercised with the marks the real file actually carries.
 *   - **The real 142 against a grown Bible.** The synthetic cases prove the rule; this one
 *     proves the rule solves the reported problem, on the shipped citation set.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** The growth that broke the old checker: the 21 June Bible is 28 lines longer. */
const GROWTH = 28;

// ---------------------------------------------------------------------------
// A synthetic document, small enough that every line number here is readable
// ---------------------------------------------------------------------------

const DOC_LINES = [
  'LIFEstream Bible', // L1
  '', // L2
  'Characters', // L3
  '', // L4
  'Name: Adan Vane', // L5
  'POB: Los Angeles, CA', // L6
  'Bio: He founded the Vane Trust in 2034 and never sat on its board.', // L7
  '', // L8
  'Characters', // L9
  'Characters', // L10
  'Characters', // L11
  'Locations', // L12
];

const DOC = DOC_LINES.join('\n');

/** Lines inserted ABOVE the document — the edit the old checker could not survive. */
const insertAbove = (count: number, lines: readonly string[] = DOC_LINES): string =>
  [...Array.from({ length: count }, (_, i) => `inserted paragraph ${i + 1}`), ...lines].join('\n');

/** The citation under test: a whole clause, unique in `DOC`, standing on L7. */
const cite = (over: Partial<LocatedCitation> = {}): LocatedCitation => ({
  where: 'registry.ts char_adan',
  of: 'bio',
  line: 7,
  quote: 'He founded the Vane Trust in 2034',
  ...over,
});

/** The message of the {@link CanonCitationError} a call throws, or `''` if it does not. */
const failureMessage = (bible: string, citations: readonly LocatedCitation[]): string => {
  try {
    verifyCitations(bible, citations);
    return '';
  } catch (error) {
    expect(error).toBeInstanceOf(CanonCitationError);
    return (error as Error).message;
  }
};

// ---------------------------------------------------------------------------
// The regression: a line inserted above a citation
// ---------------------------------------------------------------------------

describe('lines inserted above a cited quote', () => {
  const grown = insertAbove(GROWTH);

  it('verifies, because the quote is the evidence and the line is only navigation', () => {
    expect(() => verifyCitations(grown, [cite()])).not.toThrow();
  });

  it('reports the stale hint as drift, naming the old line and the new one', () => {
    const report = verifyCitations(grown, [cite()]);

    expect(report.drifted).toEqual([
      { where: 'registry.ts char_adan', of: 'bio', from: 7, to: 7 + GROWTH, matches: 1 },
    ]);
    expect(report.checked).toBe(1);
  });

  it('refreshes the hint by exactly the number of lines inserted, at any depth', () => {
    for (const inserted of [1, 3, GROWTH, 400]) {
      const report = verifyCitations(insertAbove(inserted), [cite()]);
      expect(report.drifted.map((drift) => drift.to)).toEqual([7 + inserted]);
    }
  });

  it('does not report drift for a hint that is still current', () => {
    const report = verifyCitations(DOC, [cite()]);

    expect(report.drifted).toEqual([]);
    expect(report.weak).toEqual([]);
    expect(report.checked).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// What still fails — the half of the fix that is easy to lose
// ---------------------------------------------------------------------------

describe('a quote that is no longer in the document', () => {
  it('fails when the quoted sentence was edited, naming the row and the field', () => {
    const edited = DOC.replace('in 2034', 'in 2036');
    const message = failureMessage(edited, [cite()]);

    expect(message).toContain('registry.ts char_adan');
    expect(message).toContain('bio');
    expect(message).toContain('He founded the Vane Trust in 2034');
  });

  it('fails when the quoted sentence was deleted, and says rewritten rather than moved', () => {
    const deleted = DOC_LINES.filter((_, index) => index !== 6).join('\n');
    const message = failureMessage(deleted, [cite()]);

    expect(message).toContain('rewritten or deleted, not moved');
    expect(message).toContain('registry.ts char_adan');
  });

  it('fails an edit even when the surrounding document also grew', () => {
    const edited = insertAbove(GROWTH, DOC_LINES).replace('the Vane Trust', 'the Pallas Trust');

    expect(() => verifyCitations(edited, [cite()])).toThrow(CanonCitationError);
  });

  it('counts the failures against the whole set, so one bad row does not read as many', () => {
    const deleted = DOC_LINES.filter((_, index) => index !== 6).join('\n');
    const message = failureMessage(deleted, [
      cite(),
      cite({ of: 'the character sheet', line: 3, quote: 'Characters' }),
    ]);

    expect(message).toContain('1 of 2 Bible citation(s)');
  });

  it('fails an empty quote, which asserts nothing whatever about canon', () => {
    expect(failureMessage(DOC, [cite({ quote: '   ' })])).toContain('empty quote');
  });
});

// ---------------------------------------------------------------------------
// Ambiguity — reported, never thrown
// ---------------------------------------------------------------------------

describe('a quote standing on several lines', () => {
  const ambiguous = cite({ of: 'the character sheet', line: 3, quote: 'Characters' });

  it('is reported weak, with every line it stands on', () => {
    const report = verifyCitations(DOC, [ambiguous]);

    expect(report.weak).toEqual([
      {
        where: 'registry.ts char_adan',
        of: 'the character sheet',
        quote: 'Characters',
        matches: [3, 9, 10, 11],
      },
    ]);
  });

  it('does not fail the seed, because it was already weak before the document was edited', () => {
    expect(() => verifyCitations(DOC, [ambiguous])).not.toThrow();
    expect(() => verifyCitations(insertAbove(GROWTH), [ambiguous])).not.toThrow();
  });

  it('marks a refreshed hint as a guess by carrying the match count', () => {
    const report = verifyCitations(insertAbove(GROWTH), [ambiguous]);

    expect(report.drifted).toEqual([
      {
        where: 'registry.ts char_adan',
        of: 'the character sheet',
        from: 3,
        to: 3 + GROWTH,
        matches: 4,
      },
    ]);
  });

  it('leaves a unique quote out of the weak list', () => {
    expect(WEAK_QUOTE_MATCHES).toBeGreaterThan(1);
    expect(verifyCitations(DOC, [cite()]).weak).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A hint that points past the end of the file
// ---------------------------------------------------------------------------

describe('a line hint outside the document', () => {
  it('is drift, not a failure, when the quote is still there', () => {
    const report = verifyCitations(DOC, [cite({ line: 9_000 })]);

    expect(report.drifted).toEqual([
      { where: 'registry.ts char_adan', of: 'bio', from: 9_000, to: 7, matches: 1 },
    ]);
  });

  it('says so plainly when the quote is gone, rather than printing an undefined line', () => {
    const deleted = DOC_LINES.filter((_, index) => index !== 6).join('\n');
    const message = failureMessage(deleted, [cite({ line: 9_000 })]);

    expect(message).toContain('past the end of the file');
    expect(message).toContain(`${DOC_LINES.length - 1} lines`);
    expect(message).not.toContain('undefined');
  });
});

// ---------------------------------------------------------------------------
// Typography — the source is a pasted Google Doc
// ---------------------------------------------------------------------------

describe('typography folding', () => {
  /** Every mark the real file carries: zero-width space, curly quotes, dashes, NBSP. */
  const PASTED = [
    'World Timeline',
    '\u200bThe \u201cBig One\u201d \u2013 a 9.2\u00a0magnitude quake \u2014 ENDS the era.',
  ].join('\r\n');

  const typographic = (quote: string): LocatedCitation => ({
    where: 'events.ts evt_big_one',
    of: 'description',
    line: 2,
    quote,
  });

  it('matches a plainly typed quote against curly quotes, dashes, NBSP and zero-width marks', () => {
    const report = verifyCitations(PASTED, [
      typographic('the "Big One" - a 9.2 magnitude quake - ends the era.'),
    ]);

    expect(report.drifted).toEqual([]);
    expect(report.checked).toBe(1);
  });

  it('matches in the other direction too, when the row was pasted rather than typed', () => {
    const plain = 'World Timeline\nThe "Big One" - a 9.2 magnitude quake - ends the era.';

    expect(() =>
      verifyCitations(plain, [typographic('The “Big One” – a 9.2 magnitude')]),
    ).not.toThrow();
  });

  it('folds case and runs of whitespace, which a transcriber cannot see either', () => {
    expect(() => verifyCitations(PASTED, [typographic('a   9.2 magnitude   quake')])).not.toThrow();
  });

  it('still fails a real edit hiding behind the folding', () => {
    expect(() => verifyCitations(PASTED, [typographic('a 9.3 magnitude quake')])).toThrow(
      CanonCitationError,
    );
  });
});

// ---------------------------------------------------------------------------
// The report the seed prints
// ---------------------------------------------------------------------------

describe('the citation report', () => {
  it('says so when every hint is current, rather than passing in silence', () => {
    const lines = formatCitationReport(verifyCitations(DOC, [cite()]));

    expect(lines.join('\n')).toContain('every line hint is current');
  });

  it('prints each stale hint as the substitution the author has to make', () => {
    const lines = formatCitationReport(verifyCitations(insertAbove(GROWTH), [cite()]));

    expect(lines.join('\n')).toContain('registry.ts char_adan bio: L7 -> L35');
  });

  it('prints weak quotes with their match count', () => {
    const ambiguous = cite({ of: 'the character sheet', line: 3, quote: 'Characters' });
    const lines = formatCitationReport(verifyCitations(DOC, [ambiguous]));

    expect(lines.join('\n')).toContain('"Characters" is on 4 lines');
  });
});

// ---------------------------------------------------------------------------
// The proof: the shipped citation set against a grown Bible
// ---------------------------------------------------------------------------

describe('the shipped citations against the real Bible', () => {
  const BIBLE = readFileSync(
    path.join(repoRoot, 'data', 'story_docs', 'LIFEstream Bible.txt'),
    'utf8',
  );

  /** Assembled exactly as `readSeedInputs` assembles it (`inputs.ts`, P3 review F5). */
  const REAL: readonly LocatedCitation[] = [
    ...CANON_REGISTRY_CITATIONS,
    ...CANON_EVENT_CITATIONS,
    ...CANON_TIMELINE_CITATIONS,
  ];

  it('verifies against the repo copy with every line hint current', () => {
    const report = verifyCitations(BIBLE, REAL);

    expect(report.checked).toBe(REAL.length);
    expect(report.drifted).toEqual([]);
  });

  it('verifies against a Bible that has grown 28 lines — the run that used to fail 142/142', () => {
    const grown = insertAbove(GROWTH, BIBLE.split(/\r?\n/));
    const report = verifyCitations(grown, REAL);

    // Every hint is stale, which is precisely the set the old checker threw on.
    expect(report.checked).toBe(REAL.length);
    expect(report.drifted).toHaveLength(REAL.length);
  });

  it('refreshes every unique quote to exactly the right new line', () => {
    const grown = insertAbove(GROWTH, BIBLE.split(/\r?\n/));
    const unique = verifyCitations(grown, REAL).drifted.filter((drift) => drift.matches === 1);

    // The bulk of the corpus, so "every unique one is exact" is a claim with weight.
    expect(unique.length).toBeGreaterThan(100);
    expect(unique.filter((drift) => drift.to !== drift.from + GROWTH)).toEqual([]);
  });

  it('flags the same weak quotes either way, on a corpus that has some', () => {
    const grown = insertAbove(GROWTH, BIBLE.split(/\r?\n/));
    const key = (entry: { where: string; of: string }): string => `${entry.where} ${entry.of}`;

    // Weakness is a property of the quote, not of the edit: growing the file cannot
    // change which citations fail to locate themselves.
    expect(verifyCitations(grown, REAL).weak.map(key)).toEqual(
      verifyCitations(BIBLE, REAL).weak.map(key),
    );

    // Both of those are EMPTY since P4B.4 (see below), and two empty lists agree for
    // reasons that have nothing to do with the invariant. So the claim is made where it
    // can fail: the synthetic corpus, whose "Characters" quote stands on four lines.
    const mixed = [cite(), cite({ of: 'the character sheet', line: 3, quote: 'Characters' })];
    expect(verifyCitations(insertAbove(GROWTH), mixed).weak.map(key)).toEqual(
      verifyCitations(DOC, mixed).weak.map(key),
    );
    expect(verifyCitations(DOC, mixed).weak.length).toBeGreaterThan(0);
  });

  it('has no weak quote left at all — P4B.4 strengthened the 38 it had', () => {
    // The inherited 38 were the debt `WEAK_QUOTE_MATCHES` was made advisory FOR: they were
    // weak before the Bible was ever edited, so failing the seed on them would have
    // punished the sync rather than the commit that wrote them. They are paid off, and
    // this is what keeps the next authored row from quietly re-opening the account —
    // nothing else fails when a citation quotes a bare label.
    expect(verifyCitations(BIBLE, REAL).weak).toEqual([]);
  });
});
