import { describe, expect, it } from 'vitest';

import { createCameraChannel } from '@client/views/timeline/cameraChannel';
import { worldUnitsPerDay } from '@client/views/timeline/hud';
import { TIME_SCALE } from '@shared/timeScale';

/**
 * P4.6 — the camera → HUD channel (D7 of the P4 review fix contract).
 *
 * ── WHY THIS SPEC EXISTS ─────────────────────────────────────────────────────────────
 * This is a `useSyncExternalStore` source, but it is a plain object with four methods and
 * no React in it, so it is exercised here the way its own header describes: subscribe,
 * drive it, count notifications. Nothing is mounted.
 *
 * The module is an optimisation, and an optimisation that is subtly wrong looks exactly
 * like one that works. Two opposite failures, neither of which raises anything:
 *
 *   - **Notify too often** and the point is lost. `CorridorControls` writes x on every
 *     frame; a channel that forwards each write re-renders the HUD sixty times a second
 *     to move one `<div>`, which is the cost this module was written to avoid. The suite
 *     would still be green, the app would just be slow.
 *   - **Notify too rarely** and the readout lies. This is the one the `settle` escape
 *     exists for: the camera comes to rest mid-threshold, `publish` correctly declines to
 *     notify, and nothing ever fires again — so the HUD sits up to one epsilon away from
 *     the truth *permanently*. Not a flicker; a stuck date.
 *
 * The epsilon the Corridor actually passes is {@link worldUnitsPerDay}, so the counts are
 * asserted against that rather than against a round number invented here — a spec that
 * only ever used `epsilon = 1` would not notice the real epsilon becoming useless.
 */

/** A channel plus a live notification count and the unsubscribe. */
function subscribed(initial: number, epsilon: number) {
  const channel = createCameraChannel(initial, epsilon);
  let notifications = 0;
  const unsubscribe = channel.subscribe(() => {
    notifications++;
  });
  return { channel, unsubscribe, count: () => notifications };
}

/** One day of corridor — the epsilon the Corridor really uses. */
const DAY = worldUnitsPerDay(TIME_SCALE);

// ---------------------------------------------------------------------------
// The epsilon gate
// ---------------------------------------------------------------------------

describe('publish notifies only when the HUD could actually change', () => {
  it('says nothing at all for a sub-epsilon move', () => {
    const { channel, count } = subscribed(100, DAY);
    channel.publish(100 + DAY * 0.5);
    expect(count()).toBe(0);
  });

  it('notifies once for a supra-epsilon move, and reports the new value', () => {
    const { channel, count } = subscribed(100, DAY);
    channel.publish(100 + DAY * 2);
    expect(count()).toBe(1);
    expect(channel.get()).toBe(100 + DAY * 2);
  });

  it('treats a move of EXACTLY epsilon as worth reporting', () => {
    // The boundary is `< threshold`, so epsilon itself passes. Pinned because flipping it
    // to `<=` is a one-character change that costs the readout a day of accuracy at every
    // threshold and would break no other assertion in this file.
    //
    // Driven from x = 0 so the comparison is exact: `(100 + DAY) - 100` is NOT `DAY` in
    // binary floating point, and a boundary spec that used it would be asserting the
    // rounding rather than the rule.
    const { channel, count } = subscribed(0, DAY);
    channel.publish(DAY);
    expect(count()).toBe(1);

    const just = subscribed(0, DAY);
    just.channel.publish(DAY * 0.9999);
    expect(just.count()).toBe(0);
  });

  it('gates on distance in EITHER direction', () => {
    const { channel, count } = subscribed(100, DAY);
    channel.publish(100 - DAY * 0.5);
    expect(count()).toBe(0);
    channel.publish(100 - DAY * 2);
    expect(count()).toBe(1);
  });

  it('measures from the last NOTIFIED value, so slow drift still gets through', () => {
    // The property that makes the gate safe rather than merely cheap. Each of these steps
    // is under the epsilon; a channel that tracked the last *published* value instead would
    // never fire, and a slow pan would freeze the readout entirely.
    const { channel, count } = subscribed(100, DAY);
    for (let i = 1; i <= 4; i++) channel.publish(100 + DAY * 0.4 * i);
    // Steps land at 0.4, 0.8, 1.2, 1.6 epsilons from 100. The third crosses.
    expect(count()).toBe(1);
    expect(channel.get()).toBeCloseTo(100 + DAY * 1.2, 12);
  });

  it('does not advance get() on a suppressed publish — the snapshot is what was NOTIFIED', () => {
    // `useSyncExternalStore` requires the snapshot to be stable between notifications: if
    // `get()` moved without a notification, React could tear, rendering a value it was
    // never told about.
    const { channel } = subscribed(100, DAY);
    channel.publish(100 + DAY * 0.5);
    channel.publish(100 + DAY * 0.7);
    expect(channel.get()).toBe(100);
  });

  it('collapses a whole sweep of the corridor into about one notification per DAY crossed', () => {
    // The headline number, measured rather than asserted by construction. A minute of
    // 60 fps panning across a year of corridor is 3 600 frames and 365 day-crossings; the
    // header promises "about one per day crossed rather than one per frame". A channel
    // with a broken gate produces 3 600 here — still green everywhere else in this file.
    const { channel, count } = subscribed(0, DAY);
    const frames = 3600;
    const days = 365;
    for (let i = 1; i <= frames; i++) channel.publish((DAY * days * i) / frames);

    expect(count(), `notified ${count()} times over ${frames} frames`).toBeLessThan(frames / 5);
    expect(count()).toBeGreaterThan(days * 0.9);
    expect(count()).toBeLessThanOrEqual(days);
  });

  it('never notifies for a publish of the value it already holds', () => {
    const { channel, count } = subscribed(100, DAY);
    channel.publish(100);
    channel.publish(100);
    expect(count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// settle — the escape
// ---------------------------------------------------------------------------

describe('settle is the escape that stops the readout resting on a lie', () => {
  it('reports a resting value the epsilon gate had suppressed', () => {
    // THE regression case. The camera glides to a stop half an epsilon past the last
    // notified x. `publish` is right to stay quiet; without `settle` nothing else ever
    // fires and the HUD shows yesterday's date until the reader pans again.
    const { channel, count } = subscribed(100, DAY);
    const restingAt = 100 + DAY * 0.5;

    channel.publish(restingAt);
    expect(count()).toBe(0);
    expect(channel.get()).toBe(100);

    channel.settle(restingAt);
    expect(count()).toBe(1);
    expect(channel.get()).toBe(restingAt);
  });

  it('notifies on an arbitrarily small change, not merely on a smaller epsilon', () => {
    const { channel, count } = subscribed(100, DAY);
    channel.settle(100 + 1e-12);
    expect(count()).toBe(1);
    expect(channel.get()).toBe(100 + 1e-12);
  });

  it('stays quiet when the camera settles exactly where it was already reported', () => {
    // Every frame of an idle corridor may call this. Notifying would re-render the HUD
    // forever for no change at all.
    const { channel, count } = subscribed(100, DAY);
    channel.settle(100);
    expect(count()).toBe(0);
  });

  it('rearms the gate: the next publish is measured from the settled value', () => {
    const { channel, count } = subscribed(100, DAY);
    channel.settle(100 + DAY * 0.5);
    expect(count()).toBe(1);
    // 0.4 epsilons past the settled point — below threshold, so still silent.
    channel.publish(100 + DAY * 0.9);
    expect(count()).toBe(1);
    channel.publish(100 + DAY * 1.6);
    expect(count()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Subscription bookkeeping
// ---------------------------------------------------------------------------

describe('subscribe / unsubscribe', () => {
  it('starts at the initial value with nobody notified', () => {
    const { channel, count } = subscribed(42, DAY);
    expect(channel.get()).toBe(42);
    expect(count()).toBe(0);
  });

  it('notifies every subscriber', () => {
    const channel = createCameraChannel(0, DAY);
    let a = 0;
    let b = 0;
    channel.subscribe(() => {
      a++;
    });
    channel.subscribe(() => {
      b++;
    });
    channel.publish(DAY * 2);
    expect([a, b]).toEqual([1, 1]);
  });

  it('stops notifying after the returned unsubscribe is called', () => {
    // A leak here keeps an unmounted HUD's setState alive for the life of the page.
    const { channel, unsubscribe, count } = subscribed(0, DAY);
    channel.publish(DAY * 2);
    unsubscribe();
    channel.publish(DAY * 4);
    channel.settle(DAY * 4.5);
    expect(count()).toBe(1);
  });

  it('leaves the OTHER subscribers alone when one unsubscribes', () => {
    const channel = createCameraChannel(0, DAY);
    let survivor = 0;
    const drop = channel.subscribe(() => {});
    channel.subscribe(() => {
      survivor++;
    });
    drop();
    channel.publish(DAY * 2);
    expect(survivor).toBe(1);
  });

  it('tolerates an unsubscribe called twice, and one called during a notification', () => {
    // React StrictMode double-invokes effects, and a listener that tears itself down from
    // inside its own callback is a realistic HUD unmount race. Deleting from a `Set`
    // mid-iteration is safe; this pins that it stays that way.
    const channel = createCameraChannel(0, DAY);
    let selfRemoving = 0;
    let bystander = 0;
    const stop = channel.subscribe(() => {
      selfRemoving++;
      stop();
      stop();
    });
    channel.subscribe(() => {
      bystander++;
    });

    channel.publish(DAY * 2);
    channel.publish(DAY * 4);
    expect(selfRemoving).toBe(1);
    expect(bystander).toBe(2);
  });

  it('keeps publishing usable with no subscribers at all', () => {
    // The pre-mount window: `CorridorControls` may drive the channel before the HUD
    // subscribes, and the value it lands on must be the one the HUD then reads.
    const channel = createCameraChannel(0, DAY);
    channel.publish(DAY * 3);
    channel.settle(DAY * 3.25);
    expect(channel.get()).toBe(DAY * 3.25);
  });
});

// ---------------------------------------------------------------------------
// Degenerate epsilon
// ---------------------------------------------------------------------------

describe('a non-positive epsilon degrades safely instead of notifying every frame', () => {
  it('substitutes Number.EPSILON for zero, so an unchanged value is still silent', () => {
    // The documented guard. With a literal zero threshold `Math.abs(x - current) < 0` is
    // false for every x including the current one, so an idle camera would re-render the
    // HUD on every frame — the exact failure the module exists to prevent.
    const { channel, count } = subscribed(100, 0);
    channel.publish(100);
    expect(count()).toBe(0);
    channel.publish(100 + 1e-9);
    expect(count()).toBe(1);
  });

  it('does the same for a negative epsilon', () => {
    const { channel, count } = subscribed(100, -5);
    channel.publish(100);
    expect(count()).toBe(0);
    channel.publish(101);
    expect(count()).toBe(1);
  });
});
