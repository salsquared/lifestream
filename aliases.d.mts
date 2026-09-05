// Type declarations for `aliases.mjs`, the shared cross-workspace alias table.
//
// The module is plain ESM JavaScript on purpose: `vite.config.ts`, `vitest.config.ts`
// and `tests/smoke.test.ts` all import it, and two of those are loaded by tools that
// would otherwise need it pre-compiled. This file lets every TypeScript consumer type
// it without `allowJs`, which would otherwise have to be switched on in three separate
// workspace tsconfigs to admit one JS file.

/** One alias: an import prefix and the repo-root-relative directory it maps to. */
export interface AliasEntry {
  readonly prefix: string;
  readonly target: string;
}

/** The alias table. Mirrored by hand into `tsconfig.base.json`'s `paths`; the smoke spec guards the mirror. */
export declare const aliasTable: ReadonlyArray<AliasEntry>;

/** Absolute path to a repo-root-relative `p`, anchored on this module's directory. */
export declare function fromRepoRoot(p: string): string;

/** The table in the `{ find, replacement }` shape Vite and Vitest both accept. */
export declare function resolveAliases(): Array<{ find: RegExp; replacement: string }>;
