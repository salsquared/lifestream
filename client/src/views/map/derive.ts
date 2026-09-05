/**
 * Everything the World Map container computes, as pure functions over one plain value.
 *
 * ── WHY THESE ARE NOT INLINE IN `MapView` ─────────────────────────────────────────────
 * Two of them are the phase's load-bearing claims and both fail SILENTLY when wrong. The
 * independent set is DERIVED — a country with no `grouping_country` row is independent
 * (§2.4), which is why the endpoint answers `{ groupings, members }` and no third field;
 * a container that got that wrong would rebuild the 74 synthesized "independent" groups
 * the old map export emitted and the schema deliberately refuses to store. And `nameById`
 * has a precedence order whose middle term is invisible: the server has ALREADY coalesced
 * `country_override` over `country.name`, so the layer below the optimistic one is not the
 * atlas default — the atlas default is a third, separate input, needed only to answer
 * "what would this country be called if the rename were removed".
 *
 * Pure and React-free on purpose: `scripts/` can exercise them against a fixture and
 * assert the counts, which is the only way to check a derivation whose failure mode is a
 * plausible-looking map.
 *
 * ── THE MEMBERSHIP INVARIANT ──────────────────────────────────────────────────────────
 * `grouping_country`'s primary key is `(save_id, country_id)`: one grouping per country
 * per save. Every reducer below preserves it — an assignment REPLACES whatever row the
 * country had rather than adding a second — so the optimistic state can never show a
 * country in two nations, which is a state the server cannot produce and the map cannot
 * draw.
 */

import type { Country, Grouping, GroupingCountry } from '@shared/types/index';

/**
 * The whole of the map's per-save state, in one value.
 *
 * ONE OBJECT AND NOT FOUR `useState`s, because the optimistic writes roll back by
 * restoring a snapshot (`optimistic.ts`): a rollback has to return *everything* a write
 * touched, and a delete touches both `groupings` and `members`. Four independent slices
 * would make "the state before" a thing you assemble and can assemble incompletely.
 */
export type MapData = {
  /** `GET /api/map/countries` — names already have this save's overrides coalesced in. */
  countries: Country[];
  /** `GET /api/map/groupings`.`groupings`, ordered by name as the server orders them. */
  groupings: Grouping[];
  /** `GET /api/map/groupings`.`members` — the join rows verbatim, `isLeader` included. */
  members: GroupingCountry[];
  /**
   * Renames written from this view since the last load, over the server's names.
   *
   * It exists because `/api/map/countries` returns the COALESCED name, so a successful
   * rename is invisible until that endpoint is read again — and a reset-to-default is
   * invisible even then unless the whole payload is refetched. Values are always the
   * display name to use, including for a reset, where the value is the atlas default.
   */
  renames: Record<string, string>;
};

/** An empty map — the state before the first load, and after a save switch. */
export function emptyMapData(): MapData {
  return { countries: [], groupings: [], members: [], renames: {} };
}

/**
 * `country_id -> grouping_id`, the §2.4 partition. This is `useWorld.groupingOf`'s shape
 * (§4.2) built from the same rows; the store's copy is the shell's to fill in.
 *
 * A country with NO entry is independent. Absence is the datum — never default it.
 */
export function groupingOf(data: MapData): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const member of data.members) index.set(member.countryId, member.groupingId);
  return index;
}

/**
 * `country.id -> the fill to paint`, for MEMBERS ONLY.
 *
 * An independent country is absent from this map rather than present with a default
 * color, which is the same distinction the schema makes: the renderer paints its own
 * default for a country it finds no entry for (the pinned `WorldMapProps` contract), so
 * nothing here has to name a color that means "belongs to nobody".
 */
export function fillById(data: MapData): ReadonlyMap<string, string> {
  const colorOf = new Map<string, string>();
  for (const group of data.groupings) colorOf.set(group.id, group.color);

  const fills = new Map<string, string>();
  for (const member of data.members) {
    const color = colorOf.get(member.groupingId);
    // A membership naming a grouping this save does not have is not drawable. It cannot
    // happen through the API (composite FK), and skipping beats painting `undefined`.
    if (color !== undefined) fills.set(member.countryId, color);
  }
  return fills;
}

/**
 * `country.id -> the name to show`, in three layers, lowest first:
 *
 *   1. the ATLAS DEFAULT from `deriveFeatures` — so every feature the renderer draws has
 *      a name even before the API answers, and so a country row that has somehow gone
 *      missing still labels its polygon;
 *   2. the SERVER's name, which is `coalesce(country_override.name, country.name)` for
 *      this save — an authored rename is already applied by the time it arrives;
 *   3. this session's optimistic renames, which are what makes a right-click rename
 *      visible before its write lands, and a reset-to-default visible at all.
 */
export function nameById(
  data: MapData,
  atlasDefaults: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const names = new Map<string, string>(atlasDefaults);
  for (const country of data.countries) names.set(country.id, country.name);
  for (const [countryId, name] of Object.entries(data.renames)) names.set(countryId, name);
  return names;
}

/**
 * The independent nations: every country with no `grouping_country` row (§2.4).
 *
 * DERIVED, NEVER FETCHED. The complement is computed against the country list the API
 * returned, not against the atlas, so a country the save has no row for is simply not in
 * either set rather than silently becoming independent.
 */
export function independentIds(data: MapData): ReadonlySet<string> {
  const owned = groupingOf(data);
  const independents = new Set<string>();
  for (const country of data.countries) {
    if (!owned.has(country.id)) independents.add(country.id);
  }
  return independents;
}

/** `grouping_id -> member count`, for the sidebar. Groupings with no members read 0. */
export function memberCounts(data: MapData): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const group of data.groupings) counts.set(group.id, 0);
  for (const member of data.members) {
    counts.set(member.groupingId, (counts.get(member.groupingId) ?? 0) + 1);
  }
  return counts;
}

/** `grouping_id -> its leader's country id`, or absent. At most one per grouping (§2.4). */
export function leaderIds(data: MapData): ReadonlyMap<string, string> {
  const leaders = new Map<string, string>();
  for (const member of data.members) {
    if (member.isLeader) leaders.set(member.groupingId, member.countryId);
  }
  return leaders;
}

/**
 * The countries that LEAD their union — `grouping_country.is_leader` (§2.4).
 *
 * WHY THE CONTAINER NEEDS THIS AND NOT JUST THE per-grouping leader. It is what the move
 * prompts check before they warn. P3.7 narrowed what there is to warn about: a move now
 * CARRIES the flag into a union that has no leader, so the only writes that still discard
 * leadership are a move into a union that is already led, and the bulk membership replace,
 * which lands every country as an ordinary member. Both are still worth saying out loud —
 * but they are recoverable now, because P3.7.1 gave the flag a write path.
 */
export function leaderCountryIds(data: MapData): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const member of data.members) {
    if (member.isLeader) ids.add(member.countryId);
  }
  return ids;
}

/** The countries in one grouping — the renderer's `editingMemberIds` while editing. */
export function membersOf(data: MapData, groupingId: string): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const member of data.members) {
    if (member.groupingId === groupingId) ids.add(member.countryId);
  }
  return ids;
}

/**
 * The countries the map should draw as glowing (§5.1 "cross-links in", §6).
 *
 * TWO SOURCES, because the map draws countries and the glow speaks in both currencies:
 * `glow.countryIds` directly, plus every member of a grouping in `glow.groupingIds` —
 * which is what makes clicking a grouping label in the sidebar (P2.7.2) light up its
 * members. `selectGlow` derives those members itself when `useWorld.groupingOf` is
 * populated; until the shell owns that load (§4.2) the container's own membership is the
 * only copy on the client, so the expansion happens here as well. Doing it in both places
 * is idempotent — this is a union of ids.
 */
export function glowCountryIds(
  data: MapData,
  glowCountries: ReadonlySet<string>,
  glowGroupings: ReadonlySet<string>,
): ReadonlySet<string> {
  const ids = new Set<string>(glowCountries);
  if (glowGroupings.size > 0) {
    for (const member of data.members) {
      if (glowGroupings.has(member.groupingId)) ids.add(member.countryId);
    }
  }
  return ids;
}

/* ------------------------------------------------------------------------------------ *
 * The optimistic reducers. Each returns a NEW `MapData`; none mutates its input, because
 * the value it was given is the snapshot a rollback restores.
 * ------------------------------------------------------------------------------------ */

/**
 * SQLite's default `BINARY` collation, which is what `ORDER BY name` uses in the
 * groupings read. Matching it means an optimistically-created nation appears where the
 * next refetch will put it, instead of jumping once the server answers.
 * `localeCompare` would order `Ångström` and `Zulu` differently from the server.
 */
const byName = (a: Grouping, b: Grouping): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** Insert or replace a grouping, keeping the server's name order. */
export function withGrouping(data: MapData, group: Grouping): MapData {
  const groupings = data.groupings.filter((candidate) => candidate.id !== group.id);
  groupings.push(group);
  groupings.sort(byName);
  return { ...data, groupings };
}

/**
 * Delete a grouping AND its membership rows.
 *
 * The members are dropped rather than reassigned: deleting a nation returns its countries
 * to independent, and independence is the absence of a row (§2.4). Anything that moved
 * them into an "independent" grouping would be inventing the row the schema refuses.
 */
export function withoutGrouping(data: MapData, groupingId: string): MapData {
  return {
    ...data,
    groupings: data.groupings.filter((group) => group.id !== groupingId),
    members: data.members.filter((member) => member.groupingId !== groupingId),
  };
}

/**
 * Assign one country to one grouping.
 *
 * ANY EXISTING ROW FOR THE COUNTRY IS REPLACED, whichever grouping it named — that is the
 * `(save_id, country_id)` primary key, and it is what makes the optimistic version of a
 * confirmed move correct without a separate "remove from the old owner" step.
 *
 * `isLeader` IS THE SERVER'S RULE, RESTATED (P3.7.3): a country that led its old union
 * keeps the flag when the destination has no leader, and loses it when the destination is
 * already led. It used to be an unconditional `false` here, which was right while the
 * server cleared it unconditionally too — now it would flash a demotion the write is not
 * going to make. The server's row still replaces this one on reconciliation and remains
 * the authority; this only has to agree with it for the duration of the request.
 */
export function withMember(
  data: MapData,
  saveId: string,
  groupingId: string,
  countryId: string,
): MapData {
  const moving = data.members.find((member) => member.countryId === countryId);
  // The country itself is excluded so that re-writing a leader's own membership reads its
  // union as unled and keeps the flag, rather than seeing itself and clearing it.
  const led = data.members.some(
    (member) =>
      member.groupingId === groupingId && member.isLeader && member.countryId !== countryId,
  );

  const members = data.members.filter((member) => member.countryId !== countryId);
  members.push({ saveId, groupingId, countryId, isLeader: moving?.isLeader === true && !led });
  return { ...data, members };
}

/**
 * Set or clear a union's leader — the optimistic twin of
 * `PATCH /api/groupings/:id/countries/:countryId` (P3.7.1).
 *
 * IT REWRITES EVERY MEMBER OF THE UNION, not just the one named. At most one row per
 * grouping may carry the flag (`grouping_country_leader_unique`), and the server clears
 * the previous leader in the same transaction as it sets the new one — but the response
 * carries only the row that was WRITTEN, so a reducer that flipped just that row would
 * leave the demoted leader showing on screen until the next full read. `countryId` of
 * `null` is the clear, which is the same pass with nothing set.
 */
export function withLeader(data: MapData, groupingId: string, countryId: string | null): MapData {
  const members = data.members.map((member) =>
    member.groupingId === groupingId
      ? { ...member, isLeader: countryId !== null && member.countryId === countryId }
      : member,
  );
  return { ...data, members };
}

/** Replace a membership row with the one the server actually wrote. */
export function withServerMember(data: MapData, member: GroupingCountry): MapData {
  const members = data.members.filter((row) => row.countryId !== member.countryId);
  members.push(member);
  return { ...data, members };
}

/** Remove a country's membership — back to independent, by absence. */
export function withoutMember(data: MapData, countryId: string): MapData {
  return { ...data, members: data.members.filter((member) => member.countryId !== countryId) };
}

/**
 * Replace one grouping's whole membership — the optimistic twin of
 * `PUT /api/groupings/:id/countries`.
 *
 * Countries moving in are removed from whatever grouping held them, and countries no
 * longer listed lose their row entirely. Both halves are the same delete: the PK admits
 * one row per country, so "belongs to this nation now" and "belongs to none" are the same
 * operation followed by a different number of inserts.
 */
export function withMembership(
  data: MapData,
  saveId: string,
  groupingId: string,
  countryIds: readonly string[],
): MapData {
  const wanted = [...new Set(countryIds)];
  const keep = new Set(wanted);
  const members = data.members.filter(
    (member) => member.groupingId !== groupingId && !keep.has(member.countryId),
  );
  for (const countryId of wanted) {
    members.push({ saveId, groupingId, countryId, isLeader: false });
  }
  return { ...data, members };
}

/** Replace a grouping's membership with the rows the server actually wrote. */
export function withServerMembership(
  data: MapData,
  groupingId: string,
  serverMembers: readonly GroupingCountry[],
): MapData {
  const written = new Set(serverMembers.map((member) => member.countryId));
  const members = data.members.filter(
    (member) => member.groupingId !== groupingId && !written.has(member.countryId),
  );
  return { ...data, members: [...members, ...serverMembers] };
}

/**
 * Show `name` for `countryId` from now on.
 *
 * Used for a rename AND for a reset, where `name` is the atlas default — the row is
 * deleted on the server, but the payload already on the client still carries the old
 * override, so the reset has to be recorded rather than merely un-recorded.
 */
export function withRename(data: MapData, countryId: string, name: string): MapData {
  return { ...data, renames: { ...data.renames, [countryId]: name } };
}
