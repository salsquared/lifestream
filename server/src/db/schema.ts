/**
 * Drizzle table definitions — the single source of truth for the SQLite schema.
 *
 * Column-level reference: architecture.html §2.5, with the prose in §2.1–§2.4 and the
 * simulation tables in §3. Tasks P1.1–P1.5 of implementation.html. `drizzle.config.ts`
 * at the repo root points here, and P1.6 emits all of it as ONE migration.
 *
 * ── WHY THE WHOLE SCHEMA IS HERE AT ONCE ──────────────────────────────────────────
 * There is no migration story before P1.7, and the seeds, the map view and eighty
 * hand-authored events pile on immediately afterwards. Every post-seed schema change
 * costs a migration PLUS a backfill script. So the schema is authored in full — the
 * deferred simulation tables included — and anything wrong here is permanent in
 * practice. Read a column twice before changing it.
 *
 * ── STORAGE CONVENTIONS (§2.1, settled once, applied everywhere) ──────────────────
 *   · Datetimes are TEXT, ISO-8601, UTC, with the `Z` suffix. The canonical spelling is
 *     `Date#toISOString()` — `YYYY-MM-DDTHH:MM:SS.mmmZ`, ALWAYS three fractional digits,
 *     ALWAYS `Z` — and `isoInstant()` below pins it as a CHECK on all eighteen datetime
 *     columns. This is not decoration: `'…T00:00:00.000Z'` and `'…T00:00:00Z'` are the
 *     same instant but different TEXT, they compare unequal, and the second sorts AFTER
 *     the first, so a row written in the short form fails `event_when_in_window_check`
 *     and falls out of a `byTimeRange` boundary. `shared/src/rollDate.ts` already emits
 *     the canonical form; every other writer must too.
 *     SQLite has no date type; a lexicographically-sortable UTC string makes ORDER BY,
 *     BETWEEN and index range scans work directly on the column. There is exactly one
 *     timezone in this system and it is UTC.
 *   · Ids are TEXT, never INTEGER, and always prefixed — `<prefix>_<slug|ulid>`:
 *     `sav_`, `evt_`, `char_`, `loc_`, `proj_`, `tl_`, `grp_`, `rel_`, `tag_`, `mfst_`,
 *     `run_`. Seeded rows get a readable slug (`sav_canon`), runtime rows a ULID.
 *     `country.id` is the one exception — it is an external identifier (§2.4). The
 *     prefixes are a CONVENTION, deliberately not a CHECK: the seed and the fork both
 *     mint ids, and no read depends on the shape.
 *   · SQL columns are snake_case; the camelCase property names ARE the wire format
 *     (the wire-format decision). This file is the only place the two meet — there is
 *     no hand-written mapper, and `conformance.ts` next door proves the shapes match
 *     `@shared/types`.
 *   · jsonb does not exist in SQLite: JSON columns are TEXT parsed at this boundary,
 *     and `$type<…>()` names the shape they hold. Every JSON column that a READ parses
 *     also carries a `json_valid` + `json_type` CHECK, because Drizzle parses the column
 *     eagerly: ONE malformed row makes `select().from(timeline).all()` throw for every
 *     read of the table, not just for the bad row.
 *
 * ── CLOSED ENUMS (the closed-enums decision) ──────────────────────────────────────
 * Every enum below is closed at BOTH levels: `{ enum: [...] }` types the TS side and a
 * CHECK constraint enforces the same member list in SQL, so a typo is a write error
 * rather than a silently empty view. The member lists are declared once, at the top of
 * this file, and mirrored as unions in `shared/src/types/enums.ts`.
 *
 *   `event.category` — no `project` member: it duplicated the `project_id` FK.
 *       tech        an artifact or capability SHIPS
 *       scientific  a result is ESTABLISHED
 *     The Tech Tree reads only `category = 'tech'`, so a wrong pick between those two
 *     silently deletes a node from it. The other five (political, military, disaster,
 *     cultural, personal) are ordinary subject tags for the world timeline.
 *
 * A CHECK whose expression evaluates to NULL PASSES in SQLite, so a nullable enum
 * column needs no `IS NULL OR …` branch: `tech_lane IN (…)` already admits NULL. The
 * same rule carries every other constraint here over NULLs — `era_end >= era_start`,
 * `col GLOB '…'` and `json_valid(col) AND …` are all NULL, hence all satisfied, when
 * the column is NULL.
 *
 * ── DATE PRECISION IS CARRIED EVERYWHERE, NOT JUST ON EVENTS ──────────────────────
 * §2.3's rule is "render by precision, never print a roll". The event quad honours it,
 * and so must the six other bounds — a character's lifespan, a project's dates, an
 * era's span — because canon states them at every precision: `DOB: March 14, 2018`
 * (day), `Presumed Dead (2072)` (year), `Start: ~Jan 2042` (month), `Expected 2086`.
 * Without a precision column a year-precision bound is stored as a Jan-1 instant and is
 * then indistinguishable from an authored day, so the card prints a date the Bible does
 * not contain. Each of the six bounds therefore has a `*_precision` sibling, nullable
 * together with it (`(value IS NULL) = (precision IS NULL)`).
 *
 * ── CROSS-SAVE INTEGRITY: (save_id, id) AND COMPOSITE FOREIGN KEYS ────────────────
 * A per-save row referencing a per-save row in a DIFFERENT save is silent corruption:
 * every single-column FK below was satisfiable by a parent in another save, so a fork
 * that missed one remap produced a VALID row. The schema closes that:
 *
 *   · `UNIQUE (save_id, id)` on `event`, `timeline`, `character`, `location`,
 *     `project`, `grouping` — a parent key the database can point a composite FK at.
 *   · every per-save reference is a COMPOSITE FK on `(save_id, <ref>)`, so the child's
 *     save and the parent's save must agree. The single-column `.references()` is
 *     REPLACED, not doubled up: the composite already proves the parent row exists.
 *   · the four join tables (`timeline_parent`, `timeline_member`, `event_actor`,
 *     `event_tag`) carry a `save_id` for exactly this reason. It is derivable from the
 *     parent row and that is the point — it is the column the composite FK checks
 *     against. Their primary keys are unchanged: the referenced ids are already
 *     globally unique, so `save_id` would add nothing to the key.
 *
 * References to GLOBAL tables (`tag`, `country`, `sim_run`, `save` itself) stay
 * single-column — there is no save to agree with.
 *
 * SQLite uses MATCH SIMPLE and has no other mode: if ANY column of a composite child
 * key is NULL the constraint is satisfied. So an optional reference — `event.location_id`
 * with a NOT NULL `save_id` beside it — still passes when the reference is NULL, which
 * is what optional has to mean.
 *
 * >> FOR WHOEVER WRITES THE FORK (P6) — READ THIS BEFORE YOU DEBUG IT <<
 * A fork regenerates every per-save id, so it inserts rows whose remapped parent has
 * not been written yet, and the composite FKs above would reject them one at a time in
 * insertion order. This is NOT a reason to weaken them and NOT a reason to topologically
 * sort the copy. Wrap the whole fork in one transaction and set
 *
 *     PRAGMA defer_foreign_keys = ON;
 *
 * for its duration (it resets itself at COMMIT). Every foreign key is then checked once,
 * at COMMIT, so children may be inserted before their parents inside the transaction and
 * the constraint still catches a genuinely missed remap — it aborts the whole fork
 * instead of committing a cross-save row. Verified against generated DDL. Note that
 * `defer_foreign_keys` defers FKs only: the CHECK and UNIQUE constraints still fire
 * per-statement, which is why the fork must re-canonicalize symmetric
 * `character_relation` rows after remapping rather than before committing.
 *
 * ── WHAT IS DELIBERATELY NOT HERE (P1.5.7) ───────────────────────────────────────
 * The six simulation tables are SCHEMA ONLY; §3's subsystem stays deferred. The
 * `run_id` in their primary keys is the ONLY run machinery bought now, because a
 * primary key is one irreversible line. Explicitly deferred, and not to be read into
 * these columns as a promise: the active-run pointer table, staleness evaluation, run
 * retention/pruning, and DAG orchestration. Those are a reversible subsystem that can
 * be added later without touching a single existing row (§3.5).
 *
 * Also absent on purpose: indexes beyond the primary keys, the `(save_id, id)` parent
 * keys and the three partial uniques that express a one-per-group rule (add others when
 * a read is measured slow — an index is a DDL-only migration with no backfill), and ON
 * DELETE behaviour (every FK is NO ACTION; the hard-delete path deletes in dependency
 * order explicitly rather than letting a cascade fan out silently — §7.2).
 */

import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';

// TYPE-ONLY, and that is load-bearing: `import type` is erased before any bundler has
// to resolve it, so drizzle-kit never needs the `@shared/*` tsconfig path at generate
// time. Nothing with a runtime value may be imported across the workspace boundary here.
import type { ManifestItem, MembershipRules, SectorMix } from '@shared/types/index';

/* ================================================================== *
 * Closed enum members — the SQL half. Mirrored in shared/src/types/enums.ts.
 * ================================================================== */

/**
 * How coarsely the author actually knows a date (§2.3). Used by `event.when_precision`
 * and by the six `*_precision` siblings on the non-event bounds.
 */
export const WHEN_PRECISIONS = ['time', 'day', 'month', 'season', 'year', 'decade'] as const;

/** `event.category` — see the enum notes in this file's header. No `project` member. */
export const CATEGORIES = [
  'tech',
  'political',
  'military',
  'disaster',
  'scientific',
  'cultural',
  'personal',
] as const;

/** `event.tech_lane` — only meaningful when `category = 'tech'`. */
export const TECH_LANES = [
  'energy',
  'propulsion',
  'computing',
  'neural',
  'biomedical',
  'megastructure',
] as const;

/** `timeline.kind` — what the Corridor's stratum model reads (§5.2). */
export const TIMELINE_KINDS = ['era', 'thread', 'cluster'] as const;

/** `relation.type` — canonical direction; the reverse is derived at query time (§2.6). */
export const RELATION_TYPES = ['precedes', 'partOf', 'renames'] as const;

/** `character_relation.type` — family-only for v1 (§2.2). */
export const CHARACTER_RELATION_TYPES = [
  'parent-of',
  'sibling-of',
  'spouse-of',
  'clone-of',
] as const;

/**
 * The two SYMMETRIC `character_relation` types. Stored lower-id-as-`from` so one pair
 * is one row; the directional types (`parent-of`, `clone-of`) read from→to literally.
 */
export const SYMMETRIC_CHARACTER_RELATION_TYPES = ['sibling-of', 'spouse-of'] as const;

/** `project.status` */
export const PROJECT_STATUSES = ['planned', 'active', 'succeeded', 'failed', 'cancelled'] as const;

/**
 * The reserved `event_actor.role` values. These two are not free text like the rest:
 * they are what links a character to the events defining their lifespan (§2.2), and a
 * character may have at most one of each per save — enforced by a partial unique index
 * on `event_actor` rather than by a CHECK, since it is a cross-row rule.
 */
export const LIFESPAN_ROLES = ['born', 'died'] as const;

/** `country.geometry_source` — 1:1 with a topojson feature, or carved from one (§3.1). */
export const GEOMETRY_SOURCES = ['feature', 'derived'] as const;

/**
 * `'a', 'b', …` — an enum's members as a SQL literal list.
 *
 * Inlined with `sql.raw` rather than bound as parameters: this string is rendered into a
 * CREATE TABLE, where a `?` placeholder has nothing to bind to. Every member above is a
 * bare identifier-shaped literal, so there is nothing to escape.
 */
const members = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/** `<column> in ('a', 'b', …)` — the enum CHECK. A NULL column passes it (see the header). */
const oneOf = (column: AnySQLiteColumn, values: readonly string[]) =>
  sql`${column} in (${members(values)})`;

/** `<column> not in ('a', 'b', …)`. Spelled `NOT IN` so no operator precedence is in play. */
const noneOf = (column: AnySQLiteColumn, values: readonly string[]) =>
  sql`${column} not in (${members(values)})`;

/**
 * The canonical datetime format, as a CHECK — `YYYY-MM-DDTHH:MM:SS.mmmZ`, which is
 * exactly what `Date#toISOString()` produces (see the header).
 *
 * GLOB rather than LIKE: GLOB is case-sensitive (so a lowercase `t`/`z` is rejected)
 * and supports `[0-9]` character classes, which LIKE does not. This is a FORMAT check,
 * not a calendar check — `9999-99-99T99:99:99.999Z` passes it — because the calendar is
 * the writer's job and a CHECK that half-validates dates would only be trusted twice as
 * much as it deserves. A NULL column passes.
 */
const isoInstant = (column: AnySQLiteColumn) =>
  sql`${column} glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'`;

/**
 * `(a IS NULL) = (b IS NULL)` — two columns that are meaningless apart. Used for every
 * value/precision pair, so a bound can never be stored without saying how precisely it
 * is known, nor a precision without a bound to qualify.
 */
const pairedNull = (a: AnySQLiteColumn, b: AnySQLiteColumn) => sql`(${a} is null) = (${b} is null)`;

/**
 * `json_valid(col) AND json_type(col) = '<type>'` — a JSON column holds JSON, of the
 * shape `$type<…>()` claims. A NULL column passes (`json_valid(NULL)` is NULL).
 */
const jsonOf = (column: AnySQLiteColumn, type: 'object' | 'array') =>
  sql`json_valid(${column}) and json_type(${column}) = ${sql.raw(`'${type}'`)}`;

/** `<column> <> ''` — a required TEXT column that an empty string would silently satisfy. */
const nonEmpty = (column: AnySQLiteColumn) => sql`${column} <> ''`;

/* ================================================================== *
 * CORE — architecture §2.1
 * ================================================================== */

/**
 * A versioned project/snapshot. Foundational: every per-save row is an FK away from
 * here, which is why it is the first table in the file and in the migration.
 */
export const save = sqliteTable(
  'save',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    createdAt: text('created_at').notNull(),
    /**
     * Set by a fork. A hard delete is refused (409) while any other save names this one,
     * so this FK is intentionally NOT self-cascading (§7.2).
     */
    parentSaveId: text('parent_save_id').references((): AnySQLiteColumn => save.id),
    isArchived: integer('is_archived', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [
    check('save_id_non_empty_check', nonEmpty(t.id)),
    check('save_name_non_empty_check', nonEmpty(t.name)),
    check('save_created_at_format_check', isoInstant(t.createdAt)),
    // A save that is its own parent could never be hard-deleted: the 409 rule ("refused
    // while any other save names this one") reads its own row and refuses forever.
    check('save_not_self_parent_check', sql`${t.id} <> ${t.parentSaveId}`),
  ],
);

/**
 * GLOBAL — no `save_id`. One canonical tag list shared across every save: rename once
 * and every save sees the new name, which is what keeps `byTag` membership rules stable
 * across forks. A per-save tag vocabulary is explicitly out of scope for v1 (§2.1).
 */
export const tag = sqliteTable(
  'tag',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    color: text('color').notNull(),
    description: text('description'),
    /**
     * Soft delete. A tag still referenced by any `event_tag` row cannot be hard-deleted —
     * `DELETE /api/tags/:id` refuses and offers this instead, which hides the tag from
     * the picker without breaking existing assignments or membership rules. The rule has
     * nowhere else to live.
     */
    isRetired: integer('is_retired', { mode: 'boolean' }).notNull().default(false),
  },
  // The tag vocabulary is global and is what `byTag` membership rules are written
  // against, so two tags named "Fusion" are two different rules that read as one.
  (t) => [unique('tag_name_unique').on(t.name)],
);

/**
 * Joins global tags to per-save events. Tag definitions are not per-save, but the
 * ASSIGNMENTS still scope correctly because events are — and `save_id` is here so the
 * composite FK can prove it (see the cross-save note in the header).
 */
export const eventTag = sqliteTable(
  'event_tag',
  {
    saveId: text('save_id')
      .notNull()
      .references(() => save.id),
    eventId: text('event_id').notNull(),
    tagId: text('tag_id')
      .notNull()
      .references(() => tag.id),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.tagId] }),
    foreignKey({ columns: [t.saveId, t.eventId], foreignColumns: [event.saveId, event.id] }),
  ],
);

/**
 * A saved export manifest: a named sequence of `(view, scope)` pairs (§8.6). Per-save
 * and AUTHORED, so it is copied on fork like any other thing a person wrote — and its
 * `items_json` is on the fork's json-walk list, because a resolved snapshot freezes
 * per-save ids inside the JSON (§2.6).
 */
export const manifest = sqliteTable(
  'manifest',
  {
    id: text('id').primaryKey(),
    saveId: text('save_id')
      .notNull()
      .references(() => save.id),
    title: text('title').notNull(),
    itemsJson: text('items_json', { mode: 'json' }).$type<ManifestItem[]>().notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    check('manifest_items_json_check', jsonOf(t.itemsJson, 'array')),
    check('manifest_created_at_format_check', isoInstant(t.createdAt)),
    check('manifest_updated_at_format_check', isoInstant(t.updatedAt)),
  ],
);

/* ================================================================== *
 * REGISTRY (per-save) — architecture §2.2
 * ================================================================== */

/**
 * Lifespan has ONE authority, not two. When the character has a linked birth or death
 * event (`event_actor.role = 'born' | 'died'`) that event is authoritative and
 * `lifespan_*` is a persisted derived cache of its rolled `when`, refreshed whenever
 * the event is written or re-rolled. For characters with no such event — most of the
 * cast — the column is authored directly and is the only record. Family Trees always
 * reads the column, so a card never costs an extra query (§2.2).
 *
 * `lifespan_*_precision` is what the card actually renders by: `Presumed Dead (2072)`
 * is year precision and must print as "2072", never as the Jan-1 instant stored beside
 * it (see the precision note in the header).
 */
export const character = sqliteTable(
  'character',
  {
    id: text('id').primaryKey(),
    saveId: text('save_id')
      .notNull()
      .references(() => save.id),
    name: text('name').notNull(),
    lifespanStart: text('lifespan_start'),
    lifespanStartPrecision: text('lifespan_start_precision', { enum: WHEN_PRECISIONS }),
    lifespanEnd: text('lifespan_end'),
    lifespanEndPrecision: text('lifespan_end_precision', { enum: WHEN_PRECISIONS }),
    role: text('role').notNull(),
    bio: text('bio'),
    portraitPath: text('portrait_path'),
  },
  (t) => [
    unique('character_save_id_id_unique').on(t.saveId, t.id),
    check('character_name_non_empty_check', nonEmpty(t.name)),
    check('character_lifespan_start_format_check', isoInstant(t.lifespanStart)),
    check('character_lifespan_end_format_check', isoInstant(t.lifespanEnd)),
    check('character_lifespan_order_check', sql`${t.lifespanEnd} >= ${t.lifespanStart}`),
    check(
      'character_lifespan_start_precision_check',
      oneOf(t.lifespanStartPrecision, WHEN_PRECISIONS),
    ),
    check('character_lifespan_end_precision_check', oneOf(t.lifespanEndPrecision, WHEN_PRECISIONS)),
    check(
      'character_lifespan_start_pair_check',
      pairedNull(t.lifespanStart, t.lifespanStartPrecision),
    ),
    check('character_lifespan_end_pair_check', pairedNull(t.lifespanEnd, t.lifespanEndPrecision)),
  ],
);

/**
 * A place. Renames are an IDENTITY CHAIN, not separate places: each stage stays its own
 * row so events located there keep their historically correct name, and every view
 * resolves a location to the canonical head of its chain before answering "what
 * happened here" (§2.2). Cycles are checked at write time, which a self-FK alone cannot
 * express.
 *
 * `superseded_by_location_id` is deliberately NOT unique. Canon has two chains
 * converging on one head — COPI → FOB Oasis → Camp Oasis and Disaster Ridge → Oasis
 * City — and two rows superseded by the same successor is a legitimate MERGE, not a
 * defect. Anything asserting "strictly linear, one successor, no merges" is describing
 * a rule the canon breaks.
 *
 * THE MAP REFERENCE IS TWO REAL FOREIGN KEYS, NOT A POLYMORPHIC PAIR. It used to be a
 * `(map_ref_kind, map_ref_value)` TEXT pair, which the database could not check at all:
 * a dangling id, an id of the wrong kind, and an id belonging to another save were all
 * accepted, and deleting the target left the location pointing at nothing. `country_id`
 * is global and copied verbatim on fork; `grouping_id` is per-save and REMAPPED — which
 * also splits the fork manifest's one `conditional` line into two ordinary ones. The
 * old `MapRefKind` is now DERIVED from which column is populated, never stored.
 */
export const location = sqliteTable(
  'location',
  {
    id: text('id').primaryKey(),
    saveId: text('save_id')
      .notNull()
      .references(() => save.id),
    name: text('name').notNull(),
    description: text('description'),
    lat: real('lat'),
    lng: real('lng'),
    /** GLOBAL target — copied verbatim on fork (§2.6). */
    countryId: text('country_id').references(() => country.id),
    /** PER-SAVE target — remapped on fork; the composite FK below pins the save. */
    groupingId: text('grouping_id'),
    /** COPI → FOB Oasis → Camp Oasis → Oasis City → Star City. */
    supersededByLocationId: text('superseded_by_location_id'),
  },
  (t) => [
    unique('location_save_id_id_unique').on(t.saveId, t.id),
    foreignKey({
      columns: [t.saveId, t.groupingId],
      foreignColumns: [grouping.saveId, grouping.id],
    }),
    foreignKey({
      columns: [t.saveId, t.supersededByLocationId],
      foreignColumns: [t.saveId, t.id],
    }),
    // A location sits in a country OR inside a unified nation, never both: the two would
    // be redundant at best (the grouping owns the country) and contradictory at worst.
    check('location_map_ref_check', sql`${t.countryId} is null or ${t.groupingId} is null`),
    // A one-row cycle — the chain's head superseding itself — makes the "resolve to the
    // canonical head" walk non-terminating.
    check('location_not_self_superseded_check', sql`${t.id} <> ${t.supersededByLocationId}`),
  ],
);

/**
 * A programme. Anything with DURATION is a project or a timeline — never an event
 * (§2.3): "HV V1–V3, '54–'70" is a project whose milestones are the events.
 */
export const project = sqliteTable(
  'project',
  {
    id: text('id').primaryKey(),
    saveId: text('save_id')
      .notNull()
      .references(() => save.id),
    name: text('name').notNull(),
    description: text('description').notNull(),
    dateStart: text('date_start'),
    dateStartPrecision: text('date_start_precision', { enum: WHEN_PRECISIONS }),
    dateEnd: text('date_end'),
    dateEndPrecision: text('date_end_precision', { enum: WHEN_PRECISIONS }),
    status: text('status', { enum: PROJECT_STATUSES }).notNull(),
    leadCharacterId: text('lead_character_id'),
  },
  (t) => [
    unique('project_save_id_id_unique').on(t.saveId, t.id),
    foreignKey({
      columns: [t.saveId, t.leadCharacterId],
      foreignColumns: [character.saveId, character.id],
    }),
    check('project_status_check', oneOf(t.status, PROJECT_STATUSES)),
    check('project_date_start_format_check', isoInstant(t.dateStart)),
    check('project_date_end_format_check', isoInstant(t.dateEnd)),
    check('project_date_order_check', sql`${t.dateEnd} >= ${t.dateStart}`),
    check('project_date_start_precision_check', oneOf(t.dateStartPrecision, WHEN_PRECISIONS)),
    check('project_date_end_precision_check', oneOf(t.dateEndPrecision, WHEN_PRECISIONS)),
    check('project_date_start_pair_check', pairedNull(t.dateStart, t.dateStartPrecision)),
    check('project_date_end_pair_check', pairedNull(t.dateEnd, t.dateEndPrecision)),
  ],
);

/**
 * An explicit character-to-character edge, stored ONCE. Directional types (`parent-of`,
 * `clone-of`) read from→to literally; symmetric types (`spouse-of`, `sibling-of`) are
 * stored with the lower id as `from` and rendered undirected — no mirror row, no drift.
 *
 * Sibling edges are normally DERIVED: two characters with a common `parent-of` parent
 * are siblings by construction. A stored `sibling-of` row exists only for siblings whose
 * parents are not modelled at all — never both, or the same fact is asserted twice.
 */
export const characterRelation = sqliteTable(
  'character_relation',
  {
    id: text('id').primaryKey(),
    saveId: text('save_id')
      .notNull()
      .references(() => save.id),
    fromCharacterId: text('from_character_id').notNull(),
    toCharacterId: text('to_character_id').notNull(),
    type: text('type', { enum: CHARACTER_RELATION_TYPES }).notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.saveId, t.fromCharacterId],
      foreignColumns: [character.saveId, character.id],
    }),
    foreignKey({
      columns: [t.saveId, t.toCharacterId],
      foreignColumns: [character.saveId, character.id],
    }),
    // "Stored ONCE" is only true if the database says so; without this the editor can
    // assert the same marriage twice and Family Trees draws two edges.
    unique('character_relation_edge_unique').on(
      t.saveId,
      t.fromCharacterId,
      t.toCharacterId,
      t.type,
    ),
    check('character_relation_type_check', oneOf(t.type, CHARACTER_RELATION_TYPES)),
    // Nobody is their own parent, sibling, spouse or clone. This is NOT implied by the
    // canonical-order CHECK below: for a DIRECTIONAL type that check's first disjunct is
    // already true, so `from = to` sailed through on `parent-of` and `clone-of`.
    check('character_relation_not_self_check', sql`${t.fromCharacterId} <> ${t.toCharacterId}`),
    // The canonical ordering, enforced rather than merely documented. A fork
    // regenerates every id, so a symmetric pair that satisfied this in the parent very
    // often violates it in the child — which is why the fork re-canonicalizes symmetric
    // rows after remapping, or this constraint aborts the whole fork transaction (§2.6).
    check(
      'character_relation_canonical_order_check',
      sql`${noneOf(t.type, SYMMETRIC_CHARACTER_RELATION_TYPES)} or ${t.fromCharacterId} < ${t.toCharacterId}`,
    ),
  ],
);

/* ================================================================== *
 * TIMELINE (per-save) — architecture §2.3
 * ================================================================== */

/**
 * The world timeline atom, and a POINT in time. Anything with duration lives elsewhere
 * — that hard rule is what keeps `when_min`/`when_max` meaning "we are unsure when"
 * rather than the overloaded "it lasted this long".
 *
 * THE DATE QUAD (§2.3), the most load-bearing thing in this file:
 *   · `when_min` / `when_max` / `when_precision` are the PRIMARY representation. The
 *     author enters a precision plus a value and the pair is derived from it — year
 *     `2036` becomes `[2036-01-01T00:01Z, 2036-12-31T23:59Z]`, `Late 2035` a Q4 window,
 *     a timestamped event a one-minute window. Roughly 46% of the source corpus is
 *     coarser than day precision, so this is the common case, not the exception.
 *   · `when` is a PERSISTED derived roll inside that window — `rollDate()`, seeded on
 *     the event id — and is NOT recomputed on read. It is what every layout, sort and
 *     camera target uses, and persisting it is what makes node positions stable across
 *     reloads and across a shared URL. It changes only on an explicit re-roll.
 *   · Views render by PRECISION, never by the roll: a year-precision event displays
 *     "2036". Printing the roll would fabricate a datetime the Bible does not contain.
 *   · `range_before_event_id` / `range_after_event_id` NARROW the window; they never
 *     SOURCE it. Their own `when` is itself a roll, so sourcing from them would make
 *     one guess the foundation of another. Every event has a real window of its own.
 *
 * All three datetimes are compared as TEXT, by `event_when_in_window_check` here and by
 * `byTimeRange` at read time, which is why the canonical-format CHECK is not cosmetic:
 * a window written `…T00:00:00Z` and a roll written `…T00:00:00.000Z` are the same
 * instant that this table would reject.
 */
export const event = sqliteTable(
  'event',
  {
    id: text('id').primaryKey(),
    saveId: text('save_id')
      .notNull()
      .references(() => save.id),
    title: text('title').notNull(),
    description: text('description').notNull(),
    whenMin: text('when_min').notNull(),
    whenMax: text('when_max').notNull(),
    whenPrecision: text('when_precision', { enum: WHEN_PRECISIONS }).notNull(),
    /** `when` is a SQL keyword; the SQLite dialect quotes every identifier, so it is safe. */
    when: text('when').notNull(),
    rangeBeforeEventId: text('range_before_event_id'),
    rangeAfterEventId: text('range_after_event_id'),
    category: text('category', { enum: CATEGORIES }).notNull(),
    techLane: text('tech_lane', { enum: TECH_LANES }),
    locationId: text('location_id'),
    projectId: text('project_id'),
  },
  (t) => [
    unique('event_save_id_id_unique').on(t.saveId, t.id),
    foreignKey({
      columns: [t.saveId, t.rangeBeforeEventId],
      foreignColumns: [t.saveId, t.id],
    }),
    foreignKey({
      columns: [t.saveId, t.rangeAfterEventId],
      foreignColumns: [t.saveId, t.id],
    }),
    foreignKey({
      columns: [t.saveId, t.locationId],
      foreignColumns: [location.saveId, location.id],
    }),
    foreignKey({
      columns: [t.saveId, t.projectId],
      foreignColumns: [project.saveId, project.id],
    }),
    check('event_when_min_format_check', isoInstant(t.whenMin)),
    check('event_when_max_format_check', isoInstant(t.whenMax)),
    check('event_when_format_check', isoInstant(t.when)),
    check('event_when_order_check', sql`${t.whenMax} >= ${t.whenMin}`),
    // The roll is inside its own window by construction; the constraint is what keeps a
    // hand-edited or half-migrated row from quietly laying out somewhere impossible.
    check('event_when_in_window_check', sql`${t.when} between ${t.whenMin} and ${t.whenMax}`),
    check('event_when_precision_check', oneOf(t.whenPrecision, WHEN_PRECISIONS)),
    check('event_category_check', oneOf(t.category, CATEGORIES)),
    check('event_tech_lane_check', oneOf(t.techLane, TECH_LANES)),
    // "only when category = tech" (§2.5) — a lane on a non-tech event would be read by
    // nothing and would misfile the event in the Tech Tree's lane grouping.
    check(
      'event_tech_lane_requires_tech_check',
      sql`${t.techLane} is null or ${t.category} = 'tech'`,
    ),
    // An event cannot narrow its own window: `when between when_min and when_max` would
    // be the only thing left saying anything, and the narrowing pass would loop.
    check('event_not_self_range_before_check', sql`${t.id} <> ${t.rangeBeforeEventId}`),
    check('event_not_self_range_after_check', sql`${t.id} <> ${t.rangeAfterEventId}`),
  ],
);

/**
 * An era / thread / cluster (§2.3):
 *   · `era`     a bounded span of world history (Pre-Big One, Black Fever Era) — must
 *               carry `era_start`; `era_end` is OPTIONAL.
 *   · `thread`  an open-ended through-line that need not be contiguous (the Castañeda
 *               family, the fusion lineage).
 *   · `cluster` a tight local grouping (the Etna disaster and its aftermath).
 *
 * AN ERA MAY BE OPEN-ENDED. Canon needs it: the Reconstruction Era "beginning around
 * 2047" has no stated end, and requiring one would force the seed to invent a date and
 * the era slabs (P7.2) to draw a boundary the Bible does not contain. So only
 * `era_start` is required — a NULL `era_end` means "still running", and the slab
 * renderer extends to the end of the visible range rather than reading a fabricated
 * bound.
 *
 * THE DAG ROOT IS STRUCTURAL, NOT A KIND. A save's root timeline (`tl_world`) is simply
 * the timeline with no row in `timeline_parent`. It carries `kind = 'thread'` for schema
 * simplicity — a fourth enum member would exist for exactly one row per save. Nothing
 * may infer "this is the root" from the kind; anything needing the root queries for the
 * parentless timeline.
 */
export const timeline = sqliteTable(
  'timeline',
  {
    id: text('id').primaryKey(),
    saveId: text('save_id')
      .notNull()
      .references(() => save.id),
    name: text('name').notNull(),
    kind: text('kind', { enum: TIMELINE_KINDS }).notNull(),
    description: text('description'),
    /** Predicate semantics — and the AND-across-kinds / OR-within-kind rule — in §2.6. */
    membershipRules: text('membership_rules', { mode: 'json' }).$type<MembershipRules>(),
    color: text('color'),
    eraStart: text('era_start'),
    eraStartPrecision: text('era_start_precision', { enum: WHEN_PRECISIONS }),
    eraEnd: text('era_end'),
    eraEndPrecision: text('era_end_precision', { enum: WHEN_PRECISIONS }),
    /**
     * What a PROJECT-LINKED THREAD hangs on: the thread's bar takes its extent from the
     * linked project's `date_start`/`date_end` rather than from its members (§5.2).
     * Per-save → per-save, so it is on the fork remap manifest (§2.6).
     */
    projectId: text('project_id'),
  },
  (t) => [
    unique('timeline_save_id_id_unique').on(t.saveId, t.id),
    foreignKey({
      columns: [t.saveId, t.projectId],
      foreignColumns: [project.saveId, project.id],
    }),
    check('timeline_kind_check', oneOf(t.kind, TIMELINE_KINDS)),
    // A START is required when kind = 'era' (§2.5): the era slabs (P7.2) read it
    // directly, and an era without one renders as nothing at all. The END is not — see
    // the open-ended note above.
    check('timeline_era_bounds_check', sql`${t.kind} <> 'era' or ${t.eraStart} is not null`),
    check('timeline_era_start_format_check', isoInstant(t.eraStart)),
    check('timeline_era_end_format_check', isoInstant(t.eraEnd)),
    check('timeline_era_order_check', sql`${t.eraEnd} >= ${t.eraStart}`),
    check('timeline_era_start_precision_check', oneOf(t.eraStartPrecision, WHEN_PRECISIONS)),
    check('timeline_era_end_precision_check', oneOf(t.eraEndPrecision, WHEN_PRECISIONS)),
    check('timeline_era_start_pair_check', pairedNull(t.eraStart, t.eraStartPrecision)),
    check('timeline_era_end_pair_check', pairedNull(t.eraEnd, t.eraEndPrecision)),
    // Drizzle parses this column on every read of the table, so one malformed row makes
    // `select().from(timeline).all()` throw for every row, not just the bad one.
    check('timeline_membership_rules_json_check', jsonOf(t.membershipRules, 'object')),
  ],
);

/** One DAG edge. A timeline may have several parents; cycles are rejected at write time. */
export const timelineParent = sqliteTable(
  'timeline_parent',
  {
    saveId: text('save_id')
      .notNull()
      .references(() => save.id),
    timelineId: text('timeline_id').notNull(),
    parentId: text('parent_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.timelineId, t.parentId] }),
    foreignKey({
      columns: [t.saveId, t.timelineId],
      foreignColumns: [timeline.saveId, timeline.id],
    }),
    foreignKey({
      columns: [t.saveId, t.parentId],
      foreignColumns: [timeline.saveId, timeline.id],
    }),
    // The shortest possible cycle, and the one the write-time cycle check is most likely
    // to be asked to swallow as "harmless".
    check('timeline_parent_not_self_check', sql`${t.timelineId} <> ${t.parentId}`),
  ],
);

/**
 * The manual roster half of membership; `timeline.membership_rules` is the computed
 * half. A timeline with no rules is a pure roster, one with rules and no rows here is
 * purely computed, and most real ones are both (§2.6).
 */
export const timelineMember = sqliteTable(
  'timeline_member',
  {
    saveId: text('save_id')
      .notNull()
      .references(() => save.id),
    timelineId: text('timeline_id').notNull(),
    eventId: text('event_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.timelineId, t.eventId] }),
    foreignKey({
      columns: [t.saveId, t.timelineId],
      foreignColumns: [timeline.saveId, timeline.id],
    }),
    foreignKey({ columns: [t.saveId, t.eventId], foreignColumns: [event.saveId, event.id] }),
  ],
);

/**
 * The event ↔ event graph, powering the Tech Tree's edges directly. Stored once with a
 * canonical direction: `precedes` from=A to=B means "A precedes B" / "B succeeds A",
 * and reverse views ("what succeeds X?") are derived at query time against the same row
 * — no mirror records, no consistency hazard (§2.6).
 *
 * `precedes` additionally requires `A.when < B.when`, checked at WRITE time (a CHECK
 * cannot see another row): the API rejects the write, and rejects a re-roll that would
 * violate an existing edge, naming it. Without that the Tech Tree can draw an arrow
 * pointing backwards in time.
 */
export const relation = sqliteTable(
  'relation',
  {
    id: text('id').primaryKey(),
    saveId: text('save_id')
      .notNull()
      .references(() => save.id),
    fromEventId: text('from_event_id').notNull(),
    toEventId: text('to_event_id').notNull(),
    type: text('type', { enum: RELATION_TYPES }).notNull(),
    /** Free text about the EDGE itself — why A precedes B — which has nowhere else to live. */
    note: text('note'),
  },
  (t) => [
    foreignKey({ columns: [t.saveId, t.fromEventId], foreignColumns: [event.saveId, event.id] }),
    foreignKey({ columns: [t.saveId, t.toEventId], foreignColumns: [event.saveId, event.id] }),
    // "Stored once" enforced: a duplicate edge draws a duplicate arrow in the Tech Tree
    // and double-counts in any degree calculation.
    unique('relation_edge_unique').on(t.saveId, t.fromEventId, t.toEventId, t.type),
    check('relation_type_check', oneOf(t.type, RELATION_TYPES)),
    // `precedes` to itself asserts `A.when < A.when`; `renames`/`partOf` to itself is a
    // one-node cycle in a graph every view walks.
    check('relation_not_self_check', sql`${t.fromEventId} <> ${t.toEventId}`),
  ],
);

/**
 * Many-to-many event ↔ character. `role` is free text ("crew", "designer", "victim",
 * "leader", …) and is part of the key, so one person can hold two roles in one event —
 * the leader who is also a victim. The reserved roles `born` / `died` are what link a
 * character to the events defining their lifespan (§2.2).
 *
 * ROLE IS NORMALIZED BY CONSTRAINT, not by convention. `role` is in the PRIMARY KEY, so
 * `'born'`, `'Born'` and `'born '` would be three distinct keys — three rows claiming to
 * be the same fact, and only one of them found by the lifespan lookup, which searches
 * for the literal `'born'`. The CHECK requires the stored value to equal
 * `lower(trim(role))`, which makes the key case- and whitespace-canonical without a
 * COLLATE that would also have to be remembered at every read site.
 *
 * Drives cross-view glow ("which characters appear in this event"); Family Trees does
 * NOT render co-occurrence edges off it.
 */
export const eventActor = sqliteTable(
  'event_actor',
  {
    saveId: text('save_id')
      .notNull()
      .references(() => save.id),
    eventId: text('event_id').notNull(),
    characterId: text('character_id').notNull(),
    role: text('role').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.characterId, t.role] }),
    foreignKey({ columns: [t.saveId, t.eventId], foreignColumns: [event.saveId, event.id] }),
    foreignKey({
      columns: [t.saveId, t.characterId],
      foreignColumns: [character.saveId, character.id],
    }),
    // ONE authority for a lifespan bound (§2.2): a character may be `born` in at most one
    // event and `died` in at most one. Partial, because every other role is free text and
    // repeats legitimately — one person is `crew` on a dozen events.
    uniqueIndex('event_actor_lifespan_role_unique')
      .on(t.saveId, t.characterId, t.role)
      .where(sql`${t.role} in (${members(LIFESPAN_ROLES)})`),
    check(
      'event_actor_role_normalized_check',
      sql`${t.role} <> '' and ${t.role} = lower(trim(${t.role}))`,
    ),
  ],
);

/* ================================================================== *
 * MAP — architecture §2.4. Country key = TEXT, total over the author's own data (§3.1)
 * ================================================================== */

/**
 * GLOBAL, real-world — never per-save.
 *
 * `id` is TEXT and must be TOTAL over the author's own data: a zero-padded 3-character
 * ISO 3166-1 numeric code where one exists (`"004"`, `"250"`), and a namespaced
 * synthetic code where one does not — `"x:<alpha-3 when one exists, else a kebab slug
 * of the name>"`: `x:GUF`, `x:XKX`, `x:SOL`, `x:ashmore-cartier`. One convention, so the
 * seed and the client mint the same string.
 *
 * NEVER an INTEGER: `4 !== "004"`. And a pure-ISO-numeric key cannot represent the live
 * members of the existing map saves at all — `data/iso-numeric-to-alpha3.json` contains
 * `"GUF": "GUF"` and `"undefined": "SOL"`, world-atlas bundles French Guiana inside
 * France's 250, and Natural Earth gives Kosovo / N. Cyprus / Somaliland the id -99.
 */
export const country = sqliteTable(
  'country',
  {
    id: text('id').primaryKey(),
    /** Null for synthetic rows — which is exactly why it can never be a key component. */
    isoNumeric: text('iso_numeric', { length: 3 }),
    /** Display/debug only. Not a key. */
    alpha3: text('alpha3', { length: 3 }),
    /**
     * The default real-world name. For a `geometry_source = 'feature'` row it is the
     * topojson feature's `properties.name`. For a `'derived'` row it is NOT the parent
     * feature's name — feature 250 is "France" and `x:GUF` is not France — so
     * `deriveFeatures.ts` supplies it explicitly (§3.1).
     */
    name: text('name').notNull(),
    geometrySource: text('geometry_source', { enum: GEOMETRY_SOURCES }).notNull(),
  },
  (t) => [check('country_geometry_source_check', oneOf(t.geometrySource, GEOMETRY_SOURCES))],
);

/**
 * Per-save rename of a country — `"840"` → "United Earth America". Keyed on
 * `country_id`, NOT `iso_numeric`: that column is nullable for synthetic rows and so can
 * never be part of a primary key. `country_id` points into a global table, so a fork
 * copies it VERBATIM (§2.6).
 */
export const countryOverride = sqliteTable(
  'country_override',
  {
    saveId: text('save_id')
      .notNull()
      .references(() => save.id),
    countryId: text('country_id')
      .notNull()
      .references(() => country.id),
    name: text('name').notNull(),
  },
  (t) => [primaryKey({ columns: [t.saveId, t.countryId] })],
);

/** A per-save unified nation. Name and color only — membership lives in the join below. */
export const grouping = sqliteTable(
  'grouping',
  {
    id: text('id').primaryKey(),
    saveId: text('save_id')
      .notNull()
      .references(() => save.id),
    name: text('name').notNull(),
    color: text('color').notNull(),
  },
  (t) => [
    unique('grouping_save_id_id_unique').on(t.saveId, t.id),
    // The map seed UPSERTS groupings by name, so two rows named 'UEA' in one save are
    // two half-populated nations that the importer believes are one.
    unique('grouping_save_id_name_unique').on(t.saveId, t.name),
  ],
);

/**
 * Per-save membership of countries in unified nations.
 *
 * PRIMARY KEY (save_id, country_id) IS THE INVARIANT: a country belongs to AT MOST ONE
 * unified nation per save. Verified against the existing data — all 237 codes across the
 * 103 groups in `data/map_saves/lifestream_map_v1.json` appear in exactly one group,
 * zero duplicates — and it is an invariant a jsonb `country_ids` array cannot express
 * and the database could not enforce. Clicking a country another grouping already owns
 * is therefore no longer a silent no-op: the editor prompts "Move from <X>?" and the
 * server enforces the same rule here regardless of what the client does (§2.4).
 *
 * An "independent nation" is a country with NO row here. There is nothing to seed for
 * it — the 74 "independent" groups in the old exported JSON are a projection of
 * `country`, synthesized at export time, and importing them would turn a derived fact
 * into 74 rows that can drift.
 *
 * `is_leader` MARKS THE UNION'S LEADING COUNTRY, and the row IS the membership, so
 * membership needs no separate check. Canon marks a leader on ten of the unions —
 * `Panama (Leader)`, `Colombia (Leader)`, `Argentina (Leader)`, `Turkey (Leader)`,
 * `Pakistan (Leader)`, `India (Leader)`, `Vietnam (Leader)`, `China (Leader)`,
 * `North & South Korea (Leader)`, `Indonesia (Leader)` — and the old map export has no
 * leader field at all (0 of 103 groups), so the Bible is the only source there is: with
 * no column the seed drops the fact silently. At most one leader per grouping, enforced
 * by the partial unique index below.
 *
 * On fork: `grouping_id` is remapped, `country_id` is copied verbatim (it is global),
 * `is_leader` is copied verbatim.
 */
export const groupingCountry = sqliteTable(
  'grouping_country',
  {
    saveId: text('save_id')
      .notNull()
      .references(() => save.id),
    groupingId: text('grouping_id').notNull(),
    countryId: text('country_id')
      .notNull()
      .references(() => country.id),
    isLeader: integer('is_leader', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.saveId, t.countryId] }),
    foreignKey({
      columns: [t.saveId, t.groupingId],
      foreignColumns: [grouping.saveId, grouping.id],
    }),
    // Partial: many members per grouping, at most ONE leader. A plain unique on
    // (save_id, grouping_id) would allow only one member.
    uniqueIndex('grouping_country_leader_unique')
      .on(t.saveId, t.groupingId)
      .where(sql`${t.isLeader} = 1`),
  ],
);

/* ================================================================== *
 * SIMULATION — architecture §3. Schema only; see the deferral note in the header.
 * ================================================================== */

/**
 * The run ledger (§3.5): one row per simulation run. GLOBAL, with a nullable `save_id`
 * for the save-scoped stages, and NOT remapped on fork (§7.1). Every simulation output
 * carries its `run_id`, so runs are individually versioned and comparable.
 *
 * `stage` and `status` are deliberately OPEN text, not closed enums: the stage list and
 * the run lifecycle belong to the deferred harness, and pinning either here would be
 * buying a reversible decision inside the irreversible artifact.
 */
export const simRun = sqliteTable(
  'sim_run',
  {
    id: text('id').primaryKey(),
    stage: text('stage').notNull(),
    saveId: text('save_id').references(() => save.id),
    paramsJson: text('params_json', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    /** The upstream runs this one consumed — the provenance edge between stages. */
    inputRunIdsJson: text('input_run_ids_json', { mode: 'json' }).$type<string[]>().notNull(),
    status: text('status').notNull(),
    startedAt: text('started_at').notNull(),
    // Nullable: a run has a `started_at` and a `status` before it has an end. The docs mark
    // only `save_id` optional, but NOT NULL here makes an in-flight run unrepresentable,
    // which contradicts the `status` column sitting beside it.
    finishedAt: text('finished_at'),
  },
  (t) => [
    // "Same params ⇒ same output" is a claim about this column; a row whose params are
    // the string `'not json'` cannot be compared to anything.
    check('sim_run_params_json_check', jsonOf(t.paramsJson, 'object')),
    check('sim_run_input_run_ids_json_check', jsonOf(t.inputRunIdsJson, 'array')),
    check('sim_run_started_at_format_check', isoInstant(t.startedAt)),
    check('sim_run_finished_at_format_check', isoInstant(t.finishedAt)),
  ],
);

/**
 * The per-country projection cache (§3.1) and the chain's hand-off table. GLOBAL and
 * save-independent, because it is computed over real-world countries rather than over
 * your groupings — a third fork treatment, neither copied nor remapped (§7.1).
 */
export const countryProjection = sqliteTable(
  'country_projection',
  {
    runId: text('run_id')
      .notNull()
      .references(() => simRun.id),
    countryId: text('country_id')
      .notNull()
      .references(() => country.id),
    year: integer('year').notNull(),
    pop: real('pop').notNull(),
    gdpReal: real('gdp_real').notNull(),
    gdpPc: real('gdp_pc').notNull(),
    sectorMixJson: text('sector_mix_json', { mode: 'json' }).$type<SectorMix>().notNull(),
    computedAt: text('computed_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.countryId, t.year] }),
    check('country_projection_computed_at_format_check', isoInstant(t.computedAt)),
    // Same failure mode as every other json column: Drizzle parses eagerly, so ONE
    // malformed row makes a whole-table select throw rather than returning a bad row.
    check('country_projection_sector_mix_json_check', jsonOf(t.sectorMixJson, 'object')),
  ],
);

/**
 * GLOBAL raw-fetch cache: one row per `(source, country_id, indicator, year, vintage)`
 * straight from WPP / WDI / WEO. Without it, "same params ⇒ same output" is false the
 * moment the UN or the World Bank republishes a series — the run ledger would record
 * identical params against silently different inputs (§2.4).
 */
export const sourceSeries = sqliteTable(
  'source_series',
  {
    source: text('source').notNull(),
    countryId: text('country_id')
      .notNull()
      .references(() => country.id),
    indicator: text('indicator').notNull(),
    year: integer('year').notNull(),
    value: real('value').notNull(),
    fetchedAt: text('fetched_at').notNull(),
    /** Which publication of the series this row came from — part of the key, not metadata. */
    vintage: text('vintage').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.source, t.countryId, t.indicator, t.year, t.vintage] }),
    check('source_series_fetched_at_format_check', isoInstant(t.fetchedAt)),
  ],
);

/**
 * Output of the combine step (§3.3): the projected member-country metrics summed over a
 * grouping's `grouping_country` rows. Per-save and DERIVED — never copied on fork, and
 * recomputed in the child, which is what stops a fork from producing rows that point at
 * a `sim_run` belonging to the parent (§7.1).
 *
 * `grouping_id` is right here and was never in question: the combine stage is defined
 * over groupings either way.
 */
export const groupingMetrics = sqliteTable(
  'grouping_metrics',
  {
    saveId: text('save_id')
      .notNull()
      .references(() => save.id),
    runId: text('run_id')
      .notNull()
      .references(() => simRun.id),
    groupingId: text('grouping_id').notNull(),
    pop: real('pop').notNull(),
    gdpReal: real('gdp_real').notNull(),
    gdpPc: real('gdp_pc').notNull(),
    sectorMixJson: text('sector_mix_json', { mode: 'json' }).$type<SectorMix>().notNull(),
    computedAt: text('computed_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.saveId, t.runId, t.groupingId] }),
    check('grouping_metrics_sector_mix_json_check', jsonOf(t.sectorMixJson, 'object')),
    foreignKey({
      columns: [t.saveId, t.groupingId],
      foreignColumns: [grouping.saveId, grouping.id],
    }),
    check('grouping_metrics_computed_at_format_check', isoInstant(t.computedAt)),
  ],
);

/**
 * Output of the Megacorp classifier (§3.4) — per-save, per-run industry horizontal +
 * score per COUNTRY.
 *
 * THE KEY IS `(save_id, run_id, country_id)` AND THE COUNTRY HALF IS DELIBERATE.
 * `grouping_id` would answer the open H-Mega attachment question (OQ10) inside
 * migration #1, by asserting that a horizontal attaches to a MERGED NATION. The country
 * is the finer grain, so both readings survive: a grouping's horizontals are a rollup
 * over its `grouping_country` members, while the decomposition in the other direction
 * is unrecoverable. The canon question stays open and still gates the classifier's
 * logic — which unit the tier allotment counts against — but no longer gates the schema
 * (§3.7, 2026-09-02). The World Map reads this as a color overlay, rolling up to the
 * grouping when it is drawing unified nations.
 *
 * `horizontal` is open TEXT: canon fixes HOW MANY megacorps a nation gets, never WHICH
 * industries exist — the taxonomy is emergent from the clustering (§3.4).
 *
 * `horizontal` IS IN THE PRIMARY KEY, and that is load-bearing. Canon gives a Tier 1
 * nation up to a dozen megacorps and a Tier 2 nation two to five, each holding a
 * monopoly over a different sector (Bible L234-236) — so a country has MANY
 * horizontals, not one. Keying on (save_id, run_id, country_id) alone would have made
 * the tier allotment, the most canon-anchored fact in the stage, unstorable. This is
 * orthogonal to OQ10 (country-vs-grouping grain), strictly more permissive, and costs
 * nothing if a classifier only ever writes one row.
 */
export const nationHorizontal = sqliteTable(
  'nation_horizontal',
  {
    saveId: text('save_id')
      .notNull()
      .references(() => save.id),
    runId: text('run_id')
      .notNull()
      .references(() => simRun.id),
    countryId: text('country_id')
      .notNull()
      .references(() => country.id),
    horizontal: text('horizontal').notNull(),
    score: real('score').notNull(),
    computedAt: text('computed_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.saveId, t.runId, t.countryId, t.horizontal] }),
    check('nation_horizontal_computed_at_format_check', isoInstant(t.computedAt)),
  ],
);

/**
 * Output of the Black Fever spread simulation (§3.2) — a DELIBERATE STUB. Only the key
 * shape `(run_id, country_id, t)` is fixed here; the state representation, and whether
 * this table carries a `save_id` at all, wait on OQ8 (§3.6). The row exists in the
 * schema so nothing downstream has to invent a name for it later.
 *
 * It is on neither the in-save nor the shared fork list, deliberately: with no `save_id`
 * it cannot be in-save, and filing it under either would pre-commit the open decision.
 * Whichever way OQ8 lands it is pipeline output and is never copied on fork (§7.1).
 */
export const bfSpread = sqliteTable(
  'bf_spread',
  {
    runId: text('run_id')
      .notNull()
      .references(() => simRun.id),
    countryId: text('country_id')
      .notNull()
      .references(() => country.id),
    /** Simulation timestep index. Its meaning is the sim's to define (OQ8). */
    t: integer('t').notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.countryId, t.t] })],
);
