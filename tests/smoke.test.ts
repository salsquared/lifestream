import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { SHARED_PACKAGE_NAME } from '@shared/index';
import { aliasTable, resolveAliases } from '../aliases.mjs';
import clientViteConfigExport from '../client/vite.config';
import sharedPackageJson from '../shared/package.json';
import baseTsconfig from '../tsconfig.base.json';
import { workspaceAliases } from '../vitest.config';

/**
 * P0.2.3 — the smoke spec that keeps `npm test` green from day one.
 *
 * It earns its place by proving the one thing P0.2.2 actually builds: that a spec in
 * `tests/` reaches `shared/` and `server/` through the same aliases every other
 * consumer uses. There are THREE of them and they share no machinery:
 *
 *   1. `tsconfig.base.json` `compilerOptions.paths`  — what `tsc` resolves with
 *   2. `vitest.config.ts` `resolve.alias`            — what this spec resolves with
 *   3. `client/vite.config.ts` `resolve.alias`       — what the browser resolves with
 *
 * (2) and (3) both import the table from `aliases.mjs`; (1) mirrors it by hand, because
 * `tsc` cannot import a JS module for its config. Neither Vite nor Vitest reads
 * `paths`, so nothing but this spec links the three — and an alias present in some but
 * not all of them fails somewhere no typecheck and no unit test looks. An earlier
 * version of this file compared only (1) and (2), which is exactly why the client had
 * no `@shared/*` alias at all: the first `@shared` import in client code would have
 * broken `vite dev` and `vite build` with the suite still green.
 *
 * The four real tests that land later (`countryImport`, `resolveTimeline`, `forkSave`,
 * `rollDate`) all import across workspaces, so they are the ones that would otherwise
 * discover the drift — one of them from the browser build, long after the fact.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** Stand-in module name substituted for the `*` in a path pattern. */
const PROBE = 'probe-module';

/** The `resolve.alias` shape Vite and Vitest share. */
type AliasEntry = { find: string | RegExp; replacement: string };

/** Minimal view of a Vite config — enough to reach `resolve.alias` without importing vite's types. */
type ViteConfigLike = { resolve?: { alias?: unknown } };
type ViteConfigFn = (env: {
  command: 'serve' | 'build';
  mode: string;
}) => ViteConfigLike | Promise<ViteConfigLike>;

/**
 * Normalise a `resolve.alias` value to entries. Vite accepts either an array of
 * `{ find, replacement }` or a plain object map; both are compared the same way.
 */
function aliasEntries(alias: unknown, source: string): AliasEntry[] {
  if (Array.isArray(alias)) return alias as AliasEntry[];
  if (alias !== null && typeof alias === 'object') {
    return Object.entries(alias as Record<string, string>).map(([find, replacement]) => ({
      find,
      replacement,
    }));
  }
  throw new Error(`${source} declares no resolve.alias — cross-workspace imports cannot resolve`);
}

/** Resolve `id` the way Vite/Vitest will, using a config's own alias table. */
function resolveThroughAliases(entries: readonly AliasEntry[], id: string): string | undefined {
  for (const { find, replacement } of entries) {
    if (typeof find === 'string') {
      if (id.startsWith(find)) return replacement + id.slice(find.length);
    } else if (find.test(id)) {
      return id.replace(find, replacement);
    }
  }
  return undefined;
}

/** Absolute directory an alias pattern points at, with `*`/the prefix tail stripped back off. */
function resolvedTarget(entries: readonly AliasEntry[], prefix: string): string | undefined {
  const hit = resolveThroughAliases(entries, prefix + PROBE);
  return hit === undefined ? undefined : resolve(hit);
}

// `defineConfig` may hand back a config object or a factory; the client currently
// exports an object, but normalising here keeps the spec honest either way.
const clientViteConfig: ViteConfigLike = await (typeof clientViteConfigExport === 'function'
  ? (clientViteConfigExport as unknown as ViteConfigFn)({ command: 'serve', mode: 'development' })
  : (clientViteConfigExport as unknown as ViteConfigLike));

const clientAliases = aliasEntries(clientViteConfig.resolve?.alias, 'client/vite.config.ts');
const vitestAliases: readonly AliasEntry[] = workspaceAliases;
const tsconfigPaths = Object.entries(baseTsconfig.compilerOptions.paths);

describe('@shared/* alias', () => {
  it('resolves to the shared workspace source at runtime', () => {
    // The import above is the behaviour under test; comparing against the workspace's
    // own package.json proves it landed on the real module rather than anything that
    // merely happens to export the symbol.
    expect(SHARED_PACKAGE_NAME).toBe(sharedPackageJson.name);
  });
});

describe('every alias consumer resolves to the same directory', () => {
  // One case per entry in the shared table; each asserts all three consumers agree.
  it.each(aliasTable.map(({ prefix, target }) => ({ prefix, target })))(
    '$prefix resolves identically for tsc, Vitest and Vite',
    ({ prefix, target }) => {
      const expected = resolve(repoRoot, target, PROBE);

      // 1. tsc — `paths` is mirrored by hand, so this is the entry that goes stale.
      const pattern = `${prefix}*`;
      const tsTargets = baseTsconfig.compilerOptions.paths[
        pattern as keyof typeof baseTsconfig.compilerOptions.paths
      ] as string[] | undefined;
      expect(tsTargets?.[0], `tsconfig.base.json declares no "${pattern}" in paths`).toBeDefined();
      expect(resolve(repoRoot, tsTargets![0]!.replace('*', PROBE))).toBe(expected);

      // 2. Vitest — what this very spec resolves imports with.
      expect(
        resolvedTarget(vitestAliases, prefix),
        `vitest.config.ts does not resolve ${prefix}`,
      ).toBe(expected);

      // 3. Vite — what the browser build resolves with. Missing here means the dev
      // server and `vite build` fail on the first client-side `${prefix}` import.
      expect(
        resolvedTarget(clientAliases, prefix),
        `client/vite.config.ts does not resolve ${prefix}`,
      ).toBe(expected);
    },
  );

  it('declares no alias in one consumer that the others lack', () => {
    // Guards the reverse drift: an alias a bundler resolves but `tsc` cannot would make
    // a spec pass while the typecheck fails, and vice versa.
    expect(
      tsconfigPaths.map(([pattern]) => pattern).sort(),
      'tsconfig.base.json paths and aliases.mjs disagree',
    ).toEqual(aliasTable.map(({ prefix }) => `${prefix}*`).sort());

    expect(vitestAliases, 'vitest.config.ts must use the table verbatim').toEqual(resolveAliases());

    // The client may add its own client-local aliases (`@/` and friends); what it may
    // not do is drop or shadow one of the shared ones, which the per-alias cases above
    // check by resolution rather than by identity.
    expect(clientAliases.length).toBeGreaterThanOrEqual(aliasTable.length);
  });
});
