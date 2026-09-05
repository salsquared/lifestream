/**
 * P2.1 — the world, drawn.
 *
 * PRESENTATIONAL BY CONTRACT. Everything this component draws arrives in {@link WorldMapProps};
 * it fetches nothing, reads no store and knows nothing about saves or groupings. The
 * container (`MapView.tsx`) owns all of that and passes the results down. That seam is what
 * lets the two be built at the same time, so it is honoured exactly: no prop is added, none
 * is reinterpreted, and no store is reached for.
 *
 * The one thing it does own besides pixels is the input modes (P2.2) — see `useInputMode`.
 *
 * ── THINGS HERE THAT LOOK LIKE DETAIL AND ARE NOT ─────────────────────────────────────
 * `vector-effect: non-scaling-stroke` on every path. In the flat projections `d3-zoom`
 * writes a transform onto the wrapping `<g>`, and an SVG transform scales stroke widths
 * along with geometry: without this the borders thicken with the zoom and the map turns to
 * mush at depth. It is set as an ATTRIBUTE rather than in the stylesheet because the
 * presentation attribute is what every renderer honours.
 *
 * Country ids are the zero-padded strings and `x:`-namespaced synthetics `deriveFeatures`
 * mints (`"004"`, `"250"`, `x:GUF`). They are read straight off the feature and passed back
 * out through the callbacks untouched — never parsed, never compared to a number.
 *
 * The sphere and the graticule sit BEHIND the countries. Without them an orthographic
 * render is a ragged blob of land with no globe under it (P2.1.5).
 */

import { geoGraticule10, geoPath } from 'd3-geo';
import { useCallback, useMemo, useRef, useState } from 'react';

import { projectionFor, SPHERE, type ProjectionId } from './projections';
import { useElementSize } from './useElementSize';
import { useInputMode } from './useInputMode';

import './worldMap.css';

import type { DerivedFeatureSet } from '@shared/geo/deriveFeatures';
import type { MouseEvent as ReactMouseEvent } from 'react';

export type { ProjectionId } from './projections';

/**
 * The fill for a country the container gave no colour — i.e. an independent nation, which
 * is a DERIVED state (no `grouping_country` row), never a stored one. Exported so a legend
 * or a sidebar swatch can name the same colour rather than guessing at it.
 */
export const DEFAULT_COUNTRY_FILL = '#39414f';

/** The 10°-spaced graticule. Constant, so it is built once rather than per render. */
const GRATICULE = geoGraticule10();

export interface WorldMapProps {
  /** Derived features, already through `deriveFeatures()`. Keyed by `country.id`. */
  features: DerivedFeatureSet;
  projection: ProjectionId;

  /** `country.id -> the fill to paint`. Absent = the independent/default fill. */
  fillById: ReadonlyMap<string, string>;
  /** Display name per `country.id` (override applied by the container, not here). */
  nameById: ReadonlyMap<string, string>;

  /** Countries to draw in a highlighted state (the glow set). */
  glowIds: ReadonlySet<string>;
  /** The single primary selection, drawn distinctly from glow. */
  primaryId?: string;
  /** Members of the grouping currently being edited — drawn as "in the edit set". */
  editingMemberIds?: ReadonlySet<string>;

  onCountryClick(countryId: string, ev: { shiftKey: boolean }): void;
  onCountryContextMenu(countryId: string, at: { x: number; y: number }): void;
  onCountryHover(countryId: string | undefined): void;
}

/** One country, ready to render. `d` depends on the projection; nothing else here does. */
interface CountryPath {
  id: string;
  d: string;
  /** The atlas's own name, used only when the container has no name for this id. */
  fallbackName: string;
}

/** Which extra layer a country is redrawn in, on top of the base fills. */
type MarkKind = 'glow' | 'editing' | 'primary';

/** The country id under an event target, or `undefined` for the ocean. */
function countryIdOf(target: EventTarget | null): string | undefined {
  if (!(target instanceof Element)) return undefined;
  return target.closest('[data-country]')?.getAttribute('data-country') ?? undefined;
}

export function WorldMap(props: WorldMapProps): React.JSX.Element {
  const {
    features,
    projection: projectionId,
    fillById,
    nameById,
    glowIds,
    primaryId,
    editingMemberIds,
  } = props;

  const hostRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const { width, height } = useElementSize(hostRef);

  const { owner, groupTransform, camera } = useInputMode({
    projection: projectionId,
    width,
    height,
    svgRef,
  });

  /**
   * THE PATH GENERATOR'S ONLY INPUT. `camera` is `undefined` for every flat projection —
   * `useInputMode` guarantees it — so under `d3-zoom` this memo is stable across the whole
   * interaction and the `d` strings below are never recomputed. Under orthographic the
   * camera changes on each drag frame and they are, which is the intended asymmetry: one
   * mode moves the paint, the other repaints.
   */
  const projection = useMemo(
    () => projectionFor(projectionId, width, height, camera),
    [projectionId, width, height, camera],
  );

  const scene = useMemo(() => {
    const path = geoPath(projection);
    const countries: CountryPath[] = features.features.map((feature) => ({
      id: feature.id,
      d: path(feature) ?? '',
      fallbackName: feature.properties?.name ?? feature.id,
    }));
    return { sphere: path(SPHERE) ?? '', graticule: path(GRATICULE) ?? '', countries };
  }, [features, projection]);

  const [hoveredId, setHoveredId] = useState<string | undefined>(undefined);
  const hoveredRef = useRef<string | undefined>(undefined);

  // The prop callbacks change identity on every container render; the DOM handlers below
  // must not, or React would rebind four listeners per frame of a globe drag. Reading them
  // through a ref keeps the handlers stable without making them stale.
  const callbacksRef = useRef(props);
  callbacksRef.current = props;

  const setHover = useCallback((id: string | undefined): void => {
    if (hoveredRef.current === id) return;
    hoveredRef.current = id;
    setHoveredId(id);
    callbacksRef.current.onCountryHover(id);
  }, []);

  const handleClick = useCallback((event: ReactMouseEvent<SVGGElement>): void => {
    const id = countryIdOf(event.target);
    if (id === undefined) return;
    callbacksRef.current.onCountryClick(id, { shiftKey: event.shiftKey });
  }, []);

  const handleContextMenu = useCallback((event: ReactMouseEvent<SVGGElement>): void => {
    const id = countryIdOf(event.target);
    if (id === undefined) return;
    // The container puts its menu at these coordinates, so the browser's own must go.
    event.preventDefault();
    callbacksRef.current.onCountryContextMenu(id, { x: event.clientX, y: event.clientY });
  }, []);

  const handlePointerOver = useCallback(
    (event: ReactMouseEvent<SVGGElement>): void => {
      setHover(countryIdOf(event.target));
    },
    [setHover],
  );

  const handlePointerOut = useCallback(
    (event: ReactMouseEvent<SVGGElement>): void => {
      // `relatedTarget` is what the pointer moved ONTO. Sliding from one country straight to
      // its neighbour must not report `undefined` in between — the container would see a
      // hover flicker on every border crossing.
      if (countryIdOf(event.relatedTarget) === undefined) setHover(undefined);
    },
    [setHover],
  );

  /**
   * SVG has no z-index: a neighbour drawn later paints over the selected country's stroke.
   * So the highlighted subset is drawn again, unfilled, in a layer above the fills — glow
   * first, then the edit set, then the single primary, so the strongest signal is on top.
   */
  const marks = useMemo(() => {
    const ordered: { id: string; d: string; kind: MarkKind }[] = [];
    const push = (kind: MarkKind, holds: (id: string) => boolean): void => {
      for (const country of scene.countries) {
        if (holds(country.id)) ordered.push({ id: country.id, d: country.d, kind });
      }
    };
    push('glow', (id) => glowIds.has(id));
    if (editingMemberIds !== undefined) push('editing', (id) => editingMemberIds.has(id));
    if (primaryId !== undefined) push('primary', (id) => id === primaryId);
    return ordered;
  }, [scene, glowIds, editingMemberIds, primaryId]);

  return (
    <div ref={hostRef} className="world-map">
      <svg
        ref={svgRef}
        className={`world-map__svg world-map__svg--${owner}`}
        width={width}
        height={height}
        role="img"
        aria-label="World map"
      >
        {/* The ONE transform in this component. `groupTransform` is a string under d3-zoom
            and `undefined` under orthographic, and React omits an undefined attribute — so
            in rotate mode this element genuinely carries no transform. */}
        <g className="world-map__scene" transform={groupTransform}>
          <path
            className="world-map__sphere"
            d={scene.sphere}
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
          />
          {owner === 'rotate' && (
            <path
              className="world-map__graticule"
              d={scene.graticule}
              fill="none"
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
          )}

          <g
            className="world-map__countries"
            onClick={handleClick}
            onContextMenu={handleContextMenu}
            onMouseOver={handlePointerOver}
            onMouseOut={handlePointerOut}
          >
            {scene.countries.map((country) => (
              <path
                key={country.id}
                data-country={country.id}
                className={
                  country.id === hoveredId
                    ? 'world-map__country world-map__country--hover'
                    : 'world-map__country'
                }
                d={country.d}
                fill={fillById.get(country.id) ?? DEFAULT_COUNTRY_FILL}
                vectorEffect="non-scaling-stroke"
              >
                <title>{nameById.get(country.id) ?? country.fallbackName}</title>
              </path>
            ))}
          </g>

          <g className="world-map__marks" pointerEvents="none">
            {marks.map((mark) => (
              <path
                key={`${mark.kind}:${mark.id}`}
                className={`world-map__mark world-map__mark--${mark.kind}`}
                d={mark.d}
                fill="none"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </g>
        </g>
      </svg>
    </div>
  );
}
