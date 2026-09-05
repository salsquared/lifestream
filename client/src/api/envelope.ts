/**
 * Reading a response envelope, and building a path segment out of an id.
 *
 * Every read in this API answers a NAMED OBJECT — `{ countries }`, `{ events }`,
 * `{ timeline, timelineIds, events }` — never a bare array (architecture §5.1). These are
 * the two functions that open one, and they are here rather than in each endpoint module
 * because P3.6 added five of those at once.
 *
 * DUPLICATED, KNOWINGLY: `./map.ts` carries private copies of `arrayField` and
 * `objectField` from P1.12, when it was the only endpoint module and a shared home would
 * have been a directory with one occupant. It was being edited in parallel when this
 * landed, so the copies still exist; folding them into this module is a delete-and-import
 * and should happen as soon as P3 settles.
 *
 * ── WHAT IS CHECKED AND WHAT IS ASSERTED ──────────────────────────────────────────────
 * What is checked is the ENVELOPE: that a JSON object arrived and that the named field is
 * an array (or an object). Those are the shapes that separate "the API answered" from
 * "something else did" — a drifted URL, a stale server, Vite's SPA fallback handing back
 * `index.html` — and they are what a wrong prefix actually produces. The ELEMENT TYPE is
 * asserted, not verified: both ends of it are pinned to `@shared/types` by
 * `server/src/db/conformance.ts` at compile time, so re-checking every row per load would
 * buy a guarantee tsc already gives. If a runtime schema check is ever wanted, these two
 * functions are where it goes.
 */
import { ApiError } from './client';

/** Read one array off a response envelope, or fail naming the field. */
export function arrayField<T>(body: unknown, field: string, url: string): T[] {
  const value =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)[field]
      : undefined;

  if (!Array.isArray(value)) {
    throw new ApiError(url, 0, `malformed payload: '${field}' is not an array`);
  }

  return value as T[];
}

/** Read one object off a response envelope, or fail naming the field. See {@link arrayField}. */
export function objectField<T>(body: unknown, field: string, url: string): T {
  const value =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)[field]
      : undefined;

  if (typeof value !== 'object' || value === null) {
    throw new ApiError(url, 0, `malformed payload: '${field}' is not an object`);
  }

  return value as T;
}

/**
 * A path segment built from an id.
 *
 * The ids are not opaque enough to skip this. A synthetic country id looks like `x:GUF`
 * (§3.1), and every other id is a `<prefix>_<slug|ulid>` written by a seed or an editor —
 * data, not identifiers this module gets to make assumptions about. Hono decodes
 * `req.param()`, so the server sees the original string either way.
 */
export const segment = (id: string): string => encodeURIComponent(id);
