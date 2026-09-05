/**
 * The seam between the camera (inside the R3F canvas, moving every frame) and the HUD
 * (a DOM overlay outside it) — implementation P4.6.
 *
 * The camera's x cannot be React state: `CorridorControls` writes it on every frame, and
 * a `setState` per frame would re-render the whole corridor sixty times a second to move
 * one `<div>`. It also cannot be a plain ref, because the HUD has to know when to redraw.
 *
 * So it is a tiny external store, read with `useSyncExternalStore`, that **notifies only
 * when the value could change what the HUD says**. The epsilon the view passes in is one
 * day's worth of world units, so a pan that has not yet crossed a day boundary produces
 * no re-render at all, and a full sweep of the corridor produces about one per day
 * crossed rather than one per frame.
 */

/** A single-number store with a change threshold. */
export interface CameraChannel {
  /**
   * Report the camera's x. Subscribers are notified only once the value has moved at
   * least `epsilon` from the last notified one.
   */
  publish(x: number): void;
  /**
   * Report a final resting x, notifying on any change at all.
   *
   * Without this the readout could stop up to `epsilon` away from the truth and stay
   * there — the camera comes to rest mid-threshold and nothing else ever fires.
   */
  settle(x: number): void;
  /** `useSyncExternalStore` subscribe. Returns the unsubscribe. */
  subscribe(onChange: () => void): () => void;
  /** `useSyncExternalStore` getSnapshot — the last *notified* value, never a live one. */
  get(): number;
}

/**
 * @param initial The camera's opening x.
 * @param epsilon Smallest change worth telling anyone about, in world units. Must be
 *                positive; a zero epsilon would notify on every frame.
 */
export function createCameraChannel(initial: number, epsilon: number): CameraChannel {
  const threshold = epsilon > 0 ? epsilon : Number.EPSILON;
  const listeners = new Set<() => void>();
  let current = initial;

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  return {
    publish(x) {
      if (Math.abs(x - current) < threshold) return;
      current = x;
      notify();
    },

    settle(x) {
      if (x === current) return;
      current = x;
      notify();
    },

    subscribe(onChange) {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },

    get: () => current,
  };
}
