/**
 * `resolveTimeline()` — the membership event set for a timeline (architecture §2.6, P3.5).
 *
 * Every stratum of the Corridor, the fork-fidelity check and `GET /api/timelines/:id/resolve`
 * all read membership from here, so "what is in this timeline" has exactly one answer and
 * exactly one place to look when it is wrong (§5.2).
 *
 * ── MEMBERSHIP ONLY. FILTERS ARE A SEPARATE PASS. ────────────────────────────────────
 * This function unions the manual roster (`timeline_member`) with whatever
 * `timeline.membership_rules` matches, plus the same for every descendant in the
 * `timeline_parent` DAG. It does NOT apply the live `useFilters` state — category chips, a
 * tag filter, a scrubbed time range, a search box. Those run as a client-side
 * `applyFilters(events, filters)` mask OVER this result (§2.6, P9.4).
 *
 * That split is the reason the memo below is worth having. Filter state changes on every
 * keystroke and every scrub; membership changes only when somebody writes to the save. Bake
 * the filters into the key and the cache hit rate goes to roughly zero, which is the same as
 * having no cache while paying for one. DO NOT COLLAPSE THE TWO.
 *
 * ── WHAT IS EVALUATED IN SQL AND WHAT IS EVALUATED HERE ──────────────────────────────
 * The save is loaded once into a snapshot (five indexed reads keyed on `save_id`) and the
 * predicates are evaluated in JavaScript. At the expected scale — ~50–500 events per save
 * (§2.6) — that is sub-millisecond, and it buys two things worth more than the SQL would
 * be: `byTimeRange`'s window intersection and `byLocation`'s rename-chain walk are written
 * once, in the open, instead of being assembled into dynamic SQL per rule kind; and one
 * snapshot serves every timeline in the save, so building the reverse index below costs one
 * read of the save rather than one per timeline.
 *
 * Timestamps are TEXT in the canonical `YYYY-MM-DDTHH:MM:SS.mmmZ` shape, enforced by CHECK
 * constraints (`db/schema.ts`), so every comparison here is a lexicographic string compare
 * and that is also chronological order. Nothing is parsed into a `Date`.
 */

import { eq } from 'drizzle-orm';

import type { Category, MembershipRules } from '@shared/types/index';

// TYPE-ONLY, and it has to stay that way: `db/index.ts` opens `data/lifestream.db` at module
// scope (the app-wide `appDb`), so a runtime import here would make importing this service
// open the real database — including from a spec that carefully built a `:memory:` one.
import type { Db } from '../db/index.js';
import {
  event,
  eventTag,
  location,
  timeline,
  timelineMember,
  timelineParent,
} from '../db/schema.js';

/**
 * An `event` row as the database hands it back: nullable columns are `T | null`.
 *
 * The wire type (`@shared/types`'s `EventRow`) writes those same columns as optional
 * properties, and `db/conformance.ts` pins `NullToOptional` as the single rule between the
 * two sides. Converting is the route handler's job, exactly as in `routes/map.ts` — this
 * service sits at the database layer and hands up rows, not payloads.
 */
export type StoredEvent = typeof event.$inferSelect;

/** The resolved membership of one timeline. Frozen: it is a cache entry, not a scratch copy. */
export interface ResolvedTimeline {
  saveId: string;
  /** The timeline that was asked for. */
  timelineId: string;
  /**
   * The DAG closure that was unioned — `timelineId` first, then every descendant in
   * ascending id order. A DAG has no traversal order worth preserving (a node reachable by
   * two paths has two positions), so this is sorted rather than walk-ordered.
   */
  timelineIds: readonly string[];
  /**
   * The deduplicated membership, sorted by `when`, ties broken by `id` so the order is
   * total and stable across runs (§2.6 asks for `when`; two events can share a roll).
   */
  events: readonly StoredEvent[];
}

/** `eventId → the timelines whose resolved membership contains it` — the "also in" index. */
export type TimelinesByEvent = ReadonlyMap<string, ReadonlySet<string>>;

/** The asked-for timeline does not exist in this save. The route answers 404 (§4.4). */
export class TimelineNotFoundError extends Error {
  constructor(
    readonly timelineId: string,
    readonly saveId: string,
  ) {
    super(`no timeline '${timelineId}' in save '${saveId}'`);
    this.name = 'TimelineNotFoundError';
  }
}

/**
 * `timeline_parent` describes a cycle reachable from the resolved timeline (P3.5.3).
 *
 * RAISING IS THE POINT. Cycles are rejected at write time (P12.9) and this is the backstop —
 * but a backstop that merely stops recursing would return a plausible-looking membership set
 * for a corrupt DAG, and one that recursed anyway would hang the request thread. Neither is
 * discoverable. A named cycle is.
 */
export class TimelineCycleError extends Error {
  constructor(readonly cycle: readonly string[]) {
    super(`timeline_parent cycle: ${cycle.join(' -> ')}`);
    this.name = 'TimelineCycleError';
  }
}

/**
 * A `superseded_by_location_id` chain loops (§2.2). Same reasoning as the DAG cycle: the
 * schema forbids only the one-row case (`id <> superseded_by_location_id`), the multi-row
 * case is rejected at write time, and the canonical-head walk must not be what discovers it
 * by spinning.
 */
export class LocationChainCycleError extends Error {
  constructor(readonly cycle: readonly string[]) {
    super(`location rename-chain cycle: ${cycle.join(' -> ')}`);
    this.name = 'LocationChainCycleError';
  }
}

/* ------------------------------------------------------------------ *
 * The snapshot: one save, read once.
 * ------------------------------------------------------------------ */

interface SaveSnapshot {
  /** Every timeline in the save, by id. */
  timelines: ReadonlyMap<string, typeof timeline.$inferSelect>;
  /** `timeline_parent` read downwards: parent id → its children, ascending. */
  childrenOf: ReadonlyMap<string, readonly string[]>;
  /** `timeline_member` — the manual roster half, by timeline. */
  rosterOf: ReadonlyMap<string, ReadonlySet<string>>;
  /** Every event in the save, already sorted by `(when, id)`. */
  events: readonly StoredEvent[];
  /** `event_tag` — the tags on an event, by event id. Absent means untagged. */
  tagsOf: ReadonlyMap<string, ReadonlySet<string>>;
  /** location id → the canonical head of its rename chain (§2.2). */
  canonicalLocation: ReadonlyMap<string, string>;
}

function loadSnapshot(db: Db, saveId: string): SaveSnapshot {
  const timelines = new Map(
    db
      .select()
      .from(timeline)
      .where(eq(timeline.saveId, saveId))
      .all()
      .map((row) => [row.id, row] as const),
  );

  const childrenOf = new Map<string, string[]>();
  for (const edge of db
    .select()
    .from(timelineParent)
    .where(eq(timelineParent.saveId, saveId))
    .all()) {
    // The row says "this timeline's parent is that one", so the DESCENDANT direction — the
    // one resolution walks — is `parent_id` → `timeline_id`.
    const siblings = childrenOf.get(edge.parentId);
    if (siblings === undefined) childrenOf.set(edge.parentId, [edge.timelineId]);
    else siblings.push(edge.timelineId);
  }
  for (const siblings of childrenOf.values()) siblings.sort(compareIds);

  const rosterOf = new Map<string, Set<string>>();
  for (const row of db
    .select()
    .from(timelineMember)
    .where(eq(timelineMember.saveId, saveId))
    .all()) {
    const roster = rosterOf.get(row.timelineId);
    if (roster === undefined) rosterOf.set(row.timelineId, new Set([row.eventId]));
    else roster.add(row.eventId);
  }

  const events = db.select().from(event).where(eq(event.saveId, saveId)).all();
  // Sorted once, here, so every resolved set below is in order by construction — a subset of
  // a sorted list stays sorted, and no per-timeline sort can disagree with another.
  events.sort(compareEvents);

  const tagsOf = new Map<string, Set<string>>();
  for (const row of db.select().from(eventTag).where(eq(eventTag.saveId, saveId)).all()) {
    const tags = tagsOf.get(row.eventId);
    if (tags === undefined) tagsOf.set(row.eventId, new Set([row.tagId]));
    else tags.add(row.tagId);
  }

  const successorOf = new Map(
    db
      .select({ id: location.id, supersededBy: location.supersededByLocationId })
      .from(location)
      .where(eq(location.saveId, saveId))
      .all()
      .map((row) => [row.id, row.supersededBy] as const),
  );

  return {
    timelines,
    childrenOf,
    rosterOf,
    events,
    tagsOf,
    canonicalLocation: canonicalHeads(successorOf),
  };
}

/**
 * Collapse every `superseded_by_location_id` chain to its head, memoizing the whole path.
 *
 * `COPI → FOB Oasis → Camp Oasis → Oasis City → Star City` (§2.2) is five rows and one
 * place; a `byLocation` rule naming the head has to find events sited at any of the five,
 * or "events at Oasis" returns a fifth of the site's history. Chains MERGE — two of them
 * converge on Oasis City in canon — which is why this is a map to a head and not a linked
 * list walked in one direction per row.
 */
function canonicalHeads(successorOf: ReadonlyMap<string, string | null>): Map<string, string> {
  const heads = new Map<string, string>();

  for (const start of successorOf.keys()) {
    const path: string[] = [];
    const seen = new Set<string>();
    let cursor = start;
    let head: string;

    for (;;) {
      const memo = heads.get(cursor);
      if (memo !== undefined) {
        head = memo;
        break;
      }
      if (seen.has(cursor)) throw new LocationChainCycleError([...path, cursor]);
      seen.add(cursor);
      path.push(cursor);

      const next = successorOf.get(cursor);
      if (next === undefined || next === null) {
        // No successor — or a successor whose row is not in this save, which the composite
        // foreign key makes unreachable. Either way the chain ends at the id it names.
        head = next ?? cursor;
        break;
      }
      cursor = next;
    }

    for (const step of path) heads.set(step, head);
  }

  return heads;
}

/* ------------------------------------------------------------------ *
 * The cache (P3.5.1).
 * ------------------------------------------------------------------ */

interface SaveCache {
  snapshot?: SaveSnapshot;
  resolved: Map<string, ResolvedTimeline>;
  timelinesByEvent?: TimelinesByEvent;
}

/**
 * `(save_id, timeline_id)` — and NOTHING else in the key (§2.6, P3.5.1).
 *
 * The outer `WeakMap` is a per-connection NAMESPACE, not a third key component: two open
 * databases (the app's own and a spec's `:memory:` fixture) can hold the same save id, and
 * one cache across both would serve one database's rows to the other. It is weak so a
 * closed fixture connection takes its cache with it.
 */
const cachesByConnection = new WeakMap<Db, Map<string, SaveCache>>();

function saveCache(db: Db, saveId: string): SaveCache {
  let bySave = cachesByConnection.get(db);
  if (bySave === undefined) {
    bySave = new Map();
    cachesByConnection.set(db, bySave);
  }
  let cache = bySave.get(saveId);
  if (cache === undefined) {
    cache = { resolved: new Map() };
    bySave.set(saveId, cache);
  }
  return cache;
}

/**
 * Drop everything cached for one save. **Every per-save write calls this** — the events, the
 * timelines, the DAG edges, the roster, the tag assignments, the locations (P12), and the
 * fork before it commits (§2.6).
 *
 * Invalidation is deliberately COARSE. Working out which timelines a single event write
 * could have joined or left means evaluating every rule in the save, which is the expensive
 * half of resolving in the first place; at ~50–500 events the rebuild is cheaper than the
 * bookkeeping, and a coarse drop cannot be subtly wrong.
 */
export function invalidateSave(db: Db, saveId: string): void {
  cachesByConnection.get(db)?.delete(saveId);
}

/** Drop every save's cache on this connection — schema-level changes, and fixture teardown. */
export function invalidateAllSaves(db: Db): void {
  cachesByConnection.get(db)?.clear();
}

/* ------------------------------------------------------------------ *
 * The DAG walk (P3.5.3).
 * ------------------------------------------------------------------ */

/**
 * `timelineId` plus every descendant, with a cycle raised rather than silently absorbed.
 *
 * Two marks, not one. A plain visited set is enough to TERMINATE, but it cannot tell a
 * cycle (an edge back into the path currently being walked) from a diamond (an edge into a
 * branch already finished) — and a diamond is legal and common: two eras both containing the
 * same cluster. `open` is the current path, `done` is fully explored; only an edge into
 * `open` is a cycle.
 */
function closureOf(snapshot: SaveSnapshot, timelineId: string): string[] {
  const state = new Map<string, 'open' | 'done'>();
  const path: string[] = [];
  const reached: string[] = [];

  // Recursive: the DAG is authored by hand and holds tens of nodes, and the one shape that
  // could exhaust the stack — an unbounded chain — is a cycle, which is caught by the marks
  // long before the depth matters.
  const visit = (id: string): void => {
    const mark = state.get(id);
    if (mark === 'done') return;
    if (mark === 'open') throw new TimelineCycleError([...path.slice(path.indexOf(id)), id]);

    state.set(id, 'open');
    path.push(id);
    for (const child of snapshot.childrenOf.get(id) ?? []) visit(child);
    path.pop();
    state.set(id, 'done');
    reached.push(id);
  };

  visit(timelineId);
  return reached;
}

/* ------------------------------------------------------------------ *
 * The four predicates (§2.6).
 * ------------------------------------------------------------------ */

/**
 * One predicate's values, or `undefined` when the kind is absent from the rules.
 *
 * A kind that is PRESENT but empty stays present and matches nothing: OR over zero values is
 * false, so `byTag: []` makes the whole conjunction false rather than dropping a constraint.
 * A malformed value (the column is JSON; nothing has validated its interior) is treated the
 * same way — unsatisfiable, never unconstrained. The safe direction for a wrong rule is an
 * empty timeline the author notices, not the entire save quietly joining it.
 */
function predicate<T>(raw: readonly T[] | undefined | null): readonly T[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  return Array.isArray(raw) ? raw : [];
}

/**
 * Does one event satisfy `membership_rules`?
 *
 * Kinds AND together; values within a kind OR (§2.6). A rules object with NO predicate kinds
 * present matches NOTHING — not everything, which is what an empty conjunction would
 * literally mean. "A timeline with no `membership_rules` is a pure manual roster" (§2.6) is
 * the documented reading of an absent rule set, and `{}` is that same statement written a
 * different way; the alternative is that saving a timeline with its rules cleared silently
 * sweeps every event in the save into it.
 */
function matchesRules(
  candidate: StoredEvent,
  rules: MembershipRules,
  snapshot: SaveSnapshot,
): boolean {
  let constrained = false;

  const byTag = predicate(rules.byTag);
  if (byTag !== undefined) {
    constrained = true;
    const tags = snapshot.tagsOf.get(candidate.id);
    if (tags === undefined || !byTag.some((tagId) => tags.has(tagId))) return false;
  }

  const byCategory = predicate<Category>(rules.byCategory);
  if (byCategory !== undefined) {
    constrained = true;
    if (!byCategory.includes(candidate.category)) return false;
  }

  const byTimeRange = predicate(rules.byTimeRange);
  if (byTimeRange !== undefined) {
    constrained = true;
    const [from, to] = byTimeRange;
    if (from === undefined || to === undefined) return false;
    // THE WINDOW INTERSECTS THE RANGE — not "the rolled `when` falls inside it". Membership
    // must not change when somebody re-rolls a fuzzy date: an event known only as "in the
    // 2040s" belongs to the Black Fever era whether or not its roll landed in 2044 (§2.6).
    // Both ends inclusive, both compares lexicographic on the canonical format.
    if (candidate.whenMin > to || candidate.whenMax < from) return false;
  }

  const byLocation = predicate(rules.byLocation);
  if (byLocation !== undefined) {
    constrained = true;
    if (candidate.locationId === null) return false;
    // Resolved to the canonical head FIRST (P3.5.4), so a rule naming the site catches the
    // events sited at every earlier name it carried. Glow deliberately does NOT do this — it
    // matches `location_id` by equality, because it answers "what did the user just click"
    // rather than "what happened at this place" (the glow-rules decision, §6).
    const head = snapshot.canonicalLocation.get(candidate.locationId) ?? candidate.locationId;
    // BOTH SIDES are resolved (decided 2026-09-05). Resolving only the event side made a rule
    // naming any EARLIER name of a site match nothing at all, silently: every event there
    // collapses to the head, so only a rule naming the head could ever hit. That is the
    // silently-empty failure this codebase refuses elsewhere, and it contradicts §2.2's own
    // reason for the chain ("events at Oasis returns the site's whole history"). Naming any
    // name of a place now means the place. "Only while it was called COPI" is still
    // expressible — that is `byLocation` AND `byTimeRange`, which the across-kinds semantics
    // already gives you.
    const wanted = byLocation.map((id) => snapshot.canonicalLocation.get(id) ?? id);
    if (!wanted.includes(head)) return false;
  }

  return constrained;
}

/* ------------------------------------------------------------------ *
 * The entry points.
 * ------------------------------------------------------------------ */

/**
 * Compose the membership event set for a timeline: its own roster and rules, unioned with
 * those of every descendant in the `timeline_parent` DAG, deduplicated and sorted by `when`.
 *
 * Memoized per `(saveId, timelineId)`; call {@link invalidateSave} after any write to the
 * save. `db` leads the documented `(timelineId, saveId)` argument order because the
 * connection is not part of the key — it is which database is being asked (`createDb(url)`,
 * P1.6.3, exists so a spec can ask a throwaway one).
 *
 * @throws {TimelineNotFoundError} the timeline is not in this save.
 * @throws {TimelineCycleError} `timeline_parent` loops within the reachable set.
 * @throws {LocationChainCycleError} a `superseded_by_location_id` chain loops.
 */
export function resolveTimeline(db: Db, timelineId: string, saveId: string): ResolvedTimeline {
  const cache = saveCache(db, saveId);
  const memo = cache.resolved.get(timelineId);
  if (memo !== undefined) return memo;

  const snapshot = (cache.snapshot ??= loadSnapshot(db, saveId));
  if (!snapshot.timelines.has(timelineId)) throw new TimelineNotFoundError(timelineId, saveId);

  const closure = closureOf(snapshot, timelineId);

  // A SET of ids, not a list of events: an event reachable through two branches of the DAG —
  // or one that is both on the roster and matched by a rule — is one member, once.
  const members = new Set<string>();
  for (const id of closure) {
    for (const eventId of snapshot.rosterOf.get(id) ?? []) members.add(eventId);

    const rules = snapshot.timelines.get(id)?.membershipRules;
    if (rules === null || rules === undefined) continue;
    for (const candidate of snapshot.events) {
      if (!members.has(candidate.id) && matchesRules(candidate, rules, snapshot)) {
        members.add(candidate.id);
      }
    }
  }

  // Filtering the pre-sorted snapshot is what puts the result in `when` order; nothing sorts
  // a second time, so no two resolutions can order the same pair differently.
  const resolved: ResolvedTimeline = {
    saveId,
    timelineId,
    timelineIds: Object.freeze([...closure].sort(compareIds)),
    events: Object.freeze(snapshot.events.filter((candidate) => members.has(candidate.id))),
  };

  cache.resolved.set(timelineId, Object.freeze(resolved));
  return resolved;
}

/**
 * The reverse index behind the "also in" pills (P3.5.2, P8.3): for every event in the save,
 * the timelines that contain it.
 *
 * "Contains" means the same thing here as everywhere else — it is {@link resolveTimeline}
 * inverted, resolved for every timeline in the save. So an event in a cluster is also in the
 * era above it, which is what makes the pills a navigation affordance rather than a
 * restatement of `timeline_member`. A view that wants to hide the DAG root drops it
 * structurally (the parentless timeline, §2.3) exactly as the Corridor's thread stratum does.
 *
 * An event in no timeline has no entry; read it as `index.get(id) ?? EMPTY`.
 *
 * @throws {TimelineCycleError} any timeline in the save has a cycle beneath it — the index
 *         covers all of them, so a corrupt DAG anywhere fails this rather than half-building.
 */
export function timelinesByEvent(db: Db, saveId: string): TimelinesByEvent {
  const cache = saveCache(db, saveId);
  if (cache.timelinesByEvent !== undefined) return cache.timelinesByEvent;

  const snapshot = (cache.snapshot ??= loadSnapshot(db, saveId));
  const index = new Map<string, Set<string>>();

  for (const timelineId of [...snapshot.timelines.keys()].sort(compareIds)) {
    for (const member of resolveTimeline(db, timelineId, saveId).events) {
      const timelines = index.get(member.id);
      if (timelines === undefined) index.set(member.id, new Set([timelineId]));
      else timelines.add(timelineId);
    }
  }

  cache.timelinesByEvent = index;
  return index;
}

/* ------------------------------------------------------------------ *
 * Ordering. Both compares are on TEXT in the canonical format, where bytewise order and
 * chronological order are the same thing — `localeCompare` would be neither faster nor more
 * correct, and its locale sensitivity is a hazard on ids.
 * ------------------------------------------------------------------ */

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const compareEvents = (a: StoredEvent, b: StoredEvent): number =>
  a.when < b.when ? -1 : a.when > b.when ? 1 : compareIds(a.id, b.id);
