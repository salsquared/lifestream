/**
 * Loading the world (P2.1.1, P2.1.2).
 *
 * ── WHERE THIS SITS IN THE P2 SEAM ────────────────────────────────────────────────────
 * `WorldMap` itself is presentational: it takes a `DerivedFeatureSet` as a prop and fetches
 * nothing. This module is the loader that produces that prop, and it lives beside the
 * renderer rather than inside the container because the derivation is the renderer's
 * business (architecture §3.1): the client and the database have to agree about what a
 * feature is, and that agreement is `deriveFeatures`, not a second index. The container
 * calls {@link useWorldFeatures} and hands the result down.
 *
 * ── WHY IT CALLS `fetch` DIRECTLY AND NOT THROUGH `client/src/api` ────────────────────
 * The P2 contract makes `MapView.tsx` the only importer of `client/src/api`, and the
 * topojson is not an API read: it is a static asset served from the app's own origin
 * (vendored in P0.6 — no CDN, so the map draws offline). It does keep the content-type
 * check the API transport has, and for the same reason: Vite's SPA fallback answers an
 * unknown path with `200 text/html`, so a status-only check would report success while
 * holding a page of HTML.
 *
 * ── ALL THREE JOBS OF `deriveFeatures` RUN HERE ───────────────────────────────────────
 * France carves French Guiana; the five id-less features get synthetic ids; and the `"036"`
 * shared by Australia and Ashmore and Cartier Is. is disambiguated. Skipping the third
 * silently drops one of them — no error, and the country count still reads right, because
 * the DB row is fine. Ids are zero-padded strings (`"004"`) or `x:`-namespaced (`x:GUF`)
 * and are NEVER coerced to numbers: `4 !== "004"` and every lookup between the two misses.
 */

import { useEffect, useState } from 'react';

import { deriveFeatures, type DerivedFeatureSet } from '@shared/geo/deriveFeatures';

/** The vendored, version-pinned atlas (P0.6). Same-origin, never a CDN. */
export const TOPOJSON_URL = '/topojson/countries-50m.json';

/** The parsed topojson, named off the one function that consumes it rather than re-imported. */
type WorldTopology = Parameters<typeof deriveFeatures>[0];

/**
 * `iso_numeric -> alpha-3`, which `deriveFeatures` uses for the DISPLAY-ONLY `alpha3` field
 * on its derived `country` rows and for one warning message. It is deliberately empty here.
 *
 * `data/iso-numeric-to-alpha3.json` is a repo-root data file, not a client asset, and the
 * client has no need of it: the authoritative `Country` rows — with `alpha3` — arrive from
 * `GET /api/map/countries`, and the renderer keys on `country.id` alone. Crucially, none of
 * the three derivation jobs consults this table: the France carve is geometric, the id-less
 * five are keyed by name, and the `"036"` winner is named by a rule inside the module. So
 * the FEATURE SET this produces is identical to the seed's, which is the property that
 * matters. Pass a real table through {@link LoadOptions.numericToAlpha3} if a caller ever
 * needs the `alpha3` column client-side.
 */
const NO_ALPHA3_TABLE: Readonly<Record<string, string>> = Object.freeze({});

export interface LoadOptions {
  signal?: AbortSignal;
  /** See {@link NO_ALPHA3_TABLE} — affects only the derived rows' `alpha3`, never the geometry. */
  numericToAlpha3?: Readonly<Record<string, string>>;
}

/** A topojson load that did not produce a usable world. */
export class TopologyLoadError extends Error {
  readonly url: string;
  readonly status: number;

  constructor(url: string, status: number, message: string) {
    super(`${url} — ${message}`);
    this.name = 'TopologyLoadError';
    this.url = url;
    this.status = status;
  }
}

/**
 * Fetch the vendored topojson and run it through `deriveFeatures`.
 *
 * Warnings are logged rather than thrown: against the pinned `world-atlas@2.0.2` file there
 * are none, so anything printed here means the atlas vintage moved under the seeded
 * `country` rows — worth seeing, not worth blanking the map for.
 */
export async function loadWorldFeatures(options: LoadOptions = {}): Promise<DerivedFeatureSet> {
  let response: Response;
  try {
    response = await fetch(TOPOJSON_URL, {
      signal: options.signal,
      headers: { Accept: 'application/json' },
    });
  } catch (cause) {
    // An abort is the caller's own doing — StrictMode's double-mount — and is rethrown
    // untouched so it is not mistaken for the atlas being unreachable.
    if (options.signal?.aborted === true) throw cause;
    throw new TopologyLoadError(
      TOPOJSON_URL,
      0,
      cause instanceof Error ? cause.message : 'network error',
    );
  }

  if (!response.ok) {
    throw new TopologyLoadError(TOPOJSON_URL, response.status, `HTTP ${String(response.status)}`);
  }

  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
  if (!contentType.includes('json')) {
    throw new TopologyLoadError(
      TOPOJSON_URL,
      response.status,
      `expected JSON, got ${contentType.length > 0 ? contentType : 'no content-type'}`,
    );
  }

  let topology: WorldTopology;
  try {
    topology = (await response.json()) as WorldTopology;
  } catch {
    throw new TopologyLoadError(TOPOJSON_URL, response.status, 'malformed JSON');
  }

  const derived = deriveFeatures(topology, options.numericToAlpha3 ?? NO_ALPHA3_TABLE);
  for (const warning of derived.warnings) {
    console.warn(`[world map] deriveFeatures ${warning.kind}: ${warning.message}`);
  }
  return derived;
}

/** What {@link useWorldFeatures} is doing right now. */
export type WorldFeaturesState =
  | { status: 'loading' }
  | { status: 'ready'; features: DerivedFeatureSet }
  | { status: 'error'; error: Error };

/**
 * Load the world once, for the lifetime of the mounted component.
 *
 * The atlas is a pinned static file, so there is nothing to re-fetch: no dependencies, no
 * refresh, and the active save does not scope it (geometry is global — §3.1).
 */
export function useWorldFeatures(): WorldFeaturesState {
  const [state, setState] = useState<WorldFeaturesState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();

    loadWorldFeatures({ signal: controller.signal })
      .then((features) => {
        setState({ status: 'ready', features });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: 'error',
          error: error instanceof Error ? error : new Error('topojson load failed'),
        });
      });

    return () => {
      controller.abort();
    };
  }, []);

  return state;
}
