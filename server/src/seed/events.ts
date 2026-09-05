/**
 * P3.3 — the thin slice: the twelve Pre-Big One bullets, `LIFEstream Bible.txt` L888-899.
 *
 * Twelve, not eighty. The remaining sixty-eight are transcribed in P5 with the Corridor
 * open, because bulk transcription against a schema no view has exercised is transcription
 * against a guess — a wrong precision or a silently-dropped actor is invisible in a seed
 * script and obvious the moment the node renders in the wrong place.
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
 * {@link readPreBigOneBullets}, so it is verbatim by construction. What IS authored is the
 * reading of each bullet: its precision, its category, where it happened, who was in it,
 * and what it is about. {@link CANON_EVENTS} carries each bullet's line number and date
 * phrase, and the seed asserts both against the file before it writes anything — the same
 * shape `leaders.ts` uses. A bullet that moves or is re-dated fails the seed by name
 * instead of silently seeding a stale reading.
 *
 * ── BRACKETS (P3.3.5) ─────────────────────────────────────────────────────────────────
 * None of the twelve sets `range_before_event_id` / `range_after_event_id`. They narrow a
 * window and never source one, and no bullet here narrows another: the only candidate is
 * L896's "people are moved into the mega block before it finishes completion", and
 * bounding a 2037 window above by a 2039 completion removes nothing from it. An optional
 * column that records a relationship it does not constrain is a column later readers will
 * mistake for a date source.
 */
import { and, eq, inArray } from 'drizzle-orm';

import { character, event, eventActor, eventTag, relation } from '../db/schema.js';

import type { CanonDateTools } from './dateTools.js';
import type { Db } from '../db/index.js';
import type { Category, TechLane, WhenPrecision } from '@shared/types/index';

/** One bullet as it stands in the Bible — parsed, never retyped. */
export interface PreBigOneBullet {
  /** 1-based line number in `data/story_docs/LIFEstream Bible.txt`. */
  line: number;
  /** The date phrase before the first `": "` — `"July 10th, 2034, 8:04am"`. */
  dateText: string;
  /** Everything after it, trimmed. Becomes `event.description` verbatim. */
  text: string;
}

/** One character's part in an event. `role` must already be lower-case and trimmed. */
export interface CanonEventActor {
  characterId: string;
  /** Free text, except the reserved `born` / `died` which link a lifespan bound (§2.2). */
  role: string;
}

/** The authored reading of one bullet. Everything canon states is verified, not retyped. */
export interface CanonEvent {
  id: string;
  /** Bible line, asserted against the file before anything is written. */
  line: number;
  /** The bullet's date phrase, asserted against the file. */
  sourceDate: string;
  /** Authored: a short label for the node. The bullet's own prose is the description. */
  title: string;
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
 * The twelve, in Bible order.
 *
 * The precision spread is canon's, not a choice: seven bare years, three day-precision
 * dates, one timestamp and one season.
 *
 * `project_id` is null on all twelve, and that is a fact rather than an omission — the
 * five programmes of P3.2.4 all begin in 2042 or later, so none of the Pre-Big One
 * bullets belongs to one.
 */
export const CANON_EVENTS: readonly CanonEvent[] = [
  {
    id: 'evt_lazaro_born',
    line: 888,
    sourceDate: '2021',
    title: 'Lazaro Castañeda is born',
    precision: 'year',
    precisionValue: '2021',
    category: 'personal',
    // The bullet says Los Angeles; the pre-Big-One stage of the chain, since this is 2021.
    // (Canon disagrees with itself here: L88 has him born in Lancaster and raised in Mojave.
    // The world timeline is what P3.3 transcribes, so the world timeline is what is stored.)
    locationId: 'loc_los_angeles',
    actors: [{ characterId: 'char_lazaro', role: 'born' }],
    tags: ['castaneda'],
  },
  {
    id: 'evt_ines_born',
    line: 889,
    sourceDate: '2025',
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
    line: 890,
    sourceDate: 'July 10th, 2034, 8:04am',
    title: 'The Big One',
    // The one `time`-precision bullet in the twelve. AUTHORING JUDGEMENT: canon writes a
    // wall clock ("8:04am") for an earthquake in California and the column stores UTC. The
    // stated clock is taken at face value as the stored instant rather than shifted by an
    // offset canon never gives — which is also the worked example in `rollDate.ts`'s own
    // documentation (`time` | `2034-07-10T08:04Z`).
    precision: 'time',
    precisionValue: '2034-07-10T08:04Z',
    category: 'disaster',
    // AUTHORING JUDGEMENT: the bullet says the earthquake "hit California", and California
    // is not a location row. The epicenter is: the next bullet is "a study of the epicenter
    // and the chasm opened above it known as 'Disaster Ridge'" (L891). Siting it at the
    // Ridge is what makes the Big One appear in the site's own history.
    locationId: 'loc_disaster_ridge',
    tags: ['big-one', 'disaster-ridge'],
  },
  {
    id: 'evt_disaster_ridge_study',
    line: 891,
    sourceDate: 'August 13th, 2034',
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
    line: 892,
    sourceDate: 'Feb 1st, 2035',
    title: 'Scientists begin probing the Ridge',
    precision: 'day',
    precisionValue: '2035-02-01',
    category: 'scientific',
    // The bullet's "small military base ... formed around the ridge" is COP Isotope (L78),
    // but the bullet does not name it and what is dated is the probing of the Ridge itself.
    locationId: 'loc_disaster_ridge',
    tags: ['disaster-ridge'],
  },
  {
    id: 'evt_megablock_1_groundbreaking',
    line: 893,
    sourceDate: 'Aug 1st, 2035',
    title: "Los Angeles' first Megablock breaks ground",
    precision: 'day',
    precisionValue: '2035-08-01',
    category: 'tech',
    techLane: 'megastructure',
    // Post-Big-One, so the Neo Los Angeles stage of the chain — canon defines Neo Los
    // Angeles as "Name of Los Angeles after the Big One" (L862) without dating the change,
    // and the Big One is the only boundary it gives.
    locationId: 'loc_neo_los_angeles',
    tags: ['megablock', 'big-one'],
  },
  {
    id: 'evt_fob_oasis_designation',
    line: 894,
    sourceDate: 'Late 2035',
    title: 'COP Isotope is redesignated FOB Oasis',
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
    id: 'evt_megablocks_2_8_begin',
    line: 895,
    sourceDate: '2036',
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
    line: 896,
    sourceDate: '2037',
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
    line: 897,
    sourceDate: '2039',
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
    line: 898,
    sourceDate: '2039',
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
    line: 899,
    sourceDate: '2040',
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
 * The `renames` edge between the two rename bullets, matching the
 * `superseded_by_location_id` chain it describes (P3.2.3): old designation → new.
 *
 * P5.6 owns the rest of the relation graph. This one edge ships now because both of its
 * endpoints are inside the twelve, and leaving the pair of rename events unconnected would
 * make the location chain look like the only record of a fact canon states twice.
 */
const CANON_RENAME_EDGE = {
  id: 'rel_renames_fob_oasis_camp_oasis',
  fromEventId: 'evt_fob_oasis_designation',
  toEventId: 'evt_camp_oasis_designation',
  type: 'renames',
  note: 'FOB Oasis → Camp Oasis (Bible L894 → L898), the same step the location chain records.',
} as const;

/**
 * Every bullet under the World Timeline's "Pre-Big One" heading, in document order.
 *
 * This is the CHECK, not the source of the reading — but it IS the source of every
 * `description`, so a bullet edited in the Bible reaches the database on the next seed
 * without anyone retyping it.
 *
 * The heading is disambiguated by the line above it: "Pre-Big One Era" at L420 is a prose
 * section with the same name and no bullets, and matching it instead would seed nothing.
 */
export function readPreBigOneBullets(bibleText: string): PreBigOneBullet[] {
  const lines = bibleText.split(/\r?\n/);
  const headingIndex = lines.findIndex(
    (line, index) =>
      line.trim() === 'Pre-Big One' && lines[index - 1]?.trim() === 'World Timeline:',
  );
  if (headingIndex === -1) return [];

  const bullets: PreBigOneBullet[] = [];
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const raw = (lines[index] ?? '').trim();
    if (!raw.startsWith('* ')) break;

    const body = raw.slice(2).trim();
    // Split on `": "` and not on the first colon: "July 10th, 2034, 8:04am" carries one of
    // its own, and a first-colon split would date that bullet "July 10th, 2034, 8".
    const separator = body.indexOf(': ');
    if (separator === -1) continue;

    bullets.push({
      line: index + 1,
      dateText: body.slice(0, separator).trim(),
      text: body.slice(separator + 2).trim(),
    });
  }
  return bullets;
}

/** A seeded reading that no longer describes the Bible. Rolls the transaction back. */
export class CanonDriftError extends Error {
  override name = 'CanonDriftError';
}

/**
 * Assert {@link CANON_EVENTS} still describes the file, and pair each authored reading
 * with the bullet it reads.
 *
 * @throws {@link CanonDriftError} naming every difference. A bullet that moved, was
 *         re-dated, or was inserted between two others is a transcription that has to be
 *         re-read by a person — seeding a stale reading against a shifted line is exactly
 *         the silent failure this check exists to prevent.
 */
export function resolveCanonEvents(
  bullets: readonly PreBigOneBullet[],
): { authored: CanonEvent; bullet: PreBigOneBullet }[] {
  const problems: string[] = [];

  if (bullets.length !== CANON_EVENTS.length) {
    problems.push(
      `the Bible's Pre-Big One section holds ${bullets.length} bullets, this module reads ` +
        `${CANON_EVENTS.length}`,
    );
  }

  const byLine = new Map(bullets.map((bullet) => [bullet.line, bullet] as const));
  const paired: { authored: CanonEvent; bullet: PreBigOneBullet }[] = [];

  for (const authored of CANON_EVENTS) {
    const bullet = byLine.get(authored.line);
    if (bullet === undefined) {
      problems.push(`${authored.id}: no Pre-Big One bullet at L${authored.line}`);
      continue;
    }
    if (bullet.dateText !== authored.sourceDate) {
      problems.push(
        `${authored.id}: L${authored.line} is dated "${bullet.dateText}", this module read ` +
          `"${authored.sourceDate}"`,
      );
      continue;
    }
    paired.push({ authored, bullet });
  }

  if (problems.length > 0) {
    throw new CanonDriftError(
      `seed: the Pre-Big One transcription no longer matches the Bible:\n  ${problems.join('\n  ')}`,
    );
  }
  return paired;
}

/** What one event seed did. */
export interface EventSeedResult {
  events: { total: number; inserted: number; updated: number; unchanged: number };
  /** `event_actor` rows the twelve ask for, and how many were new. */
  actors: { total: number; inserted: number };
  /** `event_tag` rows the twelve ask for, and how many were new. */
  tags: { total: number; inserted: number };
  relations: { total: number; inserted: number; updated: number; unchanged: number };
  /** `character` rows whose lifespan cache a `born`/`died` event moved. */
  lifespansRefreshed: number;
  /** One line per event, for the seed log and the date proof. */
  dates: EventDateReport[];
}

/** The derived date quad of one event, as the log prints it. */
export interface EventDateReport {
  id: string;
  line: number;
  sourceDate: string;
  precision: WhenPrecision;
  whenMin: string;
  whenMax: string;
  when: string;
}

/**
 * Write the twelve events, their actors, their tags and the one `renames` edge, then
 * refresh the lifespan caches the `born` roles just became the authority for.
 *
 * Call inside a transaction — `runSeed` owns it. Every write upserts on a natural key and
 * nothing is deleted; a row that already matches is skipped rather than rewritten, so the
 * second run issues no statement and the file stays byte-identical (§7.4).
 */
export function seedEvents(
  db: Db,
  saveId: string,
  bullets: readonly PreBigOneBullet[],
  tagIdsByName: ReadonlyMap<string, string>,
  tools: CanonDateTools,
): EventSeedResult {
  const paired = resolveCanonEvents(bullets);

  const missingTags = [
    ...new Set(
      CANON_EVENTS.flatMap((authored) => authored.tags).filter((name) => !tagIdsByName.has(name)),
    ),
  ];
  if (missingTags.length > 0) {
    throw new CanonDriftError(
      `seed: the twelve Pre-Big One events tag ${missingTags.length} name(s) the P3.1 ` +
        `vocabulary does not carry: ${missingTags.join(', ')}. Tagging is part of seeding an ` +
        `event, so a missing tag is a missing event, not a missing chip.`,
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
    // Seeded on the event id — which is why two bullets both dated "2039" get two
    // different instants, and why neither of them moves on a re-seed (P3.3.2).
    const when = tools.rollDate(authored.id, whenMin, whenMax);

    dates.push({
      id: authored.id,
      line: authored.line,
      sourceDate: authored.sourceDate,
      precision: authored.precision,
      whenMin,
      whenMax,
      when,
    });

    const values = {
      title: authored.title,
      // Verbatim from the Bible, never retyped.
      description: bullet.text,
      whenMin,
      whenMax,
      whenPrecision: authored.precision,
      when,
      category: authored.category,
      techLane: authored.techLane ?? null,
      locationId: authored.locationId ?? null,
      projectId: authored.projectId ?? null,
      // P3.3.5: no bullet in the twelve narrows another's window. See the module header.
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
      .map((row) => `${row.eventId} ${row.characterId} ${row.role}`),
  );

  let inserted = 0;
  for (const row of wanted) {
    if (existing.has(`${row.eventId} ${row.characterId} ${row.role}`)) continue;
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
      .map((row) => `${row.eventId} ${row.tagId}`),
  );

  let inserted = 0;
  for (const row of wanted) {
    if (existing.has(`${row.eventId} ${row.tagId}`)) continue;
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
    .where(and(eq(eventActor.saveId, saveId), inArray(eventActor.role, ['born', 'died'])))
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
