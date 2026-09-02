import { useMemo } from 'react';

import { useRegistry } from './registry';
import { useSelection } from './selection';
import { useWorld } from './world';
import type { Glow, Grouping, HydratedEvent, Location, Primary, PrimaryRef } from './types';

/**
 * The glow derivation. Architecture §2.6 (why it is a selector), §6 (the
 * per-primary recipe).
 *
 * Glow is a MEMOIZED DERIVED SELECTOR, not a sixth store. Nothing writes it,
 * nothing stores it, and it is never serialized into the URL (§4.2, §4.3).
 * `setPrimary()` records what was clicked and stops there; this function turns
 * that into a halo by following the join ids already on the client, and
 * re-runs whenever the primary OR the underlying data changes. That is what
 * makes a shared `?primary=character:char_lazaro` URL work: the first
 * evaluation happens before `useWorld` has resolved and is empty, and is
 * simply superseded when the fetch lands.
 *
 * Glow never removes anything from a view — that is `useFilters`' job.
 */

type EventMap = Record<string, HydratedEvent>;
type GroupingMap = Record<string, Grouping>;
type LocationMap = Record<string, Location>;
/** `country_id -> grouping_id`; see the signature note on `selectGlow`. */
type GroupingOf = Record<string, string>;

function emptyGlow(): Glow {
  return {
    eventIds: new Set<string>(),
    characterIds: new Set<string>(),
    locationIds: new Set<string>(),
    projectIds: new Set<string>(),
    countryIds: new Set<string>(),
    groupingIds: new Set<string>(),
    tagIds: new Set<string>(),
  };
}

/**
 * The glow when nothing is selected. A frozen singleton so that views can rely
 * on reference equality and skip re-rendering while the selection is empty.
 */
export const EMPTY_GLOW: Glow = Object.freeze(emptyGlow());

/**
 * The country an event sits in, or `undefined` if it sits nowhere resolvable.
 *
 * An event's `location_id` points at a per-save `location`, which carries the
 * map reference (`map_ref_kind` / `map_ref_value`, §2.5). Only a location
 * scoped to a country resolves here.
 *
 * KNOWN GAP: §2.2 gives locations a rename chain (`superseded_by_location_id`)
 * and §2.6's `byLocation` predicate resolves a location to the canonical head
 * of that chain before matching. §6 does not say whether glow should do the
 * same, so this deliberately does not walk the chain — an event pointing at a
 * superseded location row will not glow its country. Worth settling before P2
 * renames anything.
 */
function countryOfEvent(event: HydratedEvent, locations: LocationMap): string | undefined {
  if (event.locationId === undefined) return undefined;
  const location = locations[event.locationId];
  if (location === undefined) return undefined;
  if (location.mapRefKind !== 'country') return undefined;
  return location.mapRefValue;
}

/**
 * The per-primary recipe, straight off the §6 table. One block per
 * `primary.type`; each derives ONLY what §6 states for that type.
 *
 * The primary's own id always lands in its own bucket. §5.4 states this for a
 * character primary ("glow.characterIds — set directly when a character is
 * primary"); it is applied uniformly here so a view never has to special-case
 * "is this node the primary, or merely glowing".
 */
function computeGlow(
  primary: PrimaryRef,
  events: EventMap,
  groupings: GroupingMap,
  locations: LocationMap,
  groupingOf: GroupingOf,
): Glow {
  const glow = emptyGlow();

  switch (primary.type) {
    // Click event in Corridor / tech node in Tree -> its actors, location,
    // project and tags.
    case 'event': {
      glow.eventIds.add(primary.id);
      const event = events[primary.id];
      // The primary can name an id the world has not loaded (a shared URL
      // mid-fetch) or one that no longer exists (a stale link into a forked
      // save, §7.3). Both are normal; the glow is just the primary itself.
      if (event === undefined) break;
      for (const characterId of event.actorIds) glow.characterIds.add(characterId);
      for (const tagId of event.tagIds) glow.tagIds.add(tagId);
      if (event.locationId !== undefined) glow.locationIds.add(event.locationId);
      if (event.projectId !== undefined) glow.projectIds.add(event.projectId);
      break;
    }

    // Click character in Family Trees -> every event they appear in, plus
    // those events' locations and projects.
    case 'character': {
      glow.characterIds.add(primary.id);
      for (const event of Object.values(events)) {
        if (!event.actorIds.includes(primary.id)) continue;
        glow.eventIds.add(event.id);
        if (event.locationId !== undefined) glow.locationIds.add(event.locationId);
        if (event.projectId !== undefined) glow.projectIds.add(event.projectId);
      }
      break;
    }

    // Click project span in Tree, or the palette's "show Project Xero" ->
    // its milestones, their actors and their locations.
    case 'project': {
      glow.projectIds.add(primary.id);
      for (const event of Object.values(events)) {
        if (event.projectId !== primary.id) continue;
        glow.eventIds.add(event.id);
        for (const characterId of event.actorIds) glow.characterIds.add(characterId);
        if (event.locationId !== undefined) glow.locationIds.add(event.locationId);
      }
      // MISSING INPUT: §6 also wants the project's `lead_character_id` in
      // characterIds ("lead + actors"), and §4.2 repeats it for the Family
      // Trees. That column lives on `registry.projects`, which is NOT one of
      // the four inputs §4.2 gives this selector. Left underived rather than
      // guessed at; resolving it means either passing `registry.projects` in
      // or moving the lead onto something already here.
      break;
    }

    // Click country in Map -> events located there, their actors, and the
    // grouping that owns the country if any.
    case 'country': {
      glow.countryIds.add(primary.id);
      const owner = groupingOf[primary.id];
      // No entry means an independent nation (§2.4) — absence is meaningful.
      if (owner !== undefined) glow.groupingIds.add(owner);
      for (const event of Object.values(events)) {
        if (countryOfEvent(event, locations) !== primary.id) continue;
        glow.eventIds.add(event.id);
        for (const characterId of event.actorIds) glow.characterIds.add(characterId);
      }
      break;
    }

    // Click grouping in Map -> its member countries, then every event located
    // in one of them. This is the §6 two-hop walk, and the reason `useWorld`
    // has to hold `groupingOf` and the hydrated events rather than just the
    // registry rows.
    case 'grouping': {
      glow.groupingIds.add(primary.id);
      const members = new Set<string>();
      for (const [countryId, groupingId] of Object.entries(groupingOf)) {
        if (groupingId !== primary.id) continue;
        members.add(countryId);
        glow.countryIds.add(countryId);
      }
      for (const event of Object.values(events)) {
        const countryId = countryOfEvent(event, locations);
        if (countryId === undefined || !members.has(countryId)) continue;
        glow.eventIds.add(event.id);
      }
      // NOT DERIVED: a `location` can reference a grouping directly
      // (`map_ref_kind = 'grouping'`, §2.5), so an event sited at such a
      // location is arguably in the grouping too. §6 describes the walk as
      // going through the member countries only, so that path is left alone.
      break;
    }

    // §6 has no row for a 'location' primary, though the Primary union has
    // one. This is the single FK hop its closing sentence implies ("and so on
    // — driven by the foreign keys already in §2.5") and nothing more: the
    // events sited here. It does not fan out to their actors or projects,
    // because §6 does not say it should.
    case 'location': {
      glow.locationIds.add(primary.id);
      for (const event of Object.values(events)) {
        if (event.locationId !== primary.id) continue;
        glow.eventIds.add(event.id);
      }
      break;
    }

    default: {
      // Compile-time exhaustiveness: adding a PrimaryType without adding its
      // §6 rule here is an error, not a silently empty halo.
      const unhandled: never = primary.type;
      void unhandled;
      break;
    }
  }

  return glow;
}

type Memo = {
  primary: Primary;
  events: EventMap;
  groupings: GroupingMap;
  locations: LocationMap;
  groupingOf: GroupingOf;
  glow: Glow;
};

let memo: Memo | null = null;

/** Primary is a small value object, so compare it structurally, not by identity. */
function samePrimary(a: Primary, b: Primary): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.type === b.type && a.id === b.id;
}

/**
 * `selectGlow(primary, world.events, world.groupings, registry.locations)` —
 * the §4.2 signature, memoized on its inputs.
 *
 * The memo is a single last-call entry: the store objects it takes are stable
 * references that only change when the shell re-hydrates, so one entry is
 * enough to make every `useGlow()` caller in a render pass share one
 * computation. It is intentionally NOT keyed on the save — every input changes
 * on a save switch anyway, and `setActive` clears the primary (§7.3).
 *
 * SIGNATURE NOTE: `groupingOf` is a fifth, optional input that §4.2's
 * signature does not list, and the §6 country and grouping rules cannot be
 * derived without it. `groupings` (`{id, save_id, name, color}`) carries no
 * membership at all since the grouping-membership decision moved members into
 * the `grouping_country` join table — the members reach the client as
 * `useWorld.groupingOf`. It is optional so a caller written against the
 * documented four-argument signature still type-checks; such a call derives a
 * country's or grouping's own id and nothing around it. `useGlow()` always
 * passes it.
 */
export function selectGlow(
  primary: Primary,
  events: EventMap,
  groupings: GroupingMap,
  locations: LocationMap,
  groupingOf: GroupingOf = {},
): Glow {
  if (
    memo !== null &&
    samePrimary(memo.primary, primary) &&
    memo.events === events &&
    memo.groupings === groupings &&
    memo.locations === locations &&
    memo.groupingOf === groupingOf
  ) {
    return memo.glow;
  }

  const glow =
    primary === null ? EMPTY_GLOW : computeGlow(primary, events, groupings, locations, groupingOf);
  memo = { primary, events, groupings, locations, groupingOf, glow };
  return glow;
}

/**
 * Hook wrapper. Recomputes when ANY of the inputs changes — the primary the
 * user clicked, or the world/registry data landing underneath it.
 *
 * Views read `primary` to know what was clicked and `glow` to know what to
 * highlight around it.
 */
export function useGlow(): Glow {
  const primary = useSelection((state) => state.primary);
  const events = useWorld((state) => state.events);
  const groupings = useWorld((state) => state.groupings);
  const groupingOf = useWorld((state) => state.groupingOf);
  const locations = useRegistry((state) => state.locations);

  return useMemo(
    () => selectGlow(primary, events, groupings, locations, groupingOf),
    [primary, events, groupings, locations, groupingOf],
  );
}
