/**
 * The one database connection. `data/lifestream.db` is gitignored and rebuilt from
 * migrations + seed (architecture.html §7.4).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import * as schema from './schema.js';

// This module sits two directories below `server/` in both layouts — `server/src/db`
// under tsx and `server/dist/db` once built — so the workspace root is three up, and the
// path does not depend on which workspace the process was started from.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const DB_PATH = path.join(repoRoot, 'data', 'lifestream.db');

// Annotated explicitly: the namespace type behind `new Database()` is not nameable in
// this module's emitted declarations without it (TS4023).
export const sqlite: SqliteDatabase = new Database(DB_PATH);

// Off by default in SQLite, and every per-save row is an FK away from `save`.
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });

export type Db = typeof db;
