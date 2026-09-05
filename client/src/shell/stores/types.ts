/**
 * Domain + shared-state types for the visualizer shell.
 *
 * The entity shapes mirror the column-level schema in architecture §2.5; the
 * `Primary` / `Glow` shapes are normative from §4.2.
 *
 * WHY THESE LIVE HERE AND NOT IN `shared/`: at P0 the `shared/` workspace has
 * no types yet — P1 builds the Drizzle schema and the API payload types. Every
 * entity type below is a candidate to move to `shared/types/` once P1 lands,
 * and the names are chosen so that move is a re-export rather than a rename.
 * Field names are camelCase (Drizzle property convention) over the snake_case
 * SQL columns of §2.5.
 */

// Entity and enum types come from `@shared/types` — ONE declaration, shared with the
// server and asserted against the real database rows by `server/src/db/conformance.ts`.
//
// They were duplicated here until 2026-09-05, and the duplicate had already drifted:
// this file's `MembershipRules` still carried a closed date range after the shared one
// gained an open upper bound, so the client could not express an open-ended era at all.
// Re-export, never re-declare.
export type {
  Category,
  Character,
  Grouping,
  HydratedEvent,
  IsoInstant,
  Location,
  MapRefKind,
  MembershipRules,
  Project,
  ProjectStatus,
  Relation,
  RelationType,
  TechLane,
  Timeline,
  TimelineKind,
  WhenPrecision,
} from '@shared/types/index';

/* ------------------------------------------------------------------ *
 * Closed enums (architecture §2.5)
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Registry entities (per-save) — architecture §2.5
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * World entities (per-save) — architecture §2.5
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Selection + glow — architecture §4.2 (normative)
 * ------------------------------------------------------------------ */

export type PrimaryType = 'event' | 'character' | 'location' | 'project' | 'country' | 'grouping';

/** The non-null half of `Primary`, so a narrowed primary has a name. */
export type PrimaryRef = { type: PrimaryType; id: string };

/** What the user clicked on. `null` is a real state — nothing selected. */
export type Primary = PrimaryRef | null;

/**
 * The halo around the primary. Derived by `selectGlow()`, never stored and
 * never serialized into the URL (§4.2, §4.3).
 *
 * READONLY IS LOAD-BEARING, not a stylistic preference. `selectGlow()` memoizes
 * on its inputs and hands the SAME `Glow` object to every `useGlow()` caller in
 * a render pass — that sharing is the whole point of the memo. With mutable
 * `Set`s a single `glow.eventIds.add(...)` in one view therefore silently
 * poisons the halo in all four views, and keeps doing so until an input changes
 * and the memo recomputes. `ReadonlySet` is what makes that a compile error;
 * `EMPTY_GLOW`'s sets additionally throw at runtime (see `selectGlow.ts`).
 *
 * A view that needs a mutable working copy takes one: `new Set(glow.eventIds)`.
 */
export type Glow = {
  eventIds: ReadonlySet<string>;
  characterIds: ReadonlySet<string>;
  locationIds: ReadonlySet<string>;
  projectIds: ReadonlySet<string>;
  countryIds: ReadonlySet<string>;
  groupingIds: ReadonlySet<string>;
  tagIds: ReadonlySet<string>;
};
