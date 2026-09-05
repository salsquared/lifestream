import { afterEach, describe, expect, it } from 'vitest';

import {
  REDUCED_MOTION_QUERY,
  readSystemReducedMotion,
  subscribeSystemReducedMotion,
} from '@client/views/_shared/reducedMotion';

/**
 * P4.4.5 — the `prefers-reduced-motion` seam (D7 of the P4 review fix contract).
 *
 * ── WHY THIS SPEC EXISTS ─────────────────────────────────────────────────────────────
 * The module exports the read and the subscribe separately from the hook precisely "so a
 * test can drive them without a React tree". This is that test; no React is mounted and
 * no DOM environment is used — the suite runs on `environment: 'node'`, so `window` is
 * genuinely absent and the non-DOM guard is exercised for real rather than simulated.
 *
 * Two things are asserted, and both are invisible until something is already broken:
 *
 *   1. **The non-DOM guard answers `false` and never throws.** That path exists for the
 *      P15 export renderer and any headless check, which import the shared 3D components
 *      into an environment with no `matchMedia`. A throw there takes down the renderer at
 *      import time; a `true` would make every exported screenshot the reduced-motion
 *      variant of the scene — stars frozen, shell pinned — and nobody would ever see the
 *      difference against a still image.
 *   2. **Subscribe and unsubscribe are symmetric.** The listener removed must be the
 *      listener added, on the same event name and the same `MediaQueryList`. An asymmetric
 *      pair leaks one listener per mount and, in React StrictMode, per double-invoked
 *      effect — and a leaked listener still calls `setState` on an unmounted tree.
 *
 * The fake `matchMedia` is hand-rolled and installed on `globalThis`, then removed in an
 * `afterEach`. Nothing here depends on jsdom.
 */

// ---------------------------------------------------------------------------
// A hand-rolled MediaQueryList
// ---------------------------------------------------------------------------

interface FakeList {
  readonly query: string;
  matches: boolean;
  readonly added: Array<{ type: string; handler: EventListenerOrEventListenerObject }>;
  readonly removed: Array<{ type: string; handler: EventListenerOrEventListenerObject }>;
  addEventListener(type: string, handler: EventListenerOrEventListenerObject): void;
  removeEventListener(type: string, handler: EventListenerOrEventListenerObject): void;
  fire(): void;
}

function fakeList(query: string, matches: boolean): FakeList {
  const added: FakeList['added'] = [];
  const removed: FakeList['removed'] = [];
  return {
    query,
    matches,
    added,
    removed,
    addEventListener(type, handler) {
      added.push({ type, handler });
    },
    removeEventListener(type, handler) {
      removed.push({ type, handler });
    },
    fire() {
      for (const { type, handler } of added) {
        if (type !== 'change') continue;
        if (removed.some((r) => r.type === type && r.handler === handler)) continue;
        if (typeof handler === 'function') handler(new Event('change'));
        else handler.handleEvent(new Event('change'));
      }
    },
  };
}

/** The `globalThis` slot `readSystemReducedMotion` probes, typed loosely enough to stub. */
type Stubbable = { window?: { matchMedia?: unknown } };

/** Install a fake `window.matchMedia`, returning the lists it hands out. */
function installMatchMedia(matches: boolean): {
  lists: FakeList[];
  calls: string[];
} {
  const lists: FakeList[] = [];
  const calls: string[] = [];
  (globalThis as Stubbable).window = {
    matchMedia: (query: string) => {
      calls.push(query);
      const list = fakeList(query, matches);
      lists.push(list);
      return list;
    },
  };
  return { lists, calls };
}

afterEach(() => {
  // `window` does not exist in this environment to begin with, so it is deleted rather
  // than restored — leaving a stub behind would silently change what every later spec in
  // the run sees, including `pan`/`hud`, which must stay isomorphic.
  delete (globalThis as Stubbable).window;
});

// ---------------------------------------------------------------------------
// readSystemReducedMotion
// ---------------------------------------------------------------------------

describe('readSystemReducedMotion outside a browser', () => {
  it('answers false when there is no `window` at all', () => {
    // Not simulated — the suite's environment is `node`, so this is the real P15 case.
    expect(typeof globalThis.window).toBe('undefined');
    expect(readSystemReducedMotion()).toBe(false);
  });

  it('does not throw when there is no `window` at all', () => {
    expect(() => readSystemReducedMotion()).not.toThrow();
  });

  it('answers false when `window` exists but has no matchMedia', () => {
    // An older headless shim, or jsdom before the media-query polyfill is applied. The
    // guard tests `typeof … !== 'function'` rather than truthiness for exactly this.
    (globalThis as Stubbable).window = {};
    expect(readSystemReducedMotion()).toBe(false);
  });

  it('answers false when matchMedia is present but not callable', () => {
    (globalThis as Stubbable).window = { matchMedia: 'not a function' };
    expect(readSystemReducedMotion()).toBe(false);
  });
});

describe('readSystemReducedMotion in a browser', () => {
  it('reports the media query’s answer, both ways', () => {
    installMatchMedia(true);
    expect(readSystemReducedMotion()).toBe(true);

    installMatchMedia(false);
    expect(readSystemReducedMotion()).toBe(false);
  });

  it('asks the ONE declared query, verbatim', () => {
    // The module declares the query once "so the subscribe and the read cannot disagree".
    // Two spellings of it would give a reader who toggles the setting mid-session a scene
    // that reads one policy and subscribes to another.
    const { calls } = installMatchMedia(true);
    readSystemReducedMotion();
    expect(calls).toEqual([REDUCED_MOTION_QUERY]);
    expect(REDUCED_MOTION_QUERY).toBe('(prefers-reduced-motion: reduce)');
  });

  it('re-reads on every call rather than caching the first answer', () => {
    // It is `useSyncExternalStore`'s `getSnapshot`: a cached value would leave the first
    // frame after a change drawn with the old policy.
    const { calls } = installMatchMedia(false);
    readSystemReducedMotion();
    readSystemReducedMotion();
    expect(calls).toEqual([REDUCED_MOTION_QUERY, REDUCED_MOTION_QUERY]);
  });
});

// ---------------------------------------------------------------------------
// subscribeSystemReducedMotion
// ---------------------------------------------------------------------------

describe('subscribeSystemReducedMotion outside a browser', () => {
  it('returns a callable no-op rather than undefined', () => {
    // `useSyncExternalStore` calls the return value on cleanup unconditionally. Returning
    // `undefined` here would throw during unmount in the export renderer.
    const unsubscribe = subscribeSystemReducedMotion(() => {});
    expect(typeof unsubscribe).toBe('function');
    expect(() => unsubscribe()).not.toThrow();
  });

  it('never invokes the callback when there is nothing to subscribe to', () => {
    let called = 0;
    subscribeSystemReducedMotion(() => {
      called++;
    });
    expect(called).toBe(0);
  });

  it('returns a no-op when `window` exists but has no matchMedia', () => {
    (globalThis as Stubbable).window = {};
    expect(() => subscribeSystemReducedMotion(() => {})()).not.toThrow();
  });
});

describe('subscribeSystemReducedMotion in a browser', () => {
  it('listens for `change` on the list for the declared query', () => {
    const { lists, calls } = installMatchMedia(false);
    subscribeSystemReducedMotion(() => {});

    expect(calls).toEqual([REDUCED_MOTION_QUERY]);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.added.map((a) => a.type)).toEqual(['change']);
  });

  it('removes EXACTLY the handler it added, on the same list and the same event', () => {
    // The symmetry, asserted by identity rather than by count. `removeEventListener` with a
    // different function reference is a silent no-op — the listener count would look right
    // in a test that only counted calls, and the listener would still be attached.
    const { lists } = installMatchMedia(false);
    const onChange = (): void => {};
    subscribeSystemReducedMotion(onChange)();

    const list = lists[0]!;
    expect(list.added).toHaveLength(1);
    expect(list.removed).toHaveLength(1);
    expect(list.removed[0]!.type).toBe(list.added[0]!.type);
    expect(list.removed[0]!.handler).toBe(list.added[0]!.handler);
  });

  it('forwards the callback the caller gave, unwrapped', () => {
    const { lists } = installMatchMedia(false);
    const onChange = (): void => {};
    subscribeSystemReducedMotion(onChange);
    expect(lists[0]!.added[0]!.handler).toBe(onChange);
  });

  it('actually calls back when the preference changes, and stops after unsubscribe', () => {
    const { lists } = installMatchMedia(false);
    let notified = 0;
    const unsubscribe = subscribeSystemReducedMotion(() => {
      notified++;
    });

    lists[0]!.fire();
    expect(notified).toBe(1);

    unsubscribe();
    lists[0]!.fire();
    expect(notified).toBe(1);
  });

  it('keeps two subscribers independent', () => {
    // Two scenes on one page (P13's Tech Tree alongside the Corridor) each subscribe.
    // One unmounting must not deafen the other.
    const { lists } = installMatchMedia(false);
    let a = 0;
    let b = 0;
    const stopA = subscribeSystemReducedMotion(() => {
      a++;
    });
    subscribeSystemReducedMotion(() => {
      b++;
    });

    stopA();
    lists[0]!.fire();
    lists[1]!.fire();
    expect(a).toBe(0);
    expect(b).toBe(1);
  });

  it('survives an unsubscribe called twice', () => {
    // StrictMode double-invokes cleanup. The second `removeEventListener` is a no-op in
    // the DOM, and must not throw here either.
    installMatchMedia(false);
    const unsubscribe = subscribeSystemReducedMotion(() => {});
    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The stub is cleaned up
// ---------------------------------------------------------------------------

describe('the environment this spec found', () => {
  it('is left without a `window`, exactly as it was', () => {
    // Guards the `afterEach`. A leaked stub would make `readSystemReducedMotion` answer
    // from a fake in every spec that runs after this file in the same worker.
    expect('window' in globalThis).toBe(false);
    expect(readSystemReducedMotion()).toBe(false);
  });
});
