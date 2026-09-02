import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The client is served by Vite; the Hono API (P0.3) listens on 3001. Everything under
// /api/* is proxied there so the browser only ever talks to one origin in dev and the
// app can use same-origin relative URLs (`fetch('/api/health')`) with no CORS dance.
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  plugins: [react()],
});
