/**
 * Citations — the `// L<n>` affordance, made real (P3 review F5), re-keyed onto the quote
 * (P4B.1).
 *
 * The seed modules promise that every authored row "carries a `L<n>` marker naming the
 * line it was read off, so a later reader can check a row against canon without
 * re-deriving it". On an honour system that promise decays: a review of P3 found about
 * twenty-five of the registry's markers wrong — the glossary block consistently off by
 * 14-17 lines — and a wrong citation is worse than none, because it sends the checker to
 * a line that says something else and looks like a transcription error in the row.
 *
 * So a citation is DATA, not a comment: `{ of, line, quote }` on the row itself, checked
 * before the seed writes anything. What this module got WRONG until P4B.1 was which half
 * of that pair is the claim.
 *
 * ── WHY THIS WAS REWRITTEN: 142 OF 142, AND EVERY QUOTE CORRECT ───────────────────────
 * The first version asserted the LINE: it looked at `lines[cite.line - 1]` and failed
 * unless that one line carried the quote. Run against the 21 June Google Doc original of
 * the Bible — 28 lines longer than the repo's exported copy, and otherwise the same
 * document — it failed 142 of 142 citations. Not one quote had been rewritten; every
 * single failure was the same insertion, counted 142 times. The error message even
 * printed the line each quote had moved to, so the checker held the answer and refused
 * anyway. A guard that fails wholesale on a routine edit is not a guard: it is a thing
 * you learn to run with `|| true`.
 *
 * So the quote is the EVIDENCE and the line is NAVIGATION. The quote is what the row
 * claims canon says; that claim can be true or false, and when it is false the row's
 * supporting canon really did change and the row needs a human. The line number is a
 * property of everything ABOVE the quote, not of the quote — one paragraph added six
 * hundred lines earlier moves it — so it is refreshed from the file every run and
 * reported as {@link CitationReport.drifted}, never asserted.
 *
 * This is exactly the P3 review's F2 fix applied to the second guard. F2 re-keyed the
 * event drift guard in `events.ts` onto `(section, sourceDate, textStart)` so that "no
 * authored table has to be renumbered when a line is inserted above", and left
 * `CanonBullet.line` REPORTED, never asserted. The citation checker never got that
 * treatment, so for three phases the two guards disagreed about whether a line number was
 * data — the drift guard passed the 21 June Bible while the citation checker rejected it
 * whole. They now agree.
 *
 * ── WHAT STILL FAILS ──────────────────────────────────────────────────────────────────
 * A quote that is nowhere in the file, and only that. It means the sentence the row was
 * read off was rewritten or deleted, which is the one event that actually invalidates the
 * row. Ambiguity does not fail: a quote matching more than one line is reported as
 * {@link CitationReport.weak} so it can be strengthened, because a weak quote was already
 * weak before the edit and failing the seed for it now would punish the wrong commit.
 *
 * P5 writes sixty-eight more of these. That is the reason the check exists rather than a
 * second careful proof-read — and the reason it has to survive the document being edited.
 *
 * ── WHAT IS COMPARED ──────────────────────────────────────────────────────────────────
 * The Bible is a pasted Google Doc: it carries curly quotes, non-breaking spaces,
 * zero-width spaces (L77 and L78 both begin with one), en dashes where a keyboard types a
 * hyphen, and runs of whitespace that mean nothing. {@link normaliseCanonText} folds all
 * of that away, so the check catches a line that was REWRITTEN and never trips on
 * typography a transcriber cannot see. Case is folded for the same reason.
 */

/** One claim about the Bible, attached to the row that makes it. */
export interface Citation {
  /** What in the row this line supports — a field name, or a short phrase for prose. */
  of: string;
  /**
   * 1-based line number in `data/story_docs/LIFEstream Bible.txt`.
   *
   * A NAVIGATION HINT, not a key (P4B.1): it is where {@link quote} stood when the row
   * was written, so a reader can jump straight to it. It is re-derived from the file every
   * run and a stale one is reported as drift, never failed — see the module header.
   */
  line: number;
  /**
   * The text the row was read off, compared under {@link normaliseCanonText}. THIS is the
   * assertion: it must appear somewhere in the file. Quote a whole clause, not a name — a
   * quote matching more than one line is reported {@link CitationReport.weak}, because it
   * can no longer say WHICH line the row was read off.
   */
  quote: string;
}

/** A {@link Citation} plus the row that made it — what the checker reports on. */
export interface LocatedCitation extends Citation {
  /** `registry.ts CANON_CHARACTERS char_lazaro`, or any other locator a reader can follow. */
  where: string;
}

/** A citation whose quote is no longer in the Bible. Thrown before anything is written. */
export class CanonCitationError extends Error {
  override name = 'CanonCitationError';
}

/** A citation whose quote is still there, on a different line than the row records. */
export interface CitationDrift {
  /** The row that made the claim — {@link LocatedCitation.where}. */
  where: string;
  /** Which part of the row — {@link Citation.of}. */
  of: string;
  /** The line the row records. */
  from: number;
  /**
   * The line the quote is on now, and what {@link Citation.line} should be refreshed to.
   * When {@link matches} is greater than 1 this is the match nearest `from` (ties resolve
   * downward, because documents under authorship grow more often than they shrink), so it
   * is the best guess rather than a certainty.
   */
  to: number;
  /** How many lines carry the quote. Anything but 1 makes {@link to} a guess. */
  matches: number;
}

/** A citation whose quote is not unique, so it cannot say which line the row was read off. */
export interface WeakCitation {
  /** The row that made the claim — {@link LocatedCitation.where}. */
  where: string;
  /** Which part of the row — {@link Citation.of}. */
  of: string;
  /** The quote, verbatim as authored, so the fix is a copy-paste away. */
  quote: string;
  /** Every line the quote appears on, ascending. `matches.length >= WEAK_QUOTE_MATCHES`. */
  matches: readonly number[];
}

/** What {@link verifyCitations} returns when nothing is fatally wrong. */
export interface CitationReport {
  /** How many citations were checked. */
  checked: number;
  /** Citations whose line hint is stale — the seed prints these and runs on. */
  drifted: readonly CitationDrift[];
  /** Citations whose quote is not unique enough to locate. Advisory; see {@link WEAK_QUOTE_MATCHES}. */
  weak: readonly WeakCitation[];
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

/**
 * A quote matching this many lines or more is reported {@link WeakCitation}.
 *
 * TWO — which is to say: a quote is weak unless it is UNIQUE. The number is not a taste
 * call about how common is too common; it is the exact point where this module stops being
 * able to do its second job. The first job is "does canon still say this", and a quote
 * matching five lines answers that as well as one matching one. The second job is "which
 * line was this row read off", and the moment a quote matches twice, nothing in the file
 * can answer it — {@link CitationDrift.to} falls back to the nearest match, which is a
 * guess dressed as a line number.
 *
 * The corpus measures it. Replaying the 28-line growth that motivated P4B.1 against all
 * 142 shipped citations: all 104 with a unique quote refreshed to exactly the right new
 * line, and 8 of the 38 non-unique ones refreshed to the WRONG one. Every bad refresh was
 * non-unique and no unique one was bad — so uniqueness, not a match count, is the property
 * that separates a hint you can trust from one you cannot. Setting the bar at four (which
 * would still catch the file-label quotes: "Characters" on 5 lines, "DOB" on 24) would let
 * through the two-match case that actually misfired: `char_adan`'s "POB: Los Angeles, CA"
 * stands on two adjacent character sheets and the refresh picked the neighbour's.
 *
 * Advisory on purpose: 38 of the 142 citations shipped before P4B.1 are weak by this
 * measure. They were weak before the Bible was edited — a non-unique quote was always
 * non-unique — so failing the seed for them now would block a document sync on a debt the
 * sync did not create. Strengthening them (quote the clause, not the name) is its own pass.
 */
export const WEAK_QUOTE_MATCHES = 2;

/** How many lines {@link formatCitationReport} names before it says "and N more". */
const MAX_LISTED = 4;

/** How much of a line the error prints back. */
const EXCERPT = 90;

const excerpt = (line: string): string => {
  const trimmed = line.trim();
  return trimmed.length > EXCERPT ? `${trimmed.slice(0, EXCERPT)}…` : trimmed;
};

/**
 * The match a stale hint should be refreshed to: the one nearest the recorded line.
 *
 * Ties resolve DOWNWARD — `>=` rather than `>` on the distance — because the edit that
 * moves a citation is almost always an insertion above it, so of two equally distant
 * candidates the later one is the likelier home. `matches` is non-empty and ascending.
 */
const nearestMatch = (matches: readonly number[], line: number): number => {
  let best = matches[0] as number;
  for (const match of matches) {
    if (Math.abs(match - line) <= Math.abs(best - line)) best = match;
  }
  return best;
};

/**
 * Verify every citation's QUOTE against the Bible, and refresh its line hint.
 *
 * The quote is searched for across the whole file. Finding it is the pass; where it was
 * found is reported, never asserted (P4B.1 — see the module header for the 142-of-142
 * failure that forced this).
 *
 * @param bibleText  the file, as read by `readSeedInputs`.
 * @param citations  every claim the seed modules make, flattened.
 * @returns a report the caller can print: how many were checked, whose line hints are
 *          stale, and whose quotes are not unique enough to locate anything.
 * @throws {@link CanonCitationError} naming every row whose quote is NOWHERE in the file —
 *         the one failure that means the row's supporting canon actually changed.
 */
export function verifyCitations(
  bibleText: string,
  citations: readonly LocatedCitation[],
): CitationReport {
  const lines = bibleText.split(/\r?\n/);
  const normalised = lines.map(normaliseCanonText);
  const problems: string[] = [];
  const drifted: CitationDrift[] = [];
  const weak: WeakCitation[] = [];

  for (const cite of citations) {
    const quote = normaliseCanonText(cite.quote);
    if (quote === '') {
      problems.push(
        `${cite.where} ${cite.of}: cites L${cite.line} with an empty quote — a citation ` +
          `with no quote asserts nothing about canon`,
      );
      continue;
    }

    const matches: number[] = [];
    for (let index = 0; index < normalised.length; index += 1) {
      if ((normalised[index] as string).includes(quote)) matches.push(index + 1);
    }

    if (matches.length === 0) {
      // The recorded line is only context here, and it may itself be off the end of the
      // file — the Bible can shrink as well as grow, and printing "L1102 is: undefined"
      // is how the old checker turned one edit into two mysteries.
      const at = lines[cite.line - 1];
      problems.push(
        `${cite.where} ${cite.of}: "${cite.quote}" is nowhere in the Bible — the sentence ` +
          `it quotes was rewritten or deleted, not moved\n` +
          `      the L${cite.line} hint ` +
          (at === undefined
            ? `is past the end of the file (the Bible has ${lines.length} lines)`
            : `now reads: ${excerpt(at)}`),
      );
      continue;
    }

    if (matches.length >= WEAK_QUOTE_MATCHES) {
      weak.push({ where: cite.where, of: cite.of, quote: cite.quote, matches });
    }
    if (!matches.includes(cite.line)) {
      drifted.push({
        where: cite.where,
        of: cite.of,
        from: cite.line,
        to: nearestMatch(matches, cite.line),
        matches: matches.length,
      });
    }
  }

  if (problems.length > 0) {
    throw new CanonCitationError(
      `seed: ${problems.length} of ${citations.length} Bible citation(s) quote text that is ` +
        `no longer in data/story_docs/LIFEstream Bible.txt:\n  ${problems.join('\n  ')}`,
    );
  }

  return { checked: citations.length, drifted, weak };
}

/**
 * The citation report as log lines — what `npm run db:seed` prints, in the shape
 * `formatSeedReport` uses.
 *
 * Drift is printed rather than swallowed: a stale hint is harmless to the seed and
 * actively misleading to the next reader, so the run says which numbers to refresh and
 * carries on. A clean run says so in one line, because a guard that is silent when it
 * passes is a guard nobody remembers is running.
 */
export function formatCitationReport(report: CitationReport): string[] {
  const lines: string[] = [];
  lines.push(
    `citations — ${report.checked} checked against data/story_docs/LIFEstream Bible.txt (P4B.1)`,
  );

  if (report.drifted.length === 0) {
    lines.push('  every line hint is current');
  } else {
    lines.push(
      `  ${report.drifted.length} line hint(s) are stale — the quotes are all still there, ` +
        `the numbers need refreshing:`,
    );
    for (const drift of report.drifted) {
      const guess = drift.matches > 1 ? ` (nearest of ${drift.matches} matches)` : '';
      lines.push(`    ${drift.where} ${drift.of}: L${drift.from} -> L${drift.to}${guess}`);
    }
  }

  if (report.weak.length > 0) {
    lines.push(
      `  ${report.weak.length} quote(s) match ${WEAK_QUOTE_MATCHES}+ lines, so they cannot say ` +
        `which line the row was read off:`,
    );
    for (const entry of report.weak) {
      const listed = entry.matches.slice(0, MAX_LISTED).map((line) => `L${line}`);
      const rest = entry.matches.length - listed.length;
      lines.push(
        `    ${entry.where} ${entry.of}: "${entry.quote}" is on ${entry.matches.length} lines ` +
          `(${listed.join(', ')}${rest > 0 ? `, and ${rest} more` : ''})`,
      );
    }
  }

  return lines;
}
