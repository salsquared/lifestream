// Content fingerprints for the seed-idempotence check.
//
// Two different notions of "unchanged" are needed and they are not interchangeable:
//
//   fileDigest()   — raw bytes. Used to assert the REAL database was never touched. It is
//                    deliberately over-strict: any write at all, even a page-layout churn
//                    that leaves the rows identical, must trip it.
//   fingerprint()  — logical row content, order-independent. Used to compare two seed runs.
//                    Bytes are useless here: SQLite rewrites pages, reuses freelist entries
//                    and moves rows on an UPSERT that changes nothing, so a byte comparison
//                    would report every idempotent seed as non-idempotent.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import Database from 'better-sqlite3';

const sha256 = (input) => createHash('sha256').update(input).digest('hex');

/** sha256 over the file's bytes, or `null` when it does not exist. */
export const fileDigest = (file) => (existsSync(file) ? sha256(readFileSync(file)) : null);

/** sha256 over a list of files' bytes, keyed by name so a missing file is itself a change. */
export const filesDigest = (files) =>
  sha256(files.map((file) => `${file}:${fileDigest(file) ?? 'absent'}`).join('\n'));

/**
 * JSON with sorted keys, and BLOBs as base64 — `JSON.stringify` alone renders a Buffer as
 * `{"type":"Buffer","data":[…]}`, which is stable but enormous.
 */
function canonical(row) {
  const keys = Object.keys(row).sort();
  const parts = keys.map((key) => {
    const value = row[key];
    if (value === null || value === undefined) return `${key}:null`;
    if (Buffer.isBuffer(value)) return `${key}:b64:${value.toString('base64')}`;
    if (typeof value === 'bigint') return `${key}:n:${value.toString()}`;
    return `${key}:${JSON.stringify(value)}`;
  });
  return parts.join('');
}

/**
 * A per-table, order-independent digest of everything a user table holds.
 *
 * @param {string} file  path to a SQLite database.
 * @returns {{ tables: Array<{ name: string; rows: number; hash: string }>; hash: string;
 *            rows: number }}
 */
export function fingerprint(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const names = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' " +
          "AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => row.name);

    const tables = names.map((name) => {
      // Row digests are hashed individually and then SORTED, so two runs that insert the
      // same rows in a different order — which an upsert-by-natural-key seed routinely
      // does — compare equal. Only the content matters.
      const digests = [];
      for (const row of db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).iterate()) {
        digests.push(sha256(canonical(row)));
      }
      digests.sort();
      return { name, rows: digests.length, hash: sha256(digests.join('\n')) };
    });

    return {
      tables,
      rows: tables.reduce((sum, table) => sum + table.rows, 0),
      hash: sha256(tables.map((table) => `${table.name}:${table.rows}:${table.hash}`).join('\n')),
    };
  } finally {
    db.close();
  }
}

/** The tables whose content differs between two fingerprints, for the failure report. */
export function diff(before, after) {
  const byName = (fp) => new Map(fp.tables.map((table) => [table.name, table]));
  const [a, b] = [byName(before), byName(after)];
  const rows = [];
  for (const name of new Set([...a.keys(), ...b.keys()].sort())) {
    const left = a.get(name);
    const right = b.get(name);
    if (left && right && left.hash === right.hash) continue;
    rows.push({ name, before: left ? left.rows : null, after: right ? right.rows : null });
  }
  return rows;
}

/**
 * A consistent copy of a possibly-live database, via SQLite's own backup API rather than a
 * file copy: `cp` of a database with an active writer produces a torn file, and the sidecars
 * would have to be copied atomically with it. `backup()` needs no sidecars at the far end.
 */
export async function snapshot(source, destination) {
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await db.backup(destination);
  } finally {
    db.close();
  }
}
