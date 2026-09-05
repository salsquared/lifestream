import { useState } from 'react';

import type { Grouping } from '@shared/types/index';

import { PROJECTIONS, PROJECTION_IDS } from './renderer';

import type { ProjectionId } from './renderer';

/**
 * The World Map sidebar (P2.4) — projection picker, the save's unified nations, and the
 * forms that create and edit them.
 *
 * PRESENTATIONAL: props in, callbacks out. It holds exactly one piece of state of its own
 * — which row's inline rename/recolor form is open — because that is a property of this
 * panel and of nothing else. Everything the map also depends on (which grouping is being
 * edited, what is staged, what the primary is) belongs to the container, since the
 * renderer is drawing from the same values.
 *
 * THREE KINDS OF "EDITING" MEET HERE AND THEY ARE NOT THE SAME THING:
 *   · `editingGroupingId` — the P2.4.3 toggle. While it is set, clicks ON THE MAP change
 *     that nation's membership. It is the container's, because the renderer needs it too.
 *   · `renamingId` — this panel's inline name/color form. Local, and closing it changes
 *     nothing anywhere else.
 *   · `leadingId` — this panel's inline leader picker (P3.7.2). Local for the same reason:
 *     which row has its picker open changes nothing the map draws.
 * They are deliberately independent: renaming a nation while pointing at it on the map is
 * an ordinary thing to want.
 *
 * ── THE LEADER PICKER APPLIES ON CHANGE, THE RENAME FORM ON SUBMIT ──────────────────
 * The rename form holds a draft, so it needs a Save. The leader picker does not: its whole
 * input is one choice out of the union's members, and there is no half-typed state for a
 * submit to guard. Picking writes, and the select then shows the value from props — which
 * is the optimistic state and then the server's, so a refused write visibly snaps back
 * instead of leaving a draft that disagrees with the map.
 *
 * The projection picker's OPTIONS are not declared in this file: `PROJECTIONS` carries each
 * projection's label beside the factory that builds it (P2.1.3), so the list a reader picks
 * from and the list `projectionFor` can actually build are one list. A local label table
 * would compile perfectly while offering a projection the renderer does not have.
 */

/**
 * A country in one of this panel's lists: a staged chip, or a union member in the leader
 * picker. One shape for both, so P3.7.2 needed no type of its own.
 */
export type NamedCountry = { id: string; name: string };

/** A country staged for a bulk unify, with the name to print on its chip. */
export type StagedCountry = NamedCountry;

export type SidebarProps = {
  projection: ProjectionId;
  onProjectionChange: (projection: ProjectionId) => void;

  groupings: readonly Grouping[];
  memberCounts: ReadonlyMap<string, number>;
  /** `grouping_id -> the display name of its leader country`, where one is marked (§2.4). */
  leaderNames: ReadonlyMap<string, string>;
  /**
   * `grouping_id -> its leader's country id`. The ids beside {@link leaderNames}'s names,
   * because the picker's `value` is an id and a name is not a key — two members of one
   * union can carry the same display name once the author renames one of them.
   */
  leaderIds: ReadonlyMap<string, string>;
  /**
   * `grouping_id -> its member countries`, named and ordered for the leader picker.
   *
   * The panel does not otherwise list members — the map does — so this arrives only
   * because P3.7.2 has to name one of them. Ordering is the container's: this component
   * prints the list it is handed.
   */
  membersByGrouping: ReadonlyMap<string, readonly NamedCountry[]>;
  countryCount: number;
  independentCount: number;

  /** Set when the primary is a grouping — the sidebar's half of P2.7.2. */
  primaryGroupingId?: string;
  /** Groupings in `useGlow().groupingIds`, lit from another view's selection (§6). */
  glowGroupingIds: ReadonlySet<string>;
  editingGroupingId: string | null;

  staged: readonly StagedCountry[];

  onSelectGrouping: (groupingId: string) => void;
  onToggleEditing: (groupingId: string) => void;
  onCreateGrouping: (draft: { name: string; color: string }) => void;
  onUpdateGrouping: (groupingId: string, patch: { name: string; color: string }) => void;
  onDeleteGrouping: (groupingId: string) => void;
  /**
   * P3.7.2 — mark a member as this union's leader, or clear the union's leader with
   * `null`. `is_leader` had no write path before this: it was seeded from the Bible and
   * cleared by every move, so an author who moved a leading country lost a fact no file in
   * the repo could give back.
   */
  onSetLeader: (groupingId: string, countryId: string | null) => void;
  onUnstage: (countryId: string) => void;
  onClearStaged: () => void;

  /** The save's rows are still arriving — distinct from `busy`, which is a WRITE. */
  loading: boolean;
  busy: boolean;
  error?: string;
  onDismissError: () => void;
};

/**
 * A fresh color for the create form.
 *
 * Random rather than a fixed default because the field's job is to be DIFFERENT from the
 * nations already on the map, and a constant default makes every nation created without
 * touching the picker the same color — which is how the old app's maps ended up with
 * indistinguishable blocks. Six hex digits exactly: the server accepts `#rrggbb` and
 * nothing else.
 */
function randomColor(): string {
  return `#${Math.floor(Math.random() * 0x1000000)
    .toString(16)
    .padStart(6, '0')}`;
}

export function Sidebar(props: SidebarProps) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(randomColor);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [leadingId, setLeadingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftColor, setDraftColor] = useState('#000000');

  const trimmed = name.trim();
  const stagedCount = props.staged.length;

  function submitCreate(): void {
    if (trimmed === '') return;
    props.onCreateGrouping({ name: trimmed, color });
    setName('');
    // Re-rolled rather than kept, so the next nation does not inherit this one's color by
    // default — the same reason the field starts random.
    setColor(randomColor());
  }

  function openRename(group: Grouping): void {
    setRenamingId(group.id);
    setDraftName(group.name);
    setDraftColor(group.color);
  }

  function submitRename(): void {
    const target = renamingId;
    const next = draftName.trim();
    if (target === null || next === '') return;
    props.onUpdateGrouping(target, { name: next, color: draftColor });
    setRenamingId(null);
  }

  return (
    <aside className="map-sidebar">
      <section className="map-sidebar__section">
        <label className="map-field">
          <span className="map-field__label">Projection</span>
          <select
            className="map-input"
            value={props.projection}
            onChange={(event) => {
              // The value is one of this select's own options, so the cast restates what
              // the DOM erased rather than asserting anything new.
              props.onProjectionChange(event.target.value as ProjectionId);
            }}
          >
            {PROJECTION_IDS.map((id) => (
              <option key={id} value={id}>
                {PROJECTIONS[id].label}
              </option>
            ))}
          </select>
        </label>
      </section>

      {props.error !== undefined && (
        <div className="map-alert" role="alert">
          <span className="map-alert__text">{props.error}</span>
          <button type="button" className="map-button" onClick={props.onDismissError}>
            Dismiss
          </button>
        </div>
      )}

      <section className="map-sidebar__section">
        <div className="map-sidebar__heading">
          <span>Unified nations</span>
          <span className="map-muted">
            {props.loading ? 'loading…' : props.busy ? 'saving…' : `${props.groupings.length}`}
          </span>
        </div>
        <p className="map-muted map-stats">
          {props.countryCount} countries · {props.independentCount} independent
        </p>

        <ul className="map-list">
          {props.groupings.map((group) => {
            const isEditing = props.editingGroupingId === group.id;
            const isRenaming = renamingId === group.id;
            const classes = ['map-list__item'];
            if (isEditing) classes.push('map-list__item--editing');
            if (props.primaryGroupingId === group.id) classes.push('map-list__item--primary');
            if (props.glowGroupingIds.has(group.id)) classes.push('map-list__item--glow');
            const isLeading = leadingId === group.id;
            const leader = props.leaderNames.get(group.id);
            const leaderId = props.leaderIds.get(group.id);
            const members = props.membersByGrouping.get(group.id) ?? [];

            return (
              <li key={group.id} className={classes.join(' ')}>
                <div className="map-list__row">
                  <span className="map-swatch" style={{ background: group.color }} aria-hidden />
                  <button
                    type="button"
                    className="map-list__name"
                    onClick={() => {
                      props.onSelectGrouping(group.id);
                    }}
                    title="Select this nation (glows its member countries)"
                  >
                    {group.name}
                  </button>
                  <span className="map-muted">{props.memberCounts.get(group.id) ?? 0}</span>
                </div>

                {leader !== undefined && <p className="map-muted map-leader">leader · {leader}</p>}

                <div className="map-list__actions">
                  <button
                    type="button"
                    className={isEditing ? 'map-button map-button--on' : 'map-button'}
                    onClick={() => {
                      props.onToggleEditing(group.id);
                    }}
                    title="While on, clicking a country on the map adds or removes it"
                  >
                    {isEditing ? 'Editing — done' : 'Edit membership'}
                  </button>
                  <button
                    type="button"
                    className="map-button"
                    onClick={() => {
                      if (isRenaming) setRenamingId(null);
                      else openRename(group);
                    }}
                  >
                    {isRenaming ? 'Cancel' : 'Rename'}
                  </button>
                  <button
                    type="button"
                    className={isLeading ? 'map-button map-button--on' : 'map-button'}
                    onClick={() => {
                      setLeadingId(isLeading ? null : group.id);
                    }}
                    disabled={members.length === 0}
                    title="Choose which member country leads this nation"
                  >
                    {isLeading ? 'Leader — done' : 'Leader'}
                  </button>
                  <button
                    type="button"
                    className="map-button map-button--danger"
                    onClick={() => {
                      props.onDeleteGrouping(group.id);
                    }}
                    title="Deletes the nation; its countries become independent again"
                  >
                    Delete
                  </button>
                </div>

                {isLeading && (
                  <div className="map-form">
                    <select
                      className="map-input"
                      value={leaderId ?? ''}
                      onChange={(event) => {
                        // '' is the "no leader" option and is not a country id, so it maps
                        // to the clear rather than to an assignment nobody can name.
                        const picked = event.target.value;
                        props.onSetLeader(group.id, picked === '' ? null : picked);
                      }}
                      aria-label={`Leader of ${group.name}`}
                    >
                      <option value="">— no leader —</option>
                      {members.map((member) => (
                        <option key={member.id} value={member.id}>
                          {member.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {isRenaming && (
                  <form
                    className="map-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      submitRename();
                    }}
                  >
                    <input
                      className="map-input"
                      value={draftName}
                      onChange={(event) => {
                        setDraftName(event.target.value);
                      }}
                      aria-label="New name"
                    />
                    <input
                      className="map-color"
                      type="color"
                      value={draftColor}
                      onChange={(event) => {
                        setDraftColor(event.target.value);
                      }}
                      aria-label="New color"
                    />
                    <button type="submit" className="map-button" disabled={draftName.trim() === ''}>
                      Save
                    </button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>

        {props.groupings.length === 0 && (
          <p className="map-muted">
            No unified nations in this save yet. Every country is independent.
          </p>
        )}
      </section>

      <section className="map-sidebar__section">
        <div className="map-sidebar__heading">
          <span>New nation</span>
        </div>
        <form
          className="map-form"
          onSubmit={(event) => {
            event.preventDefault();
            submitCreate();
          }}
        >
          <input
            className="map-input"
            value={name}
            placeholder="e.g. United Earth America"
            onChange={(event) => {
              setName(event.target.value);
            }}
            aria-label="Nation name"
          />
          <input
            className="map-color"
            type="color"
            value={color}
            onChange={(event) => {
              setColor(event.target.value);
            }}
            aria-label="Nation color"
          />
          <button type="submit" className="map-button" disabled={trimmed === ''}>
            {stagedCount > 0 ? `Create with ${stagedCount}` : 'Create'}
          </button>
        </form>

        <p className="map-muted">
          {stagedCount > 0
            ? 'The staged countries below become its members in one write.'
            : 'Shift-click countries on the map to stage them for a new nation.'}
        </p>

        {stagedCount > 0 && (
          <>
            <div className="map-chips">
              {props.staged.map((country) => (
                <button
                  key={country.id}
                  type="button"
                  className="map-chip"
                  onClick={() => {
                    props.onUnstage(country.id);
                  }}
                  title="Remove from the staged selection"
                >
                  {country.name} ×
                </button>
              ))}
            </div>
            <button type="button" className="map-button" onClick={props.onClearStaged}>
              Clear selection
            </button>
          </>
        )}
      </section>
    </aside>
  );
}
