/**
 * `deriveFeatures` — the single place a topojson feature becomes a `country` row.
 *
 * It runs once at topojson load in **three** callers: the client map view (§5.1), the
 * server-side map export (§8.3) and the country seed (P1.9). All three must agree about
 * what a feature *is*, which is the whole reason this lives in `shared/` — a second index
 * built beside it is how the DB and the map come to disagree, and that specific
 * disagreement is invisible, because the row count stays right.
 *
 * Architecture §3.1 gives it three jobs, not one:
 *
 *   1. **The France -> French Guiana carve.** `world-atlas` bundles French Guiana inside
 *      France's `250` MultiPolygon, so GUF has no feature id of its own to borrow. `"250"`
 *      keeps `geometry_source: 'feature'` with the Guiana ring removed; `x:GUF` is emitted
 *      as `geometry_source: 'derived'`. Ported from `map/src/components/Map.jsx:27-45`.
 *   2. **The raw-id fallback.** Five features in the vendored 50m build carry no id at all
 *      (Somaliland, Kosovo, N. Cyprus, Indian Ocean Ter., Siachen Glacier); Natural Earth
 *      also hands out `-99` in other vintages. They get namespaced synthetic ids instead of
 *      being dropped. Ported from `map/src/components/Map.jsx:67-68`.
 *   3. **Disambiguating a duplicate numeric id.** `"036"` is shared by *Australia* and
 *      *Ashmore and Cartier Is.* This is the dangerous one: a naive `index[id] = feature`
 *      loop keeps whichever it reads second, drops the other, and reports no error — so
 *      `"036"` can silently resolve to Ashmore and Cartier while Australia disappears from
 *      a map whose country count still reads 237.
 *
 * Jobs 1 and 2 are the bridge from the 235 ids the 50m build resolves on its own to the
 * 237 the authored world references. Job 3 adds nothing to that count; it stops one of the
 * 237 being answered by the wrong polygon.
 *
 * **Pure by construction.** No filesystem, no fetch, no `node:*`, no DOM — the caller does
 * the I/O and hands in a parsed topology, so the browser can pass a fetched object and the
 * seed can pass a file it read. Nothing here mutates its inputs.
 */

import { feature } from 'topojson-client';

import type { Feature, Geometry, Position } from 'geojson';
import type { GeometryCollection, Topology } from 'topojson-specification';

/**
 * The only property `world-atlas` carries on a country geometry. A `type` alias rather
 * than an `interface` on purpose: `topojson-client`'s `feature<P extends Properties>`
 * constrains `P` against an index signature, and only type aliases get an implicit one.
 */
export type CountryFeatureProperties = { name?: string };

/**
 * How a row's geometry came to exist — mirrors the `country.geometry_source` enum (§2.4).
 * `'feature'` is 1:1 with a topojson feature; `'derived'` was carved out of one at load
 * time. Ashmore and Cartier Is. is `'feature'` despite its synthetic id: it *is* a real
 * 1:1 feature and only its *id* is unusable, so `'derived'` would be a lie.
 */
// Declared once in `@shared/types`; re-exported so existing importers keep working.
export type { GeometrySource } from '../types/enums.js';
import type { Country } from '../types/entities.js';
import type { GeometrySource } from '../types/enums.js';

/**
 * A `country` row as this module derives it. Field names are the architecture doc's
 * (§2.4) column names verbatim, so the seed can insert without a rename layer.
 */
/**
 * A `country` row as derived from the atlas.
 *
 * This is the shared `Country` entity verbatim — NOT a parallel shape. The seed inserts
 * these rows directly, so a second definition here would be a rename waiting to happen.
 * Property names are camelCase (the wire and TS convention); the snake_case spellings in
 * architecture §2.5 describe the SQL columns, which Drizzle maps to these.
 */
export type DerivedCountry = Country;

/** A GeoJSON feature whose `id` has been resolved to its `country.id`. */
export interface DerivedFeature extends Feature<Geometry, CountryFeatureProperties> {
  id: string;
}

/** Something the derivation had to decide that the caller should see. */
export interface DeriveWarning {
  /** Stable machine-readable kind, so a caller can filter without parsing prose. */
  kind:
    | 'france-feature-missing'
    | 'france-not-multipolygon'
    | 'guiana-ring-not-found'
    | 'unresolved-id-collision'
    | 'collision-winner-not-found'
    | 'feature-name-missing'
    | 'duplicate-derived-id';
  message: string;
}

/** Everything one topojson load produces. */
export interface DerivedFeatureSet {
  /** Every feature, in topojson document order, with the carved `x:GUF` after its parent. */
  features: DerivedFeature[];
  /** One row per entry in {@link DerivedFeatureSet.features}, same order. */
  countries: DerivedCountry[];
  /**
   * `country.id -> feature`. Exported so no caller builds its own — rebuilding this index
   * is exactly the mistake jobs 2 and 3 exist to prevent.
   */
  byId: Map<string, DerivedFeature>;
  /** Non-fatal decisions worth logging. Empty against the pinned `world-atlas@2.0.2` file. */
  warnings: DeriveWarning[];
}

/** Namespace marker for an id ISO cannot name. One convention, so every caller mints the same string. */
export const SYNTHETIC_ID_PREFIX = 'x:';

/** The topojson object holding the country geometries in `world-atlas@2`. */
const DEFAULT_OBJECT_NAME = 'countries';

/**
 * The France -> French Guiana carve (job 1). The bounding box is the one the old app used
 * (`map/src/components/Map.jsx:27-45`) and it is deliberately tight: France's `250`
 * MultiPolygon also carries Mayotte (45.2, -13.0), Réunion (55.8, -21.3) and the Antilles
 * (lon ~ -61), and only French Guiana falls inside these bounds. Widening `maxLon` past
 * -61 would swallow Martinique and Guadeloupe.
 */
const FRANCE_CARVE = {
  parentNumericId: '250',
  bounds: { minLon: -60, maxLon: -40, minLat: -5, maxLat: 10 },
  child: { name: 'French Guiana', alpha3: 'GUF' },
} as const;

/**
 * Identity for features that cannot claim a numeric id — the id-less five and the loser of
 * a numeric-id collision. Keyed by `properties.name`, because a feature with no id has
 * nothing else to key on: the mapping file's one non-numeric fallback entry
 * (`"undefined": "SOL"`) is reached by *all five* id-less features and so cannot tell them
 * apart. That ambiguity is the bug in the old app's `?? strId` line, where Kosovo,
 * N. Cyprus, Indian Ocean Ter. and Siachen Glacier all became `SOL` alongside Somaliland.
 *
 * `alpha3` where a real-world code exists (SOL and GUF agree with the two non-numeric
 * entries in `data/iso-numeric-to-alpha3.json`; XKX is Kosovo's user-assigned code), else
 * `slug` where the name's plain kebab form is not the wanted one. Names not listed here
 * fall through to {@link kebabSlug}, which is why N. Cyprus, Indian Ocean Ter. and
 * Siachen Glacier are absent.
 *
 * A vendored-atlas version bump is the one thing that invalidates this table — it is
 * pinned for exactly that reason.
 */
const UNMAPPED_FEATURE_IDENTITY: Readonly<Record<string, { alpha3?: string; slug?: string }>> = {
  Somaliland: { alpha3: 'SOL' },
  Kosovo: { alpha3: 'XKX' },
  // Plain kebab would give `ashmore-and-cartier-is`; §3.1 fixes the id as `x:ashmore-cartier`.
  'Ashmore and Cartier Is.': { slug: 'ashmore-cartier' },
};

/**
 * Job 3. When two features share a numeric code, **the feature whose name matches that
 * code's alpha-3 mapping keeps the numeric id; the other gets a namespaced synthetic.**
 * `data/iso-numeric-to-alpha3.json` maps `036 -> AUS`, so Australia keeps `"036"` and
 * Ashmore and Cartier Is. becomes `x:ashmore-cartier`.
 *
 * The rule is applied here rather than computed, because deciding "does this name match
 * this alpha-3" needs an alpha-3 -> canonical-name dictionary the project does not have.
 * A collision this table does not name is resolved in document order and reported as an
 * `'unresolved-id-collision'` warning — never dropped, never silently reordered.
 */
const NUMERIC_ID_COLLISION_WINNER: Readonly<Record<string, string>> = {
  '036': 'Australia',
};

/** A numeric feature id, tolerating an unpadded or numeric-typed id from a future vintage. */
const NUMERIC_ID_PATTERN = /^\d{1,3}$/;

/** Lowercase, non-alphanumerics to single dashes, no leading or trailing dash. */
const kebabSlug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * The raw feature id as a usable zero-padded 3-character numeric code, or `null` when the
 * feature has none — `undefined`/`null` (the id-less five) and Natural Earth's `-99`
 * placeholder both land here.
 */
const usableNumericId = (rawId: Feature['id']): string | null => {
  if (rawId === undefined || rawId === null) return null;
  const asString = String(rawId);
  if (!NUMERIC_ID_PATTERN.test(asString)) return null;
  return asString.padStart(3, '0');
};

/** A feature staged for id assignment, before collisions are resolved. */
interface StagedFeature {
  feature: Feature<Geometry, CountryFeatureProperties>;
  name: string;
  /** Non-null only while this feature is still a candidate for the numeric id. */
  numericId: string | null;
  geometrySource: GeometrySource;
  /** Set for a carved row, whose identity does not come from the name table. */
  identityOverride?: { alpha3?: string; slug?: string };
}

/** The first vertex of a polygon's outer ring, or `null` if the ring is malformed. */
const firstVertex = (polygon: Position[][]): { lon: number; lat: number } | null => {
  const point = polygon[0]?.[0];
  const lon = point?.[0];
  const lat = point?.[1];
  if (typeof lon !== 'number' || typeof lat !== 'number') return null;
  return { lon, lat };
};

/**
 * Job 1. Splits France's MultiPolygon into the polygons that stay France and the ones that
 * become French Guiana, testing the first vertex of each polygon's outer ring against
 * {@link FRANCE_CARVE}`.bounds` — the old app's test, unchanged.
 *
 * Returns replacement features rather than editing in place: `deriveFeatures` is pure, and
 * calling it twice on the same topology must give the same answer.
 */
const carveFrenchGuiana = (
  france: Feature<Geometry, CountryFeatureProperties>,
  warnings: DeriveWarning[],
): {
  france: Feature<Geometry, CountryFeatureProperties>;
  guiana: Feature<Geometry, CountryFeatureProperties> | null;
} => {
  if (france.geometry.type !== 'MultiPolygon') {
    warnings.push({
      kind: 'france-not-multipolygon',
      message: `Feature "${FRANCE_CARVE.parentNumericId}" is a ${france.geometry.type}, not a MultiPolygon; French Guiana cannot be carved out of it. x:GUF will be missing.`,
    });
    return { france, guiana: null };
  }

  const { minLon, maxLon, minLat, maxLat } = FRANCE_CARVE.bounds;
  const kept: Position[][][] = [];
  const carved: Position[][][] = [];

  for (const polygon of france.geometry.coordinates) {
    const vertex = firstVertex(polygon);
    const inGuiana =
      vertex !== null &&
      vertex.lon >= minLon &&
      vertex.lon <= maxLon &&
      vertex.lat >= minLat &&
      vertex.lat <= maxLat;
    (inGuiana ? carved : kept).push(polygon);
  }

  if (carved.length === 0) {
    warnings.push({
      kind: 'guiana-ring-not-found',
      message: `No polygon of feature "${FRANCE_CARVE.parentNumericId}" falls inside the French Guiana bounds (lon ${minLon}..${maxLon}, lat ${minLat}..${maxLat}). x:GUF will be missing.`,
    });
    return { france, guiana: null };
  }

  const firstCarved = carved[0];
  return {
    france: {
      ...france,
      geometry: { type: 'MultiPolygon', coordinates: kept },
    },
    guiana: {
      type: 'Feature',
      properties: { name: FRANCE_CARVE.child.name },
      geometry:
        carved.length > 1 || firstCarved === undefined
          ? { type: 'MultiPolygon', coordinates: carved }
          : { type: 'Polygon', coordinates: firstCarved },
    },
  };
};

/**
 * Resolve the vendored topojson into the canonical feature set and the `country` rows it
 * implies. See the module header for the three jobs this performs.
 *
 * @param topology      the parsed topojson — `client/public/topojson/countries-50m.json`,
 *                      vendored and version-pinned so the feature set the `country` table
 *                      was imported from cannot move underneath it.
 * @param numericToAlpha3 `data/iso-numeric-to-alpha3.json`. Supplies the display-only
 *                      `alpha3` for numeric rows; its two non-numeric keys (`"GUF"` and
 *                      `"undefined"`) are the author's own data and are handled by
 *                      {@link UNMAPPED_FEATURE_IDENTITY}, not read from here.
 * @param objectName    the topojson object to read; `world-atlas@2` names it `countries`.
 * @throws if `objectName` is not present in `topology.objects` — a broken input rather
 *         than a data quirk, and silently returning an empty world would be worse.
 */
export function deriveFeatures(
  topology: Topology,
  numericToAlpha3: Readonly<Record<string, string>>,
  objectName: string = DEFAULT_OBJECT_NAME,
): DerivedFeatureSet {
  const warnings: DeriveWarning[] = [];

  const object = topology.objects[objectName];
  if (object === undefined) {
    throw new Error(
      `deriveFeatures: topology has no object "${objectName}" (found: ${Object.keys(topology.objects).join(', ')}).`,
    );
  }

  const collection = feature(topology, object as GeometryCollection<CountryFeatureProperties>);

  // ---- stage every feature, carving French Guiana out of France on the way past (job 1)
  const staged: StagedFeature[] = [];
  for (const [index, raw] of collection.features.entries()) {
    const name = typeof raw.properties?.name === 'string' ? raw.properties.name : '';
    if (name === '') {
      warnings.push({
        kind: 'feature-name-missing',
        message: `Feature at index ${index} (id ${String(raw.id)}) has no properties.name; its synthetic id would be unusable.`,
      });
    }
    const numericId = usableNumericId(raw.id);

    if (numericId === FRANCE_CARVE.parentNumericId) {
      const { france, guiana } = carveFrenchGuiana(raw, warnings);
      staged.push({ feature: france, name, numericId, geometrySource: 'feature' });
      if (guiana !== null) {
        // Placed right after its parent so a derived row sits beside the feature it came from.
        staged.push({
          feature: guiana,
          name: FRANCE_CARVE.child.name,
          numericId: null,
          geometrySource: 'derived',
          identityOverride: { alpha3: FRANCE_CARVE.child.alpha3 },
        });
      }
      continue;
    }

    staged.push({ feature: raw, name, numericId, geometrySource: 'feature' });
  }

  if (!staged.some((entry) => entry.numericId === FRANCE_CARVE.parentNumericId)) {
    warnings.push({
      kind: 'france-feature-missing',
      message: `No feature carries id "${FRANCE_CARVE.parentNumericId}"; the French Guiana carve did not run and x:GUF is missing.`,
    });
  }

  // ---- resolve numeric-id collisions (job 3): losers fall through to a synthetic id
  const byNumericId = new Map<string, StagedFeature[]>();
  for (const entry of staged) {
    if (entry.numericId === null) continue;
    const bucket = byNumericId.get(entry.numericId);
    if (bucket === undefined) byNumericId.set(entry.numericId, [entry]);
    else bucket.push(entry);
  }

  for (const [numericId, candidates] of byNumericId) {
    if (candidates.length < 2) continue;

    const winnerName = NUMERIC_ID_COLLISION_WINNER[numericId];
    const matches = candidates.filter((entry) => entry.name === winnerName);
    // `candidates` has at least two entries, so `candidates[0]` is always present.
    const ruled = matches.length === 1 ? matches[0] : undefined;
    const winner = ruled ?? (candidates[0] as StagedFeature);

    if (ruled === undefined) {
      const names = candidates.map((entry) => `"${entry.name}"`).join(', ');
      warnings.push(
        winnerName === undefined
          ? {
              kind: 'unresolved-id-collision',
              message: `Numeric id "${numericId}" is shared by ${candidates.length} features (${names}) and no collision rule names a winner. "${winner.name}" keeps it in document order; the rest get synthetic ids. Add an entry to NUMERIC_ID_COLLISION_WINNER — the alpha-3 for "${numericId}" is ${numericToAlpha3[numericId] ?? 'unmapped'}.`,
            }
          : {
              kind: 'collision-winner-not-found',
              message: `Numeric id "${numericId}" is shared by ${names}, but the collision rule names "${winnerName}", which matches ${matches.length} of them. "${winner.name}" keeps it in document order; the rest get synthetic ids.`,
            },
      );
    }

    for (const entry of candidates) {
      if (entry !== winner) entry.numericId = null;
    }
  }

  // ---- assign ids and build the rows (job 2 covers everything left without a numeric id)
  const features: DerivedFeature[] = [];
  const countries: DerivedCountry[] = [];
  const byId = new Map<string, DerivedFeature>();

  for (const [index, entry] of staged.entries()) {
    let country: DerivedCountry;

    if (entry.numericId !== null) {
      country = {
        id: entry.numericId,
        name: entry.name,
        isoNumeric: entry.numericId,
        alpha3: numericToAlpha3[entry.numericId],
        geometrySource: entry.geometrySource,
      };
    } else {
      const identity = entry.identityOverride ?? UNMAPPED_FEATURE_IDENTITY[entry.name];
      const suffix = identity?.alpha3 ?? identity?.slug ?? kebabSlug(entry.name);
      country = {
        // A name that kebabs to nothing would mint the bare prefix `x:`, which would then
        // collide with the next such feature; index keeps it unique and traceable.
        id: `${SYNTHETIC_ID_PREFIX}${suffix === '' ? `feature-${index}` : suffix}`,
        name: entry.name,
        alpha3: identity?.alpha3,
        geometrySource: entry.geometrySource,
      };
    }

    const derived: DerivedFeature = { ...entry.feature, id: country.id };

    if (byId.has(country.id)) {
      warnings.push({
        kind: 'duplicate-derived-id',
        message: `Two features resolved to the same country id "${country.id}" ("${byId.get(country.id)?.properties?.name ?? ''}" and "${entry.name}"); the second is kept out of the index.`,
      });
    } else {
      byId.set(country.id, derived);
    }

    features.push(derived);
    countries.push(country);
  }

  return { features, countries, byId, warnings };
}
