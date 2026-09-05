// Anchoring + identity guard shared by every `db:*` maintenance script.
//
// Both halves exist because of a bug that was real. The targets in `db-reset` used to be
// bare relative paths, so running it from anywhere else deleted THAT directory's
// `data/*.db`; anchoring on `import.meta.url` fixes the wrong-cwd case but not the wrong
// *copy* case — a script vendored into another tree would happily delete that tree's
// database. So the anchor and the identity check ship together, and every script that
// can touch `data/` calls `assertLifestreamRepo()` before it touches anything.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repo root, resolved from THIS file and never from `process.cwd()`. */
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A repo-root-relative display path, for output that should not leak the machine's layout. */
export const rel = (p) => path.relative(repoRoot, p) || '.';

/** The root `package.json`, parsed — or `undefined` when it is missing or unparseable. */
export function readManifest() {
  try {
    return JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Refuse to run unless the anchored root really is this repository.
 *
 * @param {string} scriptName  prefixes the refusal, e.g. `db-reset`.
 * @param {string} consequence the reassurance line, e.g. `nothing was deleted.`
 */
export function assertLifestreamRepo(scriptName, consequence) {
  const manifestPath = path.join(repoRoot, 'package.json');
  const name = readManifest()?.name;
  if (name === 'lifestream') return;

  console.error(`${scriptName} refused: ${repoRoot} is not the lifestream repo.`);
  console.error(
    name === undefined
      ? `  expected ${manifestPath} to be readable JSON naming this repo; it is not.`
      : `  expected "name": "lifestream" in ${manifestPath}; found "${name}".`,
  );
  console.error(`  ${consequence}`);
  process.exit(1);
}

/**
 * Minimal flag parser: `--flag` and `--key value` / `--key=value`, nothing else.
 * An unknown flag is a hard error — a typo'd `--force` must never read as "not forced".
 *
 * @param {string[]} argv
 * @param {{ flags?: string[]; options?: string[] }} spec
 */
export function parseArgs(argv, spec) {
  const flags = new Set(spec.flags ?? []);
  const options = new Set(spec.options ?? []);
  /** @type {Record<string, string | boolean>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg : arg.slice(0, eq);
    if (flags.has(key) && eq === -1) {
      out[key.replace(/^--/, '')] = true;
    } else if (options.has(key)) {
      const value = eq === -1 ? argv[(i += 1)] : arg.slice(eq + 1);
      if (value === undefined) throw new Error(`${key} needs a value`);
      out[key.replace(/^--/, '')] = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}
