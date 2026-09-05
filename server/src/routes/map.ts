/**
 * Country and grouping data for the World Map.
 *
 * THREE prefixes per architecture.html §4.4 and §5.1: `/api/map` (the `/countries` and
 * `/groupings` reads), plus top-level `/api/groupings` and `/api/country-overrides` for
 * the writes, which the architecture deliberately places outside the `/api/map`
 * namespace.
 *
 * ONE ROUTER PER PREFIX, each mounted exactly once in `app.ts`. A single shared instance
 * mounted three times does not work: `Hono.route()` COPIES the sub-app's route table under
 * the prefix it is given, so the `/api/map/groupings` read would also be reachable at
 * `/api/groupings/groupings`, and every `/api/groupings/:id` write would answer under
 * `/api/map` and `/api/country-overrides` too.
 *
 * Placeholder. The reads land in P1; the grouping edit surface lands in P2 alongside
 * the view.
 */
import { Hono } from 'hono';

export const mapRoutes = new Hono();
export const groupingRoutes = new Hono();
export const countryOverrideRoutes = new Hono();
