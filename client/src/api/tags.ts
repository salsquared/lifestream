/**
 * The tag read (P3.6.5) — architecture §5.2, §2.1.
 *
 * ── A GLOBAL TABLE, READ THROUGH A SAVE ───────────────────────────────────────────────
 * `tag` has no `saveId`: one canonical vocabulary shared across every save, which is what
 * keeps `byTag` membership rules stable across a fork (§2.1). The ASSIGNMENTS
 * (`event_tag`) are per-save, so the usage counts are — "black-fever, 14 events" is true
 * of one save and false of its fork the moment either is edited.
 *
 * That makes this the same shape as `GET /api/map/countries`: a global table read THROUGH
 * a save, fetched with `getForSave`. Worth stating because `./client.ts` predicted the
 * opposite — it names `/api/tags` as the example of a GLOBAL read "when P3.6 arrives". The
 * counts settle it: a response that differs by save is a per-save read whatever table it
 * came from, and calling it through `getGlobal` would 400.
 */
import type { Tag } from '@shared/types/index';

import { getForSave, type RequestOptions } from './client';
import { arrayField } from './envelope';

const TAGS_URL = '/api/tags';

/**
 * A vocabulary entry plus how often the active save uses it.
 *
 * COMPOSED FROM THE SHARED TYPE, never a redeclaration: `Tag` is the row pinned against
 * the columns by `server/src/db/conformance.ts`, and `usageCount` is the one field the
 * endpoint adds. It has no home in `@shared/types` because it is not a row — nothing
 * stores it, and it is a different number for every save.
 *
 * DUPLICATED, KNOWINGLY: `server/src/routes/tags.ts` declares the same composition as
 * `TagWithUsage`. The shared home for response-only shapes does not exist yet.
 */
export type TagWithUsage = Tag & { usageCount: number };

/**
 * `GET /api/tags` — the whole vocabulary, with this save's usage counts.
 *
 * RETIRED TAGS ARE INCLUDED and carry `isRetired`. Retirement is a soft delete (§2.1): the
 * tag is hidden from the PICKER, but its existing assignments still stand and its id may
 * still appear in a `byTag` rule, so the client needs the row to be able to name a tag its
 * own events carry. Filter for the picker at the call site — `tags.filter((t) =>
 * !t.isRetired)` — rather than expecting the server to have done it.
 */
export async function fetchTags(saveId: string, options?: RequestOptions): Promise<TagWithUsage[]> {
  const body = await getForSave(TAGS_URL, saveId, options);
  return arrayField<TagWithUsage>(body, 'tags', TAGS_URL);
}
