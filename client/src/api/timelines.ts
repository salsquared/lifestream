/**
 * The timeline reads (P3.6.2) — architecture §5.2, §2.6.
 *
 * URLs come from the specification, not from the server's route filenames (§4.4). Entity
 * types come from `@shared/types/index` and are never redeclared.
 */
import type { HydratedEvent, Timeline, TimelineMember, TimelineParent } from '@shared/types/index';

import { getForSave, type RequestOptions } from './client';
import { arrayField, objectField, segment } from './envelope';

const TIMELINES_URL = '/api/timelines';

/**
 * `GET /api/timelines` — the save's timelines and the DAG edges between them.
 *
 * THE EDGES ARE HOW THE ROOT IS FOUND. A save's root is the timeline with no row in
 * `timeline_parent` — structural, never inferred from `kind` (which is `'thread'` on the
 * root) and never a hard-coded id, so a save that renames or replaces its root still
 * behaves (§2.3, P3.4.1). The Corridor's thread stratum excludes it (§5.2), which it can
 * only do with these rows in hand:
 *
 *     const parented = new Set(parents.map((edge) => edge.timelineId));
 *     const root = timelines.find((t) => !parented.has(t.id));
 *
 * `parents` is `timeline_parent` verbatim — `timelineId` is the child, `parentId` the
 * parent — for the reason `/api/map/groupings` sends its join rows verbatim: an index
 * built from the rows is one pass away, and the rows are not recoverable from an index.
 */
export type TimelineGraph = {
  timelines: Timeline[];
  parents: TimelineParent[];
};

/**
 * `GET /api/timelines/:id` — one timeline, its edges both ways, and its MANUAL ROSTER.
 *
 * `members` is `timeline_member` verbatim and IS NOT THE RESOLVED SET. Membership is the
 * roster unioned with whatever `membershipRules` matches, closed over the DAG (§2.6) —
 * ask {@link fetchResolvedTimeline} for that. The roster is here because it is the only
 * half of membership an editor can add a row to, so a panel offering to remove one has to
 * be able to read it back.
 */
export type TimelineDetail = {
  timeline: Timeline;
  parents: TimelineParent[];
  children: TimelineParent[];
  members: TimelineMember[];
};

/**
 * `GET /api/timelines/:id/resolve` — the resolved membership set.
 *
 * `timelineIds` is the DAG closure that was unioned: this timeline plus every descendant.
 * `events` are in `when` order.
 *
 * NO FILTERS ARE SENT HERE AND NONE MAY BE. Category chips, the tag filter, the time
 * scrub and the search box are a client-side `applyFilters()` mask over this result (§2.6,
 * P9.4) — the server's memo is keyed on `(saveId, timelineId)` alone precisely because
 * membership changes only on a write while filter state changes on every keystroke.
 */
export type ResolvedTimeline = {
  timeline: Timeline;
  timelineIds: string[];
  events: HydratedEvent[];
};

/** `GET /api/timelines` — see {@link TimelineGraph}. */
export async function fetchTimelines(
  saveId: string,
  options?: RequestOptions,
): Promise<TimelineGraph> {
  const body = await getForSave(TIMELINES_URL, saveId, options);
  return {
    timelines: arrayField<Timeline>(body, 'timelines', TIMELINES_URL),
    parents: arrayField<TimelineParent>(body, 'parents', TIMELINES_URL),
  };
}

/** `GET /api/timelines/:id` — see {@link TimelineDetail}. */
export async function fetchTimeline(
  saveId: string,
  timelineId: string,
  options?: RequestOptions,
): Promise<TimelineDetail> {
  const url = `${TIMELINES_URL}/${segment(timelineId)}`;
  const body = await getForSave(url, saveId, options);

  return {
    timeline: objectField<Timeline>(body, 'timeline', url),
    parents: arrayField<TimelineParent>(body, 'parents', url),
    children: arrayField<TimelineParent>(body, 'children', url),
    members: arrayField<TimelineMember>(body, 'members', url),
  };
}

/**
 * `GET /api/timelines/:id/resolve` — see {@link ResolvedTimeline}.
 *
 * Named `fetchResolvedTimeline` rather than `resolveTimeline`: the resolving happens in
 * `server/src/services/resolveTimeline.ts` and there is exactly one of it (§5.2). This
 * function fetches the answer, and a client-side identifier spelled the same way would
 * read like a second implementation.
 */
export async function fetchResolvedTimeline(
  saveId: string,
  timelineId: string,
  options?: RequestOptions,
): Promise<ResolvedTimeline> {
  const url = `${TIMELINES_URL}/${segment(timelineId)}/resolve`;
  const body = await getForSave(url, saveId, options);

  return {
    timeline: objectField<Timeline>(body, 'timeline', url),
    timelineIds: arrayField<string>(body, 'timelineIds', url),
    events: arrayField<HydratedEvent>(body, 'events', url),
  };
}
