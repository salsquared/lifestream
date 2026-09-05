/**
 * Reading the authored world off disk and resolving it into rows — everything the seed
 * decides BEFORE a statement is issued (P1.9, P1.11).
 *
 * Nothing here touches the database. That is what makes the country-key arithmetic
 * testable: `readSeedInputs()` either produces a resolved world or throws naming every
 * code it could not place, and `runSeed()` only writes what it is handed.
 *
 * ── WHY `deriveFeatures` IS A PARAMETER AND NOT AN IMPORT ─────────────────────────────
 * `deriveFeatures` is the single place a topojson feature becomes a `country` row (§3.1,
 * P1.9.1) and this module must not rebuild that index. It is nevertheless passed in rather
 * than imported, because of where the seed runs: `npm run db:seed` is `tsx scripts/seed.ts`
 * from the repo root, there is no root `tsconfig.json`, and so the `@shared/*` path alias
 * does not resolve for that process. Every other `@shared` import under `server/src` is
 * `import type` and erases before it ever reaches a resolver; a runtime one would not, and
 * would also emit an unresolvable specifier into `server/dist`. So the composition root —
 * `scripts/seed.ts` and the spec — imports the module and hands the function down. One
 * seam, one implementation, no second index.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { resolveBibleLeaders } from './leaders.js';

import type { BibleUnionLeader } from './leaders.js';
import type { deriveFeatures } from '@shared/geo/deriveFeatures';
import type { DeriveWarning, DerivedCountry } from '@shared/geo/deriveFeatures';
import type { CountryOverride, Save } from '@shared/types/index';

/** The signature of `@shared/geo/deriveFeatures`, taken from the module itself. */
export type DeriveFeatures = typeof deriveFeatures;

/** The parsed topojson, named through {@link DeriveFeatures} so no topojson types are imported. */
type Topology = Parameters<DeriveFeatures>[0];

/** `x:` — the namespace marker for an id ISO cannot name (§3.1). Mirrors `deriveFeatures`. */
const SYNTHETIC_ID_PREFIX = 'x:';

/** A 1–3 digit ISO numeric code, as the mapping file spells its keys. */
const NUMERIC_KEY = /^\d{1,3}$/;

/** The map export writes epoch milliseconds; the schema stores canonical ISO-8601 UTC. */
const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * The file whose save is canon, and the id it MUST get.
 *
 * `client/src/shell/stores/save.ts` hard-codes `CANON_SAVE_ID = 'sav_canon'` (P1.11.1,
 * P1.13). Seeding any other id points the whole client at a save that does not exist, and
 * the symptom is an empty app rather than an error. Change one and you change both.
 */
const CANON_SAVE = {
  file: 'lifestream_map_v1.json',
  id: 'sav_canon',
  name: 'v1 (Bible canon)',
} as const;

/**
 * The three mapping-file entries that resolve to no 50m geometry by numeric id (P1.9.2).
 * None of them is a failure; a FOURTH means the vendored atlas vintage moved.
 */
const EXPECTED_UNMAPPED_ISO_KEYS = ['175', 'GUF', 'undefined'] as const;

/** One entry of `data/iso-numeric-to-alpha3.json` with no country row keyed on its code. */
export interface UnmappedIsoKey {
  key: string;
  alpha3: string;
  reason: 'non-numeric key' | 'no 50m geometry for this numeric id';
}

/** How the codes of one map save split across the country key (P1.11.2). */
export interface ResolutionSplit {
  /** Distinct alpha-3 codes referenced by the file, across every group. */
  total: number;
  /** Codes that resolved to a zero-padded ISO numeric id. */
  numeric: number;
  /** The synthetic ids used, sorted — `['x:GUF', 'x:SOL']` for the canon save. */
  syntheticIds: string[];
}

/** A unified nation to write, with its membership already resolved to country ids. */
export interface MapGroupingInput {
  /** The id the map export assigned. Kept so a row traces back to the file it came from. */
  sourceId: string;
  id: string;
  name: string;
  color: string;
  /** Resolved `country.id` values, in the order the file lists them. */
  countryIds: string[];
}

/** A union leader that was placed in this save. */
export interface LeaderAssignment {
  union: string;
  leaderName: string;
  alpha3: string;
  countryId: string;
  groupingId: string;
  /** The grouping's name in the map export — differs from `union` where the author renamed it. */
  groupingName: string;
  /** Bible line the marker was parsed from. */
  line: number;
}

/** A union leader canon states that this save cannot carry, and why. */
export interface UnplacedLeader {
  union: string;
  leaderName: string;
  line: number;
  reason: string;
}

/** One file of `data/map_saves/`, resolved into the rows it becomes. */
export interface MapSaveInput {
  /** Basename, for the log. */
  file: string;
  save: Save;
  groupings: MapGroupingInput[];
  /** Groups skipped because they are the export's synthesized independents (P1.11.3). */
  independentsSkipped: number;
  resolution: ResolutionSplit;
  /** Only the `countryNames` entries that DIFFER from the derived default (P1.11.4). */
  overrides: CountryOverride[];
  /** How many `countryNames` entries were examined to produce them. */
  overrideCandidates: number;
  leaders: LeaderAssignment[];
  unplacedLeaders: UnplacedLeader[];
}

/** Everything one seed run writes. */
export interface SeedInputs {
  /** One row per derived feature — 242 against the pinned atlas (P1.9.1). */
  countries: DerivedCountry[];
  /** Non-fatal decisions `deriveFeatures` reported. Empty against the pinned atlas. */
  deriveWarnings: DeriveWarning[];
  unmappedIsoKeys: UnmappedIsoKey[];
  /** True when {@link SeedInputs.unmappedIsoKeys} is not the expected three (P1.9.2). */
  isoKeyDriftSuspected: boolean;
  /** The ten `(Leader)` markers, verified against the Bible. */
  leaderMarkers: (BibleUnionLeader & { line: number })[];
  /** One per file in `data/map_saves/`, in filename order. */
  saves: MapSaveInput[];
}

/** The shape of a map export. Everything else in the file is ignored by the importer. */
interface MapSaveFile {
  id?: unknown;
  name?: unknown;
  createdAt?: unknown;
  allGroups?: unknown;
  unifiedNations?: unknown;
  countryNames?: unknown;
}

/** One entry of `allGroups`. `independent` is present only on the synthesized ones. */
interface MapSaveGroup {
  id: string;
  name: string;
  color: string;
  countries: string[];
  independent?: boolean;
}

/** A seed input that cannot be resolved. Thrown with every failing code named, never one. */
export class SeedInputError extends Error {
  override name = 'SeedInputError';
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;

/** Lowercase, non-alphanumerics to single dashes, no leading or trailing dash. */
const kebab = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * Invert `data/iso-numeric-to-alpha3.json`.
 *
 * The map saves store alpha-3 (`{"countries": ["GUF", "SUR", "GUY"]}`) and `country.id` is
 * not alpha-3, so every member code crosses this map before it becomes a row — without it
 * zero of the 237 resolve and every insert fails on the FK. The inversion is bijective
 * against the real file (238 entries, no alpha-3 collision) and a collision is fatal here
 * rather than last-write-wins.
 */
function invertIsoMapping(numericToAlpha3: Readonly<Record<string, string>>): Map<string, string> {
  const inverse = new Map<string, string>();
  const collisions: string[] = [];

  for (const [key, alpha3] of Object.entries(numericToAlpha3)) {
    const existing = inverse.get(alpha3);
    if (existing !== undefined) collisions.push(`${alpha3} <- ${existing} and ${key}`);
    else inverse.set(alpha3, key);
  }

  if (collisions.length > 0) {
    throw new SeedInputError(
      `seed: data/iso-numeric-to-alpha3.json is not invertible — ${collisions.length} alpha-3 ` +
        `code(s) map from more than one key:\n  ${collisions.join('\n  ')}`,
    );
  }

  return inverse;
}

/**
 * alpha-3 → `country.id`, per §3.1.
 *
 * A numeric key becomes the zero-padded numeric id; the mapping file's two non-numeric
 * keys (`"GUF": "GUF"` and `"undefined": "SOL"`, whose key is the literal string
 * `undefined`) become the synthetic `x:GUF` and `x:SOL` that `deriveFeatures` mints. The
 * result is checked against the derived rows by the caller — minting a plausible id is not
 * the same as there being a country row behind it.
 */
function resolveAlpha3(alpha3: string, inverse: ReadonlyMap<string, string>): string | null {
  const key = inverse.get(alpha3);
  if (key === undefined) return null;
  return NUMERIC_KEY.test(key) ? key.padStart(3, '0') : `${SYNTHETIC_ID_PREFIX}${alpha3}`;
}

/** `allGroups` narrowed, with the file named in every failure. */
function readGroups(parsed: MapSaveFile, file: string): MapSaveGroup[] {
  if (!Array.isArray(parsed.allGroups)) {
    throw new SeedInputError(`seed: ${file} has no "allGroups" array.`);
  }

  return parsed.allGroups.map((raw, index) => {
    const group = raw as Partial<MapSaveGroup>;
    const where = `${file} allGroups[${index}]`;
    if (typeof group.id !== 'string' || group.id === '') {
      throw new SeedInputError(`seed: ${where} has no "id".`);
    }
    if (typeof group.name !== 'string' || group.name === '') {
      throw new SeedInputError(`seed: ${where} (${group.id}) has no "name".`);
    }
    if (typeof group.color !== 'string' || group.color === '') {
      throw new SeedInputError(`seed: ${where} (${group.name}) has no "color".`);
    }
    if (!Array.isArray(group.countries)) {
      throw new SeedInputError(`seed: ${where} (${group.name}) has no "countries" array.`);
    }
    return {
      id: group.id,
      name: group.name,
      color: group.color,
      countries: group.countries as string[],
      independent: group.independent === true,
    };
  });
}

/** The `save` row for one file — id, name and the `created_at` the export recorded. */
function readSaveRow(parsed: MapSaveFile, file: string): Save {
  const isCanon = file === CANON_SAVE.file;
  const stem = file.replace(/\.json$/i, '');
  const exportName = typeof parsed.name === 'string' && parsed.name !== '' ? parsed.name : stem;

  // Epoch milliseconds in the export; the schema's GLOB accepts only `toISOString()`'s
  // spelling, and the seed must be reproducible, so the file's own timestamp is used and
  // never the clock — a `new Date()` here would make two runs differ in the `save` row.
  if (typeof parsed.createdAt !== 'number' || !Number.isFinite(parsed.createdAt)) {
    throw new SeedInputError(
      `seed: ${file} has no numeric "createdAt" (epoch ms). The map exporter always writes ` +
        `one; a file without it has been hand-edited, and inventing a timestamp here would ` +
        `make the seed non-reproducible.`,
    );
  }
  const createdAt = new Date(parsed.createdAt).toISOString();
  if (!CANONICAL_INSTANT.test(createdAt)) {
    throw new SeedInputError(`seed: ${file} "createdAt" is not a usable instant: ${createdAt}`);
  }

  return {
    id: isCanon ? CANON_SAVE.id : `sav_${kebab(stem)}`,
    name: isCanon ? CANON_SAVE.name : exportName,
    description: `Seeded from data/map_saves/${file} (${exportName}).`,
    createdAt,
    isArchived: false,
  };
}

/** Resolve one map export into the rows it becomes. */
function readMapSave(
  file: string,
  parsed: MapSaveFile,
  inverse: ReadonlyMap<string, string>,
  countriesById: ReadonlyMap<string, DerivedCountry>,
  leaderMarkers: readonly (BibleUnionLeader & { line: number })[],
): MapSaveInput {
  const save = readSaveRow(parsed, file);
  const groups = readGroups(parsed, file);

  // ---- resolve every code the file references, independents included. The key must be
  // TOTAL over the author's own data (P1.9.4): a code with no country row is fatal.
  const idByAlpha3 = new Map<string, string>();
  const unresolved: string[] = [];
  const missingRow: string[] = [];
  for (const group of groups) {
    for (const alpha3 of group.countries) {
      if (idByAlpha3.has(alpha3)) continue;
      const id = resolveAlpha3(alpha3, inverse);
      if (id === null) unresolved.push(alpha3);
      else if (!countriesById.has(id)) missingRow.push(`${alpha3} -> ${id}`);
      else idByAlpha3.set(alpha3, id);
    }
  }
  if (unresolved.length > 0 || missingRow.length > 0) {
    throw new SeedInputError(
      `seed: ${file} references ${unresolved.length + missingRow.length} code(s) with no ` +
        `country row. A country quietly missing from the map is the failure this check ` +
        `exists to prevent.\n` +
        [
          ...unresolved.map((a3) => `  ${a3}: no key in data/iso-numeric-to-alpha3.json`),
          ...missingRow.map((line) => `  ${line}: resolved, but no such row from deriveFeatures`),
        ].join('\n'),
    );
  }

  const syntheticIds = [...idByAlpha3.values()]
    .filter((id) => id.startsWith(SYNTHETIC_ID_PREFIX))
    .sort();
  const resolution: ResolutionSplit = {
    total: idByAlpha3.size,
    numeric: idByAlpha3.size - syntheticIds.length,
    syntheticIds,
  };

  // ---- the partition. `grouping_country`'s PK would reject a double membership at insert
  // time; catching it here says WHICH code and WHICH two groups, which the PK cannot.
  const ownerByCountry = new Map<string, string>();
  const doubleBooked: string[] = [];
  for (const group of groups) {
    for (const alpha3 of group.countries) {
      const owner = ownerByCountry.get(alpha3);
      if (owner !== undefined) doubleBooked.push(`${alpha3}: "${owner}" and "${group.name}"`);
      else ownerByCountry.set(alpha3, group.name);
    }
  }
  if (doubleBooked.length > 0) {
    throw new SeedInputError(
      `seed: ${file} puts ${doubleBooked.length} country/countries in more than one group. ` +
        `A country belongs to at most one unified nation per save (§2.4).\n  ` +
        doubleBooked.join('\n  '),
    );
  }

  // ---- P1.11.3: the synthesized "independent" groups are skipped by construction. They
  // are a projection of `country` built at export time (map/src/App.jsx:146-155) with a
  // hardcoded slate color and an `independent: true` flag no schema has; an independent
  // nation is a country with NO grouping_country row.
  const unified = groups.filter((group) => !group.independent);
  const independentsSkipped = groups.length - unified.length;

  const groupings: MapGroupingInput[] = unified.map((group) => ({
    sourceId: group.id,
    id: `grp_${group.id}`,
    name: group.name,
    color: group.color,
    // Non-null by construction: every code resolved above or this function threw.
    countryIds: group.countries.map((alpha3) => idByAlpha3.get(alpha3) as string),
  }));

  const duplicateNames = groupings
    .map((g) => g.name)
    .filter((name, index, all) => all.indexOf(name) !== index);
  if (duplicateNames.length > 0) {
    throw new SeedInputError(
      `seed: ${file} has two unified nations with the same name (${[...new Set(duplicateNames)]
        .map((n) => `"${n}"`)
        .join(', ')}). \`grouping_save_id_name_unique\` would reject them, and the importer ` +
        `upserts on that name — two half-populated nations it believes are one.`,
    );
  }

  // ---- P1.11.4: `countryNames` is a display cache, not authored renames. Map.jsx:157
  // writes `geo.properties.name` on every click, so only entries that DIFFER from the
  // derived default become a `country_override` row. Expect near-zero.
  const cachedNames =
    typeof parsed.countryNames === 'object' && parsed.countryNames !== null
      ? (parsed.countryNames as Record<string, string>)
      : {};
  const overrides: CountryOverride[] = [];
  let overrideCandidates = 0;
  for (const [alpha3, name] of Object.entries(cachedNames)) {
    if (typeof name !== 'string' || name === '') continue;
    overrideCandidates += 1;
    const id = resolveAlpha3(alpha3, inverse);
    // A cached name for a country this save does not reference is still a real country;
    // one with no row at all is skipped rather than fatal — it is a cache, not membership.
    if (id === null) continue;
    const derived = countriesById.get(id);
    if (derived === undefined || derived.name === name) continue;
    overrides.push({ saveId: save.id, countryId: id, name });
  }

  // ---- P1.11.2: the leader flag, whose only source is the Bible. A leader is located by
  // its COUNTRY's membership, never by matching union names — two of the ten unions were
  // renamed by the authored map after the Bible was written.
  const groupingByCountryId = new Map<string, MapGroupingInput>();
  for (const grouping of groupings) {
    for (const countryId of grouping.countryIds) groupingByCountryId.set(countryId, grouping);
  }

  const leaders: LeaderAssignment[] = [];
  const unplacedLeaders: UnplacedLeader[] = [];
  for (const marker of leaderMarkers) {
    if (marker.alpha3 === null) {
      unplacedLeaders.push({
        union: marker.union,
        leaderName: marker.leaderName,
        line: marker.line,
        reason: marker.unresolvable ?? 'no country code for this marker',
      });
      continue;
    }
    const countryId = resolveAlpha3(marker.alpha3, inverse);
    const grouping = countryId === null ? undefined : groupingByCountryId.get(countryId);
    if (countryId === null || grouping === undefined) {
      unplacedLeaders.push({
        union: marker.union,
        leaderName: marker.leaderName,
        line: marker.line,
        reason: `${marker.alpha3} is not a member of any unified nation in ${file}`,
      });
      continue;
    }
    leaders.push({
      union: marker.union,
      leaderName: marker.leaderName,
      alpha3: marker.alpha3,
      countryId,
      groupingId: grouping.id,
      groupingName: grouping.name,
      line: marker.line,
    });
  }

  return {
    file,
    save,
    groupings,
    independentsSkipped,
    resolution,
    overrides,
    overrideCandidates,
    leaders,
    unplacedLeaders,
  };
}

/**
 * Read every authored input under `repoRoot` and resolve it into the rows the seed writes.
 *
 * @param repoRoot absolute path to the repository root.
 * @param derive   `deriveFeatures` from `@shared/geo/deriveFeatures` — see the module
 *                 header for why it is a parameter.
 * @throws {SeedInputError} naming every code, group or file that could not be resolved.
 */
export function readSeedInputs(repoRoot: string, derive: DeriveFeatures): SeedInputs {
  const at = (...parts: string[]): string => path.join(repoRoot, ...parts);

  const topology = readJson<Topology>(at('client', 'public', 'topojson', 'countries-50m.json'));
  const numericToAlpha3 = readJson<Record<string, string>>(
    at('data', 'iso-numeric-to-alpha3.json'),
  );
  const bibleText = readFileSync(at('data', 'story_docs', 'LIFEstream Bible.txt'), 'utf8');

  // P1.9.1 — the derived set IS the country table. No second index is built here.
  const derived = derive(topology, numericToAlpha3);
  const countriesById = new Map(derived.countries.map((country) => [country.id, country]));

  // P1.9.2 — the mapping-file entries with no country row keyed on their code. Three are
  // expected and none is a failure; a fourth means the vendored atlas vintage moved.
  const unmappedIsoKeys: UnmappedIsoKey[] = [];
  for (const [key, alpha3] of Object.entries(numericToAlpha3)) {
    if (!NUMERIC_KEY.test(key)) {
      unmappedIsoKeys.push({ key, alpha3, reason: 'non-numeric key' });
    } else if (!countriesById.has(key.padStart(3, '0'))) {
      unmappedIsoKeys.push({ key, alpha3, reason: 'no 50m geometry for this numeric id' });
    }
  }
  const expectedUnmapped = new Set<string>(EXPECTED_UNMAPPED_ISO_KEYS);
  const isoKeyDriftSuspected =
    unmappedIsoKeys.length !== expectedUnmapped.size ||
    unmappedIsoKeys.some((entry) => !expectedUnmapped.has(entry.key));

  const inverse = invertIsoMapping(numericToAlpha3);
  const leaderMarkers = resolveBibleLeaders(bibleText);

  const mapSavesDir = at('data', 'map_saves');
  const files = readdirSync(mapSavesDir)
    .filter((file) => file.toLowerCase().endsWith('.json'))
    .sort();
  if (files.length === 0) {
    throw new SeedInputError(
      `seed: no *.json files in ${mapSavesDir}. The authored worlds live there and the seed ` +
        `imports every one of them (§7.4) — an empty directory means the drain (P1.10) has ` +
        `not been done, not that there is nothing to seed.`,
    );
  }

  const saves = files.map((file) =>
    readMapSave(
      file,
      readJson<MapSaveFile>(path.join(mapSavesDir, file)),
      inverse,
      countriesById,
      leaderMarkers,
    ),
  );

  const byId = new Map<string, string>();
  for (const entry of saves) {
    const existing = byId.get(entry.save.id);
    if (existing !== undefined) {
      throw new SeedInputError(
        `seed: ${existing} and ${entry.file} both seed save id "${entry.save.id}"; the second ` +
          `would overwrite the first.`,
      );
    }
    byId.set(entry.save.id, entry.file);
  }
  if (!byId.has(CANON_SAVE.id)) {
    throw new SeedInputError(
      `seed: no file produced the canon save "${CANON_SAVE.id}". ` +
        `client/src/shell/stores/save.ts hard-codes that id, so the app would point at a save ` +
        `that does not exist — and the symptom is an empty app, not an error. ` +
        `Expected ${CANON_SAVE.file} in data/map_saves/.`,
    );
  }

  return {
    countries: derived.countries,
    deriveWarnings: derived.warnings,
    unmappedIsoKeys,
    isoKeyDriftSuspected,
    leaderMarkers,
    saves,
  };
}
