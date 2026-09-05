/**
 * P1.11 — one save per file in `data/map_saves/`, plus its groupings, membership, leaders
 * and renames.
 *
 * Every decision about WHAT to write was made in `inputs.ts`; this module writes it. Four
 * properties it has to keep:
 *
 *   · **Idempotent, never destructive** (§7.4, P1.7.2). Everything upserts by natural key
 *     and nothing is deleted, so `db:seed` twice is `db:seed` once, and a re-seed after a
 *     source edit updates what changed and leaves everything else — including rows the
 *     sources do not own — alone. Rows the sources no longer name are COUNTED and reported,
 *     not dropped.
 *   · **A row that already matches is not rewritten.** An UPDATE with the same values still
 *     dirties its page, so a blanket rewrite would leave a different file behind on every
 *     run. Skipping the no-ops is what makes the second seed byte-identical.
 *   · **The partition is the database's to enforce.** `grouping_country`'s PK is
 *     `(save_id, country_id)`, so a double membership fails at insert. `inputs.ts` checks
 *     it first only to name the two groups; this layer does not re-check it.
 *   · **At most one leader per grouping.** `grouping_country_leader_unique` is partial, so
 *     two leaders in one union fail at insert. That is why a country that is losing the
 *     flag is cleared BEFORE the membership rows are written: promoting a second member of
 *     the same union would otherwise collide on the index halfway through the batch, with
 *     both rows briefly flagged.
 */
import { and, eq, inArray, not, sql } from 'drizzle-orm';

import { countryOverride, grouping, groupingCountry, save } from '../db/schema.js';

import type { MapSaveInput } from './inputs.js';
import type { Db } from '../db/index.js';

/** What one map save's import did. */
export interface MapSaveResult {
  file: string;
  saveId: string;
  saveName: string;
  saveInserted: boolean;
  /** False when the `save` row already matched — no statement was issued for it. */
  saveChanged: boolean;
  groupingsInserted: number;
  groupingsUpdated: number;
  groupingsUnchanged: number;
  membershipsInserted: number;
  membershipsUpdated: number;
  membershipsUnchanged: number;
  leadersSet: number;
  overridesInserted: number;
  overridesUpdated: number;
  overridesUnchanged: number;
  /** Membership rows already in the database that this run's sources no longer name. */
  staleMemberships: number;
  /** Groupings already in the database that this run's sources no longer name. */
  staleGroupings: number;
}

/**
 * Write one map save. Call inside a transaction — `runSeed` owns that, so a failure part
 * way through a file does not leave a save with half its nations.
 */
export function seedMapSave(db: Db, input: MapSaveInput): MapSaveResult {
  const saveId = input.save.id;

  // ---- the save row. `parent_save_id` and `is_archived` are deliberately NOT in the
  // update set: a fork's parent and an archive flag are app state, not source data, and
  // re-running the seed must not undo either.
  const currentSave = db
    .select({ name: save.name, description: save.description, createdAt: save.createdAt })
    .from(save)
    .where(eq(save.id, saveId))
    .get();
  const saveMatches =
    currentSave !== undefined &&
    currentSave.name === input.save.name &&
    currentSave.description === input.save.description &&
    currentSave.createdAt === input.save.createdAt;

  if (!saveMatches) {
    db.insert(save)
      .values({
        id: saveId,
        name: input.save.name,
        description: input.save.description,
        createdAt: input.save.createdAt,
        isArchived: false,
      })
      .onConflictDoUpdate({
        target: save.id,
        set: {
          name: input.save.name,
          description: input.save.description,
          createdAt: input.save.createdAt,
        },
      })
      .run();
  }

  // ---- groupings, upserted on the natural key §7.4 names: the nation's name within the
  // save, with the export's own id taking precedence where both exist.
  const existingGroupings = db
    .select({ id: grouping.id, name: grouping.name, color: grouping.color })
    .from(grouping)
    .where(eq(grouping.saveId, saveId))
    .all();
  const groupingById = new Map(existingGroupings.map((row) => [row.id, row]));
  const groupingIdByName = new Map(existingGroupings.map((row) => [row.name, row.id]));

  /** The export's grouping id → the row id actually written, once a rename is absorbed. */
  const resolvedGroupingId = new Map<string, string>();
  const claimed = new Set<string>();

  // Assignment first, writes second, so a pathological rename cannot silently merge two
  // nations into one row: two source groups landing on the same existing row is a conflict
  // this loop names, rather than a second UPDATE overwriting the first.
  for (const source of input.groupings) {
    // Identity before name. Both agree on a plain re-run; they differ only when the author
    // renamed a nation in the map app (the id survives, the name does not) or deleted and
    // recreated one under the same name (the name survives, the id does not) — and the
    // first of those is the case a name-only lookup would miss and then insert straight
    // into a primary-key conflict.
    const byId = groupingById.has(source.id) ? source.id : undefined;
    const id = byId ?? groupingIdByName.get(source.name) ?? source.id;

    if (claimed.has(id)) {
      throw new Error(
        `seed: ${input.file} maps two unified nations onto grouping row "${id}" in save ` +
          `"${saveId}" — "${source.name}" is one of them. Writing both would merge two ` +
          `nations into one row. Reset the save's groupings, or give the nations distinct ` +
          `names in the export.`,
      );
    }
    claimed.add(id);
    resolvedGroupingId.set(source.id, id);
  }

  let groupingsInserted = 0;
  let groupingsUpdated = 0;
  let groupingsUnchanged = 0;

  for (const source of input.groupings) {
    // Non-null by construction: the assignment loop above visits every grouping.
    const id = resolvedGroupingId.get(source.id) as string;
    const current = groupingById.get(id);

    if (current !== undefined && current.name === source.name && current.color === source.color) {
      groupingsUnchanged += 1;
      continue;
    }
    if (current !== undefined) groupingsUpdated += 1;
    else groupingsInserted += 1;

    db.insert(grouping)
      .values({ id, saveId, name: source.name, color: source.color })
      .onConflictDoUpdate({
        target: grouping.id,
        set: { saveId, name: source.name, color: source.color },
      })
      .run();
  }

  // ---- membership. Read the current rows once: they decide insert / update / skip, and
  // they are also what says whether the leader flag has to be cleared at all.
  const existingMembers = new Map(
    db
      .select({
        countryId: groupingCountry.countryId,
        groupingId: groupingCountry.groupingId,
        isLeader: groupingCountry.isLeader,
      })
      .from(groupingCountry)
      .where(eq(groupingCountry.saveId, saveId))
      .all()
      .map((row) => [row.countryId, row] as const),
  );

  const leaderCountryIds = input.leaders.map((leader) => leader.countryId);
  const leaderCountryIdSet = new Set(leaderCountryIds);

  // Demote every country that holds the flag and should not, BEFORE anything is promoted.
  // Scoped to the countries actually losing it (and skipped entirely when there are none)
  // so a re-run issues no statement here — see the module header on byte-identity.
  const demoting = [...existingMembers.values()].some(
    (row) => row.isLeader && !leaderCountryIdSet.has(row.countryId),
  );
  if (demoting) {
    db.update(groupingCountry)
      .set({ isLeader: false })
      .where(
        and(
          eq(groupingCountry.saveId, saveId),
          eq(groupingCountry.isLeader, true),
          leaderCountryIds.length === 0
            ? undefined
            : not(inArray(groupingCountry.countryId, leaderCountryIds)),
        ),
      )
      .run();
    for (const row of existingMembers.values()) {
      if (row.isLeader && !leaderCountryIdSet.has(row.countryId)) row.isLeader = false;
    }
  }

  let membershipsInserted = 0;
  let membershipsUpdated = 0;
  let membershipsUnchanged = 0;
  let leadersSet = 0;
  const writtenCountryIds = new Set<string>();

  for (const source of input.groupings) {
    // Non-null by construction: every grouping was written immediately above.
    const groupingId = resolvedGroupingId.get(source.id) as string;
    for (const countryId of source.countryIds) {
      const isLeader = leaderCountryIdSet.has(countryId);
      const current = existingMembers.get(countryId);

      writtenCountryIds.add(countryId);
      if (isLeader) leadersSet += 1;

      if (
        current !== undefined &&
        current.groupingId === groupingId &&
        current.isLeader === isLeader
      ) {
        membershipsUnchanged += 1;
        continue;
      }
      if (current !== undefined) membershipsUpdated += 1;
      else membershipsInserted += 1;

      db.insert(groupingCountry)
        .values({ saveId, groupingId, countryId, isLeader })
        .onConflictDoUpdate({
          target: [groupingCountry.saveId, groupingCountry.countryId],
          set: { groupingId, isLeader },
        })
        .run();
    }
  }

  // ---- P1.11.4. `countryNames` is a display cache, not authored renames: Map.jsx:157
  // writes `geo.properties.name` on every click. Only the entries that DIFFER from the
  // derived default arrive here, so this loop normally writes nothing.
  const existingOverrides = new Map(
    db
      .select({ countryId: countryOverride.countryId, name: countryOverride.name })
      .from(countryOverride)
      .where(eq(countryOverride.saveId, saveId))
      .all()
      .map((row) => [row.countryId, row.name] as const),
  );

  let overridesInserted = 0;
  let overridesUpdated = 0;
  let overridesUnchanged = 0;
  for (const override of input.overrides) {
    const current = existingOverrides.get(override.countryId);
    if (current === override.name) {
      overridesUnchanged += 1;
      continue;
    }
    if (current !== undefined) overridesUpdated += 1;
    else overridesInserted += 1;

    db.insert(countryOverride)
      .values({ saveId, countryId: override.countryId, name: override.name })
      .onConflictDoUpdate({
        target: [countryOverride.saveId, countryOverride.countryId],
        set: { name: override.name },
      })
      .run();
  }

  return {
    file: input.file,
    saveId,
    saveName: input.save.name,
    saveInserted: currentSave === undefined,
    saveChanged: !saveMatches,
    groupingsInserted,
    groupingsUpdated,
    groupingsUnchanged,
    membershipsInserted,
    membershipsUpdated,
    membershipsUnchanged,
    leadersSet,
    overridesInserted,
    overridesUpdated,
    overridesUnchanged,
    staleMemberships: [...existingMembers.keys()].filter((id) => !writtenCountryIds.has(id)).length,
    staleGroupings: [...groupingById.keys()].filter((id) => !claimed.has(id)).length,
  };
}

/** Counts read back out of the database — what the seed report and P1.11.5 assert on. */
export interface MapSaveCounts {
  groupings: number;
  memberships: number;
  leaders: number;
  overrides: number;
  /** Distinct groupings holding a leader. Equal to `leaders` unless the index is gone. */
  groupingsWithLeader: number;
}

/** Read one save's map rows back, after the writes. */
export function countMapSaveRows(db: Db, saveId: string): MapSaveCounts {
  const one = (value: number | undefined): number => value ?? 0;
  const isThisSave = eq(groupingCountry.saveId, saveId);
  const isLeaderHere = and(isThisSave, eq(groupingCountry.isLeader, true));

  return {
    groupings: one(
      db
        .select({ n: sql<number>`count(*)` })
        .from(grouping)
        .where(eq(grouping.saveId, saveId))
        .get()?.n,
    ),
    memberships: one(
      db
        .select({ n: sql<number>`count(*)` })
        .from(groupingCountry)
        .where(isThisSave)
        .get()?.n,
    ),
    leaders: one(
      db
        .select({ n: sql<number>`count(*)` })
        .from(groupingCountry)
        .where(isLeaderHere)
        .get()?.n,
    ),
    overrides: one(
      db
        .select({ n: sql<number>`count(*)` })
        .from(countryOverride)
        .where(eq(countryOverride.saveId, saveId))
        .get()?.n,
    ),
    groupingsWithLeader: one(
      db
        .select({ n: sql<number>`count(distinct ${groupingCountry.groupingId})` })
        .from(groupingCountry)
        .where(isLeaderHere)
        .get()?.n,
    ),
  };
}
