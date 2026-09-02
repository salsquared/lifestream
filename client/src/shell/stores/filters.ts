import { create } from 'zustand';

import type { Category, IsoInstant } from './types';

/**
 * `useFilters` — what the user has filtered every view to. Architecture §4.2.
 *
 * Filters MASK, they never remove (§5.2): a filtered-out node keeps its
 * position and its arcs and merely dims. Applying the mask is `applyFilters`,
 * a separate cheap O(n) pass over an already-resolved membership set (§2.6) —
 * this store only holds the criteria.
 *
 * Filter state serializes to the URL alongside selection and save (§4.3), but
 * that sync is a single shell-level effect added later — no store here syncs
 * itself.
 */
export type FiltersState = {
  categories: Set<Category>;
  /** Global `tag.id`s — tags have no `save_id` (§2.5). */
  tags: Set<string>;
  search?: string;
  /** ISO-8601 UTC pair, both ends inclusive (§2.1). */
  timeRange?: [IsoInstant, IsoInstant];

  setCategories: (categories: Set<Category>) => void;
  toggleCategory: (category: Category) => void;
  setTags: (tags: Set<string>) => void;
  toggleTag: (tagId: string) => void;
  setSearch: (search: string | undefined) => void;
  setTimeRange: (timeRange: [IsoInstant, IsoInstant] | undefined) => void;
  /** Reset every criterion. Not called on a save switch — see `save.ts`. */
  clear: () => void;
};

function toggled<T>(source: Set<T>, value: T): Set<T> {
  const next = new Set(source);
  if (!next.delete(value)) next.add(value);
  return next;
}

export const useFilters = create<FiltersState>((set) => ({
  categories: new Set<Category>(),
  tags: new Set<string>(),
  search: undefined,
  timeRange: undefined,

  setCategories: (categories) => set({ categories }),
  toggleCategory: (category) =>
    set((state) => ({ categories: toggled(state.categories, category) })),
  setTags: (tags) => set({ tags }),
  toggleTag: (tagId) => set((state) => ({ tags: toggled(state.tags, tagId) })),
  setSearch: (search) => set({ search }),
  setTimeRange: (timeRange) => set({ timeRange }),
  clear: () =>
    set({
      categories: new Set<Category>(),
      tags: new Set<string>(),
      search: undefined,
      timeRange: undefined,
    }),
}));
