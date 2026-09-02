/**
 * `/api/tags` — the global tag vocabulary.
 *
 * Placeholder. Seeded vocabulary and reads land in P3; writes land in P12, including
 * the refusal to hard-delete a referenced tag (soft-delete via `is_retired` instead).
 * See architecture.html §5.2.
 */
import { Hono } from 'hono';

export const tagRoutes = new Hono();
