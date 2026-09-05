/**
 * The d3-geo map renderer (P2.1, P2.2) — everything the container needs, and nothing about
 * how it is drawn.
 *
 * The seam, restated: `MapView.tsx` owns the stores, the fetches and the sidebar; this
 * directory owns topojson -> GeoJSON, the projection registry, `d3.geoPath`, the `<path>`
 * elements and BOTH input modes. `WorldMap` is presentational — props in, callbacks out.
 * {@link useWorldFeatures} is the one loader beside it, because deriving the feature set is
 * the renderer's job (architecture §3.1) even though the value travels in as a prop.
 */

export { WorldMap, DEFAULT_COUNTRY_FILL } from './WorldMap';
export type { WorldMapProps } from './WorldMap';

export {
  DEFAULT_PROJECTION,
  PROJECTIONS,
  PROJECTION_IDS,
  gestureOwnerFor,
  isProjectionId,
  projectionFor,
} from './projections';
export type { GestureOwner, GlobeCamera, ProjectionEntry, ProjectionId } from './projections';

export { loadWorldFeatures, useWorldFeatures, TOPOJSON_URL, TopologyLoadError } from './features';
export type { LoadOptions, WorldFeaturesState } from './features';
