import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { deriveFeatures } from '@shared/geo/deriveFeatures';

import type { Feature, Geometry, Position } from 'geojson';
import type { Topology } from 'topojson-specification';

/**
 * P1.9.3 — `deriveFeatures` against the real vendored `world-atlas@2.0.2` file.
 *
 * It earns its place because every failure this module exists to prevent is **silent**.
 * A naive `id -> feature` map drops Australia or Ashmore and Cartier Is. with no error;
 * a missed France carve loses French Guiana; a missed raw-id fallback loses Somaliland —
 * and in all three cases the map still draws and the row count still looks plausible. So
 * the assertions here are counts and named rows, not shapes: a regression has to move a
 * number rather than pass quietly.
 *
 * This is the pure half of P1.9.5's country-import test. That one asserts the same facts
 * about the *seeded rows* and needs the `:memory:` fixture (and therefore P1.6.3); this
 * one needs neither a database nor a migration, so the derivation is verifiable now.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const readJson = <T>(relativePath: string): T =>
  JSON.parse(readFileSync(repoRoot + relativePath, 'utf8')) as T;

const topology = readJson<Topology>('client/public/topojson/countries-50m.json');
const numericToAlpha3 = readJson<Record<string, string>>('data/iso-numeric-to-alpha3.json');
const mapSave = readJson<{ allGroups: { countries?: string[] }[] }>(
  'data/map_saves/lifestream_map_v1.json',
);

const derived = deriveFeatures(topology, numericToAlpha3);
const rowsById = new Map(derived.countries.map((country) => [country.id, country]));

/** Every polygon of a polygonal geometry, so Polygon and MultiPolygon compare alike. */
const polygonsOf = (geometry: Geometry): Position[][][] => {
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  return [];
};

/** The bounding-box test the carve uses, re-stated here so the spec does not import it. */
const startsInFrenchGuiana = (polygon: Position[][]): boolean => {
  const lon = polygon[0]?.[0]?.[0];
  const lat = polygon[0]?.[0]?.[1];
  if (lon === undefined || lat === undefined) return false;
  return lon >= -60 && lon <= -40 && lat >= -5 && lat <= 10;
};

describe('deriveFeatures — counts and invariants', () => {
  it('turns 241 geometries into 242 rows: 241 feature + 1 derived', () => {
    expect(derived.countries).toHaveLength(242);
    expect(derived.features).toHaveLength(242);
    expect(derived.countries.filter((c) => c.geometrySource === 'feature')).toHaveLength(241);
    expect(derived.countries.filter((c) => c.geometrySource === 'derived')).toHaveLength(1);
  });

  it('reports no warnings against the pinned atlas', () => {
    expect(derived.warnings).toEqual([]);
  });

  it('indexes every row exactly once — no id is lost to a collision', () => {
    expect(derived.byId.size).toBe(derived.countries.length);
    expect(new Set(derived.countries.map((c) => c.id)).size).toBe(derived.countries.length);
  });

  it('keys on zero-padded 3-character strings, never numbers', () => {
    for (const country of derived.countries) {
      expect(typeof country.id).toBe('string');
      if (country.isoNumeric !== undefined) expect(country.isoNumeric).toMatch(/^\d{3}$/);
      if (!country.id.startsWith('x:')) expect(country.id).toMatch(/^\d{3}$/);
    }
  });

  it('leaves isoNumeric null on every synthetic row', () => {
    const synthetic = derived.countries.filter((c) => c.id.startsWith('x:'));
    expect(synthetic.map((c) => c.id).sort()).toEqual([
      'x:GUF',
      'x:SOL',
      'x:XKX',
      'x:ashmore-cartier',
      'x:indian-ocean-ter',
      'x:n-cyprus',
      'x:siachen-glacier',
    ]);
    expect(synthetic.every((c) => c.isoNumeric === undefined)).toBe(true);
  });
});

describe('job 1 — the France to French Guiana carve', () => {
  it('emits x:GUF as derived, named French Guiana and not France', () => {
    expect(rowsById.get('x:GUF')).toEqual({
      id: 'x:GUF',
      name: 'French Guiana',
      alpha3: 'GUF',
      geometrySource: 'derived',
    });
  });

  it('leaves "250" a feature row with the Guiana ring removed', () => {
    expect(rowsById.get('250')).toEqual({
      id: '250',
      name: 'France',
      isoNumeric: '250',
      alpha3: 'FRA',
      geometrySource: 'feature',
    });

    const france = derived.byId.get('250');
    const guiana = derived.byId.get('x:GUF');
    expect(france).toBeDefined();
    expect(guiana).toBeDefined();

    const francePolygons = polygonsOf((france as Feature<Geometry>).geometry);
    const guianaPolygons = polygonsOf((guiana as Feature<Geometry>).geometry);
    // 10 polygons in, 9 stay France, 1 becomes French Guiana.
    expect(francePolygons).toHaveLength(9);
    expect(guianaPolygons).toHaveLength(1);
    expect(francePolygons.some(startsInFrenchGuiana)).toBe(false);
    expect(guianaPolygons.every(startsInFrenchGuiana)).toBe(true);
  });

  it('keeps Mayotte and the Antilles inside France — the bounds are not widened', () => {
    const france = derived.byId.get('250');
    const firstVertices = polygonsOf((france as Feature<Geometry>).geometry).map((p) => p[0]?.[0]);
    // Mayotte (~45.2, -13.0) and Guadeloupe (~-61.3, 16.2) both survive the carve.
    expect(firstVertices.some((v) => v !== undefined && v[0] !== undefined && v[0] > 40)).toBe(
      true,
    );
    expect(firstVertices.some((v) => v !== undefined && v[0] !== undefined && v[0] < -61)).toBe(
      true,
    );
  });
});

describe('job 2 — the raw-id fallback', () => {
  it('gives all five id-less features a distinct synthetic id', () => {
    const idless = [
      ['Somaliland', 'x:SOL', 'SOL'],
      ['Kosovo', 'x:XKX', 'XKX'],
      ['N. Cyprus', 'x:n-cyprus', undefined],
      ['Indian Ocean Ter.', 'x:indian-ocean-ter', undefined],
      ['Siachen Glacier', 'x:siachen-glacier', undefined],
    ] as const;

    for (const [name, id, alpha3] of idless) {
      const row = rowsById.get(id);
      expect(row, `${name} should be ${id}`).toBeDefined();
      expect(row?.name).toBe(name);
      expect(row?.alpha3).toBe(alpha3);
      // They are real 1:1 features; only their id is unusable.
      expect(row?.geometrySource).toBe('feature');
    }
  });

  it("does not collapse the five onto the mapping file's single 'undefined' entry", () => {
    // The old app's `numericToAlpha3[strId] ?? strId` made all five 'SOL'.
    expect(numericToAlpha3['undefined']).toBe('SOL');
    expect(derived.countries.filter((c) => c.alpha3 === 'SOL')).toHaveLength(1);
  });
});

describe('job 3 — the duplicate "036"', () => {
  it('gives the numeric id to Australia, not to Ashmore and Cartier Is.', () => {
    expect(numericToAlpha3['036']).toBe('AUS');
    expect(rowsById.get('036')?.name).toBe('Australia');
  });

  it('keeps both features as two distinct rows', () => {
    expect(rowsById.get('x:ashmore-cartier')).toEqual({
      id: 'x:ashmore-cartier',
      name: 'Ashmore and Cartier Is.',
      geometrySource: 'feature',
    });
    expect(derived.countries.filter((c) => c.isoNumeric === '036')).toHaveLength(1);
    expect(derived.byId.get('036')).not.toBe(derived.byId.get('x:ashmore-cartier'));
  });
});

describe('acceptance — the authored world resolves', () => {
  it('resolves all 237 codes in lifestream_map_v1.json to exactly one row each', () => {
    const alpha3ToKey = new Map(
      Object.entries(numericToAlpha3).map(([key, alpha3]) => [alpha3, key]),
    );
    const authored = new Set(mapSave.allGroups.flatMap((group) => group.countries ?? []));
    expect(authored.size).toBe(237);

    const unresolved: string[] = [];
    for (const alpha3 of authored) {
      const key = alpha3ToKey.get(alpha3);
      // A numeric key is the country id outright; the two non-numeric keys ("GUF",
      // "undefined") are the rows only the carve and the fallback can produce.
      const id = key !== undefined && /^\d{3}$/.test(key) ? key : `x:${alpha3}`;
      if (derived.countries.filter((c) => c.id === id).length !== 1) unresolved.push(alpha3);
    }
    expect(unresolved).toEqual([]);
  });

  it('leaves exactly the five rows the author never references', () => {
    const alpha3ToKey = new Map(
      Object.entries(numericToAlpha3).map(([key, alpha3]) => [alpha3, key]),
    );
    const authoredIds = new Set(
      [...new Set(mapSave.allGroups.flatMap((g) => g.countries ?? []))].map((alpha3) => {
        const key = alpha3ToKey.get(alpha3);
        return key !== undefined && /^\d{3}$/.test(key) ? key : `x:${alpha3}`;
      }),
    );
    expect(
      derived.countries
        .filter((c) => !authoredIds.has(c.id))
        .map((c) => c.id)
        .sort(),
    ).toEqual([
      'x:XKX',
      'x:ashmore-cartier',
      'x:indian-ocean-ter',
      'x:n-cyprus',
      'x:siachen-glacier',
    ]);
  });
});

describe('purity', () => {
  it('does not mutate the topology and returns the same answer twice', () => {
    const before = JSON.stringify(topology);
    const second = deriveFeatures(topology, numericToAlpha3);
    expect(JSON.stringify(topology)).toBe(before);
    expect(second.countries).toEqual(derived.countries);
  });
});
