import { create } from 'zustand';

import { useSelection } from './selection';

/**
 * The seeded "v1 (Bible canon)" save. Ids are prefixed TEXT with a readable
 * slug for seeded rows (§2.1).
 *
 * Hard-coded until P6 introduces the saves UI (P1.13): one constant here plus
 * one `?save=` parameter on every API call is the whole of save handling until
 * then. Every row written before P6 already carries a real `save_id`, so
 * nothing needs backfilling when the picker arrives.
 */
export const CANON_SAVE_ID = 'sav_canon';

/**
 * `useSave` — which version is active. Architecture §4.2.
 *
 * The shell owns the fetch: an effect on `activeSaveId` reloads `useRegistry`
 * and `useWorld` (§4.2). This store does not fetch and does not know how.
 */
export type SaveState = {
  activeSaveId: string;
  /**
   * Switches the active save and clears `primary` — see the note below.
   * A no-op when `id` is already active, so re-applying `?save=` costs nothing.
   */
  setActive: (id: string) => void;
};

export const useSave = create<SaveState>((set, get) => ({
  activeSaveId: CANON_SAVE_ID,

  setActive: (id) => {
    // Re-selecting the save that is already active is a NO-OP, not a cheap
    // re-run of the clear below. The URL sync (§4.3) re-applies `?save=` from a
    // mount effect, so on every load of a shared
    // `?save=sav_canon&primary=event:evt_x` link `setActive` is called with the
    // save that is already active — and an unconditional `clear()` would wipe
    // the `?primary=` the same link just restored.
    if (id === get().activeSaveId) return;

    // A fork regenerates every per-save row id (§2.6), so a `primary` carried
    // across a save switch points at an id that either does not exist in the
    // new save or — worse — belongs to an unrelated row. Clearing it also
    // clears the derived glow for free, because glow is a selector over
    // `primary` and not a second piece of state to remember to reset (§7.3).
    // `useFilters` is deliberately NOT cleared: categories and time ranges are
    // save-independent and losing them on every switch would be annoying
    // rather than safe.
    useSelection.getState().clear();
    set({ activeSaveId: id });
  },
}));
