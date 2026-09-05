/**
 * The event reads (P3.6.1) — architecture §5.2.
 *
 * URLs are the ones the specification gives, written out in full: they come from §5.2 and
 * not from the server's route filenames (§4.4), so a drifted prefix is one grep away.
 *
 * Entity types come from `@shared/types/index` and are never redeclared — the same types
 * the Drizzle schema is conformed against in `server/src/db/conformance.ts`, so the shapes
 * below are checked against the columns rather than merely believed. camelCase end to end.
 *
 * ── AN EVENT ARRIVES AS A `HydratedEvent`, WITH ALL FOUR DATE COLUMNS ─────────────────
 * `whenMin`, `whenMax`, `whenPrecision` and `when` all travel, unformatted. Rendering is
 * BY PRECISION (§2.3): a year-precision event reads "2036", and `when` is a seeded roll
 * inside the window that exists to position a node and must never be printed. A view that
 * wants a label formats it from the precision; there is no formatted string on the wire to
 * be tempted by.
 *
 * `actorIds` / `tagIds` ride along on every event, which is what makes glow a purely
 * client-side selector (§2.6) — no glow endpoint, no join query per selection.
 */
import type { HydratedEvent, Timeline } from '@shared/types/index';

import { getForSave, type RequestOptions } from './client';
import { arrayField, objectField, segment } from './envelope';

const EVENTS_URL = '/api/events';

/**
 * `GET /api/events/:id` — one event and the timelines that contain it.
 *
 * `alsoIn` is the "also in" set (P3.5.2, P8.3), and it is MEMBERSHIP, not the manual
 * roster: an event nobody hand-added is still in the era whose `byTimeRange` covers it,
 * and in every ancestor of that era. Full timeline rows, so a pill can name the `kind`
 * alongside the name without a second fetch.
 *
 * DUPLICATED, KNOWINGLY: `server/src/routes/events.ts` declares the same envelope as
 * `EventResponse`. Only the wrapper is duplicated — both fields inside it are shared
 * types — and the shared home for response envelopes still does not exist.
 */
export type EventDetail = {
  event: HydratedEvent;
  alsoIn: Timeline[];
};

/**
 * `GET /api/events` — every event in the save, in `when` order.
 *
 * The whole list, because that is what `useWorld` holds (§4.2): at ~50–500 events per save
 * it is small enough to keep in memory, and one shell-level load then serves all four
 * views instead of each of them issuing its own per-save query.
 */
export async function fetchEvents(
  saveId: string,
  options?: RequestOptions,
): Promise<HydratedEvent[]> {
  const body = await getForSave(EVENTS_URL, saveId, options);
  return arrayField<HydratedEvent>(body, 'events', EVENTS_URL);
}

/** `GET /api/events/:id` — see {@link EventDetail}. */
export async function fetchEvent(
  saveId: string,
  eventId: string,
  options?: RequestOptions,
): Promise<EventDetail> {
  const url = `${EVENTS_URL}/${segment(eventId)}`;
  const body = await getForSave(url, saveId, options);

  return {
    event: objectField<HydratedEvent>(body, 'event', url),
    alsoIn: arrayField<Timeline>(body, 'alsoIn', url),
  };
}
