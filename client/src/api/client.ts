/**
 * The fetch transport every API call in the client goes through (P1.12.3, P2.6).
 *
 * ── WHY THERE ARE TWO ENTRY POINTS AND NOT ONE ────────────────────────────────────────
 * `getForSave` appends `?save=<id>`; `getGlobal` never does. That split is the whole of
 * P1.13's client half: rather than one function whose callers remember to pass the save,
 * the two kinds of read are different functions, so forgetting the scope on a per-save
 * read is not a thing you can do quietly. It matters because the failure mode is silent —
 * a per-save read without the parameter would 400 here, but a per-save read defaulted to
 * some save would return well-formed rows from the wrong world.
 *
 * `sendForSave` (P2.6) is the write half and takes the verb, because the split worth
 * having is scoped-vs-global and *there is no global write*: every mutable row carries a
 * `save_id` (§7). It is a third entry point, not a second dimension on the first — a
 * `get()` that could also POST would make "this call cannot change anything" unreadable
 * at the call site.
 *
 * `country` is global and `country_override` is per-save, so `/api/map/countries` is a
 * PER-SAVE read despite reading a global table: the payload it returns differs by save
 * (architecture §5.1). "Global" here means the response does not depend on which save is
 * active — `/api/health` is the only one. `/api/tags` was expected to join it and did NOT: it carries
 * per-save usage counts, so it is a per-save read despite `tag` being a global table —
 * the same shape as `/api/map/countries`, which reads a global table through per-save
 * overrides.
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

/** Narrow options — `signal` is what the shell and the map container need. */
export type RequestOptions = { signal?: AbortSignal };

/**
 * The four write verbs this API uses. There is no `GET` here: a read goes through
 * `getGlobal`/`getForSave`, and keeping the two sets disjoint is what stops a write
 * being issued by the function whose contract says it does not change anything.
 */
export type WriteMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * A request that did not produce a usable payload.
 *
 * `status` is the HTTP status when there was one, and `0` when the failure happened
 * outside the status line — the server never answered, or it answered 200 with a body
 * this client cannot read. Callers that branch on "was this a 404" want the former and
 * would be misled by a synthesized status, so the two cases stay distinguishable.
 *
 * `body` IS THE PARSED ERROR ENVELOPE, and it is here for exactly one caller. The map's
 * `PUT /api/groupings/:id/countries/:countryId` answers **409 with the current owner
 * named in the body** (`{ error, ownedBy: { id, name } }`, architecture §5.1) — that name
 * is what the "Move from ⟨X⟩?" prompt is built from, so discarding everything but the
 * message would leave the prompt with nothing to say. It is `unknown` and stays `unknown`:
 * narrowing it belongs to the endpoint module that knows which error shape its URL
 * produces, not to the transport. `undefined` when the failure had no JSON body at all.
 */
export class ApiError extends Error {
  readonly url: string;
  readonly status: number;
  readonly body: unknown;

  constructor(url: string, status: number, message: string, body?: unknown) {
    super(`${url} — ${message}`);
    this.name = 'ApiError';
    this.url = url;
    this.status = status;
    this.body = body;
  }
}

/**
 * Pull the server's `error` string and the raw envelope out of a failed response.
 *
 * Never throws: this runs on a path that is already failing, and a second failure while
 * reading the first one's body would replace a real diagnosis with a parse error.
 */
async function errorDetail(response: Response): Promise<{ message: string; body: unknown }> {
  const fallback = `HTTP ${String(response.status)}`;
  if (!isJson(response)) return { message: fallback, body: undefined };

  try {
    const body: unknown = await response.json();
    const detail = (body as ErrorBody | null)?.error;
    const message =
      typeof detail === 'string' && detail.length > 0 ? `${fallback}: ${detail}` : fallback;
    return { message, body };
  } catch {
    return { message: fallback, body: undefined };
  }
}

function isJson(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').includes('application/json');
}

/**
 * Turn a settled `Response` into its parsed JSON body, or throw an `ApiError`.
 *
 * THE CONTENT-TYPE CHECK IS NOT CEREMONY, for the same reason `HealthBadge` has one:
 * Vite's SPA fallback serves `index.html` with `200 text/html` for any path it does not
 * recognise, so the moment a URL or the `/api` proxy prefix drifts, a status-only check
 * reports success while holding a page of HTML. Checking before parsing also means the
 * error names what actually arrived ("text/html") rather than a generic parse failure.
 */
async function body(url: string, response: Response): Promise<unknown> {
  if (!response.ok) {
    const detail = await errorDetail(response);
    throw new ApiError(url, response.status, detail.message, detail.body);
  }

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

/** One `fetch`, with the transport's error policy applied to both halves of it. */
async function request(url: string, init: RequestInit, options: RequestOptions): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: options.signal });
  } catch (cause) {
    // An abort is the caller's own doing — StrictMode's double-mount, a save switched
    // mid-flight — and callers recognise it by the error they threw at it. Wrapping it
    // in an ApiError would turn "we cancelled this" into "the API is down".
    if (options.signal?.aborted === true) throw cause;
    throw new ApiError(url, 0, cause instanceof Error ? cause.message : 'network error');
  }

  return body(url, response);
}

/** `?save=<saveId>` — appended here and nowhere else, for reads and writes alike. */
function scoped(path: string, saveId: string): string {
  const query = new URLSearchParams({ save: saveId });
  return `${path}?${query.toString()}`;
}

/**
 * A read whose result does not depend on the active save — `/api/health`, and the global
 * tag vocabulary when P3.6 lands. NO `?save=` is appended, and that is the point of it
 * being a separate function from `getForSave`.
 */
export function getGlobal(path: string, options: RequestOptions = {}): Promise<unknown> {
  return request(path, { method: 'GET', headers: { Accept: 'application/json' } }, options);
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
  return request(
    scoped(path, saveId),
    { method: 'GET', headers: { Accept: 'application/json' } },
    options,
  );
}

/**
 * A WRITE scoped to one save (P2.6) — the mutating twin of `getForSave`.
 *
 * ONE FUNCTION TAKING THE VERB, rather than a `postForSave`/`putForSave`/… family: the
 * split that earns its keep in this module is *scoped vs. global*, because forgetting the
 * scope is silent, and there is no such thing as a global write in this API — every
 * mutable row carries a `save_id` (§7). Splitting by verb instead would multiply the
 * `?save=` logic by four and guard nothing.
 *
 * THE SAVE ID IS AN ARGUMENT HERE FOR A SHARPER REASON THAN ON THE READ SIDE. A write
 * fires from a click handler, so `useSave.getState().activeSaveId` read *inside* the
 * callback is read at an arbitrary later moment — after an `await`, after the user
 * switched saves. The container captures the active save once and hands it down, and
 * this signature is what forces that. Filing one save's `grouping_country` rows under
 * another save's id is not recoverable by a refetch.
 *
 * Every write endpoint answers a named JSON object (`{ grouping }`, `{ members }`,
 * `{ ok: true }`, …), so the same JSON insistence as the reads applies unchanged — a
 * `204 No Content` would fail here, and none of §5.1's writes returns one.
 */
export function sendForSave(
  method: WriteMethod,
  path: string,
  saveId: string,
  payload?: unknown,
  options: RequestOptions = {},
): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const init: RequestInit = { method, headers };

  // A body is sent only when there is one to send. `DELETE /api/groupings/:id` has no
  // payload, and a `Content-Type: application/json` header over an empty body is the
  // kind of thing a strict body parser rejects.
  if (payload !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(payload);
  }

  return request(scoped(path, saveId), init, options);
}
