/**
 * `/api/events` — event rows, their tag attachments and the seeded date re-roll.
 *
 * Placeholder. Reads land in P3 (data layer II, thin slice of events); the write
 * surface lands in P12 (editors). Endpoint list: architecture.html §5.2.
 */
import { Hono } from 'hono';

export const eventRoutes = new Hono();
