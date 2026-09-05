/**
 * The two World Map reads (P1.12.1, P1.12.2).
 *
 * URLs are the ones architecture §5.1 specifies, written out in full — they come from the
 * spec, not from the server's route filenames (§4.4), and spelling them here means a
 * drifted prefix is one grep away from being found.
 *
 * The entity types are imported from `@shared/types/index` and never redeclared: the same
 * types the Drizzle schema is conformed against in `server/src/db/conformance.ts`, so the
 * shape below is checked against the columns rather than merely believed. camelCase end to
 * end — the snake_case columns stop at the schema file (the wire-format decision).
 */
import type { Country, Grouping, GroupingCountry } from '@shared/types/index';

import { ApiError, getForSave, type RequestOptions } from './client';

const COUNTRIES_URL = '/api/map/countries';
const GROUPINGS_URL = '/api/map/groupings';

/**
 * `GET /api/map/groupings` — the save's unified nations and their membership rows.
 *
 * `members` is `grouping_country` verbatim, which is what carries `isLeader`; the
 * `groupingOf` index §4.2's `useWorld` holds is one `Object.fromEntries` away from it.
 *
 * A COUNTRY MISSING FROM `members` IS INDEPENDENT, and there is no field saying so. That
 * is a stored-vs-derived distinction, not an omission: independence is the absence of a
 * `grouping_country` row (§2.4), and the server declines to synthesize it (§5.1) because
 * the 74 "independent" groups in the old map export were exactly that synthesis and they
 * are a projection of `country`, not authored content. Derive it against the ids from
 * `fetchMapCountries` when a view needs the list.
 *
 * DUPLICATED, KNOWINGLY: `server/src/routes/map.ts` declares the same envelope as
 * `MapGroupingsResponse`. Only the wrapper is duplicated — every field inside it is a
 * shared type — and the shared home for response envelopes does not exist yet. It should
 * move to `shared/src/types/` when P3.6 adds the endpoints that would make it a pattern.
 */
export type MapGroupings = {
  groupings: Grouping[];
  members: GroupingCountry[];
};

/**
 * `GET /api/map/countries` — every country, named as this save names it.
 *
 * Global rows with the save's `country_override` applied, so it is a per-save read even
 * though `country` itself is global. Geometry is not in the payload: it comes from the
 * vendored topojson through `shared/src/geo/deriveFeatures.ts` (§3.1), and the ids here
 * are the ids that file mints.
 */
export async function fetchMapCountries(
  saveId: string,
  options?: RequestOptions,
): Promise<Country[]> {
  const body = await getForSave(COUNTRIES_URL, saveId, options);
  return arrayField<Country>(body, 'countries', COUNTRIES_URL);
}

/** `GET /api/map/groupings` — see {@link MapGroupings}. */
export async function fetchMapGroupings(
  saveId: string,
  options?: RequestOptions,
): Promise<MapGroupings> {
  const body = await getForSave(GROUPINGS_URL, saveId, options);
  return {
    groupings: arrayField<Grouping>(body, 'groupings', GROUPINGS_URL),
    members: arrayField<GroupingCountry>(body, 'members', GROUPINGS_URL),
  };
}

/**
 * Read one array off a response envelope, or fail naming the field.
 *
 * THE ELEMENT CAST IS REAL AND IS NOT VALIDATION. What is checked is the envelope: that a
 * JSON object arrived and that the field is an array — the shapes that separate "the API
 * answered" from "something else did", and the ones a wrong URL or a stale server actually
 * produce. The element type is asserted, not verified, because both ends of it are pinned
 * to `@shared/types` by `conformance.ts` at compile time, and re-checking 237 country rows
 * per load would buy a guarantee tsc already gives. If a runtime schema check is ever
 * wanted, this is the one function it goes in.
 */
function arrayField<T>(body: unknown, field: string, url: string): T[] {
  const value =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)[field]
      : undefined;

  if (!Array.isArray(value)) {
    throw new ApiError(url, 0, `malformed payload: '${field}' is not an array`);
  }

  return value as T[];
}
