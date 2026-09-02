/**
 * Characters, locations, projects and character relations.
 *
 * Mounted at FOUR top-level prefixes — `/api/characters`, `/api/locations`,
 * `/api/projects`, `/api/character-relations` — per architecture.html §4.4 and §5.2.
 * There is no `/api/registry` prefix: the nine route modules are a file layout, not a
 * URL layout, and this one owns four URLs.
 *
 * Placeholder. Reads land in P3; full registry CRUD (driven by the event side panel)
 * lands in P12.
 */
import { Hono } from 'hono';

export const registryRoutes = new Hono();
