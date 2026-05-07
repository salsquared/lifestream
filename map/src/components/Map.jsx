import React, { useState, useEffect, memo } from 'react';
import {
  ComposableMap,
  Geographies,
  Geography,
  ZoomableGroup,
  Marker
} from 'react-simple-maps';
import { geoCentroid } from 'd3-geo';
import { Plus, Minus } from 'lucide-react';
import { feature } from 'topojson-client';
import numericToAlpha3 from '../../../data/iso-numeric-to-alpha3.json';

const geoUrl = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json";

const Map = ({ selectedCountries, toggleCountrySelection, unifiedNations, setTooltipContent, editingId, onCountriesLoaded }) => {
  const [position, setPosition] = useState({ coordinates: [0, 0], zoom: 1 });
  const [geoFeatures, setGeoFeatures] = useState(null);

  useEffect(() => {
    fetch(geoUrl)
      .then(res => res.json())
      .then(topology => {
        // Parse TopoJSON into GeoJSON
        const { features } = feature(topology, topology.objects.countries);

        // Find France (ID: 250)
        const franceIndex = features.findIndex(f => f.id === "250");
        if (franceIndex > -1) {
          const france = features[franceIndex];
          const franceCoords = [];
          const fgCoords = [];

          if (france.geometry.type === 'MultiPolygon') {
            france.geometry.coordinates.forEach(polygon => {
              // French Guiana is in South America (approx lon -55 to -50, lat 2 to 6)
              // Polygon[0] is the outer ring, [0] is the first coordinate pair
              const [lon, lat] = polygon[0][0];
              if (lon >= -60 && lon <= -40 && lat >= -5 && lat <= 10) {
                fgCoords.push(polygon);
              } else {
                franceCoords.push(polygon);
              }
            });

            // Update France
            france.geometry.coordinates = franceCoords;

            // Create French Guiana feature
            if (fgCoords.length > 0) {
              const frenchGuiana = {
                type: 'Feature',
                id: 'GUF', // Use standard ISO code or pseudo code
                properties: { ...france.properties, name: 'French Guiana' },
                geometry: {
                  type: fgCoords.length > 1 ? 'MultiPolygon' : 'Polygon',
                  coordinates: fgCoords.length > 1 ? fgCoords : fgCoords[0]
                }
              };
              features.push(frenchGuiana);
            }
          }
        }

        // Remap all feature IDs from ISO numeric to alpha-3
        features.forEach(f => {
          const strId = (f.id === undefined || f.id === null) ? 'undefined' : String(f.id);
          f.id = numericToAlpha3[strId] ?? strId;
        });

        setGeoFeatures(features);

        if (onCountriesLoaded) {
          const dict = {};
          features.forEach(f => {
            if (f.id && f.properties?.name) dict[f.id] = f.properties.name;
          });
          onCountriesLoaded(dict);
        }
      });
  }, []);

  const handleZoomIn = () => {
    if (position.zoom >= 15) return;
    setPosition((pos) => ({ ...pos, zoom: pos.zoom * 1.5 }));
  };

  const handleZoomOut = () => {
    if (position.zoom <= 1) return;
    setPosition((pos) => ({ ...pos, zoom: pos.zoom / 1.5 }));
  };

  const handleMoveEnd = (position) => {
    setPosition(position);
  };

  // Wait for features to parse
  if (!geoFeatures) return null;

  return (
    <div className="map-container" style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div style={{ position: 'absolute', right: 20, top: 20, zIndex: 10, display: 'flex', flexDirection: 'column', gap: '5px' }}>
        <button 
          onClick={handleZoomIn} 
          style={{ width: '36px', height: '36px', borderRadius: '4px', background: 'var(--panel-bg)', color: 'white', border: '1px solid var(--border-color)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          title="Zoom In"
        >
          <Plus size={20} />
        </button>
        <button 
          onClick={handleZoomOut} 
          style={{ width: '36px', height: '36px', borderRadius: '4px', background: 'var(--panel-bg)', color: 'white', border: '1px solid var(--border-color)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          title="Zoom Out"
        >
          <Minus size={20} />
        </button>
      </div>
      
      <ComposableMap
        projectionConfig={{
          scale: 150,
          rotation: [-11, 0, 0],
        }}
        width={800}
        height={600}
        style={{ width: "100%", height: "100%" }}
      >
        <ZoomableGroup 
          zoom={position.zoom} 
          center={position.coordinates} 
          onMoveEnd={handleMoveEnd}
          minZoom={1}
          maxZoom={15}
        >
          <Geographies geography={geoFeatures}>
            {({ geographies }) =>
              geographies.map((geo) => {
                const isSelected = selectedCountries.includes(geo.id);
                
                const unifiedNation = unifiedNations.find(un => un.countries.includes(geo.id));
                const isEditingNation = editingId && unifiedNation && unifiedNation.id === editingId;
                
                let defaultFill = "#3b82f6"; // solo/unassigned = blue

                if (unifiedNation) {
                  defaultFill = unifiedNation.color;
                } else if (isSelected) {
                  defaultFill = "#f59e0b"; // actively selected for grouping = amber
                }

                const showLabel = position.zoom > 3 && geo.properties.name && geo.id !== "ATA";

                return (
                  <React.Fragment key={geo.rsmKey || geo.id}>
                    <Geography
                      geography={geo}
                      onClick={() => toggleCountrySelection(geo.id, geo.properties.name)}
                      onMouseEnter={() => {
                        const name = geo.properties.name;
                        const label = unifiedNation ? `${name} (${unifiedNation.name})` : name;
                        setTooltipContent(label);
                      }}
                      onMouseLeave={() => {
                        setTooltipContent("");
                      }}
                      style={{
                        default: {
                          fill: defaultFill,
                          stroke: "#0f172a",
                          strokeWidth: 0.5 / position.zoom,
                          outline: "none",
                          transition: "fill 0.2s"
                        },
                        hover: {
                          fill: isSelected ? "#d97706" : unifiedNation ? unifiedNation.color : "#2563eb",
                          stroke: "#f8fafc",
                          strokeWidth: 1 / position.zoom,
                          outline: "none",
                          cursor: "pointer",
                          transition: "all 0.2s"
                        },
                        pressed: {
                          fill: "#1d4ed8",
                          outline: "none",
                        },
                      }}
                    />
                    {showLabel && (
                      <Marker coordinates={geoCentroid(geo)}>
                        <text
                          textAnchor="middle"
                          fill="#f8fafc"
                          fontSize={6 / position.zoom}
                          style={{ pointerEvents: 'none', textShadow: '1px 1px 2px #000' }}
                        >
                          {geo.properties.name}
                        </text>
                      </Marker>
                    )}
                  </React.Fragment>
                );
              })
            }
          </Geographies>
        </ZoomableGroup>
      </ComposableMap>
    </div>
  );
};

export default memo(Map);
