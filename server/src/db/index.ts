/**
 * The database connection — a FACTORY, plus the one app-wide instance built from it.
 *
 * P0 shipped this module as a bare singleton: `new Database(DB_PATH)` at module scope, so
 * importing anything that reached the database opened `data/lifestream.db`. P1.6.3 replaces
 * that with `createDb(url)`, because two of the plan's four committed tests — the country
 * import (P1.9.5) and the fork remap (P6.2.8) — are written against a `:memory:` fixture and
 * cannot exist while the only handle in the codebase is bound to the real file.
 *
 * `data/lifestream.db` is gitignored and rebuilt from migrations + seed (architecture §7.4).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import * as schema from './schema.js';

// This module sits two directories below `server/` in both layouts — `server/src/db`
// under tsx and `server/dist/db` once built — so the workspace root is three up, and the
// path does not depend on which workspace the process was started from.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Where the app-wide instance lives when `LIFESTREAM_DB` says nothing. */
const DEFAULT_DB_PATH = path.join(repoRoot, 'data', 'lifestream.db');

/**
 * The database the app and the seed open — `data/lifestream.db`, unless `LIFESTREAM_DB`
 * redirects them.
 *
 * The env override is the second half of the test-fixture decision (P1.6.3, which names
 * both shapes). `createDb(':memory:')` covers a spec that builds its own world; this covers
 * everything that has to run the REAL entry points — `scripts/db-check-seed.mjs` proves
 * `db:seed` is idempotent by running the actual command twice, and it can only do that
 * safely by pointing it at a snapshot. A seed that cannot be redirected is a seed that
 * cannot be tested.
 *
 * A relative value is resolved against the current working directory, so `LIFESTREAM_DB`
 * behaves like a path typed at the shell. `:memory:` and better-sqlite3's other special
 * forms are passed through untouched.
 */
export const DB_PATH = ((): string => {
  const override = process.env.LIFESTREAM_DB;
  if (override === undefined || override === '') return DEFAULT_DB_PATH;
  return override.startsWith(':') ? override : path.resolve(override);
})();

/**
 * The drizzle handle, typed against the full schema. Written as the driver's own type
 * rather than `typeof db` so it does not depend on the app-wide instance below — a
 * `:memory:` handle from {@link createDb} is the same type as the real one, which is the
 * whole point of the factory.
 */
export type Db = BetterSQLite3Database<typeof schema>;

/**
 * One open connection: the drizzle handle, the raw better-sqlite3 connection underneath
 * it, and a close.
 *
 * The raw connection is part of the contract, not an escape hatch. `sqlite.transaction()`
 * is how a caller wraps many drizzle statements in one transaction while every helper it
 * calls keeps taking a plain {@link Db} (drizzle's own `db.transaction()` hands back a
 * transaction object of a different type, which would infect every signature it touches),
 * and `close()` is what a test fixture needs at teardown.
 */
export interface DbHandle {
  db: Db;
  sqlite: SqliteDatabase;
  close(): void;
}

/**
 * Open a database and wrap it in drizzle.
 *
 * @param url a filesystem path, or `':memory:'` for a throwaway database. Every caller
 *            that is not the app itself should pass `':memory:'`; the real file has one
 *            owner, the export below.
 */
export function createDb(url: string): DbHandle {
  const sqlite: SqliteDatabase = new Database(url);

  // Off by default in SQLite, and every per-save row is an FK away from `save`. It has to
  // be set per CONNECTION, not once per database, which is why it lives in the factory.
  sqlite.pragma('foreign_keys = ON');

  const db = drizzle(sqlite, { schema });

  return { db, sqlite, close: () => sqlite.close() };
}

/**
 * The app-wide instance — the thin call to {@link createDb} that P1.6.3 asks for, kept as
 * a module-level binding because `server/src/index.ts` imports this module for the side
 * effect of creating the file, and the route modules hold `db` at module scope.
 */
export const appDb: DbHandle = createDb(DB_PATH);

/** The two halves of {@link appDb}, kept as their own exports for the route modules. */
export const sqlite: SqliteDatabase = appDb.sqlite;
export const db: Db = appDb.db;
