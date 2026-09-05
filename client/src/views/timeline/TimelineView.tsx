import { useMemo } from 'react';

import { createTimeScale } from '@shared/timeScale';

import { useWorld } from '../../shell/stores/world';
import { EventNode, Scene3D } from '../_shared';
import { createCameraChannel } from './cameraChannel';
import { CorridorControls } from './CorridorControls';
import { CorridorHud } from './CorridorHud';
import { CORRIDOR_FIXTURE } from './fixture';
import { worldUnitsPerDay } from './hud';
import { createCorridorLayout } from './layout';
import { clampPan, panBounds } from './pan';

import type { HydratedEvent } from '@shared/types/index';

import './corridor.css';

/**
 * The Time Corridor — implementation P4, architecture §5.2.
 *
 * Events laid out along a 3D time axis, with the camera panning along it. This file is
 * the container: it decides *where every node goes* and hands each position to a node
 * that renders it. Four things it deliberately does not do:
 *
 *   - **It does not fetch.** The shell owns the per-save load (§4.2, P4.1) so four views
 *     never race for the same event list; this one subscribes to `useWorld` and issues no
 *     query. When the store is empty it falls back to `CORRIDOR_FIXTURE` and says so on
 *     the HUD.
 *   - **It does not build its own scale.** `createTimeScale` is THE canonical scale
 *     (§5.2, normative): the same object the Tech Tree's X axis, the viewport clamp and
 *     every later fly-to target use. A second scale here would desynchronise the views
 *     the first time either changed.
 *   - **It does not let `EventNode` position itself** (P4.3.2). Position is computed by
 *     the caller, always — the Tech Tree places the same component by lane instead.
 *   - **It does not draw strata.** Every node's z is `CORRIDOR_DEPTH`, which is 0
 *     (P4.2.4). The z-dependent parallax multiplier arrives in P7.6 and is applied at
 *     draw time only.
 */

/** Ordering the resolve endpoint already uses; applied to the store's rows for stability. */
function byWhenThenId(a: HydratedEvent, b: HydratedEvent): number {
  if (a.when !== b.when) return a.when < b.when ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

export function TimelineView() {
  const worldEvents = useWorld((state) => state.events);
  const status = useWorld((state) => state.status);

  // The two travel together: whether the fixture is in use is exactly whether the store
  // had rows, and deriving them separately is how the badge ends up lying.
  const { events, usingFixture } = useMemo(() => {
    const rows = Object.values(worldEvents);
    if (rows.length === 0) {
      return { events: CORRIDOR_FIXTURE as readonly HydratedEvent[], usingFixture: true };
    }
    return {
      events: [...rows].sort(byWhenThenId) as readonly HydratedEvent[],
      usingFixture: false,
    };
  }, [worldEvents]);

  // The scale's origin. `min(event.when)` over whatever corpus is on screen — the same
  // choice `createTimeScale` documents. The fallback is unreachable (the fixture is a
  // non-empty tuple) and exists so the origin is a `string` rather than a maybe-string
  // threaded through every memo below.
  const earliest = useMemo(
    () =>
      events.reduce<string>(
        (min, event) => (event.when < min ? event.when : min),
        events[0]?.when ?? CORRIDOR_FIXTURE[0].when,
      ),
    [events],
  );

  const scale = useMemo(() => createTimeScale(earliest), [earliest]);
  const layout = useMemo(() => createCorridorLayout(scale), [scale]);
  const bounds = useMemo(() => panBounds(scale), [scale]);

  // Positions are memoized, not computed inline: `position` is a fresh array on every
  // call, and a new array prop every render would re-render every node on every frame the
  // container happens to update.
  const placed = useMemo(
    () => events.map((event) => ({ event, position: layout.position(event) })),
    [events, layout],
  );

  // Opens at the earliest event rather than at the padded bound, so the corridor starts
  // on its first node instead of on the empty slack before it.
  const initialX = useMemo(() => clampPan(scale.toX(earliest), bounds), [scale, earliest, bounds]);

  // Re-created with the scale, because both the opening pose and the HUD's redraw
  // threshold are expressed in that scale's world units.
  const channel = useMemo(
    () => createCameraChannel(initialX, worldUnitsPerDay(scale)),
    [initialX, scale],
  );

  const notice = usingFixture
    ? status === 'error'
      ? 'World load failed — drawing the seeded fixture.'
      : 'Fixture data — no save hydrated yet.'
    : undefined;

  return (
    <div className="corridor-view">
      <Scene3D>
        <CorridorControls bounds={bounds} initialX={initialX} channel={channel} />
        {placed.map(({ event, position }) => (
          <EventNode key={event.id} event={event} position={position} state="normal" />
        ))}
      </Scene3D>

      <CorridorHud scale={scale} channel={channel} notice={notice} />
    </div>
  );
}
