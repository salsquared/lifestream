/**
 * `/api/timelines` — the timeline DAG rows plus `GET /:id/resolve`.
 *
 * P3.6.2 fills in the three reads; the Corridor consumes them from P4. Writes — including
 * the write-time rejection of `timeline_parent` cycles (P12.9) — land in P12. See
 * architecture.html §2.3, §2.6, §5.2.
 *
 * ── THE ROOT IS STRUCTURAL, SO THE EDGES SHIP ─────────────────────────────────────────
 * A save's DAG root (`tl_world`) is the timeline with NO row in `timeline_parent` — never
 * inferred from `kind`, which is `'thread'` on the root for schema simplicity, and never
 * from a hard-coded id, so a save that renames or replaces its root still behaves (§2.3,
 * P3.4.1). The Corridor's thread stratum has to exclude it (§5.2), which means the client
 * has to be able to identify it — so the list read answers with the `timeline_parent` rows
 * beside the timeline rows rather than with an `isRoot` flag. A flag would be derived
 * state on the wire, and it would answer exactly one of the questions the edges answer:
 * the breadcrumb, the timeline tray's nesting and the era→thread→cluster descent all read
 * the same rows.
 *
 * The shape is the one `/api/map/groupings` set (§5.1): the join table VERBATIM, and the
 * client builds whatever index it wants from it. The reverse is not possible.
 *
 * ── MEMBERSHIP HAS EXACTLY ONE IMPLEMENTATION AND IT IS NOT HERE ──────────────────────
 * `/resolve` calls `resolveTimeline()` (P3.5) and does nothing else. `timeline_member` on
 * the detail read is the MANUAL ROSTER — one half of membership, useful to an editor that
 * has to show what was hand-added — and it is named `members` rather than anything
 * suggesting it is the resolved set. Anything drawing a timeline reads `/resolve`.
 */
import { and, asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import type { HydratedEvent, Timeline, TimelineMember, TimelineParent } from '@shared/types/index';

import { db } from '../db/index.js';
import { timeline, timelineMember, timelineParent } from '../db/schema.js';
import {
  LocationChainCycleError,
  TimelineCycleError,
  resolveTimeline,
} from '../services/resolveTimeline.js';

import { dropNulls, resolveSave } from './common.js';
import { hydrate } from './events.js';

/**
 * `GET /api/timelines` — the save's timelines and the DAG edges between them.
 *
 * `parents` is `timeline_parent` verbatim: one row per edge, `timelineId` the child and
 * `parentId` the parent. See the header for why the edges travel rather than a flag.
 */
export type TimelinesResponse = { timelines: Timeline[]; parents: TimelineParent[] };

/**
 * `GET /api/timelines/:id` — one timeline and the rows that point at it.
 *
 * `parents` are the edges where this timeline is the CHILD, `children` those where it is
 * the parent — both `timeline_parent` rows verbatim, so a caller never has to guess which
 * end of an edge it is holding. `members` is the manual roster only (see the header).
 */
export type TimelineDetailResponse = {
  timeline: Timeline;
  parents: TimelineParent[];
  children: TimelineParent[];
  members: TimelineMember[];
};

/**
 * `GET /api/timelines/:id/resolve` — the resolved membership set (§2.6, §5.2).
 *
 * `timelineIds` IS THE DAG CLOSURE THAT WAS UNIONED — this timeline and every descendant,
 * which is what "its members are its child timelines, not a hand roster" (P3.4.1) means in
 * practice. `resolveTimeline()` computes it to do its job and the alternative to sending
 * it is the client re-walking `timeline_parent` to find out what it just received, which
 * is a second implementation of the closure and therefore a second answer to "what is in
 * this timeline" — the thing §5.2 says must have one.
 *
 * `events` are `HydratedEvent`s in `when` order, the same shape `/api/events` answers with.
 * NO FILTERS ARE APPLIED and none may be sent: category chips, the tag filter, the time
 * scrub and the search box are a client-side `applyFilters()` mask over this result (§2.6,
 * P9.4). Filtering here would put keystroke-frequency state into a memo key that exists
 * precisely because membership changes only on a write.
 */
export type TimelineResolveResponse = {
  timeline: Timeline;
  timelineIds: string[];
  events: HydratedEvent[];
};

export const timelineRoutes = new Hono();

/**
 * `GET /api/timelines` — every timeline in the save, plus every DAG edge.
 *
 * Timelines are ordered by `(name, id)`: `timeline.name` carries no UNIQUE constraint, so
 * the id is what makes the order total. Edges are ordered by `(parentId, timelineId)`,
 * which groups a parent's children together — the order a tray renders them in.
 */
timelineRoutes.get('/', (c) => {
  const scope = resolveSave(c.req.query('save'));
  if (!scope.ok) return c.json({ error: scope.error }, scope.status);

  const timelineRows = db
    .select()
    .from(timeline)
    .where(eq(timeline.saveId, scope.saveId))
    .orderBy(asc(timeline.name), asc(timeline.id))
    .all();

  const parents = db
    .select()
    .from(timelineParent)
    .where(eq(timelineParent.saveId, scope.saveId))
    .orderBy(asc(timelineParent.parentId), asc(timelineParent.timelineId))
    .all();

  const timelines: Timeline[] = timelineRows.map(dropNulls);
  return c.json({ timelines, parents } satisfies TimelinesResponse);
});

/**
 * `GET /api/timelines/:id/resolve` — membership, from `resolveTimeline()` and nowhere else.
 *
 * Registered BEFORE `/:id` for readability only — Hono matches on segment count, so the
 * two patterns cannot collide whatever the order.
 *
 * A CYCLE IS A 500, NOT A 4xx, and it names the cycle. `timeline_parent` cycles are
 * rejected at write time (P12.9) and a `superseded_by_location_id` chain that loops is
 * likewise refused, so reaching either error here means the stored DAG is already corrupt
 * — nothing about the request was wrong and no retry helps. It is caught rather than left
 * to Hono's default handler because that one answers `text/plain`, which the client's
 * transport rejects as "expected JSON": the diagnosis would arrive as a content-type
 * complaint with the named cycle discarded.
 */
timelineRoutes.get('/:id/resolve', (c) => {
  const scope = resolveSave(c.req.query('save'));
  if (!scope.ok) return c.json({ error: scope.error }, scope.status);

  const id = c.req.param('id');
  const row = db
    .select()
    .from(timeline)
    .where(and(eq(timeline.saveId, scope.saveId), eq(timeline.id, id)))
    .get();

  if (row === undefined) {
    return c.json({ error: `no timeline with id '${id}' in save '${scope.saveId}'` }, 404);
  }

  try {
    const resolved = resolveTimeline(db, id, scope.saveId);

    return c.json({
      timeline: dropNulls(row),
      timelineIds: [...resolved.timelineIds],
      events: hydrate(scope.saveId, resolved.events),
    } satisfies TimelineResolveResponse);
  } catch (cause) {
    if (cause instanceof TimelineCycleError || cause instanceof LocationChainCycleError) {
      return c.json({ error: cause.message }, 500);
    }
    throw cause;
  }
});

/**
 * `GET /api/timelines/:id` — one timeline, its edges in both directions, and its roster.
 *
 * `members` is `timeline_member` VERBATIM and is not the resolved set — see the header.
 * It is here because it is the only half of membership an editor can write to: rules are
 * a JSON predicate on the timeline row above, and the roster is a list of rows somebody
 * added by hand. A panel that could not read it back could not offer to remove one.
 */
timelineRoutes.get('/:id', (c) => {
  const scope = resolveSave(c.req.query('save'));
  if (!scope.ok) return c.json({ error: scope.error }, scope.status);

  const id = c.req.param('id');
  const row = db
    .select()
    .from(timeline)
    .where(and(eq(timeline.saveId, scope.saveId), eq(timeline.id, id)))
    .get();

  if (row === undefined) {
    return c.json({ error: `no timeline with id '${id}' in save '${scope.saveId}'` }, 404);
  }

  const parents = db
    .select()
    .from(timelineParent)
    .where(and(eq(timelineParent.saveId, scope.saveId), eq(timelineParent.timelineId, id)))
    .orderBy(asc(timelineParent.parentId))
    .all();

  const children = db
    .select()
    .from(timelineParent)
    .where(and(eq(timelineParent.saveId, scope.saveId), eq(timelineParent.parentId, id)))
    .orderBy(asc(timelineParent.timelineId))
    .all();

  const members = db
    .select()
    .from(timelineMember)
    .where(and(eq(timelineMember.saveId, scope.saveId), eq(timelineMember.timelineId, id)))
    .orderBy(asc(timelineMember.eventId))
    .all();

  return c.json({
    timeline: dropNulls(row),
    parents,
    children,
    members,
  } satisfies TimelineDetailResponse);
});
