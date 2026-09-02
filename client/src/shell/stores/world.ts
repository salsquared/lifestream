import { create } from 'zustand';

import type { Grouping, HydratedEvent, Relation, Timeline } from './types';

/** Lifecycle of the shell's per-save load. */
export type WorldStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * The per-save content the views actually draw.
 *
 * This is also what makes the glow selector possible client-side (§2.6): the
 * hydrated events carry their own join ids, and `groupings` + `groupingOf`
 * carry the country membership, so the `grouping -> member countries -> every
 * event located in one of them` two-hop walk (§6) needs no extra endpoint. At
 * ~50-500 events per save that is small enough to hold in memory.
 */
export type WorldData = {
  /** Keyed by event id. Each event embeds actorIds / tagIds / locationId / projectId. */
  events: Record<string, HydratedEvent>;
  /** Keyed by timeline id. Parentage and membership are resolved server-side (§2.6). */
  timelines: Record<string, Timeline>;
  /** Event-to-event edges, each stored once in canonical direction (§2.6). */
  relations: Relation[];
  /** Keyed by grouping id. */
  groupings: Record<string, Grouping>;
  /**
   * `country_id -> grouping_id` — the grouping-membership partition, flattened
   * from `grouping_country`. Its PK `(save_id, country_id)` guarantees one
   * grouping per country per save, which is exactly what makes this a
   * `Record` and not a `Record<string, string[]>`. A country with NO entry is
   * an independent nation (§2.4) — absence is meaningful, do not default it.
   */
  groupingOf: Record<string, string>;
};

/**
 * `useWorld` — loaded once by the shell, on mount and on every `activeSaveId`
 * change, so no view issues its own per-save query and four views never race
 * to load the same event list. Architecture §4.2.
 *
 * This store exposes state and setters only; it fetches nothing.
 */
export type WorldState = WorldData & {
  status: WorldStatus;
  /** Shell-driven lifecycle: 'loading' before the request, 'error' on failure. */
  setStatus: (status: WorldStatus) => void;
  /** Called by the shell when a per-save load resolves; sets status to 'ready'. */
  hydrate: (data: WorldData) => void;
  /**
   * Drop the world back to empty / 'idle'. Coarse by design (§2.6): any
   * per-save write invalidates the whole thing. Does not refetch — the shell's
   * effect does that, and the derived glow catches up on its own when the new
   * data lands.
   */
  invalidate: () => void;
};

/** Fresh empties per call, so no two resets can ever share a mutable record. */
function emptyWorld(): WorldData {
  return {
    events: {},
    timelines: {},
    relations: [],
    groupings: {},
    groupingOf: {},
  };
}

export const useWorld = create<WorldState>((set) => ({
  ...emptyWorld(),
  status: 'idle',

  setStatus: (status) => set({ status }),
  hydrate: (data) => set({ ...data, status: 'ready' }),
  invalidate: () => set({ ...emptyWorld(), status: 'idle' }),
}));
