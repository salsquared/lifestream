import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, describe, expect, it } from 'vitest';

import { createDb } from '@server/db/index';
import { assignMembership, setMembershipLeader } from '@server/routes/map';
import { readSeedInputs, runSeed, SeedInputError } from '@server/seed/index';
import { deriveFeatures } from '@shared/geo/deriveFeatures';

import type { DbHandle } from '@server/db/index';
import type { DeriveFeatures } from '@server/seed/index';

/**
 * P1.9.5 + P1.11.5 — the seeded rows, against a `:memory:` database.
 *
 * `tests/deriveFeatures.test.ts` is the pure half: it proves the derivation produces the
 * right 242 rows. This is the other half, and it needs a database — the country key has to
 * be TOTAL over the author's own data, and "total" is a claim about `country` rows and
 * `grouping_country` foreign keys, not about a JavaScript array. It is the test P1.6.3's
 * `createDb(url)` factory exists for (the test-fixture decision): a module-scope singleton
 * bound to `data/lifestream.db` had nowhere to put a throwaway world.
 *
 * ── WHY THE ASSERTIONS ARE COUNTS AND NAMED ROWS ──────────────────────────────────────
 * Every failure this seed can have is silent. A dropped feature still draws a map; a code
 * that resolves to the wrong polygon still renders; `is_leader` written nowhere still
 * returns a full grouping list. So the numbers are asserted exactly — 242 countries, 237
 * codes splitting 235 / `x:GUF` / `x:SOL`, 29 groupings, 163 memberships, 10 leaders — and a
 * regression has to move one of them rather than pass quietly.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const migrationsFolder = `${repoRoot}server/src/db/migrations`;
const readJson = <T>(relativePath: string): T =>
  JSON.parse(readFileSync(repoRoot + relativePath, 'utf8')) as T;

const CANON_SAVE_ID = 'sav_canon';

/** A migrated, empty database. Nothing here ever touches `data/lifestream.db`. */
function freshDb(): DbHandle {
  const handle = createDb(':memory:');
  migrate(handle.db, { migrationsFolder });
  return handle;
}

const open: DbHandle[] = [];
const seeded = (): DbHandle => {
  const handle = freshDb();
  open.push(handle);
  return handle;
};

afterAll(() => {
  for (const handle of open) handle.close();
});

const inputs = readSeedInputs(repoRoot, deriveFeatures);
const handle = seeded();
const report = runSeed(handle, inputs);
const { sqlite } = handle;

/** One column of a query, as strings. */
const column = <T>(sql: string, ...params: unknown[]): T[] =>
  sqlite
    .prepare(sql)
    .all(...(params as never[]))
    .map((row) => Object.values(row as object)[0] as T);

const scalar = (sql: string, ...params: unknown[]): number =>
  Number(column<number>(sql, ...params)[0] ?? 0);

/* ------------------------------------------------------------------ *
 * The authored world, resolved INDEPENDENTLY of the seed.
 *
 * The alpha-3 -> country.id map is rebuilt here from the two source files rather than
 * imported from `server/src/seed/`, so this spec checks the seed's answer instead of
 * agreeing with it.
 * ------------------------------------------------------------------ */

const mapSave = readJson<{
  createdAt: number;
  countryNames: Record<string, string>;
  unifiedNations: { id: string; name: string; color: string; countries: string[] }[];
  allGroups: { id: string; name: string; countries: string[]; independent?: boolean }[];
}>('data/map_saves/lifestream_map_v1.json');

const numericToAlpha3 = readJson<Record<string, string>>('data/iso-numeric-to-alpha3.json');
const alpha3ToKey = new Map(Object.entries(numericToAlpha3).map(([key, a3]) => [a3, key]));
const countryIdFor = (alpha3: string): string | null => {
  const key = alpha3ToKey.get(alpha3);
  if (key === undefined) return null;
  return /^\d{1,3}$/.test(key) ? key.padStart(3, '0') : `x:${alpha3}`;
};

const authoredCodes = [...new Set(mapSave.allGroups.flatMap((group) => group.countries))];
const unifiedGroups = mapSave.allGroups.filter((group) => group.independent !== true);
const independentGroups = mapSave.allGroups.filter((group) => group.independent === true);

describe('country seed — the global table (P1.9)', () => {
  it('seeds one row per derived feature, and the count is asserted so a drop moves it', () => {
    expect(report.countryRows).toBe(242);
    expect(scalar('select count(*) from country')).toBe(242);
    expect(report.countries.total).toBe(242);
    expect(report.countries.inserted).toBe(242);
  });

  it('keys on zero-padded 3-character strings, never numbers', () => {
    const ids = column<string>('select id from country');
    expect(ids).toHaveLength(242);
    for (const id of ids) {
      expect(typeof id).toBe('string');
      if (!id.startsWith('x:')) expect(id).toMatch(/^\d{3}$/);
    }
    // SQLite would happily store an integer in a TEXT column; `typeof` above is a JS check
    // on what came back, this is the storage class the column actually holds.
    expect(scalar(`select count(*) from country where typeof(id) <> 'text'`)).toBe(0);
    expect(
      scalar(
        `select count(*) from country where iso_numeric is not null and typeof(iso_numeric) <> 'text'`,
      ),
    ).toBe(0);
  });

  it('carves x:GUF out of France as a derived row, and France keeps its feature row', () => {
    const guf = sqlite.prepare('select * from country where id = ?').get('x:GUF') as
      | { name: string; geometry_source: string; iso_numeric: string | null; alpha3: string | null }
      | undefined;
    expect(guf).toBeDefined();
    expect(guf?.name).toBe('French Guiana');
    expect(guf?.geometry_source).toBe('derived');
    expect(guf?.iso_numeric).toBeNull();
    expect(guf?.alpha3).toBe('GUF');

    const france = sqlite.prepare('select * from country where id = ?').get('250') as
      { name: string; geometry_source: string } | undefined;
    expect(france?.name).toBe('France');
    expect(france?.geometry_source).toBe('feature');

    // Exactly one derived row against the pinned atlas: the carve, and nothing else.
    expect(scalar(`select count(*) from country where geometry_source = 'derived'`)).toBe(1);
  });

  it('leaves the "036" collision as TWO rows — Australia keeps it, Ashmore does not', () => {
    const australia = sqlite.prepare('select name from country where id = ?').get('036') as
      { name: string } | undefined;
    const ashmore = sqlite
      .prepare('select name, geometry_source from country where id = ?')
      .get('x:ashmore-cartier') as { name: string; geometry_source: string } | undefined;

    expect(australia?.name).toBe('Australia');
    expect(ashmore?.name).toBe('Ashmore and Cartier Is.');
    // A real 1:1 topojson feature whose *id* is unusable — 'derived' would be a lie (§3.1).
    expect(ashmore?.geometry_source).toBe('feature');
    expect(
      scalar(
        'select count(*) from country where name in (?, ?)',
        'Australia',
        'Ashmore and Cartier Is.',
      ),
    ).toBe(2);
  });

  it('reports the three mapping entries with no 50m geometry, and no fourth', () => {
    expect(report.unmappedIsoKeys.map((entry) => entry.key).sort()).toEqual([
      '175',
      'GUF',
      'undefined',
    ]);
    expect(report.isoKeyDriftSuspected).toBe(false);
    expect(report.deriveWarnings).toEqual([]);
  });
});

describe('country key totality — every authored code resolves (P1.9.4, P1.11.2)', () => {
  it('sees 237 distinct codes in the canon map save', () => {
    expect(authoredCodes).toHaveLength(237);
  });

  it('resolves every one of the 237 to EXACTLY ONE country row', () => {
    const unresolved: string[] = [];
    const wrongCount: string[] = [];

    for (const alpha3 of authoredCodes) {
      const id = countryIdFor(alpha3);
      if (id === null) {
        unresolved.push(alpha3);
        continue;
      }
      const rows = scalar('select count(*) from country where id = ?', id);
      if (rows !== 1) wrongCount.push(`${alpha3} -> ${id}: ${rows} rows`);
    }

    expect(unresolved).toEqual([]);
    expect(wrongCount).toEqual([]);
  });

  it('splits 237 as 235 numeric + x:GUF + x:SOL — the split, not just the total', () => {
    const ids = authoredCodes.map((alpha3) => countryIdFor(alpha3));
    const numeric = ids.filter((id) => id !== null && /^\d{3}$/.test(id));
    const synthetic = ids.filter((id) => id !== null && id.startsWith('x:')).sort();

    expect(numeric).toHaveLength(235);
    expect(synthetic).toEqual(['x:GUF', 'x:SOL']);

    // And the same split as the seed reported, so a code sliding between the two buckets
    // moves a number here rather than passing silently.
    const canon = report.saves.find((save) => save.result.saveId === CANON_SAVE_ID);
    expect(canon?.resolution).toEqual({
      total: 237,
      numeric: 235,
      syntheticIds: ['x:GUF', 'x:SOL'],
    });
  });

  it('fails LOUDLY when a country the map references is dropped', () => {
    // The deliberate break, run as a test rather than described in a comment: a derivation
    // that loses one row must not seed a world with a hole in it.
    const dropping =
      (droppedId: string): DeriveFeatures =>
      (topology, mapping, objectName) => {
        const set = deriveFeatures(topology, mapping, objectName);
        const byId = new Map(set.byId);
        byId.delete(droppedId);
        return {
          features: set.features.filter((feature) => feature.id !== droppedId),
          countries: set.countries.filter((country) => country.id !== droppedId),
          byId,
          warnings: set.warnings,
        };
      };

    // '036' is Australia — a member of no unified nation, but one of the 237 authored codes.
    expect(() => readSeedInputs(repoRoot, dropping('036'))).toThrow(SeedInputError);
    expect(() => readSeedInputs(repoRoot, dropping('036'))).toThrow(/036/);
    // 'x:GUF' is the France carve, and a member of the "Guyana" unified nation.
    expect(() => readSeedInputs(repoRoot, dropping('x:GUF'))).toThrow(/GUF/);
  });
});

describe('map save import (P1.11)', () => {
  it('seeds the canon save under the id the client hard-codes', () => {
    const row = sqlite.prepare('select * from save where id = ?').get(CANON_SAVE_ID) as
      | { name: string; created_at: string; is_archived: number; parent_save_id: string | null }
      | undefined;

    expect(row).toBeDefined();
    expect(row?.name).toBe('v1 (Bible canon)');
    // The export's own timestamp, never the clock — the seed has to be reproducible.
    expect(row?.created_at).toBe(new Date(mapSave.createdAt).toISOString());
    expect(row?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(row?.parent_save_id).toBeNull();
    expect(scalar('select count(*) from save')).toBe(1);
  });

  it('writes one grouping per unified nation and skips the 74 synthesized independents', () => {
    expect(mapSave.allGroups).toHaveLength(103);
    expect(unifiedGroups).toHaveLength(29);
    expect(independentGroups).toHaveLength(74);

    expect(scalar('select count(*) from `grouping` where save_id = ?', CANON_SAVE_ID)).toBe(29);
    const canon = report.saves.find((save) => save.result.saveId === CANON_SAVE_ID);
    expect(canon?.independentsSkipped).toBe(74);

    // An independent nation is a country with NO grouping_country row (§2.4). Each of the
    // 74 is a single-country group, and none of those countries may have one.
    const independentIds = independentGroups.flatMap((group) =>
      group.countries.map((alpha3) => countryIdFor(alpha3)),
    );
    expect(independentIds).toHaveLength(74);
    for (const id of independentIds) {
      expect(scalar('select count(*) from grouping_country where country_id = ?', id)).toBe(0);
    }
  });

  it('writes 163 membership rows — every member code of every unified nation', () => {
    const expected = unifiedGroups.reduce((n, group) => n + group.countries.length, 0);
    expect(expected).toBe(163);
    expect(scalar('select count(*) from grouping_country where save_id = ?', CANON_SAVE_ID)).toBe(
      163,
    );
  });

  it('round-trips membership: every nation holds exactly the countries the file lists', () => {
    for (const group of unifiedGroups) {
      const groupingId = column<string>(
        'select id from `grouping` where save_id = ? and name = ?',
        CANON_SAVE_ID,
        group.name,
      )[0];
      expect(groupingId, `no grouping row for "${group.name}"`).toBeDefined();

      const members = column<string>(
        'select country_id from grouping_country where save_id = ? and grouping_id = ? order by country_id',
        CANON_SAVE_ID,
        groupingId,
      );
      const wanted = group.countries.map((alpha3) => countryIdFor(alpha3)).sort();
      expect(members, `membership of "${group.name}"`).toEqual(wanted);
    }
  });

  it('keeps the partition: a country belongs to at most one nation per save', () => {
    // The composite PK enforces it; this shows it HOLDS rather than assuming it does.
    const doubled = column<string>(
      'select country_id from grouping_country where save_id = ? group by country_id having count(*) > 1',
      CANON_SAVE_ID,
    );
    expect(doubled).toEqual([]);
    expect(
      scalar(
        'select count(distinct country_id) from grouping_country where save_id = ?',
        CANON_SAVE_ID,
      ),
    ).toBe(163);
  });

  it('points every membership row at a real country and a real grouping', () => {
    expect(
      scalar(
        'select count(*) from grouping_country gc left join country c on c.id = gc.country_id where c.id is null',
      ),
    ).toBe(0);
    expect(
      scalar(
        'select count(*) from grouping_country gc left join `grouping` g on g.id = gc.grouping_id and g.save_id = gc.save_id where g.id is null',
      ),
    ).toBe(0);
  });
});

describe('union leaders — the one fact only the Bible carries (P1.11.2)', () => {
  it('finds exactly 10 (Leader) markers in the Bible', () => {
    expect(report.leaderMarkers).toHaveLength(10);
    expect(report.leaderMarkers.map((marker) => marker.leaderName)).toEqual([
      'Panama',
      'Colombia',
      'Argentina',
      'Turkey',
      'Pakistan',
      'India',
      'Vietnam',
      'China',
      'North & South Korea',
      'Indonesia',
    ]);
  });

  it('writes all 10, each in a distinct grouping', () => {
    // Ten, after an authoring decision (2026-09-04). Canon's `Unified Korea` does not exist
    // in the authored map — both Koreas are members of `East Asian Alliance`, which the
    // Bible never names — and `North & South Korea` names two countries where
    // `grouping_country_leader_unique` permits one. The author ruled that the alliance is
    // led by South Korea, on canon's own GDP-tier logic. See seed/leaders.ts.
    expect(
      scalar(
        'select count(*) from grouping_country where save_id = ? and is_leader = 1',
        CANON_SAVE_ID,
      ),
    ).toBe(10);
    expect(
      scalar(
        'select count(distinct grouping_id) from grouping_country where save_id = ? and is_leader = 1',
        CANON_SAVE_ID,
      ),
    ).toBe(10);

    const named = column<string>(
      `select c.name from grouping_country gc join country c on c.id = gc.country_id
       where gc.save_id = ? and gc.is_leader = 1 order by c.name`,
      CANON_SAVE_ID,
    );
    expect(named).toEqual([
      'Argentina',
      'China',
      'Colombia',
      'India',
      'Indonesia',
      'Pakistan',
      'Panama',
      'South Korea',
      'Turkey',
      'Vietnam',
    ]);
  });

  it('places every marker, leaving none unplaced', () => {
    // The check that matters is not the literal 10 — it is that NOTHING is silently
    // dropped. If the Bible gains an eleventh marker, or the authored map renames another
    // union out from under one, this fails rather than quietly seeding fewer.
    const canon = report.saves.find((save) => save.result.saveId === CANON_SAVE_ID);
    expect(canon?.leaders).toHaveLength(10);
    expect(canon?.unplacedLeaders).toEqual([]);
  });

  it('places each leader in the nation that actually contains it, not by union name', () => {
    const canon = report.saves.find((save) => save.result.saveId === CANON_SAVE_ID);
    const renamed = canon?.leaders.filter((leader) => leader.groupingName !== leader.union) ?? [];
    // THREE of canon's union names were changed by the authored map, so matching a leader
    // to its union by name would have dropped all three. The Korea case is the reason the
    // lookup goes through membership instead: the union was not merely renamed, it was
    // replaced by a differently-shaped one, and only the member country survives both.
    expect(renamed.map((leader) => `${leader.union} -> ${leader.groupingName}`)).toEqual([
      'Estados Unidos de America Central -> Estados Unidos de Central America',
      'New Pakistan -> Pakistan',
      'Unified Korea -> East Asian Alliance',
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * P3.7.4 — the leader WRITE path, against the world the seed just built.
 *
 * The block above proves the ten markers are written. This one proves they survive being
 * edited, which is the half P2 got wrong: the map cleared `is_leader` on every move, the
 * flag had no write path anywhere in the application, and the ten leaders exist only in
 * `data/story_docs/LIFEstream Bible.txt` — the authored map export has no leader field. So
 * a leader lost through ordinary editing was gone from every file in the repo, recoverable
 * only by re-running the seed, which an author would not think to do.
 *
 * It drives the route module's two writers directly rather than through HTTP. They take
 * their connection as an argument for exactly this reason (`server/src/routes/map.ts`):
 * the handlers close over `appDb`, which is bound to `data/lifestream.db`, and the whole
 * point of this file is that nothing in it touches the real world.
 * ------------------------------------------------------------------ */

describe('leader write path — a seeded leader survives editing (P3.7)', () => {
  /**
   * A SEEDED WORLD OF ITS OWN PER CASE, because this is the one block in the file that
   * writes. The shared `handle` is read by the idempotence spec, which compares a dump of
   * it against a second seed run — a leader moved out from under that comparison would fail
   * it for a reason that has nothing to do with idempotence. A private world per case also
   * keeps the exact counts below true no matter what order the cases run in.
   */
  const freshWorld = (): DbHandle => {
    const world = seeded();
    runSeed(world, inputs);
    return world;
  };

  /** One row of a query against a given world — the module-scope helpers read `handle`. */
  const row = <T>(world: DbHandle, sql: string, ...params: unknown[]): T | undefined =>
    world.sqlite.prepare(sql).get(...(params as never[])) as T | undefined;

  const total = (world: DbHandle, sql: string, ...params: unknown[]): number => {
    const first = row<Record<string, unknown>>(world, sql, ...params);
    return Number(Object.values(first ?? {})[0] ?? 0);
  };

  /** Where a country sits and whether it leads — the whole of what these cases assert. */
  const seatOf = (world: DbHandle, countryId: string) =>
    row<{ grouping_id: string; is_leader: number }>(
      world,
      'select grouping_id, is_leader from grouping_country where save_id = ? and country_id = ?',
      CANON_SAVE_ID,
      countryId,
    );

  const leadersIn = (world: DbHandle, groupingId: string): number =>
    total(
      world,
      'select count(*) from grouping_country where save_id = ? and grouping_id = ? and is_leader = 1',
      CANON_SAVE_ID,
      groupingId,
    );

  const groupingNamed = (world: DbHandle, name: string): string => {
    const found = row<{ id: string }>(
      world,
      'select id from `grouping` where save_id = ? and name = ?',
      CANON_SAVE_ID,
      name,
    );
    expect(found, `no grouping named "${name}" in the canon save`).toBeDefined();
    return found?.id ?? '';
  };

  // Three of the ten markers, by country id. Panama leads `Estados Unidos de Central
  // America`, China leads `Greater China`, India leads `Greater India` — asserted by name
  // in the block above, so a re-authoring that moved them fails there first.
  const PANAMA = '591';
  const CHINA = '156';
  const INDIA = '356';

  it('carries a leader into a union that has none, and back — the P2 regression', () => {
    const world = freshWorld();

    const home = seatOf(world, PANAMA);
    expect(home?.is_leader, 'Panama is one of the ten seeded leaders').toBe(1);
    const homeId = home?.grouping_id ?? '';

    const unled = groupingNamed(world, 'Guyana');
    expect(leadersIn(world, unled), '"Guyana" is seeded with no leader').toBe(0);

    // OUT. Before P3.7.3 this wrote `is_leader = 0` unconditionally and the fact was gone.
    assignMembership(world, CANON_SAVE_ID, unled, PANAMA);
    expect(seatOf(world, PANAMA)).toEqual({ grouping_id: unled, is_leader: 1 });
    expect(leadersIn(world, homeId), 'the union it left is unled now, not double-led').toBe(0);

    // AND BACK. The home union lost its leader when Panama left, so the flag has nothing to
    // collide with on the return trip and the round trip is lossless.
    assignMembership(world, CANON_SAVE_ID, homeId, PANAMA);
    expect(seatOf(world, PANAMA)).toEqual({ grouping_id: homeId, is_leader: 1 });
    expect(leadersIn(world, unled)).toBe(0);

    // The canon count, restored exactly. This is the number the regression moved, and the
    // reason it is asserted here as well as in the seed block above.
    expect(
      total(
        world,
        'select count(*) from grouping_country where save_id = ? and is_leader = 1',
        CANON_SAVE_ID,
      ),
    ).toBe(10);
  });

  it('clears the flag when the destination is already led, and never writes two', () => {
    const world = freshWorld();

    expect(seatOf(world, CHINA)?.is_leader).toBe(1);
    const greaterIndia = seatOf(world, INDIA)?.grouping_id ?? '';
    expect(seatOf(world, INDIA)?.is_leader).toBe(1);

    // The one case where clearing is right: `grouping_country_leader_unique` admits one
    // leader per union and India is already it, so the flag has nowhere to land.
    assignMembership(world, CANON_SAVE_ID, greaterIndia, CHINA);
    expect(seatOf(world, CHINA)).toEqual({ grouping_id: greaterIndia, is_leader: 0 });
    expect(seatOf(world, INDIA)).toEqual({ grouping_id: greaterIndia, is_leader: 1 });
    expect(leadersIn(world, greaterIndia)).toBe(1);
  });

  it('promotes a member by demoting the previous leader in the same write, and clears it', () => {
    const world = freshWorld();

    const greaterIndia = seatOf(world, INDIA)?.grouping_id ?? '';
    const successor = row<{ country_id: string }>(
      world,
      'select country_id from grouping_country where save_id = ? and grouping_id = ? and country_id <> ? order by country_id limit 1',
      CANON_SAVE_ID,
      greaterIndia,
      INDIA,
    )?.country_id;
    expect(successor, 'the union has a second member to promote').toBeDefined();
    const promoted = successor ?? '';

    // SET. The demotion and the promotion are one transaction, in that order: promoting
    // first would violate the partial unique index and fail here rather than pass.
    setMembershipLeader(world, CANON_SAVE_ID, greaterIndia, promoted, true);
    expect(seatOf(world, promoted)?.is_leader).toBe(1);
    expect(seatOf(world, INDIA)?.is_leader).toBe(0);
    expect(leadersIn(world, greaterIndia)).toBe(1);

    // CLEAR. Leaderlessness is a flag on rows that stay — unlike independence, which is the
    // absence of a row (§2.4) — so the membership is untouched.
    setMembershipLeader(world, CANON_SAVE_ID, greaterIndia, promoted, false);
    expect(leadersIn(world, greaterIndia)).toBe(0);
    expect(
      total(
        world,
        'select count(*) from grouping_country where save_id = ? and grouping_id = ?',
        CANON_SAVE_ID,
        greaterIndia,
      ),
    ).toBeGreaterThan(1);
  });
});

describe('country renames — countryNames is a display cache (P1.11.4)', () => {
  it('imports only the entries that differ from the derived default: none of the 165', () => {
    expect(Object.keys(mapSave.countryNames)).toHaveLength(165);

    const canon = report.saves.find((save) => save.result.saveId === CANON_SAVE_ID);
    expect(canon?.overrideCandidates).toBe(165);
    expect(canon?.counts.overrides).toBe(0);
    expect(scalar('select count(*) from country_override')).toBe(0);
  });

  it('agrees with the derived names, independently checked', () => {
    const differing: string[] = [];
    for (const [alpha3, cached] of Object.entries(mapSave.countryNames)) {
      const id = countryIdFor(alpha3);
      if (id === null) continue;
      const row = sqlite.prepare('select name from country where id = ?').get(id) as
        { name: string } | undefined;
      if (row !== undefined && row.name !== cached)
        differing.push(`${alpha3}: ${row.name} <> ${cached}`);
    }
    expect(differing).toEqual([]);
  });
});

describe('idempotence — db:seed twice is db:seed once (§7.4, P1.7.2)', () => {
  /** Every seeded table, normalised so two databases compare as data and not as bytes. */
  const dump = (target: DbHandle): string =>
    ['save', 'country', 'country_override', '`grouping`', 'grouping_country']
      .map((table) => {
        const rows = target.sqlite.prepare(`select * from ${table}`).all() as object[];
        return rows
          .map((row) => JSON.stringify(row, Object.keys(row).sort()))
          .sort()
          .join('\n');
      })
      .join('\n---\n');

  it('produces identical rows on a second run against the same database', () => {
    const once = dump(handle);
    const second = runSeed(handle, inputs);

    expect(dump(handle)).toBe(once);
    expect(second.countryRows).toBe(242);
    // Nothing was written the second time — every row already matched.
    expect(second.countries.inserted).toBe(0);
    expect(second.countries.updated).toBe(0);
    expect(second.countries.unchanged).toBe(242);

    const canon = second.saves.find((save) => save.result.saveId === CANON_SAVE_ID)?.result;
    expect(canon?.saveChanged).toBe(false);
    expect(canon?.groupingsUnchanged).toBe(29);
    expect(canon?.membershipsUnchanged).toBe(163);
    expect(canon?.groupingsInserted).toBe(0);
    expect(canon?.membershipsInserted).toBe(0);
    // Never destructive: nothing was left behind for a later run to reconcile.
    expect(canon?.staleGroupings).toBe(0);
    expect(canon?.staleMemberships).toBe(0);
  });

  it('produces the same rows in a database seeded from scratch', () => {
    const other = seeded();
    runSeed(other, inputs);
    expect(dump(other)).toBe(dump(handle));
  });
});
