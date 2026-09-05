/**
 * The shared entity types — one place both `client/` and `server/` import from, so the
 * wire format is declared once (P1.6.2).
 *
 * ── PROPERTY NAMES ARE camelCase. ALWAYS. ────────────────────────────────────────────
 * `isoNumeric`, `geometrySource`, `whenMin`, `saveId` — never `iso_numeric`. snake_case
 * exists in exactly one place in this repo: the column-name arguments inside
 * `server/src/db/schema.ts` (`isoNumeric: text('iso_numeric')`). Everything above that
 * boundary — JSON response bodies, these types, the client stores and props — is
 * camelCase (implementation.html, the wire-format decision).
 *
 * Three things depend on it and would each need a rename layer otherwise: Drizzle's
 * inferred row types are already camelCase, so no mapper exists between the schema and
 * these types (`server/src/db/conformance.ts` proves the two agree); the read APIs
 * return these shapes verbatim; and `client/src/shell/stores/types.ts` is camelCase and
 * is meant to become a thin re-export of this module with NO renames.
 *
 * Architecture §2.5 writes the columns in snake_case because it is describing SQL. That
 * is the same schema, not a second naming convention.
 *
 * Reachable as `@shared/types/index`; also re-exported from `@shared/index`.
 */

export * from './enums.js';
export * from './json.js';
export * from './entities.js';
