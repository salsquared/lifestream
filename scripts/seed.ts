/**
 * `npm run db:seed` — the world seed (architecture.html §4.1 puts it here at the root, not
 * in a workspace, because it writes shared data through `@server/db` and reads the authored
 * inputs under `data/`).
 *
 * This file is the composition root and nothing else: it anchors the repo root, checks that
 * migration #1 has run, hands `deriveFeatures` and the paths to `server/src/seed/`, and
 * prints what came back. The work is over there, where it is importable by the spec.
 *
 * P1 seeds countries (P1.9) and every world in `data/map_saves/` (P1.11). Tags, events,
 * timelines and the registry land with P1.8/P3.
 *
 * ── WHY `deriveFeatures` IS IMPORTED HERE AND NOT THERE ───────────────────────────────
 * This script runs under the ROOT `tsx`, and there is no root `tsconfig.json` — so the
 * `@shared/*` path alias does not resolve for this process, and a runtime `@shared` import
 * anywhere in the graph below would fail. Every `@shared` import under `server/src` is
 * `import type` and erases; this one is a value, so it is written relative and passed down.
 * There is still exactly ONE implementation of the topojson index (§3.1, P1.9.1).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DB_PATH, appDb } from '../server/src/db/index.js';
import { formatSeedReport, readSeedInputs, runSeed } from '../server/src/seed/index.js';
import { deriveFeatures } from '../shared/src/geo/deriveFeatures.js';

// Anchored on this file, never on the working directory — the same rule `db-reset.mjs` and
// `server/src/db/index.ts` follow, so all three resolve to the same tree no matter where
// the command was typed.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The database path as a reader would type it: repo-relative inside the tree, absolute outside. */
const displayPath = (target: string): string => {
  const relative = path.relative(repoRoot, target);
  return relative.startsWith('..') || path.isAbsolute(relative) ? target : relative;
};

/**
 * Migration #1 creates every table (P1.6). Without it the first insert fails with
 * `no such table: country`, which reads like a code bug and is not one.
 */
function assertMigrated(): void {
  const table = appDb.sqlite
    .prepare(`select name from sqlite_master where type = 'table' and name = ?`)
    .get('country');
  if (table === undefined) {
    console.error(`db:seed refused: ${displayPath(DB_PATH)} has no 'country' table.`);
    console.error('  run `npm run db:migrate` first — the seed writes rows, it does not');
    console.error('  create the schema.');
    process.exit(1);
  }
}

console.log(`db:seed -> ${displayPath(DB_PATH)}`);
assertMigrated();

try {
  const inputs = readSeedInputs(repoRoot, deriveFeatures);
  const report = runSeed(appDb, inputs);
  console.log('');
  for (const line of formatSeedReport(report)) console.log(line);
  console.log('');
  console.log('db:seed complete. Re-running is a no-op: every write is an upsert on a natural');
  console.log('key and nothing is deleted (architecture.html §7.4, P1.7.2).');
} catch (error) {
  console.error('');
  console.error(error instanceof Error ? error.message : String(error));
  console.error('');
  console.error('nothing was written — the whole seed is one transaction.');
  process.exit(1);
} finally {
  appDb.close();
}
