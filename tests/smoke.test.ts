import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { SHARED_PACKAGE_NAME } from '@shared/index';
import sharedPackageJson from '../shared/package.json';
import baseTsconfig from '../tsconfig.base.json';
import { workspaceAliases } from '../vitest.config';

/**
 * P0.2.3 — the smoke spec that keeps `npm test` green from day one.
 *
 * It earns its place by proving the one thing P0.2.2 actually builds: that a spec in
 * `tests/` reaches `shared/` and `server/` through the same aliases the tsconfig
 * declares. Vitest resolves `resolve.alias`; `tsc` resolves `compilerOptions.paths`.
 * Nothing links the two, so they drift silently — and the four real tests that land
 * later (country import, `resolve()`, fork remap, `rollDate`) all import across
 * workspaces and would be the ones to discover it.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** Stand-in module name substituted for the `*` in a path pattern. */
const PROBE = 'probe-module';

/** Resolve `id` the way Vitest will, using the config's own alias table. */
function resolveThroughAliases(id: string): string | undefined {
  for (const { find, replacement } of workspaceAliases) {
    if (find.test(id)) return id.replace(find, replacement);
  }
  return undefined;
}

const tsconfigPaths = Object.entries(baseTsconfig.compilerOptions.paths);

describe('@shared/* alias', () => {
  it('resolves to the shared workspace source at runtime', () => {
    // The import above is the behaviour under test; comparing against the workspace's
    // own package.json proves it landed on the real module rather than anything that
    // merely happens to export the symbol.
    expect(SHARED_PACKAGE_NAME).toBe(sharedPackageJson.name);
  });
});

describe('vitest aliases match tsconfig paths', () => {
  it.each(tsconfigPaths)('resolves %s to the same place tsc does', (pattern, targets) => {
    const [target] = targets;
    if (target === undefined) {
      throw new Error(`tsconfig.base.json declares "${pattern}" with no target path`);
    }

    expect(resolveThroughAliases(pattern.replace('*', PROBE))).toBe(
      resolve(repoRoot, target.replace('*', PROBE)),
    );
  });

  it('declares no alias that tsconfig.base.json does not', () => {
    // Guards the reverse drift: an alias Vitest resolves but `tsc` cannot would make a
    // spec pass while the typecheck fails.
    expect(workspaceAliases).toHaveLength(tsconfigPaths.length);
  });
});
