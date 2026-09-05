// The dump-freshness gate: the executable half of "db:reset refuses unless a dump newer
// than the last write exists" (implementation.html P1.7.3, architecture.html §7.4).
//
// The dump tooling itself is P11. Until it lands there is nothing to be fresh, so the gate
// degrades by REFUSING and naming why, not by waving the destructive path through — a
// guard that silently passes while its precondition is unimplementable is worse than no
// guard, because it reads as protection. `--force` is the documented override; the refusal
// text changes on its own the day `db:dump` appears in package.json.
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { readManifest, rel, repoRoot } from './repo.mjs';

/**
 * The database and its SQLite sidecars — `-journal` in rollback mode, `-wal` + `-shm` in
 * WAL mode. In WAL mode the committed data lives in the `-wal` file, so a reset that
 * removes only the `.db` leaves a half-reset, and a freshness check that reads only the
 * `.db`'s mtime misses the writes that actually happened.
 */
export const DB_FILENAMES = Object.freeze([
  'lifestream.db',
  'lifestream.db-journal',
  'lifestream.db-wal',
  'lifestream.db-shm',
]);

/** Absolute paths to all four, present or not. */
export const dbFilePaths = (root = repoRoot) =>
  DB_FILENAMES.map((file) => path.join(root, 'data', file));

/** Absolute path to the database itself. */
export const dbPath = (root = repoRoot) => path.join(root, 'data', 'lifestream.db');

/** Where `db:dump` writes (P11.1). Committed — unlike the database. */
export const dumpDir = (root = repoRoot) => path.join(root, 'data', 'save_dumps');

/** The most recent mtime across the database and its sidecars: the "last write". */
export function lastWrite(root = repoRoot) {
  let at = null;
  let from = null;
  for (const file of dbFilePaths(root)) {
    if (!existsSync(file)) continue;
    const mtime = statSync(file).mtimeMs;
    if (at === null || mtime > at) {
      at = mtime;
      from = file;
    }
  }
  return { at, from };
}

/** The newest `*.json` under `data/save_dumps/`, or null when there is none. */
export function newestDump(root = repoRoot) {
  const dir = dumpDir(root);
  if (!existsSync(dir)) return null;
  let best = null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(dir, entry.name);
    const at = statSync(file).mtimeMs;
    if (best === null || at > best.at) best = { file, at };
  }
  return best;
}

/** Has P11 landed? The gate's message depends on it, so it is read, not assumed. */
export const dumpToolInstalled = () => typeof readManifest()?.scripts?.['db:dump'] === 'string';

const stamp = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z';

const ago = (ms) => {
  // A negative delta is clock skew, not freshness. Say so — rendering a file stamped in the
  // future as "just now" is how a stale dump gets mistaken for a fresh one.
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 0) return `stamped ${-mins} min in the future`;
  if (mins < 1) return 'just now';
  if (mins < 90) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
};

/**
 * Decide whether the destructive path may proceed.
 *
 * @returns {{ ok: boolean; status: string; lines: string[]; remedy: string[] }}
 *   `status` is one of `no-database` · `fresh` · `stale` · `no-dumps` · `no-tooling`.
 *   `lines` explains the finding; `remedy` says what to do about it. Both are printed by
 *   the caller so that a refusal and a `--force` override read the same facts.
 */
export function freshnessGate(root = repoRoot) {
  const write = lastWrite(root);
  if (write.at === null) {
    return {
      ok: true,
      status: 'no-database',
      lines: [`no database at ${rel(dbPath(root))} — nothing to lose.`],
      remedy: [],
    };
  }

  const written = `last write ${stamp(write.at)} (${ago(write.at)}) — ${rel(write.from)}`;
  const dump = newestDump(root);

  if (dump === null) {
    return dumpToolInstalled()
      ? {
          ok: false,
          status: 'no-dumps',
          lines: [written, `no dump in ${rel(dumpDir(root))} — the database is the only copy.`],
          remedy: [
            'take one first:  npm run db:dump',
            'or override:     npm run db:reset -- --force',
          ],
        }
      : {
          ok: false,
          status: 'no-tooling',
          lines: [
            written,
            'no `db:dump` script yet — the backup tooling lands in P11, so no dump can exist.',
            'until then every reset is unbacked by construction, which is exactly what this',
            'gate is for: acknowledge it explicitly rather than let it pass silently.',
          ],
          remedy: ['override:  npm run db:reset -- --force'],
        };
  }

  const dumpLine = `newest dump ${stamp(dump.at)} (${ago(dump.at)}) — ${rel(dump.file)}`;
  if (dump.at >= write.at) {
    return { ok: true, status: 'fresh', lines: [written, dumpLine], remedy: [] };
  }

  const gapMin = Math.max(1, Math.round((write.at - dump.at) / 60000));
  return {
    ok: false,
    status: 'stale',
    lines: [
      written,
      dumpLine,
      `the dump is ${gapMin} min older than the last write — that much work has no backup.`,
    ],
    remedy: [
      'take a fresh one:  npm run db:dump',
      'or override:       npm run db:reset -- --force',
    ],
  };
}
