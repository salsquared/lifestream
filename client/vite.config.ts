import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { resolveAliases } from '../aliases.mjs';

// The client is served by Vite; the Hono API (P0.3) listens on 3001. Everything under
// /api/* is proxied there so the browser only ever talks to one origin in dev and the
// app can use same-origin relative URLs (`fetch('/api/health')`) with no CORS dance.
//
// `resolve.alias` is the browser half of the `@shared/*` wiring; `references` in
// tsconfig.json is the tsc half (see the comment there). Declare it explicitly even
// though Vite 8 also happens to read tsconfig `paths` on its own: that behaviour is
// undocumented — `ResolveOptions.tsconfigPaths` is declared `@default false` and
// setting it to `false` does not turn the resolution off — so it is not something to
// depend on. The table itself lives in `../aliases.mjs`, the one source of truth shared
// with `vitest.config.ts` and mirrored by hand into `tsconfig.base.json`, with
// `tests/smoke.test.ts` asserting all three agree. Never re-declare it here.
export default defineConfig({
  resolve: {
    alias: resolveAliases(),
  },
  server: {
    // Pinned, not preferred: without `strictPort` Vite silently walks to the next free
    // port, and the docs, the README and the server's CORS allowlist all name 5173.
    // Failing loudly beats a dev server that is up on a port nothing else expects.
    port: 5173,
    strictPort: true,
    proxy: {
      // 127.0.0.1, not `localhost`: the server binds loopback explicitly (A1), and
      // `localhost` can resolve to ::1 ahead of 127.0.0.1, which would miss it.
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
  plugins: [react()],
});
