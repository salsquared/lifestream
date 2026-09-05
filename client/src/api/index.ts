/**
 * The client's API layer (P1.12.3, P2.6) — every call to the LIFEstream API goes through
 * here. One deliberate exception: `views/map/renderer/features.ts` fetches the vendored
 * topojson directly, because that is a static asset from the app's own origin rather than
 * an API read, and the renderer is presentational and does not import this layer.
 *
 * Two levels. `./client` is the transport: it appends `?save=` for a per-save read (P1.13)
 * or write, insists on a JSON body, and turns every failure into an `ApiError`. `./map`
 * and its successors are the endpoints: one function per URL in architecture §5.1/§5.2,
 * each returning the shared entity types from `@shared/types` with no renaming anywhere —
 * camelCase from the column definition to the component prop (the wire-format decision).
 * `./envelope` sits beside them, holding the two functions that open a named response
 * object — it is internal to this directory and is deliberately not re-exported.
 *
 * Import from here, not from the modules underneath: what an endpoint's URL is, and how
 * the save gets onto it, are this directory's business.
 *
 * P3.6 added the rest of the reads §5.2 specifies — events, timelines (including
 * `/resolve`), relations, the registry FOUR and tags. Every one of them is per-save and
 * every one of them takes the save id as its first argument, which is the same discipline
 * `getForSave` enforces on the transport: the caller captures the active save before the
 * fetch and hands that captured value down (§4.2), never re-reading the store in a `.then`.
 */

export { ApiError, getForSave, getGlobal, sendForSave } from './client';
export type { RequestOptions, WriteMethod } from './client';

export {
  assignCountryToGrouping,
  clearCountryOverride,
  createGrouping,
  deleteGrouping,
  fetchMapCountries,
  fetchMapGroupings,
  GroupingConflictError,
  MembershipConflictError,
  removeCountryFromGrouping,
  replaceGroupingCountries,
  setCountryOverride,
  updateGrouping,
  setGroupingLeader,
} from './map';
export type { GroupingDraft, GroupingPatch, MapGroupings } from './map';

export { fetchEvent, fetchEvents } from './events';
export type { EventDetail } from './events';

export { fetchResolvedTimeline, fetchTimeline, fetchTimelines } from './timelines';
export type { ResolvedTimeline, TimelineDetail, TimelineGraph } from './timelines';

export { fetchRelations } from './relations';
export type { RelationDirection, RelationQuery } from './relations';

// The registry FOUR (§5.2). There is no `/api/registry` URL; `useRegistry` is a store.
export {
  fetchCharacter,
  fetchCharacterRelation,
  fetchCharacterRelations,
  fetchCharacters,
  fetchLocation,
  fetchLocations,
  fetchProject,
  fetchProjects,
} from './registry';

export { fetchTags } from './tags';
export type { TagWithUsage } from './tags';
