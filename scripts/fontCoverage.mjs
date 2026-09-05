// `node scripts/fontCoverage.mjs` — which codepoints does the vendored label font actually
// have a glyph for, and does the corpus stay inside them?
//
// ## Why this exists (P4 review, major 5)
//
// `client/public/fonts/Sora-SemiBold.ttf` was vendored so drei's `<Text>` stops fetching a
// face from jsdelivr — without it every label is blank offline. That fixed the *font*
// fetch and left a second one standing: troika bundles `@unicode-font-resolver/client` and
// calls `getFontsForString()` for any codepoint the supplied font does **not** cover,
// against a hardcoded
// `https://cdn.jsdelivr.net/gh/lojjic/unicode-font-resolver@v1.0.1/packages/data`.
// `resolveFallbacks()` has no `.catch`, so offline that promise rejects, `allDone()` never
// fires, and **the whole label** — not just the missing glyph — never renders, plus an
// unhandled rejection in the console. Setting `unicodeFontsURL` to a local copy does not
// disable the path; it falls back to the CDN on failure.
//
// So "the font covers the corpus" is a hard requirement, not a nicety, and one arrow in
// one title is enough to silently blank that node's label. This is the executable form of
// that requirement.
//
// It is a **script rather than a test helper** on purpose: `tests/fontCoverage.test.ts`
// guards the fixture, but P5 seeds 68 more bullets straight into the database, and a
// seeding gate needs something runnable that never imports the test runner.
//
// ## What it reads
//
// A TrueType/OpenType `cmap`, formats **4** (segment-mapped BMP — what a Google latin
// subset ships) and **12** (segmented coverage, UCS-4 — what a fuller re-vendoring would
// ship). Formats 0, 2, 6, 13 and 14 are ignored: 0/2/6 are legacy non-Unicode Macintosh
// tables whose "coverage" would be meaningless here, and 14 is a variation-selector
// supplement that grants no base coverage of its own. A font offering only those reads as
// zero coverage, which fails loudly rather than passing vacuously.
//
// Exit 0 = every codepoint covered · 1 = something is uncovered · 2 = inconclusive.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { assertLifestreamRepo, parseArgs, rel, repoRoot } from './lib/repo.mjs';

const PASS = 0;
const VIOLATION = 1;
const INCONCLUSIVE = 2;

/** The face drei's `<Text>` is pointed at. Repo-root-relative, resolved from this file. */
export const VENDORED_FONT = path.join(repoRoot, 'client/public/fonts/Sora-SemiBold.ttf');

// ---------------------------------------------------------------------------
// sfnt table directory
// ---------------------------------------------------------------------------

/** `0x00010000` (TrueType outlines) and `OTTO` (CFF outlines) both carry a normal `cmap`. */
const SFNT_VERSIONS = new Set([0x00010000, 0x4f54544f, 0x74727565]);

/**
 * Byte offset of a named table, or `undefined`.
 *
 * @param {Buffer} buf
 * @param {string} tag four-character table tag, e.g. `cmap`
 * @returns {{ offset: number; length: number } | undefined}
 */
function findTable(buf, tag) {
  if (buf.length < 12) throw new RangeError('fontCoverage: file is too short to be a font');
  const version = buf.readUInt32BE(0);
  if (!SFNT_VERSIONS.has(version)) {
    throw new RangeError(
      `fontCoverage: not an sfnt font (leading bytes 0x${version.toString(16).padStart(8, '0')}). ` +
        'WOFF/WOFF2 are compressed containers and are not read here.',
    );
  }
  const numTables = buf.readUInt16BE(4);
  for (let i = 0; i < numTables; i++) {
    const record = 12 + i * 16;
    if (record + 16 > buf.length) break;
    if (buf.toString('latin1', record, record + 4) !== tag) continue;
    return { offset: buf.readUInt32BE(record + 8), length: buf.readUInt32BE(record + 12) };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// cmap subtables
// ---------------------------------------------------------------------------

/**
 * Is this encoding record a Unicode one?
 *
 * Platform 0 is Unicode by definition. Platform 3 (Windows) is Unicode at encoding 1 (BMP)
 * and 10 (full repertoire); encoding 0 is the **symbol** encoding, which remaps glyphs into
 * the U+F000 private-use block — counting it would report coverage of codepoints no title
 * will ever contain while missing the ones it does.
 *
 * @param {number} platformId
 * @param {number} encodingId
 */
function isUnicodeEncoding(platformId, encodingId) {
  if (platformId === 0) return true;
  return platformId === 3 && (encodingId === 1 || encodingId === 10);
}

/**
 * Format 4 — segment mapping to delta values, the BMP workhorse.
 *
 * The trailing segment is `0xFFFF → 0xFFFF` with `idDelta = 1`, which yields glyph 0 and is
 * therefore excluded by the same `glyph !== 0` test as everything else; it needs no special
 * case. `idRangeOffset` is a byte offset *from its own address*, which is why the address is
 * recomputed per segment rather than treated as an index.
 *
 * @param {Buffer} buf
 * @param {number} at subtable offset
 * @param {Set<number>} into
 */
function readFormat4(buf, at, into) {
  const segCount = buf.readUInt16BE(at + 6) / 2;
  const endBase = at + 14;
  const startBase = at + 16 + segCount * 2;
  const deltaBase = at + 16 + segCount * 4;
  const rangeOffsetBase = at + 16 + segCount * 6;
  const subtableEnd = at + buf.readUInt16BE(at + 2);

  for (let seg = 0; seg < segCount; seg++) {
    const end = buf.readUInt16BE(endBase + seg * 2);
    const start = buf.readUInt16BE(startBase + seg * 2);
    if (start > end) continue;
    const delta = buf.readInt16BE(deltaBase + seg * 2);
    const rangeOffsetAddr = rangeOffsetBase + seg * 2;
    const rangeOffset = buf.readUInt16BE(rangeOffsetAddr);

    for (let cp = start; cp <= end; cp++) {
      let glyph;
      if (rangeOffset === 0) {
        glyph = (cp + delta) & 0xffff;
      } else {
        const glyphAddr = rangeOffsetAddr + rangeOffset + (cp - start) * 2;
        if (glyphAddr + 2 > Math.min(subtableEnd, buf.length)) continue;
        glyph = buf.readUInt16BE(glyphAddr);
        if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
      }
      if (glyph !== 0) into.add(cp);
    }
  }
}

/**
 * Format 12 — segmented coverage over the full UCS-4 range.
 *
 * Not used by the current latin subset, which is pure format 4. It is here so that
 * re-vendoring a fuller face (the fix for an uncovered codepoint) parses rather than
 * reporting zero coverage and failing for the wrong reason.
 *
 * @param {Buffer} buf
 * @param {number} at subtable offset
 * @param {Set<number>} into
 */
function readFormat12(buf, at, into) {
  const groups = buf.readUInt32BE(at + 12);
  for (let g = 0; g < groups; g++) {
    const record = at + 16 + g * 12;
    if (record + 12 > buf.length) break;
    const start = buf.readUInt32BE(record);
    const end = Math.min(buf.readUInt32BE(record + 4), 0x10ffff);
    const startGlyph = buf.readUInt32BE(record + 8);
    if (start > end) continue;
    for (let cp = start; cp <= end; cp++) {
      if (startGlyph + (cp - start) !== 0) into.add(cp);
    }
  }
}

/**
 * Every codepoint the font at `ttfPath` has a non-`.notdef` glyph for.
 *
 * The **union** of every Unicode format-4/12 subtable, not the "best" one. A font may ship
 * a platform-0 and a platform-3 copy of the same table, and picking one by a preference
 * order is a rule that can be wrong; a union cannot under-report, which is the direction
 * that matters — over-reporting coverage would let a blanking codepoint through the gate.
 *
 * @param {string} ttfPath absolute path to a `.ttf` / `.otf`
 * @returns {Set<number>} codepoints, as numbers
 */
export function readCoveredCodepoints(ttfPath) {
  const buf = readFileSync(ttfPath);
  const cmap = findTable(buf, 'cmap');
  if (!cmap) throw new RangeError(`fontCoverage: ${ttfPath} has no cmap table`);

  const covered = new Set();
  const numSubtables = buf.readUInt16BE(cmap.offset + 2);
  for (let i = 0; i < numSubtables; i++) {
    const record = cmap.offset + 4 + i * 8;
    if (record + 8 > buf.length) break;
    const platformId = buf.readUInt16BE(record);
    const encodingId = buf.readUInt16BE(record + 2);
    if (!isUnicodeEncoding(platformId, encodingId)) continue;

    const at = cmap.offset + buf.readUInt32BE(record + 4);
    if (at + 4 > buf.length) continue;
    const format = buf.readUInt16BE(at);
    if (format === 4) readFormat4(buf, at, covered);
    else if (format === 12) readFormat12(buf, at, covered);
  }
  return covered;
}

// ---------------------------------------------------------------------------
// Checking text against a coverage set
// ---------------------------------------------------------------------------

/**
 * The codepoints of `text` that `covered` does not contain — deduplicated, in order of
 * first appearance.
 *
 * Iterated with `for..of`, which walks **codepoints** rather than UTF-16 code units, so an
 * astral character is reported as the one codepoint troika will ask the resolver about
 * instead of as two lone surrogates.
 *
 * @param {string} text
 * @param {Set<number>} covered from {@link readCoveredCodepoints}
 * @returns {number[]}
 */
export function uncovered(text, covered) {
  const missing = [];
  const seen = new Set();
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (covered.has(cp) || seen.has(cp)) continue;
    seen.add(cp);
    missing.push(cp);
  }
  return missing;
}

/** `0x2192` → `U+2192 →`. For failure messages, where the bare number tells you nothing. */
export function formatCodepoint(cp) {
  const hex = cp.toString(16).toUpperCase().padStart(4, '0');
  const printable = cp >= 0x20 && cp !== 0x7f ? ` ${String.fromCodePoint(cp)}` : '';
  return `U+${hex}${printable}`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = [
  'usage: node scripts/fontCoverage.mjs [options]',
  '',
  '  --font <path>   font to read (default client/public/fonts/Sora-SemiBold.ttf).',
  '  --db <path>     database whose event titles are checked (default data/lifestream.db).',
  '  --text <string> check this string instead of the database.',
  '  --summary       print the covered ranges and exit, checking nothing.',
];

/** Contiguous runs of a sorted codepoint list, as `[lo, hi]` pairs — for `--summary`. */
function ranges(sorted) {
  const out = [];
  for (const cp of sorted) {
    const last = out[out.length - 1];
    if (last && cp === last[1] + 1) last[1] = cp;
    else out.push([cp, cp]);
  }
  return out;
}

async function main() {
  assertLifestreamRepo('fontCoverage', 'nothing was written.');

  let args;
  try {
    args = parseArgs(process.argv.slice(2), {
      flags: ['--summary', '--help'],
      options: ['--font', '--db', '--text'],
    });
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    console.error(USAGE.join('\n'));
    return INCONCLUSIVE;
  }
  if (args.help) {
    console.log(USAGE.join('\n'));
    return PASS;
  }

  const fontPath = args.font ? path.resolve(String(args.font)) : VENDORED_FONT;
  if (!existsSync(fontPath)) {
    console.error(`fontCoverage: no font at ${rel(fontPath)} — nothing could be checked.`);
    return INCONCLUSIVE;
  }

  let covered;
  try {
    covered = readCoveredCodepoints(fontPath);
  } catch (error) {
    console.error(`fontCoverage: ${String(error instanceof Error ? error.message : error)}`);
    return INCONCLUSIVE;
  }
  const sorted = [...covered].sort((a, b) => a - b);
  console.log(`${rel(fontPath)}: ${covered.size} codepoints covered.`);

  if (args.summary) {
    for (const [lo, hi] of ranges(sorted)) {
      console.log(
        lo === hi
          ? `  ${formatCodepoint(lo)}`
          : `  ${formatCodepoint(lo)}..U+${hi.toString(16).toUpperCase().padStart(4, '0')}`,
      );
    }
    return PASS;
  }

  /** @type {Array<{ label: string; text: string }>} */
  const subjects = [];
  if (args.text !== undefined) {
    subjects.push({ label: '--text', text: String(args.text) });
  } else {
    const dbPath = args.db
      ? path.resolve(String(args.db))
      : path.join(repoRoot, 'data/lifestream.db');
    if (!existsSync(dbPath)) {
      console.error(`fontCoverage: no database at ${rel(dbPath)}; pass --text or --db.`);
      return INCONCLUSIVE;
    }
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(`file:${dbPath}?mode=ro`, { readOnly: true });
    try {
      for (const row of db.prepare('select id, title from event order by id').all()) {
        subjects.push({ label: String(row.id), text: String(row.title) });
      }
    } finally {
      db.close();
    }
    console.log(`${rel(dbPath)}: ${subjects.length} event titles.`);
  }

  let violations = 0;
  for (const { label, text } of subjects) {
    const missing = uncovered(text, covered);
    if (missing.length === 0) continue;
    violations++;
    console.error(`  ${label}: ${missing.map(formatCodepoint).join(', ')}`);
    console.error(`    ${JSON.stringify(text)}`);
  }

  if (violations > 0) {
    console.error(
      `\nfontCoverage: ${violations} of ${subjects.length} strings contain a codepoint the font ` +
        'does not cover. troika will ask jsdelivr for a fallback face and, offline, the ENTIRE ' +
        'label will fail to render. Re-vendor a font that covers them, or change the text.',
    );
    return VIOLATION;
  }
  console.log(`fontCoverage: all ${subjects.length} strings are fully covered.`);
  return PASS;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(await main());
}
