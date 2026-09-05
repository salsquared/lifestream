import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CANON_EVENTS, readWorldTimelineBullets, resolveCanonEvents } from '@server/seed/events';
import {
  FUNCTION_WORDS,
  PROSE_MATCH_THRESHOLD,
  actionableGateDetail,
  buildCanonChangeReport,
  changeReportPathFor,
  claimReadsBullet,
  claimsOnBullet,
  classifyPair,
  contentWords,
  matchBullets,
  proseSimilarity,
  renderCanonChangeMarkdown,
  renderCanonChangeReport,
} from '../scripts/canonChangeReport';
import { WORLD_TIMELINE_SECTIONS, provenancePathFor } from '../scripts/sync-docs';

import type { CanonBullet, CanonEvent } from '@server/seed/events';

/**
 * P4B.6 — the canon change report.
 *
 * ── WHAT THIS SPEC IS FOR ────────────────────────────────────────────────────────────
 * The module's whole value is a JUDGEMENT: given two Bibles, decide for each bullet
 * whether it survived, and if it did, what changed about it. A wrong judgement in either
 * direction is silent — a re-dated bullet reported as removed-plus-added sends someone
 * looking for an event that was never cut, and two different bullets fused into one
 * "reworded" entry HIDES a real addition and a real removal. Neither failure raises
 * anything on its own, so both have to be exercised here.
 *
 * ── THE THRESHOLD IS A MEASUREMENT AND THIS FILE IS WHERE IT IS PINNED ───────────────
 * `PROSE_MATCH_THRESHOLD` is 0.40 because two real bullets sit on either side of it and
 * must stay there: Max Lauda's death, re-dated from `Feb 7th, 2048` to `Jan 21st, 2057`
 * and rewritten around the new date (0.4667 — one bullet), and the Helios Racing League
 * founding, moved from a 2046 bullet to a 2056 one with entirely different prose (0.3333 —
 * two bullets, and the export treats it as such). Those two numbers are the whole
 * justification for the constant, so they are asserted, not described.
 *
 * ── WHY BOTH SIDES ARE EMBEDDED AND NEITHER IS READ FROM DISK (P4B.4) ───────────────
 * The AFTER side never could be read: the real 5 Sep 2026 export lives outside the repo,
 * and a spec that read it would pass on one machine and skip on every other — the reason
 * `tests/syncDocs.test.ts` gives for the same choice.
 *
 * The BEFORE side used to be read: it was the `data/story_docs` copy on disk, every
 * bullet of it. That stopped being true the moment P4B.2 put the export on disk — the
 * repo's copy IS the after side now, so the fixture compared a document with itself and
 * measured a change of nothing. Twelve of these tests failed at once, not because the
 * module regressed but because the spec was keyed on the tree.
 *
 * So the BEFORE side is embedded too: `LIFEstream Bible.txt` L886-L970 as the 21 June copy
 * had them, verbatim, and the AFTER side applies exactly the edits the real export makes
 * to the Reconstruction Era — the three bullets it drops, the five it adds, the Lauda
 * re-dating and the one rewording — using the export's own text. Every claim below is
 * about ONE historical edit, and a spec about a past event must not depend on the tree's
 * present: install another export tomorrow and these numbers must not move. The reading
 * under test is the same 39 -> 41, and it runs everywhere.
 */

/**
 * The World Timeline exactly as the 21 June Bible carried it — L886-L970, verbatim.
 *
 * All four headings and all eighty bullets, because the counts (12 / 8 / 21 / 39), the
 * similarity scores and the "no third bullet outbids the Lauda pair" search are readings
 * over the WHOLE corpus; an excerpt of the interesting part would prove a different claim.
 */
const BEFORE_WORLD_TIMELINE = `World Timeline:
Pre-Big One
* 2021: Lazaro Castaneda is born in Los Angeles.
* 2025: Ines Cardenas is born in Los Angeles. 
* July 10th, 2034, 8:04am: An earthquake colloquially known as “The Big One” that had been anticipated for decades since the last 1906 San Francisco Earthquake hit California. 
* August 13th, 2034: The US government commissions a study of the epicenter and the chasm opened above it known as “Disaster Ridge.” 
* Feb 1st, 2035: Once the area was secured and a small military base was formed around the ridge, scientists moved in and began probing the Ridge. At first with satellites, then aerial and terrestrial drones they slowly ventured and mapped deeper and deeper towards the floor of the ridge.
* Aug 1st, 2035: With thousands of Angelenos now unhoused from the Big Ones destruction, Los Angeles’ first mega-housing building breaks ground.
* Late 2035: As extraction operations scale up and the site requires broader logistical and personnel support, COP Isotope is redesignated Forward Operating Base Oasis (FOB Oasis). The first elevator connecting Top Ridge to Bottom Ridge is constructed, allowing heavy equipment and miners to reach the floor of the chasm for the first time. 
* 2036: Megablock 2 through 8 begin construction. 
* 2037: Due to immense demand, people are moved into the mega block before it finishes completion. 
* 2039: Built at an unprecedented pace, Megablock 1 finishes construction.
* 2039: FOB Oasis is redesignated Camp Oasis as the installation transitions from a temporary forward operating base to a permanent fortified garrison. Permanent housing is established on the flattened bottom level of the Ridge. Lazaro is among the first Marines to receive a permanent billet there.
* 2040: Megablock 2-4, the last of the first generation Megablock are completed. 
North Korean War
* December 31st, 2041: Kim Jung Un accidentally sends nuclear missiles to attack SK. They are intercepted quickly and blown up over NK territory.
* January 1st, 2042: South Korea, United States, Japan, England, France, Canada, China, Russia and Mexico declare war on North Korea.
* January 10th, 2042: The Allies land and begin their pincer operation from all directions to be able to claim as much land for themselves as possible. X's father is amongst the first American soldiers to reach NK territory in the invasion.
* January 11th, 2042: The Allies encounter their first concentration camp. Deserted by the NK forces a few days earlier, most of the prisoners rushed towards the front lines to be liberated from captivity. What the allies find are sickly and deformed people clinging to the little life they have left. The doctors that have come along are trying to figure out what is wrong with them. They suspect it has to do with radiation poisoning so they refrain from putting them in quarantine.
* January 13th, 2042: The Black Fever Virus infects it's first military personnel at the quarantine facilities. First documented occurrence of a Cranial Rupture.
* January 15th, 2042: The Allies, united against North Korea, crush the small militant state with little resistance from the once loyal army.
* January 16th, 2042: The Allies declare victory over the NK government and split the land between themselves before negotiations to turn over the captured land to SK to form a United Korea.
* Jan 27th, 2042: X's father is relieved of his duty due to him reaching the maximum number of days allowed for Allied soldiers to remain in NK due to the amounts of radiation. New troops are constantly being sent in from each Allied nation to replenish the homeward soldiers to maintain the peace in their newly claimed NK lands. He is sent down to SK on a military flight and returns home the same day with his company in a military sub-orbital space shuttle.
Black Fever Era
* 2042 onward: In the months after the salted-bomb detonation, fallout begins settling into the lower atmosphere and the first faint acidity appears in rainfall - unmeasured and unnamed amid the pandemic. It climbs steadily through the Black Fever years.
* February 20th, 2042: Allies and particularly American military base personnel begin to rupture after the first infected people return home across the world.
* February 22nd, 2042: The President is made aware of the BFV and leading virologists give a grim picture that it's already here and wont go away easily. 
* Feb 23rd, 2042: The Presidential Directive 51-Alpha (NSPD-51A) has begun drafting under direct order from the President. 
* Feb 25th, 2042: NSPD-51A is put into effect and scientists from across the US and the world are taken to live in underground military installations. 
* February 26th, 2042: The Allies announce that an outbreak of a new and deadly disease coined Black Fever has taken place. All countries close their doors and halt international travel and trade but it's already too late. The soldiers that had returned home from the quick takeover of NK already carried the disease with them home.
* March, 2042: By the end of March, the death toll reaches 30,000.
* April, 2042: By the end of April, the death toll reaches 150,000. 
* May 1st, 2042: United Earth Assembly is created with the sole purpose of unifying Earth's resources to combat the BFV - Project Xero. All member countries follow US and others lead and develop underground communities for politicians and scientists. 
* May 14th, 2042: The death toll of Black Fever reaches 1M worldwide.
* June 14th, 2042: The death toll of Black Fever reaches 2M worldwide.
* ~June, 2042: The governments of small nations around the world begin to collapse. Larger more independent nations too begin to weaken. 
* July 14th, 2042: The death toll reaches 6M worldwide.
* Aug 14th, 2042: The death toll reaches 25M worldwide.
* Dec 25th, 2042: The world has a hard time celebrating Christmas as the death toll reaches 130M worldwide. 
* Jan 1st, 2043: Humanity begins its first year with less people than it had a year before.
* Oct 3rd, 2044: Dr. Bruce Deng and his team of scientists, in collaboration with the Kauai-team, achieve the impossible: they find a stable confinement method for fusion reactions. By this point the underground labs were running critically low on enriched uranium to power their fission plants. The Hoover Dam - recently repaired following structural damage caused by the Big One - had been seized by the US military in early 2042 and its hydroelectric output redirected entirely to the underground lab network, buying the project the additional runway it needed. Without that stopgap power source, Project Xero may never have reached completion. 
* Mar 29th, 2045: After the death of 940M people, the Italian contingency at Gran Sasso uses their own neucomp architecture to brute-force the antibody synthesis, producing the first viable Black Fever vaccine.
* April 1st, 2045: Countries collectively spend all their remaining resources on developing the technology further and manufacture as many vaccines equally to all parts of the world to snuff out the virus as quickly as possible. By this point, through a miracle combination of mass production and international cooperation, in 6 months, 50% of the world is vaccinated against Black Fever and life in the developed world starts to rebuild. 
* 2045: Neuro-interpretability is achieved by growing copies of an individual's brain cells. They turn out to be the only ones capable of decoding the signals or understanding the individual's particular brain due to the insane amount of signal noise human brains work with. This helps a normal computer read the extracorporeal computational brainmass.
* November 18th, 2046: The last confirmed case of Black Fever.
Reconstruction Era
* 2046: With a world in need of new forms of entertainment the Helios Racing League (HRL) is formed.
* 2046: The first fusion reactor built outside the Xero underground labs comes online at Camp Oasis, in still-sealed Disaster Ridge — the same installation whose Lithium-6 had bred the Helium-3 that fueled the first underground reactor. Built in isolation and lit as the world emerges from the pandemic, its completion is taken as the herald of the Reconstruction era.
* October 8th, 2047: The world’s first fusion powered rocket reaches orbit. Cadence to space is dramatically increased due to the low cost of space travel.
* Fall, 2047: Ines and Lazaro enroll at UCLA for their Masters and Ph.D respectively. They met for the first time and started dating shortly after. 
* Late 2040s: As the Reconstruction begins, the sour rain is undeniable and worsening.
* Feb 7th, 2048: Max Lauda dies in a test drive of his DFD craft and ends the original HRL.
* April 5th, 2049: The lunar operations are started for the first time since the BF era and the first fusion reactor on the Moon comes online.
* Early 2050s: The sour rain matures into its full storm-driven form - discrete, building-stripping fronts concentrated over cities. Terrestrial construction abandons concrete and carbonate stone for granite and basalt; the first-generation Megablocks are clad in stone retrofit by retrofit.
* Jan 3rd, 2051: MEGACORP is formed and announces the plan to build the world’s first space elevator, Earth Tower 1, on top of Disaster Ridge, Death Valley, California.
* 2051: Disaster Ridge is incorporated as a city under the new name Oasis City. 
* 2052: Ines starts working in hospitals helping people suffering from neural diseases. 
* 2054: Dal releases the first version of HoloVision (V1), vision-only — the first major consumer neural product of the Reconstruction, arriving once the rebuilt world had the infrastructure and appetite for entertainment technology again.
* 2056: Lazaro completes his doctorate and joins NovaTech to help build the fusion plants meant to power ET1.
* 2056: Lazaro is given a plot of land in Disaster Ridge to work and live out of by the US government for his service and his important work with NovaTech.
* 2057: Lazaro and Ines get married. 
* 2057: Ines quits her job and becomes a teacher to stay away from illnesses.
* June 5th, 2058: Adan, X’s older brother, is born.
* February 5th, 2060: MEGACORP announces their intention to build a large fusion-powered space craft under the title Enceladus under Project Athena without disclosing its intended target.
* Jan 30th, 2062: X is born.
* 2063: Dal releases HoloVision V2, adding neurally transmitted audio to the original sight-only system.
* Nov 2063: As a US military veteran with combat and engineering experience, X’s father is selected to serve as a nuclear propulsions engineer for Project Athena without knowing what it entails. 
* Aug 1st, 2066: Earth Tower 1 opens and takes its first cargo to LEO.
* 2066: Following the completion and opening of Earth Tower 1, MEGACORP assumes full control of the surrounding region. Oasis City is renamed Star City, reflecting its transformation from an industrial mining operation into the global center of aerospace activity.
* April 27th, 2070: Dal releases HoloVision V3, adding tactile and movement-restriction modulation to the existing visual and audio capabilities. The third and final iteration becomes the immediate technological precursor to LIFEstream.
* 2070: The asteroid mining ship, Enceladus, and its crew depart for asteroid Etna.
* 2071: Enceladus reaches asteroid Etna and mining operations commence. 
* Late 2071: Ines's first symptoms appear, dismissed as the stress of raising the boys alone while Lazaro is in deep space. 
* 2072: After nearly completing the mining, problems arise on Etna and the crew of the Enceladus is presumed dead.
* 2075: Dal publicly launches the LIFEstream system, the full-sensory successor to HoloVision V3. Where V3 modulated sight, sound, and touch through a wearable, LIFEstream transmits a Conduit's entire exteroception — vision, audition, taction, gustation, olfaction — at a minimum 600 Gsps, demanding the deeply invasive Cranial Port. Adoption is rapid and ruinous.
* 2076: Work on a successor to Project Athena, Project Aurum, begins.
* April 5th, 2076 at 7:32pm: Xavier's mother passes away.
* 2078: Deimos Vane, Atticus Pallas's clone, is created and force-matured to adulthood. His public record falsely backdates his birth to 2058. 
* 2078: Adan starts his research on DIY drops for X and they together steal biomedical equipment from a lab, accidently finding and saving Min-Seo in the process. 
* 2079: Adan synthesizes his first version of drops for X.
* Feb 7th, 2082: After years of research, Adan believes he may be able to synthesize a compound that will help his brother with his PTSD episodes. 
* May 2nd, 2082: The drops work for X and Adan begins making drops for the Ground Zeros Veterans Association (GZVA) for X to deliver. 
* October 18th, 2082: The Chrysus, of Project Aurum, departs for the further edge of the asteroid ring.
* Jan 3rd, 2084: 36 years after the close of the original, a new HRL is put together by the Promethean Syndicate Megacorporation.
* April 25, 2084: Xavier is getting ready to test upgrades to his homemade spacecraft’s DFD before delivering medication to the GZVA.`;

/**
 * The line L1 of the excerpt stands on in that Bible.
 *
 * Added back so every `L<n>` in this file is the number the change report actually
 * printed, rather than an offset into a fixture nobody can look up.
 */
const EXCERPT_FIRST_LINE = 886;

/** The real corpus, all four sections. The BEFORE side of every fixture below. */
const beforeBullets = readWorldTimelineBullets(BEFORE_WORLD_TIMELINE, WORLD_TIMELINE_SECTIONS).map(
  (bullet) => ({ ...bullet, line: bullet.line + EXCERPT_FIRST_LINE - 1 }),
);

const RECONSTRUCTION = 'Reconstruction Era';
const PRE_BIG_ONE = 'Pre-Big One';

/** The bullet at a known line of the 21 June Bible, or a failure that names it. */
function atLine(bullets: readonly CanonBullet[], line: number): CanonBullet {
  const bullet = bullets.find((entry) => entry.line === line);
  expect(bullet, `the 21 June Bible has a World Timeline bullet on L${line}`).toBeDefined();
  return bullet as CanonBullet;
}

/**
 * The four bullets the 5 Sep 2026 export changed, and the five it added, in its own words.
 *
 * Transcribed from the staged export rather than invented, because the threshold's whole
 * claim is about how these particular sentences score against each other. A paraphrase
 * would agree with whatever the measure happens to do and prove nothing.
 */
const STAGED_LAUDA =
  'Max Lauda dies during a public test run of an early commercial p-B¹¹ craft, collapsing ' +
  "the original HRL before its first season and putting the public's appetite for space to " +
  'sleep.';
const STAGED_HRL_FOUNDING =
  'Riding the fusion-craft boom, the original Helios Racing League is formed as a straight ' +
  'racing series, to stoke public enthusiasm for spaceflight.';
const STAGED_ADDITIONS: ReadonlyArray<{ dateText: string; text: string }> = [
  {
    dateText: 'Spring 2052',
    text:
      'Lazaro Castañeda completes his NovaTech-sponsored doctorate. His thesis is the first ' +
      'miniature p-B¹¹ reactor — a hand-built demonstrator, and the first aneutronic fusion ' +
      'reactor compact and clean enough to fly. Per his contract, the design and all IP vest ' +
      'in NovaTech, recorded as sole inventor.',
  },
  {
    dateText: '2053',
    text:
      'Now working directly with NovaTech, Lazaro builds the first commercial mini-reactor to ' +
      'be used by SpaceV for the first DFD-powered spacecraft.',
  },
  {
    dateText: '2054',
    text:
      'The first crewed DFD craft reaches orbit — a single-passenger research SSTO running on ' +
      "NovaTech's miniature p-B¹¹ drive. The dawn of fusion spaceflight; before it, space " +
      'access had been chemical.',
  },
  {
    dateText: '2055',
    text:
      'Productionized p-B¹¹ drives spread into distinct DFD vehicle classes — utility, sport, ' +
      'and military — and the first commercial DFD craft enter service (see DFD Vehicle Classes).',
  },
  { dateText: '2056', text: STAGED_HRL_FOUNDING },
];

/** The three Reconstruction Era bullets the export drops, by their 21 June line. */
const DROPPED_LINES = [932, 934, 944] as const;

/**
 * The staged corpus: the 21 June one with the export's Reconstruction Era edits applied.
 *
 * Line numbers are renumbered from 1 across the whole array, deliberately DIFFERENT from
 * the 21 June ones. Nothing in the matcher may key on a line number, and a fixture whose
 * two sides happened to agree on them would not prove that.
 */
const staged: CanonBullet[] = (() => {
  const out: CanonBullet[] = [];
  for (const bullet of beforeBullets) {
    if (DROPPED_LINES.includes(bullet.line as (typeof DROPPED_LINES)[number])) continue;
    if (bullet.line === 937) {
      out.push({ ...bullet, dateText: 'Jan 21st, 2057', text: STAGED_LAUDA });
      continue;
    }
    if (bullet.line === 969) {
      out.push({ ...bullet, text: bullet.text.replace('36 years', '27 years') });
      continue;
    }
    out.push({ ...bullet });
    // The five additions land in the middle of the era, which is what makes an ordinal
    // match useless: every bullet below them shifts.
    if (bullet.line === 943) {
      for (const addition of STAGED_ADDITIONS) {
        out.push({ section: RECONSTRUCTION, line: 0, ...addition });
      }
    }
  }
  return out.map((bullet, index) => ({ ...bullet, line: index + 1 }));
})();

const report = buildCanonChangeReport(beforeBullets, staged, WORLD_TIMELINE_SECTIONS);
const sectionRow = (section: string) => report.sections.find((row) => row.section === section);

// ---------------------------------------------------------------------------
// The measure, and the measurement the threshold rests on
// ---------------------------------------------------------------------------

describe('proseSimilarity', () => {
  it('scores an unchanged bullet 1 and an unrelated one near 0', () => {
    const bullet = atLine(beforeBullets, 946).text;
    expect(proseSimilarity(bullet, bullet)).toBe(1);
    expect(proseSimilarity(bullet, atLine(beforeBullets, 953).text)).toBeLessThan(0.2);
  });

  it('ignores typography the author cannot see, exactly as normaliseCanonText does', () => {
    const plain = "The world's first fusion powered rocket reaches orbit - twice.";
    const typeset = 'The  world’s first fusion powered rocket reaches orbit — twice.';
    expect(proseSimilarity(plain, typeset)).toBe(1);
  });

  it('is symmetric, so which Bible is "before" cannot change a verdict', () => {
    const a = atLine(beforeBullets, 937).text;
    expect(proseSimilarity(a, STAGED_LAUDA)).toBe(proseSimilarity(STAGED_LAUDA, a));
  });

  it('falls back to exact equality when a bullet is all function words', () => {
    // Two empty content-word sets are trivially identical, which would score 1 and fuse
    // two unrelated asides into one bullet. The fallback is what stops that.
    expect(contentWords('It is what it was.').size).toBe(0);
    expect(proseSimilarity('It is what it was.', 'And so it was not.')).toBe(0);
    expect(proseSimilarity('It is what it was.', 'it  IS what it was')).toBe(1);
  });

  it('drops function words and keeps hyphens and apostrophes inside a word', () => {
    expect(FUNCTION_WORDS.has('the')).toBe(true);
    expect(FUNCTION_WORDS.has('lauda')).toBe(false);
    expect([...contentWords("The p-B¹¹ craft's drive")].sort()).toEqual([
      "craft's",
      'drive',
      'p-b¹¹',
    ]);
  });
});

describe('PROSE_MATCH_THRESHOLD — the measurement, not a taste', () => {
  const laudaScore = proseSimilarity(atLine(beforeBullets, 937).text, STAGED_LAUDA);
  const foundingScore = proseSimilarity(atLine(beforeBullets, 932).text, STAGED_HRL_FOUNDING);

  it('puts the re-dated Max Lauda bullet above it and the rewritten HRL founding below', () => {
    // The two numbers the module header's table quotes. If either moves, the constant is
    // no longer the midpoint it claims to be and the header is stale.
    expect(laudaScore).toBeCloseTo(0.4667, 3);
    expect(foundingScore).toBeCloseTo(0.3333, 3);
    expect(laudaScore).toBeGreaterThan(PROSE_MATCH_THRESHOLD);
    expect(foundingScore).toBeLessThan(PROSE_MATCH_THRESHOLD);
  });

  it('sits at the midpoint of that band, with headroom on both sides', () => {
    // Not at the floor: too LOW is the dangerous direction, because two different bullets
    // fusing into one entry deletes a real addition and a real removal from the report,
    // while too high merely reports a move as remove-plus-add, which a reader can see.
    const below = PROSE_MATCH_THRESHOLD - foundingScore;
    const above = laudaScore - PROSE_MATCH_THRESHOLD;
    expect(below).toBeGreaterThan(0.06);
    expect(above).toBeGreaterThan(0.06);
    expect(Math.abs(above - below)).toBeLessThan(0.01);
  });

  it('cannot be beaten by a third bullet stealing either half of the Lauda pair', () => {
    // A threshold is only half the guard; the other half is that the true partner WINS.
    const before = atLine(beforeBullets, 937);
    const bestOther = Math.max(
      ...staged
        .filter((bullet) => bullet.text !== STAGED_LAUDA)
        .map((bullet) => proseSimilarity(before.text, bullet.text)),
      ...beforeBullets
        .filter((bullet) => bullet.line !== 937)
        .map((bullet) => proseSimilarity(bullet.text, STAGED_LAUDA)),
    );
    expect(bestOther).toBeLessThan(PROSE_MATCH_THRESHOLD);
    expect(laudaScore - bestOther).toBeGreaterThan(0.2);
  });
});

// ---------------------------------------------------------------------------
// Classification — the seven verdicts, one at a time
// ---------------------------------------------------------------------------

describe('classifyPair', () => {
  const bullet = (over: Partial<CanonBullet> = {}): CanonBullet => ({
    section: PRE_BIG_ONE,
    line: 10,
    dateText: '2021',
    text: 'Lazaro Castaneda is born in Los Angeles.',
    ...over,
  });

  it('calls an untouched bullet unchanged even when its line number moved', () => {
    expect(classifyPair(bullet(), bullet({ line: 4_000 }))).toBe('unchanged');
  });

  it('folds typography rather than reporting it as a rewording', () => {
    expect(
      classifyPair(bullet(), bullet({ text: 'Lazaro  Castaneda is born in Los Angeles.' })),
    ).toBe('unchanged');
  });

  it('separates a re-dating, a rewording and both at once', () => {
    expect(classifyPair(bullet(), bullet({ dateText: '2022' }))).toBe('re-dated');
    expect(classifyPair(bullet(), bullet({ text: 'Lazaro is born in LA.' }))).toBe('reworded');
    expect(classifyPair(bullet(), bullet({ dateText: '2022', text: 'Lazaro is born.' }))).toBe(
      're-dated-and-reworded',
    );
  });

  it('calls a bullet under a different heading moved, whatever else held', () => {
    expect(classifyPair(bullet(), bullet({ section: RECONSTRUCTION }))).toBe('moved');
    expect(classifyPair(bullet(), bullet({ section: RECONSTRUCTION, dateText: '2099' }))).toBe(
      'moved',
    );
  });
});

// ---------------------------------------------------------------------------
// Matching — the two failures the module exists to prevent
// ---------------------------------------------------------------------------

describe('matchBullets', () => {
  const corpus: CanonBullet[] = [
    { section: PRE_BIG_ONE, line: 1, dateText: '2021', text: 'Lazaro Castaneda is born in LA.' },
    { section: PRE_BIG_ONE, line: 2, dateText: '2025', text: 'Ines Cardenas is born in LA.' },
    { section: PRE_BIG_ONE, line: 3, dateText: '2036', text: 'Megablock 2 through 8 begin.' },
  ];

  it('is immune to an insertion above — the failure an ordinal match has', () => {
    const after: CanonBullet[] = [
      { section: PRE_BIG_ONE, line: 1, dateText: '2019', text: 'A wholly new opening bullet.' },
      ...corpus.map((bullet) => ({ ...bullet, line: bullet.line + 1 })),
    ];
    const changes = matchBullets(corpus, after);
    expect(changes.filter((change) => change.kind === 'unchanged')).toHaveLength(3);
    expect(changes.filter((change) => change.kind === 'added')).toHaveLength(1);
    expect(changes.filter((change) => change.kind === 'removed')).toHaveLength(0);
  });

  it('reports a re-dated bullet as ONE bullet — the failure the F2 key has', () => {
    // `(section, sourceDate, textStart)` contains the date, so it reads this as a deletion
    // plus an addition. That is the reading this whole module exists to replace.
    const after = corpus.map((bullet) =>
      bullet.line === 1 ? { ...bullet, dateText: '2022' } : bullet,
    );
    const changes = matchBullets(corpus, after);
    expect(changes.filter((change) => change.kind !== 'unchanged')).toHaveLength(1);
    expect(changes.find((change) => change.kind === 're-dated')?.before?.line).toBe(1);
  });

  it('matches within a section before it will match across one', () => {
    // The near-twin in another era must not outbid the bullet's own neighbour, which is
    // why the pass over same-section pairs runs first and to completion.
    const after: CanonBullet[] = [
      { ...(corpus[0] as CanonBullet), text: 'Lazaro Castaneda is born in Los Angeles.' },
      {
        section: RECONSTRUCTION,
        line: 9,
        dateText: '2021',
        text: 'Lazaro Castaneda is born in LA.',
      },
      ...corpus.slice(1),
    ];
    const changes = matchBullets(corpus, after);
    expect(changes.find((change) => change.before?.line === 1)?.kind).toBe('reworded');
    expect(changes.filter((change) => change.kind === 'added')).toHaveLength(1);
  });

  it('reports a genuine relocation as moved rather than as a removal and an addition', () => {
    const after = corpus.map((bullet) =>
      bullet.line === 3 ? { ...bullet, section: RECONSTRUCTION } : bullet,
    );
    const changes = matchBullets(corpus, after);
    expect(changes.filter((change) => change.kind === 'moved')).toHaveLength(1);
    expect(changes.filter((change) => change.kind === 'added')).toHaveLength(0);
    expect(changes.filter((change) => change.kind === 'removed')).toHaveLength(0);
  });

  it('refuses to fuse two different bullets, however the threshold is set', () => {
    // At threshold 0 everything pairs with something. That is not the guard's setting; it
    // is here to show the greedy pass never invents a pair it was not asked for.
    const after: CanonBullet[] = [
      { section: PRE_BIG_ONE, line: 1, dateText: '2021', text: 'A completely unrelated line.' },
    ];
    expect(
      matchBullets(corpus, after)
        .map((change) => change.kind)
        .sort(),
    ).toEqual(['added', 'removed', 'removed', 'removed']);
  });

  it('is deterministic when two bullets share their prose', () => {
    const twins: CanonBullet[] = [
      { section: PRE_BIG_ONE, line: 1, dateText: '2021', text: 'The same sentence twice.' },
      { section: PRE_BIG_ONE, line: 2, dateText: '2022', text: 'The same sentence twice.' },
    ];
    const after = twins.map((bullet) => ({ ...bullet, line: bullet.line + 100 }));
    for (let run = 0; run < 3; run += 1) {
      const pairs = matchBullets(twins, after).map(
        (change) => `${change.before?.line}->${change.after?.line}`,
      );
      expect(pairs).toEqual(['1->101', '2->102']);
    }
  });
});

// ---------------------------------------------------------------------------
// The real change, reproduced
// ---------------------------------------------------------------------------

describe('the 5 Sep 2026 export, over the real 21 June corpus', () => {
  it('leaves the three untouched sections entirely unchanged', () => {
    for (const section of ['Pre-Big One', 'North Korean War', 'Black Fever Era']) {
      const row = sectionRow(section);
      expect(row?.before, section).toBe(row?.after);
      expect(row?.unchanged, section).toBe(row?.before);
      expect([row?.added, row?.removed, row?.reDated, row?.reworded, row?.movedOut]).toEqual([
        0, 0, 0, 0, 0,
      ]);
    }
  });

  it('reads the Reconstruction Era as 3 removed, 5 added, 39 -> 41', () => {
    const row = sectionRow(RECONSTRUCTION);
    expect(row?.before).toBe(39);
    expect(row?.after).toBe(41);
    expect(row?.removed).toBe(3);
    expect(row?.added).toBe(5);
    expect(report.totals.before).toBe(80);
    expect(report.totals.after).toBe(82);
  });

  it('classifies Max Lauda as one re-dated bullet, NOT as a removal plus an addition', () => {
    // The single test that says the matcher works. A date-bearing key gets this wrong, and
    // getting it wrong sends a reader looking for an event that was never cut.
    const lauda = report.changed.filter((change) =>
      (change.before ?? change.after)?.text.includes('Max Lauda'),
    );
    expect(lauda).toHaveLength(1);
    expect(lauda[0]?.kind).toBe('re-dated-and-reworded');
    expect(lauda[0]?.before?.dateText).toBe('Feb 7th, 2048');
    expect(lauda[0]?.after?.dateText).toBe('Jan 21st, 2057');
    expect(lauda[0]?.score ?? 0).toBeGreaterThan(PROSE_MATCH_THRESHOLD);
  });

  it('splits the Helios Racing League founding into a removal and an addition', () => {
    // The honest answer, and deliberately not the same one as Lauda: two sentences about
    // the same institution ten years apart are not obviously one bullet, and the export
    // rewrote the founding rather than re-dating it.
    const removed = report.changed.find(
      (change) => change.kind === 'removed' && change.before?.line === 932,
    );
    const added = report.changed.find(
      (change) => change.kind === 'added' && change.after?.text === STAGED_HRL_FOUNDING,
    );
    expect(removed?.before?.text).toContain('Helios Racing League (HRL) is formed');
    expect(added).toBeDefined();
  });

  it('catches the one-word rewording that a bullet count cannot see', () => {
    // "36 years after the close of the original" became "27 years" — consistent with the
    // Lauda re-dating, and invisible to every count in the sync report.
    const reworded = report.changed.filter((change) => change.kind === 'reworded');
    expect(reworded).toHaveLength(1);
    expect(reworded[0]?.before?.text).toContain('36 years');
    expect(reworded[0]?.after?.text).toContain('27 years');
  });

  it('finds nothing transcribed against any of it, so nothing blocks the install', () => {
    // True TODAY and stated as a reading rather than an invariant: TRANSCRIBED_SECTIONS is
    // ['Pre-Big One'] and the export does not touch that section. When P5 transcribes the
    // Reconstruction Era, this flips, and it should — that is the gate doing its job.
    expect(report.actionable).toEqual([]);
    expect(report.notes).toHaveLength(report.changed.length);
    expect(report.changed).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// The split: actionable now, versus a note for P5
// ---------------------------------------------------------------------------

describe('the transcribed / untranscribed split', () => {
  /** Re-date one Pre-Big One bullet that `CANON_EVENTS` actually reads. */
  const reDateLazaro = (): CanonBullet[] =>
    beforeBullets.map((bullet) =>
      bullet.text.startsWith('Lazaro Castaneda is born') ? { ...bullet, dateText: '2022' } : bullet,
    );

  it('puts a changed bullet an authored reading claims in the actionable list', () => {
    const changed = buildCanonChangeReport(beforeBullets, reDateLazaro(), WORLD_TIMELINE_SECTIONS);
    expect(changed.actionable).toHaveLength(1);
    expect(changed.actionable[0]?.kind).toBe('re-dated');
    expect(changed.actionable[0]?.claims).toContain('evt_lazaro_born');
    expect(changed.notes).toEqual([]);
  });

  it('says the authored reading no longer resolves, so `db:seed` would throw', () => {
    const changed = buildCanonChangeReport(beforeBullets, reDateLazaro(), WORLD_TIMELINE_SECTIONS);
    expect(changed.actionable[0]?.claimsStillResolve).toBe(false);
  });

  it('flags the quieter failure: a rewording the authored key survives', () => {
    // The claim resolves on `(section, date, textStart)`, so text appended AFTER the prefix
    // leaves it resolving — `db:seed` does not throw, it writes a different
    // `event.description`, because the description is read off the bullet. Nothing else in
    // the repository would say a word about that, which is why it still blocks.
    const after = beforeBullets.map((bullet) =>
      bullet.text.startsWith('Lazaro Castaneda is born')
        ? { ...bullet, text: `${bullet.text} His parents had arrived the year before.` }
        : bullet,
    );
    const changed = buildCanonChangeReport(beforeBullets, after, WORLD_TIMELINE_SECTIONS);
    expect(changed.actionable).toHaveLength(1);
    expect(changed.actionable[0]?.kind).toBe('reworded');
    expect(changed.actionable[0]?.claimsStillResolve).toBe(true);
  });

  it('leaves an untranscribed bullet as a note that blocks nothing', () => {
    const after = beforeBullets.map((bullet) =>
      bullet.line === 946 ? { ...bullet, dateText: '2058' } : bullet,
    );
    const changed = buildCanonChangeReport(beforeBullets, after, WORLD_TIMELINE_SECTIONS);
    expect(changed.actionable).toEqual([]);
    expect(changed.notes).toHaveLength(1);
    expect(changed.notes[0]?.claims).toEqual([]);
  });

  it('counts a non-event claim as transcribed too', () => {
    // A `CanonNonEvent` is a stated decision that a bullet is a thread rather than an
    // event, and `resolveCanonEvents` resolves it through the same key — so it breaks the
    // same way. CANON_NON_EVENTS is empty today; the behaviour is not.
    const bullet = atLine(beforeBullets, 946);
    const claims = claimsOnBullet(
      bullet,
      [],
      [
        {
          section: bullet.section,
          sourceDate: bullet.dateText,
          textStart: bullet.text.slice(0, 12),
          kind: 'thread',
          reason: 'a span, not a moment',
        },
      ],
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]).toContain('non-event thread');
  });
});

// ---------------------------------------------------------------------------
// The restated key has to agree with the guard it was restated from
// ---------------------------------------------------------------------------

describe('claimReadsBullet', () => {
  it('resolves every CANON_EVENT to the same bullet resolveCanonEvents pairs it with', () => {
    // `claimReadsBullet` restates `resolveCanonEvents`'s key because that function THROWS
    // on an unclaimed bullet, which is wrong for seventy legitimately unclaimed ones. This
    // is the check that keeps the two copies honest against the real Bible.
    const transcribed = beforeBullets.filter((bullet) => bullet.section === PRE_BIG_ONE);
    const { paired } = resolveCanonEvents(transcribed);
    expect(paired.length).toBeGreaterThan(0);
    for (const { authored, bullet } of paired) {
      const hits = transcribed.filter((candidate) => claimReadsBullet(authored, candidate));
      expect(hits, authored.id).toHaveLength(1);
      expect(hits[0]?.line, authored.id).toBe(bullet.line);
    }
  });

  it('reports every authored event as claiming exactly one bullet of that corpus', () => {
    for (const authored of CANON_EVENTS) {
      const claimed = beforeBullets.filter((bullet) => claimReadsBullet(authored, bullet));
      expect(claimed, authored.id).toHaveLength(1);
      expect(claimsOnBullet(claimed[0] as CanonBullet), authored.id).toContain(authored.id);
    }
  });

  it('stops reading a bullet whose date moved, and one whose opening was rewritten', () => {
    const authored = CANON_EVENTS[0] as CanonEvent;
    const bullet = beforeBullets.filter((entry) =>
      claimReadsBullet(authored, entry),
    )[0] as CanonBullet;
    expect(claimReadsBullet(authored, { ...bullet, dateText: '2099' })).toBe(false);
    expect(claimReadsBullet(authored, { ...bullet, text: `Later, ${bullet.text}` })).toBe(false);
    expect(claimReadsBullet(authored, { ...bullet, section: RECONSTRUCTION })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The output: the gate, the console report, the committed artifact
// ---------------------------------------------------------------------------

describe('the report as output', () => {
  const blocking = buildCanonChangeReport(
    beforeBullets,
    beforeBullets.map((bullet) =>
      bullet.text.startsWith('Lazaro Castaneda is born') ? { ...bullet, dateText: '2022' } : bullet,
    ),
    WORLD_TIMELINE_SECTIONS,
  );

  it('names the authored reading in the gate detail that refuses --write', () => {
    const detail = actionableGateDetail(blocking).join('\n');
    expect(detail).toContain('evt_lazaro_born');
    expect(detail).toContain('break the seed');
  });

  it('says plainly when nothing transcribed moved', () => {
    expect(actionableGateDetail(report).join('\n')).toContain('none of them transcribed');
  });

  it('prints every section and every changed bullet', () => {
    const printed = renderCanonChangeReport(report).join('\n');
    for (const section of WORLD_TIMELINE_SECTIONS) expect(printed).toContain(section);
    expect(printed).toContain('Max Lauda dies during a public test run');
    expect(printed).toContain('RE-DATED-AND-REWORDED');
    expect(printed).toContain('FOR P5');
  });

  it('drops the per-bullet detail under --quiet but keeps the counts and the block', () => {
    const quiet = renderCanonChangeReport(report, true).join('\n');
    expect(quiet).toContain('80 -> 82 bullet(s)');
    expect(quiet).not.toContain('Max Lauda dies during a public test run');
    expect(renderCanonChangeReport(blocking, true).join('\n')).toContain('ACTIONABLE NOW');
  });

  it('writes an artifact that carries both provenance and the reasoning', () => {
    const markdown = renderCanonChangeMarkdown(report, {
      doc: 'bible',
      title: 'LIFEstream Bible',
      source: 'tmp/bible_drive_raw.txt',
      installedSha256: 'a'.repeat(64),
      stagedSha256: 'b'.repeat(64),
      generatedAt: new Date('2026-09-05T12:00:00.000Z'),
    });
    expect(markdown).toContain('# Canon change report — LIFEstream Bible');
    expect(markdown).toContain('a'.repeat(64));
    expect(markdown).toContain('2026-09-05T12:00:00.000Z');
    // P4B.6.6 — the limit is stated in the artifact itself, not only in the source.
    expect(markdown).toContain('Cities / Orbital Locations / Asteroids');
    expect(markdown).toContain('| Reconstruction Era | 39 | 41 |');
  });

  it('lands beside the provenance record, under the same convention', () => {
    const target = 'data/story_docs/LIFEstream Bible.txt';
    expect(path.dirname(changeReportPathFor(target))).toBe(path.dirname(provenancePathFor(target)));
    expect(changeReportPathFor(target)).toBe('data/story_docs/LIFEstream Bible.canon-change.md');
  });
});
