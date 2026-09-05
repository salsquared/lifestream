import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CATEGORIES, RELATION_TYPES, TECH_LANES } from '@server/db/schema';
import { CATEGORY_COLOR, RELATION_COLOR, TECH_LANE_COLOR } from '@shared/colors';

import type { Category, RelationType, TechLane } from '@shared/types/index';

/**
 * P4.3.6 — one palette for both 3D views and the export renderer.
 *
 * ── WHY THIS SPEC EXISTS ─────────────────────────────────────────────────────────────
 * A missing colour is not a crash. `CATEGORY_COLOR[c]` returning `undefined` gives
 * three.js an unusable material value, which it resolves to black — so the node renders,
 * on a black starfield, invisibly. The event is gone from the flagship view and nothing
 * anywhere says so. In the export renderer the same `undefined` becomes the literal
 * string "undefined" in a `fill` attribute, which the browser drops just as quietly.
 *
 * `tsc` already rejects a record that is not total over the TS union — that annotation is
 * the primary guard and it is the reason the modules are typed the way they are. What it
 * cannot see is the OTHER declaration of each enum: `server/src/db/schema.ts` holds the
 * runtime member arrays behind the `CHECK` constraints, and a member added there is a
 * value the database will accept and this palette will not colour. So the checks below
 * are against the DATABASE's member lists, not against the TypeScript unions.
 *
 * The rest is about the values being usable by both consumers at once: real six-digit
 * hex (three.js will take a CSS colour name; an HTML `fill` will take one too; neither
 * will take the other's shorthand reliably), and distinct from each other, because a
 * palette whose members collide encodes nothing.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const CANON_SAVE_ID = 'sav_canon';

/** Exactly `#` + six lowercase hex digits — the one form both consumers take verbatim. */
const HEX = /^#[0-9a-f]{6}$/;

const PALETTES = [
  ['CATEGORY_COLOR', CATEGORY_COLOR, CATEGORIES],
  ['TECH_LANE_COLOR', TECH_LANE_COLOR, TECH_LANES],
  ['RELATION_COLOR', RELATION_COLOR, RELATION_TYPES],
] as const;

// ---------------------------------------------------------------------------
// Totality — against the enum the DATABASE enforces
// ---------------------------------------------------------------------------

describe('every palette is total over its closed enum', () => {
  for (const [name, palette, members] of PALETTES) {
    it(`${name} colours exactly the members schema.ts constrains`, () => {
      expect(Object.keys(palette).sort()).toEqual([...members].sort());
    });

    it(`${name} has no key the enum does not have`, () => {
      for (const key of Object.keys(palette)) {
        expect(members as readonly string[], `${name}.${key} is not an enum member`).toContain(key);
      }
    });
  }

  it('CATEGORY_COLOR has seven members and no `project`', () => {
    // `project` was deliberately dropped from the enum — it duplicated the `projectId`
    // FK (§2.1). A palette that carries it is a palette written against a stale schema.
    expect(Object.keys(CATEGORY_COLOR)).toHaveLength(7);
    expect(CATEGORY_COLOR).not.toHaveProperty('project');
  });

  it('TECH_LANE_COLOR has six members', () => {
    expect(Object.keys(TECH_LANE_COLOR)).toHaveLength(6);
  });

  it('resolves a colour for every member by lookup, not just by key presence', () => {
    for (const category of CATEGORIES) {
      const colour: string | undefined = CATEGORY_COLOR[category as Category];
      expect(colour, `no colour for category ${category}`).toBeTruthy();
    }
    for (const lane of TECH_LANES) {
      expect(TECH_LANE_COLOR[lane as TechLane], `no colour for lane ${lane}`).toBeTruthy();
    }
    for (const type of RELATION_TYPES) {
      expect(RELATION_COLOR[type as RelationType], `no colour for relation ${type}`).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// The values are usable by both consumers
// ---------------------------------------------------------------------------

describe('every colour is a form both three.js and an HTML export take verbatim', () => {
  for (const [name, palette] of PALETTES) {
    it(`${name} values are #rrggbb, lowercase`, () => {
      for (const [key, value] of Object.entries(palette)) {
        expect(value, `${name}.${key}`).toMatch(HEX);
      }
    });
  }

  it('no palette repeats a colour within itself', () => {
    for (const [name, palette] of PALETTES) {
      const values = Object.values(palette);
      expect(new Set(values).size, `${name} has a duplicate colour`).toBe(values.length);
    }
  });

  it('keeps the node palettes apart from each other', () => {
    // A Tech Tree node is coloured by lane and a Corridor node by category; the same hex
    // in both would make a cross-jump between the views look like a colour change that
    // means something.
    const overlap = Object.values(CATEGORY_COLOR).filter((c) =>
      (Object.values(TECH_LANE_COLOR) as string[]).includes(c),
    );
    expect(overlap).toEqual([]);
  });

  it('keeps relation arcs dimmer than the nodes they join', () => {
    // The design rule from colors.ts, made checkable: every arc colour sits below the
    // DARKEST category colour in luma. An arc that out-glows its endpoints inverts the
    // reading order under bloom — the eye lands on the relationship, not on the events.
    const luma = (hex: string): number => {
      const n = Number.parseInt(hex.slice(1), 16);
      // Rec. 601 luma, enough to rank brightness; nothing here needs a colour space.
      return 0.299 * ((n >> 16) & 0xff) + 0.587 * ((n >> 8) & 0xff) + 0.114 * (n & 0xff);
    };
    const brightestArc = Math.max(...Object.values(RELATION_COLOR).map(luma));
    const dimmestNode = Math.min(...Object.values(CATEGORY_COLOR).map(luma));
    expect(brightestArc).toBeLessThan(dimmestNode);
  });
});

// ---------------------------------------------------------------------------
// The palettes cannot be edited underneath a consumer
// ---------------------------------------------------------------------------

describe('the palettes are frozen', () => {
  for (const [name, palette] of PALETTES) {
    it(`${name} cannot be mutated at runtime`, () => {
      // Both consumers read these on every frame / every export row. A view that patched
      // one for a hover state would change it for the export renderer too.
      expect(Object.isFrozen(palette)).toBe(true);
      expect(() => {
        (palette as Record<string, string>).tech = '#000000';
      }).toThrow(TypeError);
    });
  }

  it('still reports the original colours after the attempts above', () => {
    expect(CATEGORY_COLOR.tech).toMatch(HEX);
    expect(CATEGORY_COLOR.tech).not.toBe('#000000');
  });
});

// ---------------------------------------------------------------------------
// The values actually stored
// ---------------------------------------------------------------------------

const dbPath = `${repoRoot}data/lifestream.db`;
const dbPresent = existsSync(dbPath);

/** Skipped on a fresh clone: `data/*.db` is gitignored and rebuilt (§7.4). */
describe.skipIf(!dbPresent)('every value on disk has a colour', () => {
  it('colours every category and tech lane the seeded events actually use', () => {
    const db = new DatabaseSync(`file:${dbPath}?mode=ro`, { readOnly: true });
    let rows: Array<{ category: string; tech_lane: string | null }>;
    try {
      rows = db
        .prepare(`select distinct category, tech_lane from event where save_id = ?`)
        .all(CANON_SAVE_ID) as unknown as Array<{ category: string; tech_lane: string | null }>;
    } finally {
      db.close();
    }

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(CATEGORY_COLOR[row.category as Category], `category ${row.category}`).toMatch(HEX);
      if (row.tech_lane !== null) {
        expect(TECH_LANE_COLOR[row.tech_lane as TechLane], `lane ${row.tech_lane}`).toMatch(HEX);
      }
    }
  });
});
