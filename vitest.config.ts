import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Absolute path to `p`, resolved against the repo root (this file's directory). */
const fromRepoRoot = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Cross-workspace import aliases.
 *
 * Vitest does not read `compilerOptions.paths` from `tsconfig.base.json`, so every
 * alias declared there has to be mirrored here by hand. `tests/smoke.test.ts` asserts
 * the two lists stay in step — add a path to the tsconfig and the suite fails until
 * the matching entry lands below.
 *
 * Exported so the spec checks the very array Vitest resolves with.
 */
export const workspaceAliases = [
  { find: /^@shared\//, replacement: fromRepoRoot('./shared/src/') },
  { find: /^@server\//, replacement: fromRepoRoot('./server/src/') },
];

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
