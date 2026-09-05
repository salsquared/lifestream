// `node scripts/db-check-seed.mjs` — the executable form of P1.7.2: `db:seed` is idempotent
// (upsert by natural key) and never destructive. Running it twice is a no-op; running it
// after edits does not clobber them (architecture.html §7.4).
//
// Two halves, because neither alone is enough:
//
//   STATIC   greps the seed sources for the constructs that make a seed destructive —
//            DROP / DELETE FROM / TRUNCATE / drizzle's `.delete(`. Cheap, runs with no
//            database, and catches the "never destructive" half of the rule at review time.
//   DYNAMIC  runs the seed TWICE and compares the database's logical content. Only this can
//            prove idempotence, and it is the half that needs care: it must never run the
//            seed against the real `data/lifestream.db`.
//
// How the dynamic half stays safe. It takes a consistent SQLite-level snapshot of the target
// into a throwaway directory and points the seed at THAT via an environment variable
// (`LIFESTREAM_DB` by default), then re-hashes the real database's bytes after every run. If
// the seed ignores the redirect and writes the real file, the check does not merely fail —
// it says so in those words, because a seed that cannot be redirected is a seed that cannot
// be tested, and that is itself a finding.
//
// Exit 0 = compliant · 1 = violation · 2 = inconclusive (could not verify — NOT a pass).
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { diff, fileDigest, filesDigest, fingerprint, snapshot } from './lib/fingerprint.mjs';
import { dbFilePaths, dbPath } from './lib/backup.mjs';
import { assertLifestreamRepo, parseArgs, rel, repoRoot } from './lib/repo.mjs';

const PASS = 0;
const VIOLATION = 1;
const INCONCLUSIVE = 2;

const USAGE = [
  'usage: node scripts/db-check-seed.mjs [options]',
  '',
  '  --db <path>        database to check against (default data/lifestream.db). Never',
  '                     written to: the seed runs against a snapshot of it.',
  '  --seed-cmd <cmd>   the seed command (default "npm run --silent db:seed"). Overridable',
  '                     mainly so this checker can itself be tested against a known-good and',
  '                     a known-bad seed.',
  '  --db-env <NAME>    env var the seed reads its database path from (default LIFESTREAM_DB).',
  '  --work-dir <dir>   where the snapshot goes (default a fresh mkdtemp under $TMPDIR).',
  '  --static-only      skip the dynamic half; no database needed.',
  '  --keep             leave the work directory behind for inspection.',
];

let args;
try {
  args = parseArgs(process.argv.slice(2), {
    flags: ['--static-only', '--keep', '--help'],
    options: ['--db', '--seed-cmd', '--db-env', '--work-dir'],
  });
} catch (error) {
  console.error(`db-check-seed: ${error.message}`);
  console.error(USAGE.join('\n'));
  process.exit(VIOLATION);
}
if (args.help) {
  console.log(USAGE.join('\n'));
  process.exit(PASS);
}

assertLifestreamRepo('db-check-seed', 'nothing was read or written.');

const seedCmd = args['seed-cmd'] ?? 'npm run --silent db:seed';
const dbEnv = args['db-env'] ?? 'LIFESTREAM_DB';
const target = path.resolve(args.db ?? dbPath(repoRoot));

const violations = [];
const warnings = [];

/* ==== static half =================================================================== */
// The seed is one root script today; §4.1 puts the modules it will grow under
// `server/src/seed/`, so both are scanned and a missing directory is not an error.
function seedSources() {
  const files = [];
  const root = path.join(repoRoot, 'scripts', 'seed.ts');
  if (existsSync(root)) files.push(root);
  const dir = path.join(repoRoot, 'server', 'src', 'seed');
  if (existsSync(dir)) {
    const walk = (d) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const file = path.join(d, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (/\.(ts|mts|mjs|js)$/.test(entry.name)) files.push(file);
      }
    };
    walk(dir);
  }
  return files;
}

// Comments are stripped first, or the sentence "this seed never runs DELETE FROM" — exactly
// the sentence a careful author writes — reports itself as a violation.
const stripComments = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/.*$/gm, '');

const DESTRUCTIVE = [
  { name: 'DROP TABLE/INDEX/VIEW/TRIGGER', re: /\bdrop\s+(table|index|view|trigger)\b/i },
  { name: 'DELETE FROM', re: /\bdelete\s+from\b/i },
  { name: 'TRUNCATE', re: /\btruncate\b/i },
  { name: 'drizzle .delete(', re: /\.delete\s*\(/ },
];

const UPSERT = [
  /onConflictDo(Update|Nothing)\s*\(/,
  /\bon\s+conflict\b/i,
  /\binsert\s+or\s+(replace|ignore)\b/i,
];

const sources = seedSources();
console.log(`static: ${sources.length} seed source(s)`);
let upsertSeen = false;
for (const file of sources) {
  const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
  lines.forEach((line, index) => {
    for (const { name, re } of DESTRUCTIVE) {
      if (re.test(line)) {
        violations.push(
          `destructive construct ${name} at ${rel(file)}:${index + 1} — ${line.trim()}`,
        );
      }
    }
    if (UPSERT.some((re) => re.test(line))) upsertSeen = true;
  });
  console.log(`  ${rel(file)}`);
}
if (sources.length === 0) {
  warnings.push('no seed sources found — scripts/seed.ts is missing');
} else if (!upsertSeen) {
  warnings.push(
    'no upsert construct (onConflictDoUpdate / ON CONFLICT / INSERT OR REPLACE) in the seed — ' +
      'P1.7.2 requires upsert by natural key; only the dynamic half can prove it',
  );
}
console.log(
  `static: ${violations.length} destructive construct(s), upsert evidence: ${upsertSeen ? 'yes' : 'no'}`,
);

/* ==== dynamic half ================================================================== */
let verdict = violations.length > 0 ? VIOLATION : PASS;
let workDir;

const finish = () => {
  if (workDir && !args.keep) rmSync(workDir, { recursive: true, force: true });
  else if (workDir) console.log(`\nwork dir kept: ${workDir}`);

  console.log('');
  for (const warning of warnings) console.log(`warning: ${warning}`);
  if (violations.length > 0) {
    console.error(`db-check-seed FAILED — ${violations.length} violation(s) of P1.7.2:`);
    for (const violation of violations) console.error(`  - ${violation}`);
    console.error('  see docs/architecture.html §7.4 and docs/implementation.html P1.7.2.');
  } else if (verdict === INCONCLUSIVE) {
    console.log('db-check-seed INCONCLUSIVE — idempotence was not verified. This is not a pass.');
  } else {
    console.log('db-check-seed OK — the seed is non-destructive and running it twice is a no-op.');
  }
  process.exit(verdict);
};

const inconclusive = (...lines) => {
  for (const line of lines) console.log(`  ${line}`);
  if (verdict !== VIOLATION) verdict = INCONCLUSIVE;
  finish();
};

if (args['static-only']) {
  console.log('\ndynamic: skipped (--static-only)');
  if (verdict !== VIOLATION) verdict = INCONCLUSIVE;
  finish();
}

console.log(`\ndynamic: target ${rel(target)}`);
if (!existsSync(target)) {
  inconclusive(
    `no database at ${rel(target)}.`,
    'run `npm run db:migrate` first, or pass --db <path> to a migrated database.',
  );
}

// Everything the seed must not touch. The sidecars are in the list because a write that
// lands only in the -wal is still a write to the real database.
const sourceGuarded = target === dbPath(repoRoot) ? dbFilePaths(repoRoot) : [target];
const sourceBefore = filesDigest(sourceGuarded);

workDir = args['work-dir']
  ? path.resolve(args['work-dir'])
  : mkdtempSync(path.join(os.tmpdir(), 'lifestream-seedcheck-'));
mkdirSync(workDir, { recursive: true });
const copy = path.join(workDir, 'check.db');
if (path.resolve(copy) === target) {
  console.error('db-check-seed: --work-dir would make the snapshot overwrite --db.');
  process.exit(VIOLATION);
}
await snapshot(target, copy);
console.log(`  snapshot -> ${copy}`);

const copyFiles = () =>
  readdirSync(workDir)
    .filter((name) => name.startsWith('check.db'))
    .sort()
    .map((name) => path.join(workDir, name));

function runSeed(label) {
  const started = Date.now();
  const result = spawnSync(seedCmd, {
    shell: true,
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, [dbEnv]: copy },
  });
  const ms = Date.now() - started;
  console.log(`  ${label}: ${seedCmd}  (${dbEnv}=${path.basename(copy)}, ${ms} ms)`);
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd();
  for (const line of output ? output.split('\n') : []) console.log(`    | ${line}`);

  // Checked after EVERY run, not once at the end: the sooner an ignored redirect is named,
  // the less of the real database has been rewritten by a seed nobody meant to run.
  if (filesDigest(sourceGuarded) !== sourceBefore) {
    violations.push(
      `the seed wrote to ${rel(target)} despite ${dbEnv} pointing at the snapshot — ` +
        'it does not honour the redirect, so its idempotence cannot be checked safely',
    );
    verdict = VIOLATION;
    finish();
  }

  if (result.status !== 0) {
    inconclusive(
      `${label} exited ${result.status ?? `on signal ${result.signal}`}.`,
      'the seed has to run before running it twice can prove anything.',
    );
  }
  return result;
}

// Drizzle's own bookkeeping table is not seed output, so it does not count towards "was this
// database already seeded" — a freshly migrated database holds exactly one row, and reading
// that as "seeded" would disable the one case where the silence check is diagnostic.
const userRows = (fp) =>
  fp.tables.reduce((sum, t) => sum + (t.name === '__drizzle_migrations' ? 0 : t.rows), 0);

const before = fingerprint(copy);
const seededBefore = userRows(before) > 0;
const bytesBefore = filesDigest(copyFiles());
console.log(
  `  before: ${before.rows} row(s) across ${before.tables.length} table(s)` +
    ` — ${seededBefore ? 'already seeded' : 'unseeded'}`,
);

runSeed('run 1');
const afterOne = fingerprint(copy);
const bytesAfterOne = filesDigest(copyFiles());
console.log(`  after run 1: ${afterOne.rows} row(s)`);

// A seed that wrote NOWHERE looks, at the byte level, exactly like a correctly idempotent
// seed re-run on an already-seeded database. Measured, not assumed: an UPSERT whose DO UPDATE
// assigns the values already stored leaves the file byte-identical — SQLite commits no page
// and the header's change counter never moves. So "no bytes changed" is the EXPECTED result
// of the very case P1.7.2 cares most about, and treating it as suspicious would fail the
// check on its own success.
//
// It is only diagnostic on an EMPTY database, where an honest seed has work it must do. There,
// silence means the seed wrote somewhere we are not looking, and nothing has been proven.
if (bytesAfterOne === bytesBefore && afterOne.hash === before.hash) {
  if (!seededBefore) {
    inconclusive(
      'the seed wrote nothing to an empty redirected database.',
      `either it does not read ${dbEnv}, or it is a no-op — either way nothing was proven.`,
      'point --db at a freshly migrated database and use a seed that populates it.',
    );
  }
  warnings.push(
    'the seed changed no bytes — the expected result of an idempotent seed on an ' +
      `already-seeded target (${rel(target)} is separately verified unchanged), but also what ` +
      'an unhonoured redirect would look like. For a decisive answer, point --db at a freshly ' +
      'migrated, unseeded database.',
  );
}

runSeed('run 2');
const afterTwo = fingerprint(copy);
console.log(`  after run 2: ${afterTwo.rows} row(s)`);

if (before.hash === afterOne.hash) {
  console.log('  note: the target was already seeded — the first run was itself a no-op.');
} else {
  console.log(`  first run wrote ${afterOne.rows - before.rows} net row(s)`);
}

if (afterOne.hash !== afterTwo.hash) {
  const changed = diff(afterOne, afterTwo);
  violations.push(
    `the second seed run changed the database — not idempotent. ${changed.length} table(s) differ:`,
  );
  for (const row of changed) {
    violations.push(
      `    ${row.name}: ${row.before ?? 'absent'} -> ${row.after ?? 'absent'} row(s)`,
    );
  }
  verdict = VIOLATION;
} else {
  console.log('  run 2 changed nothing — idempotent.');
}

// Recorded for the report: the freshness gate reads the same mtime, so a checker that
// quietly touched the real database would poison it.
if (existsSync(target)) {
  console.log(
    `  ${rel(target)} unchanged (${statSync(target).size} bytes, ${fileDigest(target).slice(0, 12)})`,
  );
}

finish();
