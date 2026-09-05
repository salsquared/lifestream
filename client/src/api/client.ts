/**
 * The fetch transport every API call in the client goes through (P1.12.3).
 *
 * ── WHY THERE ARE TWO ENTRY POINTS AND NOT ONE ────────────────────────────────────────
 * `getForSave` appends `?save=<id>`; `getGlobal` never does. That split is the whole of
 * P1.13's client half: rather than one function whose callers remember to pass the save,
 * the two kinds of read are different functions, so forgetting the scope on a per-save
 * read is not a thing you can do quietly. It matters because the failure mode is silent —
 * a per-save read without the parameter would 400 here, but a per-save read defaulted to
 * some save would return well-formed rows from the wrong world.
 *
 * `country` is global and `country_override` is per-save, so `/api/map/countries` is a
 * PER-SAVE read despite reading a global table: the payload it returns differs by save
 * (architecture §5.1). "Global" here means the response does not depend on which save is
 * active — `/api/health` today, `/api/tags` when P3.6 arrives.
 *
 * ── WHY THE SAVE ID IS AN ARGUMENT AND NOT READ FROM THE STORE ────────────────────────
 * `getForSave` could read `useSave.getState().activeSaveId` itself and spare every caller
 * a parameter. It deliberately does not. §4.2 requires the shell to CAPTURE the active
 * save before a fetch and hand that captured value to `hydrate()` — re-reading the store
 * after the request lands is the race that puts save A's rows in the store under save B's
 * id. Taking the id as an argument makes the caller hold it across the await, which is
 * exactly the discipline the store guard depends on.
 *
 * P6 changes nothing here (P6.3.2): `CANON_SAVE_ID` becomes real state in
 * `shell/stores/save.ts`, and the same call sites pass the same argument.
 *
 * ── WHAT "TYPED" MEANS ────────────────────────────────────────────────────────────────
 * This module is deliberately untyped — it returns `unknown`. The types live one level up,
 * in the per-endpoint modules (`./map`), which name the shared entity type the endpoint
 * answers with and check the envelope before asserting it. A generic `get<T>()` here would
 * be a cast wearing a type parameter, applied at every call site instead of in one place.
 */

/** The server's error body: `{ "error": "<message>" }` (see `server/src/routes/map.ts`). */
type ErrorBody = { error?: unknown };

/** Narrow options — every endpoint here is a GET; `signal` is what the shell needs. */
export type RequestOptions = { signal?: AbortSignal };

/**
 * A request that did not produce a usable payload.
 *
 * `status` is the HTTP status when there was one, and `0` when the failure happened
 * outside the status line — the server never answered, or it answered 200 with a body
 * this client cannot read. Callers that branch on "was this a 404" want the former and
 * would be misled by a synthesized status, so the two cases stay distinguishable.
 */
export class ApiError extends Error {
  readonly url: string;
  readonly status: number;

  constructor(url: string, status: number, message: string) {
    super(`${url} — ${message}`);
    this.name = 'ApiError';
    this.url = url;
    this.status = status;
  }
}

/**
 * Pull the server's `error` string out of a failed response, falling back to the status.
 *
 * Never throws: this runs on a path that is already failing, and a second failure while
 * reading the first one's body would replace a real diagnosis with a parse error.
 */
async function errorMessage(response: Response): Promise<string> {
  const fallback = `HTTP ${String(response.status)}`;
  if (!isJson(response)) return fallback;

  try {
    const body: unknown = await response.json();
    const detail = (body as ErrorBody | null)?.error;
    return typeof detail === 'string' && detail.length > 0 ? `${fallback}: ${detail}` : fallback;
  } catch {
    return fallback;
  }
}

function isJson(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').includes('application/json');
}

/**
 * GET `url`, insisting on a JSON body.
 *
 * THE CONTENT-TYPE CHECK IS NOT CEREMONY, for the same reason `HealthBadge` has one:
 * Vite's SPA fallback serves `index.html` with `200 text/html` for any path it does not
 * recognise, so the moment a URL or the `/api` proxy prefix drifts, a status-only check
 * reports success while holding a page of HTML. Checking before parsing also means the
 * error names what actually arrived ("text/html") rather than a generic parse failure.
 */
async function get(url: string, options: RequestOptions): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      signal: options.signal,
      headers: { Accept: 'application/json' },
    });
  } catch (cause) {
    // An abort is the caller's own doing — StrictMode's double-mount, a save switched
    // mid-flight — and callers recognise it by the error they threw at it. Wrapping it
    // in an ApiError would turn "we cancelled this" into "the API is down".
    if (options.signal?.aborted === true) throw cause;
    throw new ApiError(url, 0, cause instanceof Error ? cause.message : 'network error');
  }

  if (!response.ok) throw new ApiError(url, response.status, await errorMessage(response));

  if (!isJson(response)) {
    const kind = (response.headers.get('content-type') ?? '').split(';')[0]?.trim();
    const got = kind !== undefined && kind.length > 0 ? kind : 'no content-type';
    throw new ApiError(url, response.status, `expected JSON, got ${got}`);
  }

  try {
    return await response.json();
  } catch {
    throw new ApiError(url, response.status, 'malformed JSON');
  }
}

/**
 * A read whose result does not depend on the active save — `/api/health`, and the global
 * tag vocabulary when P3.6 lands. NO `?save=` is appended, and that is the point of it
 * being a separate function from `getForSave`.
 */
export function getGlobal(path: string, options: RequestOptions = {}): Promise<unknown> {
  return get(path, options);
}

/**
 * A read scoped to one save. `?save=<saveId>` is appended here and nowhere else.
 *
 * `path` is the full API URL (`/api/map/countries`), not a fragment, so every URL in the
 * client greps against the ones architecture §5.1/§5.2 specify. It carries no query string
 * of its own — none of the specified reads take another parameter — so the `?` is
 * unconditional rather than a `path.includes('?')` guess.
 */
export function getForSave(
  path: string,
  saveId: string,
  options: RequestOptions = {},
): Promise<unknown> {
  const query = new URLSearchParams({ save: saveId });
  return get(`${path}?${query.toString()}`, options);
}
