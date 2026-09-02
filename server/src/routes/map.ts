/**
 * `/api/map` — country and grouping reads for the World Map.
 *
 * Placeholder. `GET /countries` and `GET /groupings` land in P1; the grouping edit
 * surface lands in P2 alongside the view. Note that architecture.html §5.1 puts the
 * grouping and rename writes at top-level `/api/groupings` and `/api/country-overrides`
 * rather than under this prefix — those mounts are added when the handlers exist.
 */
import { Hono } from 'hono';

export const mapRoutes = new Hono();
