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
import { eq, sql } from 'drizzle-orm';

import { countCountryRows, seedCountries } from './countries.js';
import { seedEvents } from './events.js';
import { countMapSaveRows, seedMapSave } from './mapSaves.js';
import { seedRegistry } from './registry.js';
import { readTagIdsByName, seedTags } from './tags.js';
import { seedTimelines } from './timelines.js';
import {
  character,
  characterRelation,
  event,
  eventActor,
  eventTag,
  location,
  project,
  relation,
  tag,
  timeline,
  timelineMember,
  timelineParent,
} from '../db/schema.js';

import type { CountrySeedResult } from './countries.js';
import type { CanonDateTools } from './dateTools.js';
import type { EventSeedResult } from './events.js';
import type {
  LeaderAssignment,
  MapSaveInput,
  ResolutionSplit,
  SeedInputs,
  UnmappedIsoKey,
  UnplacedLeader,
} from './inputs.js';
import type { MapSaveCounts, MapSaveResult } from './mapSaves.js';
import type { RegistrySeedResult } from './registry.js';
import type { TagSeedResult } from './tags.js';
import type { TimelineSeedResult } from './timelines.js';
import type { Db, DbHandle } from '../db/index.js';
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
export type { CanonDateTools } from './dateTools.js';
export {
  CanonCitationError,
  formatCitationReport,
  normaliseCanonText,
  verifyCitations,
  WEAK_QUOTE_MATCHES,
} from './citations.js';
export type {
  Citation,
  CitationDrift,
  CitationReport,
  LocatedCitation,
  WeakCitation,
} from './citations.js';
export { CANON_TAGS, seedTags } from './tags.js';
export type { CanonTag, TagSeedResult } from './tags.js';
export {
  CANON_CHARACTERS,
  CANON_CHARACTER_RELATIONS,
  CANON_LOCATIONS,
  CANON_PROJECTS,
  CANON_REGISTRY_CITATIONS,
  LifespanAuthorityError,
  seedRegistry,
} from './registry.js';
export type { RegistrySeedResult } from './registry.js';
export {
  CANON_EVENTS,
  CANON_EVENT_CITATIONS,
  CANON_NON_EVENTS,
  CanonDriftError,
  bulletSentences,
  eventOwnedLifespanBounds,
  readPreBigOneBullets,
  readWorldTimelineBullets,
  refreshLifespanCache,
  resolveCanonEvents,
  seedEvents,
  TRANSCRIBED_SECTIONS,
} from './events.js';
export type {
  CanonBullet,
  CanonEvent,
  CanonEventResolution,
  CanonNonEvent,
  EventDateReport,
  EventSeedResult,
  LifespanBound,
  SectionLedger,
} from './events.js';
export {
  CANON_TIMELINE_CITATIONS,
  CANON_TIMELINES,
  eraMembershipRules,
  seedTimelines,
} from './timelines.js';
export type { CanonTimeline, EraBounds, TimelineSeedResult } from './timelines.js';

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

/** Row counts read back after the P3 writes — what the tables actually hold. */
export interface CanonCounts {
  /** GLOBAL, so not scoped to a save. */
  tags: number;
  characters: number;
  locations: number;
  projects: number;
  characterRelations: number;
  events: number;
  eventActors: number;
  eventTags: number;
  relations: number;
  timelines: number;
  timelineParents: number;
  timelineMembers: number;
}

/** What the P3 half of the seed wrote, and what the database holds afterwards. */
export interface CanonSeedReport {
  saveId: string;
  tags: TagSeedResult;
  registry: RegistrySeedResult;
  events: EventSeedResult;
  timelines: TimelineSeedResult;
  counts: CanonCounts;
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
  /**
   * The authored world — tags, registry, the Pre-Big One events, the two timelines (P3.1-P3.4).
   * `undefined` when no {@link CanonDateTools} was supplied: the date functions are not
   * importable from here (see `dateTools.ts`), so a caller that does not hand them in gets
   * the map world alone rather than a half-dated corpus.
   */
  canon?: CanonSeedReport;
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
 * What the P3 tables hold after the writes — read back, never inferred from the write
 * counters, so a row that was rejected or that some earlier run left behind still shows
 * up in the number the log prints.
 *
 * Spelled out one query per table rather than looped: drizzle's `.from()` loses every
 * useful type the moment the table is a variable, and a renamed column should be a build
 * error here rather than a runtime one.
 */
function countCanonRows(db: Db, saveId: string): CanonCounts {
  const n = sql<number>`count(*)`;
  const all = (query: { get(): { n: number } | undefined }): number => query.get()?.n ?? 0;

  return {
    tags: all(db.select({ n }).from(tag)),
    characters: all(db.select({ n }).from(character).where(eq(character.saveId, saveId))),
    locations: all(db.select({ n }).from(location).where(eq(location.saveId, saveId))),
    projects: all(db.select({ n }).from(project).where(eq(project.saveId, saveId))),
    characterRelations: all(
      db.select({ n }).from(characterRelation).where(eq(characterRelation.saveId, saveId)),
    ),
    events: all(db.select({ n }).from(event).where(eq(event.saveId, saveId))),
    eventActors: all(db.select({ n }).from(eventActor).where(eq(eventActor.saveId, saveId))),
    eventTags: all(db.select({ n }).from(eventTag).where(eq(eventTag.saveId, saveId))),
    relations: all(db.select({ n }).from(relation).where(eq(relation.saveId, saveId))),
    timelines: all(db.select({ n }).from(timeline).where(eq(timeline.saveId, saveId))),
    timelineParents: all(
      db.select({ n }).from(timelineParent).where(eq(timelineParent.saveId, saveId)),
    ),
    timelineMembers: all(
      db.select({ n }).from(timelineMember).where(eq(timelineMember.saveId, saveId)),
    ),
  };
}

/**
 * Seed the authored world under the canon save — P3.1 tags, P3.2 registry, P3.3 the
 * Pre-Big One events, P3.4 the root timeline and the first era.
 *
 * ORDER IS THE POINT. Tags come first because tagging is a step of the event seed and not
 * a later pass (§7.4), the registry before the events because an event's location, project
 * and actors are all foreign keys into it, and the timelines last because the era's
 * `byTimeRange` rule is only meaningful once there are events for it to match.
 */
function seedCanon(db: Db, inputs: SeedInputs, tools: CanonDateTools): CanonSeedReport {
  const saveId = inputs.canonSaveId;

  const tags = seedTags(db);
  const registry = seedRegistry(db, saveId, tools);
  const events = seedEvents(db, saveId, inputs.preBigOneBullets, readTagIdsByName(db), tools);
  const timelines = seedTimelines(db, saveId, tools);

  return { saveId, tags, registry, events, timelines, counts: countCanonRows(db, saveId) };
}

/**
 * Seed the database from resolved inputs.
 *
 * @param handle the connection, from `createDb`. The raw `sqlite` half is what wraps the
 *               whole run in one transaction.
 * @param inputs from `readSeedInputs`.
 * @param tools  `rollDate` and `precisionToInterval`, handed down by the composition root
 *               for the reason `dateTools.ts` gives. OPTIONAL: without them the run seeds
 *               the map world only, which is exactly what a country-import fixture wants
 *               and is why it is not a required argument.
 * @throws if a write does not produce the rows its input asked for — the transaction rolls
 *         back and nothing is written.
 */
export function runSeed(handle: DbHandle, inputs: SeedInputs, tools?: CanonDateTools): SeedReport {
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

    // After the saves, because every P3 row is an FK away from the canon `save` row that
    // `seedMapSave` writes. `readSeedInputs` already refuses a source set that produces no
    // canon save, so there is nothing to fall back to here.
    const canon = tools === undefined ? undefined : seedCanon(db, inputs, tools);
    if (tools === undefined) {
      warnings.push(
        `no date tools were supplied, so the authored world (tags, registry, the ` +
          `Pre-Big One events, the timelines) was NOT seeded. \`npm run db:seed\` always ` +
          `supplies them; a fixture that only needs the map world does not.`,
      );
    }

    return {
      countries,
      countryRows: countCountryRows(db),
      deriveWarnings: inputs.deriveWarnings,
      unmappedIsoKeys: inputs.unmappedIsoKeys,
      isoKeyDriftSuspected: inputs.isoKeyDriftSuspected,
      leaderMarkers: inputs.leaderMarkers,
      saves,
      canon,
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

  if (report.canon !== undefined) lines.push('', ...formatCanonReport(report.canon));

  if (report.warnings.length > 0) {
    lines.push('');
    lines.push(`warnings (${report.warnings.length})`);
    for (const warning of report.warnings) lines.push(`  ! ${warning}`);
  }

  return lines;
}

/** `n rows: a inserted, b updated, c already current`. */
const rowLine = (
  rows: number,
  wrote: { inserted: number; updated: number; unchanged: number },
): string =>
  `${rows} rows: ${wrote.inserted} inserted, ${wrote.updated} updated, ` +
  `${wrote.unchanged} already current`;

/**
 * The authored world, as log lines — including the DATE PROOF: every one of the
 * events with the text it was dated from, the precision that text implies, the window that
 * precision derives, and the roll inside it. That table is the only way to see at a glance
 * that no instant was hard-coded, and that two bullets both dated "2039" landed on two
 * different points.
 */
export function formatCanonReport(canon: CanonSeedReport): string[] {
  const lines: string[] = [];
  const { counts } = canon;

  lines.push(`authored world -> save "${canon.saveId}" (P3.1-P3.4)`);
  lines.push(`  tag (GLOBAL, no save_id): ${rowLine(counts.tags, canon.tags)}`);
  if (canon.tags.adopted > 0) {
    lines.push(`    ${canon.tags.adopted} adopted an existing row's id, matched by name`);
  }
  lines.push(`  character: ${rowLine(counts.characters, canon.registry.characters)}`);
  lines.push(`  location: ${rowLine(counts.locations, canon.registry.locations)}`);
  lines.push(`  project: ${rowLine(counts.projects, canon.registry.projects)}`);
  lines.push(
    `  character_relation: ${rowLine(counts.characterRelations, canon.registry.characterRelations)}`,
  );
  lines.push(`  event: ${rowLine(counts.events, canon.events.events)}`);
  lines.push(
    `  event_actor: ${counts.eventActors} rows (${canon.events.actors.inserted} inserted this run)`,
  );
  lines.push(
    `  event_tag: ${counts.eventTags} rows (${canon.events.tags.inserted} inserted this run)`,
  );
  lines.push(`  relation: ${rowLine(counts.relations, canon.events.relations)}`);
  lines.push(`  timeline: ${rowLine(counts.timelines, canon.timelines.timelines)}`);
  lines.push(
    `  timeline_parent: ${counts.timelineParents} rows ` +
      `(${canon.timelines.parentEdges.inserted} inserted this run); DAG root is ` +
      `"${canon.timelines.rootId}", parentless — structurally, not by kind`,
  );
  lines.push(
    `  timeline_member: ${counts.timelineMembers} rows (membership is by rule, not roster)`,
  );
  lines.push(
    `  lifespan caches refreshed from born/died events: ${canon.events.lifespansRefreshed}`,
  );

  // The consumption ledger (P3 review F2). NOT a count comparison: one bullet can become
  // two events and one bullet can be claimed as a thread instead, so what has to hold is
  // that nothing is UNSPENT. `resolveCanonEvents` already refused the run otherwise; this
  // is the same fact in the log, per section, for P5.7.3 to read.
  lines.push('');
  lines.push('  bullet ledger — every bullet consumed, as an event or as a stated non-event');
  for (const section of canon.events.ledger) {
    lines.push(
      `    ${section.section}: ${section.bullets} bullets -> ${section.events} event(s) ` +
        `from ${section.bulletsWithEvent}, ${section.bulletsWithoutEvent} claimed as ` +
        `thread/project/skip, 0 unclaimed`,
    );
  }

  lines.push('');
  lines.push(
    `  the ${canon.events.dates.length} Pre-Big One dates — every one derived, none ` +
      `hard-coded (P3.3.2)`,
  );
  // The id is in the table because a LINE can now appear twice: a compound bullet becomes
  // two events, and the roll is seeded on the id, so the id is what explains why one line
  // produced two different instants.
  lines.push(
    `    ${'L'.padEnd(5)}${'event id'.padEnd(32)}${'source date'.padEnd(26)}${'prec'.padEnd(8)}` +
      `${'when_min'.padEnd(26)}${'when_max'.padEnd(26)}when`,
  );
  for (const date of canon.events.dates) {
    lines.push(
      `    ${String(date.line).padEnd(5)}${date.id.padEnd(32)}${date.sourceDate.padEnd(26)}` +
        `${date.precision.padEnd(8)}${date.whenMin.padEnd(26)}${date.whenMax.padEnd(26)}${date.when}`,
    );
  }

  return lines;
}
