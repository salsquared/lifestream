/**
 * The two things every read module under `routes/` needs, and neither of which has a
 * home yet: the save scope, and the `null` → absent-key adjustment.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────────────────
 * `resolveSave` was written for P1.12 inside `routes/map.ts`, where it was the only
 * consumer. P3.6 adds nine more prefixes across five modules, every one of them per-save,
 * so the choice was one shared definition or six copies of the same eight lines. This is
 * the shared definition. `routes/map.ts` still carries its own — it was being edited in
 * parallel when this landed — and lifting it here is a one-line change (delete the local
 * copy, import this one) that should happen as soon as P3 settles. Until it does, the
 * function exists TWICE and the two must not be allowed to drift: the status codes and
 * the message text below are copied verbatim from `map.ts`, because a client that
 * branches on a 400 from one prefix and a 404 from another is reading one contract.
 *
 * It is deliberately NOT a Hono middleware. A middleware would have to stash the resolved
 * save on the context and every handler would read it back out untyped (`c.get('saveId')`
 * is `unknown` without a typed Variables map), which trades a two-line call for a cast.
 * The two lines are the contract, visible at the top of every handler that has one:
 *
 *     const scope = resolveSave(c.req.query('save'));
 *     if (!scope.ok) return c.json({ error: scope.error }, scope.status);
 */
import { eq } from 'drizzle-orm';

import { db } from '../db/index.js';
import { save } from '../db/schema.js';

/** Every read in this directory is per-save, so a request without a usable `?save=` never runs one. */
export type SaveScope =
  { ok: true; saveId: string } | { ok: false; status: 400 | 404; error: string };

/**
 * Resolve `?save=` into a save that actually exists.
 *
 * BOTH FAILURES ARE LOUD ON PURPOSE (architecture §5.1). A missing parameter is a client
 * bug, and defaulting it to the canon save would hide it behind rows that look right; a
 * parameter naming a save that is not there is the `CANON_SAVE_ID` drift a fork
 * introduces (§2.6), whose natural symptom is an empty application rather than an error —
 * every read would legitimately return zero rows. A 404 naming the id is what turns that
 * into a one-line diagnosis.
 */
export function resolveSave(raw: string | undefined): SaveScope {
  if (raw === undefined || raw === '') {
    return { ok: false, status: 400, error: "missing required query parameter 'save'" };
  }

  const row = db.select({ id: save.id }).from(save).where(eq(save.id, raw)).get();
  if (row === undefined) {
    return { ok: false, status: 404, error: `no save with id '${raw}'` };
  }

  return { ok: true, saveId: raw };
}

/**
 * A nullable column (`T | null`) is an optional property (`T | undefined`) on the wire.
 *
 * The same rule `db/conformance.ts` pins as the single difference between a Drizzle row
 * type and its `@shared/types` counterpart, restated here because that module declares it
 * privately and exists only to be typechecked. If the two ever disagree, every
 * `const xs: Character[] = rows.map(dropNulls)` below stops compiling — which is the
 * point: the rule is asserted at each use, not merely written down twice.
 */
type NullToOptional<T> = {
  [K in keyof T as null extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as null extends T[K] ? K : never]?: Exclude<T[K], null>;
};

/**
 * A Drizzle row as it goes on the wire: every `null` column becomes an ABSENT KEY.
 *
 * Not `null`, and the distinction is the whole reason this function exists. `@shared/types`
 * writes a nullable column as an optional property, so `{ "bio": null }` does not match the
 * type the client asserts the payload against — and a client reading `event.techLane` gets
 * `null` where the type promised `string | undefined`, which survives a `??` and fails an
 * `if (x !== undefined)`. Deleting the key is stronger than `?? undefined`: the property is
 * gone from the object, not merely dropped later by `JSON.stringify`, so an in-process
 * caller (the export builders of §8, a test asserting on the handler's return) sees the
 * same shape the network does.
 *
 * Row objects here are flat by construction — every column is TEXT, INTEGER or REAL, and
 * the one JSON column (`timeline.membership_rules`) is parsed into a value that is either
 * absent or a whole object. So a shallow pass is the complete rule, not an approximation.
 */
export function dropNulls<T extends object>(row: T): NullToOptional<T> {
  const wire: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(row)) {
    if (value !== null) wire[key] = value;
  }

  return wire as NullToOptional<T>;
}
