/**
 * LIFEstream backend — Hono on Node. Single-user, local-only, no auth
 * (architecture.html §4.1).
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { eventRoutes } from './routes/events.js';
import { exportRoutes } from './routes/export.js';
import { mapRoutes } from './routes/map.js';
import { registryRoutes } from './routes/registry.js';
import { relationRoutes } from './routes/relations.js';
import { saveRoutes } from './routes/saves.js';
import { simulationRoutes } from './routes/simulation.js';
import { tagRoutes } from './routes/tags.js';
import { timelineRoutes } from './routes/timelines.js';

const PORT = 3001;

/** Any localhost origin — the Vite dev server picks the next free port when 5173 is taken. */
const DEV_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const app = new Hono();

// Dev only. In production the client is served from the same origin, so the header is
// dead weight there; in dev Vite proxies /api/* but a direct cross-origin call still works.
if (process.env.NODE_ENV !== 'production') {
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
// The nine modules are a FILE layout, not a URL layout: two of them own more than one
// prefix, because architecture.html §5.1/§5.2 specifies the URLs and those URLs do not all
// sit under a namesake path. In particular there is no /api/registry prefix.
app.route('/api/events', eventRoutes);
app.route('/api/timelines', timelineRoutes);
app.route('/api/relations', relationRoutes);
app.route('/api/tags', tagRoutes);
app.route('/api/saves', saveRoutes);
app.route('/api/simulation', simulationRoutes);
app.route('/api/export', exportRoutes);

// registry.ts owns the four registry entity prefixes (§5.2) — not /api/registry.
app.route('/api/characters', registryRoutes);
app.route('/api/locations', registryRoutes);
app.route('/api/projects', registryRoutes);
app.route('/api/character-relations', registryRoutes);

// map.ts owns the /api/map reads plus two top-level prefixes (§5.1).
app.route('/api/map', mapRoutes);
app.route('/api/groupings', mapRoutes);
app.route('/api/country-overrides', mapRoutes);

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[server] listening on http://localhost:${info.port}`);
});

export { app };
