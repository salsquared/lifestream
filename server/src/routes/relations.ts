/**
 * `/api/relations` — event-to-event relations (`precedes` / `partOf` / `renames`).
 *
 * P3.6.3 fills in the read. Writes (which validate `precedes` ordering at write time)
 * land in P12. See architecture.html §2.3, §2.6, §5.2.
 *
 * ── ONE ROW PER EDGE, AND THE DIRECTION FILTER IS WHY THAT WORKS ──────────────────────
 * `relation` stores every edge ONCE in a canonical direction: `precedes` from=A to=B
 * means "A precedes B" / "B succeeds A" (§2.6). There are no mirror rows, so "what
 * succeeds X?" is not a second table — it is this endpoint with `?event=X&direction=to`,
 * a SELECT against the same row. That is the whole reason the direction filter exists,
 * and it is why it names the COLUMN END (`from` / `to`) rather than a semantic like
 * "successors": the semantics differ per `type` (a `partOf` edge's `to` is the parent,
 * a `precedes` edge's `to` is the later event), while the column end is the same fact
 * for all three and is one grep from the schema.
 */
import { and, asc, eq, or } from 'drizzle-orm';
import { Hono } from 'hono';

import type { Relation } from '@shared/types/index';

import { db } from '../db/index.js';
import { event, relation } from '../db/schema.js';

import { dropNulls, resolveSave } from './common.js';

export type RelationsResponse = { relations: Relation[] };

/**
 * `?direction=` — which END of the edge the anchor event has to occupy.
 *
 * `from` is the outbound half ("what does X precede / what is X part of"), `to` the
 * inbound half ("what succeeds X / what is part of X"), `both` the union. `both` is the
 * default because it is the whole neighbourhood of a node, which is what a side panel
 * draws.
 */
const DIRECTIONS = ['from', 'to', 'both'] as const;
type Direction = (typeof DIRECTIONS)[number];

function isDirection(raw: string): raw is Direction {
  return (DIRECTIONS as readonly string[]).includes(raw);
}

export const relationRoutes = new Hono();

/**
 * `GET /api/relations` — the save's edges; `?event=` narrows to one node's neighbourhood.
 *
 * WITHOUT `?event=` this is the whole edge list for the save, which is what `useWorld`
 * holds (§4.2): the Tech Tree draws every `precedes` between tech events and the Corridor
 * draws arcs over the resolved set, and both work off one in-memory list rather than a
 * request per node. At ~50–500 events per save that list is small.
 *
 * EVERY FAILURE HERE IS LOUD, and each of the three is a client bug that would otherwise
 * present as an empty graph:
 *   · an unknown `direction` is a 400 naming the accepted values, never a silent fall
 *     back to `both` — a typo would return a superset of what was asked for and the
 *     caller would render it as if it had been filtered;
 *   · `direction` WITHOUT `event` is a 400, because there is no anchor for it to be a
 *     direction relative to, and quietly ignoring it is how a filter gets believed;
 *   · `?event=` naming an event that is not in this save is a 404, not `{ relations: [] }`.
 *     An id that no longer resolves is exactly what a fork produces (§2.6), and a node
 *     with genuinely no edges is indistinguishable from a stale id unless one of them
 *     raises.
 *
 * Ordered by `(from, to, type)` — the columns of `relation_edge_unique`, so the order is
 * total and stable. The row id is a generated string and sorts arbitrarily.
 */
relationRoutes.get('/', (c) => {
  const scope = resolveSave(c.req.query('save'));
  if (!scope.ok) return c.json({ error: scope.error }, scope.status);

  const rawEvent = c.req.query('event');
  const eventId = rawEvent === undefined || rawEvent === '' ? undefined : rawEvent;

  const rawDirection = c.req.query('direction');
  if (rawDirection !== undefined && rawDirection !== '' && !isDirection(rawDirection)) {
    return c.json(
      { error: `invalid 'direction' '${rawDirection}': expected one of ${DIRECTIONS.join(', ')}` },
      400,
    );
  }
  if (rawDirection !== undefined && rawDirection !== '' && eventId === undefined) {
    return c.json({ error: "query parameter 'direction' requires 'event'" }, 400);
  }
  const direction: Direction =
    rawDirection === undefined || rawDirection === '' ? 'both' : rawDirection;

  if (eventId !== undefined) {
    const anchor = db
      .select({ id: event.id })
      .from(event)
      .where(and(eq(event.saveId, scope.saveId), eq(event.id, eventId)))
      .get();

    if (anchor === undefined) {
      return c.json({ error: `no event with id '${eventId}' in save '${scope.saveId}'` }, 404);
    }
  }

  const anchored =
    eventId === undefined
      ? undefined
      : direction === 'from'
        ? eq(relation.fromEventId, eventId)
        : direction === 'to'
          ? eq(relation.toEventId, eventId)
          : or(eq(relation.fromEventId, eventId), eq(relation.toEventId, eventId));

  const rows = db
    .select()
    .from(relation)
    .where(and(eq(relation.saveId, scope.saveId), anchored))
    .orderBy(asc(relation.fromEventId), asc(relation.toEventId), asc(relation.type))
    .all();

  const relations: Relation[] = rows.map(dropNulls);
  return c.json({ relations } satisfies RelationsResponse);
});
