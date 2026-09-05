/**
 * Which events the Corridor draws, and what it says about them — the ONE place that
 * decision is made (implementation P4.1, architecture §4.2).
 *
 * ## Why this is a module and not four lines in the view
 *
 * The rule it encodes is a rule about the shell's load *lifecycle*, and it was wrong in
 * exactly the way an inline rule gets wrong: the view gated the fixture on
 * `rows.length === 0`, which conflates **not loaded** with **loaded and empty**.
 * `loadSave` returns `events: []` for a save with no timelines, `hydrate` then sets
 * `status: 'ready'`, and the reader saw thirteen fictional canon events under the label
 * "Fixture data — no save hydrated yet." — a false statement, made while the store said
 * ready, about a corpus the user is entitled to believe is theirs. It is reachable in
 * normal use the moment P6 lands a second save. `fixture.ts`'s own header warns about
 * precisely this.
 *
 * So the decision is gated on **status**, never on row count alone, and it lives here as
 * a pure function of `(status, rows)` — no React, no store, no DOM — so the table below
 * can be asserted directly rather than through a mounted canvas.
 *
 * ## The rule
 *
 * | status    | rows      | source    | notice                                       |
 * | --------- | --------- | --------- | -------------------------------------------- |
 * | `idle`    | any       | `fixture` | `Fixture data — no save loaded.`             |
 * | `error`   | any       | `fixture` | `World load failed — drawing the seeded fixture.` |
 * | `loading` | non-empty | `world`   | `Reloading…`                                 |
 * | `loading` | empty     | `pending` | `Loading world…`                             |
 * | `stale`   | any       | `pending` | `Reloading…`                                 |
 * | `ready`   | non-empty | `world`   | none                                         |
 * | `ready`   | empty     | `empty`   | `This save has no events.`                   |
 *
 * `pending` and `empty` draw **no nodes at all**. That is the point of the whole module:
 * once a real load has begun the fixture never appears again, so canon can never be
 * mistaken for the user's own world. An empty corridor that says why is honest; thirteen
 * borrowed events are not.
 *
 * `loading` with rows already on screen keeps them — `useSaveLoad` does not blank the
 * store before a refetch — so a save switch redraws rather than flashing empty.
 */

import { CORRIDOR_FIXTURE } from './fixture';

import type { WorldStatus } from '../../shell/stores/world';
import type { HydratedEvent } from '@shared/types/index';

/**
 * Where the corridor's rows came from, which is a different question from how many there
 * are. `pending` and `empty` are both zero rows and mean opposite things: one is "wait",
 * the other is "there is nothing, and that is the answer".
 */
export type CorridorSource = 'fixture' | 'world' | 'empty' | 'pending';

export interface CorridorCorpus {
  readonly events: readonly HydratedEvent[];
  readonly source: CorridorSource;
  /** HUD line, or undefined when the corpus is the real world and needs no caveat. */
  readonly notice: string | undefined;
}

/**
 * Ordering the resolve endpoint already uses, applied to the store's rows for stability.
 *
 * `useWorld.events` is a `Record` keyed by id, and `Object.values` returns it in
 * insertion order — an artefact of how the payload was built, not a fact about the
 * corpus. Sorting here is what makes two loads of the same save produce the same array,
 * which the layout's label de-collision (P4.2.3) then depends on for its own determinism.
 */
export function byWhenThenId(a: HydratedEvent, b: HydratedEvent): number {
  if (a.when !== b.when) return a.when < b.when ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/**
 * Shared empty corpus, frozen: `pending` and `empty` hand back the SAME array every call,
 * so a view memoizing on `events` does not rebuild its layout on every status tick.
 */
const NO_EVENTS: readonly HydratedEvent[] = Object.freeze([]);

/** The fixture is already sorted by `when` then id — `fixture.ts` states it. */
const FIXTURE_EVENTS: readonly HydratedEvent[] = CORRIDOR_FIXTURE;

export function corridorCorpus(
  status: WorldStatus,
  rows: readonly HydratedEvent[],
): CorridorCorpus {
  // A `switch` over the closed status union with a `never`-typed default: adding a sixth
  // member to `WorldStatus` must fail to COMPILE here rather than fall through to some
  // reasonable-looking branch, because "reasonable-looking" is how the fixture got shown
  // over a ready save in the first place.
  switch (status) {
    case 'idle':
      return {
        events: FIXTURE_EVENTS,
        source: 'fixture',
        notice: 'Fixture data — no save loaded.',
      };

    case 'error':
      return {
        events: FIXTURE_EVENTS,
        source: 'fixture',
        notice: 'World load failed — drawing the seeded fixture.',
      };

    case 'loading':
      return rows.length === 0
        ? { events: NO_EVENTS, source: 'pending', notice: 'Loading world…' }
        : { events: [...rows].sort(byWhenThenId), source: 'world', notice: 'Reloading…' };

    // `invalidate()` empties the store, so there is nothing to keep on screen the way a
    // `loading` refetch does.
    case 'stale':
      return { events: NO_EVENTS, source: 'pending', notice: 'Reloading…' };

    case 'ready':
      return rows.length === 0
        ? { events: NO_EVENTS, source: 'empty', notice: 'This save has no events.' }
        : { events: [...rows].sort(byWhenThenId), source: 'world', notice: undefined };

    default: {
      const unhandled: never = status;
      throw new RangeError(`corridorCorpus: unhandled world status ${JSON.stringify(unhandled)}`);
    }
  }
}
