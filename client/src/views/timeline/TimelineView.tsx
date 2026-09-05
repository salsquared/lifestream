import { useMemo } from 'react';

import { CORRIDOR_START, TIME_SCALE } from '@shared/timeScale';

import { useWorld } from '../../shell/stores/world';
import { EventNode, Scene3D } from '../_shared';
import { createCameraChannel } from './cameraChannel';
import { corridorCorpus } from './corpus';
import { CorridorControls } from './CorridorControls';
import { CorridorHud } from './CorridorHud';
import { worldUnitsPerDay } from './hud';
import { createCorridorLayout } from './layout';
import { clampPan, panBounds } from './pan';

import type { IsoInstant } from '@shared/types/index';

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
 *     query. What it draws for each phase of that load is `corpus.ts`'s decision, not
 *     this file's — the fixture is gated on the load's STATUS and never on a row count.
 *   - **It does not build a scale.** {@link TIME_SCALE} is THE canonical scale (§5.2,
 *     normative), a process constant on a fixed origin: the same object the Tech Tree's X
 *     axis, the viewport clamp and every later fly-to target use. A scale built here —
 *     from this view's corpus, as this file did until the P4 review — would put the two
 *     views on origins ~145 world units apart with no error in either.
 *   - **It does not let `EventNode` position itself** (P4.3.2). Position is computed by
 *     the caller, always — the Tech Tree places the same component by lane instead.
 *   - **It does not draw strata.** Every node's z is `CORRIDOR_DEPTH`, which is 0
 *     (P4.2.4). The z-dependent parallax multiplier arrives in P7.6 and is applied at
 *     draw time only.
 */

/**
 * One scale, therefore one layout, one clamp and one HUD redraw threshold — all three at
 * module level, because none of them depends on the corpus, on the save or on the mount.
 * Memoizing them per render would be theatre now that the scale is a constant, and would
 * suggest they can change.
 */
const CORRIDOR_LAYOUT = createCorridorLayout(TIME_SCALE);
const CORRIDOR_BOUNDS = panBounds(TIME_SCALE);
const CORRIDOR_UNITS_PER_DAY = worldUnitsPerDay(TIME_SCALE);

export function TimelineView() {
  const worldEvents = useWorld((state) => state.events);
  const status = useWorld((state) => state.status);

  // Rows, source and HUD notice come out together, from one function, over the load's
  // status. Deriving the notice separately from the rows is how the badge ends up lying
  // about what is on screen — which is exactly what it did.
  const { events, notice } = useMemo(
    () => corridorCorpus(status, Object.values(worldEvents)),
    [status, worldEvents],
  );

  // Positions are memoized, not computed inline: `place` returns fresh arrays on every
  // call, and a new array prop every render would re-render every node on every frame the
  // container happens to update. `labelled` rides along — the layout is the only thing
  // that knows about a node's neighbours (P4.2.3).
  const placed = useMemo(() => CORRIDOR_LAYOUT.place(events), [events]);

  // Opens on the corpus's earliest node rather than on the padded bound, so the corridor
  // starts on something instead of on the empty slack before it.
  //
  // Corpus-derived, and deliberately still so: this is a camera POSE, not a scale. A pose
  // is allowed to depend on what is being drawn — it is read once, at mount, and nothing
  // is stored against it — where an origin is not, because every persisted x is expressed
  // in it. With no nodes to open on (`pending`, `empty`) that is the corridor's own start.
  const initialX = useMemo(() => {
    const earliest = events.reduce<IsoInstant>(
      (min, event) => (event.when < min ? event.when : min),
      events[0]?.when ?? CORRIDOR_START,
    );
    return clampPan(TIME_SCALE.toX(earliest), CORRIDOR_BOUNDS);
  }, [events]);

  // Re-created with the opening pose, because the channel holds the camera's live x and a
  // new corpus opens somewhere else.
  const channel = useMemo(() => createCameraChannel(initialX, CORRIDOR_UNITS_PER_DAY), [initialX]);

  return (
    <div className="corridor-view">
      <Scene3D>
        <CorridorControls bounds={CORRIDOR_BOUNDS} initialX={initialX} channel={channel} />
        {placed.map(({ event, position, labelled }) => (
          <EventNode
            key={event.id}
            event={event}
            position={position}
            labelled={labelled}
            state="normal"
          />
        ))}
      </Scene3D>

      <CorridorHud scale={TIME_SCALE} channel={channel} notice={notice} />
    </div>
  );
}
