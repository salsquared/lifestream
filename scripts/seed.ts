/**
 * `npm run db:seed` — the world seed (architecture.html §4.1 puts it here at the root,
 * not in a workspace, because it writes shared data through `@server/db` and reads the
 * authored inputs under `data/`).
 *
 * P0 scaffolds the entry point only. P1.7 implements it: countries from the vendored
 * TopoJSON via `deriveFeatures.ts`, then the authored registry and timeline rows.
 */
console.error('db:seed is not implemented yet — P1.7 implements it.');
console.error('  see docs/implementation.html, task P1.7');
process.exit(1);
