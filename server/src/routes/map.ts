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
 * P1.12 filled in the two READS; P2.6 added the write surface below, alongside the view
 * that calls it — the conflict rule on `PUT /api/groupings/:id/countries/:countryId` only
 * has a definition once the "Move from <X>?" prompt exists to send it. P3.7 added the
 * LEADER write path: `PATCH /api/groupings/:id/countries/:countryId`, and the rule that a
 * move carries `is_leader` into a union that has none instead of always clearing it.
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
import { randomUUID } from 'node:crypto';

import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context } from 'hono';

import type { Country, CountryOverride, Grouping, GroupingCountry } from '@shared/types/index';

import { appDb, db, sqlite } from '../db/index.js';
import { country, countryOverride, grouping, groupingCountry, save } from '../db/schema.js';

import type { DbHandle } from '../db/index.js';

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

/* ==================================================================================== *
 * THE WRITE SURFACE (P2.6) — `/api/groupings` and `/api/country-overrides`
 *
 * Two more routers, mounted at their own top-level prefixes (§4.4). Shared with the
 * reads above: `resolveSave`, the `{ error: string }` envelope, and the rule that a
 * response is always a NAMED object.
 *
 * ── FOUR RULES THIS SURFACE FOLLOWS, STATED ONCE ────────────────────────────────────
 *
 * 1. THE SAVE IS THE SCOPE, ALWAYS. Every handler resolves `?save=` first and derives
 *    `save_id` for every row it writes from that one value; `:id` is then looked up
 *    WITHIN it (`resolveGrouping`). A cross-save write is therefore unrepresentable here
 *    rather than merely rejected — and the composite FK on `(save_id, grouping_id)` is
 *    still the backstop for anything that writes the table without coming through this
 *    module (§2.5).
 *
 * 2. FAILURE IS LOUD AND NAMES THE THING. The defect this endpoint set exists to fix is
 *    the old app's silent refusal (`map/src/App.jsx:96-97`): clicking a country another
 *    nation owned did nothing at all, which reads as a broken UI. So a refusal here
 *    always carries what the author needs to act on it — the 409 on an owned country
 *    names the OWNER, in the `ownedBy` field §5.1's "Move from <X>?" prompt is built
 *    from. Addressing a row that is not there is a 404 on every route, never a quiet
 *    success.
 *
 * 3. A MULTI-ROW WRITE IS ONE TRANSACTION. `PUT /:id/countries` and `DELETE /:id` both
 *    touch several rows, and a partial application of either is a visibly half-built
 *    nation (§5.1). Both run through `sqlite.transaction()` — the raw connection is
 *    exported beside the drizzle handle for exactly this (`db/index.ts`), because
 *    drizzle's own `db.transaction()` hands back a differently-typed handle that would
 *    infect every signature it touches.
 *
 *    P3.7 adds two more transactions for a DIFFERENT reason. `assignMembership` and
 *    `setMembershipLeader` each write a single row, but each decides WHAT to write from a
 *    read of `grouping_country_leader_unique`'s one-leader-per-grouping scope — and a
 *    decision taken outside the transaction that acts on it is a decision about a world
 *    that may already have moved.
 *
 * 4. INDEPENDENCE IS THE ABSENCE OF A ROW. `DELETE /:id/countries/:countryId` deletes
 *    and stores nothing; deleting a grouping deletes its membership rows and the
 *    countries are independent again by consequence, not by a flag (§2.4).
 * ==================================================================================== */

/** `POST /api/groupings`, `PATCH /api/groupings/:id` — the created / updated row. */
export type GroupingResponse = { grouping: Grouping };

/** `PUT /api/groupings/:id/countries` — the grouping's membership AFTER the write. */
export type GroupingMembersResponse = { members: GroupingCountry[] };

/** `PUT /api/groupings/:id/countries/:countryId` — the single membership row written. */
export type GroupingMemberResponse = { member: GroupingCountry };

/** `PUT /api/country-overrides/:countryId` — the upserted rename. */
export type CountryOverrideResponse = { override: CountryOverride };

/** Every DELETE on this surface. There is nothing left to return but the fact. */
export type OkResponse = { ok: true };

/**
 * The 409 body for a country another grouping already owns (§5.1, P2.3.3).
 *
 * `ownedBy` IS THE POINT OF THE STATUS CODE. A bare 409 would be the old silent refusal
 * with a number attached — the client cannot write "Move from <X>?" without X, and
 * cannot look it up either, because the owning grouping is exactly the thing it did not
 * know. Retrying the same request with `{ move: true }` is what the prompt sends.
 */
export type OwnedByError = { error: string; ownedBy: { id: string; name: string } };

/**
 * The bulk analogue of {@link OwnedByError}: `PUT /:id/countries` can collide on several
 * countries at once, each with a different owner, so the conflicts arrive as a list.
 *
 * NOT IN THE PINNED P2 CONTRACT, which specifies `ownedBy` for the single assign only —
 * the bulk shape had no definition to build to. This is the same rule generalized, and
 * the singular field is left alone so the client's existing reader keeps working.
 */
export type MembershipConflictError = {
  error: string;
  conflicts: { countryId: string; ownedBy: { id: string; name: string } }[];
};

/**
 * A save-scoped grouping lookup. Returns the row rather than a boolean because every
 * caller that reports a conflict needs the NAME, not just the existence (rule 2).
 */
function resolveGrouping(saveId: string, id: string): Grouping | undefined {
  return db
    .select()
    .from(grouping)
    .where(and(eq(grouping.saveId, saveId), eq(grouping.id, id)))
    .get();
}

/** `{ error }` for a `:id` that is not a grouping of this save — rule 1's 404. */
function noSuchGrouping(saveId: string, id: string): string {
  return `no grouping with id '${id}' in save '${saveId}'`;
}

type JsonBody = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

/**
 * Read a JSON object body, tolerating an absent one.
 *
 * `c.req.json()` THROWS on an empty body, and an empty body is legitimate on three of
 * these routes — `PUT /:id/countries/:countryId` carries `{ move: true }` only when the
 * author has confirmed the prompt, so the common case sends nothing at all. Parsed here
 * instead so that a malformed body is a 400 naming the problem rather than a bare 500.
 */
async function readJsonBody(c: Context): Promise<JsonBody> {
  const raw = await c.req.text();
  if (raw.trim() === '') return { ok: true, value: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'request body is not valid JSON' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'request body must be a JSON object' };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/**
 * Names are TRIMMED before they are stored. `UNIQUE (save_id, name)` compares the raw
 * text, so `'UEA'` and `'UEA '` are two rows the constraint accepts and the sidebar
 * draws identically — the half-populated-nation failure the schema comment warns about,
 * arriving through the UI instead of the importer.
 */
function readName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * `#rrggbb`, lower-cased. Every seeded color is in that form and `<input type="color">`
 * emits nothing else, so accepting more would only let two spellings of one color into
 * a column that is compared as text.
 */
function readColor(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(raw)) return undefined;
  return raw.toLowerCase();
}

type MoveFlag = { ok: true; move: boolean } | { ok: false; error: string };

/**
 * `{ move: true }` — the confirmed "Move from <X>?" (§5.1).
 *
 * A non-boolean is REJECTED rather than coerced. `"move": "false"` is truthy and
 * `"move": "true"` sent by a client that stringified its state would otherwise decide a
 * reassignment by accident — and the 409 exists precisely so that a move is something
 * the author said yes to.
 */
function readMove(body: Record<string, unknown>): MoveFlag {
  const raw = body.move;
  if (raw === undefined) return { ok: true, move: false };
  if (typeof raw !== 'boolean') return { ok: false, error: "'move' must be a boolean" };
  return { ok: true, move: raw };
}

type LeaderFlag = { ok: true; isLeader: boolean } | { ok: false; error: string };

/**
 * `{ isLeader }` — the whole body of the leader PATCH (P3.7.1).
 *
 * REQUIRED, and a non-boolean is rejected rather than coerced, for the reason
 * {@link readMove} gives: `"isLeader": "false"` is truthy, so a client that stringified
 * its state would DEMOTE a union's leader with the value that says to keep it. There is
 * no default either — an absent field would make an empty body mean "clear the leader",
 * and an empty body is exactly what a mis-built request sends.
 */
function readIsLeader(body: Record<string, unknown>): LeaderFlag {
  const raw = body.isLeader;
  if (typeof raw !== 'boolean') return { ok: false, error: "'isLeader' must be a boolean" };
  return { ok: true, isLeader: raw };
}

/**
 * The message from a write the database refused, or `undefined` if the error is not a
 * constraint failure and belongs to the 500 handler.
 *
 * Both callers wrap a TRANSACTION, so their messages can promise that nothing was
 * written — which is the only reason the promise is true.
 */
function constraintFailure(err: unknown): string | undefined {
  if (!(err instanceof Error) || !('code' in err)) return undefined;
  const code = err.code;
  if (typeof code !== 'string' || !code.startsWith('SQLITE_CONSTRAINT')) return undefined;
  return err.message;
}

/**
 * `/api/groupings` — create / rename / recolor / delete a unified nation, and edit its
 * membership (§5.1, P2.6.1–P2.6.3).
 */
export const groupingRoutes = new Hono();

/**
 * P2.6.1 — create a unified nation. `{ name, color }` in, `{ grouping }` out.
 *
 * The id is MINTED HERE, never accepted from the body: it is the primary key, and a
 * client that picks it can collide with a row in another save (`grouping.id` is globally
 * unique, not per-save) or re-point an existing nation by resending its id. `grp_<uuid>`
 * matches the 29 rows the map seed already wrote — the schema header's "runtime rows get
 * a ULID" is a convention with no CHECK behind it and nothing reads id order (the
 * groupings read sorts by name for exactly that reason), so matching the existing data
 * beats introducing a second id shape.
 *
 * A duplicate name is a 409, not a 500 from `grouping_save_id_name_unique`. Two nations
 * with one name are two half-populated nations the importer believes are one (§2.5), and
 * the author renaming one of them is the fix — which needs to be readable in the body.
 */
groupingRoutes.post('/', async (c) => {
  const scope = resolveSave(c.req.query('save'));
  if (!scope.ok) return c.json({ error: scope.error }, scope.status);

  const body = await readJsonBody(c);
  if (!body.ok) return c.json({ error: body.error }, 400);

  const name = readName(body.value.name);
  if (name === undefined) return c.json({ error: "'name' must be a non-empty string" }, 400);

  const color = readColor(body.value.color);
  if (color === undefined) {
    return c.json({ error: "'color' must be a hex color like '#4f9dff'" }, 400);
  }

  const taken = db
    .select({ id: grouping.id })
    .from(grouping)
    .where(and(eq(grouping.saveId, scope.saveId), eq(grouping.name, name)))
    .get();
  if (taken !== undefined) {
    return c.json(
      { error: `save '${scope.saveId}' already has a grouping named '${name}' (id '${taken.id}')` },
      409,
    );
  }

  const row = db
    .insert(grouping)
    .values({ id: `grp_${randomUUID()}`, saveId: scope.saveId, name, color })
    .returning()
    .get();

  return c.json({ grouping: row } satisfies GroupingResponse);
});

/**
 * P2.6.1 — rename and/or recolor. Both fields optional, at least one required.
 *
 * An empty patch is a 400 rather than a no-op 200: it is a client that meant to send
 * something, and answering it with the unchanged row would confirm a write that did not
 * happen. Renaming a grouping to the name it already has is fine — the uniqueness check
 * excludes the row being edited, so re-submitting an unchanged form is not a conflict.
 */
groupingRoutes.patch('/:id', async (c) => {
  const scope = resolveSave(c.req.query('save'));
  if (!scope.ok) return c.json({ error: scope.error }, scope.status);

  const id = c.req.param('id');
  const target = resolveGrouping(scope.saveId, id);
  if (target === undefined) return c.json({ error: noSuchGrouping(scope.saveId, id) }, 404);

  const body = await readJsonBody(c);
  if (!body.ok) return c.json({ error: body.error }, 400);

  const patch: { name?: string; color?: string } = {};

  if (body.value.name !== undefined) {
    const name = readName(body.value.name);
    if (name === undefined) return c.json({ error: "'name' must be a non-empty string" }, 400);
    patch.name = name;
  }

  if (body.value.color !== undefined) {
    const color = readColor(body.value.color);
    if (color === undefined) {
      return c.json({ error: "'color' must be a hex color like '#4f9dff'" }, 400);
    }
    patch.color = color;
  }

  if (patch.name === undefined && patch.color === undefined) {
    return c.json({ error: "body must carry at least one of 'name' or 'color'" }, 400);
  }

  if (patch.name !== undefined && patch.name !== target.name) {
    const taken = db
      .select({ id: grouping.id })
      .from(grouping)
      .where(and(eq(grouping.saveId, scope.saveId), eq(grouping.name, patch.name)))
      .get();
    if (taken !== undefined) {
      return c.json(
        {
          error: `save '${scope.saveId}' already has a grouping named '${patch.name}' (id '${taken.id}')`,
        },
        409,
      );
    }
  }

  const row = db
    .update(grouping)
    .set(patch)
    .where(and(eq(grouping.saveId, scope.saveId), eq(grouping.id, id)))
    .returning()
    .get();

  return c.json({ grouping: row } satisfies GroupingResponse);
});

/**
 * P2.6.1 — delete a unified nation and return its countries to independent.
 *
 * THE CASCADE IS APPLICATION-LEVEL AND HAS TO BE. §5.1 says "DELETE cascades its
 * grouping_country rows", but the composite FK to `grouping (save_id, id)` is declared
 * `ON DELETE no action` in the migration — deleting a grouping that still has members
 * would simply fail. The two statements therefore run in ONE transaction (rule 3): a
 * membership delete that committed without the grouping delete would silently disband a
 * nation the author still sees in the sidebar.
 *
 * `location` also points at `grouping (save_id, grouping_id)`, and that reference is NOT
 * cascaded — a place cannot be un-referenced by deleting the nation it names. The FK
 * refusal is surfaced as a 409 naming the constraint rather than a 500.
 */
groupingRoutes.delete('/:id', (c) => {
  const scope = resolveSave(c.req.query('save'));
  if (!scope.ok) return c.json({ error: scope.error }, scope.status);

  const id = c.req.param('id');
  if (resolveGrouping(scope.saveId, id) === undefined) {
    return c.json({ error: noSuchGrouping(scope.saveId, id) }, 404);
  }

  try {
    sqlite.transaction(() => {
      db.delete(groupingCountry)
        .where(and(eq(groupingCountry.saveId, scope.saveId), eq(groupingCountry.groupingId, id)))
        .run();
      db.delete(grouping)
        .where(and(eq(grouping.saveId, scope.saveId), eq(grouping.id, id)))
        .run();
    })();
  } catch (err) {
    const refusal = constraintFailure(err);
    if (refusal === undefined) throw err;
    return c.json(
      { error: `grouping '${id}' is still referenced, so nothing was deleted: ${refusal}` },
      409,
    );
  }

  return c.json({ ok: true } satisfies OkResponse);
});

/**
 * One membership row joined to the grouping that owns it — the shape every conflict
 * report needs.
 *
 * The join is INNER and cannot drop a row: `grouping_country`'s composite FK guarantees
 * a membership names a grouping in the same save. So `undefined` here means exactly one
 * thing — the country belongs to no nation in this save — which is what makes it usable
 * as the membership lookup as well as the owner lookup.
 */
function ownerOf(
  saveId: string,
  countryId: string,
): { member: GroupingCountry; ownerName: string } | undefined {
  return db
    .select({ member: groupingCountry, ownerName: grouping.name })
    .from(groupingCountry)
    .innerJoin(
      grouping,
      and(eq(grouping.saveId, groupingCountry.saveId), eq(grouping.id, groupingCountry.groupingId)),
    )
    .where(and(eq(groupingCountry.saveId, saveId), eq(groupingCountry.countryId, countryId)))
    .get();
}

/** The grouping's membership as the reads emit it — ordered by `country_id` (§5.1). */
function membersOf(saveId: string, groupingId: string): GroupingCountry[] {
  return db
    .select()
    .from(groupingCountry)
    .where(and(eq(groupingCountry.saveId, saveId), eq(groupingCountry.groupingId, groupingId)))
    .orderBy(asc(groupingCountry.countryId))
    .all();
}

/* ==================================================================================== *
 * THE LEADER WRITE PATH (P3.7)
 *
 * `is_leader` was written by the seed and by nothing else. P2 shipped a map that CLEARS
 * the flag on every move with no surface anywhere that sets it, and the ten leaders exist
 * only in `data/story_docs/LIFEstream Bible.txt` — the authored map export has no leader
 * field — so a leader lost through ordinary editing was gone from every file in the repo,
 * recoverable only by re-running the seed. The warning P2 added to the move prompts was a
 * mitigation, not a fix.
 *
 * ── WHY THESE TWO TAKE A CONNECTION AND THE REST OF THE MODULE DOES NOT ──────────────
 * Every other helper here closes over the module-scope `db` / `sqlite`, which are bound to
 * `data/lifestream.db`. These two carry the invariant worth a spec — the partial unique
 * index `grouping_country_leader_unique` admits ONE leader per grouping, and each writer
 * passes through a moment where the wrong statement order trips it — so they take the
 * handle as an argument and `tests/countryImport.test.ts` (P3.7.4) drives them against its
 * own `:memory:` world. The handlers pass `appDb`, which IS that module-scope pair.
 * ==================================================================================== */

/** The connection one membership write runs on: the app's handle, or a spec's. */
export type MembershipWriter = Pick<DbHandle, 'db' | 'sqlite'>;

/** Is this grouping already led by some country other than `exceptCountryId`? */
function hasLeader(
  handle: MembershipWriter,
  saveId: string,
  groupingId: string,
  exceptCountryId: string,
): boolean {
  const row = handle.db
    .select({ countryId: groupingCountry.countryId })
    .from(groupingCountry)
    .where(
      and(
        eq(groupingCountry.saveId, saveId),
        eq(groupingCountry.groupingId, groupingId),
        eq(groupingCountry.isLeader, true),
        // Excluded so that re-writing a leader's own membership reads the grouping as
        // unled and keeps the flag, rather than seeing itself and clearing it.
        ne(groupingCountry.countryId, exceptCountryId),
      ),
    )
    .get();

  return row !== undefined;
}

/**
 * P3.7.3 — write one membership row, CARRYING `is_leader` where it can.
 *
 * The flag used to be reset unconditionally, on the grounds that leadership is a fact
 * about a membership and the destination may already have a leader (§2.4). The second
 * half is true; the first does not follow from it. When the destination has NO leader
 * there is nothing for the flag to collide with, and clearing it destroys authored canon
 * for no reason — which is the whole of the P2 regression. So the rule is now the narrow
 * one: cleared only when the destination is already led.
 *
 * ONE TRANSACTION, because the decision and the write have to see the same world. A
 * "does the destination have a leader" read taken outside it can be true when read and
 * false when written, and the write it authorises is the one that puts two leaders in one
 * grouping — which `grouping_country_leader_unique` then refuses, turning an ordinary
 * click into a 500 about a constraint.
 */
export function assignMembership(
  handle: MembershipWriter,
  saveId: string,
  groupingId: string,
  countryId: string,
): GroupingCountry {
  return handle.sqlite.transaction((): GroupingCountry => {
    const moving = handle.db
      .select({ isLeader: groupingCountry.isLeader })
      .from(groupingCountry)
      .where(and(eq(groupingCountry.saveId, saveId), eq(groupingCountry.countryId, countryId)))
      .get();

    // A country arriving from independence leads nothing, so the absent row is `false`
    // rather than a case of its own.
    const isLeader = moving?.isLeader === true && !hasLeader(handle, saveId, groupingId, countryId);

    return handle.db
      .insert(groupingCountry)
      .values({ saveId, groupingId, countryId, isLeader })
      .onConflictDoUpdate({
        target: [groupingCountry.saveId, groupingCountry.countryId],
        set: { groupingId, isLeader },
      })
      .returning()
      .get();
  })();
}

/**
 * P3.7.1 — mark a member as its union's leader, or clear the union's leader.
 *
 * SETTING ONE CLEARS THE PREVIOUS ONE IN THE SAME TRANSACTION, AND THE ORDER IS PART OF
 * THE CONTRACT. `grouping_country_leader_unique` is a partial unique index over
 * `(save_id, grouping_id) WHERE is_leader = 1`: promoting the new leader before demoting
 * the old one fails on the constraint, and demoting first WITHOUT a transaction leaves the
 * union with no leader at all if the promotion does not land. Clear, then set — both or
 * neither.
 *
 * The caller has already established that `countryId` is a member of `groupingId`, so the
 * final update is keyed on the primary key `(save_id, country_id)`: it writes the row the
 * URL names, or no row at all.
 */
export function setMembershipLeader(
  handle: MembershipWriter,
  saveId: string,
  groupingId: string,
  countryId: string,
  isLeader: boolean,
): GroupingCountry {
  return handle.sqlite.transaction((): GroupingCountry => {
    if (isLeader) {
      handle.db
        .update(groupingCountry)
        .set({ isLeader: false })
        .where(
          and(
            eq(groupingCountry.saveId, saveId),
            eq(groupingCountry.groupingId, groupingId),
            eq(groupingCountry.isLeader, true),
            ne(groupingCountry.countryId, countryId),
          ),
        )
        .run();
    }

    return handle.db
      .update(groupingCountry)
      .set({ isLeader })
      .where(and(eq(groupingCountry.saveId, saveId), eq(groupingCountry.countryId, countryId)))
      .returning()
      .get();
  })();
}

/**
 * P2.6.2 — replace this grouping's whole membership. `{ countryIds, move? }` in,
 * `{ members }` out.
 *
 * WHY THIS IS NOT N SINGLE ASSIGNS. The sidebar's "unify these selected countries" is
 * inherently bulk, and N requests fail independently: one 409 in the middle leaves a
 * half-built nation on screen, with no request left to undo the ones that succeeded
 * (§5.1). So the handler diffs the request against `grouping_country` and writes the
 * delta — the removals and the additions — inside ONE transaction. Either the membership
 * is what was asked for, or it is untouched.
 *
 * THE DIFF IS INSIDE THE TRANSACTION TOO, not just the writes. It reads the rows it is
 * about to overwrite; computing it outside would be a read of a state the write no
 * longer applies to.
 *
 * The conflict rule is the same one `PUT /:id/countries/:countryId` enforces, applied to
 * every requested country at once: without `{ move: true }` a country another nation owns
 * refuses the WHOLE request (nothing is written, including the parts that would have
 * succeeded), and the body lists every conflict with its owner. Countries dropped from
 * the membership become independent — no row, no flag (rule 4).
 */
groupingRoutes.put('/:id/countries', async (c) => {
  const scope = resolveSave(c.req.query('save'));
  if (!scope.ok) return c.json({ error: scope.error }, scope.status);

  const id = c.req.param('id');
  const target = resolveGrouping(scope.saveId, id);
  if (target === undefined) return c.json({ error: noSuchGrouping(scope.saveId, id) }, 404);

  const body = await readJsonBody(c);
  if (!body.ok) return c.json({ error: body.error }, 400);

  const move = readMove(body.value);
  if (!move.ok) return c.json({ error: move.error }, 400);

  const rawIds = body.value.countryIds;
  if (!Array.isArray(rawIds) || rawIds.some((v) => typeof v !== 'string' || v === '')) {
    return c.json({ error: "'countryIds' must be an array of country ids" }, 400);
  }
  // Deduplicated because the request describes a SET — the membership after the write —
  // and `(save_id, country_id)` would reject the repeat anyway, as a 500 about a
  // constraint instead of the write the author meant.
  const requested = [...new Set(rawIds as string[])];

  // Unknown ids are rejected BEFORE the transaction so the message can name them. The FK
  // to `country` would catch them too, with `FOREIGN KEY constraint failed` and no clue
  // which of the fifty ids was wrong. A 400, not a 404: the missing thing is in the body,
  // not the URL. Ids are zero-padded strings and synthetics look like `x:GUF` (§3.1) —
  // never coerced, here or anywhere.
  if (requested.length > 0) {
    const known = new Set(
      db
        .select({ id: country.id })
        .from(country)
        .where(inArray(country.id, requested))
        .all()
        .map((row) => row.id),
    );
    const unknown = requested.filter((countryId) => !known.has(countryId));
    if (unknown.length > 0) {
      return c.json(
        {
          error: `'countryIds' names ${unknown.length} id(s) that are not countries: ${unknown
            .map((countryId) => `'${countryId}'`)
            .join(', ')}`,
        },
        400,
      );
    }
  }

  type Outcome =
    | { ok: true; members: GroupingCountry[] }
    | { ok: false; conflicts: MembershipConflictError['conflicts'] };

  // The transaction RETURNS the refusal rather than throwing it: a conflict has written
  // nothing, so committing an empty transaction and reporting it is honest, and it keeps
  // the 409 out of the catch below, which is about writes the DATABASE refused.
  const run = sqlite.transaction((): Outcome => {
    const owners = new Map<string, { groupingId: string; ownerName: string }>();
    if (requested.length > 0) {
      for (const row of db
        .select({ member: groupingCountry, ownerName: grouping.name })
        .from(groupingCountry)
        .innerJoin(
          grouping,
          and(
            eq(grouping.saveId, groupingCountry.saveId),
            eq(grouping.id, groupingCountry.groupingId),
          ),
        )
        .where(
          and(
            eq(groupingCountry.saveId, scope.saveId),
            inArray(groupingCountry.countryId, requested),
          ),
        )
        .all()) {
        owners.set(row.member.countryId, {
          groupingId: row.member.groupingId,
          ownerName: row.ownerName,
        });
      }
    }

    const claimed = requested.filter((countryId) => {
      const owner = owners.get(countryId);
      return owner !== undefined && owner.groupingId !== target.id;
    });

    if (claimed.length > 0 && !move.move) {
      return {
        ok: false,
        conflicts: claimed.map((countryId) => {
          // Non-null: `claimed` is built from the map's own entries.
          const owner = owners.get(countryId) as { groupingId: string; ownerName: string };
          return { countryId, ownedBy: { id: owner.groupingId, name: owner.ownerName } };
        }),
      };
    }

    const keep = new Set(requested);
    const dropped = membersOf(scope.saveId, target.id)
      .map((row) => row.countryId)
      .filter((countryId) => !keep.has(countryId));

    // One delete for both halves of the diff: the countries leaving this grouping, and
    // the ones being taken from another. Both are `(save_id, country_id)` rows, and the
    // second must go before its replacement can be inserted — the primary key is the
    // reason a move is a delete-and-insert rather than an overwrite.
    const removals = [...dropped, ...claimed];
    if (removals.length > 0) {
      db.delete(groupingCountry)
        .where(
          and(
            eq(groupingCountry.saveId, scope.saveId),
            inArray(groupingCountry.countryId, removals),
          ),
        )
        .run();
    }

    const additions = requested.filter(
      (countryId) => owners.get(countryId)?.groupingId !== target.id,
    );
    if (additions.length > 0) {
      db.insert(groupingCountry)
        .values(
          additions.map((countryId) => ({
            saveId: scope.saveId,
            groupingId: target.id,
            countryId,
            // A country arriving from another nation arrives as an ordinary member, and
            // this endpoint KEEPS that rule where P3.7.3 relaxed it for the single
            // assign. A whole-membership replace can move several leaders in at once and
            // `grouping_country_leader_unique` admits one, so carrying the flag here
            // would mean picking which of them keeps it — the author's decision, not this
            // handler's, and `PATCH /:id/countries/:countryId` is where they make it.
            isLeader: false,
          })),
        )
        .run();
    }

    return { ok: true, members: membersOf(scope.saveId, target.id) };
  });

  let outcome: Outcome;
  try {
    outcome = run();
  } catch (err) {
    const refusal = constraintFailure(err);
    if (refusal === undefined) throw err;
    // The transaction rolled back, so this is a true statement and not a hopeful one.
    return c.json(
      { error: `the membership delta was refused, so nothing was written: ${refusal}` },
      409,
    );
  }

  if (!outcome.ok) {
    return c.json(
      {
        error:
          `${outcome.conflicts.length} of the requested countries already belong to another ` +
          `grouping in save '${scope.saveId}'; resend with { "move": true } to reassign them`,
        conflicts: outcome.conflicts,
      } satisfies MembershipConflictError,
      409,
    );
  }

  return c.json({ members: outcome.members } satisfies GroupingMembersResponse);
});

/**
 * P2.6.3 — assign one country to this grouping. `{ member }` out.
 *
 * PUT, NOT POST: the row is keyed `(save_id, country_id)`, so the request fully specifies
 * the resource it writes and repeating it changes nothing (§5.1).
 *
 * THIS IS THE ENDPOINT THE PHASE EXISTS FOR. `grouping_country`'s primary key allows one
 * nation per country per save, so a country another grouping owns is a CONFLICT, not an
 * overwrite — and the old app answered that click with nothing at all. Here it is a 409
 * carrying `ownedBy`, which is what the "Move from <X>?" prompt is written from; the
 * author's confirmation comes back as `{ move: true }` and reassigns.
 *
 * The write is still one upsert against the `(save_id, country_id)` primary key, so a move
 * cannot leave the country in two nations or in none. Since P3.7.3 it runs inside a
 * transaction anyway — not for the row, but because the `is_leader` it writes depends on a
 * read of the destination's current leader. See {@link assignMembership}.
 */
groupingRoutes.put('/:id/countries/:countryId', async (c) => {
  const scope = resolveSave(c.req.query('save'));
  if (!scope.ok) return c.json({ error: scope.error }, scope.status);

  const id = c.req.param('id');
  const target = resolveGrouping(scope.saveId, id);
  if (target === undefined) return c.json({ error: noSuchGrouping(scope.saveId, id) }, 404);

  // 404 rather than the FK's `FOREIGN KEY constraint failed`: `country` is global, so an
  // id that is not in it is not in any save either.
  const countryId = c.req.param('countryId');
  const known = db.select({ id: country.id }).from(country).where(eq(country.id, countryId)).get();
  if (known === undefined) return c.json({ error: `no country with id '${countryId}'` }, 404);

  const body = await readJsonBody(c);
  if (!body.ok) return c.json({ error: body.error }, 400);

  const move = readMove(body.value);
  if (!move.ok) return c.json({ error: move.error }, 400);

  const current = ownerOf(scope.saveId, countryId);

  // Already a member of THIS grouping: return the row unchanged. `assignMembership` would
  // now preserve `is_leader` here too — it clears only when the DESTINATION is already led
  // by someone else — but a re-confirmation has nothing to write, and this short-circuit
  // is what makes "a repeat click cannot demote a leader" a property of the endpoint
  // rather than of one branch inside the writer.
  if (current !== undefined && current.member.groupingId === target.id) {
    return c.json({ member: current.member } satisfies GroupingMemberResponse);
  }

  if (current !== undefined && !move.move) {
    return c.json(
      {
        error: `country '${countryId}' already belongs to '${current.ownerName}' in save '${scope.saveId}'; resend with { "move": true } to reassign it`,
        ownedBy: { id: current.member.groupingId, name: current.ownerName },
      } satisfies OwnedByError,
      409,
    );
  }

  // Reached on a fresh assign and on the CONFIRMED move, never on a re-confirmation —
  // that short-circuited above. The writer decides `is_leader` inside its own
  // transaction: carried when the country led its old union and the destination has no
  // leader, cleared when the destination is already led (P3.7.3).
  const member = assignMembership(appDb, scope.saveId, target.id, countryId);

  return c.json({ member } satisfies GroupingMemberResponse);
});

/**
 * P3.7.1 — mark a member as its union's leader, or clear the union's leader.
 * `{ isLeader }` in, `{ member }` out.
 *
 * WHY IT IS A SEPARATE ENDPOINT. `PUT /:id/countries/:countryId` already owns the row's
 * existence and which grouping it names; folding the flag into it would make the
 * membership assign and the leadership edit one request, so every re-assign would have to
 * either carry the flag or clear it — which is the defect this task exists to remove.
 * PATCH, because the request changes ONE column of a row it does not otherwise describe.
 *
 * THE COUNTRY MUST ALREADY BE A MEMBER OF THIS GROUPING, and the two ways that fails
 * answer exactly as `DELETE /:id/countries/:countryId` does: a country in no grouping is a
 * 404, one in a DIFFERENT grouping is a 409 naming the owner (rule 2). Leadership is a
 * fact about a membership row (§2.4) — with no row there is nothing to set the flag on,
 * and creating the membership here would be a second write the author did not ask for.
 *
 * `{ isLeader: false }` on a member that does not lead is a 200 with the row untouched:
 * the request describes the state it wants, and that state already holds.
 */
groupingRoutes.patch('/:id/countries/:countryId', async (c) => {
  const scope = resolveSave(c.req.query('save'));
  if (!scope.ok) return c.json({ error: scope.error }, scope.status);

  const id = c.req.param('id');
  const target = resolveGrouping(scope.saveId, id);
  if (target === undefined) return c.json({ error: noSuchGrouping(scope.saveId, id) }, 404);

  const body = await readJsonBody(c);
  if (!body.ok) return c.json({ error: body.error }, 400);

  const flag = readIsLeader(body.value);
  if (!flag.ok) return c.json({ error: flag.error }, 400);

  // No separate `country` lookup: an id that is in no `grouping_country` row of this save
  // is not a member whether or not it is a country, and the 404 below says the thing the
  // author can act on. `PUT` checks the global table because its INSERT would otherwise
  // fail on the foreign key; this handler only ever updates.
  const countryId = c.req.param('countryId');
  const current = ownerOf(scope.saveId, countryId);

  if (current === undefined) {
    return c.json(
      { error: `country '${countryId}' belongs to no grouping in save '${scope.saveId}'` },
      404,
    );
  }

  if (current.member.groupingId !== target.id) {
    return c.json(
      {
        error: `country '${countryId}' belongs to '${current.ownerName}', not to '${target.name}'`,
        ownedBy: { id: current.member.groupingId, name: current.ownerName },
      } satisfies OwnedByError,
      409,
    );
  }

  const member = setMembershipLeader(appDb, scope.saveId, target.id, countryId, flag.isLeader);

  return c.json({ member } satisfies GroupingMemberResponse);
});

/**
 * P2.6.3 — the inverse: back to independent. Deletes the row and stores nothing, because
 * independence is the absence of a row and never a stored flag (§2.4, rule 4).
 *
 * Deleting a membership that belongs to a DIFFERENT grouping is refused with the same
 * 409 + `ownedBy` as the assign, rather than deleting it anyway. The request names the
 * grouping in its path; honouring it would let a stale sidebar disband a nation the
 * author was not looking at.
 */
groupingRoutes.delete('/:id/countries/:countryId', (c) => {
  const scope = resolveSave(c.req.query('save'));
  if (!scope.ok) return c.json({ error: scope.error }, scope.status);

  const id = c.req.param('id');
  const target = resolveGrouping(scope.saveId, id);
  if (target === undefined) return c.json({ error: noSuchGrouping(scope.saveId, id) }, 404);

  const countryId = c.req.param('countryId');
  const current = ownerOf(scope.saveId, countryId);

  if (current === undefined) {
    return c.json(
      { error: `country '${countryId}' belongs to no grouping in save '${scope.saveId}'` },
      404,
    );
  }

  if (current.member.groupingId !== target.id) {
    return c.json(
      {
        error: `country '${countryId}' belongs to '${current.ownerName}', not to '${target.name}'`,
        ownedBy: { id: current.member.groupingId, name: current.ownerName },
      } satisfies OwnedByError,
      409,
    );
  }

  db.delete(groupingCountry)
    .where(and(eq(groupingCountry.saveId, scope.saveId), eq(groupingCountry.countryId, countryId)))
    .run();

  return c.json({ ok: true } satisfies OkResponse);
});

/**
 * `/api/country-overrides` — the per-save country rename (§5.1, P2.6.4). The read half
 * is already live: this module's `/api/map/countries` coalesces these rows over the
 * global defaults, so a write here is visible on the next read of that endpoint.
 */
export const countryOverrideRoutes = new Hono();

/**
 * P2.6.4 — rename a country for this save. `{ name }` in, `{ override }` out.
 *
 * PUT and an upsert, for the same reason as the membership assign: the row is keyed
 * `(save_id, country_id)`, so the URL fully specifies it.
 *
 * The default name is NOT compared against. The old map app wrote `geo.properties.name`
 * on every click (`map/src/App.jsx:157`), which is why the seed filters names equal to
 * the derived default — but that filter belongs to the IMPORT of a display cache, not to
 * an authored rename. An author who types the default name has pinned it against a later
 * change to the global row, and refusing that would be this module guessing.
 */
countryOverrideRoutes.put('/:countryId', async (c) => {
  const scope = resolveSave(c.req.query('save'));
  if (!scope.ok) return c.json({ error: scope.error }, scope.status);

  const countryId = c.req.param('countryId');
  const known = db.select({ id: country.id }).from(country).where(eq(country.id, countryId)).get();
  if (known === undefined) return c.json({ error: `no country with id '${countryId}'` }, 404);

  const body = await readJsonBody(c);
  if (!body.ok) return c.json({ error: body.error }, 400);

  const name = readName(body.value.name);
  if (name === undefined) return c.json({ error: "'name' must be a non-empty string" }, 400);

  const override = db
    .insert(countryOverride)
    .values({ saveId: scope.saveId, countryId, name })
    .onConflictDoUpdate({
      target: [countryOverride.saveId, countryOverride.countryId],
      set: { name },
    })
    .returning()
    .get();

  return c.json({ override } satisfies CountryOverrideResponse);
});

/**
 * P2.6.4 — restore the default name by REMOVING the row, never by writing the default
 * into it (§7.4). A stored copy of the default is a value that stops tracking the global
 * row it copied, and the import that did exactly that is the bug this shape avoids.
 */
countryOverrideRoutes.delete('/:countryId', (c) => {
  const scope = resolveSave(c.req.query('save'));
  if (!scope.ok) return c.json({ error: scope.error }, scope.status);

  const countryId = c.req.param('countryId');
  const removed = db
    .delete(countryOverride)
    .where(and(eq(countryOverride.saveId, scope.saveId), eq(countryOverride.countryId, countryId)))
    .returning()
    .get();

  if (removed === undefined) {
    return c.json(
      { error: `save '${scope.saveId}' has no rename for country '${countryId}'` },
      404,
    );
  }

  return c.json({ ok: true } satisfies OkResponse);
});
