/**
 * P3.2 — the registry: characters, locations, projects and the family edges between
 * characters (architecture §2.2).
 *
 * Everything here is authored from `data/story_docs/LIFEstream Bible.txt` and carries a
 * `// L<n>` marker naming the line it was read off, so a later reader can check a row
 * against canon without re-deriving it. Where a value is an authoring judgement rather
 * than a fact on the page, the comment says so in as many words.
 *
 * ── THREE RULES THIS MODULE EXISTS TO KEEP ────────────────────────────────────────────
 *
 * **Renames are an identity chain, not separate places** (P3.2.3, §2.2). One row per
 * NAME, linked by `superseded_by_location_id`, so an event keeps the historically correct
 * name of where it happened while every "what happened here" query resolves to the
 * canonical head first. The chain is acyclic with one successor per row — and that is the
 * whole of the rule. It is NOT linear: canon has two chains converging on Oasis City
 * (`COP Isotope → FOB Oasis → Camp Oasis`, L894/L898, and `Disaster Ridge → Oasis City`,
 * L941, which the glossary calls Oasis City's *fourth* designation), so
 * `superseded_by_location_id` deliberately carries no UNIQUE constraint. Do not add one.
 *
 * **A lifespan has one authority** (§2.2). Where a character has a linked `born` / `died`
 * event, that event is authoritative and `lifespan_*` is a persisted derived cache of its
 * rolled `when` — so this module does not author, compare or write those columns at all
 * (see {@link CanonCharacter.eventOwnedBounds}); `refreshLifespanCache` in `events.ts`
 * fills them from the event. Authoring them here as well would put the same fact in the
 * database twice, and the two would disagree the moment anybody re-rolled the event.
 *
 * **The Adan–X `sibling-of` row does not exist** (P3.2.5, §2.2). Both their parents are
 * modelled, so the edge is derived by the Family Trees layout. Storing it too would
 * assert the same fact twice, and the two copies can then disagree.
 */
import { eq } from 'drizzle-orm';

import { character, characterRelation, location, project } from '../db/schema.js';

import type { CanonDateTools } from './dateTools.js';
import type { Db } from '../db/index.js';
import type { CharacterRelationType, ProjectStatus, WhenPrecision } from '@shared/types/index';

/** A bound the Bible states, as the precision it states it at plus the value to read. */
export interface AuthoredBound {
  precision: WhenPrecision;
  /** A form `precisionToInterval` accepts — see its table for every shape. */
  value: string;
}

/** One authored character. `role` is required by the schema and is free text. */
export interface CanonCharacter {
  id: string;
  name: string;
  role: string;
  bio: string;
  /** Authored directly — only for a bound no `born`/`died` event owns. */
  lifespanStart?: AuthoredBound;
  lifespanEnd?: AuthoredBound;
  /**
   * Bounds owned by a linked `born`/`died` event (§2.2). Listed rather than inferred so
   * this module can leave those columns strictly alone: it does not write them on an
   * insert, does not compare them when deciding whether a row changed, and does not put
   * them in its update set. `refreshLifespanCache` owns them.
   */
  eventOwnedBounds?: readonly ('start' | 'end')[];
}

/** One authored location. `supersededById` is the rename chain's forward link. */
export interface CanonLocation {
  id: string;
  name: string;
  description: string;
  /** GLOBAL `country.id` — `'840'` USA, `'380'` Italy. Null for anything off Earth. */
  countryId?: string;
  /** The row that replaced this NAME. Never this row's own id (a CHECK rejects that). */
  supersededById?: string;
}

/** One authored project. Anything with duration is a project, never an event (§2.3). */
export interface CanonProject {
  id: string;
  name: string;
  description: string;
  dateStart?: AuthoredBound;
  dateEnd?: AuthoredBound;
  status: ProjectStatus;
}

/** One authored character-to-character edge. */
export interface CanonCharacterRelation {
  id: string;
  fromCharacterId: string;
  toCharacterId: string;
  type: CharacterRelationType;
}

/* ------------------------------------------------------------------ *
 * Characters — P3.2.1, Bible L513-562
 * ------------------------------------------------------------------ */

/**
 * The fourteen names P3.2.1 lists, in its order.
 *
 * Names are transcribed VERBATIM from the character sheet, curly quotes and all — which
 * is why `Adan Castañeda` carries a tilde and `Xavier “X” Castaneda` does not. That is
 * canon's own inconsistency (L515, L521) and not this module's to silently harmonise.
 */
export const CANON_CHARACTERS: readonly CanonCharacter[] = [
  {
    id: 'char_lazaro',
    name: 'Lazaro Castañeda', // L559
    role: "Adan's and X's father; Marine-Scientific Liaison at COP Isotope, later NovaTech fusion engineer",
    bio:
      'Born to Mexican immigrants and raised in Mojave, California; the eldest of five. Watched the ' +
      'Marines raise Combat Outpost Isotope on the rim of Disaster Ridge and made joining them his ' +
      'goal. Presumed dead in 2072 with the rest of the Enceladus crew. Canon dates his birth twice: ' +
      'the character sheet gives October 12, 2021 (L560) while the world timeline gives only the year ' +
      "(L888) — the linked birth event owns the column, so the sheet's day is recorded here instead.",
    // "DOD: Presumed Dead (2072)" — L561. Year precision: the card must print "2072".
    lifespanEnd: { precision: 'year', value: '2072' },
    // "2021: Lazaro Castaneda is born in Los Angeles." — L888, seeded as `evt_lazaro_born`.
    eventOwnedBounds: ['start'],
  },
  {
    id: 'char_ines',
    name: 'Ines de la Encarnación Cardenas', // L555
    role: "Adan's and X's mother; neuroscientist, later a teacher",
    bio:
      "Nine years old when the Big One hit. Took her Master's and Ph.D. in neuroscience at UCLA, " +
      'proving the Black Fever Virus could only reach its full effect in human neural tissue, and left ' +
      'the field in 2056 rather than carry the virus home to her children. Among the last known ' +
      'carriers of Lazy Black Fever. Canon dates her birth twice: March 18, 2025 on the character ' +
      'sheet (L557), year-only in the world timeline (L889) — the linked birth event owns the column.',
    // "DOD: April 5th, 2076 at 7:32pm" — L558. Time precision; the only clock canon gives her.
    lifespanEnd: { precision: 'time', value: '2076-04-05T19:32Z' },
    // "2025: Ines Cardenas is born in Los Angeles." — L889, seeded as `evt_ines_born`.
    eventOwnedBounds: ['start'],
  },
  {
    id: 'char_adan',
    name: 'Adan Castañeda', // L521
    role: "Xavier's older brother; synthesizes drops by hand for X and the GZVA",
    bio:
      'Born in Los Angeles. Researches and hand-synthesizes Neuro-Optic Stabilizer Solution for his ' +
      "brother's PTSD episodes and then for the Ground Zeros Veterans Association, because the " +
      'official supply was never going to be enough.',
    lifespanStart: { precision: 'day', value: '2058-06-05' }, // "DOB: June 5th, 2058" — L523
  },
  {
    id: 'char_x',
    name: 'Xavier “X” Castaneda', // L515
    role: 'Protagonist; Seki Sports driver in the Helios Racing League',
    bio: 'Born in Los Angeles. Races as "X" for Team Seki Sports on the HRL grid.',
    lifespanStart: { precision: 'day', value: '2062-01-30' }, // "DOB: Jan 30th, 2062" — L520
  },
  {
    id: 'char_min_seo',
    name: 'Han Min-Seo', // L525
    role: "X's girlfriend",
    bio:
      'Born in Unified Korea (former North). Daughter of Han Chol-min, a former North Korean naval ' +
      'officer retained as a token rear admiral in the Unified Korean Navy. Found and saved by Adan ' +
      'and X in 2078 during a theft of biomedical equipment.',
    lifespanStart: { precision: 'day', value: '2060-02-02' }, // "DOB: Feb 2nd, 2060" — L528
  },
  {
    id: 'char_bruce_deng',
    name: 'Bruce Deng', // L926
    role: 'Fusion physicist',
    bio:
      'Dr. Bruce Deng and his team, working with the Kauai contingent, found a stable confinement ' +
      'method for fusion reactions on October 3rd, 2044 — the D-He³ reactor, and the backbone of ' +
      'fixed industrial power ever since. Canon gives him no dates of his own.',
  },
  {
    id: 'char_atticus',
    name: 'Atticus Pallas', // L535
    role: 'Antagonist',
    bio:
      'Place and date of birth both recorded as unknown, which is canon rather than a gap in this ' +
      'transcription (L537-538). Deimos Vane is his clone.',
  },
  {
    id: 'char_deimos',
    name: 'Deimos Vane', // L539
    role: 'Antagonist; MEGACORP HRL, Team Phaethon driver',
    bio:
      "Atticus Pallas's clone, created and force-matured to adulthood in 2078. His public record " +
      'falsely backdates his birth to 2058, which is why the character sheet gives both years ' +
      '"2058 (Fiction)/2078 (Reality)" (L543). The real year is the one stored.',
    // AUTHORING JUDGEMENT: canon states two birth years and labels one of them a fabrication
    // (L543, L961). The stored bound is the real one; the false record lives in the bio.
    lifespanStart: { precision: 'year', value: '2078' },
  },
  {
    id: 'char_dal',
    name: 'Dal', // L645
    role: 'Korean megacorporation — maker of HoloVision and LIFEstream',
    bio:
      'FLAGGED FOR THE AUTHOR: P3.2.1 lists "Dal" among the fourteen characters, but everywhere the ' +
      'Bible names Dal it is a company — "Korean Mega DAL" in the LIFEstream glossary entry, a ' +
      'megacorporation at L645, a marketing department at L379. It is seeded as the plan asks, with ' +
      'no family edges and no dates, so it can be moved or dropped without touching anything else.',
  },
  {
    id: 'char_kim_jung_un',
    name: 'Kim Jung Un', // L629
    role: 'Supreme Leader of North Korea',
    bio:
      'Launched a single nuclear missile at South Korea on December 31st, 2041 in an inebriated ' +
      'accident, starting the war that ended his regime. Canon gives him no dates of his own.',
  },
  {
    id: 'char_moto',
    name: 'Motoaki “Moto” Nagai', // L529
    role: 'Head of Seki Sports Racing',
    bio: 'Born in Osaka, Japan. Runs the team X drives for.',
    lifespanStart: { precision: 'day', value: '2018-03-14' }, // "DOB: March 14, 2018" — L532
  },
  {
    id: 'char_max_lauda',
    name: 'Max Lauda', // L549
    role: 'Traditional motorsport racing legend',
    bio:
      'One of the most exceptional drivers in motorsports history. Died in a test drive of his DFD ' +
      'craft, ending the original Helios Racing League and discouraging a generation of professionals ' +
      'who reasoned that a craft Lauda could not control was not masterable.',
    // AUTHORING JUDGEMENT: the character sheet leaves both "DOB" and "DOD" blank (L551-552). The
    // death date is read off the world timeline instead — "Feb 7th, 2048: Max Lauda dies in a test
    // drive of his DFD craft" (L940). P5 transcribes that bullet as an event; once it carries a
    // `died` actor row the event takes the column over and this authored value stops being used.
    lifespanEnd: { precision: 'day', value: '2048-02-07' },
  },
  {
    id: 'char_rocko',
    name: 'Rocko', // L545
    role: 'Chihuahua Therodolon in a large automata body',
    bio:
      "Formerly a chronically ill senior chihuahua; the brothers' first successful brain clone and " +
      'the proof-of-concept for X\'s surgery. Loud, yappy, confrontational — "old couch king" turned ' +
      'all-bark-all-bite.',
  },
  {
    id: 'char_laika',
    name: 'Laika', // L547
    role: 'Greyhound Therodolon in a large automata body',
    bio: 'An old ex-race dog and the second (final) successful clone. Quick, agile, determined.',
  },
];

/* ------------------------------------------------------------------ *
 * Locations — P3.2.2 + P3.2.3, Bible L73-84, L860-885, L975-1070
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
    name: 'Star City', // L866, glossary L1063
    description:
      'Final designation of the Disaster Ridge site, adopted after MEGACORP assumed full control of ' +
      'the region on the completion of Earth Tower 1 in 2066. The global aerospace and economic ' +
      'epicenter, home to the ring of 120 fusion reactors powering the Space Fountain section.',
    countryId: '840',
  },
  {
    id: 'loc_oasis_city',
    name: 'Oasis City', // glossary L1044
    description:
      'Fourth designation of the Disaster Ridge site, following Camp Oasis. Established in 2051 after ' +
      'the military designation was dropped and NovaTech bought the rights to the region from the US ' +
      'government, turning it into a civilian industrial and corporate hub.',
    countryId: '840',
    supersededById: 'loc_star_city', // L965: renamed Star City in 2066
  },
  {
    id: 'loc_camp_oasis',
    name: 'Camp Oasis', // glossary L987
    description:
      'Third designation of the Disaster Ridge installation, following FOB Oasis. Marks the transition ' +
      'from a temporary forward operating base to a permanent fortified garrison, with housing on the ' +
      'flattened bottom level of the Ridge.',
    countryId: '840',
    supersededById: 'loc_oasis_city', // L941: incorporated as Oasis City in 2051
  },
  {
    id: 'loc_fob_oasis',
    name: 'FOB Oasis', // glossary L1010
    description:
      'Second designation of the Disaster Ridge installation, following Combat Outpost Isotope. ' +
      'Established as extraction operations scaled and the site required broader logistical ' +
      'infrastructure; the first elevator connecting Top Ridge and Bottom Ridge was built in this phase.',
    countryId: '840',
    supersededById: 'loc_camp_oasis', // L898: redesignated Camp Oasis in 2039
  },
  {
    id: 'loc_cop_isotope',
    name: 'COP Isotope', // L78, glossary L992 ("Combat Outpost Isotope (COPI)")
    description:
      'Original name of the Marine outpost at Disaster Ridge, established once the initial ' +
      'science-personnel survey confirmed massive Lithium-6 deposits. Austere, and focused entirely on ' +
      'securing and surveying the site. Civilians took to calling it Camp Disaster.',
    countryId: '840',
    supersededById: 'loc_fob_oasis', // L894: redesignated FOB Oasis in late 2035
  },
  {
    id: 'loc_disaster_ridge',
    name: 'Disaster Ridge', // L73, glossary L1005
    description:
      'The massive geological chasm opened along the San Andreas Fault near Mojave, California by the ' +
      'Big One in 2034, later found to hold extraordinary Lithium-6 deposits capable of breeding ' +
      'Helium-3. Named by the people of Mojave. Site of Earth Tower 1.',
    countryId: '840',
    // The MERGE the schema exists to permit: this chain and the COP Isotope chain converge on
    // one head. "2051: Disaster Ridge is incorporated as a city under the new name Oasis City."
    // — L941, and the glossary calls Oasis City the site's FOURTH designation (L1044).
    supersededById: 'loc_oasis_city',
  },

  // ---- Mojave, head first.
  {
    id: 'loc_new_mojave',
    name: 'New Mojave', // L864
    description:
      'The rebuilt Mojave, raised after the Big One levelled the original town. Used whenever canon ' +
      'compares what used to be with what is.',
    countryId: '840',
  },
  {
    id: 'loc_mojave',
    name: 'Mojave', // L863
    description:
      "The original town of Mojave, in Death Valley — Lazaro's home when the Big One destroyed it, " +
      'and the town whose residents named Disaster Ridge.',
    countryId: '840',
    supersededById: 'loc_new_mojave',
  },

  // ---- Los Angeles, head first.
  {
    id: 'loc_neo_los_angeles',
    name: 'Neo Los Angeles', // L862
    description:
      'The name of Los Angeles after the Big One. First city imbued with a passion for reconstruction, ' +
      'and the site of the first-generation Megablocks.',
    countryId: '840',
  },
  {
    id: 'loc_los_angeles',
    name: 'Los Angeles', // L861
    description:
      'Los Angeles before the Big One: suburban sprawl as far as the eye could see, cut through by a ' +
      'highway network and taxiing aircraft.',
    countryId: '840',
    supersededById: 'loc_neo_los_angeles',
  },

  // ---- the rest of P3.2.2, in its order.
  {
    id: 'loc_gran_sasso',
    name: 'Gran Sasso National Laboratory (LNGS)', // L197
    description:
      "The Italian contingency's underground Project Xero lab in Abruzzo. Where the neucomp was " +
      'integrated into a working signal processor in early 2044, and where the first viable Black ' +
      'Fever vaccine was brute-forced on March 29th, 2045.',
    countryId: '380',
  },
  {
    id: 'loc_kauai_lab',
    name: 'Pacific Missile Range Facility, Kauai', // L168
    description:
      'Underground Project Xero lab housing biologists, virologists and chemists running Black Fever ' +
      'transmission research and Pacific quarantine coordination, and the central coordination point ' +
      'for the antibody trials across every UEA member lab.',
    countryId: '840',
  },
  {
    id: 'loc_hoover_dam',
    name: 'Hoover Dam', // L177
    description:
      'Repaired after structural damage from the Big One, seized by the US military in early 2042 and ' +
      'its hydroelectric output redirected entirely to the underground lab network — the stopgap that ' +
      'bought Project Xero the runway it needed.',
    countryId: '840',
  },
  {
    id: 'loc_et1',
    name: 'Earth Tower 1', // L330, glossary L1007
    description:
      'The first and only Terra-scale construction project in human history. A hybrid Space Fountain ' +
      'and Space Tether elevator built atop Disaster Ridge, reaching 2,000km on active magnetic ' +
      'support before transitioning to a passive tether at 36,000km. Opened August 1st, 2066.',
    countryId: '840',
  },
  {
    id: 'loc_port_charon',
    name: 'Port Charon', // L873
    description:
      "Industrial logistics city at the top of Earth Tower 1's Space Fountain section, 2,000km above " +
      'Star City. The transshipment hub where earth-bound freight meets the deep-space cargo arriving ' +
      'on the lunar highway in the sky — a working-class port named by its workers.',
  },
  {
    id: 'loc_atlas',
    name: 'Atlas', // L875
    description:
      "The counterweight at the top of Earth Tower 1's Space Tether at geostationary orbit, 36,000km " +
      'up. A compacted heap of Processed Regolith from the Moon, held in place by orbital tension.',
  },
  {
    id: 'loc_erebus',
    name: 'Erebus', // L877
    description:
      'The deep-space region surrounding Atlas at geostationary altitude. Hosts the Tartarus Run ' +
      "circuit, carved from leftover Processed Regolith from Atlas's construction.",
  },
  {
    id: 'loc_etna',
    name: 'Etna', // L880
    description:
      'First asteroid target for MEGACORP, in Project Athena. Near edge of the asteroid belt. Reached ' +
      'by the Enceladus in 2071; the crew was presumed dead there in 2072.',
  },
  {
    id: 'loc_chrysus',
    name: 'Chrysus', // L883
    description:
      'Second asteroid target for MEGACORP, in Project Aurum. Far edge of the asteroid belt.',
  },
];

/* ------------------------------------------------------------------ *
 * Projects — P3.2.4, Bible L791-826
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
    name: 'NSPD-51A', // L792, glossary L1043
    description:
      'National Security Presidential Directive 51-Alpha. The amended Directive 51 that replaced the ' +
      'traditional continuity-of-government structure with a streamlined scientific congress of 435 ' +
      'researcher-representatives empowered to decide alongside the President. The blueprint of ' +
      'United Earth governance.',
    dateStart: { precision: 'month', value: '2042-01' }, // "Start: ~Jan 2042" — L796
    dateEnd: { precision: 'month', value: '2047-05' }, // "End: May, 2047" — L797
    status: 'succeeded',
  },
  {
    id: 'proj_xero',
    name: 'Project Xero', // L799, glossary L1050
    description:
      "The United Earth Alliance's operation to cure and eradicate the Black Fever Virus at global " +
      'scale — the single most important operation in human history. Ran the Xero Network of ' +
      'underground labs, and produced the neucomp as a side effect of its own data load.',
    dateStart: { precision: 'month', value: '2042-05' }, // "Start: May, 2042" — L802
    dateEnd: { precision: 'month', value: '2047-06' }, // "End: June, 2047" — L803
    status: 'succeeded',
  },
  {
    id: 'proj_athena',
    name: 'Project Athena', // L804, glossary L1048
    description:
      "MEGACORP's mission to mine asteroid Etna at the near edge of the asteroid belt and return rare " +
      'earth minerals to Earth. Called Project Nero by people who expected its haul to tank the ' +
      'materials markets — a joke that landed differently once the crew was presumed dead.',
    // AUTHORING JUDGEMENT: canon's timeline for Athena lists "Announced: Feb 5th, 2060" rather than
    // a start (L808). The announcement is the earliest dated point of the programme, so it is what
    // `date_start` carries; the milestones in between (crew selected Nov 2063, departure 2070) are
    // events, not bounds.
    dateStart: { precision: 'day', value: '2060-02-05' },
    dateEnd: { precision: 'year', value: '2072' }, // "End: 2072 (Crew presumed dead)" — L811
    status: 'failed',
  },
  {
    id: 'proj_aurum',
    name: 'Project Aurum', // L813, glossary L1049
    description:
      "MEGACORP's second asteroid mining mission, targeting asteroid Chrysus at the far edge of the " +
      'belt. Set in place before Athena failed. Called Project Midas by the opposition that formed ' +
      'once people understood what the first haul would do to the economy.',
    dateStart: { precision: 'year', value: '2076' }, // "Start: 2076" — L817
    dateEnd: { precision: 'year', value: '2086' }, // "End: Expected 2086" — L818
    // AUTHORING JUDGEMENT: the Chrysus departed in October 2082 and is expected back in 2086, and
    // the story's present is 2084 (L969) — so the programme is running, not finished.
    status: 'active',
  },
  {
    id: 'proj_afterlife',
    name: 'Project Afterlife', // L822, glossary L1047
    description:
      'A secret programme run alongside cure development inside Project Xero, hidden from the public ' +
      'and from most Xero personnel. Its stated goal was neucomp hosts capable of sustaining a full ' +
      'human Eidolon; its real function was political — the promise the US President used to buy the ' +
      "future Megacorp owners' consent to the great mergers.",
    // AUTHORING JUDGEMENT: canon dates the START as a RANGE — "Start: alongside cure development
    // (~2042-2045), in secret" (L825) — which `date_start` (one instant plus one precision) cannot
    // express. The earlier end of that range is stored at year precision. There is no stated end:
    // the programme "becomes the commercial Afterlife Program under Cognis" (L826) on no given date,
    // so `date_end` stays null rather than acquiring an invented one.
    dateStart: { precision: 'year', value: '2042' },
    status: 'succeeded',
  },
];

/* ------------------------------------------------------------------ *
 * Family relations — P3.2.5, Bible L38, L555-561, L961
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
  // Symmetric: lower id first. "2057: Lazaro and Ines get married." — L948.
  {
    id: 'crel_ines_lazaro_spouse',
    fromCharacterId: 'char_ines',
    toCharacterId: 'char_lazaro',
    type: 'spouse-of',
  },
  {
    id: 'crel_lazaro_adan_parent',
    fromCharacterId: 'char_lazaro',
    toCharacterId: 'char_adan',
    type: 'parent-of',
  },
  {
    id: 'crel_lazaro_x_parent',
    fromCharacterId: 'char_lazaro',
    toCharacterId: 'char_x',
    type: 'parent-of',
  },
  {
    id: 'crel_ines_adan_parent',
    fromCharacterId: 'char_ines',
    toCharacterId: 'char_adan',
    type: 'parent-of',
  },
  {
    id: 'crel_ines_x_parent',
    fromCharacterId: 'char_ines',
    toCharacterId: 'char_x',
    type: 'parent-of',
  },
  // AUTHORING JUDGEMENT ON DIRECTION. P3.2.5 writes this edge "Atticus clone-of Deimos", and
  // canon says the opposite of what that reads as in English: "Deimos Vane, Atticus Pallas's
  // clone" (L961). Both are satisfied by reading `clone-of` the way `parent-of` reads — `from`
  // is the progenitor — which is also the only reading under which the plan's own phrasing and
  // canon agree. So: from = the original, to = the clone.
  {
    id: 'crel_atticus_deimos_clone',
    fromCharacterId: 'char_atticus',
    toCharacterId: 'char_deimos',
    type: 'clone-of',
  },
];

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

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

function seedCharacters(db: Db, saveId: string, tools: CanonDateTools): RegistryTableResult {
  const existing = new Map(
    db
      .select()
      .from(character)
      .where(eq(character.saveId, saveId))
      .all()
      .map((row) => [row.id, row] as const),
  );

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  for (const authored of CANON_CHARACTERS) {
    const owned = new Set(authored.eventOwnedBounds ?? []);
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
