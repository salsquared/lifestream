/**
 * `runSeed` — the world seed (P1.9 + P1.11, architecture §7.4).
 *
 * The whole run is ONE transaction. A file that fails halfway through leaves the database
 * exactly as it was, rather than a save with some of its nations and none of its leaders.
 *
 * Idempotent and never destructive, which is a policy and not an aspiration (§7.4): every
 * write is an upsert on a natural key and nothing is deleted, so `db:seed` twice produces
 * the same rows as `db:seed` once, and `db:reset` + `db:migrate` + `db:seed` reproduces the
 * file byte for byte. Rows the sources no longer name are counted and reported, never
 * dropped — a fork's `parent_save_id` may point at them.
 *
 * Reading and resolving the authored inputs is `inputs.ts`'s job and happens before any
 * statement is issued; see that module for why `deriveFeatures` arrives as a parameter.
 */
import { countCountryRows, seedCountries } from './countries.js';
import { countMapSaveRows, seedMapSave } from './mapSaves.js';

import type { CountrySeedResult } from './countries.js';
import type {
  LeaderAssignment,
  MapSaveInput,
  ResolutionSplit,
  SeedInputs,
  UnmappedIsoKey,
  UnplacedLeader,
} from './inputs.js';
import type { MapSaveCounts, MapSaveResult } from './mapSaves.js';
import type { DbHandle } from '../db/index.js';
import type { DeriveWarning } from '@shared/geo/deriveFeatures';

export { readSeedInputs, SeedInputError } from './inputs.js';
export type {
  DeriveFeatures,
  LeaderAssignment,
  MapSaveInput,
  ResolutionSplit,
  SeedInputs,
  UnmappedIsoKey,
  UnplacedLeader,
} from './inputs.js';
export { BIBLE_UNION_LEADERS, readBibleLeaderMarkers, resolveBibleLeaders } from './leaders.js';
export type { BibleLeaderMarker, BibleUnionLeader } from './leaders.js';

/** What one map save's import wrote, and what the database holds afterwards. */
export interface SaveSeedReport {
  result: MapSaveResult;
  counts: MapSaveCounts;
  /** How this file's codes split across the country key — 235 numeric + `x:GUF` + `x:SOL`. */
  resolution: ResolutionSplit;
  /** Synthesized "independent" groups skipped by construction (P1.11.3). */
  independentsSkipped: number;
  /** Unified nations the file asked for. */
  expectedGroupings: number;
  /** Member codes the file asked for, across those nations. */
  expectedMemberships: number;
  leaders: LeaderAssignment[];
  unplacedLeaders: UnplacedLeader[];
  /** `countryNames` entries examined to produce `result.overrides*` (P1.11.4). */
  overrideCandidates: number;
}

/** Everything one seed run did. */
export interface SeedReport {
  countries: CountrySeedResult;
  /** `country` row count read back after the writes — the number a dropped feature moves. */
  countryRows: number;
  deriveWarnings: DeriveWarning[];
  unmappedIsoKeys: UnmappedIsoKey[];
  isoKeyDriftSuspected: boolean;
  /** Every `(Leader)` marker canon carries, whether or not it could be placed. */
  leaderMarkers: SeedInputs['leaderMarkers'];
  saves: SaveSeedReport[];
  /** Non-fatal observations worth a line in the log. */
  warnings: string[];
}

/** A write that did not produce the rows it was asked for. Rolls the transaction back. */
class SeedWriteError extends Error {
  override name = 'SeedWriteError';
}

/** Assert the writes match the inputs, naming the difference (P1.11.5). */
function verifyMapSave(input: MapSaveInput, result: MapSaveResult, counts: MapSaveCounts): void {
  const expectedGroupings = input.groupings.length;
  const expectedMemberships = input.groupings.reduce((n, g) => n + g.countryIds.length, 0);
  const wroteGroupings =
    result.groupingsInserted + result.groupingsUpdated + result.groupingsUnchanged;
  const wroteMemberships =
    result.membershipsInserted + result.membershipsUpdated + result.membershipsUnchanged;

  const problems: string[] = [];
  if (wroteGroupings !== expectedGroupings) {
    problems.push(`wrote ${wroteGroupings} groupings, the file asked for ${expectedGroupings}`);
  }
  if (wroteMemberships !== expectedMemberships) {
    problems.push(
      `wrote ${wroteMemberships} membership rows, the file asked for ${expectedMemberships}`,
    );
  }
  if (counts.leaders !== input.leaders.length) {
    problems.push(
      `${counts.leaders} is_leader rows in the database, ${input.leaders.length} resolved from ` +
        `the Bible. The map export has no leader field, so a silent 0 is the expected shape ` +
        `of this bug`,
    );
  }
  if (counts.groupingsWithLeader !== counts.leaders) {
    problems.push(
      `${counts.leaders} leaders spread over ${counts.groupingsWithLeader} groupings — ` +
        `grouping_country_leader_unique should have made that impossible`,
    );
  }
  if (counts.overrides < result.overridesInserted + result.overridesUpdated) {
    problems.push(`fewer country_override rows than were just written`);
  }

  if (problems.length > 0) {
    throw new SeedWriteError(
      `seed: ${input.file} did not import cleanly:\n  ${problems.join('\n  ')}`,
    );
  }
}

/**
 * Seed the database from resolved inputs.
 *
 * @param handle the connection, from `createDb`. The raw `sqlite` half is what wraps the
 *               whole run in one transaction.
 * @param inputs from `readSeedInputs`.
 * @throws if a write does not produce the rows its input asked for — the transaction rolls
 *         back and nothing is written.
 */
export function runSeed(handle: DbHandle, inputs: SeedInputs): SeedReport {
  const { db, sqlite } = handle;
  const warnings: string[] = [];

  for (const warning of inputs.deriveWarnings) {
    warnings.push(`deriveFeatures [${warning.kind}]: ${warning.message}`);
  }
  if (inputs.isoKeyDriftSuspected) {
    warnings.push(
      `data/iso-numeric-to-alpha3.json has ${inputs.unmappedIsoKeys.length} entries with no ` +
        `country row, not the expected three (175/MYT, GUF, undefined/SOL). The vendored ` +
        `atlas vintage has probably moved.`,
    );
  }

  const run = sqlite.transaction((): SeedReport => {
    const countries = seedCountries(db, inputs.countries);

    const saves: SaveSeedReport[] = inputs.saves.map((input) => {
      const result = seedMapSave(db, input);
      const counts = countMapSaveRows(db, input.save.id);
      verifyMapSave(input, result, counts);

      if (input.groupings.length > 0 && input.leaders.length === 0) {
        warnings.push(
          `${input.file}: no union leader could be placed. Canon marks ` +
            `${inputs.leaderMarkers.length}; none of their countries is a member of a ` +
            `unified nation in this file.`,
        );
      }
      for (const unplaced of input.unplacedLeaders) {
        warnings.push(
          `${input.file}: canon's leader for "${unplaced.union}" ` +
            `(${unplaced.leaderName}, Bible L${unplaced.line}) was NOT written — ${unplaced.reason}`,
        );
      }
      if (result.staleMemberships > 0 || result.staleGroupings > 0) {
        warnings.push(
          `${input.file}: ${result.staleGroupings} grouping(s) and ${result.staleMemberships} ` +
            `membership row(s) already in save "${input.save.id}" are not named by the file. ` +
            `Left in place — the seed is never destructive (§7.4).`,
        );
      }

      return {
        result,
        counts,
        resolution: input.resolution,
        independentsSkipped: input.independentsSkipped,
        expectedGroupings: input.groupings.length,
        expectedMemberships: input.groupings.reduce((n, g) => n + g.countryIds.length, 0),
        leaders: input.leaders,
        unplacedLeaders: input.unplacedLeaders,
        overrideCandidates: input.overrideCandidates,
      };
    });

    return {
      countries,
      countryRows: countCountryRows(db),
      deriveWarnings: inputs.deriveWarnings,
      unmappedIsoKeys: inputs.unmappedIsoKeys,
      isoKeyDriftSuspected: inputs.isoKeyDriftSuspected,
      leaderMarkers: inputs.leaderMarkers,
      saves,
      warnings,
    };
  });

  return run();
}

/** The seed report as log lines — what `npm run db:seed` prints. */
export function formatSeedReport(report: SeedReport): string[] {
  const lines: string[] = [];

  lines.push('countries (global, real-world) — P1.9');
  lines.push(
    `  ${report.countryRows} rows: ${report.countries.inserted} inserted, ` +
      `${report.countries.updated} updated, ${report.countries.unchanged} already current`,
  );
  lines.push(
    `  geometry_source: ${report.countries.featureRows} feature, ` +
      `${report.countries.derivedRows} derived`,
  );
  lines.push(`  synthetic ids: ${report.countries.syntheticIds.join(', ')}`);
  lines.push(
    `  mapping entries with no country row (${report.unmappedIsoKeys.length}, expected 3): ` +
      report.unmappedIsoKeys.map((e) => `${e.key} -> ${e.alpha3} (${e.reason})`).join('; '),
  );

  lines.push('');
  lines.push(`union leaders — canon marks ${report.leaderMarkers.length} (P1.11.2)`);
  for (const marker of report.leaderMarkers) {
    const code = marker.alpha3 ?? '???';
    lines.push(`  L${marker.line} ${marker.union}: ${marker.leaderName} (${code})`);
  }

  for (const save of report.saves) {
    const { result, counts, resolution } = save;
    lines.push('');
    lines.push(`${result.file} -> save "${result.saveId}" (${result.saveName})`);
    lines.push(
      `  save row: ${result.saveInserted ? 'inserted' : result.saveChanged ? 'updated' : 'already current'}`,
    );
    lines.push(
      `  groupings: ${counts.groupings} (${result.groupingsInserted} inserted, ` +
        `${result.groupingsUpdated} updated, ${result.groupingsUnchanged} already current; ` +
        `${save.independentsSkipped} synthesized "independent" groups skipped)`,
    );
    lines.push(
      `  grouping_country: ${counts.memberships} (${result.membershipsInserted} inserted, ` +
        `${result.membershipsUpdated} updated, ${result.membershipsUnchanged} already current)`,
    );
    lines.push(
      `  code resolution: ${resolution.total} codes = ${resolution.numeric} numeric + ` +
        resolution.syntheticIds.join(' + '),
    );
    lines.push(
      `  is_leader: ${counts.leaders} in ${counts.groupingsWithLeader} distinct groupings`,
    );
    for (const leader of save.leaders) {
      const renamed = leader.groupingName === leader.union ? '' : ` [canon: "${leader.union}"]`;
      lines.push(`    ${leader.groupingName}: ${leader.leaderName} (${leader.alpha3})${renamed}`);
    }
    lines.push(
      `  country_override: ${counts.overrides} rows from ${save.overrideCandidates} cached ` +
        `names (only entries differing from the derived default — P1.11.4)`,
    );
  }

  if (report.warnings.length > 0) {
    lines.push('');
    lines.push(`warnings (${report.warnings.length})`);
    for (const warning of report.warnings) lines.push(`  ! ${warning}`);
  }

  return lines;
}
