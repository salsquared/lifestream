import { create } from 'zustand';

import type { Primary } from './types';

/**
 * `useSelection` — what the user clicked on. Architecture §4.2.
 *
 * Glow is NOT stored here and must never be. `setPrimary()` sets `primary` and
 * nothing else; the halo is a memoized derived selector over
 * `(primary, world.events, world.groupings, registry.locations)` — see
 * `../selectGlow.ts` and architecture §2.6.
 *
 * WHY (this is load-bearing, do not "optimize" it back): computing glow inside
 * the setter is correct exactly once — on a click, with the world data already
 * loaded. It is wrong in the case that matters most. Opening a shared URL like
 * `/v/timeline?primary=character:char_lazaro` restores `primary` during the
 * first render, BEFORE `useWorld` has any events, so a glow computed at
 * set-time is empty — and because nothing re-invokes `setPrimary` when the
 * fetch lands, it stays empty forever. As a selector, that empty first
 * evaluation is simply superseded the moment the world data resolves.
 */
export type SelectionState = {
  primary: Primary;
  /** Sets primary ONLY — computes no glow and stores none. See the note above. */
  setPrimary: (primary: Primary) => void;
  /** Deselect. Also clears the derived glow for free, since glow is a selector. */
  clear: () => void;
};

export const useSelection = create<SelectionState>((set) => ({
  primary: null,
  setPrimary: (primary) => set({ primary }),
  clear: () => set({ primary: null }),
}));
