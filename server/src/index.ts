/**
 * LIFEstream backend entry point — the only module that listens.
 *
 * Single-user, local-only, no auth (architecture.html §4.1). The app itself is built in
 * `app.ts`, which stays importable without side effects.
 */
import { serve } from '@hono/node-server';

import { app } from './app.js';
// Imported for its side effect: opening the connection creates `data/lifestream.db` if it
// is missing. P0's goal clause wants that file to exist after a boot and drizzle cannot
// deliver it — the schema is intentionally empty at P0, so `db:generate` emits no
// migration for `db:migrate` to run. It sits here rather than in `app.ts` so importing the
// app in a test does not touch the filesystem.
import './db/index.js';

const PORT = 3001;

// Loopback only. "Local-only, so no auth" is a premise that has to be enforced by the
// bind: the default listens on every interface, which put this API on the machine's LAN
// address. `localhost` still reaches a 127.0.0.1-bound server on Node 24, so the Vite
// proxy and any hand-typed http://localhost:3001 are unaffected.
serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, (info) => {
  console.log(`[server] listening on http://127.0.0.1:${info.port}`);
});
