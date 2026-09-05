/**
 * One TS type per table — the wire format.
 *
 * EVERY PROPERTY HERE IS camelCase — `isoNumeric`, not `iso_numeric`. SQL columns are
 * snake_case and stay inside `server/src/db/schema.ts`; everything above the Drizzle
 * boundary is camelCase (implementation.html, the wire-format decision). Drizzle's
 * inferred row types are already camelCase, so these are the SAME shapes, not a mapping
 * layer: a nullable column shows up here as an optional property, and
 * `server/src/db/conformance.ts` fails to compile if a column is added, dropped or
 * re-typed on one side only.
 *
 * Column-level source of truth: architecture.html §2.5, which spells the columns
 * snake_case because it is describing SQL — the same schema, not a second convention.
 *
 * THE JOIN TABLES CARRY A `saveId` AND IT IS NOT REDUNDANT NOISE. `EventTag`,
 * `TimelineParent`, `TimelineMember` and `EventActor` each repeat the save of the row
 * they point at, because that is the column the schema's composite foreign keys check
 * against: without it a join row in save B could reference an event in save A and the
 * database would call it valid. Read it, do not drop it when constructing one.
 *
 * SIX BOUNDS OUTSIDE THE EVENT QUAD CARRY A PRECISION. A character's lifespan, a
 * project's dates and an era's span are each a `(value, precision)` PAIR — both set or
 * both absent — for the same reason `EventRow` is: §2.3 renders by precision and never
 * prints a roll, so a year-precision bound stored as a bare Jan-1 instant would print a
 * date the Bible does not contain.
 */

import type {
  Category,
  CharacterRelationType,
  GeometrySource,
  IsoInstant,
  ProjectStatus,
  RelationType,
  TechLane,
  TimelineKind,
  WhenPrecision,
} from './enums.js';
import type { ManifestItem, MembershipRules, SectorMix } from './json.js';

/* ------------------------------------------------------------------ *
 * Core — architecture §2.1
 * ------------------------------------------------------------------ */

/** A versioned project/snapshot. Every per-save row carries a `saveId` (§7). */
export type Save = {
  id: string;
  name: string;
  description: string;
  createdAt: IsoInstant;
  /** Set on a fork; a hard delete is refused while any save still names this one. */
  parentSaveId?: string;
  isArchived: boolean;
};

/**
 * GLOBAL — no `saveId`. One canonical tag list shared across every save, so timeline
 * `byTag` membership rules stay stable across forks (§2.1).
 */
export type Tag = {
  id: string;
  name: string;
  color: string;
  description?: string;
  /** Soft delete. A tag referenced by any `event_tag` row cannot be hard-deleted. */
  isRetired: boolean;
};

/**
 * Joins global tags to per-save events. `tagId` is global; `eventId` is per-save and
 * `saveId` is what pins the two to the same save (see the join-table note above).
 */
export type EventTag = {
  saveId: string;
  eventId: string;
  tagId: string;
};

/** A saved export manifest: a named sequence of `(view, scope)` pairs (§8.6). */
export type Manifest = {
  id: string;
  saveId: string;
  title: string;
  itemsJson: ManifestItem[];
  createdAt: IsoInstant;
  updatedAt: IsoInstant;
};

/* ------------------------------------------------------------------ *
 * Registry (per-save) — architecture §2.2
 * ------------------------------------------------------------------ */

export type Character = {
  id: string;
  saveId: string;
  name: string;
  /**
   * Derived cache of the linked born/died event when one exists, authored directly
   * when it does not (§2.2). The event wins where both exist.
   *
   * Set together with its precision, always: `Presumed Dead (2072)` is year precision
   * and the card must print "2072", not the instant stored here.
   */
  lifespanStart?: IsoInstant;
  lifespanStartPrecision?: WhenPrecision;
  lifespanEnd?: IsoInstant;
  lifespanEndPrecision?: WhenPrecision;
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
  /**
   * The map reference: TWO real foreign keys, at most one of them set, replacing the
   * old `(mapRefKind, mapRefValue)` TEXT pair that nothing could check. `MapRefKind` is
   * now derived from which of these is populated.
   *
   * `countryId` is GLOBAL and copied verbatim on fork; `groupingId` is per-save and is
   * REMAPPED — the one difference that used to make this a `conditional` line in the
   * fork's remap manifest and is now two ordinary ones.
   */
  countryId?: string;
  groupingId?: string;
  /**
   * Rename identity chain (§2.2): COPI → FOB Oasis → Camp Oasis → Oasis City →
   * Star City. Cycle-checked at write time; views resolve to the canonical head before
   * answering "what happened here". Two chains MAY converge on one successor — canon
   * has such a merge — so this is deliberately not unique.
   */
  supersededByLocationId?: string;
};

/** Anything with duration is a project or a timeline — never an event (§2.3). */
export type Project = {
  id: string;
  saveId: string;
  name: string;
  description: string;
  /** Each bound is set together with its precision — `Expected 2086` is year precision. */
  dateStart?: IsoInstant;
  dateStartPrecision?: WhenPrecision;
  dateEnd?: IsoInstant;
  dateEndPrecision?: WhenPrecision;
  status: ProjectStatus;
  leadCharacterId?: string;
};

/**
 * An explicit character-to-character edge, stored once. Directional types
 * (`parent-of`, `clone-of`) read from→to literally; symmetric types (`spouse-of`,
 * `sibling-of`) are stored with the lower id as `from` and rendered undirected (§2.2).
 */
export type CharacterRelation = {
  id: string;
  saveId: string;
  fromCharacterId: string;
  toCharacterId: string;
  type: CharacterRelationType;
};

/* ------------------------------------------------------------------ *
 * Timeline (per-save) — architecture §2.3
 * ------------------------------------------------------------------ */

/** An `event` row exactly as stored. The world timeline atom: a POINT in time. */
export type EventRow = {
  id: string;
  saveId: string;
  title: string;
  description: string;
  /** The window the author actually knows. Primary; `when` is derived from it (§2.3). */
  whenMin: IsoInstant;
  whenMax: IsoInstant;
  whenPrecision: WhenPrecision;
  /**
   * A seeded roll inside `[whenMin, whenMax]` — PERSISTED, not recomputed on read, so
   * node positions are stable across reloads and shared URLs. Changes only on an
   * explicit re-roll. Views render by `whenPrecision`, never by this value (§2.3).
   */
  when: IsoInstant;
  /** OPTIONAL narrowing of the window — never its source (§2.3). */
  rangeBeforeEventId?: string;
  rangeAfterEventId?: string;
  category: Category;
  /** Only meaningful when `category === 'tech'`. */
  techLane?: TechLane;
  locationId?: string;
  projectId?: string;
};

/**
 * An `event` row with its join ids embedded — the shape the read APIs return.
 *
 * The glow derivation is purely client-side (§2.6), which is only possible because
 * every event payload carries its own `actorIds` / `tagIds` / `locationId` /
 * `projectId`: the views never issue a join query to find out what an event touches.
 */
export type HydratedEvent = EventRow & {
  /** `event_actor.character_id` */
  actorIds: string[];
  /** `event_tag.tag_id` */
  tagIds: string[];
};

/**
 * An era / thread / cluster. The DAG root (`tl_world`) is the timeline with NO row in
 * `timeline_parent` — never inferred from `kind`, which is `'thread'` on the root for
 * schema simplicity (§2.3).
 */
export type Timeline = {
  id: string;
  saveId: string;
  name: string;
  kind: TimelineKind;
  description?: string;
  membershipRules?: MembershipRules;
  color?: string;
  /**
   * `eraStart` is required when `kind === 'era'` (§2.5) — enforced as a CHECK. `eraEnd`
   * is NOT: an open-ended era is a real thing (the Reconstruction Era "beginning around
   * 2047" has no stated end), and a missing end means "still running", never "unknown".
   * Each bound is set together with its precision.
   */
  eraStart?: IsoInstant;
  eraStartPrecision?: WhenPrecision;
  eraEnd?: IsoInstant;
  eraEndPrecision?: WhenPrecision;
  /**
   * What a PROJECT-LINKED THREAD hangs on: the thread's bar takes its extent from the
   * linked project's `dateStart`/`dateEnd` rather than from its members (§5.2).
   */
  projectId?: string;
};

/** One DAG edge. A timeline may have several parents; cycles are rejected at write time. */
export type TimelineParent = {
  saveId: string;
  timelineId: string;
  parentId: string;
};

/** The manual roster half of membership; `membershipRules` is the computed half. */
export type TimelineMember = {
  saveId: string;
  timelineId: string;
  eventId: string;
};

/**
 * An event-to-event edge, stored once in canonical direction (§2.6). `precedes`
 * from=A to=B means "A precedes B" / "B succeeds A", and requires `A.when < B.when`
 * at write time.
 */
export type Relation = {
  id: string;
  saveId: string;
  fromEventId: string;
  toEventId: string;
  type: RelationType;
  /** Free-text annotation on the EDGE itself — "via the Kauai lab". */
  note?: string;
};

/**
 * Many-to-many event ↔ character. `role` is free text ("crew", "designer", "victim",
 * "leader", …); the reserved roles `born` / `died` link a character to the events that
 * define their lifespan (§2.2), and a character may hold each of those at most once per
 * save.
 *
 * `role` IS PART OF THE KEY AND IS STORED NORMALIZED — lower-cased and trimmed, checked
 * by the database. Write `'born'`; `'Born'` and `'born '` are rejected rather than
 * stored as two more keys the lifespan lookup would never find.
 */
export type EventActor = {
  saveId: string;
  eventId: string;
  characterId: string;
  role: string;
};

/* ------------------------------------------------------------------ *
 * Map — architecture §2.4
 * ------------------------------------------------------------------ */

/**
 * GLOBAL, real-world. `id` is TEXT and TOTAL over the author's own data (§3.1): a
 * zero-padded 3-char ISO numeric where one exists (`"004"`, `"250"`), a namespaced
 * synthetic id otherwise (`"x:GUF"`, `"x:XKX"`, `"x:SOL"`, `"x:ashmore-cartier"`).
 * NEVER an integer — `4 !== "004"`.
 */
export type Country = {
  id: string;
  /** Null for synthetic rows. Nullable, therefore never a key component. */
  isoNumeric?: string;
  /** Display/debug only — not a key. */
  alpha3?: string;
  /**
   * The default real-world name. For a `geometry_source = 'feature'` row it is the
   * topojson feature's `properties.name`; for a `'derived'` row it is supplied
   * explicitly by `deriveFeatures.ts` — feature 250 is "France" and `x:GUF` is not
   * France (§3.1).
   */
  name: string;
  geometrySource: GeometrySource;
};

/** Per-save rename of a country — e.g. `"840"` → "United Earth America". */
export type CountryOverride = {
  saveId: string;
  countryId: string;
  name: string;
};

/** A per-save unified nation. Membership lives in `grouping_country`, not here. */
export type Grouping = {
  id: string;
  saveId: string;
  name: string;
  color: string;
};

/**
 * Per-save membership. PRIMARY KEY `(saveId, countryId)` — a country belongs to AT
 * MOST ONE unified nation per save, which is the partition invariant a jsonb array
 * could not express. An "independent nation" is a country with no row here (§2.4).
 */
export type GroupingCountry = {
  saveId: string;
  groupingId: string;
  countryId: string;
  /**
   * The union's LEADING country — `Panama (Leader)`, `India (Leader)`, … Canon marks one
   * on ten of the unions and the old map export has no such field, so the Bible is the
   * only source there is. At most one per grouping, enforced by a partial unique index;
   * membership needs no separate check because this row IS the membership. Copied
   * verbatim on fork.
   */
  isLeader: boolean;
};

/* ------------------------------------------------------------------ *
 * Simulation — architecture §3. SCHEMA ONLY; the subsystem is deferred.
 * ------------------------------------------------------------------ */

/**
 * The run ledger. GLOBAL, with a nullable `saveId` for the save-scoped stages, and
 * NOT remapped on fork (§7.1). Every simulation output carries a `runId`, so runs are
 * individually versioned and comparable.
 *
 * `stage` and `status` are deliberately open TEXT: the stage list and the run
 * lifecycle belong to the harness (§3.5), which is deferred, and neither is one of the
 * closed enums the schema pins down.
 */
export type SimRun = {
  id: string;
  stage: string;
  saveId?: string;
  paramsJson: Record<string, unknown>;
  /** The upstream runs this one consumed. */
  inputRunIdsJson: string[];
  status: string;
  startedAt: IsoInstant;
  finishedAt?: IsoInstant;
};

/**
 * The per-country projection cache (§3.1). GLOBAL and save-independent: it is computed
 * over real-world countries, not over your groupings. The chain's hand-off table.
 */
export type CountryProjection = {
  runId: string;
  countryId: string;
  year: number;
  pop: number;
  gdpReal: number;
  gdpPc: number;
  sectorMixJson: SectorMix;
  computedAt: IsoInstant;
};

/**
 * GLOBAL raw-fetch cache — one row straight from WPP / WDI / WEO. Without it, "same
 * params ⇒ same output" is false the moment a source republishes a series (§2.4).
 */
export type SourceSeries = {
  source: string;
  countryId: string;
  indicator: string;
  year: number;
  value: number;
  fetchedAt: IsoInstant;
  /** Which publication of the series this row came from. */
  vintage: string;
};

/** Output of the combine step (§3.3) — per save, per run, per grouping. */
export type GroupingMetrics = {
  saveId: string;
  runId: string;
  groupingId: string;
  pop: number;
  gdpReal: number;
  gdpPc: number;
  sectorMixJson: SectorMix;
  computedAt: IsoInstant;
};

/**
 * Output of the Megacorp classifier (§3.4) — keyed on the COUNTRY, not the grouping,
 * and deliberately so: a grouping's horizontals are a rollup over its
 * `grouping_country` members, while the decomposition in the other direction is
 * unrecoverable. `horizontal` is emergent (canon fixes how many, never which), so it
 * is open TEXT rather than a closed enum.
 */
export type NationHorizontal = {
  saveId: string;
  runId: string;
  countryId: string;
  horizontal: string;
  score: number;
  computedAt: IsoInstant;
};

/**
 * Output of the Black Fever spread simulation (§3.2) — a deliberate STUB. Only the key
 * shape `(runId, countryId, t)` is fixed; the state representation and whether the
 * table carries a `saveId` at all wait on OQ8 (§3.6).
 */
export type BfSpread = {
  runId: string;
  countryId: string;
  /** Simulation timestep index. */
  t: number;
};
