/**
 * Drizzle table definitions — the single source of truth for the SQLite schema.
 *
 * Intentionally EMPTY at P0. The whole schema is authored in one go in P1 and emitted
 * as a single migration (P1.6), because there is no migration story before P1.7 and the
 * seed, the map view and eighty hand-authored events pile on immediately afterwards.
 * Adding a table here now would fragment that migration.
 *
 * Column-level reference: architecture.html §2.5 (core, saves, registry) and §3 (the
 * six deferred simulation tables). `drizzle.config.ts` at the repo root points here.
 */
export {};
