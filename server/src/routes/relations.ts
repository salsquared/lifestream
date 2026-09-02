/**
 * `/api/relations` — event-to-event relations (`precedes` / `partOf` / `renames`).
 *
 * Placeholder. Reads land in P3; writes (which validate `precedes` ordering at write
 * time) land in P12. See architecture.html §2.3, §5.2.
 */
import { Hono } from 'hono';

export const relationRoutes = new Hono();
