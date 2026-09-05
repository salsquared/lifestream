// `node scripts/db-check-migrations.mjs` — the executable form of P1.7.1: every post-seed
// schema change ships a drizzle migration PLUS a backfill script. A migration with no
// backfill is not a complete change (architecture.html §7.4).
//
// The rule cannot be checked by reading SQL — whether a column needs a backfill is a
// judgement about the data, not about the DDL. So the check makes the judgement VISIBLE
// instead of guessing at it: every migration past the baseline must be accompanied by one
// of two files under `scripts/backfills/`, and the author has to choose which.
//
//   scripts/backfills/<tag>.ts           the backfill. Any of .ts .mts .mjs .js .sql.
//   scripts/backfills/<tag>.data-free.md the written waiver. §7.4 allows a migration with
//                                        no backfill "when the change is provably data-free,
//                                        and the commit says so" — this file is where it
//                                        says so, and it must actually say something.
//
// Exactly one of the two, never both, never neither. The baseline migration (index 0) is
// exempt by construction: it created the schema, so there were no rows to move.
//
// Exit 0 = compliant, 1 = violation.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { assertLifestreamRepo, parseArgs, rel, repoRoot } from './lib/repo.mjs';

const MIGRATIONS_DIR = path.join(repoRoot, 'server', 'src', 'db', 'migrations');
const JOURNAL = path.join(MIGRATIONS_DIR, 'meta', '_journal.json');
const BACKFILL_DIR = path.join(repoRoot, 'scripts', 'backfills');
const BACKFILL_EXTS = ['.ts', '.mts', '.mjs', '.js', '.sql'];
const WAIVER_SUFFIX = '.data-free.md';

// A waiver is prose, not a checkbox. Below this it is not an argument, it is a shrug.
const MIN_WAIVER_CHARS = 40;

const USAGE = [
  'usage: node scripts/db-check-migrations.mjs [--quiet]',
  '',
  '  --quiet  print only violations.',
];

let args;
try {
  args = parseArgs(process.argv.slice(2), { flags: ['--quiet', '--help'] });
} catch (error) {
  console.error(`db-check-migrations: ${error.message}`);
  console.error(USAGE.join('\n'));
  process.exit(1);
}
if (args.help) {
  console.log(USAGE.join('\n'));
  process.exit(0);
}

assertLifestreamRepo('db-check-migrations', 'nothing was read or written.');

const violations = [];
const note = (line) => {
  if (!args.quiet) console.log(line);
};

/* ---- the journal is the list of migrations; the directory must agree with it -------- */
if (!existsSync(JOURNAL)) {
  console.error(`db-check-migrations: no journal at ${rel(JOURNAL)}.`);
  console.error('  run `npm run db:generate` — with no journal there is no migration history.');
  process.exit(1);
}

const journal = JSON.parse(readFileSync(JOURNAL, 'utf8'));
const entries = [...(journal.entries ?? [])].sort((a, b) => a.idx - b.idx);
const sqlFiles = existsSync(MIGRATIONS_DIR)
  ? readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.sql'))
      .sort()
  : [];

// A migration whose journal entry and whose file disagree is the failure mode that makes
// `db:migrate` skip a change silently, so it is checked before anything about backfills.
const tagged = new Set(entries.map((entry) => `${entry.tag}.sql`));
for (const entry of entries) {
  if (!sqlFiles.includes(`${entry.tag}.sql`)) {
    violations.push(`journal entry ${entry.idx} (${entry.tag}) has no ${entry.tag}.sql`);
  }
}
for (const file of sqlFiles) {
  if (!tagged.has(file)) {
    violations.push(
      `${rel(path.join(MIGRATIONS_DIR, file))} is not in the journal — db:migrate will never run it`,
    );
  }
}

/* ---- one backfill (or one written waiver) per migration past the baseline ----------- */
const backfills = existsSync(BACKFILL_DIR)
  ? readdirSync(BACKFILL_DIR).filter((n) => n !== '.gitkeep')
  : [];
const claimed = new Set();

const rows = entries.map((entry, index) => {
  const { tag } = entry;
  if (index === 0) return { tag, state: 'baseline', detail: 'schema creation — no rows existed' };

  const code = BACKFILL_EXTS.map((ext) => `${tag}${ext}`).find((name) => backfills.includes(name));
  const waiverName = `${tag}${WAIVER_SUFFIX}`;
  const waiver = backfills.includes(waiverName) ? waiverName : undefined;

  if (code) claimed.add(code);
  if (waiver) claimed.add(waiver);

  if (code && waiver) {
    violations.push(
      `${tag}: has BOTH a backfill (${code}) and a data-free waiver (${waiver}) — pick one`,
    );
    return { tag, state: 'AMBIGUOUS', detail: `${code} + ${waiver}` };
  }

  if (!code && !waiver) {
    violations.push(
      `${tag}: no backfill. Add ${rel(path.join(BACKFILL_DIR, `${tag}.ts`))}, or ` +
        `${rel(path.join(BACKFILL_DIR, waiverName))} saying why the change is data-free`,
    );
    return { tag, state: 'MISSING', detail: 'neither a backfill nor a waiver' };
  }

  const file = path.join(BACKFILL_DIR, code ?? waiver);
  const body = readFileSync(file, 'utf8').replace(/\s+/g, ' ').trim();
  if (body.length < MIN_WAIVER_CHARS) {
    violations.push(
      `${tag}: ${rel(file)} is ${body.length} chars — under ${MIN_WAIVER_CHARS}, it says nothing`,
    );
    return { tag, state: 'EMPTY', detail: rel(file) };
  }

  return { tag, state: code ? 'backfill' : 'data-free', detail: code ?? waiver };
});

// A backfill whose migration was renamed or deleted is dead weight that reads as coverage.
for (const file of backfills) {
  if (!claimed.has(file)) {
    violations.push(`${rel(path.join(BACKFILL_DIR, file))} matches no migration in the journal`);
  }
}

/* ---- report ------------------------------------------------------------------------ */
note(`migrations in ${rel(MIGRATIONS_DIR)}: ${entries.length}`);
const width = Math.max(0, ...rows.map((row) => row.tag.length));
for (const row of rows) {
  note(`  ${row.tag.padEnd(width)}  ${row.state.padEnd(9)}  ${row.detail}`);
}

if (violations.length > 0) {
  console.error('');
  console.error(`db-check-migrations FAILED — ${violations.length} violation(s) of P1.7.1:`);
  for (const violation of violations) console.error(`  - ${violation}`);
  console.error('');
  console.error('  every post-seed schema change ships a migration PLUS a backfill script.');
  console.error('  see docs/architecture.html §7.4 and docs/implementation.html P1.7.1.');
  process.exit(1);
}

note('');
note('db-check-migrations OK — every post-seed migration has a backfill or a written waiver.');
