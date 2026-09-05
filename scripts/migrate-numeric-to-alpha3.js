// Converts all country IDs in a map save file from ISO numeric strings to ISO alpha-3.
// Handles: unifiedNations[].countries, countryNames keys, allGroups[].countries,
//          and allGroups[].id for independent (solo) country entries.
// Null entries in countries arrays are stripped as a side effect.
// Usage: node scripts/migrate-numeric-to-alpha3.js [filename]
//        filename defaults to lifestream_map_v1.json

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const mapping = JSON.parse(
  readFileSync(resolve(__dirname, '../data/iso-numeric-to-alpha3.json'), 'utf-8'),
);

const saveFile = process.argv[2] ?? 'lifestream_map_v1.json';
const savePath = resolve(__dirname, '../data/map_saves', saveFile);

const project = JSON.parse(readFileSync(savePath, 'utf-8'));

function toAlpha3(id) {
  if (id === null || id === undefined) return null;
  const str = String(id);
  return mapping[str] ?? str;
}

// countryNames: remap keys
const newCountryNames = {};
for (const [id, name] of Object.entries(project.countryNames ?? {})) {
  newCountryNames[toAlpha3(id)] = name;
}
project.countryNames = newCountryNames;

// unifiedNations: remap countries arrays, strip nulls
project.unifiedNations = project.unifiedNations.map((nation) => ({
  ...nation,
  countries: nation.countries.filter(Boolean).map(toAlpha3),
}));

// allGroups: remap countries arrays + id for independent entries, strip nulls
if (project.allGroups) {
  project.allGroups = project.allGroups.map((group) => {
    const updated = {
      ...group,
      countries: group.countries.filter(Boolean).map(toAlpha3),
    };
    if (group.independent) updated.id = toAlpha3(group.id);
    return updated;
  });
}

writeFileSync(savePath, JSON.stringify(project, null, 2));
console.log(`Migrated ${saveFile} to alpha-3 IDs.`);
