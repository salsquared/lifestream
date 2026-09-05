/**
 * The shell's per-save load (P4.1) — architecture §4.2.
 *
 * ── WHY THE FETCH IS HERE AND NOT IN A VIEW ──────────────────────────────────────────
 * §4.2 gives the shell the per-save load so that four views never race to fetch the same
 * event list, and so that `useWorld` / `useRegistry` have exactly one writer. P2's map
 * container kept its rows in view-local state because this module did not exist yet, and
 * said so in its header: `selectGlow`'s country and grouping rules read
 * `useWorld.groupingOf`, which stayed empty, so clicking a country lit only that country
 * instead of its whole union. Populating the store is the entire fix — the map view needs
 * no change.
 *
 * ── WHY IT LOADS FIVE COLLECTIONS AND NOT JUST THE EVENTS ────────────────────────────
 * P4.1 is worded as "fetch events for the world timeline", but `hydrate()` takes a whole
 * `WorldData` (that shape is what makes the save-identity guard a single atomic write).
 * Hydrating events alone would blank the timelines, relations, groupings and `groupingOf`
 * the store is documented to hold — which is precisely the trap the map container refused
 * to walk into from its own side. So the world load is all five, and the registry load is
 * the three lookup tables §4.2 pairs with it.
 *
 * ── THE ROOT TIMELINE IS FOUND, NOT SPELLED ──────────────────────────────────────────
 * P4.1 writes the URL as `GET /api/timelines/tl_world/resolve`. That id is hard-coded
 * NOWHERE here, because `tl_world` is a per-save row id and §7.3 says a fork regenerates
 * every per-save row id — a forked save's root is a different string, and a hard-coded one
 * would resolve a timeline that does not exist in it (404) the moment P6's fork lands.
 * `api/timelines.ts` already states the rule from the other side: the root is the timeline
 * with no row in `timeline_parent`, "structural, never inferred from `kind` and never a
 * hard-coded id" (§2.3, P3.4.1). `GET /api/timelines` is already part of this load, so the
 * structural answer is free.
 *
 * This module is deliberately a plain async function and not a hook: it takes the save id
 * as an ARGUMENT (§4.2 — the caller captures the active save before the fetch), reads no
 * store, writes no store, and is therefore exercisable against the real API outside React.
 * `useSaveLoad` is the React half.
 */
import type { GroupingCountry } from '@shared/types/index';

import {
  fetchCharacters,
  fetchLocations,
  fetchMapGroupings,
  fetchProjects,
  fetchRelations,
  fetchResolvedTimeline,
  fetchTimelines,
  type RequestOptions,
  type TimelineGraph,
} from '../api';

import type { RegistryData } from './stores/registry';
import type { WorldData } from './stores/world';

/** Everything one save switch has to put in place, in the shape the two stores take. */
export type SavePayload = {
  world: WorldData;
  registry: RegistryData;
};

/**
 * A save whose timeline DAG has no single root, so "the world timeline" has no answer.
 *
 * Raised rather than papered over with a guess: resolving an arbitrary one of several
 * parentless timelines would draw a SUBSET of the world and look completely normal doing
 * it. A save with no timelines at all is not this error — that is an empty save, and it
 * loads with no events.
 */
export class WorldRootError extends Error {
  override name = 'WorldRootError';

  constructor(message: string) {
    super(`world timeline: ${message}`);
  }
}

/** Index rows by `id`, which is how both stores hold every collection but `relations`. */
function byId<T extends { id: string }>(rows: readonly T[]): Record<string, T> {
  const index: Record<string, T> = {};
  for (const row of rows) index[row.id] = row;
  return index;
}

/**
 * `country_id -> grouping_id`, flattened from `grouping_country` (§2.4).
 *
 * A country with no membership row simply gets no key: absence IS independence, and
 * defaulting it to anything would invent the 74 synthesized groups the schema refuses to
 * store. The PK `(save_id, country_id)` is what makes this a `Record<string, string>`
 * rather than a `Record<string, string[]>`.
 */
function indexGroupingOf(members: readonly GroupingCountry[]): Record<string, string> {
  const index: Record<string, string> = {};
  for (const member of members) index[member.countryId] = member.groupingId;
  return index;
}

/**
 * The DAG root: the one timeline with no row in `timeline_parent` (§2.3).
 *
 * `undefined` means the save has no timelines at all. Anything else that is not exactly
 * one root is a `WorldRootError` — see the note on that class.
 */
function rootTimelineId(graph: TimelineGraph): string | undefined {
  if (graph.timelines.length === 0) return undefined;

  const parented = new Set(graph.parents.map((edge) => edge.timelineId));
  const roots = graph.timelines.filter((timeline) => !parented.has(timeline.id));

  if (roots.length === 1) return roots[0]?.id;
  if (roots.length === 0) {
    throw new WorldRootError(
      `every one of ${String(graph.timelines.length)} timelines has a parent — the DAG has a cycle`,
    );
  }
  throw new WorldRootError(
    `${String(roots.length)} timelines have no parent (${roots.map((t) => t.id).join(', ')})`,
  );
}

/**
 * The world half: the resolved event set plus the four collections the views draw from.
 *
 * The resolve is chained behind `GET /api/timelines` because it needs the root id from it;
 * the relations and the groupings run alongside both, so the load is two round trips deep
 * rather than four wide.
 */
async function loadWorld(saveId: string, options?: RequestOptions): Promise<WorldData> {
  const resolved = fetchTimelines(saveId, options).then(async (graph) => {
    const rootId = rootTimelineId(graph);
    if (rootId === undefined) return { graph, events: [] };
    const { events } = await fetchResolvedTimeline(saveId, rootId, options);
    return { graph, events };
  });

  const [{ graph, events }, relations, map] = await Promise.all([
    resolved,
    fetchRelations(saveId, {}, options),
    fetchMapGroupings(saveId, options),
  ]);

  return {
    events: byId(events),
    timelines: byId(graph.timelines),
    relations,
    groupings: byId(map.groupings),
    groupingOf: indexGroupingOf(map.members),
  };
}

/**
 * The registry half: the three lookup tables §4.2 names.
 *
 * Four endpoints exist (§5.2 adds `/api/character-relations`), and only three are read
 * here — `RegistryData` holds characters, locations and projects, and the Family Trees
 * view fetches its edges when it is built (P11).
 */
async function loadRegistry(saveId: string, options?: RequestOptions): Promise<RegistryData> {
  const [characters, locations, projects] = await Promise.all([
    fetchCharacters(saveId, options),
    fetchLocations(saveId, options),
    fetchProjects(saveId, options),
  ]);

  return {
    characters: byId(characters),
    locations: byId(locations),
    projects: byId(projects),
  };
}

/**
 * Load one save, whole. The save id is an ARGUMENT and no store is read: the caller
 * captured the active save before calling, and hands that same captured value to
 * `hydrate()` afterwards (§4.2).
 */
export async function loadSave(saveId: string, options?: RequestOptions): Promise<SavePayload> {
  const [world, registry] = await Promise.all([
    loadWorld(saveId, options),
    loadRegistry(saveId, options),
  ]);

  return { world, registry };
}
