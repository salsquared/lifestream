/**
 * Citations — the `// L<n>` affordance, made real (P3 review F5).
 *
 * The seed modules promise that every authored row "carries a `L<n>` marker naming the
 * line it was read off, so a later reader can check a row against canon without
 * re-deriving it". On an honour system that promise decays: a review of P3 found about
 * twenty-five of the registry's markers wrong — the glossary block consistently off by
 * 14-17 lines — and a wrong citation is worse than none, because it sends the checker to
 * a line that says something else and looks like a transcription error in the row.
 *
 * So a citation is DATA, not a comment: `{ of, line, quote }` on the row itself, and this
 * module asserts that the cited line really does contain the quoted text before the seed
 * writes anything. A line that moves fails by name and the error says where the quote
 * actually is now, which is what makes the correction mechanical instead of archaeological.
 *
 * P5 writes sixty-eight more of these. That is the reason the check exists rather than a
 * second careful proof-read.
 *
 * ── WHAT IS COMPARED ──────────────────────────────────────────────────────────────────
 * The Bible is a pasted Google Doc: it carries curly quotes, non-breaking spaces,
 * zero-width spaces (L77 and L78 both begin with one), en dashes where a keyboard types a
 * hyphen, and runs of whitespace that mean nothing. {@link normaliseCanonText} folds all
 * of that away, so the check catches a line that MOVED or was REWRITTEN and never trips on
 * typography a transcriber cannot see. Case is folded for the same reason.
 */

/** One claim about the Bible, attached to the row that makes it. */
export interface Citation {
  /** What in the row this line supports — a field name, or a short phrase for prose. */
  of: string;
  /** 1-based line number in `data/story_docs/LIFEstream Bible.txt`. */
  line: number;
  /** Text that MUST appear on that line, compared under {@link normaliseCanonText}. */
  quote: string;
}

/** A {@link Citation} plus the row that made it — what the checker reports on. */
export interface LocatedCitation extends Citation {
  /** `registry.ts CANON_CHARACTERS char_lazaro`, or any other locator a reader can follow. */
  where: string;
}

/** A citation that no longer describes the Bible. Thrown before anything is written. */
export class CanonCitationError extends Error {
  override name = 'CanonCitationError';
}

/** Zero-width and byte-order marks the pasted source carries invisibly. */
const INVISIBLE = /[\u200b-\u200d\ufeff]/g;

/**
 * Fold away everything about the source's typography that a transcriber cannot see or
 * reproduce: curly quotes, dash variants, non-breaking spaces, runs of whitespace, case.
 */
export function normaliseCanonText(value: string): string {
  return value
    .normalize('NFC')
    .replace(INVISIBLE, '')
    .replace(/[\u2018\u2019\u201b]/g, "'")
    .replace(/[\u201c\u201d\u201f]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Attach a locator to every citation a row makes. */
export const locate = (where: string, cites: readonly Citation[] | undefined): LocatedCitation[] =>
  (cites ?? []).map((cite) => ({ where, ...cite }));

/** At most this many "the quote is actually here" hints per failing citation. */
const MAX_HINTS = 4;

/** How much of the cited line the error prints back. */
const EXCERPT = 90;

const excerpt = (line: string): string => {
  const trimmed = line.trim();
  return trimmed.length > EXCERPT ? `${trimmed.slice(0, EXCERPT)}…` : trimmed;
};

/**
 * Assert every citation's line really carries its quote.
 *
 * @param bibleText  the file, as read by `readSeedInputs`.
 * @param citations  every claim the seed modules make, flattened.
 * @throws {@link CanonCitationError} naming each failure AND the lines the quote is on
 *         now, so the fix is a number substitution rather than a re-read.
 */
export function verifyCitations(bibleText: string, citations: readonly LocatedCitation[]): void {
  const lines = bibleText.split(/\r?\n/);
  const normalised = lines.map(normaliseCanonText);
  const problems: string[] = [];

  for (const cite of citations) {
    const quote = normaliseCanonText(cite.quote);
    if (quote === '') {
      problems.push(`${cite.where} ${cite.of}: cites L${cite.line} with an empty quote`);
      continue;
    }

    const target = normalised[cite.line - 1];
    if (target === undefined) {
      problems.push(
        `${cite.where} ${cite.of}: cites L${cite.line}, but the Bible has only ${lines.length} lines`,
      );
      continue;
    }
    if (target.includes(quote)) continue;

    const found: number[] = [];
    for (let index = 0; index < normalised.length && found.length < MAX_HINTS; index += 1) {
      if ((normalised[index] as string).includes(quote)) found.push(index + 1);
    }
    problems.push(
      `${cite.where} ${cite.of}: L${cite.line} does not carry "${cite.quote}"\n` +
        `      L${cite.line} is: ${excerpt(lines[cite.line - 1] as string)}\n` +
        `      the quote is on: ${found.length === 0 ? 'no line — it was rewritten, not moved' : found.map((n) => `L${n}`).join(', ')}`,
    );
  }

  if (problems.length > 0) {
    throw new CanonCitationError(
      `seed: ${problems.length} of ${citations.length} Bible citation(s) no longer describe ` +
        `data/story_docs/LIFEstream Bible.txt:\n  ${problems.join('\n  ')}`,
    );
  }
}
