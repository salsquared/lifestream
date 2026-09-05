/**
 * The World Map endpoints — the two reads (P1.12.1, P1.12.2) and the write surface (P2.6).
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
import type { Country, CountryOverride, Grouping, GroupingCountry } from '@shared/types/index';

import { ApiError, getForSave, sendForSave, type RequestOptions } from './client';

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

/* ------------------------------------------------------------------------------------ *
 * The write half (P2.6). Architecture §5.1 lists these URLs; the container calls them.
 * ------------------------------------------------------------------------------------ */

/**
 * The write URLs live OUTSIDE the `/api/map` prefix, and that is the specification, not
 * an oversight (§5.1, §4.4): `/api/groupings` and `/api/country-overrides` are top-level,
 * while the two reads above are `/api/map/*`. One route module (`server/src/routes/map.ts`)
 * owns all three prefixes. Spelling them out here keeps a drifted prefix one grep away.
 */
const GROUPINGS_WRITE_URL = '/api/groupings';
const COUNTRY_OVERRIDES_URL = '/api/country-overrides';

/**
 * A path segment built from an id.
 *
 * Country ids are not opaque enough to skip this: a synthetic one looks like `x:GUF`
 * (§3.1), and while `:` is legal in a path segment, the ids are data and the next
 * convention need not be. Hono decodes `req.param()`, so the server sees `x:GUF` either
 * way.
 */
const segment = (id: string): string => encodeURIComponent(id);

/** What `POST /api/groupings` and `PATCH /api/groupings/:id` accept. */
export type GroupingDraft = { name: string; color: string };
export type GroupingPatch = { name?: string; color?: string };

/**
 * The 409 from `PUT /api/groupings/:id/countries/:countryId` — the country is already
 * owned by another grouping in this save, and the response names the owner (§5.1).
 *
 * IT IS A DISTINCT ERROR TYPE BECAUSE IT IS NOT A FAILURE. `grouping_country`'s PK is
 * `(save_id, country_id)`, so "already claimed" is the schema working, and the answer is
 * a question for the author — "Move from ⟨X⟩?" (P2.3.3) — not an error to surface. A
 * caller that cannot ask retries with `{ move: true }` or gives up; either way it has to
 * be able to tell this apart from a 500, and `ownedBy.name` is what the prompt says.
 */
export class GroupingConflictError extends Error {
  readonly countryId: string;
  readonly ownedBy: { id: string; name: string };

  constructor(countryId: string, ownedBy: { id: string; name: string }, message: string) {
    super(message);
    this.name = 'GroupingConflictError';
    this.countryId = countryId;
    this.ownedBy = ownedBy;
  }
}

/**
 * The 409 from `PUT /api/groupings/:id/countries` — the bulk analogue, one entry per
 * country another nation already owns.
 *
 * The whole request is refused, not the conflicting part of it: that is what makes the
 * bulk endpoint worth having (§5.1), so the state on screen after this error is the state
 * before it, on the server as well as here.
 */
export class MembershipConflictError extends Error {
  readonly conflicts: { countryId: string; ownedBy: { id: string; name: string } }[];

  constructor(
    conflicts: { countryId: string; ownedBy: { id: string; name: string } }[],
    message: string,
  ) {
    super(message);
    this.name = 'MembershipConflictError';
    this.conflicts = conflicts;
  }
}

/** `POST /api/groupings` — create a unified nation. */
export async function createGrouping(
  saveId: string,
  draft: GroupingDraft,
  options?: RequestOptions,
): Promise<Grouping> {
  const body = await sendForSave('POST', GROUPINGS_WRITE_URL, saveId, draft, options);
  return objectField<Grouping>(body, 'grouping', GROUPINGS_WRITE_URL);
}

/** `PATCH /api/groupings/:id` — rename and/or recolor. */
export async function updateGrouping(
  saveId: string,
  groupingId: string,
  patch: GroupingPatch,
  options?: RequestOptions,
): Promise<Grouping> {
  const url = `${GROUPINGS_WRITE_URL}/${segment(groupingId)}`;
  const body = await sendForSave('PATCH', url, saveId, patch, options);
  return objectField<Grouping>(body, 'grouping', url);
}

/**
 * `DELETE /api/groupings/:id` — delete a unified nation.
 *
 * Its `grouping_country` rows go with it, which returns those countries to INDEPENDENT
 * (§5.1). Nothing is written to say so: independence is the absence of a row (§2.4), so
 * the client's own optimistic version of this deletes membership rows rather than
 * inventing an "independent" grouping to move them into.
 */
export async function deleteGrouping(
  saveId: string,
  groupingId: string,
  options?: RequestOptions,
): Promise<void> {
  const url = `${GROUPINGS_WRITE_URL}/${segment(groupingId)}`;
  const body = await sendForSave('DELETE', url, saveId, undefined, options);
  expectOk(body, url);
}

/**
 * `PUT /api/groupings/:id/countries` — replace this grouping's whole membership.
 *
 * ONE CALL, NOT N. The sidebar's "unify these selected countries" is inherently bulk, and
 * N single assigns would leave a half-built nation on screen if the fourth one 409s
 * (§5.1). The handler diffs against `grouping_country` and writes the delta in one
 * transaction.
 */
export async function replaceGroupingCountries(
  saveId: string,
  groupingId: string,
  countryIds: readonly string[],
  move = false,
  options?: RequestOptions,
): Promise<GroupingCountry[]> {
  const url = `${GROUPINGS_WRITE_URL}/${segment(groupingId)}/countries`;

  let body: unknown;
  try {
    body = await sendForSave('PUT', url, saveId, { countryIds: [...countryIds], move }, options);
  } catch (cause) {
    throw asMembershipConflict(cause) ?? cause;
  }

  return arrayField<GroupingCountry>(body, 'members', url);
}

/**
 * `PUT /api/groupings/:id/countries/:countryId` — assign one country to one grouping.
 *
 * PUT and not POST because the row is fully specified by the URL: its PK is
 * `(save_id, country_id)`, so the write is an upsert against a named resource (§5.1).
 *
 * Throws {@link GroupingConflictError} when the country belongs to a DIFFERENT grouping
 * and `move` was not set — see that class for why the caller has to be able to tell it
 * apart. Pass `{ move: true }` to have the server delete the old row and insert the new
 * one in one transaction, which is what the author confirming "Move from ⟨X⟩?" sends.
 */
export async function assignCountryToGrouping(
  saveId: string,
  groupingId: string,
  countryId: string,
  move = false,
  options?: RequestOptions,
): Promise<GroupingCountry> {
  const url = `${GROUPINGS_WRITE_URL}/${segment(groupingId)}/countries/${segment(countryId)}`;

  let body: unknown;
  try {
    body = await sendForSave('PUT', url, saveId, { move }, options);
  } catch (cause) {
    throw asConflict(cause, countryId) ?? cause;
  }

  return objectField<GroupingCountry>(body, 'member', url);
}

/**
 * `DELETE /api/groupings/:id/countries/:countryId` — back to independent.
 *
 * Deletes the row and stores NOTHING. There is no "independent" grouping to move the
 * country into and there must never be one: the 74 synthesized independent groups in the
 * old map export are exactly the artifact §2.4 refuses to store.
 */
export async function removeCountryFromGrouping(
  saveId: string,
  groupingId: string,
  countryId: string,
  options?: RequestOptions,
): Promise<void> {
  const url = `${GROUPINGS_WRITE_URL}/${segment(groupingId)}/countries/${segment(countryId)}`;
  const body = await sendForSave('DELETE', url, saveId, undefined, options);
  expectOk(body, url);
}

/** `PUT /api/country-overrides/:countryId` — this save's name for a country. */
export async function setCountryOverride(
  saveId: string,
  countryId: string,
  name: string,
  options?: RequestOptions,
): Promise<CountryOverride> {
  const url = `${COUNTRY_OVERRIDES_URL}/${segment(countryId)}`;
  const body = await sendForSave('PUT', url, saveId, { name }, options);
  return objectField<CountryOverride>(body, 'override', url);
}

/**
 * `DELETE /api/country-overrides/:countryId` — back to the default name.
 *
 * THE ROW IS REMOVED, NOT REWRITTEN WITH THE DEFAULT. Storing the topojson default as an
 * override would make an authored rename indistinguishable from an unrenamed country, and
 * would freeze today's atlas name into the save (§7.4). The default is whatever
 * `deriveFeatures` says it is at read time, which is why the container needs the derived
 * feature set to offer this at all.
 */
export async function clearCountryOverride(
  saveId: string,
  countryId: string,
  options?: RequestOptions,
): Promise<void> {
  const url = `${COUNTRY_OVERRIDES_URL}/${segment(countryId)}`;
  const body = await sendForSave('DELETE', url, saveId, undefined, options);
  expectOk(body, url);
}

/**
 * Recognise the assign conflict, or `null` for anything else.
 *
 * The status alone is not enough to build the prompt from: a 409 whose body does not name
 * an owner leaves "Move from ⟨X⟩?" with no X, so it stays an `ApiError` and surfaces as
 * one rather than producing a dialog reading "Move from undefined?".
 */
function asConflict(cause: unknown, countryId: string): GroupingConflictError | null {
  if (!(cause instanceof ApiError) || cause.status !== 409) return null;

  const owner = readOwner(cause.body);
  return owner === null ? null : new GroupingConflictError(countryId, owner, cause.message);
}

/** The bulk twin of {@link asConflict}; `null` when the 409 does not carry a conflict list. */
function asMembershipConflict(cause: unknown): MembershipConflictError | null {
  if (!(cause instanceof ApiError) || cause.status !== 409) return null;

  const envelope = cause.body;
  const raw =
    typeof envelope === 'object' && envelope !== null
      ? (envelope as { conflicts?: unknown }).conflicts
      : undefined;
  if (!Array.isArray(raw)) return null;

  const conflicts: MembershipConflictError['conflicts'] = [];
  for (const entry of raw as unknown[]) {
    const owner = readOwner(entry);
    const countryId =
      typeof entry === 'object' && entry !== null
        ? (entry as { countryId?: unknown }).countryId
        : undefined;
    if (owner === null || typeof countryId !== 'string') return null;
    conflicts.push({ countryId, ownedBy: owner });
  }

  return new MembershipConflictError(conflicts, cause.message);
}

/** `{ id, name }` off an `ownedBy` field, or `null` when it is not that shape. */
function readOwner(source: unknown): { id: string; name: string } | null {
  const owner =
    typeof source === 'object' && source !== null
      ? (source as { ownedBy?: unknown }).ownedBy
      : undefined;
  if (typeof owner !== 'object' || owner === null) return null;

  const { id, name } = owner as { id?: unknown; name?: unknown };
  if (typeof id !== 'string' || typeof name !== 'string') return null;
  return { id, name };
}

/** Read one object off a response envelope, or fail naming the field. See `arrayField`. */
function objectField<T>(body: unknown, field: string, url: string): T {
  const value =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)[field]
      : undefined;

  if (typeof value !== 'object' || value === null) {
    throw new ApiError(url, 0, `malformed payload: '${field}' is not an object`);
  }

  return value as T;
}

/**
 * The `{ ok: true }` envelope the two DELETEs answer with.
 *
 * Checked rather than ignored for the same reason the transport insists on JSON: a
 * response that parsed but does not carry the flag is not a delete that happened, and a
 * silently-accepted one would leave the optimistic removal on screen with the row still
 * in the database.
 */
function expectOk(body: unknown, url: string): void {
  const ok = typeof body === 'object' && body !== null ? (body as { ok?: unknown }).ok : undefined;
  if (ok !== true) throw new ApiError(url, 0, "malformed payload: expected '{ ok: true }'");
}
