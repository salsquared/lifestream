/**
 * The closed enums of the schema, plus the one datetime alias.
 *
 * Every union here is CLOSED (implementation.html, the closed-enums decision): the
 * database enforces the same member list as a `CHECK` constraint, so a typo is a write
 * error rather than a silently empty view. The member lists are declared for SQL in
 * `server/src/db/schema.ts` and mirrored here for the wire; `server/src/db/conformance.ts`
 * fails to compile if the two ever drift.
 *
 * Names and casing match `client/src/shell/stores/types.ts` exactly, so that file can
 * become a re-export of this one rather than a second declaration (P1.6.2).
 */

/**
 * All datetimes are TEXT, ISO-8601, UTC, with the `Z` suffix (architecture §2.1). There
 * is exactly one timezone in this system and it is UTC.
 *
 * ONE SPELLING IS CANONICAL: whatever `Date#toISOString()` produces —
 * `YYYY-MM-DDTHH:MM:SS.mmmZ`, always three fractional digits, always `Z`
 * (`2042-05-01T00:00:00.000Z`). Every datetime column carries a `GLOB` CHECK for
 * exactly that shape, so the shorter `2042-05-01T00:00:00Z` is a write error rather
 * than a second encoding of the same instant. It has to be: these are TEXT columns
 * compared as TEXT, and the two spellings are unequal AND sort in the wrong order,
 * which silently breaks the event window CHECK and `byTimeRange` at a boundary.
 * `shared/src/rollDate.ts` already emits the canonical form.
 */
export type IsoInstant = string;

/**
 * `event.category`.
 *
 * `tech` = an artifact or capability SHIPS; `scientific` = a result is ESTABLISHED.
 * The Tech Tree reads only `category === 'tech'`, so a wrong pick silently deletes a
 * node. There is deliberately no `project` member — it duplicated the `projectId` FK.
 */
export type Category =
  'tech' | 'political' | 'military' | 'disaster' | 'scientific' | 'cultural' | 'personal';

/** `event.tech_lane` — only meaningful when `category === 'tech'`. */
export type TechLane =
  'energy' | 'propulsion' | 'computing' | 'neural' | 'biomedical' | 'megastructure';

/** `event.when_precision` — how coarsely the author actually knows the date (§2.3). */
export type WhenPrecision = 'time' | 'day' | 'month' | 'season' | 'year' | 'decade';

/** `timeline.kind` — the Corridor's stratum model reads this (§5.2). */
export type TimelineKind = 'era' | 'thread' | 'cluster';

/** `relation.type` — canonical direction, see §2.6 (reverse relations). */
export type RelationType = 'precedes' | 'partOf' | 'renames';

/** `character_relation.type` — family-only for v1 (§2.2). */
export type CharacterRelationType = 'parent-of' | 'sibling-of' | 'spouse-of' | 'clone-of';

/** `project.status` */
export type ProjectStatus = 'planned' | 'active' | 'succeeded' | 'failed' | 'cancelled';

/**
 * What a `Location`'s map reference points at — DERIVED, never stored.
 *
 * There is no `map_ref_kind` column any more. A location carries two real foreign keys,
 * `countryId` (global) and `groupingId` (per-save), at most one of them set, so the kind
 * is read off whichever is populated:
 *
 * ```ts
 * const kind: MapRefKind | undefined =
 *   loc.countryId ? 'country' : loc.groupingId ? 'grouping' : undefined;
 * ```
 *
 * The union survives the column because the UI still has to NAME the two cases — a
 * target picker, a legend, a glow rule — and one vocabulary shared with the client beats
 * two copies of the same two strings. It is deliberately NOT mirrored by a runtime
 * member list in `schema.ts`: there is no column for a CHECK to constrain, and adding
 * one back is the mistake this replaced.
 */
export type MapRefKind = 'country' | 'grouping';

/**
 * `country.geometry_source` — `feature` is 1:1 with a topojson feature, `derived` is
 * carved out of one at load time by `deriveFeatures.ts` (§3.1).
 */
export type GeometrySource = 'feature' | 'derived';
