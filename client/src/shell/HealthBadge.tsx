import { useEffect, useState } from 'react';

/**
 * P0.4.4 — the end-to-end smoke check for the Vite proxy.
 *
 * A same-origin GET of `/api/health` only succeeds if Vite's `/api/*` proxy (P0.4.3) is
 * forwarding to the Hono server (P0.3) on :3001, so rendering its result in the top bar
 * tells you the whole dev chain is up at a glance. It is intentionally the only network
 * call in the shell at P0 — the per-save fetch arrives with the stores in P1/P2.
 */

type HealthState =
  { status: 'checking' } | { status: 'ok'; detail: string } | { status: 'error'; detail: string };

const LABEL: Record<HealthState['status'], string> = {
  checking: 'checking',
  ok: 'up',
  error: 'down',
};

export function HealthBadge() {
  const [state, setState] = useState<HealthState>({ status: 'checking' });

  useEffect(() => {
    const controller = new AbortController();

    async function check(): Promise<HealthState> {
      const response = await fetch('/api/health', { signal: controller.signal });
      const body = (await response.text()).trim();
      if (!response.ok) {
        return { status: 'error', detail: `HTTP ${String(response.status)}` };
      }
      return { status: 'ok', detail: body.length > 0 ? body : `HTTP ${String(response.status)}` };
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
