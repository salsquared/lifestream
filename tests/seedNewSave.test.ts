import { describe, expect, it } from 'vitest';

import { mintNewSaveId, parseSeedArgs, retargetCanonSave } from '../scripts/seed.js';

import type { CanonTargeting, NewSaveTarget } from '../scripts/seed.js';
import type { MapSaveInput } from '@server/seed/index';

/**
 * P4B.3 — `db:seed --new-save`, the clean-slate escape hatch.
 *
 * ── WHY THIS SPEC IS PURE, AND WHY THAT IS ENOUGH ─────────────────────────────────────
 * The flag is a transform on the object `readSeedInputs` returns, applied before
 * `runSeed` is called: `seedCanon` reads `inputs.canonSaveId` and `seedMapSave` reads
 * each `input.save.id`, so rewriting those is the whole feature. That makes the valuable
 * assertions database-free — WHICH fields moved, and, far more importantly, which ones
 * did NOT. A spec that drove a real seed would prove the same thing more slowly and
 * would need a scratch database to do it.
 *
 * `scripts/seed.ts` can be imported at all because of two decisions in that file: the
 * `import.meta.url === process.argv[1]` main guard (the idiom `scripts/fontCoverage.mjs`
 * already uses, so `tests/fontCoverage.test.ts` can import it), and the LAZY import of
 * `server/src/db/index.ts`, which opens `data/lifestream.db` at module scope. Importing
 * this module opens nothing and writes nothing.
 *
 * ── THE FAILURES THESE ASSERTIONS EXIST TO CATCH ──────────────────────────────────────
 * Every one of them is silent.
 *
 *   - A save entry that is NOT canon being rewritten. `data/map_saves/` holds one file
 *     today, so a transform that rewrote all of them would look correct forever and
 *     break the day a second world is added. The fixture therefore carries a second,
 *     non-canon save whose identity is asserted to be untouched, field by field.
 *   - The grouping ids not being namespaced. `grouping.id` is a GLOBAL primary key and
 *     `inputs.ts` mints it as `grp_${sourceId}` from the map export, so the new save
 *     would claim the ids canon already holds — and `seedMapSave` upserts with
 *     `set: { saveId, ... }`, which MOVES the row. Verified against a scratch copy of the
 *     real database on 2026-09-05: the run dies with a bare `FOREIGN KEY constraint
 *     failed` from `grouping_country`.
 *   - A leader pointing at canon's grouping id after the groupings were renamed. The
 *     leader flag is written by `(save_id, grouping_id)`, so a stale pointer is either an
 *     FK failure or, worse, a flag on the wrong nation.
 *   - The input object being MUTATED. `main` prints the plan using the rewritten object
 *     and names the ORIGINAL canon id in the same breath ("untouched sav_canon"); if the
 *     transform mutated in place, that line would name the new id and claim it left
 *     itself alone.
 *   - `save.createdAt` being taken from the clock. `readSaveRow` refuses to do that on
 *     reproducibility grounds; the mint instant is provenance and belongs in
 *     `description`, which is where this repository already puts provenance.
 */

const CANON_SAVE_ID = 'sav_canon';
const MINTED_AT = '2026-09-05T15:32:41.123Z';
const target: NewSaveTarget = { id: 'sav_whatif', mintedAt: MINTED_AT };

/**
 * A map save reduced to the fields the transform touches, with everything else present
 * and distinctive so a stray rewrite shows up as a failure rather than as a pass.
 */
function mapSave(id: string, file: string): MapSaveInput {
  return {
    file,
    save: {
      id,
      name: `${id} name`,
      description: `Seeded from data/map_saves/${file} (Version 1).`,
      createdAt: '2025-05-07T00:00:00.000Z',
      isArchived: false,
    },
    groupings: [
      {
        sourceId: '1746',
        id: 'grp_1746',
        name: 'United Emirates of Africa',
        color: '#c0ffee',
        countryIds: ['012', '818'],
      },
      {
        sourceId: '1747',
        id: 'grp_1747',
        name: 'Pacific Compact',
        color: '#decaf0',
        countryIds: ['036'],
      },
    ],
    independentsSkipped: 74,
    resolution: { total: 3, numeric: 3, syntheticIds: [] },
    overrides: [{ saveId: id, countryId: '012', name: 'Algeria (renamed)' }],
    overrideCandidates: 237,
    leaders: [
      {
        union: 'UEA',
        leaderName: 'Adan',
        alpha3: 'DZA',
        countryId: '012',
        groupingId: 'grp_1746',
        groupingName: 'United Emirates of Africa',
        line: 412,
      },
    ],
    unplacedLeaders: [],
  };
}

/**
 * Canon plus one other world.
 *
 * `data/map_saves/` holds exactly one file today, so a transform that rewrote EVERY save
 * would pass against the real inputs and break the day a second world lands. The second
 * entry exists to make that failure reachable now.
 */
function seedInputs(): CanonTargeting {
  return {
    canonSaveId: CANON_SAVE_ID,
    saves: [mapSave(CANON_SAVE_ID, 'lifestream_map_v1.json'), mapSave('sav_other', 'other.json')],
  };
}

describe('parseSeedArgs', () => {
  it('takes no arguments and asks for nothing', () => {
    expect(parseSeedArgs([])).toEqual({ help: false, newSave: false, newSaveId: undefined });
  });

  it('reads --new-save with and without an id', () => {
    expect(parseSeedArgs(['--new-save'])).toEqual({
      help: false,
      newSave: true,
      newSaveId: undefined,
    });
    expect(parseSeedArgs(['--new-save=sav_whatif'])).toEqual({
      help: false,
      newSave: true,
      newSaveId: 'sav_whatif',
    });
  });

  it('reads -h and --help', () => {
    expect(parseSeedArgs(['-h']).help).toBe(true);
    expect(parseSeedArgs(['--help']).help).toBe(true);
  });

  // The reason the parser is strict at all: an argument it does not understand must not
  // fall through to "re-seed canon in place", which is the one outcome the flag exists to
  // avoid and the one that leaves no trace.
  it('refuses an argument it does not know', () => {
    expect(() => parseSeedArgs(['--new-sav'])).toThrow(/unknown argument: --new-sav/);
    expect(() => parseSeedArgs(['sav_whatif'])).toThrow(/unknown argument: sav_whatif/);
    // `--new-save <id>` is deliberately NOT a spelling: only `=` carries a value.
    expect(() => parseSeedArgs(['--new-save', 'sav_whatif'])).toThrow(/unknown argument/);
  });

  it('holds an explicit id to the `sav_` + kebab convention', () => {
    for (const bad of ['whatif', 'sav_WhatIf', 'sav_what_if', 'sav_', 'sav_-x', 'sav_x-']) {
      expect(() => parseSeedArgs([`--new-save=${bad}`])).toThrow(/is not a save id/);
    }
    expect(parseSeedArgs(['--new-save=sav_2026-09-05-153241']).newSaveId).toBe(
      'sav_2026-09-05-153241',
    );
  });

  it('refuses two explicit ids rather than letting argument order decide', () => {
    expect(() => parseSeedArgs(['--new-save=sav_a', '--new-save=sav_b'])).toThrow(/given twice/);
  });
});

describe('mintNewSaveId', () => {
  it('mints a readable, sortable, convention-shaped id in UTC', () => {
    expect(mintNewSaveId(new Date(MINTED_AT))).toBe('sav_2026-09-05-153241');
  });

  // The minted id goes through the same validation an explicit one does the moment anyone
  // types it back, so the two must agree on the shape.
  it('mints an id the parser accepts', () => {
    const id = mintNewSaveId(new Date(MINTED_AT));
    expect(parseSeedArgs([`--new-save=${id}`]).newSaveId).toBe(id);
  });

  it('sorts by time, because a save id is the only handle on a save until P6', () => {
    const earlier = mintNewSaveId(new Date('2026-09-05T15:32:41.000Z'));
    const later = mintNewSaveId(new Date('2026-09-05T15:32:42.000Z'));
    expect([later, earlier].sort()).toEqual([earlier, later]);
  });
});

describe('retargetCanonSave', () => {
  const rewritten = retargetCanonSave(seedInputs(), target);
  const minted = rewritten.saves.find(
    (entry) => entry.file === 'lifestream_map_v1.json',
  ) as MapSaveInput;

  it('points the authored world at the new save', () => {
    expect(rewritten.canonSaveId).toBe('sav_whatif');
    expect(minted.save.id).toBe('sav_whatif');
  });

  it('names the new save after the id, not after canon', () => {
    expect(minted.save.name).toBe('New save whatif');
  });

  it('writes provenance into `description`: from what, and when', () => {
    expect(minted.save.description).toContain('db:seed --new-save');
    expect(minted.save.description).toContain(MINTED_AT);
    expect(minted.save.description).toContain('data/map_saves/lifestream_map_v1.json');
    expect(minted.save.description).toContain('LIFEstream Bible.txt');
    // It says which save it was cloned from AND that that save was not touched — the
    // whole promise of the flag, recorded where a reader of the database can see it.
    expect(minted.save.description).toContain(CANON_SAVE_ID);
  });

  it('keeps `createdAt` from the map export rather than the clock', () => {
    expect(minted.save.createdAt).toBe('2025-05-07T00:00:00.000Z');
  });

  // `grouping.id` is a GLOBAL primary key and `seedMapSave` upserts on it with
  // `set: { saveId }`. Reusing canon's ids does not create the new save's nations, it
  // moves canon's.
  it('namespaces the grouping ids on the target save, keeping the source id traceable', () => {
    expect(minted.groupings.map((group) => group.id)).toEqual([
      'grp_whatif_1746',
      'grp_whatif_1747',
    ]);
    expect(minted.groupings.map((group) => group.sourceId)).toEqual(['1746', '1747']);
    expect(minted.groupings.map((group) => group.name)).toEqual([
      'United Emirates of Africa',
      'Pacific Compact',
    ]);
  });

  it('re-points the leaders at the namespaced groupings', () => {
    expect(minted.leaders.map((leader) => leader.groupingId)).toEqual(['grp_whatif_1746']);
    expect(minted.leaders[0]?.countryId).toBe('012');
  });

  it('re-points the country overrides at the new save', () => {
    expect(minted.overrides).toEqual([
      { saveId: 'sav_whatif', countryId: '012', name: 'Algeria (renamed)' },
    ]);
  });

  it('leaves every other save entry exactly as it was', () => {
    const other = rewritten.saves.find((entry) => entry.file === 'other.json');
    expect(other).toEqual(mapSave('sav_other', 'other.json'));
  });

  it('does not mutate the object it was given', () => {
    const original = seedInputs();
    retargetCanonSave(original, target);
    expect(original).toEqual(seedInputs());
  });

  // The transform is generic in its argument so a caller keeps its own type — `main` hands
  // it the full `SeedInputs` and gets a full `SeedInputs` back. Everything it does not name
  // has to survive by reference, or `runSeed` would be handed a half-built world.
  it('carries every field it does not name through by reference', () => {
    const original = { ...seedInputs(), countries: [], preBigOneBullets: [], anything: 1 };
    const out = retargetCanonSave(original, target);
    expect(out.countries).toBe(original.countries);
    expect(out.preBigOneBullets).toBe(original.preBigOneBullets);
    expect(out.anything).toBe(1);
    expect(out.saves).toHaveLength(2);
  });

  // Three refusals, all of which are silent if let through: the first re-seeds canon under
  // a name claiming it did not, the second merges two authored worlds into one save, and
  // the third means the transform and `readSeedInputs` disagree about which save is canon.
  it('refuses to mint the canon id', () => {
    expect(() =>
      retargetCanonSave(seedInputs(), { id: CANON_SAVE_ID, mintedAt: MINTED_AT }),
    ).toThrow(/is the canon save/);
  });

  it('refuses an id another map save in the same run already claims', () => {
    expect(() => retargetCanonSave(seedInputs(), { id: 'sav_other', mintedAt: MINTED_AT })).toThrow(
      /already the save id of data\/map_saves\/other\.json/,
    );
  });

  it('refuses inputs whose canon save id names no map save', () => {
    const orphaned: CanonTargeting = { ...seedInputs(), canonSaveId: 'sav_missing' };
    expect(() => retargetCanonSave(orphaned, target)).toThrow(/no map save produced the canon/);
  });
});
