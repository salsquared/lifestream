/**
 * P3.2 — the registry: characters, locations, projects and the family edges between
 * characters (architecture §2.2).
 *
 * Everything here is authored from `data/story_docs/LIFEstream Bible.txt` and carries
 * {@link Citation}s naming the lines it was read off, so a later reader can check a row
 * against canon without re-deriving it. Where a value is an authoring judgement rather
 * than a fact on the page, the comment says so in as many words.
 *
 * ── CITATIONS ARE CHECKED, NOT PROMISED (P3 review F5) ────────────────────────────────
 * They used to be `// L<n>` comments, and about twenty-five of them were wrong — the
 * glossary block consistently off by 14-17 lines, several others by 1-6 — because nothing
 * ever read them. A citation is now `{ of, line, quote }` DATA on the row, and
 * `verifyCitations` checks it at input-resolution time. What it asserts is that the
 * QUOTE is still somewhere in the Bible; `line` is a navigation hint it refreshes and
 * reports, not a claim it enforces (P4B.1). It used to assert the line, and that made a
 * document which merely grew by 28 lines fail all 142 citations at once while every quote
 * was still correct. A wrong citation is still worse than none — it sends a reader to a
 * line that says something else, and the row looks mistranscribed — which is why drift is
 * reported loudly rather than silently tolerated. P5 writes seventy more of these, which
 * is why the affordance had to become real rather than be tidied up once.
 *
 * ── THREE RULES THIS MODULE EXISTS TO KEEP ────────────────────────────────────────────
 *
 * **Renames are an identity chain, not separate places** (P3.2.3, §2.2). One row per
 * NAME, linked by `superseded_by_location_id`, so an event keeps the historically correct
 * name of where it happened while every "what happened here" query resolves to the
 * canonical head first. The chain is acyclic with one successor per row — and that is the
 * whole of the rule. It is NOT linear: canon has two chains converging on Oasis City
 * (`COP Isotope → FOB Oasis → Camp Oasis`, and `Disaster Ridge → Oasis City`, which the
 * glossary calls Oasis City's *fourth* designation — every one of those steps is cited on
 * the row that makes it), so `superseded_by_location_id` deliberately carries no UNIQUE
 * constraint. Do not add one.
 *
 * **A lifespan has one authority** (§2.2). Where a character has a linked `born` / `died`
 * event, that event is authoritative and `lifespan_*` is a persisted derived cache of its
 * rolled `when` — so this module does not author, compare or write those columns at all;
 * `refreshLifespanCache` in `events.ts` fills them from the event. Authoring them here as
 * well would put the same fact in the database twice, and the two would disagree the
 * moment anybody re-rolled the event.
 *
 * WHICH bounds those are is a QUERY, not a list (P3 review F4). It used to be a hand-kept
 * `eventOwnedBounds` array per character, and the first actor row the array did not name
 * put two writers on one column: `seedCharacters` wrote the authored value, then
 * `refreshLifespanCache` wrote the event's, and every run after the first reported
 * "1 updated / refreshed 1" for ever. `eventOwnedLifespanBounds` in `events.ts` derives it
 * from the actual `event_actor` rows, and {@link seedCharacters} REFUSES the run when an
 * authored bound and an event-owned role claim the same column — §2.2's promised
 * write-time disagreement check, which did not exist.
 *
 * **The Adan–X `sibling-of` row does not exist** (P3.2.5, §2.2). Both their parents are
 * modelled, so the edge is derived by the Family Trees layout. Storing it too would
 * assert the same fact twice, and the two copies can then disagree.
 */
import { eq } from 'drizzle-orm';

import { locate } from './citations.js';
import { eventOwnedLifespanBounds } from './events.js';
import { character, characterRelation, location, project } from '../db/schema.js';

import type { Citation, LocatedCitation } from './citations.js';
import type { CanonDateTools } from './dateTools.js';
import type { LifespanBound } from './events.js';
import type { Db } from '../db/index.js';
import type { CharacterRelationType, ProjectStatus, WhenPrecision } from '@shared/types/index';

/** A bound the Bible states, as the precision it states it at plus the value to read. */
export interface AuthoredBound {
  precision: WhenPrecision;
  /** A form `precisionToInterval` accepts — see its table for every shape. */
  value: string;
}

/** Every authored row cites the lines it was read off. See the module header for why. */
interface CanonRow {
  id: string;
  cites: readonly Citation[];
}

/** One authored character. `role` is required by the schema and is free text. */
export interface CanonCharacter extends CanonRow {
  name: string;
  role: string;
  bio: string;
  /**
   * Authored directly — and ONLY legal for a bound no `born`/`died` event owns. A bound
   * that an actor row also claims fails the seed rather than oscillating (§2.2, F4).
   */
  lifespanStart?: AuthoredBound;
  lifespanEnd?: AuthoredBound;
}

/** One authored location. `supersededById` is the rename chain's forward link. */
export interface CanonLocation extends CanonRow {
  name: string;
  description: string;
  /** GLOBAL `country.id` — `'840'` USA, `'380'` Italy. Null for anything off Earth. */
  countryId?: string;
  /** The row that replaced this NAME. Never this row's own id (a CHECK rejects that). */
  supersededById?: string;
}

/** One authored project. Anything with duration is a project, never an event (§2.3). */
export interface CanonProject extends CanonRow {
  name: string;
  description: string;
  dateStart?: AuthoredBound;
  dateEnd?: AuthoredBound;
  status: ProjectStatus;
}

/** One authored character-to-character edge. */
export interface CanonCharacterRelation extends CanonRow {
  fromCharacterId: string;
  toCharacterId: string;
  type: CharacterRelationType;
}

/* ------------------------------------------------------------------ *
 * Characters — P3.2.1, Bible L513-L561
 * ------------------------------------------------------------------ */

/**
 * The fourteen names P3.2.1 lists, in its order.
 *
 * Names are transcribed VERBATIM from the character sheet, curly quotes and all — which
 * is why `Adan Castañeda` carries a tilde and `Xavier “X” Castaneda` does not. That is
 * canon's own inconsistency — both rows cite the line they were read off — and not this
 * module's to silently harmonise.
 */
export const CANON_CHARACTERS: readonly CanonCharacter[] = [
  {
    id: 'char_lazaro',
    name: 'Lazaro Castañeda',
    role: "Adan's and X's father; Marine-Scientific Liaison at COP Isotope, later NovaTech fusion engineer",
    bio:
      'Born to Mexican immigrants and raised in Mojave, California; the eldest of five. Watched the ' +
      'Marines raise Combat Outpost Isotope on the rim of Disaster Ridge and made joining them his ' +
      'goal. Presumed dead in 2072 with the rest of the Enceladus crew. Canon dates his birth twice: ' +
      'the character sheet gives October 12, 2021 while the world timeline gives only the year — ' +
      "the linked birth event owns the column, so the sheet's day is recorded here instead.",
    // Year precision: the card must print "2072". `lifespan_start` is NOT authored — it is
    // owned by `evt_lazaro_born`, which the F4 check derives rather than this row declaring.
    lifespanEnd: { precision: 'year', value: '2072' },
    cites: [
      { of: 'name', line: 584, quote: '* Lazaro Castañeda.' },
      {
        of: 'role (scientific liaison)',
        line: 82,
        quote: 'Lazaro is designated as a scientific liaison',
      },
      {
        of: 'bio (eldest of five, raised in Mojave)',
        line: 91,
        quote: 'He was the oldest of 5 siblings',
      },
      {
        of: "bio (the sheet's day-precision DOB)",
        line: 586,
        quote: 'DOB: October 12, 2021',
      },
      {
        of: "bio (the world timeline's year-only birth)",
        line: 913,
        quote: '2021: Lazaro Castaneda is born in Los Angeles.',
      },
      { of: 'lifespanEnd', line: 587, quote: 'DOD: Presumed Dead (2072)' },
    ],
  },
  {
    id: 'char_ines',
    name: 'Ines de la Encarnación Cardenas',
    role: "Adan's and X's mother; neuroscientist, later a teacher",
    bio:
      "Nine years old when the Big One hit. Took her Master's and Ph.D. in neuroscience at UCLA, " +
      'proving the Black Fever Virus could only reach its full effect in human neural tissue, and left ' +
      'the field in 2056 rather than carry the virus home to her children. Among the last known ' +
      'carriers of Lazy Black Fever. Canon dates her birth twice: March 18, 2025 on the character ' +
      'sheet, year-only in the world timeline — the linked birth event owns the column.',
    // Time precision; the only clock canon gives her. `lifespan_start` is owned by
    // `evt_ines_born` and is therefore not authored here.
    lifespanEnd: { precision: 'time', value: '2076-04-05T19:32Z' },
    cites: [
      { of: 'name', line: 580, quote: 'Ines de la Encarnación Cardenas' },
      {
        of: "bio (the sheet's day-precision DOB)",
        line: 582,
        quote: 'DOB: March 18, 2025',
      },
      {
        of: "bio (the world timeline's year-only birth)",
        line: 914,
        quote: '2025: Ines Cardenas is born in Los Angeles.',
      },
      { of: 'lifespanEnd', line: 583, quote: 'DOD: April 5th, 2076 at 7:32pm' },
    ],
  },
  {
    id: 'char_adan',
    name: 'Adan Castañeda',
    role: "Xavier's older brother; synthesizes drops by hand for X and the GZVA",
    bio:
      'Born in Los Angeles. Researches and hand-synthesizes Neuro-Optic Stabilizer Solution for his ' +
      "brother's PTSD episodes and then for the Ground Zeros Veterans Association, because the " +
      'official supply was never going to be enough.',
    lifespanStart: { precision: 'day', value: '2058-06-05' },
    cites: [
      { of: 'name', line: 547, quote: 'Adan Castañeda' },
      {
        of: 'bio (POB — on the line below; the POB line is verbatim identical under X)',
        line: 548,
        quote: "Xavier's older brother. 25. M.",
      },
      { of: 'lifespanStart', line: 550, quote: 'DOB: June 5th, 2058' },
    ],
  },
  {
    id: 'char_x',
    name: 'Xavier “X” Castaneda',
    role: 'Protagonist; Seki Sports driver in the Helios Racing League',
    bio: 'Born in Los Angeles. Races as "X" for Team Seki Sports on the HRL grid.',
    lifespanStart: { precision: 'day', value: '2062-01-30' },
    cites: [
      { of: 'name', line: 541, quote: 'Xavier "X" Castaneda' },
      {
        of: 'bio (POB — on the line below; the POB line is verbatim identical under Adan)',
        line: 544,
        quote: 'Seki HRLz Team Seki Sports Driver',
      },
      { of: 'lifespanStart', line: 546, quote: 'DOB: Jan 30th, 2062' },
    ],
  },
  {
    id: 'char_min_seo',
    name: 'Han Min-Seo',
    role: "X's girlfriend",
    bio:
      'Born in Unified Korea (former North). Daughter of Han Chol-min, a former North Korean naval ' +
      'officer retained as a token rear admiral in the Unified Korean Navy. Found and saved by Adan ' +
      'and X in 2078 during a theft of biomedical equipment.',
    lifespanStart: { precision: 'day', value: '2060-02-02' },
    cites: [
      { of: 'name', line: 551, quote: 'Han Min-Seo' },
      { of: 'bio (POB)', line: 553, quote: 'POB: Unified Korea (former North)' },
      { of: 'lifespanStart', line: 554, quote: 'DOB: Feb 2nd, 2060' },
      { of: 'bio (her father)', line: 555, quote: 'Father: Han Chol-min' },
    ],
  },
  {
    id: 'char_bruce_deng',
    name: 'Bruce Deng',
    role: 'Fusion physicist',
    bio:
      'Dr. Bruce Deng and his team, working with the Kauai contingent, found a stable confinement ' +
      'method for fusion reactions on October 3rd, 2044 — the D-He³ reactor, and the backbone of ' +
      'fixed industrial power ever since. Canon gives him no dates of his own.',
    cites: [
      {
        of: 'name and the confinement result',
        line: 951,
        quote: 'Dr. Bruce Deng and his team of scientists',
      },
      {
        of: 'bio (the D-He³ reactor, October 3rd 2044)',
        line: 1022,
        quote: "Dr. Bruce Deng's team on October 3rd, 2044",
      },
    ],
  },
  {
    id: 'char_atticus',
    name: 'Atticus Pallas',
    role: 'Antagonist',
    bio:
      'Place and date of birth both recorded as unknown, which is canon rather than a gap in this ' +
      'transcription. Deimos Vane is his clone.',
    cites: [
      { of: 'name', line: 560, quote: '* Atticus Pallas' },
      {
        of: 'bio (POB unknown) — on the line below; the POB line is verbatim identical under Deimos',
        line: 561,
        quote: 'Antagonist. M. Age unknown.',
      },
      { of: 'bio (DOB unknown)', line: 563, quote: 'DOB: Unknown' },
      { of: 'bio (Deimos is his clone)', line: 990, quote: "Deimos Vane, Atticus Pallas's clone" },
    ],
  },
  {
    id: 'char_deimos',
    name: 'Deimos Vane',
    role: 'Antagonist; MEGACORP HRL, Team Phaethon driver',
    bio:
      "Atticus Pallas's clone, created and force-matured to adulthood in 2078. His public record " +
      'falsely backdates his birth to 2058, which is why the character sheet gives both years ' +
      '"2058 (Fiction)/2078 (Reality)". The real year is the one stored.',
    // AUTHORING JUDGEMENT: canon states two birth years and labels one of them a
    // fabrication. The stored bound is the real one; the false record lives in the bio.
    lifespanStart: { precision: 'year', value: '2078' },
    cites: [
      { of: 'name', line: 564, quote: '* Deimos Vane' },
      {
        of: 'lifespanStart and bio (the two years)',
        line: 569,
        quote: 'DOB: 2058 (Fiction)/2078 (Reality)',
      },
      {
        of: 'bio (created and force-matured in 2078)',
        line: 990,
        quote: "Deimos Vane, Atticus Pallas's clone, is created and force-matured to adulthood",
      },
    ],
  },
  {
    id: 'char_dal',
    name: 'Dal',
    role: 'Korean megacorporation — maker of HoloVision and LIFEstream',
    bio:
      'NOT A PERSON. Dal is a company, ruled by the author on 2026-09-05, and the Bible agrees ' +
      'everywhere it names it: "Korean Mega DAL" in the LIFEstream glossary, a megacorporation with ' +
      'a country of origin, a marketing department. P3.2.1 listed it among the fourteen characters ' +
      'and this row exists only because the plan asked for it. It carries no family edges and no ' +
      'dates, so nothing depends on it. The row should go — but the seed cannot delete (§7.4), so ' +
      'removing the authored entry would leave this row behind. See P4B.7.',
    cites: [
      { of: 'name and bio (the megacorporation entry)', line: 672, quote: '* Dal' },
      { of: 'bio (country of origin)', line: 673, quote: 'Country of Origin: Korea' },
      {
        of: 'bio (the marketing department)',
        line: 406,
        quote: "written by Dal's marketing department",
      },
      {
        of: 'bio (the LIFEstream glossary entry)',
        line: 1039,
        quote: 'Product built by Korean Mega DAL',
      },
    ],
  },
  {
    id: 'char_kim_jung_un',
    name: 'Kim Jung Un',
    role: 'Supreme Leader of North Korea',
    bio:
      'Launched a single nuclear missile at South Korea on December 31st, 2041 in an inebriated ' +
      'accident, starting the war that ended his regime. Canon gives him no dates of his own.',
    cites: [
      { of: 'name', line: 656, quote: '* Kim Jung Un' },
      { of: 'role', line: 657, quote: 'Supreme Leader of North Korea' },
      {
        of: 'bio (the accidental launch)',
        line: 926,
        quote: 'December 31st, 2041: Kim Jung Un accidentally sends nuclear missiles',
      },
    ],
  },
  {
    id: 'char_moto',
    name: 'Motoaki “Moto” Nagai',
    role: 'Head of Seki Sports Racing',
    bio: 'Born in Osaka, Japan. Runs the team X drives for.',
    lifespanStart: { precision: 'day', value: '2018-03-14' },
    cites: [
      { of: 'name', line: 556, quote: 'Motoaki "Moto" Nagai' },
      { of: 'role', line: 557, quote: 'Head of Seki Sports Racing' },
      { of: 'bio (POB)', line: 558, quote: 'POB: Osaka, Japan' },
      { of: 'lifespanStart', line: 559, quote: 'DOB: March 14, 2018' },
    ],
  },
  {
    id: 'char_max_lauda',
    name: 'Max Lauda',
    role: 'Traditional motorsport racing legend',
    bio:
      'One of the most exceptional drivers in motorsports history. Died during a public test run ' +
      'of an early commercial p-B¹¹ craft, collapsing the original Helios Racing League before its ' +
      "first season and putting the public's appetite for space to sleep — the league never made " +
      'it past the development stage, and a generation of professionals reasoned that a craft ' +
      'Lauda could not control was not masterable.',
    // AUTHORING JUDGEMENT, REVISED with the 21 June Bible (P4B.4). This row used to say the
    // character sheet left both "DOB" and "DOD" blank, so the death date had to be inferred
    // from the world timeline. The sheet now carries `DOD: 2057` and the timeline carries
    // `Jan 21st, 2057`, so the two AGREE and nothing is being inferred — the timeline is used
    // because it is a day where the sheet is a year, not because the sheet was silent. DOB is
    // still blank, which is why there is no `lifespanStart`.
    //
    // The date itself moved nine years, from 2048-02-07. That is the revision the citation
    // check caught: the old quote was nowhere in the new Bible, and it named this row.
    //
    // P5 transcribes that bullet as an event; the moment it carries a `died` actor row this
    // authored bound becomes ILLEGAL and the seed refuses the run (F4) rather than letting the
    // two writers take turns — so P5's job is to delete this line in the same commit that adds
    // the actor.
    lifespanEnd: { precision: 'day', value: '2057-01-21' },
    cites: [
      { of: 'name', line: 575, quote: '* Max Lauda' },
      {
        of: 'the blank DOB on the character sheet — on the line below',
        line: 576,
        quote: 'Traditional Motorsport Racing Legend',
      },
      {
        of: 'DOD on the character sheet — a year, agreeing with the timeline',
        line: 578,
        quote: 'DOD: 2057',
      },
      {
        of: 'lifespanEnd (read off the world timeline)',
        line: 972,
        quote: 'Jan 21st, 2057: Max Lauda dies during a public test run',
      },
    ],
  },
  {
    id: 'char_rocko',
    name: 'Rocko',
    role: 'Chihuahua Therodolon in a large automata body',
    bio:
      "Formerly a chronically ill senior chihuahua; the brothers' first successful brain clone and " +
      'the proof-of-concept for X\'s surgery. Loud, yappy, confrontational — "old couch king" turned ' +
      'all-bark-all-bite.',
    cites: [
      { of: 'name', line: 571, quote: '* Rocko' },
      { of: 'role and bio', line: 572, quote: 'Chihuahua Therodolon in a large automata body' },
    ],
  },
  {
    id: 'char_laika',
    name: 'Laika',
    role: 'Greyhound Therodolon in a large automata body',
    bio: 'An old ex-race dog and the second (final) successful clone. Quick, agile, determined.',
    cites: [
      { of: 'name', line: 573, quote: '* Laika' },
      { of: 'role and bio', line: 574, quote: 'Greyhound Therodolon in a large automata body' },
    ],
  },
];

/* ------------------------------------------------------------------ *
 * Locations — P3.2.2 + P3.2.3, Bible L73-L81, L860-L885, L975-L1048
 * ------------------------------------------------------------------ */

/**
 * Nineteen rows: P3.2.2's twelve entries — two of which ("Mojave / New Mojave",
 * "LA / Neo LA") are themselves two-stage rename chains and so become two rows each —
 * plus P3.2.3's five-stage Disaster Ridge chain. 12 + 2 + 5 = 19.
 *
 * ORDER IS LOad-BEARING. `(save_id, superseded_by_location_id)` is a real composite
 * foreign key back into this table and SQLite checks it immediately, so every row is
 * written after the row it points at: heads first, then backwards down each chain.
 */
export const CANON_LOCATIONS: readonly CanonLocation[] = [
  // ---- the Disaster Ridge site, head first (P3.2.3).
  {
    id: 'loc_star_city',
    name: 'Star City',
    description:
      'Final designation of the Disaster Ridge site, adopted after MEGACORP assumed full control of ' +
      'the region on the completion of Earth Tower 1 in 2066. The global aerospace and economic ' +
      'epicenter, home to the ring of 120 fusion reactors powering the Space Fountain section.',
    countryId: '840',
    cites: [
      { of: 'name', line: 981, quote: 'Oasis City is renamed Star City' },
      {
        of: 'description',
        line: 1070,
        quote: 'Star City: Final designation of the Disaster Ridge site',
      },
    ],
  },
  {
    id: 'loc_oasis_city',
    name: 'Oasis City',
    description:
      'Fourth designation of the Disaster Ridge site, following Camp Oasis. Established in 2051 after ' +
      'the military designation was dropped and NovaTech bought the rights to the region from the US ' +
      'government, turning it into a civilian industrial and corporate hub.',
    countryId: '840',
    supersededById: 'loc_star_city',
    cites: [
      {
        of: 'name and description',
        line: 1055,
        quote: 'Oasis City: Fourth designation of the Disaster Ridge site',
      },
      {
        of: 'supersededById (renamed Star City in 2066)',
        line: 981,
        quote: 'Oasis City is renamed Star City',
      },
    ],
  },
  {
    id: 'loc_camp_oasis',
    name: 'Camp Oasis',
    description:
      'Third designation of the Disaster Ridge installation, following FOB Oasis. Marks the transition ' +
      'from a temporary forward operating base to a permanent fortified garrison, with housing on the ' +
      'flattened bottom level of the Ridge.',
    countryId: '840',
    supersededById: 'loc_oasis_city',
    cites: [
      {
        of: 'name and description',
        line: 1013,
        quote: 'Camp Oasis: Third designation of the Disaster Ridge',
      },
      {
        of: 'supersededById (incorporated as Oasis City in 2051)',
        line: 963,
        quote: 'Disaster Ridge is incorporated as a city under the new name Oasis City',
      },
    ],
  },
  {
    id: 'loc_fob_oasis',
    name: 'FOB Oasis',
    description:
      'Second designation of the Disaster Ridge installation, following Combat Outpost Isotope. ' +
      'Established as extraction operations scaled and the site required broader logistical ' +
      'infrastructure; the first elevator connecting Top Ridge and Bottom Ridge was built in this phase.',
    countryId: '840',
    supersededById: 'loc_camp_oasis',
    cites: [
      {
        of: 'name and description',
        line: 1031,
        quote: 'FOB Oasis: Second designation of the Disaster Ridge',
      },
      {
        of: 'description (the first elevator)',
        line: 83,
        quote: 'For the first time there is an elevator built',
      },
      {
        of: 'supersededById (redesignated Camp Oasis in 2039)',
        line: 923,
        quote: 'FOB Oasis is redesignated Camp Oasis',
      },
    ],
  },
  {
    id: 'loc_cop_isotope',
    name: 'COP Isotope',
    description:
      'Original name of the Marine outpost at Disaster Ridge, established once the initial ' +
      'science-personnel survey confirmed massive Lithium-6 deposits. Austere, and focused entirely on ' +
      'securing and surveying the site. Civilians took to calling it Camp Disaster.',
    countryId: '840',
    supersededById: 'loc_fob_oasis',
    cites: [
      { of: 'name', line: 82, quote: 'Combat Outpost Isotope, or' },
      {
        of: 'description',
        line: 1017,
        quote: 'Combat Outpost Isotope (COPI): Original name given to the marine outpost',
      },
      {
        of: 'supersededById (redesignated FOB Oasis in late 2035)',
        line: 919,
        quote: 'COP Isotope is redesignated Forward Operating Base Oasis',
      },
    ],
  },
  {
    id: 'loc_disaster_ridge',
    name: 'Disaster Ridge',
    description:
      'The massive geological chasm opened along the San Andreas Fault near Mojave, California by the ' +
      'Big One in 2034, later found to hold extraordinary Lithium-6 deposits capable of breeding ' +
      'Helium-3. Named by the people of Mojave. Site of Earth Tower 1.',
    countryId: '840',
    // The MERGE the schema exists to permit: this chain and the COP Isotope chain converge
    // on one head — the 2051 incorporation, which the glossary calls the site's FOURTH
    // designation. Both lines are cited below.
    supersededById: 'loc_oasis_city',
    cites: [
      { of: 'name', line: 916, quote: 'the chasm opened above it known as "Disaster Ridge."' },
      {
        of: 'description',
        line: 1025,
        quote: 'Disaster Ridge: The massive geological chasm opened along the San Andreas Fault',
      },
      {
        of: 'description (named by the people of Mojave)',
        line: 95,
        quote: 'it was given by the people of Mojave as Disaster Ridge',
      },
      {
        of: 'supersededById (the chain merge, 2051)',
        line: 963,
        quote: 'Disaster Ridge is incorporated as a city under the new name Oasis City',
      },
      {
        of: 'supersededById (Oasis City is the FOURTH designation)',
        line: 1055,
        quote: 'Oasis City: Fourth designation',
      },
    ],
  },

  // ---- Mojave, head first.
  {
    id: 'loc_new_mojave',
    name: 'New Mojave',
    description:
      'The rebuilt Mojave, raised after the Big One levelled the original town. Used whenever canon ' +
      'compares what used to be with what is.',
    countryId: '840',
    cites: [
      { of: 'name', line: 893, quote: '* New Mojave' },
      { of: 'description', line: 894, quote: 'Rebuilt version of Mojave' },
    ],
  },
  {
    id: 'loc_mojave',
    name: 'Mojave',
    description:
      "The original town of Mojave, in Death Valley — Lazaro's home when the Big One destroyed it, " +
      'and the town whose residents named Disaster Ridge.',
    countryId: '840',
    supersededById: 'loc_new_mojave',
    cites: [
      { of: 'name', line: 891, quote: '* Mojave' },
      { of: 'description', line: 892, quote: 'The original town of Mojave in Death Valley' },
    ],
  },

  // ---- Los Angeles, head first.
  {
    id: 'loc_neo_los_angeles',
    name: 'Neo Los Angeles',
    description:
      'The name of Los Angeles after the Big One. First city imbued with a passion for reconstruction, ' +
      'and the site of the first-generation Megablocks.',
    countryId: '840',
    cites: [
      { of: 'name', line: 889, quote: '* Neo Los Angeles' },
      { of: 'description', line: 890, quote: 'Name of Los Angeles after the Big One' },
    ],
  },
  {
    id: 'loc_los_angeles',
    name: 'Los Angeles',
    description:
      'Los Angeles before the Big One: suburban sprawl as far as the eye could see, cut through by a ' +
      'highway network and taxiing aircraft.',
    countryId: '840',
    supersededById: 'loc_neo_los_angeles',
    cites: [
      { of: 'name', line: 447, quote: 'Los Angeles in the early 2030s' },
      { of: 'description', line: 888, quote: 'Los Angeles before the Big One' },
    ],
  },

  // ---- the rest of P3.2.2, in its order.
  {
    id: 'loc_gran_sasso',
    name: 'Gran Sasso National Laboratory (LNGS)',
    description:
      "The Italian contingency's underground Project Xero lab in Abruzzo. Where the neucomp was " +
      'integrated into a working signal processor in early 2044, and where the first viable Black ' +
      'Fever vaccine was brute-forced on March 29th, 2045.',
    countryId: '380',
    cites: [
      { of: 'name', line: 206, quote: 'Gran Sasso National Laboratory (LNGS), Abruzzo' },
      { of: 'description (the 2045 vaccine)', line: 952, quote: 'Mar 29th, 2045' },
    ],
  },
  {
    id: 'loc_kauai_lab',
    name: 'Pacific Missile Range Facility, Kauai',
    description:
      'Underground Project Xero lab housing biologists, virologists and chemists running Black Fever ' +
      'transmission research and Pacific quarantine coordination, and the central coordination point ' +
      'for the antibody trials across every UEA member lab.',
    countryId: '840',
    cites: [
      { of: 'name', line: 177, quote: 'Pacific Missile Range Facility, Kauai, Hawaii' },
      {
        of: 'description',
        line: 178,
        quote: 'Housed biologists, virologists, and chemists running BFV transmission research',
      },
    ],
  },
  {
    id: 'loc_hoover_dam',
    name: 'Hoover Dam',
    description:
      'Repaired after structural damage from the Big One, seized by the US military in early 2042 and ' +
      'its hydroelectric output redirected entirely to the underground lab network — the stopgap that ' +
      'bought Project Xero the runway it needed.',
    countryId: '840',
    cites: [{ of: 'name', line: 186, quote: 'Hoover Dam, Nevada/Arizona Border' }],
  },
  {
    id: 'loc_et1',
    name: 'Earth Tower 1',
    description:
      'The first and only Terra-scale construction project in human history. A hybrid Space Fountain ' +
      'and Space Tether elevator built atop Disaster Ridge, reaching 2,000km on active magnetic ' +
      'support before transitioning to a passive tether at 36,000km. Opened August 1st, 2066.',
    countryId: '840',
    cites: [
      {
        of: 'name',
        line: 360,
        quote: "Earth Tower 1 isn't a space elevator in the traditional sense",
      },
      {
        of: 'description',
        line: 1028,
        quote:
          'Earth Tower 1 (ET1): The first and only Terra-scale construction project in human history',
      },
      { of: 'description (opening date)', line: 980, quote: 'Aug 1st, 2066: Earth Tower 1 opens' },
    ],
  },
  {
    id: 'loc_port_charon',
    name: 'Port Charon',
    description:
      "Industrial logistics city at the top of Earth Tower 1's Space Fountain section, 2,000km above " +
      'Star City. The transshipment hub where earth-bound freight meets the deep-space cargo arriving ' +
      'on the lunar highway in the sky — a working-class port named by its workers.',
    cites: [
      {
        of: 'name',
        line: 1057,
        quote: 'Port Charon: Industrial logistics city built at the top of Earth Tower 1',
      },
      {
        of: 'description',
        line: 899,
        quote: '* Industrial logistics city built at the top of Earth Tower 1',
      },
    ],
  },
  {
    id: 'loc_atlas',
    name: 'Atlas',
    description:
      "The counterweight at the top of Earth Tower 1's Space Tether at geostationary orbit, 36,000km " +
      'up. A compacted heap of Processed Regolith from the Moon, held in place by orbital tension.',
    cites: [
      { of: 'name', line: 1005, quote: 'Atlas: The counterweight at the top of Earth Tower 1' },
      {
        of: 'description',
        line: 901,
        quote:
          "The counterweight at the top of Earth Tower 1's Space Tether at geostationary orbit",
      },
    ],
  },
  {
    id: 'loc_erebus',
    name: 'Erebus',
    description:
      'The deep-space region surrounding Atlas at geostationary altitude. Hosts the Tartarus Run ' +
      "circuit, carved from leftover Processed Regolith from Atlas's construction.",
    cites: [
      { of: 'name', line: 1030, quote: 'Erebus: The deep-space region surrounding Atlas' },
      {
        of: 'description',
        line: 903,
        quote:
          'The deep-space region surrounding Atlas at geostationary altitude. Named for the Greek primordial darkness',
      },
    ],
  },
  {
    id: 'loc_etna',
    name: 'Etna',
    description:
      'First asteroid target for MEGACORP, in Project Athena. Near edge of the asteroid belt. Reached ' +
      'by the Enceladus in 2071; the crew was presumed dead there in 2072.',
    cites: [
      { of: 'name', line: 905, quote: '* Etna' },
      {
        of: 'description',
        line: 906,
        quote: 'First asteroid target for MEGACORP in Project Athena',
      },
      { of: 'description (near edge)', line: 907, quote: 'Location: Near edge of Asteroid Belt' },
    ],
  },
  {
    id: 'loc_chrysus',
    name: 'Chrysus',
    description:
      'Second asteroid target for MEGACORP, in Project Aurum. Far edge of the asteroid belt.',
    cites: [
      { of: 'name', line: 908, quote: '* Chrysus' },
      {
        of: 'description',
        line: 909,
        quote: 'Second asteroid target for MEGACORP in Project Aurum',
      },
      { of: 'description (far edge)', line: 910, quote: 'Location: Far edge of Asteroid Belt' },
    ],
  },
];

/* ------------------------------------------------------------------ *
 * Projects — P3.2.4, Bible L791-L826
 * ------------------------------------------------------------------ */

/**
 * The five programmes. A project is where DURATION lives — an event is a point (§2.3) —
 * so each bound is authored at the precision canon states it at: `~Jan 2042` is a month,
 * `Expected 2086` is a year, and the card renders by that precision rather than printing
 * the instant stored beside it.
 *
 * `lead_character_id` is null on all five: canon names no lead for any of them, and
 * inventing one would put an authored-looking fact in the registry.
 */
export const CANON_PROJECTS: readonly CanonProject[] = [
  {
    id: 'proj_nspd_51a',
    name: 'NSPD-51A',
    description:
      'National Security Presidential Directive 51-Alpha. The amended Directive 51 that replaced the ' +
      'traditional continuity-of-government structure with a streamlined scientific congress of 435 ' +
      'researcher-representatives empowered to decide alongside the President. The blueprint of ' +
      'United Earth governance.',
    dateStart: { precision: 'month', value: '2042-01' },
    dateEnd: { precision: 'month', value: '2047-05' },
    status: 'succeeded',
    cites: [
      {
        of: 'name',
        line: 159,
        quote:
          'The plan, designated as National Security Presidential Directive 51-Alpha (NSPD-51A)',
      },
      {
        of: 'description',
        line: 1054,
        quote: 'NSPD-51A: National Security Presidential Directive 51-Alpha',
      },
      { of: 'dateStart', line: 820, quote: 'Start: ~Jan 2042' },
      { of: 'dateEnd', line: 821, quote: 'End: May, 2047' },
    ],
  },
  {
    id: 'proj_xero',
    name: 'Project Xero',
    description:
      "The United Earth Alliance's operation to cure and eradicate the Black Fever Virus at global " +
      'scale — the single most important operation in human history. Ran the Xero Network of ' +
      'underground labs, and produced the neucomp as a side effect of its own data load.',
    dateStart: { precision: 'month', value: '2042-05' },
    dateEnd: { precision: 'month', value: '2047-06' },
    status: 'succeeded',
    cites: [
      { of: 'name', line: 823, quote: 'Project Xero (Zero)' },
      {
        of: 'description',
        line: 1062,
        quote: 'Project Xero: The single most important operation in human history',
      },
      { of: 'dateStart', line: 826, quote: 'Start: May, 2042' },
      { of: 'dateEnd', line: 827, quote: 'End: June, 2047' },
    ],
  },
  {
    id: 'proj_athena',
    name: 'Project Athena',
    description:
      "MEGACORP's mission to mine asteroid Etna at the near edge of the asteroid belt and return rare " +
      'earth minerals to Earth. Called Project Nero by people who expected its haul to tank the ' +
      'materials markets — a joke that landed differently once the crew was presumed dead.',
    // AUTHORING JUDGEMENT: canon's timeline for Athena lists an ANNOUNCEMENT rather than a
    // start. The announcement is the earliest dated point of the programme, so it is what
    // `date_start` carries; the milestones in between (crew selected Nov 2063, departure
    // 2070) are events, not bounds.
    dateStart: { precision: 'day', value: '2060-02-05' },
    dateEnd: { precision: 'year', value: '2072' },
    status: 'failed',
    cites: [
      { of: 'name', line: 521, quote: 'Project Athena and the Etna Incident' },
      {
        of: 'description',
        line: 1060,
        quote: "Project Athena: MEGACORP's mission to mine asteroid Etna",
      },
      {
        of: 'description (the Project Nero joke)',
        line: 831,
        quote: 'people took to calling it Project Nero',
      },
      { of: 'dateStart (announcement, not a start)', line: 833, quote: 'Announced: Feb 5th, 2060' },
      { of: 'dateEnd', line: 836, quote: 'End: 2072 (Crew presumed dead)' },
    ],
  },
  {
    id: 'proj_aurum',
    name: 'Project Aurum',
    description:
      "MEGACORP's second asteroid mining mission, targeting asteroid Chrysus at the far edge of the " +
      'belt. Set in place before Athena failed. Called Project Midas by the opposition that formed ' +
      'once people understood what the first haul would do to the economy.',
    dateStart: { precision: 'year', value: '2076' },
    dateEnd: { precision: 'year', value: '2086' },
    // AUTHORING JUDGEMENT: the Chrysus departed in October 2082 and is expected back in
    // 2086, and the story's present is 2084 — so the programme is running, not finished.
    status: 'active',
    cites: [
      {
        of: 'name',
        line: 988,
        quote: 'Work on a successor to Project Athena, Project Aurum, begins',
      },
      {
        of: 'description',
        line: 1061,
        quote: "Project Aurum: MEGACORP's second asteroid mining mission",
      },
      { of: 'description (the Project Midas joke)', line: 840, quote: 'Project Midas' },
      { of: 'dateStart', line: 842, quote: 'Start: 2076' },
      { of: 'dateEnd', line: 843, quote: 'End: Expected 2086' },
      {
        of: 'status (the Chrysus departed 2082)',
        line: 995,
        quote: 'October 18th, 2082: The Chrysus, of Project Aurum, departs',
      },
      { of: "status (the story's present is 2084)", line: 997, quote: 'April 25, 2084' },
    ],
  },
  {
    id: 'proj_afterlife',
    name: 'Project Afterlife',
    description:
      'A secret programme run alongside cure development inside Project Xero, hidden from the public ' +
      'and from most Xero personnel. Its stated goal was neucomp hosts capable of sustaining a full ' +
      'human Eidolon; its real function was political — the promise the US President used to buy the ' +
      "future Megacorp owners' consent to the great mergers.",
    // AUTHORING JUDGEMENT: canon dates the START as a RANGE — "alongside cure development
    // (~2042-2045), in secret" — which `date_start` (one instant plus one precision) cannot
    // express. The earlier end of that range is stored at year precision. There is no stated
    // end: the programme becomes the commercial Afterlife Program under Cognis on no given
    // date, so `date_end` stays null rather than acquiring an invented one.
    dateStart: { precision: 'year', value: '2042' },
    status: 'succeeded',
    cites: [
      { of: 'name', line: 1003, quote: 'The commercial successor to Project Afterlife' },
      {
        of: 'description',
        line: 1059,
        quote: 'Project Afterlife: A covert effort, run inside Project Xero',
      },
      {
        of: 'dateStart (a range, not an instant)',
        line: 850,
        quote: 'Start: alongside cure development',
      },
      {
        of: 'the absent dateEnd',
        line: 851,
        quote: 'Becomes the commercial Afterlife Program under Cognis',
      },
    ],
  },
];

/* ------------------------------------------------------------------ *
 * Family relations — P3.2.5, Bible L38, L554-L561, L963
 * ------------------------------------------------------------------ */

/**
 * Six edges, and the seventh deliberately absent.
 *
 * `parent-of` and `clone-of` are DIRECTIONAL and read from→to literally, with `from` as
 * the progenitor in both: "Lazaro parent-of Adan", "Atticus clone-of Deimos". `spouse-of`
 * is SYMMETRIC and stored once with the lower id as `from` — `char_ines` < `char_lazaro`
 * — which the schema enforces with a CHECK rather than trusting to convention.
 *
 * There is NO Adan–X `sibling-of` row (P3.2.5). Both parents are modelled, so the sibling
 * edge is derived by the Family Trees layout; storing it as well would assert the same
 * fact twice.
 */
export const CANON_CHARACTER_RELATIONS: readonly CanonCharacterRelation[] = [
  // Symmetric: lower id first.
  {
    id: 'crel_ines_lazaro_spouse',
    fromCharacterId: 'char_ines',
    toCharacterId: 'char_lazaro',
    type: 'spouse-of',
    cites: [{ of: 'the marriage', line: 973, quote: '2057: Lazaro and Ines get married' }],
  },
  {
    id: 'crel_lazaro_adan_parent',
    fromCharacterId: 'char_lazaro',
    toCharacterId: 'char_adan',
    type: 'parent-of',
    cites: [
      { of: 'Lazaro as father', line: 585, quote: "Adan's and X's Father" },
      { of: "Adan's birth", line: 975, quote: "June 5th, 2058: Adan, X's older brother, is born" },
    ],
  },
  {
    id: 'crel_lazaro_x_parent',
    fromCharacterId: 'char_lazaro',
    toCharacterId: 'char_x',
    type: 'parent-of',
    cites: [
      { of: 'Lazaro as father', line: 585, quote: "Adan's and X's Father" },
      {
        of: 'both births',
        line: 45,
        quote: 'Adan and X would be born in 2058 and 2062 respectively',
      },
    ],
  },
  {
    id: 'crel_ines_adan_parent',
    fromCharacterId: 'char_ines',
    toCharacterId: 'char_adan',
    type: 'parent-of',
    cites: [{ of: 'Ines as mother', line: 581, quote: "Adan's and X's Mother" }],
  },
  {
    id: 'crel_ines_x_parent',
    fromCharacterId: 'char_ines',
    toCharacterId: 'char_x',
    type: 'parent-of',
    cites: [
      { of: 'Ines as mother', line: 581, quote: "Adan's and X's Mother" },
      { of: "X's birth", line: 977, quote: 'Jan 30th, 2062: X is born' },
    ],
  },
  // AUTHORING JUDGEMENT ON DIRECTION. P3.2.5 writes this edge "Atticus clone-of Deimos",
  // and canon says the opposite of what that reads as in English — the cited line has
  // Deimos as the clone. Both are satisfied by reading `clone-of` the way `parent-of`
  // reads — `from` is the progenitor — which is also the only reading under which the
  // plan's own phrasing and canon agree. So: from = the original, to = the clone.
  {
    id: 'crel_atticus_deimos_clone',
    fromCharacterId: 'char_atticus',
    toCharacterId: 'char_deimos',
    type: 'clone-of',
    cites: [{ of: 'the direction', line: 990, quote: "Deimos Vane, Atticus Pallas's clone" }],
  },
];

/* ------------------------------------------------------------------ *
 * Citations
 * ------------------------------------------------------------------ */

/**
 * The sections these rows were read out of. Cited like anything else, because "the
 * character sheet is at L513" is exactly the kind of claim that silently stops being true.
 */
const SECTION_CITATIONS: readonly Citation[] = [
  { of: 'the character sheet', line: 540, quote: 'Main Characters' },
  { of: 'the locations section', line: 897, quote: 'Orbital Locations' },
  { of: 'the Disaster Ridge site history', line: 81, quote: 'Evolution of Disaster Ridge Site' },
  { of: 'the projects section', line: 823, quote: 'Project Xero (Zero)' },
  { of: 'the glossary', line: 1002, quote: 'Glossary' },
];

/** Every Bible line this module cites, flattened for `verifyCitations`. */
export const CANON_REGISTRY_CITATIONS: readonly LocatedCitation[] = [
  ...locate('registry.ts', SECTION_CITATIONS),
  ...CANON_CHARACTERS.flatMap((row) => locate(`registry.ts ${row.id}`, row.cites)),
  ...CANON_LOCATIONS.flatMap((row) => locate(`registry.ts ${row.id}`, row.cites)),
  ...CANON_PROJECTS.flatMap((row) => locate(`registry.ts ${row.id}`, row.cites)),
  ...CANON_CHARACTER_RELATIONS.flatMap((row) => locate(`registry.ts ${row.id}`, row.cites)),
];

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

/** Two writers claiming one lifespan column. Rolls the transaction back (§2.2, F4). */
export class LifespanAuthorityError extends Error {
  override name = 'LifespanAuthorityError';
}

/** What one registry seed did, per table. */
export interface RegistryTableResult {
  total: number;
  inserted: number;
  updated: number;
  unchanged: number;
}

/** What one registry seed did. */
export interface RegistrySeedResult {
  characters: RegistryTableResult;
  locations: RegistryTableResult;
  projects: RegistryTableResult;
  characterRelations: RegistryTableResult;
}

/** A start bound takes its interval's lower edge; an end bound takes the upper. */
const boundInstant = (
  tools: CanonDateTools,
  bound: AuthoredBound | undefined,
  edge: 'start' | 'end',
): string | null => {
  if (bound === undefined) return null;
  const [min, max] = tools.precisionToInterval(bound.precision, bound.value);
  return edge === 'start' ? min : max;
};

/** The precision beside a bound — null together with it, which a paired CHECK enforces. */
const boundPrecision = (bound: AuthoredBound | undefined): WhenPrecision | null =>
  bound?.precision ?? null;

/**
 * Seed characters, locations, projects and family edges for one save.
 *
 * Call inside a transaction — `runSeed` owns it. Everything upserts on its id and nothing
 * is deleted, so re-running is a no-op and rows the plan no longer names are left alone
 * (§7.4). A row that already matches is SKIPPED rather than rewritten, which is what keeps
 * the second run from dirtying a page it had nothing to say about.
 */
export function seedRegistry(db: Db, saveId: string, tools: CanonDateTools): RegistrySeedResult {
  return {
    characters: seedCharacters(db, saveId, tools),
    locations: seedLocations(db, saveId),
    projects: seedProjects(db, saveId, tools),
    // Last: both endpoints of every edge are a composite FK into `character`.
    characterRelations: seedCharacterRelations(db, saveId),
  };
}

/**
 * Characters — and the one place §2.2's "a lifespan has one authority" is enforced rather
 * than described (P3 review F4).
 *
 * Which bounds an event owns is DERIVED from the actor rows, so an actor row added in P5
 * takes the column over automatically and no list has to be kept in step. The authored
 * bound beside it does not lose quietly: it is a CONTRADICTION — two sources for one fact
 * — and the seed refuses the run rather than letting `seedCharacters` and
 * `refreshLifespanCache` overwrite each other on alternate runs for ever.
 */
function seedCharacters(db: Db, saveId: string, tools: CanonDateTools): RegistryTableResult {
  const existing = new Map(
    db
      .select()
      .from(character)
      .where(eq(character.saveId, saveId))
      .all()
      .map((row) => [row.id, row] as const),
  );

  const eventOwned = eventOwnedLifespanBounds(db, saveId);
  const noAuthority = new Set<LifespanBound>();

  const conflicts = CANON_CHARACTERS.flatMap((authored) => {
    const owned = eventOwned.get(authored.id) ?? noAuthority;
    const clashes: string[] = [];
    if (owned.has('start') && authored.lifespanStart !== undefined) {
      clashes.push(
        `${authored.id}: lifespanStart is authored here (${authored.lifespanStart.precision} ` +
          `"${authored.lifespanStart.value}") AND owned by a \`born\` event_actor row`,
      );
    }
    if (owned.has('end') && authored.lifespanEnd !== undefined) {
      clashes.push(
        `${authored.id}: lifespanEnd is authored here (${authored.lifespanEnd.precision} ` +
          `"${authored.lifespanEnd.value}") AND owned by a \`died\` event_actor row`,
      );
    }
    return clashes;
  });

  if (conflicts.length > 0) {
    throw new LifespanAuthorityError(
      `seed: ${conflicts.length} lifespan bound(s) have two authorities (§2.2):\n  ` +
        conflicts.join('\n  ') +
        `\n  The event wins — it is the one that can be re-rolled. Delete the authored bound ` +
        `from registry.ts in the same change that adds the actor row. Left as it is, ` +
        `seedCharacters and refreshLifespanCache would take turns rewriting the column and ` +
        `every run after the first would report "1 updated / refreshed 1" for ever.`,
    );
  }

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  for (const authored of CANON_CHARACTERS) {
    const owned = eventOwned.get(authored.id) ?? noAuthority;
    const lifespanStart = owned.has('start')
      ? null
      : boundInstant(tools, authored.lifespanStart, 'start');
    const lifespanStartPrecision = owned.has('start')
      ? null
      : boundPrecision(authored.lifespanStart);
    const lifespanEnd = owned.has('end') ? null : boundInstant(tools, authored.lifespanEnd, 'end');
    const lifespanEndPrecision = owned.has('end') ? null : boundPrecision(authored.lifespanEnd);

    const current = existing.get(authored.id);
    // A bound a `born`/`died` event owns is compared by nobody here: `refreshLifespanCache`
    // writes it from the event, and comparing it would make every run see a difference and
    // rewrite the row (§2.2).
    const matches =
      current !== undefined &&
      current.name === authored.name &&
      current.role === authored.role &&
      current.bio === authored.bio &&
      (owned.has('start') ||
        (current.lifespanStart === lifespanStart &&
          current.lifespanStartPrecision === lifespanStartPrecision)) &&
      (owned.has('end') ||
        (current.lifespanEnd === lifespanEnd &&
          current.lifespanEndPrecision === lifespanEndPrecision));

    if (matches) {
      unchanged += 1;
      continue;
    }
    if (current !== undefined) updated += 1;
    else inserted += 1;

    // Only the columns this module owns go in the update set — an event-owned bound is
    // left exactly as `refreshLifespanCache` last wrote it.
    const set: Record<string, unknown> = {
      saveId,
      name: authored.name,
      role: authored.role,
      bio: authored.bio,
    };
    if (!owned.has('start')) {
      set['lifespanStart'] = lifespanStart;
      set['lifespanStartPrecision'] = lifespanStartPrecision;
    }
    if (!owned.has('end')) {
      set['lifespanEnd'] = lifespanEnd;
      set['lifespanEndPrecision'] = lifespanEndPrecision;
    }

    db.insert(character)
      .values({
        id: authored.id,
        saveId,
        name: authored.name,
        role: authored.role,
        bio: authored.bio,
        lifespanStart,
        lifespanStartPrecision,
        lifespanEnd,
        lifespanEndPrecision,
      })
      .onConflictDoUpdate({ target: character.id, set })
      .run();
  }

  return { total: CANON_CHARACTERS.length, inserted, updated, unchanged };
}

function seedLocations(db: Db, saveId: string): RegistryTableResult {
  const existing = new Map(
    db
      .select()
      .from(location)
      .where(eq(location.saveId, saveId))
      .all()
      .map((row) => [row.id, row] as const),
  );

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  // In authored order, which is head-first down each rename chain: the composite FK
  // `(save_id, superseded_by_location_id)` is checked as each row lands.
  for (const authored of CANON_LOCATIONS) {
    const countryId = authored.countryId ?? null;
    const supersededByLocationId = authored.supersededById ?? null;
    const current = existing.get(authored.id);

    if (
      current !== undefined &&
      current.name === authored.name &&
      current.description === authored.description &&
      current.countryId === countryId &&
      current.supersededByLocationId === supersededByLocationId
    ) {
      unchanged += 1;
      continue;
    }
    if (current !== undefined) updated += 1;
    else inserted += 1;

    db.insert(location)
      .values({
        id: authored.id,
        saveId,
        name: authored.name,
        description: authored.description,
        countryId,
        supersededByLocationId,
      })
      .onConflictDoUpdate({
        target: location.id,
        set: {
          saveId,
          name: authored.name,
          description: authored.description,
          countryId,
          supersededByLocationId,
        },
      })
      .run();
  }

  return { total: CANON_LOCATIONS.length, inserted, updated, unchanged };
}

function seedProjects(db: Db, saveId: string, tools: CanonDateTools): RegistryTableResult {
  const existing = new Map(
    db
      .select()
      .from(project)
      .where(eq(project.saveId, saveId))
      .all()
      .map((row) => [row.id, row] as const),
  );

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  for (const authored of CANON_PROJECTS) {
    const values = {
      name: authored.name,
      description: authored.description,
      dateStart: boundInstant(tools, authored.dateStart, 'start'),
      dateStartPrecision: boundPrecision(authored.dateStart),
      dateEnd: boundInstant(tools, authored.dateEnd, 'end'),
      dateEndPrecision: boundPrecision(authored.dateEnd),
      status: authored.status,
    };
    const current = existing.get(authored.id);

    if (
      current !== undefined &&
      current.name === values.name &&
      current.description === values.description &&
      current.dateStart === values.dateStart &&
      current.dateStartPrecision === values.dateStartPrecision &&
      current.dateEnd === values.dateEnd &&
      current.dateEndPrecision === values.dateEndPrecision &&
      current.status === values.status
    ) {
      unchanged += 1;
      continue;
    }
    if (current !== undefined) updated += 1;
    else inserted += 1;

    db.insert(project)
      .values({ id: authored.id, saveId, ...values })
      // `lead_character_id` is app-editable and is deliberately not in the update set —
      // the same rule that keeps `save.parent_save_id` out of `seedMapSave`'s.
      .onConflictDoUpdate({ target: project.id, set: { saveId, ...values } })
      .run();
  }

  return { total: CANON_PROJECTS.length, inserted, updated, unchanged };
}

function seedCharacterRelations(db: Db, saveId: string): RegistryTableResult {
  const existing = new Map(
    db
      .select()
      .from(characterRelation)
      .where(eq(characterRelation.saveId, saveId))
      .all()
      .map((row) => [row.id, row] as const),
  );

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  for (const authored of CANON_CHARACTER_RELATIONS) {
    const current = existing.get(authored.id);

    if (
      current !== undefined &&
      current.fromCharacterId === authored.fromCharacterId &&
      current.toCharacterId === authored.toCharacterId &&
      current.type === authored.type
    ) {
      unchanged += 1;
      continue;
    }
    if (current !== undefined) updated += 1;
    else inserted += 1;

    db.insert(characterRelation)
      .values({
        id: authored.id,
        saveId,
        fromCharacterId: authored.fromCharacterId,
        toCharacterId: authored.toCharacterId,
        type: authored.type,
      })
      .onConflictDoUpdate({
        target: characterRelation.id,
        set: {
          saveId,
          fromCharacterId: authored.fromCharacterId,
          toCharacterId: authored.toCharacterId,
          type: authored.type,
        },
      })
      .run();
  }

  return { total: CANON_CHARACTER_RELATIONS.length, inserted, updated, unchanged };
}
