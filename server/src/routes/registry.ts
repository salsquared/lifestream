/**
 * `/api/registry` — characters, locations, projects and character relations.
 *
 * Placeholder. Reads land in P3; full registry CRUD (driven by the event side panel)
 * lands in P12. Note that architecture.html §5.2 lists these at top-level
 * `/api/characters`, `/api/locations`, `/api/projects` and `/api/character-relations`
 * rather than under a `/api/registry` prefix; the final mount is settled when the
 * handlers land.
 */
import { Hono } from 'hono';

export const registryRoutes = new Hono();
