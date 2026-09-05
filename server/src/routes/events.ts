/**
 * `/api/events` — event rows, hydrated with their join ids.
 *
 * P3.6.1 fills in the two reads. The write surface — `POST`/`PATCH`/`DELETE`,
 * `POST /:id/reroll` and `PUT /:id/tags` — lands in P12 (editors). Endpoint list:
 * architecture.html §5.2.
 *
 * ── EVERY EVENT ON THE WIRE IS A `HydratedEvent` ──────────────────────────────────────
 * The row plus its `actorIds[]` and `tagIds[]`. That is not a convenience: glow is a
 * purely client-side derived selector (§2.6), and it can only be one because each event
 * payload already carries what it touches — `actorIds`, `tagIds`, `locationId`,
 * `projectId`. A payload of bare `event` rows would force a join query per selection and
 * there would have to be a glow endpoint. At ~50–500 events per save the whole list is
 * small enough to hold in `useWorld` (§4.2), which is what makes one shell-level load
 * serve all four views.
 *
 * `hydrate()` below is exported because `GET /api/timelines/:id/resolve` answers with the
 * same shape (`routes/timelines.ts`) — an event must not be one shape on one endpoint and
 * another shape on the next.
 *
 * ── ALL FOUR DATE COLUMNS, NEVER A FORMATTED STRING ───────────────────────────────────
 * `whenMin`, `whenMax`, `whenPrecision` and `when` all travel, and none of them is
 * rendered here. Under render-by-precision (§2.3) the view prints according to
 * `whenPrecision` — a year-precision event reads "2036", not the January-1 instant its
 * window starts at — and `when` is a SEEDED ROLL inside `[whenMin, whenMax]` that exists
 * to position a node, never to be printed. Formatting server-side would fabricate a
 * timestamp the Bible does not contain, and the window it was rolled from would be gone
 * from the payload that could have corrected it.
 *
 * ── THE WIRE FORMAT IS camelCase ──────────────────────────────────────────────────────
 * SQL columns are snake_case and stay inside `db/schema.ts`; Drizzle's inferred row types
 * are already camelCase, so these handlers return them VERBATIM (the wire-format
 * decision). The one adjustment is nullability — `dropNulls`, see `common.ts`.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';

import type { HydratedEvent, Timeline } from '@shared/types/index';

import { db } from '../db/index.js';
import { event, eventActor, eventTag, timeline } from '../db/schema.js';
import type { StoredEvent } from '../services/resolveTimeline.js';
import {
  LocationChainCycleError,
  TimelineCycleError,
  timelinesByEvent,
} from '../services/resolveTimeline.js';

import { dropNulls, resolveSave } from './common.js';

export type EventsResponse = { events: HydratedEvent[] };

/**
 * `GET /api/events/:id` — one event, plus the timelines that contain it.
 *
 * `alsoIn` is FULL TIMELINE ROWS, not ids. The pills that render it name the timeline's
 * `kind` as well as its name (P8.3), so an era, a thread and a cluster are distinguishable
 * at a glance — and a detail read that answered with ids would make the panel fetch the
 * timeline list before it could draw a label.
 */
export type EventResponse = { event: HydratedEvent; alsoIn: Timeline[] };

export const eventRoutes = new Hono();

/**
 * Attach `actorIds` / `tagIds` to stored rows, in one pass over two indexed reads.
 *
 * Shared with `routes/timelines.ts`, which answers `/resolve` with the same shape.
 *
 * `actorIds` IS DEDUPLICATED AND THAT IS NOT DEFENSIVE. `event_actor`'s primary key is
 * `(event_id, character_id, role)` and `role` is free text, so one person holding two
 * roles in one event — the leader who is also a victim (§2.5) — is two legitimate rows for
 * one actor. `actorIds` answers "who appears in this event", so it is a set; the roles
 * themselves belong to the event side panel's read, which lands with the editors in P12.
 *
 * Both id lists are sorted, so the payload for an unchanged event is byte-identical
 * between requests — join tables have no inherent row order, and an unstable list would
 * churn every memo and diff downstream of it.
 */
export function hydrate(saveId: string, rows: readonly StoredEvent[]): HydratedEvent[] {
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);

  const actorRows = db
    .select({ eventId: eventActor.eventId, characterId: eventActor.characterId })
    .from(eventActor)
    .where(and(eq(eventActor.saveId, saveId), inArray(eventActor.eventId, ids)))
    .all();

  const tagRows = db
    .select({ eventId: eventTag.eventId, tagId: eventTag.tagId })
    .from(eventTag)
    .where(and(eq(eventTag.saveId, saveId), inArray(eventTag.eventId, ids)))
    .all();

  const actorsOf = groupBy(
    actorRows,
    (row) => row.eventId,
    (row) => row.characterId,
  );
  const tagsOf = groupBy(
    tagRows,
    (row) => row.eventId,
    (row) => row.tagId,
  );

  return rows.map((row) => ({
    ...dropNulls(row),
    actorIds: [...(actorsOf.get(row.id) ?? [])].sort(compare),
    tagIds: [...(tagsOf.get(row.id) ?? [])].sort(compare),
  }));
}

/** `rows -> Map<key, Set<value>>`, the shape both join tables collapse into. */
function groupBy<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  valueOf: (row: T) => string,
): Map<string, Set<string>> {
  const grouped = new Map<string, Set<string>>();

  for (const row of rows) {
    const key = keyOf(row);
    const values = grouped.get(key);
    if (values === undefined) grouped.set(key, new Set([valueOf(row)]));
    else values.add(valueOf(row));
  }

  return grouped;
}

/** Bytewise, like every other ordering in this codebase: ids are TEXT and locale-free. */
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * `GET /api/events` — every event in the save, in `when` order.
 *
 * Ordered by `(when, id)`, the same total order `resolveTimeline()` puts its membership
 * sets in. Two events can share a roll — `rollDate` is seeded per event and nothing stops
 * two of them landing on the same instant — so the id tiebreak is what keeps the two
 * orderings from disagreeing about a pair the Corridor draws side by side.
 *
 * `when` is the SORT KEY and not the display value (§2.3); see the header.
 */
eventRoutes.get('/', (c) => {
  const scope = resolveSave(c.req.query('save'));
  if (!scope.ok) return c.json({ error: scope.error }, scope.status);

  const rows = db
    .select()
    .from(event)
    .where(eq(event.saveId, scope.saveId))
    .orderBy(asc(event.when), asc(event.id))
    .all();

  return c.json({ events: hydrate(scope.saveId, rows) } satisfies EventsResponse);
});

/**
 * `GET /api/events/:id` — one event and its "also in" timelines.
 *
 * `alsoIn` COMES FROM `resolveTimeline()`, through the reverse index it builds (P3.5.2),
 * and deliberately not from a `timeline_member` lookup. Membership is the union of the
 * manual roster with whatever `membership_rules` matches, closed over the `timeline_parent`
 * DAG (§2.6) — so an event nobody ever added to a roster is still in the era whose
 * `byTimeRange` covers it, and is also in every ancestor of that era. Reading the roster
 * table instead would answer with the small hand-typed subset and call it the truth, which
 * is precisely the second definition of membership §5.2 forbids.
 *
 * The index covers the whole save and is memoized beside the per-timeline results, so the
 * first detail read after a write pays for resolving the save's timelines once and every
 * read after it is a map lookup.
 *
 * A CYCLE IS A 500 THAT NAMES THE CYCLE, exactly as on `/api/timelines/:id/resolve`. The
 * index resolves EVERY timeline in the save, so a corrupt DAG anywhere fails this read
 * even though the event itself is fine — and it has to be caught here rather than left to
 * Hono's default handler, which answers `text/plain` and would have the client transport
 * report a content-type complaint with the named cycle thrown away.
 */
eventRoutes.get('/:id', (c) => {
  const scope = resolveSave(c.req.query('save'));
  if (!scope.ok) return c.json({ error: scope.error }, scope.status);

  const id = c.req.param('id');
  const row = db
    .select()
    .from(event)
    .where(and(eq(event.saveId, scope.saveId), eq(event.id, id)))
    .get();

  if (row === undefined) {
    return c.json({ error: `no event with id '${id}' in save '${scope.saveId}'` }, 404);
  }

  const hydrated = hydrate(scope.saveId, [row])[0];
  if (hydrated === undefined) {
    // Unreachable: `hydrate` is 1:1 on its input. `noUncheckedIndexedAccess` cannot know
    // that, and a non-null assertion here would be the one place in this module claiming
    // something the compiler is right to doubt.
    return c.json({ error: `failed to hydrate event '${id}'` }, 500);
  }

  let timelineIds: string[];
  try {
    timelineIds = [...(timelinesByEvent(db, scope.saveId).get(id) ?? [])];
  } catch (cause) {
    if (cause instanceof TimelineCycleError || cause instanceof LocationChainCycleError) {
      return c.json({ error: cause.message }, 500);
    }
    throw cause;
  }

  const alsoIn: Timeline[] =
    timelineIds.length === 0
      ? []
      : db
          .select()
          .from(timeline)
          .where(and(eq(timeline.saveId, scope.saveId), inArray(timeline.id, timelineIds)))
          .orderBy(asc(timeline.name), asc(timeline.id))
          .all()
          .map(dropNulls);

  return c.json({ event: hydrated, alsoIn } satisfies EventResponse);
});
