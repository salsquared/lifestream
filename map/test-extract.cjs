const https = require('https');
const topojson = require('topojson-client');
const { geoBounds } = require('d3-geo');

https.get('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const topology = JSON.parse(data);
    const featureCollection = topojson.feature(topology, topology.objects.countries);
    
    const france = featureCollection.features.find(f => f.properties.name === 'France');
    console.log(france.geometry.type); // Should be MultiPolygon
    console.log('Total polygons in France:', france.geometry.coordinates.length);
    
    // We want to find the polygon corresponding to French Guiana.
    // French Guiana is in South America: approx long: -54 to -51, lat: 2 to 6
    let fgIndex = -1;
    france.geometry.coordinates.forEach((polygon, i) => {
      // Create a dummy feature to get bounds
      const f = { type: 'Feature', geometry: { type: 'Polygon', coordinates: polygon } };
      const bounds = geoBounds(f);
      const [minLong, minLat] = bounds[0];
      const [maxLong, maxLat] = bounds[1];
      
      // Check if it's in South America
      if (minLong >= -55 && maxLong <= -50 && minLat >= 2 && maxLat <= 6) {
        fgIndex = i;
        console.log(`Found French Guiana at index ${i}`);
      }
    });
  });
});
