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

/* ------------------------------------------------------------------ *
 * Closed enums (architecture §2.5)
 * ------------------------------------------------------------------ */

/** `event.category` */
export type Category =
  'tech' | 'political' | 'military' | 'disaster' | 'scientific' | 'cultural' | 'personal';

/** `event.tech_lane` */
export type TechLane =
  'energy' | 'propulsion' | 'computing' | 'neural' | 'biomedical' | 'megastructure';

/** `event.when_precision` */
export type WhenPrecision = 'time' | 'day' | 'month' | 'season' | 'year' | 'decade';

/** `timeline.kind` */
export type TimelineKind = 'era' | 'thread' | 'cluster';

/** `relation.type` — canonical direction, see §2.6 (reverse relations). */
export type RelationType = 'precedes' | 'partOf' | 'renames';

/** `project.status` */
export type ProjectStatus = 'planned' | 'active' | 'succeeded' | 'failed' | 'cancelled';

/** `location.map_ref_kind` — what `mapRefValue` points at. */
export type MapRefKind = 'country' | 'grouping';

/**
 * All datetimes are TEXT ISO-8601 UTC with a `Z` suffix (§2.1). Aliased so the
 * intent survives the move to `shared/`.
 */
export type IsoInstant = string;

/* ------------------------------------------------------------------ *
 * Registry entities (per-save) — architecture §2.5
 * ------------------------------------------------------------------ */

export type Character = {
  id: string;
  saveId: string;
  name: string;
  /** Derived cache of the linked born/died event when one exists (§2.2). */
  lifespanStart?: IsoInstant;
  lifespanEnd?: IsoInstant;
  role: string;
  bio?: string;
  portraitPath?: string;
};

export type Location = {
  id: string;
  saveId: string;
  name: string;
  description?: string;
  lat?: number;
  lng?: number;
  /** `mapRefValue` points at a `country.id` or a `grouping.id` per `mapRefKind`. */
  mapRefKind?: MapRefKind;
  mapRefValue?: string;
  /** Rename identity chain (§2.2). */
  supersededByLocationId?: string;
};

export type Project = {
  id: string;
  saveId: string;
  name: string;
  description: string;
  dateStart?: IsoInstant;
  dateEnd?: IsoInstant;
  status: ProjectStatus;
  leadCharacterId?: string;
};

/* ------------------------------------------------------------------ *
 * World entities (per-save) — architecture §2.5
 * ------------------------------------------------------------------ */

/**
 * An `event` row with its join ids embedded. The glow derivation is purely
 * client-side (§2.6), which is only possible because every event payload
 * carries its own `actorIds` / `tagIds` / `locationId` / `projectId` — the
 * views never issue a join query to find out what an event touches.
 */
export type HydratedEvent = {
  id: string;
  saveId: string;
  title: string;
  description: string;
  whenMin: IsoInstant;
  whenMax: IsoInstant;
  whenPrecision: WhenPrecision;
  /** Seeded roll inside [whenMin, whenMax]; persisted, not recomputed (§2.3). */
  when: IsoInstant;
  /** OPTIONAL narrowing of the window — never its source (§2.3). */
  rangeBeforeEventId?: string;
  rangeAfterEventId?: string;
  category: Category;
  techLane?: TechLane;
  locationId?: string;
  projectId?: string;
  /** `event_actor.character_id` */
  actorIds: string[];
  /** `event_tag.tag_id` */
  tagIds: string[];
};

/** `timeline.membership_rules` jsonb — predicate semantics in §2.6. */
export type MembershipRules = {
  byTag?: string[];
  byCategory?: Category[];
  byTimeRange?: [IsoInstant, IsoInstant];
  byLocation?: string[];
};

export type Timeline = {
  id: string;
  saveId: string;
  name: string;
  kind: TimelineKind;
  description?: string;
  membershipRules?: MembershipRules;
  color?: string;
  /** Required when `kind === 'era'` (§2.5). */
  eraStart?: IsoInstant;
  eraEnd?: IsoInstant;
};

/** An event-to-event edge, stored once in canonical direction (§2.6). */
export type Relation = {
  id: string;
  saveId: string;
  fromEventId: string;
  toEventId: string;
  type: RelationType;
  note?: string;
};

/** Membership lives in `grouping_country`, surfaced client-side as `groupingOf`. */
export type Grouping = {
  id: string;
  saveId: string;
  name: string;
  color: string;
};

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
