// `npm run db:reset` — delete the local SQLite database so it can be rebuilt from
// migrations + seed. The single destructive command in the repo, and therefore the one
// with the most guards on it (implementation.html P1.7.3, architecture.html §7.4).
//
// Three guards, in the order they fire:
//
//   1. IDENTITY (scripts/lib/repo.mjs) — the targets are anchored on `import.meta.url` and
//      the anchored root must be this repo. Not overridable by anything: there is no good
//      reason to delete another tree's database from here.
//   2. FRESHNESS (scripts/lib/backup.mjs) — refuse unless a dump newer than the last write
//      exists. `--force` overrides, loudly, and says exactly what is being overridden.
//   3. SIDECARS — the `-wal`/`-shm`/`-journal` siblings go with the `.db`, because in WAL
//      mode the committed data is in the `-wal` and removing only the `.db` half-resets.
//
// Usage:  node scripts/db-reset.mjs [--force] [--dry-run]
//         npm run db:reset -- --force
import { existsSync, unlinkSync } from 'node:fs';

import { dbFilePaths, freshnessGate } from './lib/backup.mjs';
import { assertLifestreamRepo, parseArgs, rel, repoRoot } from './lib/repo.mjs';

const USAGE = [
  'usage: node scripts/db-reset.mjs [--force] [--dry-run]',
  '',
  '  --force    proceed even though no dump newer than the last write exists.',
  '             Overrides the freshness gate ONLY — never the repo-identity check.',
  '  --dry-run  list what would be deleted and exit. Implies no deletion at all.',
];

let args;
try {
  args = parseArgs(process.argv.slice(2), { flags: ['--force', '--dry-run', '--help'] });
} catch (error) {
  console.error(`db-reset refused: ${error.message}`);
  console.error(USAGE.join('\n'));
  console.error('  nothing was deleted.');
  process.exit(1);
}

if (args.help) {
  console.log(USAGE.join('\n'));
  process.exit(0);
}

// Guard 1. Before anything is read, let alone unlinked.
assertLifestreamRepo('db-reset', 'nothing was deleted.');

const targets = dbFilePaths(repoRoot).filter((file) => existsSync(file));

// Guard 2. The gate is evaluated even under `--force` and even for a dry run, so the
// output always states the backup situation rather than only mentioning it on refusal.
const gate = freshnessGate(repoRoot);
for (const line of gate.lines) console.log(`  ${line}`);

if (!gate.ok && !args['dry-run'] && !args.force) {
  console.error('');
  console.error(`db-reset refused: no backup newer than the last write (${gate.status}).`);
  for (const line of gate.remedy) console.error(`  ${line}`);
  console.error('  nothing was deleted.');
  process.exit(1);
}

if (!gate.ok && args.force) {
  console.log('');
  console.log(`  --force: proceeding without a fresh backup (${gate.status}).`);
  console.log('  whatever is in the database and not in a dump is gone after this.');
}

if (args['dry-run']) {
  console.log('');
  if (targets.length === 0) {
    console.log('dry run: nothing to remove');
  } else {
    for (const target of targets) console.log(`dry run: would remove ${rel(target)}`);
    if (!gate.ok) console.log(`dry run: the freshness gate would refuse this (${gate.status})`);
  }
  process.exit(0);
}

console.log('');
for (const target of targets) {
  unlinkSync(target);
  console.log(`removed ${rel(target)}`);
}

if (targets.length === 0) {
  console.log('nothing to remove');
} else {
  console.log(`db reset (${targets.length} file(s))`);
  // Unlinking a file the server still has open does not close its handle: the process
  // keeps writing to an inode with no directory entry, so its work vanishes and the
  // next `db:migrate` builds a database nobody is reading.
  console.log('restart the dev server — a running server still holds the deleted file open.');
}
