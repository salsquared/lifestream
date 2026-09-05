/**
 * The two date functions the P3 seed needs, as a parameter rather than an import.
 *
 * `rollDate` and `precisionToInterval` live in `shared/src/rollDate.ts` — ONE
 * implementation, shared with the UI editor, which is what makes the seed and the editor
 * agree on the same point for the same event (§2.6). This module does not re-export them
 * and does not reimplement them; it only names their type.
 *
 * ── WHY THEY ARRIVE AS A PARAMETER ────────────────────────────────────────────────────
 * Exactly the reason `deriveFeatures` does, and the rule is worth stating once here so no
 * later task "tidies" it into an import. `npm run db:seed` is `tsx scripts/seed.ts` from
 * the repo root; there is no root `tsconfig.json`, so the `@shared/*` path alias does not
 * resolve for that process. Every `@shared` import under `server/src` is `import type`
 * and erases before any resolver sees it — including the two below. A runtime `@shared`
 * import here would not erase, would fail under `tsx`, and would also emit an
 * unresolvable specifier into `server/dist`. So the composition root (`scripts/seed.ts`)
 * imports the module by relative path and hands the functions down.
 *
 * The seam is optional at `runSeed`'s boundary: a caller that only wants the map world —
 * `tests/countryImport.test.ts` does — passes nothing and gets no P3 content, rather than
 * every such caller having to grow an argument it has no use for.
 */
import type { precisionToInterval, rollDate } from '@shared/rollDate';

/** The two functions, taken from the module itself so the signatures cannot drift. */
export interface CanonDateTools {
  /** `rollDate(eventId, whenMin, whenMax)` — the seeded point-in-window roll. */
  rollDate: typeof rollDate;
  /** `precisionToInterval(precision, value)` — a stated precision becomes a window. */
  precisionToInterval: typeof precisionToInterval;
}
