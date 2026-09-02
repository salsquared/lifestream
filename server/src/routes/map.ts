/**
 * Country and grouping data for the World Map.
 *
 * Mounted at THREE prefixes per architecture.html §4.4 and §5.1: `/api/map` (the
 * `/countries` and `/groupings` reads), plus top-level `/api/groupings` and
 * `/api/country-overrides` for the writes, which the architecture deliberately places
 * outside the `/api/map` namespace.
 *
 * Placeholder. The reads land in P1; the grouping edit surface lands in P2 alongside
 * the view.
 */
import { Hono } from 'hono';

export const mapRoutes = new Hono();
