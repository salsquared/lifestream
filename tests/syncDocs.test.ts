import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readWorldTimelineBullets } from '@server/seed/events';
import {
  DOCS,
  OUTSIDE_TIMELINE,
  WORLD_TIMELINE_SECTIONS,
  buildProvenance,
  chooseListedHunks,
  diffLines,
  encodingPreserved,
  headingsIn,
  hunkSections,
  inspectEncoding,
  missingHeadings,
  parseArgs,
  provenancePathFor,
  sectionBulletCounts,
  sectionSpans,
  validateBible,
} from '../scripts/sync-docs';

/**
 * P4B.2 — the gates `scripts/sync-docs.ts` puts in front of a fetched Bible export.
 *
 * ── WHY THIS SPEC EXISTS ─────────────────────────────────────────────────────────────
 * The script's whole job is to REFUSE a bad export, and a refusal that never fires is
 * indistinguishable from one that cannot. Every gate below is therefore exercised against
 * a Bible that breaks it, built by mutating the real installed copy — not against a
 * hand-written miniature, because a miniature agrees with whatever the parser happens to
 * do and the real document is the only thing that catches the two apart.
 *
 * Four failures matter, and none of them raises anything on its own:
 *
 *   1. **A renamed heading.** `readWorldTimelineBullets` seeds an EMPTY section rather
 *      than failing — its own comment says so — so a rename reaches the database as
 *      "that era has no events" and nothing anywhere says otherwise.
 *   2. **A section that empties out.** The heading survives, its bullets do not. Same
 *      silence, and it is the failure the sync exists to catch: it is what a botched
 *      export looks like.
 *   3. **A re-encoded export.** Endings normalised to LF or the BOM dropped rewrites
 *      every line in `git diff`, which buries the author's actual edit under 1,100 lines
 *      of noise and is unrecoverable once committed.
 *   4. **Drift against the transcription.** A bullet re-dated upstream unpairs the
 *      authored reading in `events.ts`. `db:seed` would catch it — AFTER the file was
 *      installed and committed, which is one commit too late.
 *
 * ── WHY THE STAGED EXPORT IS BUILT HERE AND NOT READ FROM DISK ───────────────────────
 * The task was exercised against a real 5 Sep 2026 export whose Reconstruction Era ran to
 * two bullets more than the installed copy. That file lives outside the repo, so a spec
 * that read it would pass on one machine and skip on every other — and a skipped gate is
 * the thing this file exists to prevent. So the BEFORE side is the real installed Bible,
 * every byte of it, and the AFTER side inserts exactly the two bullets the real export
 * added. The comparison under test is the same two-bullet move, and it runs everywhere.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const INSTALLED_PATH = path.join(repoRoot, 'data', 'story_docs', 'LIFEstream Bible.txt');

/** The real thing. Read once; every fixture below is a mutation of it. */
const installedBytes = readFileSync(INSTALLED_PATH);
const installedText = installedBytes.toString('utf8');
const installedEncoding = inspectEncoding(installedBytes);

/**
 * The installed copy's bullet counts, as of the 28 May 2026 export.
 *
 * A DATED READING, deliberately pinned. When a sync lands, these move, and this line is
 * part of taking the sync — that is the point: a spec that tracked the file automatically
 * would agree with a Reconstruction Era that had silently dropped to zero.
 */
const INSTALLED_COUNTS: Readonly<Record<string, number>> = {
  'Pre-Big One': 12,
  'North Korean War': 8,
  'Black Fever Era': 21,
  // 39 until the 21 June Bible was taken (P4B.4); the Reconstruction Era gained two.
  // Updating this line is PART OF taking a sync, deliberately — a fixture that tracked the
  // file automatically would agree just as readily with a section that had silently
  // dropped to zero, which is the failure this whole spec exists to make loud.
  'Reconstruction Era': 41,
};

// ---------------------------------------------------------------------------
// Fixture surgery — CRLF in, CRLF out, BOM untouched
// ---------------------------------------------------------------------------

const CRLF = '\r\n';
const split = (text: string): string[] => text.split(CRLF);
const join = (parts: readonly string[]): string => parts.join(CRLF);
const bytesOf = (text: string): Buffer => Buffer.from(text, 'utf8');

/** The index of a heading BELOW the `World Timeline:` anchor — never the prose one above it. */
function timelineHeadingIndex(text: string, heading: string): number {
  const lines = split(text);
  const anchor = lines.findIndex((line) => line.trim() === 'World Timeline:');
  expect(anchor, 'the installed Bible has a World Timeline').toBeGreaterThan(-1);
  const index = lines.findIndex((line, i) => i > anchor && line.trim() === heading);
  expect(
    index,
    `the installed Bible has a "${heading}" heading under the World Timeline`,
  ).toBeGreaterThan(-1);
  return index;
}

/** The half-open bullet range belonging to a World Timeline heading. */
function sectionBody(text: string, heading: string): { start: number; end: number } {
  const lines = split(text);
  const start = timelineHeadingIndex(text, heading) + 1;
  let end = start;
  while (end < lines.length) {
    const raw = (lines[end] ?? '').trim();
    if (raw !== '' && !raw.startsWith('* ')) break;
    end += 1;
  }
  return { start, end };
}

/** A rename is the realistic way a heading goes missing — nobody deletes one. */
function renameHeading(text: string, from: string, to: string): string {
  const lines = split(text);
  lines[timelineHeadingIndex(text, from)] = to;
  return join(lines);
}

/** The botched export: the heading survives, every bullet under it is gone. */
function emptySection(text: string, heading: string): string {
  const lines = split(text);
  const { start, end } = sectionBody(text, heading);
  lines.splice(start, end - start);
  return join(lines);
}

/** The two bullets the 5 Sep export added to the Reconstruction Era. */
function addBullets(text: string, heading: string, bullets: readonly string[]): string {
  const lines = split(text);
  const { end } = sectionBody(text, heading);
  lines.splice(end, 0, ...bullets);
  return join(lines);
}

const stagedText = addBullets(installedText, 'Reconstruction Era', [
  '* 2071: The Corridor Authority publishes its first open register of relocations.',
  '* 2073: The last of the interim camps is decommissioned.',
]);
const stagedBytes = bytesOf(stagedText);

// ---------------------------------------------------------------------------
// The bytes go through untouched
// ---------------------------------------------------------------------------

describe('encoding', () => {
  it('reads the installed Bible as UTF-8 with a BOM and CRLF throughout', () => {
    expect(installedEncoding.bom).toBe(true);
    expect(installedEncoding.utf8).toBe(true);
    expect(installedEncoding.loneLf).toBe(0);
    expect(installedEncoding.loneCr).toBe(0);
    expect(installedEncoding.crlf).toBeGreaterThan(1_000);
    // The document's last line is unterminated, so there is exactly one more line than
    // there are endings. Pinned because `lines` is reported to the author as a count.
    expect(installedEncoding.lines).toBe(installedEncoding.crlf + 1);
    expect(encodingPreserved(installedEncoding)).toBe(true);
  });

  it('hashes the raw bytes, BOM included, and survives a decode/encode round trip', () => {
    // The install path writes the ORIGINAL buffer, never a re-encoded string. This asserts
    // the two are the same bytes, which is what makes that choice checkable rather than
    // merely stated.
    expect(bytesOf(installedText).equals(installedBytes)).toBe(true);
    expect(inspectEncoding(bytesOf(installedText)).sha256).toBe(installedEncoding.sha256);
    expect(installedEncoding.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('detects a stripped BOM', () => {
    const stripped = inspectEncoding(installedBytes.subarray(3));
    expect(stripped.bom).toBe(false);
    expect(stripped.crlf).toBe(installedEncoding.crlf);
    expect(encodingPreserved(stripped)).toBe(false);
  });

  it('detects endings normalised to LF, and says why that is not cosmetic', () => {
    const lf = inspectEncoding(bytesOf(installedText.split(CRLF).join('\n')));
    expect(lf.crlf).toBe(0);
    expect(lf.loneLf).toBe(installedEncoding.crlf);
    expect(encodingPreserved(lf)).toBe(false);

    const gate = validateBible(installedText, lf).gates[0];
    expect(gate?.ok).toBe(false);
    expect(gate?.detail.join(' ')).toContain('git diff');
  });

  it('detects bytes that are not valid UTF-8', () => {
    const broken = inspectEncoding(Buffer.from([0xef, 0xbb, 0xbf, 0xff, 0xfe, 0x0d, 0x0a]));
    expect(broken.utf8).toBe(false);
    expect(encodingPreserved(broken)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The document's shape, cross-checked against the parser that reads it
// ---------------------------------------------------------------------------

describe('sectionSpans', () => {
  it('finds every section the real parser reports bullets under', () => {
    // `WORLD_TIMELINE_HEADING` is restated in sync-docs.ts because events.ts keeps it
    // private. This is the check that keeps the two copies honest: the spans have to name
    // every section the parser itself assigned a bullet to.
    const parsed = new Set(
      readWorldTimelineBullets(installedText, WORLD_TIMELINE_SECTIONS).map((b) => b.section),
    );
    const found = new Set(headingsIn(installedText));
    for (const section of parsed) expect(found).toContain(section);
    for (const section of WORLD_TIMELINE_SECTIONS) expect(found).toContain(section);
  });

  it('puts everything above the World Timeline outside a section', () => {
    const spans = sectionSpans(installedText);
    const first = spans[0];
    expect(first?.section).toBeNull();
    expect(first?.startLine).toBe(1);
    // The Bible's prose carries headings of its own that repeat the era names; none of them
    // may be reported as a World Timeline section.
    expect(spans.filter((span) => span.section === 'Black Fever Era')).toHaveLength(1);
  });

  it('reports no section at all for a document with no World Timeline', () => {
    expect(headingsIn('just some prose\r\nand more of it')).toEqual([]);
  });
});

describe('sectionBulletCounts', () => {
  it('counts the installed Bible section by section', () => {
    expect(Object.fromEntries(sectionBulletCounts(installedText))).toEqual(INSTALLED_COUNTS);
  });

  it('counts a staged export whose Reconstruction Era gained two bullets', () => {
    expect(Object.fromEntries(sectionBulletCounts(stagedText))).toEqual({
      ...INSTALLED_COUNTS,
      'Reconstruction Era': INSTALLED_COUNTS['Reconstruction Era']! + 2,
    });
  });

  it('reports zero for a section whose bullets were dropped, rather than throwing', () => {
    // The heading is still there, so the parser does not object. Only the COUNT says
    // anything is wrong, which is why the gate is a count and not a try/catch.
    const gutted = emptySection(installedText, 'North Korean War');
    expect(sectionBulletCounts(gutted).get('North Korean War')).toBe(0);
    expect(sectionBulletCounts(gutted).get('Black Fever Era')).toBe(21);
  });
});

// ---------------------------------------------------------------------------
// The gates
// ---------------------------------------------------------------------------

const gateNamed = (text: string, encoding = inspectEncoding(bytesOf(text)), fragment = '') =>
  validateBible(text, encoding).gates.find((gate) => gate.name.includes(fragment));

describe('validateBible', () => {
  it('passes a well-formed export — the installed Bible itself', () => {
    const result = validateBible(installedText, installedEncoding);
    expect(result.gates.map((gate) => gate.ok)).toEqual([true, true, true, true, true]);
    expect(result.ok).toBe(true);
    expect(Object.fromEntries(result.counts ?? new Map())).toEqual(INSTALLED_COUNTS);
    expect(result.ledger).toEqual([
      {
        section: 'Pre-Big One',
        bullets: 12,
        events: 13,
        bulletsWithEvent: 12,
        bulletsWithoutEvent: 0,
      },
    ]);
  });

  it('passes the staged export — two new bullets do not break the transcription', () => {
    const result = validateBible(stagedText, inspectEncoding(stagedBytes));
    expect(result.ok).toBe(true);
    expect(result.counts?.get('Reconstruction Era')).toBe(
      INSTALLED_COUNTS['Reconstruction Era']! + 2,
    );
  });

  it('fails, and stops, when a section heading is missing', () => {
    const renamed = renameHeading(installedText, 'Black Fever Era', 'The Black Fever Era');
    const result = validateBible(renamed, inspectEncoding(bytesOf(renamed)));

    expect(result.ok).toBe(false);
    expect(missingHeadings(renamed, WORLD_TIMELINE_SECTIONS)).toEqual(['Black Fever Era']);
    const heading = result.gates.at(-1);
    expect(heading?.name).toContain('section headings present');
    expect(heading?.ok).toBe(false);
    expect(heading?.detail.join(' ')).toContain('"Black Fever Era"');
    // Nothing runs past a missing heading: the parser would throw, and "the parser threw"
    // is a worse report than "the heading is gone".
    expect(result.gates).toHaveLength(3);
    expect(result.counts).toBeNull();
  });

  it('fails when a section parses to zero bullets', () => {
    const gutted = emptySection(installedText, 'North Korean War');
    const result = validateBible(gutted, inspectEncoding(bytesOf(gutted)));

    expect(result.ok).toBe(false);
    const bullets = result.gates.at(-1);
    expect(bullets?.name).toContain('at least one bullet');
    expect(bullets?.ok).toBe(false);
    expect(bullets?.detail.join(' ')).toContain('"North Korean War"');
    // The counts still come back — the report needs them to show the drop to zero.
    expect(result.counts?.get('North Korean War')).toBe(0);
    expect(result.ledger).toBeNull();
  });

  it('fails when a Pre-Big One bullet is re-dated out from under its authored reading', () => {
    // The drift guard, the one gate that protects work already done. `events.ts` keys its
    // readings on (section, date phrase, prose opening), so moving the date unpairs one.
    const drifted = installedText.replace(
      '* July 10th, 2034, 8:04am:',
      '* July 11th, 2034, 8:04am:',
    );
    expect(drifted).not.toBe(installedText);

    const result = validateBible(drifted, inspectEncoding(bytesOf(drifted)));
    expect(result.ok).toBe(false);
    const guard = result.gates.at(-1);
    expect(guard?.name).toContain('drift guard');
    expect(guard?.ok).toBe(false);
    expect(guard?.detail.join(' ')).toContain('July 10th, 2034, 8:04am');
    expect(result.ledger).toBeNull();
  });

  it('fails on a bad encoding without pretending the document is unreadable', () => {
    const noBom = inspectEncoding(installedBytes.subarray(3));
    const result = validateBible(installedText, noBom);
    expect(result.ok).toBe(false);
    expect(result.gates[0]?.ok).toBe(false);
    // The later gates still ran: an export can be badly encoded and structurally fine, and
    // the author is owed both facts in one run.
    expect(result.gates.slice(1).every((gate) => gate.ok)).toBe(true);
    expect(gateNamed(installedText, noBom, 'BOM')?.detail.join(' ')).toContain('re-encoded');
  });
});

// ---------------------------------------------------------------------------
// The diff — a map of where the document moved, never the document
// ---------------------------------------------------------------------------

describe('diffLines', () => {
  it('reports nothing for identical input', () => {
    expect(diffLines(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual({
      hunks: [],
      added: 0,
      removed: 0,
    });
  });

  it('reports a pure insertion at the line it lands on', () => {
    const summary = diffLines(['a', 'b'], ['a', 'x', 'y', 'b']);
    expect(summary).toEqual({
      hunks: [{ beforeStart: 2, beforeLines: 0, afterStart: 2, afterLines: 2 }],
      added: 2,
      removed: 0,
    });
  });

  it('reports a pure deletion', () => {
    const summary = diffLines(['a', 'x', 'b'], ['a', 'b']);
    expect(summary.added).toBe(0);
    expect(summary.removed).toBe(1);
    expect(summary.hunks).toEqual([
      { beforeStart: 2, beforeLines: 1, afterStart: 2, afterLines: 0 },
    ]);
  });

  it('groups a replacement into one hunk, not two', () => {
    const summary = diffLines(['a', 'x', 'b'], ['a', 'y', 'b']);
    expect(summary.hunks).toHaveLength(1);
    expect(summary).toMatchObject({ added: 1, removed: 1 });
  });

  it('keeps separate changes in separate hunks, in document order', () => {
    const summary = diffLines(['a', 'x', 'b', 'c', 'y', 'd'], ['a', 'b', 'c', 'd', 'z']);
    expect(summary.hunks.map((hunk) => hunk.beforeStart)).toEqual([2, 5, 7]);
    expect(summary).toMatchObject({ added: 1, removed: 2 });
  });

  it('handles an empty side without a matrix', () => {
    expect(diffLines([], ['a', 'b'])).toMatchObject({ added: 2, removed: 0 });
    expect(diffLines(['a', 'b'], [])).toMatchObject({ added: 0, removed: 2 });
    expect(diffLines([], [])).toMatchObject({ hunks: [], added: 0, removed: 0 });
  });
});

describe('the installed Bible against the staged export', () => {
  const before = split(installedText);
  const after = split(stagedText);
  const summary = diffLines(before, after);

  it('sees exactly the two added bullets and nothing else', () => {
    expect(summary.added).toBe(2);
    expect(summary.removed).toBe(0);
    expect(summary.hunks).toHaveLength(1);
    expect(after).toHaveLength(before.length + 2);
  });

  it('places the change in the Reconstruction Era, by name', () => {
    const sections = hunkSections(
      summary.hunks[0] ?? { beforeStart: 1, beforeLines: 0, afterStart: 1, afterLines: 0 },
      sectionSpans(installedText),
      sectionSpans(stagedText),
    );
    expect(sections).toContain('Reconstruction Era');
    expect(sections).not.toContain(OUTSIDE_TIMELINE);
  });

  it('reports a section count moving by exactly the bullets that were added', () => {
    const beforeCounts = sectionBulletCounts(installedText);
    const afterCounts = sectionBulletCounts(stagedText);
    const before = INSTALLED_COUNTS['Reconstruction Era']!;
    expect(beforeCounts.get('Reconstruction Era')).toBe(before);
    expect(afterCounts.get('Reconstruction Era')).toBe(before + 2);
    // Every other section holds still. A sync that moved a section nobody edited is the
    // signal that the export itself is wrong.
    for (const section of WORLD_TIMELINE_SECTIONS) {
      if (section === 'Reconstruction Era') continue;
      expect(afterCounts.get(section)).toBe(beforeCounts.get(section));
    }
  });
});

describe('chooseListedHunks', () => {
  // The Bible's prose sits above the World Timeline and churns far more than the timeline
  // does, so "the first N hunks" truncates away the only ones the reader came for.
  const spans = sectionSpans(installedText);
  const timelineLine = timelineHeadingIndex(installedText, 'Reconstruction Era') + 2;
  const prose = (line: number) => ({
    beforeStart: line,
    beforeLines: 1,
    afterStart: line,
    afterLines: 1,
  });
  const canon = prose(timelineLine);
  const hunks = [...Array.from({ length: 8 }, (_, i) => prose(i + 2)), canon];

  it('keeps a World Timeline hunk that a first-N listing would drop', () => {
    // The budget is a TOTAL, and the World Timeline hunk holds one of its places — so the
    // prose fills what is left rather than crowding canon out.
    const listed = chooseListedHunks(hunks, spans, spans, 3);
    expect(listed).toContain(canon);
    expect(listed).toHaveLength(3);
    // Printed back in document order, not in priority order.
    expect(listed.map((hunk) => hunk.beforeStart)).toEqual([2, 3, canon.beforeStart]);
  });

  it('lists everything when the budget covers it', () => {
    expect(chooseListedHunks(hunks, spans, spans, 50)).toEqual(hunks);
  });
});

// ---------------------------------------------------------------------------
// The document table, argv, and the provenance record
// ---------------------------------------------------------------------------

describe('DOCS', () => {
  it('carries the two document ids, and only those two', () => {
    // All seven documents in the author's folder, per P4B.5's "sync all seven, parse one".
    // Pinned as a list rather than a count so that ADDING one is a deliberate edit here —
    // a document that appears in the table without a decision about its gates is exactly
    // the "file nothing reads is a file nothing checks" case the decision rules on.
    expect(Object.keys(DOCS)).toEqual([
      'bible',
      'story',
      'research',
      'treatment',
      'screenplay',
      'visual-style',
      'synopsis',
      'character',
    ]);
    // Exactly one document is authoritative; every other one is tracked only.
    expect(Object.values(DOCS).filter((d) => d.gates === 'world-timeline')).toHaveLength(1);
    expect(DOCS.bible?.driveId).toBe('1OMG_OBxCSFkcnuaG2jHnnNtUcYe0ii7JnjGY_fS5Hs0');
    expect(DOCS.story?.driveId).toBe('1pKXR0k-eeRVKZLdjU7vn745AByr5JyknU06GvU0BnZk');
  });

  it('gates the Bible on the parser and the Story Document on encoding alone', () => {
    // P4B.2.5: nothing reads the Story Document yet, so there is no parser to run and the
    // script must not imply there is.
    expect(DOCS.bible?.gates).toBe('world-timeline');
    expect(DOCS.story?.gates).toBe('encoding-only');
  });

  it('points at the files that are actually in the repo', () => {
    expect(DOCS.bible?.target).toBe('data/story_docs/LIFEstream Bible.txt');
    expect(path.join(repoRoot, DOCS.bible?.target ?? '')).toBe(INSTALLED_PATH);
  });
});

describe('parseArgs', () => {
  it('takes flags and options in both spellings', () => {
    expect(
      parseArgs(['--doc', 'bible', '--from=/tmp/x.txt', '--write'], {
        flags: ['--write'],
        options: ['--doc', '--from'],
      }),
    ).toEqual({ doc: 'bible', from: '/tmp/x.txt', write: true });
  });

  it('refuses an unknown argument rather than ignoring it', () => {
    // A typo'd `--write` must never read as "not writing", and a typo'd `--wrote` must
    // never be swallowed as one.
    expect(() => parseArgs(['--wrote'], { flags: ['--write'] })).toThrow(/unknown argument/);
    expect(() => parseArgs(['--doc'], { options: ['--doc'] })).toThrow(/needs a value/);
  });

  it('keeps --first independent of --write, so neither implies the other', () => {
    // `--first` says "there is deliberately no installed copy to diff against". It is a
    // SEPARATE flag from `--write` on purpose: the overwhelmingly common reason a target
    // is missing is a typo'd `--doc` or a path that moved, and a `--write` that quietly
    // created the file in those cases is how a sync writes canon somewhere nothing reads.
    // Adding a document is rare and deliberate, so it has to say so.
    const both = parseArgs(['--doc', 'research', '--write', '--first'], {
      flags: ['--write', '--first'],
      options: ['--doc'],
    });
    expect(both).toEqual({ doc: 'research', write: true, first: true });

    const writeOnly = parseArgs(['--write'], { flags: ['--write', '--first'] });
    expect(writeOnly.first).toBeUndefined();

    const firstOnly = parseArgs(['--first'], { flags: ['--write', '--first'] });
    expect(firstOnly.write).toBeUndefined();
  });
});

describe('provenance', () => {
  const record = buildProvenance(
    'bible',
    DOCS.bible ?? { title: '', driveId: '', target: '', gates: 'encoding-only' },
    installedEncoding,
    sectionBulletCounts(installedText),
    '/tmp/bible_drive_raw.txt',
    new Date('2026-09-05T12:00:00.000Z'),
  );

  it('sits beside the document it describes', () => {
    expect(provenancePathFor('data/story_docs/LIFEstream Bible.txt')).toBe(
      path.join('data', 'story_docs', 'LIFEstream Bible.provenance.json'),
    );
  });

  it('records what settles whether the document changed', () => {
    expect(record).toMatchObject({
      doc: 'bible',
      title: 'LIFEstream Bible',
      driveDocId: '1OMG_OBxCSFkcnuaG2jHnnNtUcYe0ii7JnjGY_fS5Hs0',
      target: 'data/story_docs/LIFEstream Bible.txt',
      bytes: installedEncoding.bytes,
      sha256: installedEncoding.sha256,
      lines: installedEncoding.lines,
      encoding: { bom: true, newline: 'crlf' },
      worldTimelineBullets: INSTALLED_COUNTS,
      syncedAt: '2026-09-05T12:00:00.000Z',
    });
  });

  it('does NOT record Drive modifiedTime, and says why in the record itself', () => {
    // Every document in that folder carries a near-identical timestamp from a bulk move,
    // so `modifiedTime` is not evidence of an edit. A field that looks like evidence and
    // is not is worse than no field — the note is there so the next reader knows it was a
    // decision rather than a gap.
    expect(Object.keys(record)).not.toContain('modifiedTime');
    expect(JSON.stringify(record)).not.toContain('"modifiedTime":');
    expect(record.note).toContain('modifiedTime');
    expect(record.note).toContain('bulk move');
  });

  it('round-trips as JSON, which is the form it is written in', () => {
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });
});
