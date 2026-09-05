/**
 * The Hono app — routes only, no listener.
 *
 * Split from `index.ts` so that importing the app never binds a port: `serve()` used to
 * run at module scope beside the `app` export, which made any `app.request()` test
 * EADDRINUSE whenever the dev server was up. `index.ts` is the only module that listens.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { eventRoutes } from './routes/events.js';
import { exportRoutes } from './routes/export.js';
import { countryOverrideRoutes, groupingRoutes, mapRoutes } from './routes/map.js';
import {
  characterRelationRoutes,
  characterRoutes,
  locationRoutes,
  projectRoutes,
} from './routes/registry.js';
import { relationRoutes } from './routes/relations.js';
import { saveRoutes } from './routes/saves.js';
import { simulationRoutes } from './routes/simulation.js';
import { tagRoutes } from './routes/tags.js';
import { timelineRoutes } from './routes/timelines.js';

/** Any loopback origin on any port, including the IPv6 literal Vite binds (`[::1]`). */
const DEV_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export const app = new Hono();

// Opt-in, never on by accident: set LIFESTREAM_DEV_CORS=1 to enable it. The normal dev
// path is same-origin — Vite proxies /api/* from :5173 to this server — so CORS is only
// needed for a direct cross-origin call (a browser hitting :3001 straight, a second
// client, curl with an Origin header). Keyed off its own variable rather than NODE_ENV,
// which nothing in this repo sets: an opt-out guard here could never actually turn off.
if (process.env.LIFESTREAM_DEV_CORS === '1') {
  app.use(
    '/api/*',
    cors({
      origin: (origin) => (DEV_ORIGIN.test(origin) ? origin : null),
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type'],
    }),
  );
}

app.get('/api/health', (c) => c.json({ ok: true }));

// Every route module is an empty placeholder at P0; each one names the phase that fills it.
//
// ONE Hono instance per URL prefix, mounted EXACTLY ONCE. `route()` copies the sub-app's
// route table under the prefix it is given, so mounting one instance at several prefixes
// aliases every handler across all of them — a single `GET /:id` on a shared registry
// router would serve /api/characters/:id and /api/locations/:id alike.
//
// The nine modules remain a FILE layout, not a URL layout (architecture.html §4.4): two of
// them export several routers, because the URLs in §5.1/§5.2 do not all sit under a
// namesake path. In particular there is no /api/registry prefix.
app.route('/api/events', eventRoutes);
app.route('/api/timelines', timelineRoutes);
app.route('/api/relations', relationRoutes);
app.route('/api/tags', tagRoutes);
app.route('/api/saves', saveRoutes);
app.route('/api/simulation', simulationRoutes);
app.route('/api/export', exportRoutes);

// registry.ts owns the four registry entity prefixes (§5.2) — not /api/registry.
app.route('/api/characters', characterRoutes);
app.route('/api/locations', locationRoutes);
app.route('/api/projects', projectRoutes);
app.route('/api/character-relations', characterRelationRoutes);

// map.ts owns the /api/map reads plus two top-level write prefixes (§5.1).
app.route('/api/map', mapRoutes);
app.route('/api/groupings', groupingRoutes);
app.route('/api/country-overrides', countryOverrideRoutes);
