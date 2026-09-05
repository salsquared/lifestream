/**
 * `npm run db:seed` — the world seed (architecture.html §4.1 puts it here at the root, not
 * in a workspace, because it writes shared data through `@server/db` and reads the authored
 * inputs under `data/`).
 *
 * This file is the composition root and nothing else: it anchors the repo root, checks that
 * migration #1 has run, hands `deriveFeatures` and the paths to `server/src/seed/`, and
 * prints what came back. The work is over there, where it is importable by the spec.
 *
 * P1 seeds countries (P1.9) and every world in `data/map_saves/` (P1.11). P3 adds the
 * authored world under the canon save: the tag vocabulary (P3.1), the registry (P3.2), the
 * Pre-Big One events (P3.3) and the root timeline plus its first era (P3.4). P4B.3 adds the
 * one argument this script takes — see the next block.
 *
 * ── WHY THREE FUNCTIONS ARE IMPORTED HERE AND NOT THERE ───────────────────────────────
 * This script runs under the ROOT `tsx`, and there is no root `tsconfig.json` — so the
 * `@shared/*` path alias does not resolve for this process, and a runtime `@shared` import
 * anywhere in the graph below would fail. Every `@shared` import under `server/src` is
 * `import type` and erases; these three are values, so they are written relative and
 * passed down. There is still exactly ONE implementation of the topojson index (§3.1,
 * P1.9.1) and ONE of the date roll (§2.6, P1.8) — the seed and the UI editor share it,
 * which is what makes them agree on the same point for the same event.
 *
 * ── `--new-save`, AND WHAT IT IS NOT (P4B.3) ──────────────────────────────────────────
 * architecture.html §7.4 has promised this flag since P0 — "the way to get a clean slate is
 * `db:seed --new-save`, which creates a fresh save and leaves the existing tree intact" —
 * and until now the script took no arguments at all.
 *
 * Be precise about its role, because the doc overstates it. `--new-save` is the CLEAN-SLATE
 * ESCAPE HATCH: a what-if world, a throwaway test target, a recovery when a re-seed has
 * left orphans you cannot reconcile. It is NOT the mechanism for taking a corrected Bible.
 * A Bible correction re-seeds `sav_canon` IN PLACE, because the seed is idempotent and
 * never destructive (§7.4, P1.7.2) and because there is exactly one canon — minting a
 * second save per correction would leave a pile of near-identical worlds and no answer to
 * "which one is the story".
 *
 * The whole feature is a pure transform on the inputs object, applied AFTER
 * `readSeedInputs` and BEFORE `runSeed`: `seedCanon` reads `inputs.canonSaveId` and
 * `seedMapSave` reads each `input.save.id`, so rewriting those two is the entire swap. That
 * is why {@link retargetCanonSave} lives here and not under `server/src/seed/` — nothing
 * downstream needs to know the flag exists.
 *
 * ── A SAVE MINTED HERE CANNOT BE OPENED IN THE APP YET ────────────────────────────────
 * `client/src/shell/stores/save.ts` hard-codes `CANON_SAVE_ID = 'sav_canon'` and there is
 * no save picker until P6. So the save this flag mints is real, complete and CORRECT in the
 * database, and there is nothing in the browser that can navigate to it. Someone who runs
 * the flag, reloads the app and sees the same world would reasonably conclude it failed. It
 * did not: reaching a second save is P6's job (P6.3.2 turns `CANON_SAVE_ID` into real
 * state). This is said in `--help`, in the plan the run prints, and again in its closing
 * line, because a silent success that looks like a failure is worse than an error.
 *
 * ── WHY THE DATABASE IS IMPORTED LAZILY, AND WHY THERE IS A MAIN GUARD ────────────────
 * `server/src/db/index.ts` opens `data/lifestream.db` at module scope, so a static import
 * would mean `--help` creates a database file and `tests/seedNewSave.test.ts` could not
 * import the pure transform without one. The `import.meta.url === process.argv[1]` guard is
 * the same idiom `scripts/fontCoverage.mjs:354` uses for the same reason — its spec imports
 * it too.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { formatSeedReport, readSeedInputs, runSeed } from '../server/src/seed/index.js';
import { formatCitationReport } from '../server/src/seed/citations.js';
import { deriveFeatures } from '../shared/src/geo/deriveFeatures.js';
import { precisionToInterval, rollDate } from '../shared/src/rollDate.js';

import type { DbHandle } from '../server/src/db/index.js';
import type { MapSaveInput } from '../server/src/seed/index.js';

/**
 * The raw connection, taken from `DbHandle` rather than redeclared.
 *
 * `import type` erases (`verbatimModuleSyntax`), so naming the real type here does NOT
 * re-introduce the module-scope `new Database(DB_PATH)` the lazy import below avoids.
 */
type Sqlite = DbHandle['sqlite'];

/**
 * The two fields of `SeedInputs` that `--new-save` rewrites.
 *
 * Deliberately NARROWER than `SeedInputs`: the transform below reads these and nothing
 * else, and saying so in the signature is what lets `tests/seedNewSave.test.ts` exercise it
 * against a two-save fixture instead of a hand-built copy of every field `readSeedInputs`
 * returns — a copy that would go stale the next time that interface grows (it grew on
 * 2026-09-05, mid-task, when P4B.1 added `citations`). Callers keep their own type: the
 * transform is generic in it and hands back exactly what it was given.
 */
export interface CanonTargeting {
  /** The save the authored P3 world is written under. `seedCanon` reads this. */
  canonSaveId: string;
  /** One entry per file in `data/map_saves/`. `seedMapSave` reads each `save.id`. */
  saves: MapSaveInput[];
}

// Anchored on this file, never on the working directory — the same rule `db-reset.mjs` and
// `server/src/db/index.ts` follow, so all three resolve to the same tree no matter where
// the command was typed.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The shape of a save id, as the seed already mints them: `sav_canon`, and
 * `sav_${kebab(stem)}` for every other file in `data/map_saves/`
 * (`server/src/seed/inputs.ts`). An explicit `--new-save=<id>` is held to it, and the
 * prefix is NOT added for the caller: an id without `sav_` would not read as a save
 * anywhere else in the tree, and quietly repairing it teaches the wrong convention.
 */
const SAVE_ID = /^sav_[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The tables the authored world (P3) is written into, each keyed on a GLOBAL id.
 *
 * Read {@link assertAuthoredWorldIsFree} for why this list exists; it is not a schema
 * inventory. `tag` is deliberately absent — it carries no `save_id` and is global by
 * design (§7.4) — and so are the child tables (`event_actor`, `timeline_member`, …),
 * which cannot hold a row whose parent is not already counted here.
 */
const AUTHORED_WORLD_TABLES = ['character', 'location', 'project', 'event', 'timeline'] as const;

const USAGE = [
  'usage: npm run db:seed [-- <options>]',
  '',
  '  -h, --help        this text.',
  '  --new-save        seed a FRESH save instead of re-seeding "sav_canon", leaving every',
  '                    existing save and fork exactly as it is. The id is minted from the',
  '                    clock in UTC: sav_2026-09-05-153241.',
  '  --new-save=<id>   the same, under an id you choose. It must look like `sav_whatif`',
  '                    (the `sav_` prefix, then lowercase kebab-case) and it must not',
  '                    already exist — this flag never writes into a save it did not mint.',
  '',
  'WHAT --new-save IS FOR, AND WHAT IT IS NOT',
  '',
  '  It is the clean-slate escape hatch: a what-if world, a throwaway test target, or a',
  '  recovery when a re-seed has left orphans you cannot reconcile.',
  '',
  '  It is NOT how you take a corrected Bible. A Bible correction re-seeds "sav_canon" IN',
  '  PLACE: the seed is idempotent and never destructive (architecture.html §7.4), and',
  '  there is exactly one canon. Plain `npm run db:seed` is the command for that.',
  '',
  'A SAVE MINTED BY --new-save CANNOT BE OPENED IN THE APP YET',
  '',
  "  client/src/shell/stores/save.ts hard-codes CANON_SAVE_ID = 'sav_canon' and there is",
  '  no save picker until P6. The save will exist in the database, complete and correct,',
  '  and nothing in the browser can navigate to it — so running this flag and then',
  '  reloading the app looks exactly like a failure. It is not one. Reaching a second',
  '  save is P6 (P6.3.2 turns CANON_SAVE_ID into real state).',
];

/** `npm run db:seed --`'s arguments, parsed. */
export interface SeedArgs {
  /** `-h` / `--help` — print {@link USAGE} and write nothing. */
  help: boolean;
  /** `--new-save` in either form. */
  newSave: boolean;
  /** The id from `--new-save=<id>`, or `undefined` when one must be minted. */
  newSaveId: string | undefined;
}

/**
 * Parse the command line.
 *
 * An unrecognised argument is a HARD ERROR rather than something ignored, for the reason
 * `scripts/lib/repo.mjs`'s `parseArgs` gives: a typo'd `--new-save` must never read as
 * "re-seed canon in place", which is the one outcome this flag exists to avoid.
 *
 * Only the `--new-save=<id>` spelling takes a value. A `--new-save <id>` form would be
 * ambiguous with the bare flag followed by nothing, and resolving that ambiguity by
 * guessing is how a save id ends up being a stray shell argument.
 *
 * @throws {Error} naming the argument it could not read.
 */
export function parseSeedArgs(argv: readonly string[]): SeedArgs {
  const args: SeedArgs = { help: false, newSave: false, newSaveId: undefined };

  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') {
      args.help = true;
      continue;
    }

    if (arg === '--new-save') {
      args.newSave = true;
      continue;
    }

    if (arg.startsWith('--new-save=')) {
      if (args.newSaveId !== undefined) {
        throw new Error(
          `--new-save=<id> was given twice ("${args.newSaveId}" and ` +
            `"${arg.slice('--new-save='.length)}"). One run mints one save; which of the two ` +
            `won would be decided by argument order, and that is not a thing to leave to ` +
            `argument order.`,
        );
      }
      const id = arg.slice('--new-save='.length);
      if (!SAVE_ID.test(id)) {
        throw new Error(
          `--new-save=${id === '' ? '<empty>' : id} is not a save id. Ids look like ` +
            `\`sav_canon\` or \`sav_whatif\`: the \`sav_\` prefix, then lowercase kebab-case. ` +
            `The prefix is not added for you — every other save id in the tree carries it, ` +
            `and one that does not would not read as a save anywhere.`,
        );
      }
      args.newSave = true;
      args.newSaveId = id;
      continue;
    }

    throw new Error(
      `unknown argument: ${arg}. This script takes --new-save[=<id>] and --help, and refuses ` +
        `everything else — a mistyped --new-save must never read as "re-seed canon in place".`,
    );
  }

  return args;
}

/**
 * Mint a save id from the clock: `sav_2026-09-05-153241`.
 *
 * Readable, sortable, and in the same `sav_` + kebab shape `readSaveRow` mints for the
 * files under `data/map_saves/`. UTC, not local time, so two people minting a save in the
 * same minute from different timezones do not produce ids that sort against each other
 * wrongly. Seconds are in it because minutes are not enough resolution to make an
 * accidental collision impossible — and a collision is refused rather than disambiguated
 * (see {@link assertNewSaveIsFree}), so it must be genuinely rare.
 *
 * @param now the instant the run started. A parameter, not `new Date()`, so this is pure.
 */
export function mintNewSaveId(now: Date): string {
  const iso = now.toISOString();
  return `sav_${iso.slice(0, 10)}-${iso.slice(11, 19).replace(/:/g, '')}`;
}

/** Where a `--new-save` run is aimed. */
export interface NewSaveTarget {
  /** The save id to mint — from `--new-save=<id>`, or {@link mintNewSaveId}. */
  id: string;
  /** ISO-8601 instant the run started. Goes into the provenance line, nowhere else. */
  mintedAt: string;
}

/**
 * Rewrite `inputs` so the canon sources are seeded under `target.id` instead of
 * `inputs.canonSaveId`, leaving every other save in the set alone.
 *
 * PURE: it returns a new object and mutates nothing, which is what makes it testable
 * without a database (`tests/seedNewSave.test.ts`) and what makes the refusals below
 * happen before a statement is issued rather than halfway through a transaction.
 *
 * ── WHY THE GROUPING IDS ARE REWRITTEN TOO ────────────────────────────────────────────
 * This is not cosmetic, and it is the part the design did not anticipate. `grouping.id` is
 * a GLOBAL primary key (`server/src/db/schema.ts:917`), and `inputs.ts` mints it as
 * `grp_${sourceId}` from the map export — so re-seeding the same file under a second save
 * produces the same ids. `seedMapSave` upserts with
 * `onConflictDoUpdate({ target: grouping.id, set: { saveId, … } })`, which would MOVE the
 * canon save's 29 groupings into the new save rather than copy them. Verified 2026-09-05
 * against a scratch copy of `data/lifestream.db`: `grouping_country`'s composite FK on
 * `(save_id, grouping_id)` catches it and the run dies with a bare
 * `FOREIGN KEY constraint failed`. Namespacing the id on the target save is what makes the
 * new save's nations its own rows. `sourceId` is kept by `MapGroupingInput` precisely so
 * the row still traces back to the group in the file.
 *
 * ── WHAT IS DELIBERATELY NOT REWRITTEN ────────────────────────────────────────────────
 * `save.createdAt` keeps the map export's own timestamp. `readSaveRow` refuses to take it
 * from the clock — "inventing a timestamp here would make the seed non-reproducible" — and
 * that reasoning does not stop applying because a flag was passed. The instant the save was
 * minted is provenance, and provenance goes in `description`, which is where this
 * repository already puts it.
 *
 * @throws {Error} if the target collides with the canon save or with another map save in
 *                 the same run. Neither is recoverable and both are silent if allowed
 *                 through: the first re-seeds canon under a name that says it did not, the
 *                 second merges two authored worlds into one save.
 */
export function retargetCanonSave<T extends CanonTargeting>(inputs: T, target: NewSaveTarget): T {
  const from = inputs.canonSaveId;

  if (target.id === from) {
    throw new Error(
      `--new-save=${target.id} is the canon save. Re-seeding canon in place is what plain ` +
        `\`npm run db:seed\` does, and it is the right command for a corrected Bible — the ` +
        `seed is idempotent and never destructive. --new-save exists for a world that is ` +
        `NOT canon.`,
    );
  }

  const collision = inputs.saves.find((entry) => entry.save.id === target.id);
  if (collision !== undefined) {
    throw new Error(
      `--new-save=${target.id} is already the save id of data/map_saves/${collision.file}, ` +
        `which this run also seeds. Both would write into one save and the second would ` +
        `overwrite the first.`,
    );
  }

  const source = inputs.saves.find((entry) => entry.save.id === from);
  if (source === undefined) {
    throw new Error(
      `seed: no map save produced the canon save "${from}", so there are no canon sources to ` +
        `mint "${target.id}" from. \`readSeedInputs\` refuses this case; reaching it here ` +
        `means the two disagree about which save is canon.`,
    );
  }

  const suffix = target.id.slice('sav_'.length);

  /** Canon's grouping row id → the id the same nation gets in the new save. */
  const groupingIds = new Map(
    source.groupings.map((group) => [group.id, `grp_${suffix}_${group.sourceId}`]),
  );

  const description =
    `Fresh save from \`db:seed --new-save\` at ${target.mintedAt}. Seeded from ` +
    `data/map_saves/${source.file} and data/story_docs/LIFEstream Bible.txt — the same ` +
    `sources as "${from}", which this run did not touch.`;

  const saves = inputs.saves.map((entry) => {
    if (entry.save.id !== from) return entry;
    return {
      ...entry,
      save: { ...entry.save, id: target.id, name: `New save ${suffix}`, description },
      // Non-null by construction on both lines: every grouping is in the map above, and
      // every leader was placed into one of THIS entry's groupings by `readMapSave`.
      groupings: entry.groupings.map((group) => ({
        ...group,
        id: groupingIds.get(group.id) as string,
      })),
      leaders: entry.leaders.map((leader) => ({
        ...leader,
        groupingId: groupingIds.get(leader.groupingId) as string,
      })),
      // `seedMapSave` writes `save.id` and never reads this field, so rewriting it changes
      // no row. It is rewritten anyway: an inputs object that says two different things
      // about which save it is for is a trap for whoever reads it next.
      overrides: entry.overrides.map((override) => ({ ...override, saveId: target.id })),
    };
  });

  // The spread is every field of `T` with two replaced, which is what `T` is — but
  // TypeScript cannot prove that for an open type parameter, so it is asserted here rather
  // than by widening the signature to `SeedInputs` and losing the caller's own type.
  return { ...inputs, canonSaveId: target.id, saves } as T;
}

/** The database path as a reader would type it: repo-relative inside the tree, absolute outside. */
const displayPath = (target: string): string => {
  const relative = path.relative(repoRoot, target);
  return relative.startsWith('..') || path.isAbsolute(relative) ? target : relative;
};

/** Print `lines` to stderr, then exit 1. Nothing has been written when this is called. */
function refuse(lines: readonly string[]): never {
  for (const line of lines) console.error(line);
  process.exit(1);
}

/**
 * Migration #1 creates every table (P1.6). Without it the first insert fails with
 * `no such table: country`, which reads like a code bug and is not one.
 */
function assertMigrated(sqlite: Sqlite, dbPath: string): void {
  const table = sqlite
    .prepare(`select name from sqlite_master where type = 'table' and name = ?`)
    .get('country');
  if (table === undefined) {
    refuse([
      `db:seed refused: ${displayPath(dbPath)} has no 'country' table.`,
      '  run `npm run db:migrate` first — the seed writes rows, it does not',
      '  create the schema.',
    ]);
  }
}

/**
 * Refuse `--new-save` when the target id is already taken.
 *
 * The flag mints a save; it does not adopt one. Upserting into a save someone else created
 * is the one behaviour that would make `--new-save` destructive, and it would be silent —
 * the report would count inserts and updates exactly as it does for canon.
 */
function assertNewSaveIsFree(sqlite: Sqlite, targetId: string): void {
  const existing = sqlite.prepare('select name from save where id = ?').get(targetId) as
    { name: string } | undefined;
  if (existing !== undefined) {
    refuse([
      `db:seed --new-save refused: save "${targetId}" already exists ("${existing.name}").`,
      '',
      '  This flag mints a save; it never writes into one it did not mint. Seeding over an',
      "  existing save would upsert into someone else's world and report it as a normal run.",
      '',
      '  Pass a different --new-save=<id>, or omit the id and let one be minted from the clock.',
    ]);
  }
}

/**
 * Refuse `--new-save` when the authored world (P3) already lives under another save.
 *
 * ── THE LIMITATION THIS GUARD MAKES LEGIBLE ───────────────────────────────────────────
 * `server/src/seed/registry.ts`, `events.ts` and `timelines.ts` write the authored world
 * from hardcoded, GLOBAL ids — `char_lazaro`, `loc_star_city`, `evt_big_one` — and upsert
 * with `onConflictDoUpdate({ target: character.id, set: { saveId, … } })`. Under a second
 * save id that statement does not copy the row, it MOVES it: canon's fourteen characters
 * would leave `sav_canon` and arrive in the new save, which is the precise opposite of
 * "leaves the existing tree intact".
 *
 * Verified 2026-09-05 against a scratch copy of `data/lifestream.db`. SQLite does stop it —
 * `character` has three composite children on `(save_id, id)` (`character_relation`,
 * `project.lead_character_id`, `event_actor`) and moving the parent orphans all of them, so
 * the single seed transaction rolls back and nothing is written. But the message is a bare
 * `FOREIGN KEY constraint failed` thrown from inside `seedCharacters`, which reads like a
 * bug in the seed. This guard exists to refuse first and say why, and it costs five counts.
 *
 * So the flag WORKS on a database whose authored world is absent or already belongs to the
 * target — a freshly migrated one, or a `db:reset` — and refuses on one where canon is
 * already seeded. Lifting the refusal means giving the canon seeders per-save ids, which is
 * a change to `server/src/seed/` and is not P4B.3's to make.
 */
function assertAuthoredWorldIsFree(sqlite: Sqlite, targetId: string): void {
  const held = AUTHORED_WORLD_TABLES.map((table) => ({
    table,
    rows: (
      sqlite.prepare(`select count(*) as n from \`${table}\` where save_id <> ?`).get(targetId) as {
        n: number;
      }
    ).n,
  })).filter((entry) => entry.rows > 0);

  if (held.length === 0) return;

  refuse([
    `db:seed --new-save refused: the authored world is already seeded under another save.`,
    '',
    `  found ${held.map((entry) => `${entry.rows} ${entry.table}`).join(', ')} row(s) that do`,
    `  not belong to "${targetId}".`,
    '',
    '  server/src/seed/registry.ts, events.ts and timelines.ts mint GLOBAL ids —',
    '  `char_lazaro`, `loc_star_city`, `evt_big_one` — and upsert on them with',
    '  `set: { saveId, ... }`. Writing them under a second save id MOVES those rows out of',
    '  the save that holds them today instead of copying them, which is exactly the damage',
    '  this flag exists to avoid. SQLite refuses it too (grouping/relation foreign keys), so',
    '  nothing would be written either way — but it refuses with a bare',
    '  "FOREIGN KEY constraint failed" that reads like a bug in the seed.',
    '',
    '  --new-save therefore works against a database whose authored world is absent: after',
    '  `npm run db:reset && npm run db:migrate`, or on a fresh clone. On a database that',
    '  already holds canon, giving the canon seeders per-save ids is the prerequisite, and',
    '  that is a change to server/src/seed/ rather than to this script.',
  ]);
}

async function main(): Promise<void> {
  let args: SeedArgs;
  try {
    args = parseSeedArgs(process.argv.slice(2));
  } catch (error) {
    refuse([
      `db:seed refused: ${error instanceof Error ? error.message : String(error)}`,
      '',
      ...USAGE,
    ]);
  }

  if (args.help) {
    for (const line of USAGE) console.log(line);
    return;
  }

  // Imported here and not at the top of the file: this module opens `data/lifestream.db`
  // the moment it is loaded, and neither `--help` nor the spec should create a database.
  const { DB_PATH, appDb } = await import('../server/src/db/index.js');

  console.log(`db:seed -> ${displayPath(DB_PATH)}`);
  assertMigrated(appDb.sqlite, DB_PATH);

  try {
    const resolved = readSeedInputs(repoRoot, deriveFeatures);
    let inputs = resolved;

    if (args.newSave) {
      const now = new Date();
      const target: NewSaveTarget = {
        id: args.newSaveId ?? mintNewSaveId(now),
        mintedAt: now.toISOString(),
      };

      assertNewSaveIsFree(appDb.sqlite, target.id);
      assertAuthoredWorldIsFree(appDb.sqlite, target.id);
      inputs = retargetCanonSave(resolved, target);

      // Non-null by construction: `retargetCanonSave` returned, so it rewrote this entry.
      const minted = inputs.saves.find((entry) => entry.save.id === target.id) as MapSaveInput;
      console.log('');
      console.log(`db:seed --new-save: minting "${target.id}"`);
      console.log(`  name      ${minted.save.name}`);
      console.log(`  from      data/map_saves/${minted.file} + the Bible — canon's own sources`);
      console.log(`  at        ${target.mintedAt}`);
      console.log(`  untouched "${resolved.canonSaveId}", and every other save and fork.`);
      console.log('');
      console.log('  NOTE: nothing can open this save yet. client/src/shell/stores/save.ts');
      console.log("  hard-codes CANON_SAVE_ID = 'sav_canon' and the save picker is P6, so the");
      console.log('  save will be in the database and unreachable in the browser. That is');
      console.log('  expected, and it is not a failed run.');
    }

    // The citation check ran inside `readSeedInputs` and either threw or did not. Print it
    // either way: a guard that says nothing when it passes is a guard nobody remembers is
    // running, and "142 checked, every line hint current" is the line that tells a reader
    // the Bible and the authored tables are still describing each other. It goes BEFORE the
    // seed report because it is a property of the inputs, not of anything written.
    console.log('');
    for (const line of formatCitationReport(inputs.citations)) console.log(line);

    const report = runSeed(appDb, inputs, { rollDate, precisionToInterval });
    console.log('');
    for (const line of formatSeedReport(report)) console.log(line);
    console.log('');
    if (args.newSave) {
      console.log(`db:seed complete. "${inputs.canonSaveId}" is a fresh save;`);
      console.log(`"${resolved.canonSaveId}" and every other save were left exactly as they`);
      console.log('were. Re-running this command mints ANOTHER save rather than doing nothing —');
      console.log('which is why it refuses an id that already exists. Opening the new save in');
      console.log('the app waits on P6.');
    } else {
      console.log('db:seed complete. Re-running is a no-op: every write is an upsert on a natural');
      console.log('key and nothing is deleted (architecture.html §7.4, P1.7.2).');
    }
  } catch (error) {
    console.error('');
    console.error(error instanceof Error ? error.message : String(error));
    console.error('');
    console.error('nothing was written — the whole seed is one transaction.');
    process.exit(1);
  } finally {
    appDb.close();
  }
}

// Run only when this file IS the command, so `tests/seedNewSave.test.ts` can import the
// pure half. Same guard, same reason, as `scripts/fontCoverage.mjs:354`.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
