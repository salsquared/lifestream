/**
 * The client's API layer (P1.12.3) — the only place in `client/` that calls `fetch`.
 *
 * Two levels. `./client` is the transport: it appends `?save=` for a per-save read (P1.13),
 * insists on a JSON body, and turns every failure into an `ApiError`. `./map` and its
 * successors are the endpoints: one function per URL in architecture §5.1/§5.2, each
 * returning the shared entity types from `@shared/types` with no renaming anywhere —
 * camelCase from the column definition to the component prop (the wire-format decision).
 *
 * Import from here, not from the modules underneath: what an endpoint's URL is, and how
 * the save gets onto it, are this directory's business.
 */

export { ApiError, getForSave, getGlobal } from './client';
export type { RequestOptions } from './client';

export { fetchMapCountries, fetchMapGroupings } from './map';
export type { MapGroupings } from './map';
