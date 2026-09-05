/**
 * P3.4 — the DAG root and the first era.
 *
 * ── THE ROOT IS STRUCTURAL (P3.4.1, §2.3) ─────────────────────────────────────────────
 * `tl_world` is the root because it has NO row in `timeline_parent` — not because of its
 * id and not because of its `kind`. It carries `kind = 'thread'` for schema simplicity: a
 * fourth enum member would exist for exactly one row per save, and every rule that applies
 * to a thread applies to it. Anything that needs the root queries for the parentless
 * timeline, which is why the Corridor's thread stratum can exclude it without a special
 * case, and why a save that renames or replaces its root still behaves (P7.3).
 *
 * Its members are its CHILD TIMELINES, not a hand roster — so it carries no
 * `membership_rules` and no `timeline_member` rows, and resolving it walks the DAG.
 *
 * ── THE ERA (P3.4.2, §2.3) ────────────────────────────────────────────────────────────
 * The name is verbatim from the Bible heading at L887. The BOUNDS are authored: canon
 * groups these twelve bullets under one heading and never states where the era starts or
 * stops, so the row's own description says the numbers are a modelling decision — the rule
 * the era-bounds decision sets for all four eras.
 *
 * `era_end` is nullable even for an era, and stays that way on purpose for the
 * Reconstruction Era later. This one has an end because its section does: the next heading
 * begins the North Korean War.
 */
import { and, eq } from 'drizzle-orm';

import { timeline, timelineParent } from '../db/schema.js';

import type { CanonDateTools } from './dateTools.js';
import type { Db } from '../db/index.js';
import type { MembershipRules, TimelineKind, WhenPrecision } from '@shared/types/index';

/** An authored era bound: what canon-adjacent year it is, and how precisely it is known. */
interface AuthoredBound {
  precision: WhenPrecision;
  value: string;
}

/** One authored timeline, plus the parent edge that decides whether it is the root. */
export interface CanonTimeline {
  id: string;
  name: string;
  kind: TimelineKind;
  description: string;
  color: string;
  /** Required when `kind === 'era'`; a CHECK enforces it. */
  eraStart?: AuthoredBound;
  /** Optional even for an era — a null end means "still running", never "unknown". */
  eraEnd?: AuthoredBound;
  /**
   * `undefined` on the ROOT and only on the root. Anything else is a `timeline_parent`
   * row, which is what makes this timeline not the root.
   */
  parentId?: string;
  /**
   * `byTimeRange` here is authored as the era's own bounds. An event matches when its
   * `[whenMin, whenMax]` window INTERSECTS the range — not when its rolled `when` falls
   * inside it — so membership does not change when somebody re-rolls a date (§2.6). The
   * two instants are filled in from `eraStart` / `eraEnd` rather than typed a second time.
   */
  membershipFromEraBounds?: boolean;
}

/** The root, then the era. Order matters: the parent edge needs both rows to exist. */
export const CANON_TIMELINES: readonly CanonTimeline[] = [
  {
    id: 'tl_world',
    name: 'World Timeline',
    // 'thread' for schema simplicity, NOT as a marker of rootness. See the module header.
    kind: 'thread',
    description:
      'The whole of the LIFEstream world, and the view every consumer opens on. It is the DAG ' +
      'root structurally — it has no row in timeline_parent — and its members are its child ' +
      'timelines rather than a hand roster, so it carries no membership rules of its own.',
    color: '#e6e6e6',
  },
  {
    id: 'tl_pre_big_one',
    // Verbatim from the Bible's World Timeline heading, L887.
    name: 'Pre-Big One',
    kind: 'era',
    description:
      "The world before the earthquake, from the births of X's parents to the last of the " +
      'first-generation Megablocks. AUTHORED BOUNDS: canon groups these bullets under one heading ' +
      'and states no start or end for the era, so 2021-2040 is a modelling decision taken from the ' +
      'extent of the section (L888-L899) and not a date the Bible gives.',
    color: '#7a8899',
    eraStart: { precision: 'year', value: '2021' },
    eraEnd: { precision: 'year', value: '2040' },
    parentId: 'tl_world',
    membershipFromEraBounds: true,
  },
];

/** What one timeline seed did. */
export interface TimelineSeedResult {
  timelines: { total: number; inserted: number; updated: number; unchanged: number };
  parentEdges: { total: number; inserted: number };
  /** The id with no `timeline_parent` row — asserted, not assumed. */
  rootId: string;
}

/** A root that is not one root. Rolls the transaction back. */
class TimelineRootError extends Error {
  override name = 'TimelineRootError';
}

/**
 * Seed the root timeline and the Pre-Big One era for one save.
 *
 * Call inside a transaction — `runSeed` owns it. Idempotent and never destructive: a row
 * that already matches is skipped rather than rewritten, and a timeline this run does not
 * name is left alone.
 */
export function seedTimelines(db: Db, saveId: string, tools: CanonDateTools): TimelineSeedResult {
  const existing = new Map(
    db
      .select()
      .from(timeline)
      .where(eq(timeline.saveId, saveId))
      .all()
      .map((row) => [row.id, row] as const),
  );

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  for (const authored of CANON_TIMELINES) {
    const eraStart =
      authored.eraStart === undefined
        ? null
        : tools.precisionToInterval(authored.eraStart.precision, authored.eraStart.value)[0];
    const eraEnd =
      authored.eraEnd === undefined
        ? null
        : tools.precisionToInterval(authored.eraEnd.precision, authored.eraEnd.value)[1];

    const membershipRules: MembershipRules | null =
      authored.membershipFromEraBounds === true && eraStart !== null && eraEnd !== null
        ? { byTimeRange: [eraStart, eraEnd] }
        : null;

    const values = {
      name: authored.name,
      kind: authored.kind,
      description: authored.description,
      color: authored.color,
      eraStart,
      eraStartPrecision: authored.eraStart?.precision ?? null,
      eraEnd,
      eraEndPrecision: authored.eraEnd?.precision ?? null,
      membershipRules,
      projectId: null,
    };
    const current = existing.get(authored.id);

    if (
      current !== undefined &&
      current.name === values.name &&
      current.kind === values.kind &&
      current.description === values.description &&
      current.color === values.color &&
      current.eraStart === values.eraStart &&
      current.eraStartPrecision === values.eraStartPrecision &&
      current.eraEnd === values.eraEnd &&
      current.eraEndPrecision === values.eraEndPrecision &&
      current.projectId === values.projectId &&
      // Drizzle parses the JSON column on read, so the two sides are compared as data.
      JSON.stringify(current.membershipRules ?? null) === JSON.stringify(values.membershipRules)
    ) {
      unchanged += 1;
      continue;
    }
    if (current !== undefined) updated += 1;
    else inserted += 1;

    db.insert(timeline)
      .values({ id: authored.id, saveId, ...values })
      .onConflictDoUpdate({ target: timeline.id, set: { saveId, ...values } })
      .run();
  }

  const parentEdges = seedParentEdges(db, saveId);
  assertSingleStructuralRoot(db, saveId);

  return {
    timelines: { total: CANON_TIMELINES.length, inserted, updated, unchanged },
    parentEdges,
    rootId: 'tl_world',
  };
}

/** `timeline_parent`, whose whole row is its key — an existing edge is left in place. */
function seedParentEdges(db: Db, saveId: string): { total: number; inserted: number } {
  const wanted = CANON_TIMELINES.flatMap((authored) =>
    authored.parentId === undefined
      ? []
      : [{ timelineId: authored.id, parentId: authored.parentId }],
  );

  let inserted = 0;
  for (const edge of wanted) {
    const current = db
      .select({ timelineId: timelineParent.timelineId })
      .from(timelineParent)
      .where(
        and(
          eq(timelineParent.saveId, saveId),
          eq(timelineParent.timelineId, edge.timelineId),
          eq(timelineParent.parentId, edge.parentId),
        ),
      )
      .get();
    if (current !== undefined) continue;

    inserted += 1;
    db.insert(timelineParent)
      .values({ saveId, timelineId: edge.timelineId, parentId: edge.parentId })
      .onConflictDoNothing()
      .run();
  }

  return { total: wanted.length, inserted };
}

/**
 * Assert the save has exactly one parentless timeline, and that it is `tl_world`.
 *
 * The root is defined structurally, so "there is a root" is a property of the rows and not
 * of this module's intentions. Seeding a second parentless timeline — or accidentally
 * giving `tl_world` a parent — breaks every consumer that queries for the root, and does
 * it silently: the Corridor would simply draw one bar too many.
 */
function assertSingleStructuralRoot(db: Db, saveId: string): void {
  const all = db
    .select({ id: timeline.id })
    .from(timeline)
    .where(eq(timeline.saveId, saveId))
    .all()
    .map((row) => row.id);
  const parented = new Set(
    db
      .select({ timelineId: timelineParent.timelineId })
      .from(timelineParent)
      .where(eq(timelineParent.saveId, saveId))
      .all()
      .map((row) => row.timelineId),
  );

  const roots = all.filter((id) => !parented.has(id));
  if (roots.length !== 1 || roots[0] !== 'tl_world') {
    throw new TimelineRootError(
      `seed: save "${saveId}" must have exactly one parentless timeline and it must be ` +
        `"tl_world"; found [${roots.join(', ')}] across ${all.length} timeline(s).`,
    );
  }
}
