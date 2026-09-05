/**
 * The shapes that live INSIDE a JSON column.
 *
 * SQLite has no jsonb, so every one of these is stored as TEXT holding JSON and is
 * parsed at the Drizzle boundary (`text({ mode: 'json' })`). They are separated from
 * `entities.ts` because they are the only shapes a fork has to walk INTO rather than
 * remap column-wise (architecture §2.6, the `json-walk` block of the remap manifest).
 */

import type { Category, IsoInstant } from './enums.js';

/**
 * `timeline.membership_rules` — the four predicates, all shipping in v1 (§2.6).
 *
 * Multiple predicate KINDS are ANDed; multiple values WITHIN a kind are ORed.
 * `byTimeRange` matches when the event's `[whenMin, whenMax]` window INTERSECTS the
 * range — deliberately not "its rolled `when` falls inside", so membership does not
 * change when somebody re-rolls a date.
 *
 * `byLocation` is the one predicate holding per-save ids, which is why a fork has to
 * walk into this JSON and remap them.
 */
export type MembershipRules = {
  /** Global `tag.id`s — survive a fork untouched, which is why `tag` has no `saveId`. */
  byTag?: string[];
  byCategory?: Category[];
  /** Both ends inclusive. */
  byTimeRange?: [IsoInstant, IsoInstant];
  /** Per-save `location.id`s, resolved to the canonical head of the rename chain. */
  byLocation?: string[];
};

/**
 * `country_projection.sector_mix_json` / `grouping_metrics.sector_mix_json`.
 *
 * Sector share by sector name. The exact taxonomy is the projection stage's business
 * (§3.1, deferred) — the column only has to hold it.
 */
export type SectorMix = Record<string, number>;

/** Which visualizer an export item renders (architecture §8.7). */
export type ExportView = 'timeline' | 'map' | 'tech' | 'family';

/** What is inside an export (architecture §8.5). */
export type ExportScope = 'all' | 'view' | 'selection' | 'filter';

/**
 * The client-only state an export request has to carry, because the server has never
 * seen it (§8.5). Stored inside a manifest only as a RESOLVED SNAPSHOT — frozen at
 * save time — since a bare `scope: 'selection'` would mean something different on
 * every run.
 */
export type ExportScopeParams = {
  /** `"<type>:<id>"`, e.g. `"character:char_lazaro"`. */
  primary?: string;
  /** Optional; the server can re-derive it from `primary`. Dropped, not remapped, on fork. */
  glow?: string[];
  filters?: {
    categories?: Category[];
    tags?: string[];
    search?: string;
    timeRange?: [IsoInstant, IsoInstant];
  };
  /** The Corridor's focus root (§5.2) — a per-save `timeline.id`. */
  rootTimelineId?: string;
};

/**
 * One `(view, scope)` pair of `manifest.items_json` (architecture §8.6). The export
 * pipeline (P15) owns the semantics; this is the storage shape.
 */
export type ManifestItem = {
  view: ExportView;
  scope: ExportScope;
  scopeParams?: ExportScopeParams;
};
