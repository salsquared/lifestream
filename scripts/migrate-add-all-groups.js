// Adds `allGroups` to a map save file.
// allGroups = all unifiedNations + every country in countryNames not already in a group (as independent single-country groups).
// Usage: node scripts/migrate-add-all-groups.js [filename]
//        filename defaults to lifestream_map_v1.json

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const saveFile = process.argv[2] ?? 'lifestream_map_v1.json';
const savePath = resolve(__dirname, '../data/map_saves', saveFile);

const project = JSON.parse(readFileSync(savePath, 'utf-8'));

if (project.allGroups) {
  console.log(`${saveFile} already has allGroups — nothing to do.`);
  process.exit(0);
}

const groupedIds = new Set(project.unifiedNations.flatMap((n) => n.countries.filter(Boolean)));

const independentGroups = Object.entries(project.countryNames)
  .filter(([id]) => !groupedIds.has(id))
  .map(([id, name]) => ({
    id,
    name,
    color: '#334155',
    countries: [id],
    independent: true,
  }));

project.allGroups = [...project.unifiedNations, ...independentGroups];

writeFileSync(savePath, JSON.stringify(project, null, 2));

console.log(
  `Migrated ${saveFile}: ${project.unifiedNations.length} groups + ${independentGroups.length} independent countries added to allGroups.`,
);
independentGroups.forEach((g) => console.log(`  + ${g.name} (${g.id})`));
