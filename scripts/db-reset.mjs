// Deletes the local SQLite database so it can be rebuilt from migrations + seed.
// P1.7 constrains this further: it must refuse unless a dump newer than the last
// write exists. That guard lands with the backup tooling in P11; until then the
// database holds nothing that is not reproducible from `db:migrate` + `db:seed`.
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Anchored on this file, never on the working directory. The targets used to be bare
// relative paths, so `node scripts/db-reset.mjs` run from anywhere else deleted THAT
// directory's `data/*.db` — verified by running it in a scratch tree and watching the
// decoy disappear. `server/src/db/index.ts` anchors `DB_PATH` the same way, and the two
// must resolve to the same file for this script to be reset-the-real-database.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The anchor makes a wrong cwd harmless; it does not make a wrong *copy* harmless — a
// script vendored into another tree would happily delete that tree's database. So
// confirm the anchored root really is this repo before unlinking anything.
const manifestPath = path.join(repoRoot, 'package.json');
let manifestName;
try {
  manifestName = JSON.parse(readFileSync(manifestPath, 'utf8')).name;
} catch {
  manifestName = undefined;
}
if (manifestName !== 'lifestream') {
  console.error(`db-reset refused: ${repoRoot} is not the lifestream repo.`);
  console.error(
    manifestName === undefined
      ? `  expected ${manifestPath} to be readable JSON naming this repo; it is not.`
      : `  expected "name": "lifestream" in ${manifestPath}; found "${manifestName}".`,
  );
  console.error('  nothing was deleted.');
  process.exit(1);
}

// SQLite keeps sidecars next to the database file: `-journal` in rollback mode,
// `-wal` + `-shm` in WAL mode. A sidecar left beside a freshly-created database is a
// corruption source, so all four are removed together (and all four are gitignored).
const targets = [
  'lifestream.db',
  'lifestream.db-journal',
  'lifestream.db-wal',
  'lifestream.db-shm',
].map((file) => path.join(repoRoot, 'data', file));

let removed = 0;
for (const target of targets) {
  if (existsSync(target)) {
    unlinkSync(target);
    console.log(`removed ${path.relative(repoRoot, target)}`);
    removed += 1;
  }
}

if (removed === 0) {
  console.log('nothing to remove');
} else {
  console.log(`db reset (${removed} file(s))`);
  // Unlinking a file the server still has open does not close its handle: the process
  // keeps writing to an inode with no directory entry, so its work vanishes and the
  // next `db:migrate` builds a database nobody is reading.
  console.log('restart the dev server — a running server still holds the deleted file open.');
}
