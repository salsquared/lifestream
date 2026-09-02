/**
 * Entry point for the shared workspace — the types and small pure utilities that both
 * `client/` and `server/` import. Consumers reach it through the `@shared/*` path alias
 * declared in `tsconfig.base.json` (and mirrored in `vitest.config.ts`).
 *
 * Deliberately near-empty at P0: this is the floor the alias wiring is proved against.
 * The real modules — `types/`, `rollDate.ts`, `geo/deriveFeatures.ts` — land in P1.
 *
 * Nothing here may import from `node:*` or from the DOM; the workspace is isomorphic by
 * construction, which `shared/tsconfig.json` enforces with `"types": []`.
 */

/** npm name of this workspace, kept in step with `shared/package.json`. */
export const SHARED_PACKAGE_NAME = '@lifestream/shared';
