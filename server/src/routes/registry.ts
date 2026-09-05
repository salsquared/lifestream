/**
 * Characters, locations, projects and character relations.
 *
 * FOUR top-level prefixes — `/api/characters`, `/api/locations`, `/api/projects`,
 * `/api/character-relations` — per architecture.html §4.4 and §5.2. There is no
 * `/api/registry` prefix: the nine route modules are a file layout, not a URL layout,
 * and this one owns four URLs.
 *
 * ONE ROUTER PER PREFIX, each mounted exactly once in `app.ts`. A single shared instance
 * mounted four times does not work: `Hono.route()` COPIES the sub-app's route table under
 * the prefix it is given, so one `GET /:id` registered here would answer under all four
 * and `/api/locations/char_lazaro` would reach the character handler. The four entities
 * have near-identical URL shapes, so the aliasing stays invisible until it serves the
 * wrong row.
 *
 * Placeholder. Reads land in P3; full registry CRUD (driven by the event side panel)
 * lands in P12.
 */
import { Hono } from 'hono';

export const characterRoutes = new Hono();
export const locationRoutes = new Hono();
export const projectRoutes = new Hono();
export const characterRelationRoutes = new Hono();
