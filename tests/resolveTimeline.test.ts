import { fileURLToPath } from 'node:url';

import { and, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, describe, expect, it } from 'vitest';

import { createDb } from '@server/db/index';
import {
  event,
  eventTag,
  location,
  save,
  tag,
  timeline,
  timelineMember,
  timelineParent,
} from '@server/db/schema';
import {
  invalidateAllSaves,
  invalidateSave,
  LocationChainCycleError,
  resolveTimeline,
  timelinesByEvent,
  TimelineCycleError,
  TimelineNotFoundError,
} from '@server/services/resolveTimeline';

import type { DbHandle } from '@server/db/index';
import type { ResolvedTimeline } from '@server/services/resolveTimeline';

/**
 * P3.5.5 — `resolveTimeline()` against a `:memory:` database (the test-fixture decision).
 *
 * ── WHY THIS IS ONE OF THE FOUR TESTS ────────────────────────────────────────────────
 * Every way this function fails is silent. A dropped recursion step returns a shorter
 * timeline, not an error. A dropped dedupe returns the same event twice and the Corridor
 * draws two nodes at one instant. A `byTimeRange` that reads the rolled `when` instead of
 * the `[when_min, when_max]` window returns a plausible set that CHANGES when somebody
 * re-rolls a date. A `byLocation` that skips the rename chain returns a fifth of a site's
 * history. And a cycle in `timeline_parent` does not return anything at all — it hangs the
 * request thread, which is the one failure a spec has to catch by construction rather than
 * by waiting.
 *
 * So the world below is built to make each of those a DIFFERENT number, and the cycle cases
 * carry an explicit timeout — with one limit stated plainly below, because a spec that
 * promises more than it delivers is worse than one that promises less.
 *
 * ── WHAT IS DELIBERATELY NOT TESTED HERE ─────────────────────────────────────────────
 * Filters. `resolveTimeline()` resolves membership and nothing else; the live `useFilters`
 * state is a separate client-side `applyFilters()` mask over this result (architecture §2.6,
 * P9.4). There is no filter argument to pass, and that is the design.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const migrationsFolder = `${repoRoot}server/src/db/migrations`;

/** A migrated, empty database. Nothing here ever touches `data/lifestream.db`. */
const handle: DbHandle = createDb(':memory:');
migrate(handle.db, { migrationsFolder });
afterAll(() => handle.close());

const { db } = handle;

const SPEC_SAVE = 'sav_spec';
const CYCLE_SAVE = 'sav_cycle';
const LOOP_SAVE = 'sav_loccycle';
const CACHE_SAVE = 'sav_cache';

/* ------------------------------------------------------------------ *
 * Fixture helpers. Every instant is written in the canonical
 * `YYYY-MM-DDTHH:MM:SS.mmmZ` shape the CHECK constraints enforce.
 * ------------------------------------------------------------------ */

/** The year window §2.3 derives from a year-precision date. */
const year = (y: number): [string, string] => [
  `${y}-01-01T00:01:00.000Z`,
  `${y}-12-31T23:59:00.000Z`,
];

const addSave = (id: string): void => {
  db.insert(save)
    .values({
      id,
      name: id,
      description: 'resolveTimeline fixture',
      createdAt: '2026-09-05T00:00:00.000Z',
      isArchived: false,
    })
    .run();
};

type EventSpec = {
  id: string;
  window: [string, string];
  /** The persisted roll. Inside the window, exactly as the CHECK requires. */
  when: string;
  category: 'tech' | 'political' | 'military' | 'disaster' | 'scientific' | 'cultural' | 'personal';
  precision?: 'time' | 'day' | 'month' | 'season' | 'year' | 'decade';
  locationId?: string;
  tagIds?: string[];
  saveId?: string;
};

const addEvent = (spec: EventSpec): void => {
  const saveId = spec.saveId ?? SPEC_SAVE;
  db.insert(event)
    .values({
      id: spec.id,
      saveId,
      title: spec.id,
      description: '',
      whenMin: spec.window[0],
      whenMax: spec.window[1],
      whenPrecision: spec.precision ?? 'year',
      when: spec.when,
      category: spec.category,
      techLane: null,
      locationId: spec.locationId ?? null,
      projectId: null,
    })
    .run();

  for (const tagId of spec.tagIds ?? []) {
    db.insert(eventTag).values({ saveId, eventId: spec.id, tagId }).run();
  }
};

type TimelineSpec = {
  id: string;
  kind?: 'era' | 'thread' | 'cluster';
  parents?: string[];
  roster?: string[];
  rules?: Record<string, unknown>;
  saveId?: string;
};

const addTimeline = (spec: TimelineSpec): void => {
  const saveId = spec.saveId ?? SPEC_SAVE;
  const kind = spec.kind ?? 'thread';
  db.insert(timeline)
    .values({
      id: spec.id,
      saveId,
      name: spec.id,
      kind,
      // An era must carry a start (CHECK), paired with its precision.
      eraStart: kind === 'era' ? '2035-01-01T00:00:00.000Z' : null,
      eraStartPrecision: kind === 'era' ? 'year' : null,
      membershipRules: (spec.rules ?? null) as never,
    })
    .run();

  for (const parentId of spec.parents ?? []) {
    db.insert(timelineParent).values({ saveId, timelineId: spec.id, parentId }).run();
  }
  for (const eventId of spec.roster ?? []) {
    db.insert(timelineMember).values({ saveId, timelineId: spec.id, eventId }).run();
  }
};

const addLocation = (id: string, supersededBy: string | null, saveId = SPEC_SAVE): void => {
  db.insert(location).values({ id, saveId, name: id, supersededByLocationId: supersededBy }).run();
};

/** The resolved membership as ids — what nearly every assertion below compares. */
const ids = (resolved: ResolvedTimeline): string[] => resolved.events.map((row) => row.id);

/** `resolveTimeline` against the spec save, which is what all but a few cases want. */
const resolve = (timelineId: string, saveId = SPEC_SAVE): ResolvedTimeline =>
  resolveTimeline(db, timelineId, saveId);

/* ------------------------------------------------------------------ *
 * THE WORLD.
 *
 * One save, four rename-chain locations, two global tags, thirteen events and nineteen
 * timelines — a four-level chain, a diamond, one timeline per predicate kind, and one that
 * is both a roster and a rule.
 * ------------------------------------------------------------------ */

addSave(SPEC_SAVE);

// COPI → Camp Oasis ← Disaster Ridge: two chains converging on one head, which canon has
// and the schema deliberately permits (§2.2). `loc_etna` is off the chain entirely.
addLocation('loc_camp', null);
addLocation('loc_copi', 'loc_camp');
addLocation('loc_ridge', 'loc_camp');
addLocation('loc_etna', null);

db.insert(tag).values({ id: 'tag_fusion', name: 'Fusion', color: '#3b82f6' }).run();
db.insert(tag).values({ id: 'tag_fever', name: 'Black Fever', color: '#ef4444' }).run();

// Inserted in scrambled time order on purpose: `select` returns rowid order, so a result
// that comes back sorted by `when` was sorted by the service and not by the fixture.
addEvent({ id: 'ev_late', window: year(2058), when: '2058-11-11T00:00:00.000Z', category: 'scientific' }); // prettier-ignore
addEvent({ id: 'ev_camp', window: year(2038), when: '2038-08-08T00:00:00.000Z', category: 'political', locationId: 'loc_camp' }); // prettier-ignore
addEvent({ id: 'ev_fusion_v2', window: year(2049), when: '2049-09-09T00:00:00.000Z', category: 'tech', tagIds: ['tag_fusion', 'tag_fever'] }); // prettier-ignore
addEvent({ id: 'ev_copi', window: year(2033), when: '2033-06-15T00:00:00.000Z', category: 'political', locationId: 'loc_copi' }); // prettier-ignore
addEvent({ id: 'ev_quake', window: year(2046), when: '2046-05-05T00:00:00.000Z', category: 'disaster', tagIds: ['tag_fever'] }); // prettier-ignore
addEvent({ id: 'ev_ridge', window: year(2035), when: '2035-03-02T00:00:00.000Z', category: 'military', locationId: 'loc_ridge' }); // prettier-ignore
addEvent({ id: 'ev_etna', window: year(2041), when: '2041-04-04T00:00:00.000Z', category: 'disaster', locationId: 'loc_etna', tagIds: ['tag_fever'] }); // prettier-ignore
addEvent({ id: 'ev_early', window: year(2029), when: '2029-01-05T00:00:00.000Z', category: 'personal' }); // prettier-ignore
addEvent({ id: 'ev_fusion_v1', window: year(2044), when: '2044-02-02T00:00:00.000Z', category: 'tech', tagIds: ['tag_fusion'] }); // prettier-ignore
addEvent({ id: 'ev_roster_only', window: year(2036), when: '2036-06-06T00:00:00.000Z', category: 'cultural' }); // prettier-ignore
addEvent({ id: 'ev_orphan', window: year(2032), when: '2032-02-02T00:00:00.000Z', category: 'cultural' }); // prettier-ignore

// "Sometime in the 2040s" — a decade-precision window whose ROLL (2044) sits outside the
// era range below while the WINDOW overlaps it. This is the event that separates a correct
// `byTimeRange` from one reading `when`, and §2.6 names exactly this case.
addEvent({
  id: 'ev_decade',
  window: ['2040-01-01T00:01:00.000Z', '2049-12-31T23:59:00.000Z'],
  when: '2044-07-07T00:00:00.000Z',
  precision: 'decade',
  category: 'cultural',
});

// A one-minute window opening on the range's closing instant: inclusive at both ends means
// this is a member, and a `<` where `<=` belongs drops it.
addEvent({
  id: 'ev_boundary',
  window: ['2050-01-01T00:00:00.000Z', '2050-01-01T00:01:00.000Z'],
  when: '2050-01-01T00:00:30.000Z',
  precision: 'time',
  category: 'cultural',
});

const RANGE: [string, string] = ['2045-01-01T00:00:00.000Z', '2050-01-01T00:00:00.000Z'];

// A four-level chain: world → era → cluster → deep, one roster event each.
addTimeline({ id: 'tl_world', roster: ['ev_roster_only'] });
addTimeline({ id: 'tl_era', kind: 'era', parents: ['tl_world'], roster: ['ev_camp'] });
addTimeline({ id: 'tl_cluster', kind: 'cluster', parents: ['tl_era'], roster: ['ev_etna'] });
addTimeline({ id: 'tl_deep', kind: 'cluster', parents: ['tl_cluster'], roster: ['ev_late'] });

// A diamond: tl_shared hangs under both branches, and ev_early is on both branch rosters.
addTimeline({ id: 'tl_fork' });
addTimeline({ id: 'tl_left', kind: 'cluster', parents: ['tl_fork'], roster: ['ev_early'] });
addTimeline({ id: 'tl_right', kind: 'cluster', parents: ['tl_fork'], roster: ['ev_early'] });
addTimeline({
  id: 'tl_shared',
  kind: 'cluster',
  parents: ['tl_left', 'tl_right'],
  roster: ['ev_quake'],
});

// One timeline per predicate kind, plus the two-kind conjunction and the degenerate cases.
addTimeline({ id: 'tl_tag', rules: { byTag: ['tag_fusion'] } });
addTimeline({ id: 'tl_tag_or', rules: { byTag: ['tag_fusion', 'tag_fever'] } });
addTimeline({ id: 'tl_category', rules: { byCategory: ['disaster'] } });
addTimeline({ id: 'tl_category_or', rules: { byCategory: ['disaster', 'tech'] } });
addTimeline({ id: 'tl_range', rules: { byTimeRange: RANGE } });
addTimeline({ id: 'tl_location', rules: { byLocation: ['loc_camp'] } });
addTimeline({ id: 'tl_location_etna', rules: { byLocation: ['loc_etna'] } });
addTimeline({ id: 'tl_location_mid', rules: { byLocation: ['loc_copi'] } });
addTimeline({ id: 'tl_and', rules: { byCategory: ['tech'], byTag: ['tag_fever'] } });
addTimeline({ id: 'tl_empty_rules', rules: {} });
addTimeline({ id: 'tl_both', roster: ['ev_fusion_v1'], rules: { byTag: ['tag_fusion'] } });

// A parent whose child is RULE-driven, and which carries a rule of its own. Everything
// above it is roster-driven, so without this row a resolution that recursed into
// descendants but only collected their `timeline_member` rows would still pass.
addTimeline({ id: 'tl_rollup', parents: [], rules: { byTag: ['tag_fusion'] } });
db.insert(timelineParent)
  .values({ saveId: SPEC_SAVE, timelineId: 'tl_category', parentId: 'tl_rollup' })
  .run();

/* ------------------------------------------------------------------ *
 * The cases.
 * ------------------------------------------------------------------ */

describe('DAG recursion', () => {
  it('unions this timeline with every descendant, four levels down', () => {
    // Each level adds exactly one roster event, so a recursion that stops early is a
    // shorter list rather than a different one — and the id says which level was lost.
    expect(ids(resolve('tl_deep'))).toEqual(['ev_late']);
    expect(ids(resolve('tl_cluster'))).toEqual(['ev_etna', 'ev_late']);
    expect(ids(resolve('tl_era'))).toEqual(['ev_camp', 'ev_etna', 'ev_late']);
    expect(ids(resolve('tl_world'))).toEqual(['ev_roster_only', 'ev_camp', 'ev_etna', 'ev_late']);
  });

  it('reports the closure it walked, parents and children alike', () => {
    expect(resolve('tl_world').timelineIds).toEqual([
      'tl_cluster',
      'tl_deep',
      'tl_era',
      'tl_world',
    ]);
    expect(resolve('tl_deep').timelineIds).toEqual(['tl_deep']);
  });

  it('walks descendants, never ancestors', () => {
    // tl_deep is under tl_world; resolving it must not drag the rest of the chain down.
    expect(ids(resolve('tl_deep'))).not.toContain('ev_roster_only');
  });

  it('sorts by `when`, not by insertion order', () => {
    const world = ids(resolve('tl_world'));
    expect(world).toEqual(['ev_roster_only', 'ev_camp', 'ev_etna', 'ev_late']);
    // ev_late was the first row inserted and is last here; ev_roster_only was the tenth.
    expect(world[0]).toBe('ev_roster_only');
  });
});

describe('deduplication', () => {
  it('yields an event reachable by two DAG paths exactly once', () => {
    const forked = ids(resolve('tl_fork'));
    // tl_shared is reachable through tl_left AND tl_right; ev_early is on both rosters.
    expect(forked).toEqual(['ev_early', 'ev_quake']);
    expect(forked.filter((id) => id === 'ev_quake')).toHaveLength(1);
    expect(forked.filter((id) => id === 'ev_early')).toHaveLength(1);
  });

  it('visits a diamond without mistaking it for a cycle', () => {
    // The join node is reached twice. A visited-set that raised on the second arrival would
    // fail here, which is why cycle detection tracks the OPEN PATH and not merely "seen".
    expect(resolve('tl_fork').timelineIds).toEqual(['tl_fork', 'tl_left', 'tl_right', 'tl_shared']);
  });

  it('yields an event that is both rostered and rule-matched exactly once', () => {
    expect(ids(resolve('tl_both'))).toEqual(['ev_fusion_v1', 'ev_fusion_v2']);
  });
});

describe('membership_rules — each kind in isolation', () => {
  it('byTag matches any listed tag', () => {
    expect(ids(resolve('tl_tag'))).toEqual(['ev_fusion_v1', 'ev_fusion_v2']);
    // OR within the kind: fusion OR fever.
    expect(ids(resolve('tl_tag_or'))).toEqual([
      'ev_etna',
      'ev_fusion_v1',
      'ev_quake',
      'ev_fusion_v2',
    ]);
  });

  it('byCategory matches the closed enum', () => {
    expect(ids(resolve('tl_category'))).toEqual(['ev_etna', 'ev_quake']);
    expect(ids(resolve('tl_category_or'))).toEqual([
      'ev_etna',
      'ev_fusion_v1',
      'ev_quake',
      'ev_fusion_v2',
    ]);
  });

  it('byTimeRange intersects the WINDOW, not the rolled `when`', () => {
    // ev_decade is the case §2.6 describes: known only as "the 2040s", rolled to 2044 —
    // outside the range — and a member anyway, because its window overlaps. Reading `when`
    // instead of `[when_min, when_max]` drops it, and would drop it again differently after
    // any re-roll, which is precisely the instability the window rule exists to prevent.
    expect(ids(resolve('tl_range'))).toEqual([
      'ev_decade',
      'ev_quake',
      'ev_fusion_v2',
      'ev_boundary',
    ]);

    const range = resolve('tl_range');
    expect(ids(range)).toContain('ev_decade');
    expect(range.events.find((row) => row.id === 'ev_decade')?.when).toBe(
      '2044-07-07T00:00:00.000Z',
    );
    // ev_fusion_v1's window is entirely before the range; ev_late's entirely after.
    expect(ids(range)).not.toContain('ev_fusion_v1');
    expect(ids(range)).not.toContain('ev_late');
  });

  it('byTimeRange includes both ends', () => {
    // ev_boundary opens at exactly the range's closing instant.
    const boundary = resolve('tl_range').events.find((row) => row.id === 'ev_boundary');
    expect(boundary?.whenMin).toBe(RANGE[1]);
  });

  it('byLocation resolves the rename chain to its canonical head first', () => {
    // COPI and Disaster Ridge are earlier names of Camp Oasis. A rule naming the head has
    // to return the whole site history — matching `location_id` literally returns only
    // ev_camp, a third of it (P3.5.4).
    expect(ids(resolve('tl_location'))).toEqual(['ev_copi', 'ev_ridge', 'ev_camp']);
    expect(ids(resolve('tl_location'))).not.toContain('ev_etna');
    // An off-chain location still matches by plain equality.
    expect(ids(resolve('tl_location_etna'))).toEqual(['ev_etna']);
  });

  it('byLocation naming a SUPERSEDED id means the PLACE, not nothing', () => {
    // Decided 2026-09-05, and this is the line the previous version said the decision would
    // be made on. BOTH sides resolve to the canonical head, so naming any name of a site
    // means the site. Resolving only the event side made every earlier name silently match
    // nothing — every event there collapses to the head, so only a rule naming the head
    // could ever hit — which is the silently-empty failure this codebase refuses elsewhere
    // and contradicts §2.2's own reason for the chain.
    expect(ids(resolve('tl_location_mid'))).toEqual(['ev_copi', 'ev_ridge', 'ev_camp']);
    // ...and it agrees with the rule written against the head, because they name one place.
    expect(ids(resolve('tl_location_mid'))).toEqual(ids(resolve('tl_location')));
    // "only while it was called COPI" is still expressible: byLocation AND byTimeRange.
    expect(ids(resolve('tl_location_mid'))).not.toContain('ev_etna');
  });
});

describe('membership_rules — combined', () => {
  it('ANDs across kinds while ORing within one', () => {
    // tech AND fever-tagged. ev_fusion_v1 is tech but untagged with fever; ev_quake and
    // ev_etna are fever-tagged but not tech. An OR here would return four events.
    expect(ids(resolve('tl_and'))).toEqual(['ev_fusion_v2']);
  });

  it('unions the manual roster with the rule matches', () => {
    expect(ids(resolve('tl_both'))).toEqual(['ev_fusion_v1', 'ev_fusion_v2']);
  });

  it("collects a DESCENDANT's rule matches, not merely its roster", () => {
    // tl_rollup contributes its own byTag rule; tl_category, its only child, contributes a
    // byCategory one. Nothing here is on any roster — a recursion that walked the DAG but
    // read only `timeline_member` on the way down would answer with the two fusion events
    // and quietly lose the disasters.
    expect(ids(resolve('tl_rollup'))).toEqual([
      'ev_etna',
      'ev_fusion_v1',
      'ev_quake',
      'ev_fusion_v2',
    ]);
    expect(resolve('tl_rollup').timelineIds).toEqual(['tl_category', 'tl_rollup']);
  });

  it('treats a rules object with no predicates as matching nothing', () => {
    // An empty conjunction is literally "everything", which would sweep the whole save into
    // any timeline whose rules were cleared. `{}` is read as "no rules" instead (§2.6).
    expect(ids(resolve('tl_empty_rules'))).toEqual([]);
  });
});

describe('cycles raise rather than hang', () => {
  addSave(CYCLE_SAVE);
  addTimeline({ id: 'tl_a', saveId: CYCLE_SAVE });
  addTimeline({ id: 'tl_b', saveId: CYCLE_SAVE, parents: ['tl_a'] });
  addTimeline({ id: 'tl_c', saveId: CYCLE_SAVE, parents: ['tl_b'] });
  // …and back: tl_a's parent is tl_c, so a → b → c → a.
  db.insert(timelineParent)
    .values({ saveId: CYCLE_SAVE, timelineId: 'tl_a', parentId: 'tl_c' })
    .run();

  // A cycle that does NOT include the entry point: tl_head → tl_x ⇄ tl_y.
  addTimeline({ id: 'tl_head', saveId: CYCLE_SAVE });
  addTimeline({ id: 'tl_x', saveId: CYCLE_SAVE, parents: ['tl_head'] });
  addTimeline({ id: 'tl_y', saveId: CYCLE_SAVE, parents: ['tl_x'] });
  db.insert(timelineParent)
    .values({ saveId: CYCLE_SAVE, timelineId: 'tl_x', parentId: 'tl_y' })
    .run();

  // ── WHAT THE TIMEOUTS DO AND DO NOT CATCH ──────────────────────────────────────────
  // They catch the regressions that still return: a plain visited set that absorbs the
  // cycle and answers with a plausible set (`expected function to throw`), a guard removed
  // entirely so the recursion overflows the stack (`RangeError`, not a cycle error), and
  // anything that merely becomes pathologically slow. VERIFIED by mutating all three.
  //
  // They do NOT catch a traversal rewritten as a SYNCHRONOUS unguarded loop. Vitest's test
  // timeout is a timer, and a timer cannot preempt synchronous JavaScript — a `while` loop
  // over a queue that never empties wedges the worker and no `{ timeout }` value changes
  // that (verified too: that mutation hangs the run rather than failing it). Nothing in
  // this harness can catch that case, which is exactly why the implementation is written
  // so it cannot happen — the two marks in `closureOf` make an unbounded walk
  // unrepresentable rather than merely unlikely.
  it('raises on a cycle through the entry point', { timeout: 5000 }, () => {
    expect(() => resolve('tl_a', CYCLE_SAVE)).toThrow(TimelineCycleError);
    try {
      resolve('tl_a', CYCLE_SAVE);
      expect.unreachable('a cycle must not resolve');
    } catch (error) {
      expect(error).toBeInstanceOf(TimelineCycleError);
      // The message names the loop, so the write-time rejection (P12.9) has something to
      // quote and a corrupt save is one line to diagnose.
      expect((error as TimelineCycleError).cycle).toEqual(['tl_a', 'tl_b', 'tl_c', 'tl_a']);
    }
  });

  it('raises on a cycle further down the DAG', { timeout: 5000 }, () => {
    expect(() => resolve('tl_head', CYCLE_SAVE)).toThrow(TimelineCycleError);
  });

  it('raises on a looping location rename chain', { timeout: 5000 }, () => {
    addSave(LOOP_SAVE);
    addLocation('loc_p', null, LOOP_SAVE);
    addLocation('loc_q', 'loc_p', LOOP_SAVE);
    // Closing the loop needs a second statement: the composite FK requires the target row
    // to exist, and the schema only forbids the one-row case (`id <> superseded_by`).
    db.update(location)
      .set({ supersededByLocationId: 'loc_q' })
      .where(and(eq(location.saveId, LOOP_SAVE), eq(location.id, 'loc_p')))
      .run();
    addTimeline({ id: 'tl_loop', saveId: LOOP_SAVE, rules: { byLocation: ['loc_p'] } });

    expect(() => resolveTimeline(db, 'tl_loop', LOOP_SAVE)).toThrow(LocationChainCycleError);
  });
});

describe('unknown timelines', () => {
  it('raises rather than answering an empty set', () => {
    // An empty membership set is a legitimate answer for a real timeline, so a missing one
    // has to be a different outcome or the route can never tell 404 from "nothing in it".
    expect(() => resolve('tl_nonexistent')).toThrow(TimelineNotFoundError);
    // Right id, wrong save: the save scopes the lookup.
    expect(() => resolve('tl_world', CYCLE_SAVE)).toThrow(TimelineNotFoundError);
  });
});

describe('the reverse index (also-in)', () => {
  it('maps an event to every timeline that contains it, inherited membership included', () => {
    const index = timelinesByEvent(db, SPEC_SAVE);

    // ev_late is rostered on tl_deep only, and is therefore in the three timelines above it.
    expect([...(index.get('ev_late') ?? [])].sort()).toEqual([
      'tl_cluster',
      'tl_deep',
      'tl_era',
      'tl_world',
    ]);

    // ev_quake arrives by both routes at once: a roster (tl_shared, and the diamond above
    // it) and four rules.
    expect([...(index.get('ev_quake') ?? [])].sort()).toEqual([
      'tl_category',
      'tl_category_or',
      'tl_fork',
      'tl_left',
      'tl_range',
      'tl_right',
      'tl_rollup',
      'tl_shared',
      'tl_tag_or',
    ]);

    // …and NOT tl_world: the diamond is its own root, so the four-level chain never
    // reaches ev_quake. An "also in" that walked ancestors of ancestors indiscriminately
    // — or one that unioned the whole save — would add it here.
    expect(index.get('ev_quake')?.has('tl_world')).toBe(false);
  });

  it('has no entry for an event in no timeline', () => {
    expect(timelinesByEvent(db, SPEC_SAVE).has('ev_orphan')).toBe(false);
  });
});

describe('the memo cache', () => {
  it('is keyed by (save, timeline) and dropped by an explicit invalidation', () => {
    addSave(CACHE_SAVE);
    addTimeline({ id: 'tl_cache', saveId: CACHE_SAVE, rules: { byCategory: ['tech'] } });
    addEvent({
      id: 'ev_cache_1',
      saveId: CACHE_SAVE,
      window: year(2040),
      when: '2040-01-02T00:00:00.000Z',
      category: 'tech',
    });

    const first = resolveTimeline(db, 'tl_cache', CACHE_SAVE);
    expect(ids(first)).toEqual(['ev_cache_1']);
    // Same object, not merely an equal one — the memo is real.
    expect(resolveTimeline(db, 'tl_cache', CACHE_SAVE)).toBe(first);

    addEvent({
      id: 'ev_cache_2',
      saveId: CACHE_SAVE,
      window: year(2041),
      when: '2041-01-02T00:00:00.000Z',
      category: 'tech',
    });

    // A write with no invalidation is still the cached answer. This is the contract, not a
    // bug: the cache is dropped by the WRITER (P3.5.1), which is why every per-save write
    // has to call `invalidateSave`.
    expect(ids(resolveTimeline(db, 'tl_cache', CACHE_SAVE))).toEqual(['ev_cache_1']);

    invalidateSave(db, CACHE_SAVE);
    expect(ids(resolveTimeline(db, 'tl_cache', CACHE_SAVE))).toEqual(['ev_cache_1', 'ev_cache_2']);

    // Invalidating one save leaves the others alone.
    const spec = resolve('tl_world');
    invalidateSave(db, CACHE_SAVE);
    expect(resolve('tl_world')).toBe(spec);

    invalidateAllSaves(db);
    expect(resolve('tl_world')).not.toBe(spec);
    expect(ids(resolve('tl_world'))).toEqual(ids(spec));
  });

  it('hands back a frozen result, so a caller cannot corrupt the cache', () => {
    const resolved = resolve('tl_world');
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.events)).toBe(true);
  });
});
