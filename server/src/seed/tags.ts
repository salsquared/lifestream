/**
 * P3.1 — the canonical tag vocabulary.
 *
 * GLOBAL (no `save_id`): one list shared by every save, which is the whole reason
 * `timeline.membership_rules.byTag` survives a fork untouched (§2.1, §2.6). Seeded
 * BEFORE any event exists, because tagging is a step of the event seed and not a later
 * pass — retro-tagging eighty bullets by hand is exactly what this ordering avoids
 * (§7.4). Five features read this table (timeline `byTag` rules, the relation-suggestion
 * heuristic, the filter chips, cluster derivation, the tag autocomplete) and all five
 * are no-ops that look implemented while it is empty.
 *
 * ── WHAT A TAG IS (P3.1.3) ────────────────────────────────────────────────────────────
 * A tag is a **subject** — the thing an event is *about*. It is NOT a category and NOT a
 * location: `event.category` is a closed enum and `event.location_id` is a foreign key,
 * and both already exist. So there is no `disaster` tag (that is a category) and no
 * `los-angeles` tag (that is a location row). `disaster-ridge` IS a tag, because the site
 * and its sixty-year story are a subject that runs across five location rows and four
 * categories; `castaneda` and `pallas` are subjects for the same reason.
 *
 * A per-save tag vocabulary is explicitly out of scope for v1.
 *
 * ── IDEMPOTENT BY NAME (P3.1.2) ───────────────────────────────────────────────────────
 * The natural key is `name`, not `id` — so a tag someone created in the app under a name
 * this table also carries is ADOPTED (updated in place, keeping its runtime id) rather
 * than duplicated into a second row that `byTag` rules would then have to name twice.
 * `is_retired` is never written on an update: a soft delete is a person's decision, and
 * re-running the seed must not undo it.
 */
import { sql } from 'drizzle-orm';

import { tag } from '../db/schema.js';

import type { Db } from '../db/index.js';

/** One authored tag. `name` is the natural key and the chip label. */
export interface CanonTag {
  /** `tag_<slug>` — the seed's readable-slug id convention (§2.1). */
  id: string;
  /** Kebab slug, exactly as P3.1.1 drafts it. UNIQUE, and what `byTag` rules are written against. */
  name: string;
  /** `#rrggbb`, lower case — the shape the map export already uses for `grouping.color`. */
  color: string;
  /** One line, drawn from the Bible's own glossary wherever it has an entry. */
  description: string;
}

/**
 * Twenty-six subjects, drawn from the Bible's own vocabulary. The first twenty are
 * P3.1.1's draft list verbatim; the last six are glossary headwords that the twelve
 * Pre-Big One bullets and their immediate neighbours actually need.
 */
export const CANON_TAGS: readonly CanonTag[] = [
  {
    id: 'tag_black_fever',
    name: 'black-fever',
    color: '#b2453c',
    description:
      'The ultra-deadly, head-exploding virus engineered in North Korea that kills almost 900 million people in the 2040s.',
  },
  {
    id: 'tag_sour_rain',
    name: 'sour-rain',
    color: '#8fa03a',
    description:
      'Corrosive, faintly radioactive rainfall left by the North Korean salted bomb — acidic and radioactive at once.',
  },
  {
    id: 'tag_disaster_ridge',
    name: 'disaster-ridge',
    color: '#c07a35',
    description:
      'The chasm opened along the San Andreas Fault by the Big One, and the sixty-year site history that runs COP Isotope → Star City.',
  },
  {
    id: 'tag_megablock',
    name: 'megablock',
    color: '#7a8899',
    description:
      "Los Angeles' mega-housing arcologies, raised to house the Angelenos the Big One unhoused.",
  },
  {
    id: 'tag_project_xero',
    name: 'project-xero',
    color: '#3f8fa8',
    description:
      "The United Earth operation to cure and eradicate Black Fever — the Bible's 'single most important operation in human history'.",
  },
  {
    id: 'tag_fusion',
    name: 'fusion',
    color: '#d9a441',
    description:
      'Nuclear fusion: the Lithium-6 that breeds it, the D-He³ and p-B¹¹ reactors, and the energy economy built on both.',
  },
  {
    id: 'tag_dfd',
    name: 'dfd',
    color: '#d97a41',
    description:
      'Direct Fusion Drive — propulsion that pushes a craft with the plasma of the fusion reaction itself.',
  },
  {
    id: 'tag_space_elevator',
    name: 'space-elevator',
    color: '#6f8fd9',
    description:
      'Earth Tower 1: the hybrid Space Fountain and Space Tether raised on Disaster Ridge, and everything built to serve it.',
  },
  {
    id: 'tag_asteroid_mining',
    name: 'asteroid-mining',
    color: '#8a6f4f',
    description:
      "MEGACORP's asteroid programmes — Athena to Etna, Aurum to Chrysus — and the crews sent to work them.",
  },
  {
    id: 'tag_holovision',
    name: 'holovision',
    color: '#b06fd9',
    description:
      'The neural sight-and-sound consumer device released by Dal in three versions, and the technical ancestor of LIFEstream.',
  },
  {
    id: 'tag_lifestream',
    name: 'lifestream',
    color: '#d94f8a',
    description:
      "Dal's full-sensory broadcast system: a Conduit transmits their lived experience to Receivers through a Cranial Port.",
  },
  {
    id: 'tag_neucomp',
    name: 'neucomp',
    color: '#4fbfa8',
    description:
      'The synthetic neural computer invented at Gran Sasso in early 2044, and the bio-compute industry grown around it.',
  },
  {
    id: 'tag_daemon',
    name: 'daemon',
    color: '#7f6fd9',
    description:
      "A personal neucomp grown from its user's own brain tissue that speaks to them in a voice only they can hear.",
  },
  {
    id: 'tag_hrl',
    name: 'hrl',
    color: '#d94f4f',
    description:
      'The Helios Racing League — miniaturised DFD spacecraft raced along Earth Tower 1, and the Helios Cup it runs for.',
  },
  {
    id: 'tag_castaneda',
    name: 'castaneda',
    color: '#d98f4f',
    description: 'The Castañeda family line: Lazaro, Ines, and their sons Adan and Xavier.',
  },
  {
    id: 'tag_pallas',
    name: 'pallas',
    color: '#6f6f8f',
    description: 'Atticus Pallas, his mandate, and the clone Deimos Vane made in his image.',
  },
  {
    id: 'tag_uea',
    name: 'uea',
    color: '#4f8fd9',
    description:
      "United Earth: the Black Fever era's replacement for the United Nations, and far stronger than its predecessor.",
  },
  {
    id: 'tag_megacorp',
    name: 'megacorp',
    color: '#a8a04f',
    description:
      'The megacorporations and the great mergers that made them — horizontal, syndicated, monolithic, parasitic and state.',
  },
  {
    id: 'tag_nk_war',
    name: 'nk-war',
    color: '#8f4f4f',
    description:
      "Kim Jung Un's misfired missile, the allied invasion of North Korea, and the salted bomb that ended it.",
  },
  {
    id: 'tag_reconstruction',
    name: 'reconstruction',
    color: '#5faf6f',
    description:
      'The rebuilding of the world after the Black Fever Pandemic, beginning around 2047.',
  },
  {
    id: 'tag_big_one',
    name: 'big-one',
    color: '#c0483f',
    description:
      "The largest earthquake in California's history, 2034 — it destroyed southern and central California and opened Disaster Ridge.",
  },
  {
    id: 'tag_helium_3',
    name: 'helium-3',
    color: '#5fc0c0',
    description:
      'The D-He³ fuel isotope, bred from Lithium-6 on Earth and swept from the lunar surface — control of its supply is control of energy.',
  },
  {
    id: 'tag_automata',
    name: 'automata',
    color: '#909090',
    description:
      'Anthropomorphic robots built by United Earth to work the hazardous jobs the Black Fever made lethal for people.',
  },
  {
    id: 'tag_eidolon',
    name: 'eidolon',
    color: '#a06fc0',
    description:
      "A virtual copy of a person's brain captured at one instant, hosted by Cognis and sold through the Afterlife Program.",
  },
  {
    id: 'tag_lunar_economy',
    name: 'lunar-economy',
    color: '#b8b8a0',
    description:
      'Helium-3 extraction on the Moon and the regolith stream it spoils: Processed Regolith up to Atlas, Cast Mare Regolith down the tower.',
  },
  {
    id: 'tag_drops',
    name: 'drops',
    color: '#6fc08a',
    description:
      'Neuro-Optic Stabilizer Solution (NOSS) — the eye drops a whole generation doses itself through Black Fever trauma with.',
  },
];

/** What one tag seed did. */
export interface TagSeedResult {
  /** Rows the vocabulary asks for. */
  total: number;
  inserted: number;
  /** Rows that existed under this name and differed. */
  updated: number;
  /** Rows that existed and already matched — no statement was issued for them. */
  unchanged: number;
  /** Rows adopted under a runtime id because a row already carried the name. */
  adopted: number;
}

/**
 * Upsert the vocabulary, keyed on `name` (P3.1.2).
 *
 * A row that already matches is SKIPPED rather than rewritten, for the same reason
 * `seedCountries` skips one: an UPDATE with identical values still dirties its page, so
 * a blanket rewrite leaves a different file behind every run and there is nothing left
 * to compare (§7.4).
 *
 * Never destructive: a tag this run did not name is left alone, because `event_tag`
 * rows and `byTag` rules in any save may point at it.
 */
export function seedTags(db: Db): TagSeedResult {
  const existing = db
    .select({
      id: tag.id,
      name: tag.name,
      color: tag.color,
      description: tag.description,
    })
    .from(tag)
    .all();
  const byName = new Map(existing.map((row) => [row.name, row] as const));
  const byId = new Map(existing.map((row) => [row.id, row] as const));

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let adopted = 0;

  for (const authored of CANON_TAGS) {
    // Identity by NAME first. A tag someone typed in the app under this name holds a
    // ULID id; writing the authored id beside it would put the same subject in the
    // vocabulary twice, and `byTag` rules would then have to list both.
    const holder = byName.get(authored.name);
    if (holder !== undefined && holder.id !== authored.id) adopted += 1;
    const id = holder?.id ?? authored.id;
    const current = holder ?? byId.get(id);

    if (
      current !== undefined &&
      current.name === authored.name &&
      current.color === authored.color &&
      current.description === authored.description
    ) {
      unchanged += 1;
      continue;
    }
    if (current !== undefined) updated += 1;
    else inserted += 1;

    db.insert(tag)
      .values({
        id,
        name: authored.name,
        color: authored.color,
        description: authored.description,
        // Insert-only. `is_retired` is a person's soft delete, not source data — the
        // same rule that keeps `save.parent_save_id` out of `seedMapSave`'s update set.
        isRetired: false,
      })
      .onConflictDoUpdate({
        target: tag.id,
        set: { name: authored.name, color: authored.color, description: authored.description },
      })
      .run();
  }

  return { total: CANON_TAGS.length, inserted, updated, unchanged, adopted };
}

/** `tag.id` for every authored tag, by name — what the event seed tags rows with. */
export function readTagIdsByName(db: Db): Map<string, string> {
  return new Map(
    db
      .select({ id: tag.id, name: tag.name })
      .from(tag)
      .all()
      .map((row) => [row.name, row.id] as const),
  );
}

/** Row count of the whole table — global, so it is not scoped to a save. */
export function countTagRows(db: Db): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(tag)
      .get()?.n ?? 0
  );
}
