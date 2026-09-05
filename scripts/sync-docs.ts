/**
 * `npx tsx scripts/sync-docs.ts --doc bible --from <export>` — check a fetched Google Doc
 * export against the copy in `data/story_docs/`, and install it only if it will not break
 * the seed. P4B.2.
 *
 * Everything under `data/story_docs/` arrived by hand export, which is how the Bible went
 * 24 days stale without anyone noticing. This closes the half of that gap that a script
 * can close.
 *
 * ── THERE IS NO FETCH IN THIS SCRIPT, AND THAT IS NOT AN OVERSIGHT ────────────────────
 * P4B.2.1 reads as though this script pulls the document from Drive by id. It cannot, and
 * it should not try. The documents are private, and the only Drive access this project has
 * is an assistant-side connector — a tool the author's assistant holds, not a credential a
 * Node process can present. Making a fetch work here would mean standing up a Google Cloud
 * OAuth client, a consent screen and a refresh-token file on disk, which is a much larger
 * commitment (and a much larger secret to keep) than the task is worth.
 *
 * So the fetch happens OUTSIDE: whoever is holding a Drive connection exports the document
 * to a file and passes it in with `--from`. This script owns everything else, which is the
 * automatable half and the half that actually protects canon:
 *
 *   · it VALIDATES the export against the real parser in `server/src/seed/events.ts`,
 *   · it DIFFS it against what is installed and says where the document moved,
 *   · it REPORTS what happened to every World Timeline bullet — matched on prose, so a
 *     re-dated bullet reads as one bullet that moved rather than as a deletion plus an
 *     addition — and REFUSES to install when a changed bullet is one `events.ts` reads
 *     (P4B.6; see `scripts/canonChangeReport.ts`),
 *   · it RECORDS provenance next to the installed file,
 *   · and it INSTALLS only on an explicit `--write`, only if every gate passed.
 *
 * If someone later adds a fetch, it belongs in front of `--from` — write the export to a
 * temp file and hand it to this code path. Nothing here needs to change.
 *
 * ── WHY THIS IS `.ts` WHEN THE OTHER `scripts/*` ARE `.mjs` ───────────────────────────
 * The validation is only worth anything if it runs the REAL parser rather than a second
 * implementation of it, and that parser is `server/src/seed/events.ts`. The `db-check-*`
 * scripts are plain JS because they need nothing from the workspace; this one does.
 *
 * It therefore inherits `scripts/seed.ts`'s constraint, and the constraint is real — it
 * has bitten this project before. This runs under the ROOT `tsx` and there is no root
 * `tsconfig.json`, so `@shared/*` and `@server/*` DO NOT RESOLVE at runtime. Every value
 * import in the graph below must be a relative path. (`events.ts`'s own `@shared` import
 * is `import type` and erases, which is why importing it here works at all.)
 *
 * The same constraint is why `parseArgs`, the repo anchor and the identity guard are
 * re-implemented below instead of imported from `scripts/lib/repo.mjs`: that module is
 * plain JS with no `.d.mts` sidecar, so importing it from TypeScript fails `npm run
 * typecheck` with TS7016. The three helpers are ~30 lines and their behaviour is pinned by
 * the spec; when `repo.mjs` grows a declaration file, delete them and import it.
 *
 * ── WHAT PROVES A DOCUMENT CHANGED ────────────────────────────────────────────────────
 * Not Drive's `modifiedTime`. All seven documents in that folder carry near-identical
 * timestamps from a bulk folder move, so `modifiedTime` says only that the folder was
 * touched. The SHA-256 of the bytes and the diff are what settle it, and they are what the
 * provenance record keeps. `modifiedTime` is deliberately not recorded: a field that looks
 * like evidence and is not is worse than no field.
 *
 * ── WHAT IS NOT CHECKED HERE ──────────────────────────────────────────────────────────
 * Citations. `verifyCitations` is the SEED's gate and runs on `npm run db:seed`; it is not
 * duplicated here. A staged export can pass every gate below and still fail the seed on a
 * citation, and the output says so rather than implying a clean bill of health.
 *
 * ── BYTES GO THROUGH UNCHANGED ────────────────────────────────────────────────────────
 * No normalisation, ever — not the BOM, not the CRLFs, not trailing whitespace. A
 * normalisation is a diff the author did not make, and it lands in `git diff` looking
 * exactly as though they had edited the document. Encoding is CHECKED and never repaired.
 *
 * Exit 0 = validated · 1 = a gate failed, or the command could not run · 2 = inconclusive
 * (the check could not be completed — NOT a pass).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  CanonDriftError,
  TRANSCRIBED_SECTIONS,
  readWorldTimelineBullets,
  resolveCanonEvents,
} from '../server/src/seed/events.js';
import {
  actionableGateDetail,
  buildCanonChangeReport,
  changeReportPathFor,
  renderCanonChangeMarkdown,
  renderCanonChangeReport,
} from './canonChangeReport.js';

import type { SectionLedger } from '../server/src/seed/events.js';
import type { CanonChangeReport } from './canonChangeReport.js';

/* ==== the document table ============================================================ */

/** One syncable document. Keyed by `--doc` name. */
export interface DocSpec {
  /** The Drive title. Recorded in provenance, NEVER used to find the file (P4B.2.1). */
  title: string;
  /**
   * The Drive document id — the only identity that survives a rename. A pull by title
   * would silently fetch a different document the day someone renames one; a pull by id
   * fails loudly, which is the behaviour canon deserves.
   */
  driveId: string;
  /** Repo-relative destination. */
  target: string;
  /**
   * Which gates apply. `world-timeline` runs the canon parser and the drift guard;
   * `encoding-only` is for a document no code reads yet, where encoding and the diff are
   * the only checks that can mean anything (P4B.2.5 — "a file nothing reads is a file
   * nothing checks").
   */
  gates: 'world-timeline' | 'encoding-only';
}

/**
 * Every document in the author's LIFEstream folder.
 *
 * P4B.5's decision is **sync all seven, parse one**. Being *tracked* and being
 * *authoritative* are different jobs. Tracked means the file lands in the repo and is
 * committed, so an edit becomes a diff someone can read — which is the whole of what
 * change-detection needs for a document no code parses, and it is what makes 24 days of
 * silent drift impossible for any of them. Authoritative means the file may contradict the
 * database and win, and that is the Bible alone; when one of the other six disagrees with
 * it, the Bible is right and the document is stale.
 *
 * So six of these carry `encoding-only`. That is not a weaker version of the Bible's
 * gates — it is the complete set of checks that can mean anything about a file whose
 * structure nothing depends on. Give a document real gates on the day something parses it,
 * not before.
 */
export const DOCS: Readonly<Record<string, DocSpec>> = {
  bible: {
    title: 'LIFEstream Bible',
    driveId: '1OMG_OBxCSFkcnuaG2jHnnNtUcYe0ii7JnjGY_fS5Hs0',
    target: 'data/story_docs/LIFEstream Bible.txt',
    gates: 'world-timeline',
  },
  story: {
    title: 'LIFEstream Story Document',
    driveId: '1pKXR0k-eeRVKZLdjU7vn745AByr5JyknU06GvU0BnZk',
    target: 'data/story_docs/LIFEstream Story Document.txt',
    gates: 'encoding-only',
  },
  research: {
    title: 'LIFEstream Research',
    driveId: '1l1YfgPhMAMuxSJwgTXJ8AP0ukhPcQX08vgboH4PeJLc',
    target: 'data/story_docs/LIFEstream Research.txt',
    gates: 'encoding-only',
  },
  treatment: {
    title: 'LIFEstream Treatment',
    driveId: '1sHF2_6_2Pqm3Uuk3uGasXyKOWFm0evh-kdxnyrSEewE',
    target: 'data/story_docs/LIFEstream Treatment.txt',
    gates: 'encoding-only',
  },
  screenplay: {
    title: 'LifeStream by Salvador Salcedo',
    driveId: '1RtGTs-rT5nwMjqPw1NNG_9pzM3ApoxsnWYqtO_LmZ3A',
    target: 'data/story_docs/LIFEstream Screenplay Fragment.txt',
    gates: 'encoding-only',
  },
  'visual-style': {
    title: 'Visual Style',
    driveId: '1dOShf5rbJuDtR3fZ9AfVz_Q9C-KW_BbM9jJa8MxVKQY',
    target: 'data/story_docs/LIFEstream Visual Style.txt',
    gates: 'encoding-only',
  },
  synopsis: {
    title: 'LIFEstream 1 Page Synopsis',
    driveId: '1paY2qEBEYsAHe3NwdMdDxXIdBKJbdCIv1jLJScDIV8w',
    target: 'data/story_docs/LIFEstream Synopsis.txt',
    gates: 'encoding-only',
  },
  character: {
    title: 'Character',
    driveId: '1-oUJDhqO1GbfA1m0Dg0DPX1yVZG1YT5fYJsCGBmYBmo',
    target: 'data/story_docs/LIFEstream Character.txt',
    gates: 'encoding-only',
  },
};

/**
 * The four World Timeline headings, spelled as the file spells them.
 *
 * `TRANSCRIBED_SECTIONS` is the subset `events.ts` has readings for (one, today). This is
 * the full set the Bible must still contain: a section vanishing from the export is a
 * catastrophe P5 would discover only when it went to transcribe it.
 */
export const WORLD_TIMELINE_SECTIONS: readonly string[] = [
  'Pre-Big One',
  'North Korean War',
  'Black Fever Era',
  'Reconstruction Era',
];

/**
 * The line the World Timeline hangs off, restated from `events.ts` (where it is module
 * private). If the parser's anchor ever changes, this copy drifts — which is why the spec
 * cross-checks the headings found here against the sections the parser reports bullets
 * under, rather than trusting the two constants to stay equal on their own.
 */
const WORLD_TIMELINE_HEADING = 'World Timeline:';

/* ==== anchoring and argv ============================================================ */

/** The repo root, resolved from THIS file and never from `process.cwd()`. */
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A repo-root-relative display path, so output does not leak the machine's layout. */
const rel = (target: string): string => {
  const relative = path.relative(repoRoot, target);
  return relative.startsWith('..') || path.isAbsolute(relative) ? target : relative;
};

/**
 * Minimal flag parser — `--flag`, `--key value`, `--key=value`, nothing else. An unknown
 * argument is a hard error: a typo'd `--write` must never read as "not writing", and a
 * typo'd `--wrote` must never be swallowed.
 *
 * Semantics deliberately identical to `parseArgs` in `scripts/lib/repo.mjs`.
 */
export function parseArgs(
  argv: readonly string[],
  spec: { flags?: readonly string[]; options?: readonly string[] },
): Record<string, string | boolean> {
  const flags = new Set(spec.flags ?? []);
  const options = new Set(spec.options ?? []);
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg : arg.slice(0, eq);
    if (flags.has(key) && eq === -1) {
      out[key.replace(/^--/, '')] = true;
    } else if (options.has(key)) {
      const value = eq === -1 ? argv[(i += 1)] : arg.slice(eq + 1);
      if (value === undefined) throw new Error(`${key} needs a value`);
      out[key.replace(/^--/, '')] = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

/**
 * Refuse to run unless the anchored root really is this repository — the same guard every
 * `db:*` script takes before it touches `data/`, for the same reason: this script WRITES
 * into `data/story_docs/`, and a copy of it vendored into another tree must not overwrite
 * that tree's files.
 */
function assertLifestreamRepo(): void {
  let name: unknown;
  try {
    name = (
      JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { name?: unknown }
    ).name;
  } catch {
    name = undefined;
  }
  if (name === 'lifestream') return;
  console.error(`sync-docs refused: ${repoRoot} is not the lifestream repo.`);
  console.error(
    name === undefined
      ? `  expected ${path.join(repoRoot, 'package.json')} to be readable JSON naming this repo.`
      : `  expected "name": "lifestream" in package.json; found "${String(name)}".`,
  );
  console.error('  nothing was read or written.');
  process.exit(1);
}

/* ==== encoding ====================================================================== */

/** What the bytes are, independent of what they say. */
export interface EncodingReport {
  bytes: number;
  /** Over the RAW bytes, BOM included — the thing that settles whether anything changed. */
  sha256: string;
  /** A UTF-8 BOM (`EF BB BF`) leads the file. */
  bom: boolean;
  /** `\r\n` pairs. */
  crlf: number;
  /** `\n` with no `\r` before it. Any at all means the endings were rewritten. */
  loneLf: number;
  /** `\r` with no `\n` after it. Classic-Mac endings, or a truncated write. */
  loneCr: number;
  /** Lines, counted the way the parser counts them: `split(/\r?\n/)`. */
  lines: number;
  /** The bytes decode as UTF-8 without a replacement character. */
  utf8: boolean;
}

/** Read the bytes' shape. Never repairs anything — see the header. */
export function inspectEncoding(bytes: Uint8Array): EncodingReport {
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;

  let crlf = 0;
  let loneLf = 0;
  let loneCr = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === 0x0a) {
      if (i > 0 && bytes[i - 1] === 0x0d) crlf += 1;
      else loneLf += 1;
    } else if (bytes[i] === 0x0d && bytes[i + 1] !== 0x0a) {
      loneCr += 1;
    }
  }

  let utf8 = true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    utf8 = false;
  }

  return {
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bom,
    crlf,
    loneLf,
    loneCr,
    lines: decode(bytes).split(/\r?\n/).length,
    utf8,
  };
}

/** The bytes as text, BOM and all — exactly what `readFileSync(p, 'utf8')` hands the seed. */
export const decode = (bytes: Uint8Array): string => Buffer.from(bytes).toString('utf8');

/** Is this file's encoding the one canon is stored in? BOM + CRLF throughout + valid UTF-8. */
export function encodingPreserved(report: EncodingReport): boolean {
  return report.bom && report.utf8 && report.loneLf === 0 && report.loneCr === 0;
}

/** One line of `key value` detail about a file's bytes. */
export const describeEncoding = (report: EncodingReport): string =>
  `${report.bytes} bytes, ${report.lines} lines, BOM ${report.bom ? 'yes' : 'NO'}, ` +
  `CRLF ${report.crlf}, lone LF ${report.loneLf}, lone CR ${report.loneCr}, ` +
  `UTF-8 ${report.utf8 ? 'ok' : 'INVALID'}`;

/* ==== the document's shape ========================================================== */

/** A run of lines under one World Timeline heading. 1-based, inclusive. */
export interface SectionSpan {
  /** The heading, or `null` for everything above the `World Timeline:` line. */
  section: string | null;
  startLine: number;
  endLine: number;
}

/**
 * Where each World Timeline section starts and ends, by the parser's own rule: below the
 * `World Timeline:` anchor, any non-blank line that is not a `"* "` bullet is the next
 * heading.
 *
 * That rule keeps running to end of file, so the tail matter ("Glossary", "To-Do:") shows
 * up here as sections too. That is faithful rather than sloppy — those headings are
 * exactly what the parser would treat as sections, and a diff that lands in one of them
 * should be reported under the name the parser would use.
 */
export function sectionSpans(text: string): SectionSpan[] {
  const lines = text.split(/\r?\n/);
  const anchor = lines.findIndex((line) => line.trim() === WORLD_TIMELINE_HEADING);
  if (anchor === -1) {
    return lines.length === 0 ? [] : [{ section: null, startLine: 1, endLine: lines.length }];
  }

  const spans: SectionSpan[] = [{ section: null, startLine: 1, endLine: anchor + 1 }];
  for (let index = anchor + 1; index < lines.length; index += 1) {
    const raw = (lines[index] ?? '').trim();
    if (raw === '' || raw.startsWith('* ')) continue;
    const previous = spans[spans.length - 1];
    if (previous !== undefined) previous.endLine = index;
    spans.push({ section: raw, startLine: index + 1, endLine: lines.length });
  }
  return spans;
}

/** The section a 1-based line falls in — `null` above the World Timeline. */
export function sectionOfLine(spans: readonly SectionSpan[], line: number): string | null {
  for (const span of spans) {
    if (line >= span.startLine && line <= span.endLine) return span.section;
  }
  return null;
}

/** The World Timeline headings this text carries, in document order. */
export const headingsIn = (text: string): string[] =>
  sectionSpans(text)
    .map((span) => span.section)
    .filter((section): section is string => section !== null);

/** Which of `required` this text is missing. Empty is the only acceptable answer. */
export const missingHeadings = (text: string, required: readonly string[]): string[] => {
  const present = new Set(headingsIn(text));
  return required.filter((section) => !present.has(section));
};

/**
 * Bullets per section, counted by the REAL parser — not by a regex that agrees with it
 * today. A section that silently drops to zero is the failure that matters most here, and
 * only the parser's own reading of the file can report it honestly.
 *
 * @throws {CanonDriftError} if the World Timeline or any named heading is absent.
 */
export function sectionBulletCounts(
  text: string,
  sections: readonly string[] = WORLD_TIMELINE_SECTIONS,
): Map<string, number> {
  const counts = new Map<string, number>(sections.map((section) => [section, 0]));
  for (const bullet of readWorldTimelineBullets(text, sections)) {
    counts.set(bullet.section, (counts.get(bullet.section) ?? 0) + 1);
  }
  return counts;
}

/* ==== the diff ====================================================================== */

/** One contiguous change. Line numbers are 1-based; a zero-length side is pure ins/del. */
export interface DiffHunk {
  beforeStart: number;
  beforeLines: number;
  afterStart: number;
  afterLines: number;
}

/** What moved, without reproducing the document. */
export interface DiffSummary {
  hunks: DiffHunk[];
  added: number;
  removed: number;
}

/**
 * The LCS matrix is O(n·m) cells. The Bible is ~1,100 lines and the common prefix and
 * suffix are trimmed first, so the real cost is a few thousand cells; this cap exists so a
 * pathological `--from` degrades into a named error instead of a swap storm.
 */
const MAX_DIFF_CELLS = 4_000_000;

/** The diff could not be computed — reported as inconclusive, never as "no changes". */
export class DiffTooLargeError extends Error {
  override name = 'DiffTooLargeError';
}

/**
 * A hunk-level unified diff, WITHOUT the text. The reader wants to know where the document
 * moved, not to re-read the document — a 236 KB dump would bury the two-bullet change that
 * is the whole point of running this.
 */
export function diffLines(before: readonly string[], after: readonly string[]): DiffSummary {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const a = before.slice(prefix, before.length - suffix);
  const b = after.slice(prefix, after.length - suffix);
  const n = a.length;
  const m = b.length;

  if (n === 0 && m === 0) return { hunks: [], added: 0, removed: 0 };
  if (n === 0 || m === 0) {
    return {
      hunks: [{ beforeStart: prefix + 1, beforeLines: n, afterStart: prefix + 1, afterLines: m }],
      added: m,
      removed: n,
    };
  }
  if (n * m > MAX_DIFF_CELLS) {
    throw new DiffTooLargeError(
      `the changed region is ${n}x${m} lines, over the ${MAX_DIFF_CELLS}-cell diff budget`,
    );
  }

  // dp[i][j] = length of the LCS of a[i..] and b[j..], filled from the end so the
  // backtrack below can walk forward and emit hunks in document order.
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  const at = (i: number, j: number): number => dp[i * width + j] ?? 0;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }

  const hunks: DiffHunk[] = [];
  let added = 0;
  let removed = 0;
  let open: DiffHunk | null = null;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      if (open !== null) {
        hunks.push(open);
        open = null;
      }
      i += 1;
      j += 1;
      continue;
    }
    if (open === null) {
      open = {
        beforeStart: prefix + i + 1,
        beforeLines: 0,
        afterStart: prefix + j + 1,
        afterLines: 0,
      };
    }
    if (j >= m || (i < n && at(i + 1, j) >= at(i, j + 1))) {
      open.beforeLines += 1;
      removed += 1;
      i += 1;
    } else {
      open.afterLines += 1;
      added += 1;
      j += 1;
    }
  }
  if (open !== null) hunks.push(open);

  return { hunks, added, removed };
}

/** How a section reads in the report when a change lands above the World Timeline. */
export const OUTSIDE_TIMELINE = '(above the World Timeline)';

/** Every section one hunk touches, on either side of the change. */
export function hunkSections(
  hunk: DiffHunk,
  beforeSpans: readonly SectionSpan[],
  afterSpans: readonly SectionSpan[],
): string[] {
  const names = new Set<string>();
  const collect = (spans: readonly SectionSpan[], start: number, count: number): void => {
    // A zero-length side still has a position; report the section it would be inserted
    // into rather than dropping the hunk out of the section summary entirely.
    const last = start + Math.max(count, 1) - 1;
    for (let line = start; line <= last; line += 1) {
      names.add(sectionOfLine(spans, line) ?? OUTSIDE_TIMELINE);
    }
  };
  collect(beforeSpans, hunk.beforeStart, hunk.beforeLines);
  collect(afterSpans, hunk.afterStart, hunk.afterLines);
  return [...names];
}

/* ==== the gates ===================================================================== */

/** One validation gate and what it found. */
export interface Gate {
  name: string;
  ok: boolean;
  /** Printed indented under the gate. Populated on failure; often on success too. */
  detail: string[];
}

/** The whole verdict on a staged export. */
export interface Validation {
  gates: Gate[];
  ok: boolean;
  /** Per-section bullet counts, or `null` if the file could not be parsed that far. */
  counts: Map<string, number> | null;
  /** The drift guard's ledger, or `null` if it did not run or did not pass. */
  ledger: SectionLedger[] | null;
}

/**
 * Every gate that must pass before an export may be installed over the Bible.
 *
 * They run in cost order and they SHORT-CIRCUIT downwards, because a later gate run on a
 * file that failed an earlier one reports noise: `readWorldTimelineBullets` throws on a
 * missing heading, and "the parser threw" is a worse message than "the heading is gone".
 */
export function encodingGate(encoding: EncodingReport): Gate {
  const problems: string[] = [];
  if (!encoding.bom) problems.push('no UTF-8 BOM — the export was re-encoded');
  if (!encoding.utf8) problems.push('the bytes are not valid UTF-8');
  if (encoding.loneLf > 0) {
    problems.push(
      `${encoding.loneLf} bare LF ending(s) — the line endings were normalised to LF, ` +
        'which lands in `git diff` as though the author had rewritten every line',
    );
  }
  if (encoding.loneCr > 0) problems.push(`${encoding.loneCr} bare CR ending(s)`);
  return {
    name: 'encoding preserved — UTF-8 with BOM, CRLF throughout',
    ok: problems.length === 0,
    detail: problems.length === 0 ? [describeEncoding(encoding)] : problems,
  };
}

export function validateBible(text: string, encoding: EncodingReport): Validation {
  const gates: Gate[] = [];
  let counts: Map<string, number> | null = null;
  let ledger: SectionLedger[] | null = null;

  /* -- encoding. Checked, never repaired: see the header. ---------------------------- */
  gates.push(encodingGate(encoding));

  /* -- the anchor -------------------------------------------------------------------- */
  const anchorLine =
    text.split(/\r?\n/).findIndex((line) => line.trim() === WORLD_TIMELINE_HEADING) + 1;
  gates.push({
    name: `"${WORLD_TIMELINE_HEADING}" present`,
    ok: anchorLine > 0,
    detail:
      anchorLine > 0
        ? [`L${anchorLine}`]
        : ['every transcribed bullet hangs off it — the whole slice would seed as nothing'],
  });
  if (anchorLine === 0) return { gates, ok: false, counts, ledger };

  /* -- the four headings ------------------------------------------------------------- */
  const missing = missingHeadings(text, WORLD_TIMELINE_SECTIONS);
  gates.push({
    name: `all ${WORLD_TIMELINE_SECTIONS.length} section headings present`,
    ok: missing.length === 0,
    detail:
      missing.length === 0
        ? [WORLD_TIMELINE_SECTIONS.join(' · ')]
        : [
            `missing: ${missing.map((section) => `"${section}"`).join(', ')}`,
            'a renamed heading parses as an empty section rather than failing, which is why',
            'this is checked by name and not inferred from a bullet count',
          ],
  });
  if (missing.length > 0) return { gates, ok: false, counts, ledger };

  /* -- every section still has bullets ----------------------------------------------- */
  try {
    counts = sectionBulletCounts(text);
  } catch (error) {
    gates.push({
      name: 'every section parses to at least one bullet',
      ok: false,
      detail: [error instanceof Error ? error.message : String(error)],
    });
    return { gates, ok: false, counts, ledger };
  }
  const empty = [...counts].filter(([, bullets]) => bullets === 0).map(([section]) => section);
  gates.push({
    name: 'every section parses to at least one bullet',
    ok: empty.length === 0,
    detail:
      empty.length === 0
        ? [[...counts].map(([section, bullets]) => `${section} ${bullets}`).join(' · ')]
        : [
            `${empty.map((section) => `"${section}"`).join(', ')} parse(s) to zero bullets`,
            'the heading survived and its contents did not — the failure that matters most,',
            'because nothing downstream raises on an empty section',
          ],
  });
  if (empty.length > 0) return { gates, ok: false, counts, ledger };

  /* -- the drift guard --------------------------------------------------------------- */
  // The seed's own check, run here so a Bible that breaks the existing transcription is
  // refused BEFORE it is installed rather than at the next `db:seed`.
  try {
    const resolution = resolveCanonEvents(readWorldTimelineBullets(text, TRANSCRIBED_SECTIONS));
    ledger = resolution.ledger;
    gates.push({
      name: `canon drift guard over ${TRANSCRIBED_SECTIONS.join(', ')}`,
      ok: true,
      detail: ledger.map(
        (entry) =>
          `${entry.section}: ${entry.bullets} bullet(s) -> ${entry.events} event(s), ` +
          `${entry.bulletsWithEvent} claimed as event(s), ${entry.bulletsWithoutEvent} as non-event(s)`,
      ),
    });
  } catch (error) {
    if (!(error instanceof CanonDriftError)) throw error;
    gates.push({
      name: `canon drift guard over ${TRANSCRIBED_SECTIONS.join(', ')}`,
      ok: false,
      detail: error.message.split('\n'),
    });
  }

  return { gates, ok: gates.every((gate) => gate.ok), counts, ledger };
}

/**
 * The encoding-only verdict, for a document no code reads yet (P4B.2.5).
 *
 * One gate, and the report says as much rather than implying a parser ran. Nothing here
 * can tell a good Story Document from a truncated one — that check arrives with the first
 * code that reads it.
 */
export function validateOpaque(encoding: EncodingReport): Validation {
  const gate = encodingGate(encoding);
  return { gates: [gate], ok: gate.ok, counts: null, ledger: null };
}

/* ==== provenance ==================================================================== */

/** The record written beside an installed document. */
export interface Provenance {
  doc: string;
  title: string;
  driveDocId: string;
  target: string;
  bytes: number;
  sha256: string;
  lines: number;
  encoding: { bom: boolean; newline: 'crlf' };
  /** Per-section bullet counts at sync time, or `null` for an unparsed document. */
  worldTimelineBullets: Record<string, number> | null;
  /** Where the export was staged, for the person retracing the sync. */
  source: string;
  syncedAt: string;
  note: string;
}

/** `data/story_docs/LIFEstream Bible.provenance.json` next to the document it describes. */
export const provenancePathFor = (target: string): string =>
  path.join(path.dirname(target), `${path.basename(target, path.extname(target))}.provenance.json`);

export function buildProvenance(
  doc: string,
  spec: DocSpec,
  encoding: EncodingReport,
  counts: Map<string, number> | null,
  sourcePath: string,
  now: Date,
): Provenance {
  return {
    doc,
    title: spec.title,
    driveDocId: spec.driveId,
    target: spec.target,
    bytes: encoding.bytes,
    sha256: encoding.sha256,
    lines: encoding.lines,
    encoding: { bom: encoding.bom, newline: 'crlf' },
    worldTimelineBullets: counts === null ? null : Object.fromEntries(counts),
    source: sourcePath,
    syncedAt: now.toISOString(),
    note:
      'Fetched outside this script (see scripts/sync-docs.ts) and installed by ' +
      '`sync-docs --write`. Drive modifiedTime is deliberately NOT recorded: every ' +
      'document in that folder carries a near-identical timestamp from a bulk move, so ' +
      'it is not evidence of an edit. The sha256 and the diff are.',
  };
}

/* ==== the CLI ======================================================================= */

const PASS = 0;
const FAILED = 1;
const INCONCLUSIVE = 2;

/** Hunks listed individually before the report starts costing more than it tells. */
const MAX_LISTED_HUNKS = 20;

const USAGE = [
  'usage: npx tsx scripts/sync-docs.ts --doc <name> --from <path> [--write] [--quiet]',
  '',
  '  --doc <name>   which document. One of: ' + Object.keys(DOCS).join(', '),
  '  --from <path>  the fetched export to check. THIS SCRIPT DOES NOT FETCH — the',
  '                 documents are private and the only Drive access here is an',
  '                 assistant-side connector, not a credential a Node process holds.',
  '                 Export the doc as plain text elsewhere and pass the file in.',
  '  --write        install it over the repo copy and record provenance. Without this',
  '                 the run is a DRY RUN that writes nothing — pulling canon is a',
  '                 decision, not a side effect of running a script.',
  '  --quiet        print the gates and the verdict, not the diff detail.',
  '  --help',
  '',
  '  --first           this document has no installed copy yet and that is expected;',
  '                    only meaningful with --write, and never implied by it.',
  '',
  '  exit 0 = validated · 1 = a gate failed or the command could not run · 2 = inconclusive',
];

/**
 * Which hunks to print when there are more than the budget.
 *
 * NOT the first N. The Bible's prose sits above the World Timeline and churns far more
 * than the timeline does — on the 5 Sep export, 27 of 29 hunks are prose and the two that
 * move canon are the last two. Listing in document order therefore truncates away the only
 * hunks the reader came for. So every hunk touching one of the four sections is listed, the
 * rest fill what is left of the budget, and the result is printed back in document order.
 */
export function chooseListedHunks(
  hunks: readonly DiffHunk[],
  beforeSpans: readonly SectionSpan[],
  afterSpans: readonly SectionSpan[],
  budget: number = MAX_LISTED_HUNKS,
): DiffHunk[] {
  const canon = new Set(WORLD_TIMELINE_SECTIONS);
  const touchesCanon = (hunk: DiffHunk): boolean =>
    hunkSections(hunk, beforeSpans, afterSpans).some((section) => canon.has(section));

  const chosen = new Set(hunks.filter(touchesCanon));
  for (const hunk of hunks) {
    if (chosen.size >= budget) break;
    chosen.add(hunk);
  }
  return hunks.filter((hunk) => chosen.has(hunk));
}

/** Left-pad a number so a column of counts lines up. */
const pad = (value: number, width: number): string => String(value).padStart(width);

function main(argv: readonly string[]): number {
  let args: Record<string, string | boolean>;
  try {
    args = parseArgs(argv, {
      flags: ['--write', '--first', '--quiet', '--help'],
      options: ['--doc', '--from'],
    });
  } catch (error) {
    console.error(`sync-docs: ${error instanceof Error ? error.message : String(error)}`);
    console.error(USAGE.join('\n'));
    return FAILED;
  }
  if (args.help === true) {
    console.log(USAGE.join('\n'));
    return PASS;
  }

  assertLifestreamRepo();

  const docName = typeof args.doc === 'string' ? args.doc : undefined;
  if (docName === undefined) {
    console.error('sync-docs: --doc is required.');
    console.error(USAGE.join('\n'));
    return FAILED;
  }
  const spec = DOCS[docName];
  if (spec === undefined) {
    console.error(`sync-docs: no document named "${docName}".`);
    for (const [name, entry] of Object.entries(DOCS)) {
      console.error(`  ${name.padEnd(6)} ${entry.title}  ${entry.driveId}`);
    }
    console.error('  the other five documents in the folder feed nothing yet (P4B.5).');
    return FAILED;
  }

  const from = typeof args.from === 'string' ? args.from : undefined;
  if (from === undefined) {
    console.error('sync-docs: --from is required — this script checks an export, it cannot');
    console.error('  fetch one. See the header of scripts/sync-docs.ts for why.');
    return FAILED;
  }

  const stagedPath = path.resolve(from);
  const targetPath = path.join(repoRoot, spec.target);
  if (!existsSync(stagedPath) || !statSync(stagedPath).isFile()) {
    console.error(`sync-docs: no file at ${stagedPath}.`);
    return FAILED;
  }
  if (stagedPath === targetPath) {
    console.error(`sync-docs: --from is the installed copy itself (${rel(targetPath)}).`);
    console.error('  there is nothing to compare it against, and installing it is a no-op.');
    return FAILED;
  }

  const write = args.write === true;
  const first = args.first === true;
  const quiet = args.quiet === true;

  const stagedBytes = readFileSync(stagedPath);
  const stagedText = decode(stagedBytes);
  const stagedEncoding = inspectEncoding(stagedBytes);

  console.log(`sync-docs: ${docName} — ${spec.title}`);
  console.log(`  document   ${spec.driveId}  (Google Docs; exported outside this script)`);
  console.log(`  staged     ${rel(stagedPath)}`);
  console.log(`  installed  ${rel(targetPath)}`);
  console.log(`  mode       ${write ? 'WRITE — will install if every gate passes' : 'dry run'}`);

  /* -- half one: the comparison ------------------------------------------------------ */
  const installed = existsSync(targetPath) ? readFileSync(targetPath) : null;
  let verdict = PASS;
  let installedCounts: Map<string, number> | null = null;
  // Hoisted out of the comparison block below: the canon change report (P4B.6) needs BOTH
  // sides, and it is printed after the gates have had their say about the staged one.
  let installedTimelineText: string | null = null;
  let changeReport: CanonChangeReport | null = null;

  console.log('');
  console.log('encoding');
  console.log(`  staged     ${describeEncoding(stagedEncoding)}`);
  console.log(`  sha256     ${stagedEncoding.sha256}`);

  if (installed === null) {
    console.log('');
    console.log(`no installed copy at ${rel(targetPath)} — there is nothing to compare against,`);
    console.log('  so nothing has been proved about DRIFT. The gates below still ran; what is');
    console.log('  missing is a baseline, not a check.');
    if (first) {
      // `--first` is a separate flag from `--write` on purpose. A plain `--write` must keep
      // refusing here: the overwhelmingly common reason there is no installed copy is a
      // typo'd `--doc` or a target path that moved, and silently creating a new file is how
      // a sync ends up writing canon to a path nothing reads. Placing a genuinely new
      // document is rare and deliberate, so it says so.
      console.log('  --first given: this is a deliberate first placement, so the missing');
      console.log('  baseline is expected rather than a failure.');
    } else {
      console.log('  Pass --first alongside --write if this is a new document being added;');
      console.log('  otherwise check --doc and the target path.');
      verdict = INCONCLUSIVE;
    }
  } else {
    const installedEncoding = inspectEncoding(installed);
    const installedText = decode(installed);
    installedTimelineText = installedText;
    console.log(`  installed  ${describeEncoding(installedEncoding)}`);
    console.log(`  sha256     ${installedEncoding.sha256}`);

    console.log('');
    if (installedEncoding.sha256 === stagedEncoding.sha256) {
      console.log('diff       identical — the staged export is byte-for-byte the installed copy.');
      console.log('           (Drive modifiedTime would still differ; it is not evidence.)');
    } else {
      try {
        // Split on `/\r?\n/`, the parser's own rule, so the diff is ending-AGNOSTIC: an
        // export normalised to LF reports its two real edits here and fails the encoding
        // gate, instead of reporting 1,100 changed lines and burying them.
        const beforeLines = installedText.split(/\r?\n/);
        const afterLines = stagedText.split(/\r?\n/);
        const summary = diffLines(beforeLines, afterLines);
        const beforeSpans = sectionSpans(installedText);
        const afterSpans = sectionSpans(stagedText);

        console.log(
          `diff       ${summary.hunks.length} hunk(s), +${summary.added} -${summary.removed} line(s)`,
        );
        const changed = new Set<string>();
        for (const hunk of summary.hunks) {
          for (const section of hunkSections(hunk, beforeSpans, afterSpans)) changed.add(section);
        }
        console.log(`  sections   ${[...changed].join(', ')}`);
        const canonTouched = WORLD_TIMELINE_SECTIONS.filter((section) => changed.has(section));
        console.log(
          canonTouched.length === 0
            ? '  none of the four World Timeline sections moved'
            : `  World Timeline sections changed: ${canonTouched.join(', ')}`,
        );

        if (!quiet) {
          const listed = chooseListedHunks(summary.hunks, beforeSpans, afterSpans);
          for (const hunk of listed) {
            const where = hunkSections(hunk, beforeSpans, afterSpans).join(' / ');
            console.log(
              `    L${pad(hunk.beforeStart, 5)} -> L${pad(hunk.afterStart, 5)}  ` +
                `+${pad(hunk.afterLines, 3)} -${pad(hunk.beforeLines, 3)}  ${where}`,
            );
          }
          if (listed.length < summary.hunks.length) {
            console.log(
              `    … ${summary.hunks.length - listed.length} more hunk(s) not listed, none of ` +
                'them in a World Timeline section. This is a map, not the document.',
            );
          }
        }
      } catch (error) {
        if (!(error instanceof DiffTooLargeError)) throw error;
        console.log(`diff       could not be computed: ${error.message}`);
        verdict = INCONCLUSIVE;
      }
    }

    if (spec.gates === 'world-timeline') {
      try {
        installedCounts = sectionBulletCounts(installedText);
      } catch {
        installedCounts = null;
      }
    }
  }

  /* -- half two: the gates ----------------------------------------------------------- */
  const validation =
    spec.gates === 'world-timeline'
      ? validateBible(stagedText, stagedEncoding)
      : validateOpaque(stagedEncoding);

  if (spec.gates === 'world-timeline' && validation.counts !== null) {
    console.log('');
    console.log('World Timeline bullets   installed -> staged');
    const width = Math.max(...WORLD_TIMELINE_SECTIONS.map((section) => section.length));
    for (const section of WORLD_TIMELINE_SECTIONS) {
      const after = validation.counts.get(section) ?? 0;
      const before = installedCounts?.get(section);
      const delta =
        before === undefined
          ? ''
          : after === before
            ? ''
            : `   ${after > before ? '+' : ''}${after - before}`;
      console.log(
        `  ${section.padEnd(width)}  ${pad(before ?? 0, 3)}${before === undefined ? '  ?' : ''}` +
          ` -> ${pad(after, 3)}${delta}`,
      );
    }
    if (installedCounts === null) {
      console.log(
        '  (the installed copy could not be parsed, so the left column is not a reading)',
      );
    }
  }

  /* -- the canon change report (P4B.6) ----------------------------------------------- */
  // Bullet counts above say a section grew by two. This says WHICH two, what happened to
  // the other eighty, and whether anything in `events.ts` was reading one of them — the
  // half of the check that a file which merely still PARSES cannot give.
  //
  // It needs both documents parsed all the way. When either side could not be read that
  // far, a gate above has already failed and set the verdict; there is nothing honest to
  // report here, so it says so rather than reporting a partial reading as a clean one.
  let changeGate: Gate | null = null;
  if (spec.gates === 'world-timeline') {
    console.log('');
    if (installedTimelineText === null || installedCounts === null || validation.counts === null) {
      console.log('canon change report   not computed — one of the two documents did not parse.');
      console.log('  Nothing has been proved about what MOVED; see the failing gate below.');
    } else {
      changeReport = buildCanonChangeReport(
        readWorldTimelineBullets(installedTimelineText, WORLD_TIMELINE_SECTIONS),
        readWorldTimelineBullets(stagedText, WORLD_TIMELINE_SECTIONS),
        WORLD_TIMELINE_SECTIONS,
      );
      for (const line of renderCanonChangeReport(changeReport, quiet)) console.log(line);
      changeGate = {
        name: 'no changed bullet is claimed by an authored reading in events.ts',
        ok: changeReport.actionable.length === 0,
        detail: actionableGateDetail(changeReport),
      };
      validation.gates.push(changeGate);
    }
  }

  console.log('');
  console.log('gates');
  for (const gate of validation.gates) {
    console.log(`  ${gate.ok ? 'OK  ' : 'FAIL'}  ${gate.name}`);
    for (const line of gate.detail) console.log(`        ${line}`);
  }
  if (spec.gates === 'encoding-only') {
    console.log('        no code reads this document yet, so encoding and the diff are the only');
    console.log('        checks that can mean anything (P4B.2.5). There is no parser to run.');
  }
  console.log('');
  console.log("  citations are NOT checked here. `verifyCitations` is the SEED's gate and runs");
  console.log('  on `npm run db:seed`; an export that passes above can still fail there.');

  if (!validation.ok || changeGate?.ok === false) verdict = FAILED;

  /* -- half three: the install ------------------------------------------------------- */
  console.log('');
  if (!write) {
    console.log('dry run — nothing was written. Re-run with --write to install.');
  } else if (verdict !== PASS) {
    console.log('--write REFUSED — the run did not come back clean. Nothing was written.');
  } else {
    const identical =
      installed !== null && inspectEncoding(installed).sha256 === stagedEncoding.sha256;
    if (identical) {
      console.log(`${rel(targetPath)} is already these bytes — not rewritten.`);
    } else {
      // The bytes go through untouched. Not `writeFileSync(target, text)`: re-encoding a
      // decoded string is exactly the silent normalisation the header refuses.
      writeFileSync(targetPath, stagedBytes);
      console.log(`installed ${stagedEncoding.bytes} bytes -> ${rel(targetPath)}`);
    }
    const provenancePath = provenancePathFor(targetPath);
    const record = buildProvenance(
      docName,
      spec,
      stagedEncoding,
      validation.counts,
      stagedPath,
      new Date(),
    );
    writeFileSync(provenancePath, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`provenance -> ${rel(provenancePath)}`);
    if (changeReport !== null && installed !== null) {
      // Committed with the Bible it describes (P4B.6.5), so the commit that installs a new
      // canon carries the reasoning for what it changed.
      const reportPath = changeReportPathFor(targetPath);
      writeFileSync(
        reportPath,
        renderCanonChangeMarkdown(changeReport, {
          doc: docName,
          title: spec.title,
          source: rel(stagedPath),
          installedSha256: inspectEncoding(installed).sha256,
          stagedSha256: stagedEncoding.sha256,
          generatedAt: new Date(),
        }),
      );
      console.log(`change report -> ${rel(reportPath)}`);
    }
  }

  console.log('');
  if (verdict === FAILED) {
    console.error('sync-docs FAILED — the staged export must not be installed.');
  } else if (verdict === INCONCLUSIVE) {
    console.log('sync-docs INCONCLUSIVE — the check did not complete. This is not a pass.');
  } else {
    console.log(
      write
        ? 'sync-docs OK — installed. Run `npm run db:seed` next: citations are checked there.'
        : 'sync-docs OK — the staged export validates and is safe to install with --write.',
    );
  }
  return verdict;
}

/**
 * Run only when invoked as the entry point, so the spec can import the pure halves above
 * without the CLI firing (and without a `process.exit` inside a test run).
 */
const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(path.resolve(entry)).href === import.meta.url) {
  process.exit(main(process.argv.slice(2)));
}
