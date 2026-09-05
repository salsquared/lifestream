import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Grouping, GroupingCountry } from '@shared/types/index';

import {
  assignCountryToGrouping,
  clearCountryOverride,
  createGrouping,
  deleteGrouping,
  fetchMapCountries,
  fetchMapGroupings,
  GroupingConflictError,
  MembershipConflictError,
  removeCountryFromGrouping,
  replaceGroupingCountries,
  setCountryOverride,
  updateGrouping,
} from '../../api';
import { useGlow } from '../../shell/stores/selectGlow';
import { useSave } from '../../shell/stores/save';
import { useSelection } from '../../shell/stores/selection';
import { CountryMenu } from './CountryMenu';
import { Sidebar } from './Sidebar';
import {
  emptyMapData,
  fillById,
  glowCountryIds,
  groupingOf,
  independentIds,
  leaderCountryIds,
  leaderIds,
  memberCounts,
  membersOf,
  nameById,
  withGrouping,
  withMember,
  withMembership,
  withoutGrouping,
  withoutMember,
  withRename,
  withServerMember,
  withServerMembership,
} from './derive';
import { createWriteQueue, Declined, runOptimistic } from './optimistic';
import { DEFAULT_PROJECTION, useWorldFeatures, WorldMap } from './renderer';

import type { MapData } from './derive';
import type { OptimisticStore, Reconcile } from './optimistic';
import type { ProjectionId } from './renderer';

import './map.css';

/**
 * The World Map container (P2.3, P2.4, P2.5, P2.6.5, P2.7). Architecture §5.1.
 *
 * IT OWNS THE STATE, THE FETCHES AND THE WRITES; the renderer under `./renderer/` owns
 * pixels and gestures and reads no store. Everything it draws arrives as a prop computed
 * here: `fillById` from the groupings and their membership, `nameById` from the atlas
 * defaults under the API's names under this session's renames, `glowIds` from `useGlow()`,
 * and `editingMemberIds` from whichever grouping is being edited. That seam is the reason
 * this file is the only one in the view that imports `client/src/api`.
 *
 * ── FOUR THINGS THAT ARE SETTLED AND ARE NOT RE-DECIDED HERE ─────────────────────────
 *
 * 1. INDEPENDENCE IS DERIVED. `GET /api/map/groupings` answers `{ groupings, members }`
 *    and nothing else; a country with no membership row is independent (§2.4). There is
 *    no `independents` field to read and none to add — that field is exactly the 74
 *    synthesized groups the old map export emitted and the schema refuses to store.
 *
 * 2. THE ACTIVE SAVE IS CAPTURED, NEVER RE-READ. `saveId` is read from `useSave` during
 *    render and closed over by every callback and every fetch. Reading
 *    `useSave.getState()` inside a click handler or after an `await` is the race that
 *    files one save's `grouping_country` rows under another save's id (§4.2) — and it is
 *    unrecoverable by refetching, because the rows are well-formed and real.
 *
 * 3. GLOW COMES FROM `useGlow()`. Not `useSelection.glow`, which does not exist and never
 *    did: `useSelection` holds `primary` and nothing else, and the halo is a memoized
 *    derived selector over (primary, world, registry) precisely so that a shared
 *    `?primary=` URL still glows once the fetch lands (§2.6, §4.2, P2.7.3).
 *
 * 4. A CLICK FLIPS FIRST AND ROLLS BACK ON FAILURE, including when the author declines
 *    the "Move from ⟨X⟩?" prompt (P2.6.5). See `optimistic.ts` for why that is a snapshot
 *    restore and not an inverse write.
 *
 * ── WHERE THIS VIEW'S DATA LIVES, AND WHY IT IS NOT IN `useWorld` YET ────────────────
 * §4.2 has the shell load the registry and the world once per save, and `useWorld` holds
 * `groupings` + `groupingOf` for exactly the rows below. That loader does not exist yet —
 * P2.5 puts the map's own fetch in the view — and hydrating `useWorld` from here would be
 * worse than not: `hydrate()` takes a whole `WorldData`, so writing the two collections
 * this view has would blank the events, timelines and relations the store is meant to
 * hold. The consequence to know about: `selectGlow`'s country and grouping rules read
 * `useWorld.groupingOf`, which stays empty until the shell owns the load, so a country
 * primary lights only itself for now. `glowCountryIds` expands grouping glow against this
 * view's own membership so that P2.7.2 works today; when the shell loader lands, this
 * state becomes a read of the store and nothing else here changes.
 */

type LoadStatus = 'loading' | 'ready' | 'error';

/** An open right-click menu: which country, and where the pointer was. */
type OpenMenu = { countryId: string; at: { x: number; y: number } };

export function MapView() {
  const saveId = useSave((state) => state.activeSaveId);
  const setPrimary = useSelection((state) => state.setPrimary);
  const primary = useSelection((state) => state.primary);
  const glow = useGlow();

  /**
   * The atlas, loaded by the RENDERER's own loader and passed back down as a prop.
   *
   * Deriving the feature set is the renderer's job (§3.1, P2.1.2) — all three jobs of
   * `deriveFeatures`, including the `"036"` disambiguation without which Australia or
   * Ashmore and Cartier Is. silently vanishes — and the container's job is only to hold
   * the value and hand it back. Calling `loadWorldFeatures` here instead would be the
   * second implementation of the one index the module exists to prevent.
   */
  const world = useWorldFeatures();
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [error, setError] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState(0);

  const [projection, setProjection] = useState<ProjectionId>(DEFAULT_PROJECTION);
  const [editingGroupingId, setEditingGroupingId] = useState<string | null>(null);
  const [staged, setStaged] = useState<readonly string[]>([]);
  const [hoveredId, setHoveredId] = useState<string | undefined>(undefined);
  const [menu, setMenu] = useState<OpenMenu | null>(null);

  /**
   * The per-save rows, held in a ref BESIDE the state.
   *
   * The ref is what an optimistic write snapshots and restores, and it has to be exact:
   * `data` from the enclosing render is the value as of that render, which after an
   * `await` is a value from the past. Every write goes through the queue below, so the
   * ref is only ever read and written between awaits — there is no interleaving for it to
   * be wrong about.
   */
  const [data, setDataState] = useState<MapData>(emptyMapData);
  const dataRef = useRef<MapData>(data);
  const setData = useCallback((next: MapData) => {
    dataRef.current = next;
    setDataState(next);
  }, []);

  const store = useMemo<OptimisticStore<MapData>>(
    () => ({ read: () => dataRef.current, write: setData }),
    [setData],
  );

  /** Serializes the writes, so one write's rollback can never discard another's success. */
  const queueRef = useRef<ReturnType<typeof createWriteQueue> | null>(null);
  queueRef.current ??= createWriteQueue();
  const enqueue = queueRef.current;

  const stagedRef = useRef<readonly string[]>(staged);
  stagedRef.current = staged;

  const reportFailure = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  /* ---------------------------------------------------------------------------- *
   * The per-save load (P2.5), re-run on every `activeSaveId` change. The atlas is
   * loaded once by `useWorldFeatures` above and is not save-scoped — geometry is global.
   * ---------------------------------------------------------------------------- */

  useEffect(() => {
    const controller = new AbortController();
    // Captured before the fetch and used after it — never re-read. See note 2 above.
    const requestedSave = saveId;

    setStatus('loading');
    Promise.all([
      fetchMapCountries(requestedSave, { signal: controller.signal }),
      fetchMapGroupings(requestedSave, { signal: controller.signal }),
    ])
      .then(([countries, groupings]) => {
        // The §4.2 save-identity guard, applied to this view's own state. The abort above
        // already covers the ordinary case; this covers the one where the response was
        // already in flight when the switch happened.
        if (requestedSave !== useSave.getState().activeSaveId) return;
        setData({
          countries,
          groupings: groupings.groupings,
          members: groupings.members,
          // Renames are per-save and optimistic; the payload just read already has this
          // save's overrides coalesced in, so carrying the previous save's forward would
          // print one world's names over another's.
          renames: {},
        });
        setStatus('ready');
        setError(undefined);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        reportFailure(cause);
        setStatus('error');
      });

    return () => {
      controller.abort();
    };
  }, [saveId, setData, reportFailure]);

  // A grouping being edited, a staged selection and an open menu all name rows of the
  // save that just went away, so they are dropped with it (the same reasoning as
  // `setActive` clearing `primary`, §7.3).
  useEffect(() => {
    setEditingGroupingId(null);
    setStaged([]);
    setMenu(null);
  }, [saveId]);

  /* ---------------------------------------------------------------------------- *
   * The derived props the renderer draws from.
   * ---------------------------------------------------------------------------- */

  const atlasDefaults = useMemo<ReadonlyMap<string, string>>(() => {
    const defaults = new Map<string, string>();
    if (world.status !== 'ready') return defaults;
    for (const country of world.features.countries) defaults.set(country.id, country.name);
    return defaults;
  }, [world]);

  const fills = useMemo(() => fillById(data), [data]);
  const names = useMemo(() => nameById(data, atlasDefaults), [data, atlasDefaults]);
  const owners = useMemo(() => groupingOf(data), [data]);
  const counts = useMemo(() => memberCounts(data), [data]);
  const independents = useMemo(() => independentIds(data), [data]);

  const glowIds = useMemo(
    () => glowCountryIds(data, glow.countryIds, glow.groupingIds),
    [data, glow],
  );

  /**
   * The set the renderer draws as "in the edit set".
   *
   * It carries the membership of the grouping being edited when there is one, and the
   * SHIFT-STAGED selection when there is not. Those are the same thing from the map's
   * point of view — the countries this gesture has collected — and the pinned prop list
   * has one slot for it, so a staged selection that only appeared in the sidebar would be
   * a selection you cannot see where you are making it.
   */
  const editingMemberIds = useMemo<ReadonlySet<string>>(
    () => (editingGroupingId === null ? new Set(staged) : membersOf(data, editingGroupingId)),
    [data, editingGroupingId, staged],
  );

  const stagedChips = useMemo(
    () => staged.map((id) => ({ id, name: names.get(id) ?? id })),
    [staged, names],
  );

  const leaderNames = useMemo(() => {
    const leaders = new Map<string, string>();
    for (const [groupingId, countryId] of leaderIds(data)) {
      leaders.set(groupingId, names.get(countryId) ?? countryId);
    }
    return leaders;
  }, [data, names]);

  const primaryCountryId = primary?.type === 'country' ? primary.id : undefined;
  const primaryGroupingId = primary?.type === 'grouping' ? primary.id : undefined;

  /* ---------------------------------------------------------------------------- *
   * Writes. Every one of them: flip, send, restore the snapshot if it does not land.
   * ---------------------------------------------------------------------------- */

  const write = useCallback(
    (apply: Reconcile<MapData>, send: () => Promise<Reconcile<MapData> | void>) => {
      setPending((count) => count + 1);
      return enqueue(() => runOptimistic(store, apply, send, reportFailure))
        .finally(() => {
          setPending((count) => count - 1);
        })
        // `runOptimistic` reports and swallows the failures it expects, so anything left
        // is a defect in a reducer. Every caller here `void`s the result, and an
        // unhandled rejection is the one failure mode that would leave no trace at all.
        .catch((cause: unknown) => {
          reportFailure(cause);
          return 'failed' as const;
        });
    },
    [enqueue, store, reportFailure],
  );

  /**
   * The line a move prompt gains when it would destroy authored leadership.
   *
   * A move CLEARS `is_leader` — the destination may already have a leader, and a
   * membership's flag cannot travel with it (§2.4) — and P2 ships no write path for the
   * flag at all: it is seed-only, and canon marks one on ten of the unions. So a move made
   * without noticing removes something the interface cannot put back, which is the one
   * case in this view where "undo it afterwards" is not available. The prompt says so
   * before the write rather than after it.
   */
  const leaderWarning = useCallback(
    (countryIds: readonly string[]) => {
      const leaders = leaderCountryIds(dataRef.current);
      const affected = countryIds.filter((id) => leaders.has(id));
      if (affected.length === 0) return '';

      const listed = affected.map((id) => names.get(id) ?? id).join(', ');
      return (
        `\n\nWARNING — ${listed} ` +
        `${affected.length === 1 ? 'leads its' : 'lead their'} current union. Moving ` +
        `${affected.length === 1 ? 'it' : 'them'} clears that leadership, and nothing in ` +
        'this view can set it again.'
      );
    },
    [names],
  );

  /**
   * Assign a country, asking before taking it from another nation (P2.3.3, P2.6.3).
   *
   * THE PROMPT IS BUILT FROM THE 409, not from the membership this view happens to hold.
   * The server is the authority on who owns the country — this client's copy can be a
   * refetch behind — and the response names the owner precisely so the question can be
   * asked. Declining rolls the optimistic flip back and reports nothing: the author
   * answered, and an answer is not a failure.
   */
  const assignCountry = useCallback(
    (groupingId: string, countryId: string) =>
      write(
        (prev) => withMember(prev, saveId, groupingId, countryId),
        async () => {
          // The server's row replaces the optimistic one so a re-confirmed membership
          // keeps its `isLeader` flag, which the optimistic row always clears.
          const applyMember = (member: GroupingCountry) => (prev: MapData) =>
            withServerMember(prev, member);

          try {
            return applyMember(await assignCountryToGrouping(saveId, groupingId, countryId));
          } catch (cause) {
            if (!(cause instanceof GroupingConflictError)) throw cause;

            const country = names.get(countryId) ?? countryId;
            const owner = cause.ownedBy.name;
            const confirmed = window.confirm(
              `“${country}” already belongs to “${owner}”.` +
                leaderWarning([countryId]) +
                `\n\nMove from ${owner}?`,
            );
            if (!confirmed) throw new Declined();

            return applyMember(await assignCountryToGrouping(saveId, groupingId, countryId, true));
          }
        },
      ),
    [write, saveId, names, leaderWarning],
  );

  const handleCountryClick = useCallback(
    (countryId: string, event: { shiftKey: boolean }) => {
      setMenu(null);

      if (editingGroupingId === null) {
        if (event.shiftKey) {
          // Staging for the bulk unify. Deliberately not a write: nothing exists to write
          // to until the nation is created, which is what `PUT /:id/countries` is for.
          setStaged((previous) =>
            previous.includes(countryId)
              ? previous.filter((id) => id !== countryId)
              : [...previous, countryId],
          );
          return;
        }
        // P2.3.4 / P2.7.1 — the cross-view link. Nothing is written.
        setPrimary({ type: 'country', id: countryId });
        return;
      }

      // P2.3.2 — while editing, a click toggles membership of the edited nation. The
      // owner is read from the ref rather than the render's `data`, because a click can
      // land between a write and its state update.
      const owner = groupingOf(dataRef.current).get(countryId);
      if (owner === editingGroupingId) {
        void write(
          (prev) => withoutMember(prev, countryId),
          async () => {
            await removeCountryFromGrouping(saveId, editingGroupingId, countryId);
          },
        );
        return;
      }

      void assignCountry(editingGroupingId, countryId);
    },
    [editingGroupingId, setPrimary, write, saveId, assignCountry],
  );

  const handleContextMenu = useCallback((countryId: string, at: { x: number; y: number }) => {
    setMenu({ countryId, at });
  }, []);

  /**
   * The per-save rename (P2.3.5).
   *
   * AN EMPTY ANSWER IS A RESET, and a reset DELETES the row rather than storing the
   * default name in it (§7.4) — a stored copy of the default stops tracking the global
   * row it copied. A name that happens to equal the default is written as an ordinary
   * override: the server declines to compare against the default on the grounds that
   * pinning today's atlas name may be exactly what the author meant, and there is no way
   * from here to tell the two intentions apart.
   */
  const renameCountry = useCallback(
    (countryId: string) => {
      setMenu(null);
      const current = names.get(countryId) ?? countryId;
      const answer = window.prompt(`Name for “${current}” in this save`, current);
      if (answer === null) return;

      const next = answer.trim();
      if (next === current) return;

      if (next === '') {
        const fallback = atlasDefaults.get(countryId);
        if (fallback === undefined || fallback === current) return;
        void write(
          (prev) => withRename(prev, countryId, fallback),
          async () => {
            await clearCountryOverride(saveId, countryId);
          },
        );
        return;
      }

      void write(
        (prev) => withRename(prev, countryId, next),
        async () => {
          await setCountryOverride(saveId, countryId, next);
        },
      );
    },
    [names, atlasDefaults, write, saveId],
  );

  const resetCountryName = useCallback(
    (countryId: string) => {
      setMenu(null);
      const fallback = atlasDefaults.get(countryId);
      if (fallback === undefined) return;
      void write(
        (prev) => withRename(prev, countryId, fallback),
        async () => {
          await clearCountryOverride(saveId, countryId);
        },
      );
    },
    [atlasDefaults, write, saveId],
  );

  /**
   * Create a nation, and give it the staged countries in ONE membership write (P2.4.2).
   *
   * The create itself is not optimistic and cannot be: the id is minted by the server, and
   * a placeholder row would have to be reconciled by identity it does not have. The
   * membership that follows it is, which is why the two are separate steps rather than one
   * — and if the membership is refused, the nation stays, empty. That is what actually
   * happened, and inventing a compensating delete would be a second write the author did
   * not ask for.
   */
  const createNation = useCallback(
    (draft: { name: string; color: string }) => {
      const countryIds = [...stagedRef.current];
      setPending((count) => count + 1);

      void enqueue(async () => {
        let created: Grouping;
        try {
          created = await createGrouping(saveId, draft);
        } catch (cause) {
          reportFailure(cause);
          return;
        }

        setData(withGrouping(dataRef.current, created));
        if (countryIds.length === 0) return;

        const outcome = await runOptimistic(
          store,
          (prev) => withMembership(prev, saveId, created.id, countryIds),
          async () => {
            const send = (move: boolean) =>
              replaceGroupingCountries(saveId, created.id, countryIds, move);

            let members;
            try {
              members = await send(false);
            } catch (cause) {
              if (!(cause instanceof MembershipConflictError)) throw cause;
              const owners = cause.conflicts
                .map(
                  (conflict) =>
                    `${names.get(conflict.countryId) ?? conflict.countryId} → ${conflict.ownedBy.name}`,
                )
                .join('\n');
              const confirmed = window.confirm(
                `${String(cause.conflicts.length)} of the staged countries already belong to ` +
                  `another nation:\n\n${owners}` +
                  leaderWarning(cause.conflicts.map((conflict) => conflict.countryId)) +
                  '\n\nMove them?',
              );
              if (!confirmed) throw new Declined();
              members = await send(true);
            }

            return (prev: MapData) => withServerMembership(prev, created.id, members);
          },
          reportFailure,
        );

        if (outcome === 'applied') setStaged([]);
      })
        .finally(() => {
          setPending((count) => count - 1);
        })
        .catch(reportFailure);
    },
    [enqueue, saveId, setData, store, reportFailure, names, leaderWarning],
  );

  const editNation = useCallback(
    (groupingId: string, patch: { name: string; color: string }) => {
      const current = dataRef.current.groupings.find((group) => group.id === groupingId);
      if (current === undefined) return;
      void write(
        (prev) => withGrouping(prev, { ...current, ...patch }),
        async () => {
          const updated = await updateGrouping(saveId, groupingId, patch);
          return (prev) => withGrouping(prev, updated);
        },
      );
    },
    [write, saveId],
  );

  const removeNation = useCallback(
    (groupingId: string) => {
      const current = dataRef.current.groupings.find((group) => group.id === groupingId);
      if (current === undefined) return;

      const size = memberCounts(dataRef.current).get(groupingId) ?? 0;
      const confirmed = window.confirm(
        `Delete “${current.name}”?\n\nIts ${String(size)} member ${
          size === 1 ? 'country becomes' : 'countries become'
        } independent again.`,
      );
      if (!confirmed) return;

      if (editingGroupingId === groupingId) setEditingGroupingId(null);
      void write(
        (prev) => withoutGrouping(prev, groupingId),
        async () => {
          await deleteGrouping(saveId, groupingId);
        },
      );
    },
    [write, saveId, editingGroupingId],
  );

  /* ---------------------------------------------------------------------------- *
   * Render.
   * ---------------------------------------------------------------------------- */

  const menuCountry = menu === null ? undefined : menu.countryId;
  const menuName = menuCountry === undefined ? '' : (names.get(menuCountry) ?? menuCountry);
  const menuDefault = menuCountry === undefined ? undefined : atlasDefaults.get(menuCountry);
  // Offered only when this save actually renames the country: the DELETE answers 404 when
  // there is no override row, so an unconditional item would produce an error for a no-op.
  const resettableTo =
    menuDefault !== undefined && menuDefault !== menuName ? menuDefault : undefined;

  const hoveredName =
    hoveredId === undefined ? undefined : (names.get(hoveredId) ?? hoveredId);
  const hoveredOwner = hoveredId === undefined ? undefined : owners.get(hoveredId);
  const hoveredOwnerName =
    hoveredOwner === undefined
      ? undefined
      : dataRef.current.groupings.find((group) => group.id === hoveredOwner)?.name;

  return (
    <div className="map-view">
      <Sidebar
        projection={projection}
        onProjectionChange={setProjection}
        groupings={data.groupings}
        memberCounts={counts}
        leaderNames={leaderNames}
        countryCount={data.countries.length}
        independentCount={independents.size}
        primaryGroupingId={primaryGroupingId}
        glowGroupingIds={glow.groupingIds}
        editingGroupingId={editingGroupingId}
        staged={stagedChips}
        onSelectGrouping={(groupingId) => {
          setPrimary({ type: 'grouping', id: groupingId });
        }}
        onToggleEditing={(groupingId) => {
          setEditingGroupingId((current) => (current === groupingId ? null : groupingId));
          // Staging and membership editing are two ways to say the same thing, and the
          // renderer has one set to draw them in — so entering an edit puts the staged
          // one away rather than layering them.
          setStaged([]);
        }}
        onCreateGrouping={createNation}
        onUpdateGrouping={editNation}
        onDeleteGrouping={removeNation}
        onUnstage={(countryId) => {
          setStaged((previous) => previous.filter((id) => id !== countryId));
        }}
        onClearStaged={() => {
          setStaged([]);
        }}
        loading={status === 'loading'}
        busy={pending > 0}
        error={error}
        onDismissError={() => {
          setError(undefined);
        }}
      />

      <div className="map-stage">
        {world.status !== 'ready' ? (
          <p className="map-placeholder">
            {world.status === 'error'
              ? `The atlas could not be loaded — ${world.error.message}`
              : 'Loading the atlas…'}
          </p>
        ) : (
          <WorldMap
            features={world.features}
            projection={projection}
            fillById={fills}
            nameById={names}
            glowIds={glowIds}
            primaryId={primaryCountryId}
            editingMemberIds={editingMemberIds}
            onCountryClick={handleCountryClick}
            onCountryContextMenu={handleContextMenu}
            onCountryHover={setHoveredId}
          />
        )}

        {hoveredName !== undefined && (
          <div className="map-tooltip">
            <span>{hoveredName}</span>
            {hoveredOwnerName !== undefined && (
              <span className="map-muted"> · {hoveredOwnerName}</span>
            )}
            {hoveredOwnerName === undefined && <span className="map-muted"> · independent</span>}
          </div>
        )}

        {editingGroupingId !== null && (
          <div className="map-banner">
            Editing membership — click a country to add or remove it.
          </div>
        )}

        {menu !== null && (
          <CountryMenu
            at={menu.at}
            name={menuName}
            resettableTo={resettableTo}
            onRename={() => {
              renameCountry(menu.countryId);
            }}
            onReset={() => {
              resetCountryName(menu.countryId);
            }}
            onClose={() => {
              setMenu(null);
            }}
          />
        )}
      </div>
    </div>
  );
}
