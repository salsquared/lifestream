/**
 * Compile-time proof that the SQL schema and the wire types are the same shapes.
 *
 * The wire format is camelCase and Drizzle's inferred row types already are — so there
 * is no mapper between `schema.ts` and `@shared/types`, only an ASSERTION that the two
 * agree. This file is that assertion. It has no runtime value and nothing imports it;
 * it exists so that `tsc` fails when a column is added, dropped, renamed or re-typed on
 * one side only.
 *
 * Two things are deliberately declared twice and reconciled here rather than shared
 * directly:
 *   · the closed-enum member lists, because `schema.ts` needs them as RUNTIME arrays
 *     (`{ enum: [...] }` plus the CHECK constraints) while `shared/` must stay free of
 *     anything the client would have to bundle;
 *   · nullability, because a nullable column infers as `T | null` on the Drizzle side
 *     and is written as an optional property (`T | undefined`) on the wire side.
 *     `NullToOptional` is the one rule that converts between them.
 *
 * Constraints are NOT reflected here and cannot be: a CHECK, a UNIQUE or a composite
 * foreign key narrows which VALUES a column may hold, and every one of them leaves the
 * column's TYPE alone. `save_id` added to a join table shows up (it is a column);
 * `UNIQUE (save_id, id)` does not. The assertions below prove the SHAPES agree — the
 * schema file is still the only place the rules live.
 *
 * If a check below fails, the fix is to change whichever side is wrong — never to relax
 * the assertion.
 */

import type {
  BfSpread,
  Category,
  CharacterRelation,
  CharacterRelationType,
  Country,
  CountryOverride,
  CountryProjection,
  EventActor,
  EventRow,
  EventTag,
  GeometrySource,
  Grouping,
  GroupingCountry,
  GroupingMetrics,
  Location,
  Manifest,
  NationHorizontal,
  Project,
  ProjectStatus,
  Relation,
  RelationType,
  Save,
  SimRun,
  SourceSeries,
  Tag,
  TechLane,
  Timeline,
  TimelineKind,
  TimelineMember,
  TimelineParent,
  WhenPrecision,
  Character as SharedCharacter,
} from '@shared/types/index';

import {
  CATEGORIES,
  CHARACTER_RELATION_TYPES,
  GEOMETRY_SOURCES,
  PROJECT_STATUSES,
  RELATION_TYPES,
  TECH_LANES,
  TIMELINE_KINDS,
  WHEN_PRECISIONS,
  bfSpread,
  character,
  characterRelation,
  country,
  countryOverride,
  countryProjection,
  event,
  eventActor,
  eventTag,
  grouping,
  groupingCountry,
  groupingMetrics,
  location,
  manifest,
  nationHorizontal,
  project,
  relation,
  save,
  simRun,
  sourceSeries,
  tag,
  timeline,
  timelineMember,
  timelineParent,
} from './schema.js';

/** A nullable column (`T | null`) is an optional property (`T | undefined`) on the wire. */
type NullToOptional<T> = {
  [K in keyof T as null extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as null extends T[K] ? K : never]?: Exclude<T[K], null>;
};

/** The wire shape of one table's SELECT row. */
type Row<T extends { $inferSelect: unknown }> = NullToOptional<T['$inferSelect']>;

/**
 * Exact key sets, checked separately because ASSIGNABILITY CANNOT SEE THEM.
 *
 * `NullToOptional` turns every nullable column into an OPTIONAL property, and a type
 * whose extra properties are all optional is still assignable to one without them — in
 * both directions. So `{ id: string; mapRefKind?: K; mapRefValue?: string }` and
 * `{ id: string; countryId?: string; groupingId?: string }` are mutually assignable, and
 * the pure `Same` below called them identical. That is not a corner case: it is exactly
 * the shape of replacing the polymorphic map-ref pair with two real FK columns, and of
 * adding the six nullable `*_precision` siblings — the two changes this assertion most
 * needed to be watching. Verified: the negative control passed silently without this.
 *
 * `keyof (X & Y)` is `keyof X | keyof Y`, so this reads through the intersection that
 * `NullToOptional` produces without having to flatten it.
 */
type SameKeys<A, B> = [Exclude<keyof A, keyof B>] extends [never]
  ? [Exclude<keyof B, keyof A>] extends [never]
    ? true
    : false
  : false;

/**
 * Mutual assignability rather than strict identity: it catches a missing property, an
 * extra property and a changed type — everything a schema/type drift can be — without
 * failing on the structurally irrelevant difference between an intersection and the
 * flattened object literal that `NullToOptional` produces. `SameKeys` covers the one
 * thing assignability alone lets through (see above); both must hold.
 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? SameKeys<A, B> : false) : false;

/** `false` is not assignable to `true`, so a drifted pair is a compile error. */
type Assert<T extends true> = T;

/* ------------------------------------------------------------------ *
 * Closed enums — the runtime member lists against the shared unions
 * ------------------------------------------------------------------ */

export type _WhenPrecisionMembers = Assert<Same<(typeof WHEN_PRECISIONS)[number], WhenPrecision>>;
export type _CategoryMembers = Assert<Same<(typeof CATEGORIES)[number], Category>>;
export type _TechLaneMembers = Assert<Same<(typeof TECH_LANES)[number], TechLane>>;
export type _TimelineKindMembers = Assert<Same<(typeof TIMELINE_KINDS)[number], TimelineKind>>;
export type _RelationTypeMembers = Assert<Same<(typeof RELATION_TYPES)[number], RelationType>>;
export type _CharacterRelationTypeMembers = Assert<
  Same<(typeof CHARACTER_RELATION_TYPES)[number], CharacterRelationType>
>;
export type _ProjectStatusMembers = Assert<Same<(typeof PROJECT_STATUSES)[number], ProjectStatus>>;
export type _GeometrySourceMembers = Assert<
  Same<(typeof GEOMETRY_SOURCES)[number], GeometrySource>
>;

// `MapRefKind` HAS NO LINE HERE ON PURPOSE, and its absence is not drift. It is the one
// union in `@shared/types` with no column behind it: `location.map_ref_kind` is gone,
// replaced by the `country_id` / `grouping_id` foreign-key pair, and the kind is derived
// from whichever is populated. There is no runtime member list in `schema.ts` to conform
// it against — and re-adding one to restore the symmetry would mean re-adding the
// polymorphic column this replaced.

/* ------------------------------------------------------------------ *
 * Tables — one line per table in `schema.ts`; a new table adds a line
 * ------------------------------------------------------------------ */

// core
export type _Save = Assert<Same<Row<typeof save>, Save>>;
export type _Tag = Assert<Same<Row<typeof tag>, Tag>>;
export type _EventTag = Assert<Same<Row<typeof eventTag>, EventTag>>;
export type _Manifest = Assert<Same<Row<typeof manifest>, Manifest>>;

// registry
export type _Character = Assert<Same<Row<typeof character>, SharedCharacter>>;
export type _Location = Assert<Same<Row<typeof location>, Location>>;
export type _Project = Assert<Same<Row<typeof project>, Project>>;
export type _CharacterRelation = Assert<Same<Row<typeof characterRelation>, CharacterRelation>>;

// timeline
export type _Event = Assert<Same<Row<typeof event>, EventRow>>;
export type _Timeline = Assert<Same<Row<typeof timeline>, Timeline>>;
export type _TimelineParent = Assert<Same<Row<typeof timelineParent>, TimelineParent>>;
export type _TimelineMember = Assert<Same<Row<typeof timelineMember>, TimelineMember>>;
export type _Relation = Assert<Same<Row<typeof relation>, Relation>>;
export type _EventActor = Assert<Same<Row<typeof eventActor>, EventActor>>;

// map
export type _Country = Assert<Same<Row<typeof country>, Country>>;
export type _CountryOverride = Assert<Same<Row<typeof countryOverride>, CountryOverride>>;
export type _Grouping = Assert<Same<Row<typeof grouping>, Grouping>>;
export type _GroupingCountry = Assert<Same<Row<typeof groupingCountry>, GroupingCountry>>;

// simulation
export type _SimRun = Assert<Same<Row<typeof simRun>, SimRun>>;
export type _CountryProjection = Assert<Same<Row<typeof countryProjection>, CountryProjection>>;
export type _SourceSeries = Assert<Same<Row<typeof sourceSeries>, SourceSeries>>;
export type _GroupingMetrics = Assert<Same<Row<typeof groupingMetrics>, GroupingMetrics>>;
export type _NationHorizontal = Assert<Same<Row<typeof nationHorizontal>, NationHorizontal>>;
export type _BfSpread = Assert<Same<Row<typeof bfSpread>, BfSpread>>;
