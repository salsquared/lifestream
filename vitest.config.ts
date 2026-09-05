import { defineConfig } from 'vitest/config';

import { resolveAliases } from './aliases.mjs';

/**
 * Cross-workspace import aliases.
 *
 * The table itself lives in `aliases.mjs` — the single source of truth shared with
 * `client/vite.config.ts`, because neither Vite nor Vitest reads
 * `compilerOptions.paths` from `tsconfig.base.json`. The tsconfig mirrors the table by
 * hand (it is the third consumer, and `tsc` cannot import a JS module for its config),
 * so `tests/smoke.test.ts` asserts all three resolve every alias to the same directory.
 *
 * Exported so the spec checks the very array Vitest resolves with.
 */
export const workspaceAliases = resolveAliases();

export default defineConfig({
  resolve: { alias: workspaceAliases },
  test: {
    // Specs live at the repo root, per the plan. Workspace-local test files (a Vite
    // template's example spec, say) are deliberately out of scope.
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
