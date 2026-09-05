/**
 * The canon change report — what MOVED between two Bibles, not merely that something did.
 * P4B.6, consumed by `scripts/sync-docs.ts`.
 *
 * ── THE GAP THIS CLOSES ───────────────────────────────────────────────────────────────
 * `TRANSCRIBED_SECTIONS` in `server/src/seed/events.ts` is `['Pre-Big One']`, so the drift
 * guard reads 12 bullets of 82. The other 70 — North Korean War 8, Black Fever Era 21,
 * Reconstruction Era 41 — are parsed by nothing and checked by nothing. That is not a
 * hypothetical hole. The author's Bible lives in Google Docs; its Reconstruction Era was
 * rewritten, four load-bearing dates moved, and nothing in this repository noticed for 24
 * days. `sync-docs` on its own validates that a file still PARSES; it would have installed
 * the new Bible cleanly and said nothing about meaning.
 *
 * So this module reads all four sections from both sides and reports, bullet by bullet,
 * what happened to each one.
 *
 * ── WHY BULLETS ARE MATCHED BY PROSE AND NOT BY A KEY ─────────────────────────────────
 * Two obvious matchers both fail, and they fail on the cases that matter:
 *
 *   · BY ORDINAL — "the 6th bullet of the section became the 6th bullet". The first
 *     insertion above shifts everything below it, and the 5 Sep export inserts four
 *     bullets into the middle of the Reconstruction Era. An ordinal match would report 30
 *     changed bullets where 2 changed.
 *   · BY THE F2 KEY `(section, sourceDate, textStart)` — the key `resolveCanonEvents`
 *     resolves on. It contains the DATE, so it breaks on a re-dated bullet, which is the
 *     single most important case here: Max Lauda's death moved from `Feb 7th, 2048` to
 *     `Jan 21st, 2057`. A date-bearing key reports that as one deletion plus one addition.
 *     The truth is one bullet, re-dated, and the two readings lead to different work — one
 *     says "an event was cut and another written", the other says "an authored date is now
 *     wrong". Only the second is true.
 *
 * So bullets are matched on their PROSE, which is the part a re-dating leaves behind.
 *
 * ── THE MEASURE, AND THE MEASUREMENT BEHIND THE THRESHOLD ─────────────────────────────
 * {@link proseSimilarity} is the Sørensen–Dice coefficient over the SET OF CONTENT WORDS:
 * `normaliseCanonText`-folded prose, split into words, function words dropped
 * ({@link FUNCTION_WORDS}), compared as sets. Dice because it is the conventional string
 * similarity for this job and is symmetric and length-tolerant — the Lauda bullet doubled
 * in length, and a measure that punished that would lose the pair it exists to keep.
 *
 * Content words rather than every word, and word SETS rather than word bigrams, because
 * both choices were MEASURED against the real 28 May → 5 Sep pair of Bibles rather than
 * guessed. The decision the threshold has to make is a single one, and it is sharp:
 *
 *   · Max Lauda's death (L937 → L972) is ONE bullet, re-dated and rewritten. Match it.
 *   · The Helios Racing League founding (L932 → L970) is two different sentences about
 *     the same institution, ten years apart, and the export treats the old one as cut and
 *     the new one as written. Do NOT match it.
 *
 * Scores for that pair of pairs, over the real documents:
 *
 *     measure                          Lauda    HRL founding   band
 *     Dice over word bigrams           0.1778   0.1622         0.0156   ← unusable
 *     Dice over word set               0.4783   0.3889         0.0894
 *     IDF-weighted cosine              0.4399   0.3335         0.1064
 *     Dice over CONTENT-word set       0.4667   0.3333         0.1333   ← this module
 *
 * Word bigrams — the conventional first choice — separate the two by 0.016, which is not a
 * threshold, it is a coin flip. Content-word Dice separates them by 0.133, and the two
 * remaining near-misses of the same export sit further down still (Lazaro's doctorate
 * 0.2564, the first orbital fusion craft 0.2857).
 *
 * {@link PROSE_MATCH_THRESHOLD} is therefore **0.40**, the midpoint of that band, with
 * 0.067 of headroom on each side — 14% of the Lauda score below it, 20% of the HRL score
 * above it. The nearest competing partner for either half of the Lauda pair scores 0.20
 * and 0.125, so the pair cannot be stolen by a third bullet either.
 *
 * The measure choice buys MARGIN, not correctness: every measure tried — bigram Dice,
 * word-set Dice, Jaccard, IDF-weighted cosine — ranks those four candidate pairs in the
 * same order. Only the width of the gap between "match" and "don't" changes. That is the
 * reassuring form of a tuned constant: the answer does not depend on the tuning, only the
 * comfort with which it is reached.
 *
 * A threshold errs in two directions and they are NOT symmetric, which is why 0.40 sits at
 * the midpoint and not lower. Too high, and a re-dated bullet reads as removed-plus-added:
 * noisy, but both halves are still printed and a reader can see they are the same bullet.
 * Too low, and two genuinely different bullets FUSE into one "reworded" entry — a real
 * addition and a real removal both vanish from the report. Hiding a canon change is the
 * failure this module exists to prevent, so the safe side is up.
 *
 * ── WHAT THIS DOES NOT COVER ──────────────────────────────────────────────────────────
 * The World Timeline, and nothing else. The Bible's character sheets, location lists,
 * project descriptions and glossary also feed `server/src/seed/registry.ts`, and the only
 * thing watching those is the citation set of P4B.1 — which catches a quote that was
 * REWRITTEN and is blind to a section that was ADDED. The 5 Sep export is the worked
 * example: it carries a new *Cities / Orbital Locations / Asteroids* block, all eight of
 * whose locations are already seeded, and nothing in this repository flagged its arrival.
 * A section can appear in the Bible, matter to the registry, and pass every gate here.
 *
 * ── HOUSE CONSTRAINT ──────────────────────────────────────────────────────────────────
 * Run under the ROOT `tsx` with no root `tsconfig.json`, so `@shared/*` and `@server/*` DO
 * NOT RESOLVE at runtime. Every import below is a relative path, for the reason
 * `scripts/seed.ts`'s header gives.
 */
import path from 'node:path';

import { normaliseCanonText } from '../server/src/seed/citations.js';
import { CANON_EVENTS, CANON_NON_EVENTS } from '../server/src/seed/events.js';

import type {
  BulletClaim,
  CanonBullet,
  CanonEvent,
  CanonNonEvent,
} from '../server/src/seed/events.js';

/* ==== prose similarity ============================================================== */

/**
 * The classic English function words, dropped before words are compared.
 *
 * Not a tuning knob and not fitted to this corpus: it is the standard determiner /
 * preposition / conjunction / pronoun / auxiliary list, and it is here because those words
 * cannot be evidence that two sentences describe the same event. The Helios Racing League
 * pair shares seven words with itself and three of them are `a`, `the` and `is`; the Lauda
 * pair shares eleven and seven of those are content. Removing the words that carry no
 * information is what makes those two cases separable — see the header's table.
 */
export const FUNCTION_WORDS: ReadonlySet<string> = new Set(
  `a an the and or but nor of in on at to for from by with as into onto over under
   is are was were be been being am if then than so such that this these those it its
   he she his her their they them we us our you your i me my not no all any each other more most
   both few own same very can will just also there here when where while after before during until
   up down out off again once who whom which what how why do does did done have has had having`
    .split(/\s+/)
    .filter((word) => word !== ''),
);

/**
 * Fold a bullet's prose into words, the way the rest of canon folds text.
 *
 * `normaliseCanonText` first — it is what `citations.ts` and `resolveCanonEvents` compare
 * under, so a curly apostrophe, an em dash or a doubled space can never read as an edit.
 * Hyphens and apostrophes stay INSIDE words (`p-b¹¹`, `still-sealed`, `public's`) so a
 * compound reads as the one token the author wrote; everything else splits.
 */
export function words(text: string): string[] {
  return normaliseCanonText(text)
    .split(/[^\p{L}\p{N}'-]+/u)
    .map((word) => word.replace(/^['-]+|['-]+$/g, ''))
    .filter((word) => word !== '');
}

/** The words of a bullet that carry information about WHAT it says. */
export const contentWords = (text: string): Set<string> =>
  new Set(words(text).filter((word) => !FUNCTION_WORDS.has(word)));

/**
 * How alike two bullets read, in `[0, 1]`. Sørensen–Dice over their content-word sets;
 * see the header for the measure, the alternatives, and the measurement behind
 * {@link PROSE_MATCH_THRESHOLD}.
 *
 * A bullet with NO content words — conceivable for a one-clause aside — would otherwise
 * score 1 against every other such bullet, because two empty sets are trivially identical.
 * That degenerate case falls back to equality of the whole word sequence, so a fold-away
 * bullet can still match its own twin and nothing else. Words rather than raw text, so the
 * fallback stays as punctuation-blind as the path it stands in for.
 */
export function proseSimilarity(before: string, after: string): number {
  const a = contentWords(before);
  const b = contentWords(after);
  if (a.size === 0 || b.size === 0) {
    return words(before).join(' ') === words(after).join(' ') ? 1 : 0;
  }
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

/**
 * The score at or above which two bullets are the same bullet.
 *
 * MEASURED, not chosen: 0.40 is the midpoint of the band between the re-dated Max Lauda
 * bullet (0.4667) and the rewritten Helios Racing League founding (0.3333), the two cases
 * that must fall on opposite sides of it. The header carries the full table and why the
 * midpoint rather than the floor.
 */
export const PROSE_MATCH_THRESHOLD = 0.4;

/* ==== matching ====================================================================== */

/** What happened to one bullet between two Bibles. */
export type ChangeKind =
  'unchanged' | 're-dated' | 'reworded' | 're-dated-and-reworded' | 'moved' | 'added' | 'removed';

/** One bullet's fate. Exactly one side is `null` for an `added` or a `removed` bullet. */
export interface BulletChange {
  kind: ChangeKind;
  /** The bullet as the installed Bible has it. `null` when the bullet is new. */
  before: CanonBullet | null;
  /** The bullet as the staged export has it. `null` when the bullet is gone. */
  after: CanonBullet | null;
  /** The prose similarity the pair matched on. `null` when there is no pair. */
  score: number | null;
}

/**
 * Pair the bullets of two Bibles, greedily, best score first, each bullet used once.
 *
 * Two passes, and the order is deliberate. Pass one considers only pairs WITHIN a section,
 * so a bullet stays where it is when a plausible partner is standing next to it. Pass two
 * runs over what is left, ACROSS sections, so a bullet genuinely relocated to another era
 * is reported as `moved` rather than as a removal and an unrelated addition. Doing it in
 * one pass would let a stronger cross-section score outbid a bullet's own neighbour.
 *
 * The all-pairs comparison is O(n·m) — 80 × 82 on the real documents, a few thousand
 * comparisons of thirty-word sentences. It is not worth optimising and it is not optimised.
 *
 * Ties break on `before.line` then `after.line`, so the result is the same on every run:
 * two bullets with identical prose (the Bible has none today, but a duplicated line is a
 * normal authoring accident) pair in document order rather than arbitrarily.
 */
export function matchBullets(
  before: readonly CanonBullet[],
  after: readonly CanonBullet[],
  threshold: number = PROSE_MATCH_THRESHOLD,
): BulletChange[] {
  interface Candidate {
    before: CanonBullet;
    after: CanonBullet;
    score: number;
  }

  const usedBefore = new Set<CanonBullet>();
  const usedAfter = new Set<CanonBullet>();
  const paired: Candidate[] = [];

  const pass = (sameSection: boolean): void => {
    const candidates: Candidate[] = [];
    for (const left of before) {
      if (usedBefore.has(left)) continue;
      for (const right of after) {
        if (usedAfter.has(right)) continue;
        if ((left.section === right.section) !== sameSection) continue;
        const score = proseSimilarity(left.text, right.text);
        if (score >= threshold) candidates.push({ before: left, after: right, score });
      }
    }
    candidates.sort(
      (x, y) => y.score - x.score || x.before.line - y.before.line || x.after.line - y.after.line,
    );
    for (const candidate of candidates) {
      if (usedBefore.has(candidate.before) || usedAfter.has(candidate.after)) continue;
      usedBefore.add(candidate.before);
      usedAfter.add(candidate.after);
      paired.push(candidate);
    }
  };

  pass(true);
  pass(false);

  const changes: BulletChange[] = paired.map((candidate) => ({
    kind: classifyPair(candidate.before, candidate.after),
    before: candidate.before,
    after: candidate.after,
    score: candidate.score,
  }));
  for (const bullet of before) {
    if (!usedBefore.has(bullet)) {
      changes.push({ kind: 'removed', before: bullet, after: null, score: null });
    }
  }
  for (const bullet of after) {
    if (!usedAfter.has(bullet)) {
      changes.push({ kind: 'added', before: null, after: bullet, score: null });
    }
  }
  return changes;
}

/**
 * What changed about a bullet that survived, judged under `normaliseCanonText` so
 * typography a transcriber cannot see never reads as an edit.
 *
 * A relocation reports as `moved` and swallows the rest: the section is the coarse half of
 * the F2 key, so a bullet in a different era is a different bullet's worth of work no
 * matter what else held. The record keeps both sides, so a moved bullet's date and prose
 * are still there to read.
 */
export function classifyPair(before: CanonBullet, after: CanonBullet): ChangeKind {
  if (before.section !== after.section) return 'moved';
  const reDated = normaliseCanonText(before.dateText) !== normaliseCanonText(after.dateText);
  const reworded = normaliseCanonText(before.text) !== normaliseCanonText(after.text);
  if (reDated && reworded) return 're-dated-and-reworded';
  if (reDated) return 're-dated';
  if (reworded) return 'reworded';
  return 'unchanged';
}

/* ==== who has transcribed what ====================================================== */

/**
 * Does an authored claim read this bullet? The same test `resolveCanonEvents` applies —
 * section and date equal under `normaliseCanonText`, prose opening compared as a
 * normalised PREFIX.
 *
 * Restated here rather than imported because `resolveCanonEvents` is a GUARD: it THROWS
 * when a bullet is unclaimed, which is right for the twelve transcribed bullets and wrong
 * for these eighty-two, where seventy are legitimately unclaimed and being unclaimed is
 * exactly the fact this report is carrying. The rule is four lines; when it changes there,
 * it changes here, and `tests/canonChangeReport.test.ts` pins the two together against the
 * real Bible.
 */
export function claimReadsBullet(claim: BulletClaim, bullet: CanonBullet): boolean {
  return (
    normaliseCanonText(claim.section) === normaliseCanonText(bullet.section) &&
    normaliseCanonText(claim.sourceDate) === normaliseCanonText(bullet.dateText) &&
    normaliseCanonText(bullet.text).startsWith(normaliseCanonText(claim.textStart))
  );
}

/**
 * Everything transcribed against one bullet, named the way the seed names it.
 *
 * Non-events count. A `CanonNonEvent` is a stated decision that a bullet is a thread or a
 * project rather than an event, and `resolveCanonEvents` resolves it through the same key —
 * so a bullet that moves out from under one breaks the seed exactly as hard as one that
 * moves out from under an event.
 */
export function claimsOnBullet(
  bullet: CanonBullet,
  events: readonly CanonEvent[] = CANON_EVENTS,
  nonEvents: readonly CanonNonEvent[] = CANON_NON_EVENTS,
): string[] {
  const names: string[] = [];
  for (const authored of events) {
    if (claimReadsBullet(authored, bullet)) names.push(authored.id);
  }
  for (const authored of nonEvents) {
    if (claimReadsBullet(authored, bullet)) {
      names.push(`non-event ${authored.kind} "${authored.sourceDate}"`);
    }
  }
  return names;
}

/** A changed bullet, plus what the transcription has to say about it. */
export interface ChangedBullet extends BulletChange {
  /**
   * The authored readings that claim the INSTALLED bullet — `evt_lazaro_born`, and so on.
   * Empty means nobody has transcribed it: the change is real, and it is P5's to take.
   */
  claims: string[];
  /**
   * Whether those claims still resolve against the STAGED bullet.
   *
   * Reported rather than acted on, because it separates two failures that look identical
   * in a count: `false` means the next `db:seed` throws `CanonDriftError` and names the
   * event; `true` means it does not throw and quietly writes a different
   * `event.description`, since the description is read off the bullet rather than authored.
   * The second is the one worth knowing about — nothing else would have said a word.
   */
  claimsStillResolve: boolean;
}

/* ==== the report ==================================================================== */

/** What happened to one section, in counts. */
export interface SectionChange {
  section: string;
  /** Bullets under the heading in the installed Bible, and in the staged export. */
  before: number;
  after: number;
  unchanged: number;
  reDated: number;
  reworded: number;
  reDatedAndReworded: number;
  /** Bullets that left this section, and bullets that arrived in it. */
  movedOut: number;
  movedIn: number;
  added: number;
  removed: number;
}

/** The whole reading: what moved, and who had transcribed it. */
export interface CanonChangeReport {
  /** One row per section, in the order the sections were requested. */
  sections: SectionChange[];
  /** Every bullet that is not `unchanged`, in the order {@link changeOrder} defines. */
  changed: ChangedBullet[];
  /** The subset an authored reading claims. Non-empty REFUSES `--write`. */
  actionable: ChangedBullet[];
  /** The subset nobody has transcribed. A note for P5; blocks nothing. */
  notes: ChangedBullet[];
  totals: { before: number; after: number; unchanged: number };
  /** The threshold this reading was taken at, so the report says how it was produced. */
  threshold: number;
}

/**
 * Order the changed bullets for a human reading the report next to the staged document:
 * by section, then in STAGED document order, with the removed bullets after them in
 * installed order.
 *
 * Removed bullets are not interleaved because there is no honest line number to interleave
 * them on — they exist in one of the two documents and inventing a position in the other
 * would be a fact the report does not have.
 */
export function changeOrder(sections: readonly string[]) {
  const rank = new Map(sections.map((section, index) => [section, index]));
  const sectionRank = (change: BulletChange): number =>
    rank.get((change.after ?? change.before)?.section ?? '') ?? sections.length;
  return (x: BulletChange, y: BulletChange): number =>
    sectionRank(x) - sectionRank(y) ||
    Number(x.after === null) - Number(y.after === null) ||
    (x.after?.line ?? x.before?.line ?? 0) - (y.after?.line ?? y.before?.line ?? 0);
}

/**
 * Read two Bibles and say what happened to every World Timeline bullet.
 *
 * Takes BULLETS rather than file paths, so the whole reading is a pure function of two
 * parsed documents and the spec can exercise it on constructed corpora — a re-dated
 * bullet, a bullet moved between eras, a bullet nobody has transcribed — without a
 * filesystem and without touching `data/story_docs/`.
 */
export function buildCanonChangeReport(
  before: readonly CanonBullet[],
  after: readonly CanonBullet[],
  sections: readonly string[],
  options: {
    threshold?: number;
    events?: readonly CanonEvent[];
    nonEvents?: readonly CanonNonEvent[];
  } = {},
): CanonChangeReport {
  const threshold = options.threshold ?? PROSE_MATCH_THRESHOLD;
  const events = options.events ?? CANON_EVENTS;
  const nonEvents = options.nonEvents ?? CANON_NON_EVENTS;

  const changes = matchBullets(before, after, threshold);

  const sectionRows: SectionChange[] = sections.map((section) => ({
    section,
    before: before.filter((bullet) => bullet.section === section).length,
    after: after.filter((bullet) => bullet.section === section).length,
    unchanged: 0,
    reDated: 0,
    reworded: 0,
    reDatedAndReworded: 0,
    movedOut: 0,
    movedIn: 0,
    added: 0,
    removed: 0,
  }));
  const rowFor = (section: string | undefined): SectionChange | undefined =>
    sectionRows.find((row) => row.section === section);

  for (const change of changes) {
    // A `moved` bullet is counted twice on purpose — out of the section it left and into
    // the one it reached — because a reader of either section's row needs to see it.
    if (change.kind === 'moved') {
      const from = rowFor(change.before?.section);
      const to = rowFor(change.after?.section);
      if (from !== undefined) from.movedOut += 1;
      if (to !== undefined) to.movedIn += 1;
      continue;
    }
    const row = rowFor((change.after ?? change.before)?.section);
    if (row === undefined) continue;
    if (change.kind === 'unchanged') row.unchanged += 1;
    else if (change.kind === 're-dated') row.reDated += 1;
    else if (change.kind === 'reworded') row.reworded += 1;
    else if (change.kind === 're-dated-and-reworded') row.reDatedAndReworded += 1;
    else if (change.kind === 'added') row.added += 1;
    else row.removed += 1;
  }

  const changed: ChangedBullet[] = changes
    .filter((change) => change.kind !== 'unchanged')
    .sort(changeOrder(sections))
    .map((change) => {
      // The claims are read off the INSTALLED bullet: that is what the authored table in
      // `events.ts` points at, and therefore what a change to it invalidates. An added
      // bullet has no installed side and so nothing can have transcribed it.
      const claims = change.before === null ? [] : claimsOnBullet(change.before, events, nonEvents);
      const stillClaimed =
        change.after === null ? [] : claimsOnBullet(change.after, events, nonEvents);
      return {
        ...change,
        claims,
        claimsStillResolve:
          claims.length > 0 && claims.every((name) => stillClaimed.includes(name)),
      };
    });

  return {
    sections: sectionRows,
    changed,
    actionable: changed.filter((change) => change.claims.length > 0),
    notes: changed.filter((change) => change.claims.length === 0),
    totals: {
      before: before.length,
      after: after.length,
      unchanged: changes.filter((change) => change.kind === 'unchanged').length,
    },
    threshold,
  };
}

/**
 * `data/story_docs/LIFEstream Bible.canon-change.md`, beside the document it describes and
 * beside `provenancePathFor`'s record of the same sync. Same convention, deliberately: the
 * two files answer "which bytes are these" and "what did they change", and a reader who
 * finds one should find the other without being told where to look.
 */
export const changeReportPathFor = (target: string): string =>
  path.join(path.dirname(target), `${path.basename(target, path.extname(target))}.canon-change.md`);

/* ==== rendering ===================================================================== */

/**
 * A section's `moved` cell.
 *
 * `in/out` rather than a net, because a section that lost one bullet and gained another
 * nets to zero and a zero in this column would say nothing happened. A count that can
 * cancel is exactly the reporting a byte diff already gives.
 */
const movedCell = (row: SectionChange): string =>
  row.movedIn === 0 && row.movedOut === 0 ? '0' : `${row.movedIn}/${row.movedOut}`;

/** A bullet in one line: where it stands, what it is dated, and how it opens. */
const oneLine = (bullet: CanonBullet, width = 72): string => {
  const text = bullet.text.length > width ? `${bullet.text.slice(0, width)}…` : bullet.text;
  return `L${bullet.line} [${bullet.section}] "${bullet.dateText}": ${text}`;
};

/** The two sides of a change, indented under it. Only the side that exists is printed. */
function sidesOf(change: BulletChange, indent: string): string[] {
  const lines: string[] = [];
  if (change.before !== null) lines.push(`${indent}installed  ${oneLine(change.before)}`);
  if (change.after !== null) lines.push(`${indent}staged     ${oneLine(change.after)}`);
  return lines;
}

/** One changed bullet, headline plus both sides. */
export function describeChange(change: ChangedBullet, indent = '    '): string[] {
  const score = change.score === null ? '' : `  (prose ${change.score.toFixed(3)})`;
  const head = `${indent}${change.kind.toUpperCase()}${score}`;
  const lines = [head, ...sidesOf(change, `${indent}  `)];
  if (change.claims.length > 0) {
    lines.push(
      `${indent}  transcribed by ${change.claims.join(', ')} — ` +
        (change.claimsStillResolve
          ? 'the reading STILL RESOLVES, so `db:seed` will not throw; it will quietly ' +
            'write a different event.description, which nothing else would report'
          : 'the reading NO LONGER RESOLVES — the next `db:seed` throws CanonDriftError'),
    );
  }
  return lines;
}

/**
 * The gate detail `sync-docs` prints under "no changed bullet is claimed by an authored
 * reading". Named here because the sentence explaining WHY it refuses belongs next to the
 * code that decides.
 */
export function actionableGateDetail(report: CanonChangeReport): string[] {
  if (report.actionable.length === 0) {
    return [
      `${report.changed.length} changed bullet(s), none of them transcribed — ` +
        `nothing in events.ts reads a bullet this export moved`,
    ];
  }
  return [
    `${report.actionable.length} changed bullet(s) an authored reading claims:`,
    ...report.actionable.flatMap((change) => {
      // `claims` are read off the installed side, so an actionable change always has one.
      const bullet = change.before ?? change.after;
      if (bullet === null) return [];
      return change.claims.map((claim) => `  ${claim} -> ${oneLine(bullet, 56)}`);
    }),
    'installing this would break the seed on the next run, or silently rewrite an',
    'event description. Reconcile events.ts against the staged Bible first — failing',
    'here names the cause; failing at db:seed leaves it to be rediscovered.',
  ];
}

/** The report as `sync-docs` prints it. `quiet` drops the per-bullet detail. */
export function renderCanonChangeReport(report: CanonChangeReport, quiet = false): string[] {
  const lines: string[] = [];
  const width = Math.max(...report.sections.map((row) => row.section.length), 7);
  lines.push('canon change report   all four sections, matched on prose');
  lines.push(
    `  ${'section'.padEnd(width)}  before -> after   unchanged  re-dated  reworded  ` +
      `both  in/out  added  removed`,
  );
  for (const row of report.sections) {
    lines.push(
      `  ${row.section.padEnd(width)}  ${String(row.before).padStart(6)} -> ` +
        `${String(row.after).padStart(5)}   ${String(row.unchanged).padStart(9)}  ` +
        `${String(row.reDated).padStart(8)}  ${String(row.reworded).padStart(8)}  ` +
        `${String(row.reDatedAndReworded).padStart(4)}  ` +
        `${movedCell(row).padStart(6)}  ` +
        `${String(row.added).padStart(5)}  ${String(row.removed).padStart(7)}`,
    );
  }
  lines.push(
    `  ${report.totals.before} -> ${report.totals.after} bullet(s), ` +
      `${report.totals.unchanged} unchanged, ${report.changed.length} changed ` +
      `(prose match at ${report.threshold})`,
  );

  if (report.actionable.length > 0) {
    lines.push('');
    lines.push(`  ACTIONABLE NOW — ${report.actionable.length} changed bullet(s) already`);
    lines.push('  transcribed in events.ts. These block --write.');
    for (const change of report.actionable) lines.push(...describeChange(change));
  }

  if (report.notes.length > 0) {
    lines.push('');
    lines.push(`  FOR P5 — ${report.notes.length} changed bullet(s) nobody has transcribed.`);
    lines.push('  Nothing reads them yet, so they block nothing; this is the only record');
    lines.push('  that they moved at all.');
    if (quiet) {
      lines.push('    (--quiet: per-bullet detail suppressed)');
    } else {
      for (const change of report.notes) lines.push(...describeChange(change));
    }
  }

  if (report.changed.length === 0) {
    lines.push('  every bullet in all four sections is unchanged.');
  }
  return lines;
}

/** What the written artifact records about where it came from. */
export interface ChangeReportMeta {
  /** The `--doc` name and the Drive title, for a reader who has only this file. */
  doc: string;
  title: string;
  /** Where the export was staged, and the two sha256s the diff was taken between. */
  source: string;
  installedSha256: string;
  stagedSha256: string;
  generatedAt: Date;
}

/**
 * The report as the file committed beside the Bible.
 *
 * Markdown, not the project's HTML doc convention: this is a machine-generated record that
 * lands in a commit and is read on GitHub next to the `git diff` it explains, not a
 * planning document. It is written for the reader of THAT COMMIT — the whole point of
 * P4B.6.5 is that the commit installing a new canon carries the reasoning for what it
 * changed, so nobody has to re-derive it from two versions of an 1,100-line document.
 */
export function renderCanonChangeMarkdown(
  report: CanonChangeReport,
  meta: ChangeReportMeta,
): string {
  const out: string[] = [];
  out.push(`# Canon change report — ${meta.title}`);
  out.push('');
  out.push(
    'Generated by `scripts/sync-docs.ts` (P4B.6) when this Bible was installed. It reports ' +
      'what happened to every World Timeline bullet, matched on prose rather than on line ' +
      'number or on the `(section, date, textStart)` key — so a re-dated bullet reads as one ' +
      'bullet that moved, not as a deletion plus an addition.',
  );
  out.push('');
  out.push(`- document: \`${meta.doc}\` — ${meta.title}`);
  out.push(`- staged from: \`${meta.source}\``);
  out.push(`- installed sha256: \`${meta.installedSha256}\` (before)`);
  out.push(`- staged sha256: \`${meta.stagedSha256}\` (after)`);
  out.push(`- generated: ${meta.generatedAt.toISOString()}`);
  out.push(
    `- prose match: Sørensen–Dice over content words, threshold ${report.threshold} ` +
      '(see the header of `scripts/canonChangeReport.ts` for the measurement)',
  );
  out.push('');
  out.push('## Per section');
  out.push('');
  out.push(
    '| section | before | after | unchanged | re-dated | reworded | both | moved in/out | ' +
      'added | removed |',
  );
  out.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const row of report.sections) {
    out.push(
      `| ${row.section} | ${row.before} | ${row.after} | ${row.unchanged} | ${row.reDated} | ` +
        `${row.reworded} | ${row.reDatedAndReworded} | ${movedCell(row)} | ` +
        `${row.added} | ${row.removed} |`,
    );
  }
  out.push('');
  out.push(
    `**${report.totals.before} → ${report.totals.after} bullets**, ` +
      `${report.totals.unchanged} unchanged, ${report.changed.length} changed.`,
  );

  const section = (heading: string, blurb: string, changes: readonly ChangedBullet[]): void => {
    out.push('');
    out.push(`## ${heading}`);
    out.push('');
    out.push(blurb);
    out.push('');
    if (changes.length === 0) {
      out.push('_None._');
      return;
    }
    for (const change of changes) {
      out.push(
        `### ${change.kind}${change.score === null ? '' : ` (prose ${change.score.toFixed(3)})`}`,
      );
      out.push('');
      if (change.before !== null) out.push(`- **installed** — ${oneLine(change.before, 400)}`);
      if (change.after !== null) out.push(`- **staged** — ${oneLine(change.after, 400)}`);
      if (change.claims.length > 0) {
        out.push(
          `- **transcribed by** \`${change.claims.join('`, `')}\` — ` +
            (change.claimsStillResolve
              ? 'the reading still resolves, so `db:seed` will not throw; it writes a ' +
                'different `event.description` instead'
              : 'the reading no longer resolves — `db:seed` throws `CanonDriftError`'),
        );
      }
      out.push('');
    }
  };

  section(
    'Actionable now — a transcribed bullet changed',
    'An authored reading in `server/src/seed/events.ts` claims these bullets. A change ' +
      'here either breaks the next `db:seed` or silently rewrites an `event.description`, ' +
      'so `sync-docs --write` refuses to install until they are reconciled.',
    report.actionable,
  );
  section(
    'For P5 — a bullet nobody has transcribed changed',
    'Nothing reads these bullets yet, so they block nothing. `TRANSCRIBED_SECTIONS` is ' +
      "`['Pre-Big One']`; P5 transcribes the rest, and this list is what it inherits.",
    report.notes,
  );

  out.push('');
  out.push('## What this does not cover');
  out.push('');
  out.push(
    "The World Timeline, and nothing else. The Bible's character sheets, location lists, " +
      'project descriptions and glossary also feed `server/src/seed/registry.ts`, and the ' +
      'only thing watching those is the citation set — which catches a quote that was ' +
      '**rewritten** and is blind to a section that was **added**. The 5 Sep 2026 export is ' +
      'the worked example: it carries a new *Cities / Orbital Locations / Asteroids* block ' +
      'whose eight locations are already seeded, and nothing flagged its arrival.',
  );
  out.push('');
  return `${out.join('\n')}\n`;
}
