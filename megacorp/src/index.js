import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load a map save file — pass the filename as a CLI arg or use the default
const saveFile = process.argv[2] ?? 'lifestream_map_v1.json';
const savePath = resolve(__dirname, '../../data/map_saves', saveFile);

const project = JSON.parse(readFileSync(savePath, 'utf-8'));
const nations = project.allGroups ?? project.unifiedNations;

const results = nations.map(nation => ({
  nation: nation.name,
  countryCount: nation.countries.length,
  megacorps: calculateMegacorps(nation),
}));

console.table(results);

function calculateMegacorps(nation) {
  // Placeholder formula — replace with real logic
  // e.g. larger nations support more megacorps
  const count = nation.countries.length;
  if (count >= 15) return 5;
  if (count >= 8)  return 4;
  if (count >= 4)  return 3;
  if (count >= 2)  return 2;
  return 1;
}
