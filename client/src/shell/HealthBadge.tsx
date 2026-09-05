import { useEffect, useState } from 'react';

/**
 * P0.4.4 — the end-to-end smoke check for the Vite proxy.
 *
 * A same-origin GET of `/api/health` only succeeds if Vite's `/api/*` proxy (P0.4.3) is
 * forwarding to the Hono server (P0.3) on :3001, so rendering its result in the top bar
 * tells you the whole dev chain is up at a glance. It is intentionally the only network
 * call in the shell at P0 — the per-save fetch arrives with the stores in P1/P2.
 *
 * WHY IT INSISTS ON `{ ok: true }` AND NOT MERELY A 2xx: a 2xx proves something answered,
 * not that the API did. Vite's SPA fallback serves `index.html` with `200 text/html` for
 * any path it does not recognise, so the moment the proxy prefix drifts — a typo'd
 * `/api`, a rename, a server that never came up — a status-only check reads "api up"
 * while it is holding a page of HTML. The badge only claims the chain is live when it has
 * parsed JSON from the server and found the health flag literally `true`.
 */

type HealthState =
  { status: 'checking' } | { status: 'ok'; detail: string } | { status: 'error'; detail: string };

const LABEL: Record<HealthState['status'], string> = {
  checking: 'checking',
  ok: 'up',
  error: 'down',
};

/** `GET /api/health` answers `{ ok: true }` (server/src/index.ts). Nothing else counts. */
function isHealthy(body: unknown): boolean {
  return typeof body === 'object' && body !== null && (body as { ok?: unknown }).ok === true;
}

export function HealthBadge() {
  const [state, setState] = useState<HealthState>({ status: 'checking' });

  useEffect(() => {
    const controller = new AbortController();

    async function check(): Promise<HealthState> {
      const response = await fetch('/api/health', { signal: controller.signal });
      if (!response.ok) {
        return { status: 'error', detail: `HTTP ${String(response.status)}` };
      }

      // Checked before parsing so the SPA-fallback case reports what it actually got
      // ("text/html") instead of a generic parse failure.
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        const kind = contentType.split(';')[0]?.trim();
        return {
          status: 'error',
          detail: `not JSON (${kind !== undefined && kind.length > 0 ? kind : 'no content-type'})`,
        };
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { status: 'error', detail: 'malformed JSON' };
      }

      if (!isHealthy(body)) {
        return { status: 'error', detail: 'no ok:true in payload' };
      }
      return { status: 'ok', detail: `HTTP ${String(response.status)}` };
    }

    check()
      .then((next) => {
        setState(next);
      })
      .catch((error: unknown) => {
        // StrictMode's double-mount aborts the first request; that is not a failure.
        if (controller.signal.aborted) return;
        setState({
          status: 'error',
          detail: error instanceof Error ? error.message : 'unreachable',
        });
      });

    return () => {
      controller.abort();
    };
  }, []);

  return (
    <span
      className={`health health--${state.status}`}
      title={`GET /api/health — ${state.status === 'checking' ? 'in flight' : state.detail}`}
    >
      <span className="health__dot" />
      <span>api {LABEL[state.status]}</span>
      {state.status !== 'checking' && <span>· {state.detail}</span>}
    </span>
  );
}
