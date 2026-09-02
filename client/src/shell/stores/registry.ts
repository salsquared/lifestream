import { create } from 'zustand';

import type { Character, Location, Project } from './types';

/**
 * The per-save lookup tables, keyed by id.
 *
 * NOTE (`noUncheckedIndexedAccess` is on): indexing any of these yields
 * `T | undefined`. That is deliberate — at P0, and during every load, they are
 * empty, and a view that assumes a hit will be wrong exactly when the data has
 * not landed yet.
 */
export type RegistryData = {
  characters: Record<string, Character>;
  locations: Record<string, Location>;
  projects: Record<string, Project>;
};

/**
 * `useRegistry` — cached character / location / project lookups for the active
 * save. Architecture §4.2.
 *
 * The shell owns the fetch: it loads the registry once on mount and again on
 * every `activeSaveId` change, so a view never issues its own per-save query
 * and four views never race to load the same rows. This store exposes the
 * state and the setters only — it fetches nothing.
 */
export type RegistryState = RegistryData & {
  /** Called by the shell once a per-save load resolves. */
  hydrate: (data: RegistryData) => void;
  /**
   * Drop the cache. Coarse by design (§2.6): any per-save write invalidates
   * the whole thing rather than surgically patching one row. Does not refetch
   * — the shell's effect does that.
   */
  invalidate: () => void;
};

/** Fresh empties per call, so no two resets can ever share a mutable record. */
function emptyRegistry(): RegistryData {
  return { characters: {}, locations: {}, projects: {} };
}

export const useRegistry = create<RegistryState>((set) => ({
  ...emptyRegistry(),
  hydrate: (data) => set({ ...data }),
  invalidate: () => set({ ...emptyRegistry() }),
}));
