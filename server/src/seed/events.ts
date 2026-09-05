/**
 * P3.3 — the thin slice: the Pre-Big One bullets, `LIFEstream Bible.txt` L888-899.
 *
 * Twelve bullets, not eighty. The remaining sixty-eight are transcribed in P5 with the
 * Corridor open, because bulk transcription against a schema no view has exercised is
 * transcription against a guess — a wrong precision or a silently-dropped actor is
 * invisible in a seed script and obvious the moment the node renders in the wrong place.
 *
 * Twelve bullets, THIRTEEN events: L894 is compound and is split. See "one bullet is not
 * one event" below.
 *
 * ── THE DATE MODEL, WHICH IS THE POINT OF THIS FILE (§2.3, P3.3.2) ────────────────────
 * Nothing here hard-codes an instant. Each bullet states a precision and a value; the
 * window is `precisionToInterval(precision, value)` and the point is
 * `rollDate(event.id, whenMin, whenMax)`. The roll is seeded on the EVENT ID, which is
 * why L897 and L898 — both bare "2039" — land on different instants deterministically,
 * and why re-running the seed does not move a single node in the Corridor.
 *
 * Views render by PRECISION and never print the roll: a year-precision bullet displays
 * "2036". The roll is a layout value; printing it would fabricate a datetime canon does
 * not contain.
 *
 * ── THE AUTHORED TABLE IS THE CHECK, NOT THE SOURCE ───────────────────────────────────
 * `description` is never transcribed by hand — it is read out of the Bible at seed time by
 * {@link readWorldTimelineBullets}, so it is verbatim by construction. What IS authored is
 * the reading of each bullet: its precision, its category, where it happened, who was in
 * it, and what it is about.
 *
 * ── HOW A READING FINDS ITS BULLET (P3 review F2) ─────────────────────────────────────
 * The key is `(section heading, date phrase, the opening of the bullet's own prose)`.
 * NOT the line number. A line number is not a property of the bullet — it is a property of
 * everything above it, so one blank line inserted six hundred lines away renumbered every
 * entry and, worse, silently re-paired an event with its neighbour wherever two adjacent
 * bullets shared a year (L897 and L898 are both "2039"; P5's sections carry four more such
 * pairs). {@link CanonEvent.textStart} is what tells those apart, and it is compared under
 * {@link normaliseCanonText} so the source's curly quotes are not a tripwire.
 *
 * The line number is still REPORTED — in every error and in the seed's date proof — but it
 * is read off the bullet that matched, never asserted against it.
 *
 * ── ONE BULLET IS NOT ONE EVENT: THE LEDGER (P3 review F2, F6) ────────────────────────
 * A bullet may become two events, or one event, or no event at all. So the check is not a
 * count comparison — `bullets.length === CANON_EVENTS.length` forbids exactly the split
 * P3.3 calls for and P5 requires — it is a CONSUMPTION LEDGER: every bullet the parser
 * finds must be claimed by at least one {@link CanonEvent} or by an explicit
 * {@link CanonNonEvent} (a thread, a project, or a deliberate skip). A bullet nobody
 * claims fails the seed. That is the check P5.7.3's "12 / 8 / 21 / 39 bullets consumed"
 * needs, and it is what lets P5.2.3 record L910 "2042 onward" as a thread rather than
 * quietly dropping it.
 *
 * The one split shipped here is L894 (P3 review F6). Its bullet carries a redesignation
 * AND "The first elevator connecting Top Ridge to Bottom Ridge is constructed…", which is
 * a distinct dated megastructure milestone on the Disaster Ridge build thread and already
 * appears as prose in `loc_fob_oasis`'s description with no event behind it. Splitting it
 * now means P5 is not the first user of the path, and it makes P3.3's "twelve is a floor"
 * true rather than aspirational. Each half takes its own sentences of the bullet
 * ({@link CanonEvent.descriptionSentences}) — sliced, never retyped.
 *
 * ── BRACKETS (P3.3.5) ─────────────────────────────────────────────────────────────────
 * None of these sets `range_before_event_id` / `range_after_event_id`. They narrow a
 * window and never source one, and no bullet here narrows another: the only candidate is
 * L896's "people are moved into the mega block before it finishes completion", and
 * bounding a 2037 window above by a 2039 completion removes nothing from it. An optional
 * column that records a relationship it does not constrain is a column later readers will
 * mistake for a date source.
 */
import { and, eq, inArray } from 'drizzle-orm';

import { locate, normaliseCanonText } from './citations.js';
import { character, event, eventActor, eventTag, relation } from '../db/schema.js';

import type { Citation, LocatedCitation } from './citations.js';
import type { CanonDateTools } from './dateTools.js';
import type { Db } from '../db/index.js';
import type { Category, TechLane, WhenPrecision } from '@shared/types/index';

/** One bullet as it stands in the Bible — parsed, never retyped. */
export interface CanonBullet {
  /** The World Timeline heading it stands under — `"Pre-Big One"`. Part of its key. */
  section: string;
  /**
   * 1-based line number in `data/story_docs/LIFEstream Bible.txt`.
   *
   * REPORTED, never asserted: it is read off the file every run, so it is always current
   * and no authored table has to be renumbered when a line is inserted above (F2).
   */
  line: number;
  /** The date phrase before the first `": "` — `"July 10th, 2034, 8:04am"`. Part of its key. */
  dateText: string;
  /** Everything after it, trimmed. The source of every `event.description`. */
  text: string;
}

/** One character's part in an event. `role` must already be lower-case and trimmed. */
export interface CanonEventActor {
  characterId: string;
  /** Free text, except the reserved `born` / `died` which link a lifespan bound (§2.2). */
  role: string;
}

/** What identifies the bullet a reading was taken from — the F2 key, without a line number. */
export interface BulletClaim {
  /** The World Timeline heading the bullet stands under. */
  section: string;
  /** The bullet's date phrase, exactly as the file spells it. */
  sourceDate: string;
  /**
   * The opening of the bullet's own prose — enough of it to tell the bullet apart from
   * every sibling that shares its section and date. Compared as a normalised PREFIX, so
   * it can stop at a word boundary and need not reproduce the source's punctuation.
   */
  textStart: string;
}

/** The authored reading of one bullet. Everything canon states is verified, not retyped. */
export interface CanonEvent extends BulletClaim {
  id: string;
  /** Authored: a short label for the node. The bullet's own prose is the description. */
  title: string;
  /**
   * Which of the bullet's sentences become this event's description, in order. Omit for
   * the whole bullet — which is the case for every bullet that is not split. Indices are
   * checked against the bullet, so a rewritten bullet fails rather than truncating.
   */
  descriptionSentences?: readonly number[];
  /** Straight off the source text (P3.3.1). */
  precision: WhenPrecision;
  /** `sourceDate` in a form `precisionToInterval` reads. The only hand step in the date path. */
  precisionValue: string;
  category: Category;
  /** Only legal when `category === 'tech'` — a CHECK enforces it. */
  techLane?: TechLane;
  locationId?: string;
  projectId?: string;
  actors?: readonly CanonEventActor[];
  /** `tag.name`s from the P3.1 vocabulary. Every event carries at least one (P3.3.4). */
  tags: readonly string[];
}

/**
 * A bullet the transcription deliberately does NOT turn into an event.
 *
 * The ledger requires every bullet to be claimed, so "this one is a thread, not an event"
 * has to be stated rather than left as silence — silence is indistinguishable from an
 * oversight, which is the whole failure the ledger exists to catch.
 */
export interface CanonNonEvent extends BulletClaim {
  /** What it becomes instead. `skip` is a deliberate omission with a reason. */
  kind: 'thread' | 'project' | 'skip';
  reason: string;
}

/**
 * The World Timeline headings this module transcribes.
 *
 * P5 adds "North Korean War", "Black Fever Era" and "Reconstruction Era" here; the parser
 * and the ledger already work per-section, so that is the whole of the change.
 */
export const TRANSCRIBED_SECTIONS: readonly string[] = ['Pre-Big One'];

/** The line the World Timeline begins on. Sections are the non-bullet lines under it. */
const WORLD_TIMELINE_HEADING = 'World Timeline:';

/**
 * The thirteen readings, in Bible order.
 *
 * The precision spread is canon's, not a choice: seven bare years, three day-precision
 * dates, one timestamp and one season — the season covering both halves of the split
 * L894.
 *
 * `project_id` is null on all of them, and that is a fact rather than an omission — the
 * five programmes of P3.2.4 all begin in 2042 or later, so none of the Pre-Big One
 * bullets belongs to one.
 */
export const CANON_EVENTS: readonly CanonEvent[] = [
  {
    id: 'evt_lazaro_born',
    section: 'Pre-Big One',
    sourceDate: '2021',
    textStart: 'Lazaro Castaneda is born',
    title: 'Lazaro Castañeda is born',
    precision: 'year',
    precisionValue: '2021',
    category: 'personal',
    // The bullet says Los Angeles; the pre-Big-One stage of the chain, since this is 2021.
    // (Canon disagrees with itself here: the prose life story has him born in Lancaster and
    // raised in Mojave. The world timeline is what P3.3 transcribes, so the world timeline
    // is what is stored. See CANON_EVENT_CITATIONS.)
    locationId: 'loc_los_angeles',
    actors: [{ characterId: 'char_lazaro', role: 'born' }],
    tags: ['castaneda'],
  },
  {
    id: 'evt_ines_born',
    section: 'Pre-Big One',
    sourceDate: '2025',
    textStart: 'Ines Cardenas is born',
    title: 'Ines Cardenas is born',
    precision: 'year',
    precisionValue: '2025',
    category: 'personal',
    locationId: 'loc_los_angeles',
    actors: [{ characterId: 'char_ines', role: 'born' }],
    tags: ['castaneda'],
  },
  {
    id: 'evt_big_one',
    section: 'Pre-Big One',
    sourceDate: 'July 10th, 2034, 8:04am',
    textStart: 'An earthquake colloquially known as',
    title: 'The Big One',
    // The one `time`-precision bullet. AUTHORING JUDGEMENT: canon writes a wall clock
    // ("8:04am") for an earthquake in California and the column stores UTC. The stated
    // clock is taken at face value as the stored instant rather than shifted by an offset
    // canon never gives — which is also the worked example in `rollDate.ts`'s own
    // documentation (`time` | `2034-07-10T08:04Z`).
    precision: 'time',
    precisionValue: '2034-07-10T08:04Z',
    category: 'disaster',
    // AUTHORING JUDGEMENT: the bullet says the earthquake "hit California", and California
    // is not a location row. The epicenter is: the next bullet is "a study of the epicenter
    // and the chasm opened above it known as 'Disaster Ridge'". Siting it at the Ridge is
    // what makes the Big One appear in the site's own history.
    locationId: 'loc_disaster_ridge',
    tags: ['big-one', 'disaster-ridge'],
  },
  {
    id: 'evt_disaster_ridge_study',
    section: 'Pre-Big One',
    sourceDate: 'August 13th, 2034',
    textStart: 'The US government commissions a study',
    title: 'The US government commissions the Disaster Ridge study',
    precision: 'day',
    precisionValue: '2034-08-13',
    // AUTHORING JUDGEMENT: `political` rather than `scientific`. The dated act is a
    // government commissioning; the science it commissions starts in the next bullet.
    category: 'political',
    locationId: 'loc_disaster_ridge',
    tags: ['disaster-ridge', 'big-one'],
  },
  {
    id: 'evt_ridge_probing_begins',
    section: 'Pre-Big One',
    sourceDate: 'Feb 1st, 2035',
    textStart: 'Once the area was secured',
    title: 'Scientists begin probing the Ridge',
    precision: 'day',
    precisionValue: '2035-02-01',
    category: 'scientific',
    // The bullet's "small military base ... formed around the ridge" is COP Isotope, but
    // the bullet does not name it and what is dated is the probing of the Ridge itself.
    locationId: 'loc_disaster_ridge',
    tags: ['disaster-ridge'],
  },
  {
    id: 'evt_megablock_1_groundbreaking',
    section: 'Pre-Big One',
    sourceDate: 'Aug 1st, 2035',
    textStart: 'With thousands of Angelenos now unhoused',
    title: "Los Angeles' first Megablock breaks ground",
    precision: 'day',
    precisionValue: '2035-08-01',
    category: 'tech',
    techLane: 'megastructure',
    // Post-Big-One, so the Neo Los Angeles stage of the chain — canon defines Neo Los
    // Angeles as "Name of Los Angeles after the Big One" without dating the change, and
    // the Big One is the only boundary it gives.
    locationId: 'loc_neo_los_angeles',
    tags: ['megablock', 'big-one'],
  },
  {
    id: 'evt_fob_oasis_designation',
    section: 'Pre-Big One',
    sourceDate: 'Late 2035',
    textStart: 'As extraction operations scale up',
    title: 'COP Isotope is redesignated FOB Oasis',
    // First half of the compound bullet — the redesignation sentence only (F6).
    descriptionSentences: [0],
    // The one `season`-precision bullet. "Late" is Q4 (§2.3).
    precision: 'season',
    precisionValue: 'Late 2035',
    category: 'military',
    // The stage this event CREATES, not the one it ends — this is FOB Oasis's founding
    // event, and the chain row already exists (P3.2.3). No new location is invented here.
    locationId: 'loc_fob_oasis',
    tags: ['disaster-ridge', 'helium-3'],
  },
  {
    id: 'evt_ridge_first_elevator',
    section: 'Pre-Big One',
    sourceDate: 'Late 2035',
    // Same bullet as the row above, told apart by nothing — both halves of a compound
    // bullet share its key by construction, which is why the ledger counts CLAIMS and not
    // rows (F2, F6).
    textStart: 'As extraction operations scale up',
    title: 'The first Top Ridge–Bottom Ridge elevator is built',
    // Second half of the compound bullet.
    descriptionSentences: [1],
    precision: 'season',
    precisionValue: 'Late 2035',
    // AUTHORING JUDGEMENT: `tech` / `megastructure`, not `military`. The redesignation
    // beside it is the military act; this is the first permanent structure in the chasm and
    // the start of the Disaster Ridge build line that runs to Earth Tower 1 — the thread
    // P5.5.3 owns. `loc_fob_oasis` because the bullet dates the elevator to that phase, and
    // `loc_fob_oasis`'s own description already says so.
    category: 'tech',
    techLane: 'megastructure',
    locationId: 'loc_fob_oasis',
    tags: ['disaster-ridge', 'helium-3'],
  },
  {
    id: 'evt_megablocks_2_8_begin',
    section: 'Pre-Big One',
    sourceDate: '2036',
    textStart: 'Megablock 2 through 8 begin construction',
    title: 'Megablocks 2 through 8 begin construction',
    precision: 'year',
    precisionValue: '2036',
    category: 'tech',
    techLane: 'megastructure',
    locationId: 'loc_neo_los_angeles',
    tags: ['megablock'],
  },
  {
    id: 'evt_megablock_early_occupancy',
    section: 'Pre-Big One',
    sourceDate: '2037',
    textStart: 'Due to immense demand',
    title: 'People move into the Megablock before it is finished',
    precision: 'year',
    precisionValue: '2037',
    // AUTHORING JUDGEMENT: `cultural`. What the bullet dates is a housing-demand
    // phenomenon, not a construction milestone, so it is deliberately NOT tech/megastructure
    // like the three build events around it.
    category: 'cultural',
    locationId: 'loc_neo_los_angeles',
    tags: ['megablock'],
  },
  {
    id: 'evt_megablock_1_complete',
    section: 'Pre-Big One',
    sourceDate: '2039',
    // The first of the two adjacent "2039" bullets. Under the old line-number key these
    // two were indistinguishable; the prose opening is what separates them (F2).
    textStart: 'Built at an unprecedented pace',
    title: 'Megablock 1 is completed',
    precision: 'year',
    precisionValue: '2039',
    category: 'tech',
    techLane: 'megastructure',
    locationId: 'loc_neo_los_angeles',
    tags: ['megablock'],
  },
  {
    id: 'evt_camp_oasis_designation',
    section: 'Pre-Big One',
    sourceDate: '2039',
    textStart: 'FOB Oasis is redesignated Camp Oasis',
    title: 'FOB Oasis is redesignated Camp Oasis',
    precision: 'year',
    precisionValue: '2039',
    category: 'military',
    locationId: 'loc_camp_oasis',
    // "Lazaro is among the first Marines to receive a permanent billet there." The role is
    // free text; `billeted` is authored vocabulary, not one of the two reserved roles.
    actors: [{ characterId: 'char_lazaro', role: 'billeted' }],
    tags: ['disaster-ridge', 'castaneda'],
  },
  {
    id: 'evt_megablocks_2_4_complete',
    section: 'Pre-Big One',
    sourceDate: '2040',
    textStart: 'Megablock 2-4, the last of the first generation',
    title: 'Megablocks 2-4 complete the first generation',
    precision: 'year',
    precisionValue: '2040',
    category: 'tech',
    techLane: 'megastructure',
    locationId: 'loc_neo_los_angeles',
    tags: ['megablock'],
  },
];

/**
 * Bullets deliberately transcribed as something other than an event.
 *
 * EMPTY for the Pre-Big One section: all twelve of its bullets are dated moments and all
 * twelve become events. P5 fills this — L910's "2042 onward" is a thread, not a point
 * (P5.2.3) — and the ledger will refuse the run until it does.
 */
export const CANON_NON_EVENTS: readonly CanonNonEvent[] = [];

/**
 * The prose claims this module's comments make about lines the bullets themselves do not
 * cover, as data the seed checks (P3 review F5).
 *
 * A bullet's own line needs no citation: the reading is matched against the file every run
 * and its line number is read back off the match. These are the OTHER lines the reasoning
 * leans on — the ones a reader would otherwise have to take on trust.
 */
const MODULE_CITATIONS: readonly Citation[] = [
  {
    of: 'the World Timeline heading the parser anchors on',
    line: 911,
    quote: 'World Timeline:',
  },
  {
    of: "the Pre-Big One heading — the line above this, the section's first bullet",
    line: 913,
    quote: '* 2021: Lazaro Castaneda is born in Los Angeles.',
  },
  {
    of: 'the prose section the heading must NOT be confused with',
    line: 446,
    quote: 'Pre-Big One Era',
  },
  {
    of: 'evt_lazaro_born — canon disagreeing with itself about his birthplace',
    line: 91,
    quote: 'Lazaro was born in 2021 to Mexican immigrants in Lancaster, California',
  },
  {
    of: 'evt_ridge_probing_begins — the unnamed "small military base" is COP Isotope',
    line: 82,
    quote: 'Combat Outpost Isotope, or',
  },
  {
    of: 'evt_megablock_1_groundbreaking — Neo Los Angeles is the post-Big-One name',
    line: 890,
    quote: 'Name of Los Angeles after the Big One',
  },
  {
    of: 'evt_ridge_first_elevator — the elevator belongs to the FOB Oasis phase',
    line: 83,
    quote: 'For the first time there is an elevator built from the command center',
  },
];

/** Every Bible line this module cites, ready for `verifyCitations`. */
export const CANON_EVENT_CITATIONS: readonly LocatedCitation[] = locate(
  'events.ts',
  MODULE_CITATIONS,
);

/**
 * The `renames` edge between the two rename bullets, matching the
 * `superseded_by_location_id` chain it describes (P3.2.3): old designation → new.
 *
 * P5.6 owns the rest of the relation graph. This one edge ships now because both of its
 * endpoints are inside the slice, and leaving the pair of rename events unconnected would
 * make the location chain look like the only record of a fact canon states twice.
 */
const CANON_RENAME_EDGE = {
  id: 'rel_renames_fob_oasis_camp_oasis',
  fromEventId: 'evt_fob_oasis_designation',
  toEventId: 'evt_camp_oasis_designation',
  type: 'renames',
  note: 'FOB Oasis → Camp Oasis, the same step the location chain records.',
} as const;

/** A seeded reading that no longer describes the Bible. Rolls the transaction back. */
export class CanonDriftError extends Error {
  override name = 'CanonDriftError';
}

/**
 * Every bullet under the named World Timeline headings, in document order.
 *
 * This is the CHECK, not the source of the reading — but it IS the source of every
 * `description`, so a bullet edited in the Bible reaches the database on the next seed
 * without anyone retyping it.
 *
 * The World Timeline is anchored on its own `"World Timeline:"` line, which is what
 * disambiguates the headings: "Pre-Big One Era" at L420 is a prose section with a similar
 * name and no bullets, and matching that instead would seed nothing.
 *
 * A bullet with no `": "` date separator is still returned, with an empty `dateText` — it
 * has to reach the ledger to be refused, and a parser that quietly drops it is a hole in
 * exactly the check the ledger is.
 *
 * @throws {@link CanonDriftError} if the World Timeline, or any requested heading under
 *         it, is not in the file.
 */
export function readWorldTimelineBullets(
  bibleText: string,
  sections: readonly string[],
): CanonBullet[] {
  const lines = bibleText.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === WORLD_TIMELINE_HEADING);
  if (start === -1) {
    throw new CanonDriftError(
      `seed: no "${WORLD_TIMELINE_HEADING}" line in data/story_docs/LIFEstream Bible.txt. ` +
        `Every transcribed bullet hangs off it, so the whole slice would seed as nothing.`,
    );
  }

  const wanted = new Set(sections);
  const seen = new Set<string>();
  const bullets: CanonBullet[] = [];
  let section: string | null = null;

  for (let index = start + 1; index < lines.length; index += 1) {
    const raw = (lines[index] ?? '').trim();
    if (raw === '') continue;

    // Any non-bullet line is the next heading. A blank line inside a section is not one,
    // which is why it is skipped above rather than clearing the heading.
    if (!raw.startsWith('* ')) {
      section = raw;
      if (wanted.has(section)) seen.add(section);
      continue;
    }
    if (section === null || !wanted.has(section)) continue;

    const body = raw.slice(2).trim();
    // Split on `": "` and not on the first colon: "July 10th, 2034, 8:04am" carries one of
    // its own, and a first-colon split would date that bullet "July 10th, 2034, 8".
    const separator = body.indexOf(': ');
    bullets.push({
      section,
      line: index + 1,
      dateText: separator === -1 ? '' : body.slice(0, separator).trim(),
      text: separator === -1 ? body : body.slice(separator + 2).trim(),
    });
  }

  const missing = sections.filter((name) => !seen.has(name));
  if (missing.length > 0) {
    throw new CanonDriftError(
      `seed: the World Timeline has no heading named ${missing.map((n) => `"${n}"`).join(', ')}. ` +
        `A renamed heading seeds an empty section rather than failing, which is why this is ` +
        `checked and not inferred from the bullet count.`,
    );
  }
  return bullets;
}

/** The bullets P3.3 transcribes — {@link TRANSCRIBED_SECTIONS}, which today is one. */
export function readPreBigOneBullets(bibleText: string): CanonBullet[] {
  return readWorldTimelineBullets(bibleText, TRANSCRIBED_SECTIONS);
}

/** A bullet's sentences, in order. The unit a compound bullet is split on. */
export function bulletSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter((sentence) => sentence !== '');
}

/**
 * `(section, date)` — the coarse half of the F2 key; `textStart` separates the rest.
 *
 * NUL-joined, not space-joined: a heading and a date phrase can otherwise be repartitioned
 * into the same string, and a key two different bullets can share is the whole bug F2 is
 * about.
 */
const claimKey = (section: string, dateText: string): string =>
  `${normaliseCanonText(section)}\u0000${normaliseCanonText(dateText)}`;

/** What one section's bullets were spent on — P5.7.3's "N bullets consumed" check. */
export interface SectionLedger {
  section: string;
  /** Bullets the parser found under the heading. */
  bullets: number;
  /** Events authored from them. GREATER than `bullets` where a compound bullet is split. */
  events: number;
  /** Bullets at least one event claims. */
  bulletsWithEvent: number;
  /** Bullets claimed only as a thread, a project, or a deliberate skip. */
  bulletsWithoutEvent: number;
}

/** One authored reading, paired with the bullet it was read off. */
export interface PairedEvent {
  authored: CanonEvent;
  bullet: CanonBullet;
}

/** The result of the drift guard: the pairings, and what every bullet was spent on. */
export interface CanonEventResolution {
  paired: PairedEvent[];
  ledger: SectionLedger[];
}

/**
 * Assert {@link CANON_EVENTS} still describes the file, pair each authored reading with
 * the bullet it reads, and account for every bullet.
 *
 * The guard has three jobs and they fail differently:
 *
 *   1. **Resolution** — each {@link BulletClaim} must match exactly one bullet on
 *      `(section, date, prose opening)`. Zero matches means the bullet moved sections, was
 *      re-dated or was rewritten; two matches means `textStart` is too short to separate
 *      two siblings and has to be lengthened.
 *   2. **Slicing** — a `descriptionSentences` index must exist in the bullet it points at.
 *   3. **The ledger** — every bullet must be claimed by at least one event or one
 *      {@link CanonNonEvent}. An unclaimed bullet is a bullet somebody forgot.
 *
 * The two authored tables are PARAMETERS with the module's own as defaults, so the guard
 * can be exercised against a constructed corpus — a re-dated bullet, a split compound
 * bullet, a bullet claimed as a thread — without editing the Bible or this file. That is
 * how F2 was proved, and it is how P5 should check its four sections before it writes them.
 *
 * @throws {@link CanonDriftError} naming every difference, with the LINE NUMBER of every
 *         bullet involved so the report can be checked against the file by eye.
 */
export function resolveCanonEvents(
  bullets: readonly CanonBullet[],
  events: readonly CanonEvent[] = CANON_EVENTS,
  nonEvents: readonly CanonNonEvent[] = CANON_NON_EVENTS,
): CanonEventResolution {
  const problems: string[] = [];

  const bySectionDate = new Map<string, CanonBullet[]>();
  for (const bullet of bullets) {
    const key = claimKey(bullet.section, bullet.dateText);
    const siblings = bySectionDate.get(key);
    if (siblings === undefined) bySectionDate.set(key, [bullet]);
    else siblings.push(bullet);
  }

  const claimed = new Set<CanonBullet>();

  /** Resolve one claim to its bullet, or push the problem that says why it could not. */
  const resolve = (claim: BulletClaim, id: string): CanonBullet | undefined => {
    const siblings = bySectionDate.get(claimKey(claim.section, claim.sourceDate)) ?? [];
    const prefix = normaliseCanonText(claim.textStart);
    const hits = siblings.filter((bullet) => normaliseCanonText(bullet.text).startsWith(prefix));

    if (hits.length === 1) {
      const bullet = hits[0] as CanonBullet;
      claimed.add(bullet);
      return bullet;
    }
    if (hits.length > 1) {
      problems.push(
        `${id}: "${claim.textStart}" matches ${hits.length} bullets under "${claim.section}" ` +
          `dated "${claim.sourceDate}" (${hits.map((b) => `L${b.line}`).join(', ')}) — ` +
          `lengthen textStart until it names one`,
      );
      return undefined;
    }
    problems.push(
      `${id}: no bullet under "${claim.section}" dated "${claim.sourceDate}" begins ` +
        `"${claim.textStart}"` +
        (siblings.length === 0
          ? ` — that section carries no bullet with that date phrase at all`
          : `; ${siblings.length} bullet(s) share that date: ` +
            siblings.map((b) => `L${b.line} "${b.text.slice(0, 48)}…"`).join(', ')),
    );
    return undefined;
  };

  const paired: PairedEvent[] = [];
  for (const authored of events) {
    const bullet = resolve(authored, authored.id);
    if (bullet === undefined) continue;

    const sentences = bulletSentences(bullet.text);
    const outOfRange = (authored.descriptionSentences ?? []).filter(
      (index) => sentences[index] === undefined,
    );
    if (outOfRange.length > 0) {
      problems.push(
        `${authored.id}: L${bullet.line} holds ${sentences.length} sentence(s), this module ` +
          `slices ${outOfRange.map((index) => `[${index}]`).join(', ')} out of it`,
      );
      continue;
    }
    paired.push({ authored, bullet });
  }

  const nonEventBullets = new Set<CanonBullet>();
  for (const nonEvent of nonEvents) {
    const bullet = resolve(
      nonEvent,
      `non-event ${nonEvent.kind} under "${nonEvent.section}" dated "${nonEvent.sourceDate}"`,
    );
    if (bullet !== undefined) nonEventBullets.add(bullet);
  }

  // ---- the ledger. Not `bullets.length === CANON_EVENTS.length`: a compound bullet is
  // two events and a span bullet is a thread, so the invariant is that nothing is
  // UNSPENT, never that the two counts agree (F2).
  const eventBullets = new Set(paired.map((entry) => entry.bullet));
  const unclaimed = bullets.filter((bullet) => !claimed.has(bullet));
  if (unclaimed.length > 0) {
    problems.push(
      `${unclaimed.length} bullet(s) no event and no non-event entry claims — every bullet ` +
        `must be spent, as an event or as an explicit thread / project / skip:\n    ` +
        unclaimed
          .map(
            (bullet) =>
              `L${bullet.line} [${bullet.section}] "${bullet.dateText}": ` +
              `"${bullet.text.slice(0, 60)}…"`,
          )
          .join('\n    '),
    );
  }

  if (problems.length > 0) {
    throw new CanonDriftError(
      `seed: the World Timeline transcription no longer matches the Bible:\n  ${problems.join('\n  ')}`,
    );
  }

  // Sections come from the BULLETS, not from `TRANSCRIBED_SECTIONS`: the ledger reports
  // what was actually read, so a section that parsed as empty shows as zero rather than
  // vanishing from the report.
  const sections = [...new Set(bullets.map((bullet) => bullet.section))];
  const ledger: SectionLedger[] = sections.map((section) => {
    const inSection = bullets.filter((bullet) => bullet.section === section);
    return {
      section,
      bullets: inSection.length,
      events: paired.filter((entry) => entry.bullet.section === section).length,
      bulletsWithEvent: inSection.filter((bullet) => eventBullets.has(bullet)).length,
      bulletsWithoutEvent: inSection.filter(
        (bullet) => !eventBullets.has(bullet) && nonEventBullets.has(bullet),
      ).length,
    };
  });

  return { paired, ledger };
}

/** What one event seed did. */
export interface EventSeedResult {
  events: { total: number; inserted: number; updated: number; unchanged: number };
  /** `event_actor` rows the slice asks for, and how many were new. */
  actors: { total: number; inserted: number };
  /** `event_tag` rows the slice asks for, and how many were new. */
  tags: { total: number; inserted: number };
  relations: { total: number; inserted: number; updated: number; unchanged: number };
  /** `character` rows whose lifespan cache a `born`/`died` event moved. */
  lifespansRefreshed: number;
  /** Per section: bullets found, and what every one of them was spent on. */
  ledger: SectionLedger[];
  /** One line per event, for the seed log and the date proof. */
  dates: EventDateReport[];
}

/** The derived date quad of one event, as the log prints it. */
export interface EventDateReport {
  id: string;
  /** Read off the bullet that matched — never authored (F2). */
  line: number;
  sourceDate: string;
  precision: WhenPrecision;
  whenMin: string;
  whenMax: string;
  when: string;
}

/** The two roles that own a lifespan bound, and the bound each owns (§2.2). */
const LIFESPAN_ROLES = ['born', 'died'] as const;

/** Which end of a lifespan a `born`/`died` role is the authority for. */
export type LifespanBound = 'start' | 'end';

const boundOfRole = (role: string): LifespanBound | null =>
  role === 'born' ? 'start' : role === 'died' ? 'end' : null;

/**
 * Which lifespan bounds are owned by an EVENT rather than authored, per character (§2.2,
 * P3 review F4).
 *
 * Derived, never listed. `registry.ts` used to carry a hand-written `eventOwnedBounds`
 * array, and the moment an actor row existed that the array did not name, two writers
 * fought over the same column: `seedCharacters` wrote the authored value, then
 * `refreshLifespanCache` wrote the event's, and every run after the first reported
 * "1 updated / refreshed 1" forever. The content converged, so `db:check` could not see
 * it and only the seed log lied — which is precisely the kind of drift a hand-maintained
 * list produces.
 *
 * BOTH sources are read, because neither alone is complete at the moment the question is
 * asked: `seedRegistry` runs BEFORE `seedEvents`, so on a first seed the table is still
 * empty, and on any run an actor row the app wrote is just as authoritative as one this
 * module authors.
 */
export function eventOwnedLifespanBounds(db: Db, saveId: string): Map<string, Set<LifespanBound>> {
  const owned = new Map<string, Set<LifespanBound>>();

  const claim = (characterId: string, role: string): void => {
    const bound = boundOfRole(role);
    if (bound === null) return;
    const bounds = owned.get(characterId);
    if (bounds === undefined) owned.set(characterId, new Set([bound]));
    else bounds.add(bound);
  };

  for (const row of db
    .select({ characterId: eventActor.characterId, role: eventActor.role })
    .from(eventActor)
    .where(and(eq(eventActor.saveId, saveId), inArray(eventActor.role, [...LIFESPAN_ROLES])))
    .all()) {
    claim(row.characterId, row.role);
  }

  for (const authored of CANON_EVENTS) {
    for (const actor of authored.actors ?? []) claim(actor.characterId, actor.role);
  }

  return owned;
}

/** The bullet text one event stores — the whole bullet, or the sentences it claims. */
function eventDescription(authored: CanonEvent, bullet: CanonBullet): string {
  if (authored.descriptionSentences === undefined) return bullet.text;
  const sentences = bulletSentences(bullet.text);
  // Non-null by construction: `resolveCanonEvents` refuses an out-of-range index.
  return authored.descriptionSentences.map((index) => sentences[index] as string).join(' ');
}

/**
 * Write the events, their actors, their tags and the one `renames` edge, then refresh the
 * lifespan caches the `born` roles just became the authority for.
 *
 * Call inside a transaction — `runSeed` owns it. Every write upserts on a natural key and
 * nothing is deleted; a row that already matches is skipped rather than rewritten, so the
 * second run issues no statement and the file stays byte-identical (§7.4).
 */
export function seedEvents(
  db: Db,
  saveId: string,
  bullets: readonly CanonBullet[],
  tagIdsByName: ReadonlyMap<string, string>,
  tools: CanonDateTools,
): EventSeedResult {
  const { paired, ledger } = resolveCanonEvents(bullets);

  const missingTags = [
    ...new Set(
      CANON_EVENTS.flatMap((authored) => authored.tags).filter((name) => !tagIdsByName.has(name)),
    ),
  ];
  if (missingTags.length > 0) {
    throw new CanonDriftError(
      `seed: the Pre-Big One events tag ${missingTags.length} name(s) the P3.1 vocabulary ` +
        `does not carry: ${missingTags.join(', ')}. Tagging is part of seeding an event, so a ` +
        `missing tag is a missing event, not a missing chip.`,
    );
  }

  const existing = new Map(
    db
      .select()
      .from(event)
      .where(eq(event.saveId, saveId))
      .all()
      .map((row) => [row.id, row] as const),
  );

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  const dates: EventDateReport[] = [];

  for (const { authored, bullet } of paired) {
    const [whenMin, whenMax] = tools.precisionToInterval(
      authored.precision,
      authored.precisionValue,
    );
    // Seeded on the event id — which is why two bullets both dated "2039", and the two
    // halves of the one compound bullet, get different instants, and why none of them
    // moves on a re-seed (P3.3.2).
    const when = tools.rollDate(authored.id, whenMin, whenMax);

    dates.push({
      id: authored.id,
      line: bullet.line,
      sourceDate: authored.sourceDate,
      precision: authored.precision,
      whenMin,
      whenMax,
      when,
    });

    const values = {
      title: authored.title,
      // Verbatim from the Bible, never retyped — sliced by sentence where a compound
      // bullet became two events (F6).
      description: eventDescription(authored, bullet),
      whenMin,
      whenMax,
      whenPrecision: authored.precision,
      when,
      category: authored.category,
      techLane: authored.techLane ?? null,
      locationId: authored.locationId ?? null,
      projectId: authored.projectId ?? null,
      // P3.3.5: no bullet in the slice narrows another's window. See the module header.
      rangeBeforeEventId: null,
      rangeAfterEventId: null,
    };
    const current = existing.get(authored.id);

    if (
      current !== undefined &&
      current.title === values.title &&
      current.description === values.description &&
      current.whenMin === values.whenMin &&
      current.whenMax === values.whenMax &&
      current.whenPrecision === values.whenPrecision &&
      current.when === values.when &&
      current.category === values.category &&
      current.techLane === values.techLane &&
      current.locationId === values.locationId &&
      current.projectId === values.projectId &&
      current.rangeBeforeEventId === values.rangeBeforeEventId &&
      current.rangeAfterEventId === values.rangeAfterEventId
    ) {
      unchanged += 1;
      continue;
    }
    if (current !== undefined) updated += 1;
    else inserted += 1;

    db.insert(event)
      .values({ id: authored.id, saveId, ...values })
      .onConflictDoUpdate({ target: event.id, set: { saveId, ...values } })
      .run();
  }

  const actors = seedEventActors(db, saveId);
  const tags = seedEventTags(db, saveId, tagIdsByName);
  const relations = seedRenameRelation(db, saveId);
  const lifespansRefreshed = refreshLifespanCache(db, saveId);

  return {
    events: { total: CANON_EVENTS.length, inserted, updated, unchanged },
    actors,
    tags,
    relations,
    lifespansRefreshed,
    ledger,
    dates,
  };
}

/**
 * `event_actor`, whose whole row is its primary key — so there is nothing to update and
 * an existing row is simply left in place. Reading the current rows first is what keeps
 * the second run from issuing a statement at all.
 */
function seedEventActors(db: Db, saveId: string): { total: number; inserted: number } {
  const wanted = CANON_EVENTS.flatMap((authored) =>
    (authored.actors ?? []).map((actor) => ({ eventId: authored.id, ...actor })),
  );

  const existing = new Set(
    db
      .select({
        eventId: eventActor.eventId,
        characterId: eventActor.characterId,
        role: eventActor.role,
      })
      .from(eventActor)
      .where(eq(eventActor.saveId, saveId))
      .all()
      .map((row) => `${row.eventId} ${row.characterId} ${row.role}`),
  );

  let inserted = 0;
  for (const row of wanted) {
    if (existing.has(`${row.eventId} ${row.characterId} ${row.role}`)) continue;
    inserted += 1;
    db.insert(eventActor)
      .values({ saveId, eventId: row.eventId, characterId: row.characterId, role: row.role })
      .onConflictDoNothing()
      .run();
  }

  return { total: wanted.length, inserted };
}

/** `event_tag` — the P3.3.4 half of seeding an event, not a later pass. */
function seedEventTags(
  db: Db,
  saveId: string,
  tagIdsByName: ReadonlyMap<string, string>,
): { total: number; inserted: number } {
  const wanted = CANON_EVENTS.flatMap((authored) =>
    // Non-null by construction: `seedEvents` refuses before this point if any name is
    // missing from the vocabulary.
    authored.tags.map((name) => ({
      eventId: authored.id,
      tagId: tagIdsByName.get(name) as string,
    })),
  );

  const existing = new Set(
    db
      .select({ eventId: eventTag.eventId, tagId: eventTag.tagId })
      .from(eventTag)
      .where(eq(eventTag.saveId, saveId))
      .all()
      .map((row) => `${row.eventId} ${row.tagId}`),
  );

  let inserted = 0;
  for (const row of wanted) {
    if (existing.has(`${row.eventId} ${row.tagId}`)) continue;
    inserted += 1;
    db.insert(eventTag)
      .values({ saveId, eventId: row.eventId, tagId: row.tagId })
      .onConflictDoNothing()
      .run();
  }

  return { total: wanted.length, inserted };
}

/** The single `renames` edge described above. */
function seedRenameRelation(
  db: Db,
  saveId: string,
): { total: number; inserted: number; updated: number; unchanged: number } {
  const current = db
    .select()
    .from(relation)
    .where(and(eq(relation.saveId, saveId), eq(relation.id, CANON_RENAME_EDGE.id)))
    .get();

  if (
    current !== undefined &&
    current.fromEventId === CANON_RENAME_EDGE.fromEventId &&
    current.toEventId === CANON_RENAME_EDGE.toEventId &&
    current.type === CANON_RENAME_EDGE.type &&
    current.note === CANON_RENAME_EDGE.note
  ) {
    return { total: 1, inserted: 0, updated: 0, unchanged: 1 };
  }

  const values = {
    saveId,
    fromEventId: CANON_RENAME_EDGE.fromEventId,
    toEventId: CANON_RENAME_EDGE.toEventId,
    type: CANON_RENAME_EDGE.type,
    note: CANON_RENAME_EDGE.note,
  };
  db.insert(relation)
    .values({ id: CANON_RENAME_EDGE.id, ...values })
    .onConflictDoUpdate({ target: relation.id, set: values })
    .run();

  return {
    total: 1,
    inserted: current === undefined ? 1 : 0,
    updated: current === undefined ? 0 : 1,
    unchanged: 0,
  };
}

/**
 * Refresh `character.lifespan_*` from the `born` / `died` events that own it (§2.2).
 *
 * A lifespan bound has ONE authority. Where a linked event exists it is authoritative and
 * the column is a persisted cache of its rolled `when` at the event's own precision — so
 * Family Trees can render a card without a second query, and a re-roll updates the card.
 * Where no such event exists the column is authored in `registry.ts` and this pass never
 * touches it: the partial unique index on `(save_id, character_id, role)` guarantees at
 * most one `born` and one `died` per character, so nothing here can be ambiguous.
 *
 * The other half of "one authority" is `seedCharacters`, which asks
 * {@link eventOwnedLifespanBounds} which columns this function owns and refuses to author
 * one of them (F4). Without that, both writers write and neither wins.
 *
 * @returns how many character rows actually moved. Zero on a re-seed, which is what keeps
 *          the file byte-identical.
 */
export function refreshLifespanCache(db: Db, saveId: string): number {
  const links = db
    .select({
      characterId: eventActor.characterId,
      role: eventActor.role,
      when: event.when,
      precision: event.whenPrecision,
    })
    .from(eventActor)
    .innerJoin(event, and(eq(eventActor.saveId, event.saveId), eq(eventActor.eventId, event.id)))
    .where(and(eq(eventActor.saveId, saveId), inArray(eventActor.role, [...LIFESPAN_ROLES])))
    .all();

  if (links.length === 0) return 0;

  const current = new Map(
    db
      .select({
        id: character.id,
        lifespanStart: character.lifespanStart,
        lifespanStartPrecision: character.lifespanStartPrecision,
        lifespanEnd: character.lifespanEnd,
        lifespanEndPrecision: character.lifespanEndPrecision,
      })
      .from(character)
      .where(eq(character.saveId, saveId))
      .all()
      .map((row) => [row.id, row] as const),
  );

  let refreshed = 0;
  for (const link of links) {
    const row = current.get(link.characterId);
    if (row === undefined) continue;

    if (link.role === 'born') {
      if (row.lifespanStart === link.when && row.lifespanStartPrecision === link.precision)
        continue;
      refreshed += 1;
      db.update(character)
        .set({ lifespanStart: link.when, lifespanStartPrecision: link.precision })
        .where(eq(character.id, link.characterId))
        .run();
    } else {
      if (row.lifespanEnd === link.when && row.lifespanEndPrecision === link.precision) continue;
      refreshed += 1;
      db.update(character)
        .set({ lifespanEnd: link.when, lifespanEndPrecision: link.precision })
        .where(eq(character.id, link.characterId))
        .run();
    }
  }

  return refreshed;
}
