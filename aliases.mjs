// Single source of truth for the cross-workspace import aliases.
//
// Three consumers, three resolvers, ONE table:
//   - tsconfig.base.json `paths`   (tsc)          — mirrored by hand, guarded by tests/smoke.test.ts
//   - vitest.config.ts   `resolve.alias` (Vitest) — imports this file
//   - client/vite.config.ts `resolve.alias` (Vite) — imports this file
//
// Vite and Vitest do not read tsconfig `paths`, so without this module each config
// carries its own copy and they drift silently. `tests/smoke.test.ts` asserts that
// every consumer resolves each alias to the same absolute directory.
//
// `target` is repo-root-relative. Each consumer resolves it from its own location
// via `resolveAliases(fromRepoRoot)`.
import { fileURLToPath } from 'node:url';

/** @type {ReadonlyArray<{ prefix: string; target: string }>} */
export const aliasTable = Object.freeze([
  { prefix: '@shared/', target: 'shared/src/' },
  { prefix: '@server/', target: 'server/src/' },
]);

/** Absolute path to a repo-root-relative `p`, anchored on THIS file's directory. */
export const fromRepoRoot = (p) => fileURLToPath(new URL(p, import.meta.url));

/**
 * The table in the `{ find, replacement }` shape Vite and Vitest both accept.
 * `find` is a regex anchored at the start so `@shared/x` matches but `foo@shared/x` does not.
 */
export const resolveAliases = () =>
  aliasTable.map(({ prefix, target }) => ({
    find: new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    replacement: fromRepoRoot('./' + target),
  }));
