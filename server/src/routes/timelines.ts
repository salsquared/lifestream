/**
 * `/api/timelines` — the timeline DAG rows plus `GET /:id/resolve`.
 *
 * Placeholder. `resolveTimeline()` and the read endpoints land in P3; the Corridor
 * consumes them from P4. See architecture.html §2.3, §2.6, §5.2.
 */
import { Hono } from 'hono';

export const timelineRoutes = new Hono();
