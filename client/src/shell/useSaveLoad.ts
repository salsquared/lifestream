import { useEffect } from 'react';

import { loadSave } from './loadSave';
import { useRegistry } from './stores/registry';
import { useSave } from './stores/save';
import { useWorld } from './stores/world';

/**
 * The React half of the shell-owned per-save load (P4.1) — architecture §4.2.
 *
 * Mounted exactly once, by `AppShell`. It is the ONLY writer of `useWorld` and
 * `useRegistry`: §4.2's "the shell owns the fetch" is what stops four views issuing four
 * copies of the same query, and it only holds if there is one of these.
 *
 * ── THE SAVE ID IS CAPTURED FROM RENDER, NEVER RE-READ AS A VALUE ────────────────────
 * `requestedSave` is read out of the render-time `saveId` before anything is requested and
 * is the value handed to `hydrate()` when the load lands. Re-reading
 * `useSave.getState().activeSaveId` inside the `.then` is the race that files one save's
 * rows under another save's id, and it is unrecoverable by refetching because the rows are
 * well-formed and real (§4.2, §7.3). `hydrate()` itself compares the captured id against
 * the live one and drops the payload on a mismatch — that comparison is a GUARD, not a
 * source of truth, which is why it lives inside the store and the value still travels as
 * an argument. The `.catch` uses the same comparison for the same reason: an old save's
 * failure must not mark the new save's load as errored.
 *
 * ── TWO TRIGGERS, ONE LOADER ─────────────────────────────────────────────────────────
 * §4.2 documents the refetch trigger as an effect on `activeSaveId`; that is the dep list.
 * `invalidate()` is the second trigger and deliberately does NOT change `activeSaveId`, so
 * the effect alone would never see it — hence `useWorld`'s fifth status, `'stale'`, which
 * means loaded-then-superseded as opposed to `'idle'`'s never-loaded. It is watched with a
 * store subscription rather than a second dep because a dep on the status would oscillate:
 * this loader sets `'loading'` itself, so `'stale'` flips back to false the instant the
 * reload starts and the effect would re-run and fetch everything a second time. The
 * subscription fires on the TRANSITION into `'stale'` and is immune to that.
 *
 * The subscription lives inside the effect on purpose: it closes over the same
 * `requestedSave` the initial load captured, so a reload triggered by a write cannot pick
 * up a different save than the effect it belongs to.
 *
 * ── AT P4 THE SECOND TRIGGER HAS NO PRODUCER ─────────────────────────────────────────
 * Nothing in `client/src` calls `invalidate()`. `useWorld` and `useRegistry` both expose
 * it, but no component, view or API wrapper fires it — so at P4 `'stale'` is a status the
 * application never enters, and the abort-and-restart path below, the most intricate
 * machinery in this file, is unreachable in the running app. (The server-side
 * `invalidateSave` in `resolveTimeline.ts` is a different cache and is not this trigger.)
 * It is kept rather than deferred because the ordering hazard it defends against is a
 * property of the loader, not of its caller, and retrofitting it under a live producer
 * would be the wrong time to get it right.
 *
 * Its first real exercise is P6.3.3 (on save switch, invalidate every cache; views
 * re-fetch). **P6 is therefore landing on untried code**: the transition guard, the
 * `AbortController` swap and the captured-id closure have never run against any
 * invalidation at all. Treat a P6 bug in this area as "never worked" rather than
 * "regressed", and give the path a spec when P6 gives it a producer.
 *
 * ── WHAT IS NOT DONE HERE ────────────────────────────────────────────────────────────
 * The stores are NOT emptied at the start of a save switch — `hydrate()` replaces them
 * atomically when the new payload lands, and blanking first would mean calling
 * `invalidate()`, which would trip the stale subscription and start a second load of the
 * save we are already loading. The visible consequence is that the previous save's rows
 * stay on screen for the length of one load; `setActive` has already cleared `primary`
 * (§7.3), so nothing is highlighted against the wrong world in the meantime.
 */
export function useSaveLoad(): void {
  const saveId = useSave((state) => state.activeSaveId);

  useEffect(() => {
    // Captured HERE, before a single request goes out. Everything below uses this value
    // and nothing below re-reads the store for it.
    const requestedSave = saveId;

    function start(controller: AbortController): void {
      useWorld.getState().setStatus('loading');

      loadSave(requestedSave, { signal: controller.signal })
        .then((payload) => {
          // Registry first: `selectGlow` reads both slices, and hydrating the world last
          // means its recomputation already sees the locations and projects it follows.
          // Both calls carry the captured id and both drop the payload if it is stale.
          useRegistry.getState().hydrate(requestedSave, payload.registry);
          useWorld.getState().hydrate(requestedSave, payload.world);
        })
        .catch((cause: unknown) => {
          // An abort is this hook's own doing — StrictMode's double mount, a save switch,
          // an invalidation superseding an in-flight load — not a failure to report.
          if (controller.signal.aborted) return;
          // The same save-identity guard `hydrate()` applies, for the status write.
          if (requestedSave !== useSave.getState().activeSaveId) return;

          useWorld.getState().setStatus('error');
          console.error(
            `[shell] per-save load failed for ${requestedSave}:`,
            cause instanceof Error ? cause.message : cause,
          );
        });
    }

    let controller = new AbortController();
    start(controller);

    const unsubscribe = useWorld.subscribe((state, previous) => {
      // The TRANSITION into 'stale', not the state: `start()` below sets 'loading', which
      // would otherwise re-enter this listener and reload forever.
      if (state.status !== 'stale' || previous.status === 'stale') return;

      controller.abort();
      controller = new AbortController();
      start(controller);
    });

    return () => {
      unsubscribe();
      controller.abort();
    };
  }, [saveId]);
}
