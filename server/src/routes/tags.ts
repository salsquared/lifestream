/**
 * `/api/tags` — the global tag vocabulary, counted against one save.
 *
 * P3.6.5 fills in the read. Writes land in P12, including the refusal to hard-delete a
 * referenced tag (soft-delete via `is_retired` instead). See architecture.html §5.2, §2.1.
 *
 * ── A GLOBAL TABLE BEHIND A PER-SAVE READ ─────────────────────────────────────────────
 * `tag` has no `save_id` — one canonical vocabulary shared across every save, which is
 * what keeps `byTag` membership rules stable across a fork (§2.1). The ASSIGNMENTS
 * (`event_tag`) are per-save, so a usage count is not: "black-fever, 14 events" is true
 * of one save and false of its fork the moment either is edited.
 *
 * That makes this endpoint the same shape as `GET /api/map/countries` (§5.1) — a global
 * table read THROUGH a save — and it takes `?save=` for the same reason, with the same
 * loud 400/404. It is worth stating because the transport's own comment in
 * `client/src/api/client.ts` predicted the opposite ("`/api/tags` when P3.6 arrives" is
 * listed as an example of a GLOBAL read). The counts are what settle it: a response that
 * differs by save is a per-save read whatever table it came from, and the client calls
 * this through `getForSave`.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';

import type { Tag } from '@shared/types/index';

import { db } from '../db/index.js';
import { eventTag, tag } from '../db/schema.js';

import { dropNulls, resolveSave } from './common.js';

/**
 * A vocabulary entry plus how often the active save uses it.
 *
 * COMPOSED FROM THE SHARED TYPE, never a redeclaration of it: `Tag` is the row
 * `db/conformance.ts` pins against the column list, and `usageCount` is the one field
 * this endpoint adds on top. It has no home in `@shared/types` because it is not a row —
 * nothing stores it, and it is a different number for every save.
 */
export type TagWithUsage = Tag & { usageCount: number };

export type TagsResponse = { tags: TagWithUsage[] };

export const tagRoutes = new Hono();

/**
 * `GET /api/tags` — the whole vocabulary, with this save's usage counts.
 *
 * A LEFT JOIN CARRYING THE SAVE IN ITS ON CLAUSE, for the reason `/api/map/countries`
 * does: moving `event_tag.save_id` into a WHERE turns the outer join back into an inner
 * one, and every tag the save has never used — which is most of a freshly seeded
 * vocabulary — silently disappears from the picker. The count has to be able to be zero.
 *
 * `count(event_tag.event_id)` and not `count(*)`: on a LEFT JOIN with no match the joined
 * columns are NULL and `count(*)` would count that phantom row as 1, giving every unused
 * tag a usage of one. Counting a NULLABLE column from the RIGHT side is what makes the
 * empty case come back as 0.
 *
 * RETIRED TAGS ARE INCLUDED, and `isRetired` is on the row. Retirement is a soft delete
 * (§2.1): the tag is hidden from the PICKER but its existing `event_tag` rows still stand
 * and its id may still appear in a `byTag` membership rule, so a response that omitted it
 * would leave the client unable to name a tag its own events carry. Filtering for the
 * picker is one predicate on the client; recovering a row that never arrived is not.
 *
 * Ordered by name — `tag_name_unique` makes that a total order, and it is the only
 * ordering meaningful to a reader.
 */
tagRoutes.get('/', (c) => {
  const scope = resolveSave(c.req.query('save'));
  if (!scope.ok) return c.json({ error: scope.error }, scope.status);

  const rows = db
    .select({
      id: tag.id,
      name: tag.name,
      color: tag.color,
      description: tag.description,
      isRetired: tag.isRetired,
      usageCount: sql<number>`count(${eventTag.eventId})`,
    })
    .from(tag)
    .leftJoin(eventTag, and(eq(eventTag.tagId, tag.id), eq(eventTag.saveId, scope.saveId)))
    .groupBy(tag.id)
    .orderBy(asc(tag.name))
    .all();

  const tags: TagWithUsage[] = rows.map(dropNulls);
  return c.json({ tags } satisfies TagsResponse);
});
