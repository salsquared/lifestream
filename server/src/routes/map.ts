/**
 * Country and grouping data for the World Map.
 *
 * THREE prefixes per architecture.html §4.4 and §5.1: `/api/map` (the `/countries` and
 * `/groupings` reads), plus top-level `/api/groupings` and `/api/country-overrides` for
 * the writes, which the architecture deliberately places outside the `/api/map`
 * namespace.
 *
 * ONE ROUTER PER PREFIX, each mounted exactly once in `app.ts`. A single shared instance
 * mounted three times does not work: `Hono.route()` COPIES the sub-app's route table under
 * the prefix it is given, so the `/api/map/groupings` read would also be reachable at
 * `/api/groupings/groupings`, and every `/api/groupings/:id` write would answer under
 * `/api/map` and `/api/country-overrides` too.
 *
 * P1.12 fills in the two READS. The write surface stays a placeholder until P2, which
 * builds it alongside the view that calls it — see the note on the write routers below.
 *
 * ── THE WIRE FORMAT IS camelCase ──────────────────────────────────────────────────────
 * SQL columns are snake_case and stay inside `db/schema.ts`; Drizzle's inferred row types
 * are already camelCase, so these handlers return them VERBATIM and convert nothing (the
 * wire-format decision). The one adjustment below is nullability, not naming: a nullable
 * column infers as `T | null` while the wire type writes it as an optional property, and
 * `db/conformance.ts` pins that as the single rule between the two sides. `undefined` is
 * dropped by `JSON.stringify`, so `?? undefined` is what makes the payload omit the key
 * rather than send `null`.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';

import type { Country, Grouping, GroupingCountry } from '@shared/types/index';

import { db } from '../db/index.js';
import { country, countryOverride, grouping, groupingCountry, save } from '../db/schema.js';

/**
 * `GET /api/map/countries` — the global `country` rows with this save's renames applied
 * (§5.1). Geometry is NOT in here: it comes from the vendored topojson (§3.1).
 */
export type MapCountriesResponse = { countries: Country[] };

/**
 * `GET /api/map/groupings` — the save's unified nations plus their `grouping_country`
 * membership rows (§5.1).
 *
 * `members` is the join table verbatim rather than a flattened `countryId -> groupingId`
 * index, for two reasons. It keeps `isLeader` — the one authored fact on the join row
 * (§2.4), which an index would silently drop — and the client's `groupingOf` (§4.2) is one
 * `Object.fromEntries` away from it, while the reverse is not.
 *
 * THERE IS NO `independents` FIELD AND THAT IS THE CONTRACT. A country with no
 * `grouping_country` row is independent; that is derived, never a row (§2.4), and §5.1
 * places the derivation on the client — a country in `/api/map/countries` and in none of
 * these members. Synthesizing independent groupings here would rebuild exactly the
 * artifact the old map app exported and the schema deliberately refuses to store.
 */
export type MapGroupingsResponse = { groupings: Grouping[]; members: GroupingCountry[] };

/** Every read below is per-save, so a request without a usable `?save=` never runs one. */
type SaveScope = { ok: true; saveId: string } | { ok: false; status: 400 | 404; error: string };

/**
 * Resolve `?save=` into a save that actually exists.
 *
 * BOTH FAILURES ARE LOUD ON PURPOSE. A missing parameter is a client bug, and defaulting
 * it to the canon save would hide it; a parameter naming a save that is not there is the
 * `CANON_SAVE_ID` drift P1.11.1 warns about, whose natural symptom is "an empty app, not
 * an error" — every read would legitimately return zero rows. A 404 naming the id is what
 * turns that into a one-line diagnosis.
 */
function resolveSave(raw: string | undefined): SaveScope {
  if (raw === undefined || raw === '') {
    return { ok: false, status: 400, error: "missing required query parameter 'save'" };
  }

  const row = db.select({ id: save.id }).from(save).where(eq(save.id, raw)).get();
  if (row === undefined) {
    return { ok: false, status: 404, error: `no save with id '${raw}'` };
  }

  return { ok: true, saveId: raw };
}

export const mapRoutes = new Hono();

/**
 * P1.12.1 — global country rows with the active save's overrides applied.
 *
 * A LEFT JOIN, not two queries: `country_override` holds a row only for the countries the
 * author actually renamed (P1.11.4 expects near-zero of them), so `coalesce` is what makes
 * "overridden where a row exists, otherwise the topojson default" a single pass. The join
 * predicate carries the save — putting `save_id` in a WHERE clause instead would turn the
 * outer join back into an inner one and drop every country that has no override.
 *
 * Ordered by `id` because it is the primary key and therefore total and stable. Display
 * order is the client's business, and it cannot be decided here anyway: the name a sidebar
 * would sort on is the overridden one, which differs per save.
 */
mapRoutes.get('/countries', (c) => {
  const scope = resolveSave(c.req.query('save'));
  if (!scope.ok) return c.json({ error: scope.error }, scope.status);

  const rows = db
    .select({
      id: country.id,
      isoNumeric: country.isoNumeric,
      alpha3: country.alpha3,
      name: sql<string>`coalesce(${countryOverride.name}, ${country.name})`,
      geometrySource: country.geometrySource,
    })
    .from(country)
    .leftJoin(
      countryOverride,
      and(eq(countryOverride.countryId, country.id), eq(countryOverride.saveId, scope.saveId)),
    )
    .orderBy(asc(country.id))
    .all();

  const countries: Country[] = rows.map((row) => ({
    id: row.id,
    isoNumeric: row.isoNumeric ?? undefined,
    alpha3: row.alpha3 ?? undefined,
    name: row.name,
    geometrySource: row.geometrySource,
  }));

  return c.json({ countries } satisfies MapCountriesResponse);
});

/**
 * P1.12.2 — the save's unified nations and their membership.
 *
 * Two selects rather than one join, deliberately. A join emits the grouping's name and
 * color once per member country — 237 copies across 103 nations for the canon save — and
 * the client would have to de-duplicate them back into the `groupings` record §4.2 wants.
 * Both tables are keyed on `save_id`, so this is two indexed scans of a few hundred rows.
 *
 * Groupings are ordered by `name`: `UNIQUE (save_id, name)` makes it a total order, and it
 * is the only ordering with meaning to a reader — a `grp_<ulid>` sorts arbitrarily.
 */
mapRoutes.get('/groupings', (c) => {
  const scope = resolveSave(c.req.query('save'));
  if (!scope.ok) return c.json({ error: scope.error }, scope.status);

  const groupings = db
    .select()
    .from(grouping)
    .where(eq(grouping.saveId, scope.saveId))
    .orderBy(asc(grouping.name))
    .all();

  const members = db
    .select()
    .from(groupingCountry)
    .where(eq(groupingCountry.saveId, scope.saveId))
    .orderBy(asc(groupingCountry.countryId))
    .all();

  return c.json({ groupings, members } satisfies MapGroupingsResponse);
});

/**
 * `/api/groupings` — create / rename / delete a unified nation and edit its membership
 * (§5.1). PLACEHOLDER UNTIL P2.
 *
 * Held back with the view that calls it rather than shipped ahead of it: the interesting
 * half of this surface is the conflict rule on
 * `PUT /api/groupings/:id/countries/:countryId` — a 409 naming the current owner unless
 * the body carries `{ move: true }` — and that rule only has a definition once the "Move
 * from <X>?" prompt exists to send it. P1.12 is reads.
 *
 * When it lands: POST `/`, PATCH `/:id`, DELETE `/:id`, PUT `/:id/countries` (bulk
 * membership replace, one transaction), PUT and DELETE `/:id/countries/:countryId`.
 */
export const groupingRoutes = new Hono();

/**
 * `/api/country-overrides` — the per-save country rename (§5.1). PLACEHOLDER UNTIL P2,
 * alongside the right-click rename in the view.
 *
 * When it lands: PUT `/:countryId` (an upsert — the row is keyed `(save_id, country_id)`)
 * and DELETE `/:countryId`, which restores the default name by REMOVING the row rather
 * than writing the default back into it (§7.4). The read half is already live: this
 * module's `/api/map/countries` is where an override becomes visible.
 */
export const countryOverrideRoutes = new Hono();
