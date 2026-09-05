/**
 * Thirteen real seeded events, read out of `data/lifestream.db` verbatim — the corridor's
 * fallback corpus.
 *
 * The shell owns the per-save load (architecture §4.2, P4.1): `useSaveLoad` fetches
 * `GET /api/timelines/tl_world/resolve` once per save and hydrates `useWorld`, and this
 * view subscribes to that store and issues no query of its own. This fixture is what it
 * draws before any load has been attempted, or after one has failed — no API server
 * running, say — so the layout can be looked at without a backend. `TimelineView` shows a
 * badge naming it whenever it is in use, because a corridor silently drawing stale canon
 * while the real load failed is exactly the kind of thing that goes unnoticed.
 *
 * **The choice is made by `corpus.ts`, on the load's STATUS, and never on a row count.**
 * That distinction is the whole of the P4 review's second finding: `rows.length === 0`
 * conflates *not loaded yet* with *loaded, and genuinely empty*, so a real save with no
 * events rendered these thirteen fictional canon events under a badge saying no save was
 * hydrated — while the store reported `ready`. An empty save gets an empty corridor. Do
 * not reintroduce a row-count test here or in the view.
 *
 * It is a snapshot, not a source of truth. The database is authoritative; regenerate this
 * file from it rather than hand-editing a date here. It covers all seven categories and
 * four of the six precisions, which is what makes it useful for eyeballing the band
 * layout — every band has at least one node in it.
 */

import type { HydratedEvent } from '@shared/types/index';

/**
 * Sorted by `when`, then by id — the same order the resolve endpoint returns.
 *
 * Typed as a NON-EMPTY tuple, not a plain array. The original reason — that the view
 * derived the scale's origin from the earliest `when` it held — is gone: the origin is
 * `CORRIDOR_START`, a process constant, so an empty fixture would no longer make it
 * `undefined`. The tuple stays because the property it encodes is still the one worth
 * holding: a fallback corpus with nothing in it is a fallback that draws an empty screen
 * and reports success, which is the same class of silent lie the status gate above exists
 * to close. `tsc` refuses to let this file become empty.
 */
export const CORRIDOR_FIXTURE: readonly [HydratedEvent, ...HydratedEvent[]] = [
  {
    id: 'evt_lazaro_born',
    saveId: 'sav_canon',
    title: 'Lazaro Castañeda is born',
    description: 'Lazaro Castaneda is born in Los Angeles.',
    whenMin: '2021-01-01T00:01:00.000Z',
    whenMax: '2021-12-31T23:59:00.000Z',
    whenPrecision: 'year',
    when: '2021-02-09T10:15:00.000Z',
    category: 'personal',
    locationId: 'loc_los_angeles',
    actorIds: ['char_lazaro'],
    tagIds: ['tag_castaneda'],
  },
  {
    id: 'evt_ines_born',
    saveId: 'sav_canon',
    title: 'Ines Cardenas is born',
    description: 'Ines Cardenas is born in Los Angeles.',
    whenMin: '2025-01-01T00:01:00.000Z',
    whenMax: '2025-12-31T23:59:00.000Z',
    whenPrecision: 'year',
    when: '2025-01-07T10:51:00.000Z',
    category: 'personal',
    locationId: 'loc_los_angeles',
    actorIds: ['char_ines'],
    tagIds: ['tag_castaneda'],
  },
  {
    id: 'evt_big_one',
    saveId: 'sav_canon',
    title: 'The Big One',
    description:
      'An earthquake colloquially known as “The Big One” that had been anticipated for decades since the last 1906 San Francisco Earthquake hit California.',
    whenMin: '2034-07-10T08:04:00.000Z',
    whenMax: '2034-07-10T08:04:00.000Z',
    whenPrecision: 'time',
    when: '2034-07-10T08:04:00.000Z',
    category: 'disaster',
    locationId: 'loc_disaster_ridge',
    actorIds: [],
    tagIds: ['tag_big_one', 'tag_disaster_ridge'],
  },
  {
    id: 'evt_disaster_ridge_study',
    saveId: 'sav_canon',
    title: 'The US government commissions the Disaster Ridge study',
    description:
      'The US government commissions a study of the epicenter and the chasm opened above it known as “Disaster Ridge.”',
    whenMin: '2034-08-13T00:01:00.000Z',
    whenMax: '2034-08-13T23:59:00.000Z',
    whenPrecision: 'day',
    when: '2034-08-13T20:51:00.000Z',
    category: 'political',
    locationId: 'loc_disaster_ridge',
    actorIds: [],
    tagIds: ['tag_big_one', 'tag_disaster_ridge'],
  },
  {
    id: 'evt_ridge_probing_begins',
    saveId: 'sav_canon',
    title: 'Scientists begin probing the Ridge',
    description:
      'Once the area was secured and a small military base was formed around the ridge, scientists moved in and began probing the Ridge. At first with satellites, then aerial and terrestrial drones they slowly ventured and mapped deeper and deeper towards the floor of the ridge.',
    whenMin: '2035-02-01T00:01:00.000Z',
    whenMax: '2035-02-01T23:59:00.000Z',
    whenPrecision: 'day',
    when: '2035-02-01T11:41:00.000Z',
    category: 'scientific',
    locationId: 'loc_disaster_ridge',
    actorIds: [],
    tagIds: ['tag_disaster_ridge'],
  },
  {
    id: 'evt_megablock_1_groundbreaking',
    saveId: 'sav_canon',
    title: "Los Angeles' first Megablock breaks ground",
    description:
      'With thousands of Angelenos now unhoused from the Big Ones destruction, Los Angeles’ first mega-housing building breaks ground.',
    whenMin: '2035-08-01T00:01:00.000Z',
    whenMax: '2035-08-01T23:59:00.000Z',
    whenPrecision: 'day',
    when: '2035-08-01T13:54:00.000Z',
    category: 'tech',
    techLane: 'megastructure',
    locationId: 'loc_neo_los_angeles',
    actorIds: [],
    tagIds: ['tag_big_one', 'tag_megablock'],
  },
  {
    id: 'evt_ridge_first_elevator',
    saveId: 'sav_canon',
    title: 'The first Top Ridge–Bottom Ridge elevator is built',
    description:
      'The first elevator connecting Top Ridge to Bottom Ridge is constructed, allowing heavy equipment and miners to reach the floor of the chasm for the first time.',
    whenMin: '2035-10-01T00:01:00.000Z',
    whenMax: '2035-12-31T23:59:00.000Z',
    whenPrecision: 'season',
    when: '2035-10-20T14:00:00.000Z',
    category: 'tech',
    techLane: 'megastructure',
    locationId: 'loc_fob_oasis',
    actorIds: [],
    tagIds: ['tag_disaster_ridge', 'tag_helium_3'],
  },
  {
    id: 'evt_fob_oasis_designation',
    saveId: 'sav_canon',
    title: 'COP Isotope is redesignated FOB Oasis',
    description:
      'As extraction operations scale up and the site requires broader logistical and personnel support, COP Isotope is redesignated Forward Operating Base Oasis (FOB Oasis).',
    whenMin: '2035-10-01T00:01:00.000Z',
    whenMax: '2035-12-31T23:59:00.000Z',
    whenPrecision: 'season',
    when: '2035-12-11T14:30:00.000Z',
    category: 'military',
    locationId: 'loc_fob_oasis',
    actorIds: [],
    tagIds: ['tag_disaster_ridge', 'tag_helium_3'],
  },
  {
    id: 'evt_megablocks_2_8_begin',
    saveId: 'sav_canon',
    title: 'Megablocks 2 through 8 begin construction',
    description: 'Megablock 2 through 8 begin construction.',
    whenMin: '2036-01-01T00:01:00.000Z',
    whenMax: '2036-12-31T23:59:00.000Z',
    whenPrecision: 'year',
    when: '2036-10-07T05:55:00.000Z',
    category: 'tech',
    techLane: 'megastructure',
    locationId: 'loc_neo_los_angeles',
    actorIds: [],
    tagIds: ['tag_megablock'],
  },
  {
    id: 'evt_megablock_early_occupancy',
    saveId: 'sav_canon',
    title: 'People move into the Megablock before it is finished',
    description:
      'Due to immense demand, people are moved into the mega block before it finishes completion.',
    whenMin: '2037-01-01T00:01:00.000Z',
    whenMax: '2037-12-31T23:59:00.000Z',
    whenPrecision: 'year',
    when: '2037-02-23T08:30:00.000Z',
    category: 'cultural',
    locationId: 'loc_neo_los_angeles',
    actorIds: [],
    tagIds: ['tag_megablock'],
  },
  {
    id: 'evt_camp_oasis_designation',
    saveId: 'sav_canon',
    title: 'FOB Oasis is redesignated Camp Oasis',
    description:
      'FOB Oasis is redesignated Camp Oasis as the installation transitions from a temporary forward operating base to a permanent fortified garrison. Permanent housing is established on the flattened bottom level of the Ridge. Lazaro is among the first Marines to receive a permanent billet there.',
    whenMin: '2039-01-01T00:01:00.000Z',
    whenMax: '2039-12-31T23:59:00.000Z',
    whenPrecision: 'year',
    when: '2039-08-07T00:30:00.000Z',
    category: 'military',
    locationId: 'loc_camp_oasis',
    actorIds: ['char_lazaro'],
    tagIds: ['tag_castaneda', 'tag_disaster_ridge'],
  },
  {
    id: 'evt_megablock_1_complete',
    saveId: 'sav_canon',
    title: 'Megablock 1 is completed',
    description: 'Built at an unprecedented pace, Megablock 1 finishes construction.',
    whenMin: '2039-01-01T00:01:00.000Z',
    whenMax: '2039-12-31T23:59:00.000Z',
    whenPrecision: 'year',
    when: '2039-08-16T20:00:00.000Z',
    category: 'tech',
    techLane: 'megastructure',
    locationId: 'loc_neo_los_angeles',
    actorIds: [],
    tagIds: ['tag_megablock'],
  },
  {
    id: 'evt_megablocks_2_4_complete',
    saveId: 'sav_canon',
    title: 'Megablocks 2-4 complete the first generation',
    description: 'Megablock 2-4, the last of the first generation Megablock are completed.',
    whenMin: '2040-01-01T00:01:00.000Z',
    whenMax: '2040-12-31T23:59:00.000Z',
    whenPrecision: 'year',
    when: '2040-08-14T01:35:00.000Z',
    category: 'tech',
    techLane: 'megastructure',
    locationId: 'loc_neo_los_angeles',
    actorIds: [],
    tagIds: ['tag_megablock'],
  },
];
