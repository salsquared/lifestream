/**
 * The relation read (P3.6.3) — architecture §5.2, §2.6.
 *
 * `relation` stores every edge ONCE in a canonical direction: `precedes` from=A to=B means
 * "A precedes B" / "B succeeds A" (§2.6). There are no mirror rows, so "what succeeds X?"
 * is this endpoint with `?event=X&direction=to` — a SELECT against the same row rather
 * than a second table to keep consistent.
 */
import type { Relation } from '@shared/types/index';

import { getGlobal, type RequestOptions } from './client';
import { arrayField } from './envelope';

const RELATIONS_URL = '/api/relations';

/**
 * Which END of the edge the anchor event has to occupy.
 *
 * `from` is the outbound half ("what does X precede, what is X part of"), `to` the inbound
 * half ("what succeeds X, what is part of X"), `both` the whole neighbourhood — the
 * default, and what a side panel draws. It names the column end rather than a semantic
 * like "successors" because the semantics differ per `type` (a `partOf` edge's `to` is the
 * parent; a `precedes` edge's `to` is the later event) while the column end does not.
 */
export type RelationDirection = 'from' | 'to' | 'both';

/** What {@link fetchRelations} narrows by. Omit `event` for the save's whole edge list. */
export type RelationQuery = {
  /** An event id. A `direction` without one is refused by the server, loudly. */
  event?: string;
  /** Only meaningful with `event`; defaults to `both`. */
  direction?: RelationDirection;
};

/**
 * `GET /api/relations` — the save's edges, optionally narrowed to one event.
 *
 * Without `event` this is the whole edge list, which is what `useWorld` holds (§4.2): the
 * Tech Tree draws every `precedes` between tech events and the Corridor draws arcs over
 * the resolved set, both off one in-memory list.
 *
 * An `event` id that is not in this save is a 404, not an empty list, and the `ApiError`
 * carries it through — a node with genuinely no edges is otherwise indistinguishable from
 * an id a fork invalidated (§2.6).
 *
 * ── WHY THIS ONE READ DOES NOT GO THROUGH `getForSave` ────────────────────────────────
 * `getForSave` builds its URL as `path + '?' + 'save=…'`, with an unconditional `?`,
 * documented as safe because "none of the specified reads take another parameter". §5.2's
 * `GET /api/relations?event=:id` is the read that broke that assumption — appending
 * `?save=` to a path that already carries a query string produces a second `?` and a
 * parameter named `?save`. So this call assembles its own query string and goes through
 * `getGlobal`, which appends nothing.
 *
 * NOTHING ABOUT THE SCOPE DISCIPLINE IS RELAXED. `saveId` is still a required argument, it
 * is still written into every request, and it is still the caller's captured value rather
 * than a re-read of the store (§4.2) — only the place the string is built moved. The real
 * fix is a `params` argument on `getForSave`; the transport is another lane's file, and
 * P3.6 is the task that found the gap.
 */
export async function fetchRelations(
  saveId: string,
  query: RelationQuery = {},
  options?: RequestOptions,
): Promise<Relation[]> {
  const params = new URLSearchParams({ save: saveId });
  if (query.event !== undefined) params.set('event', query.event);
  if (query.direction !== undefined) params.set('direction', query.direction);

  const url = `${RELATIONS_URL}?${params.toString()}`;
  const body = await getGlobal(url, options);

  return arrayField<Relation>(body, 'relations', url);
}
