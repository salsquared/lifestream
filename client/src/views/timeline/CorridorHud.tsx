import { useSyncExternalStore } from 'react';

import { formatWhen } from '@shared/formatWhen';
import { CORRIDOR_END } from '@shared/timeScale';

import { cameraDateIso, cutoffOpacity } from './hud';

import type { TimeScale } from '@shared/timeScale';
import type { CameraChannel } from './cameraChannel';

/**
 * The corridor's HUD — implementation P4.6.
 *
 * A DOM overlay, not in-canvas text: it is chrome that must stay legible at a fixed size
 * whatever the camera is doing, and a `drei <Text>` would scale and rotate with the
 * scene. It reads the camera's x through the external channel rather than through props,
 * so a pan re-renders this component and nothing else (see `cameraChannel.ts`).
 *
 * Two things are on it, and both are inversions of the canonical scale rather than
 * independent state:
 *
 *   - **The current date** — `scale.toDate(cameraX)`, rendered through `formatWhen` so
 *     the HUD spells a date the same way every node label, detail panel and export
 *     builder does (P4.7). Day precision: the camera is at an instant, but announcing
 *     `13 August 2034, 20:51` for a position that is only ever approximate would be a
 *     precision the reader cannot act on.
 *   - **The cutoff warning** — a fade rather than a toggle, in over the last six months
 *     before `CORRIDOR_END`. The corpus ends there; the corridor does not, and the
 *     reader should be told which side of that edge they are on.
 */
export interface CorridorHudProps {
  /** THE canonical scale the nodes were positioned with. */
  scale: TimeScale;
  /** The camera's x, published by `CorridorControls`. */
  channel: CameraChannel;
  /** A one-line note under the readout — the fixture badge, or a load error. */
  notice?: string;
}

/** `CORRIDOR_END` as a bare date, so the marker's label cannot drift from the constant. */
const CUTOFF_LABEL = CORRIDOR_END.slice(0, 10);

export function CorridorHud({ scale, channel, notice }: CorridorHudProps) {
  const cameraX = useSyncExternalStore(channel.subscribe, channel.get, channel.get);

  const at = cameraDateIso(scale, cameraX);
  const label = formatWhen({ when: at, whenMin: at, whenMax: at, whenPrecision: 'day' });
  const warning = cutoffOpacity(at, CORRIDOR_END);

  return (
    <div className="corridor-hud">
      <p className="corridor-hud__date">{label}</p>

      {/* Always mounted, faded by opacity: mounting it at the threshold would pop the
          layout and defeat the point of a ramp. */}
      <p className="corridor-hud__cutoff" style={{ opacity: warning }} aria-hidden={warning === 0}>
        {CUTOFF_LABEL} cutoff
      </p>

      {notice === undefined ? null : <p className="corridor-hud__notice">{notice}</p>}
    </div>
  );
}
