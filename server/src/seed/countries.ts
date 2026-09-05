/**
 * P1.9 — the global `country` table.
 *
 * GLOBAL and real-world: no `save_id`, seeded once, shared by every save. The rows are
 * `deriveFeatures`' output verbatim (P1.9.1) — this module decides nothing about identity,
 * it only writes. The France carve, the id-less-five fallback and the duplicate `"036"`
 * all happen one layer up, in the one module the client renderer calls too.
 */
import { sql } from 'drizzle-orm';

import { country } from '../db/schema.js';

import type { Db } from '../db/index.js';
import type { DerivedCountry } from '@shared/geo/deriveFeatures';

/** What one country seed did. */
export interface CountrySeedResult {
  /** Rows the input asked for — 242 against the pinned atlas. */
  total: number;
  inserted: number;
  /** Rows that existed and differed. */
  updated: number;
  /** Rows that existed and already matched — no statement was issued for them. */
  unchanged: number;
  /** Rows whose geometry is 1:1 with a topojson feature. */
  featureRows: number;
  /** Rows carved out of another feature at load time — `x:GUF` alone, today. */
  derivedRows: number;
  /** Rows keyed on a synthetic `x:` id. */
  syntheticIds: string[];
}

/** The column values one derived country implies, with nulls where the row has no code. */
const rowValues = (row: DerivedCountry) => ({
  id: row.id,
  // `?? null` rather than leaving it undefined: drizzle drops an undefined key from the
  // UPDATE clause, so a row that used to carry an iso_numeric would silently keep it after
  // the derivation stopped producing one.
  isoNumeric: row.isoNumeric ?? null,
  alpha3: row.alpha3 ?? null,
  name: row.name,
  geometrySource: row.geometrySource,
});

/**
 * Upsert every derived country by its id — the natural key (§7.4, P1.7.2).
 *
 * A row that already matches is SKIPPED rather than rewritten. That is what makes the
 * second `db:seed` byte-identical and not merely row-identical: an UPDATE with the same
 * values still dirties the page it lands on, so a blanket rewrite leaves a different file
 * behind every run and there is nothing left to compare.
 *
 * Never deletes: a row this run did not produce is left alone rather than dropped, because
 * `country` is global and a `grouping_country` or `location` in some save may point at it.
 */
export function seedCountries(db: Db, countries: readonly DerivedCountry[]): CountrySeedResult {
  const existing = new Map(
    db
      .select({
        id: country.id,
        isoNumeric: country.isoNumeric,
        alpha3: country.alpha3,
        name: country.name,
        geometrySource: country.geometrySource,
      })
      .from(country)
      .all()
      .map((row) => [row.id, row] as const),
  );

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  for (const row of countries) {
    const values = rowValues(row);
    const current = existing.get(row.id);

    if (current !== undefined) {
      if (
        current.isoNumeric === values.isoNumeric &&
        current.alpha3 === values.alpha3 &&
        current.name === values.name &&
        current.geometrySource === values.geometrySource
      ) {
        unchanged += 1;
        continue;
      }
      updated += 1;
    } else {
      inserted += 1;
    }

    db.insert(country)
      .values(values)
      .onConflictDoUpdate({
        target: country.id,
        set: {
          isoNumeric: values.isoNumeric,
          alpha3: values.alpha3,
          name: values.name,
          geometrySource: values.geometrySource,
        },
      })
      .run();
  }

  return {
    total: countries.length,
    inserted,
    updated,
    unchanged,
    featureRows: countries.filter((row) => row.geometrySource === 'feature').length,
    derivedRows: countries.filter((row) => row.geometrySource === 'derived').length,
    syntheticIds: countries
      .map((row) => row.id)
      .filter((id) => id.startsWith('x:'))
      .sort(),
  };
}

/** Row count of the whole table — the number P1.9.5 asserts so a dropped feature moves it. */
export function countCountryRows(db: Db): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(country)
      .get()?.n ?? 0
  );
}
