/**
 * One event, drawn as a glowing sphere with a billboarded label (P4.3).
 *
 * ## It does not know which view it is in
 *
 * `position` is computed by the CALLER and never here (P4.3.2, contract S5). This
 * component imports no time scale, reads no store, and has no idea whether it is in the
 * Corridor or the Tech Tree — which is the only reason one component can serve both.
 * The Corridor places it at time × category band (P4.2.2); the Tech Tree places the same
 * component at time × technology lane (P13.4). A node that derived its own y from a
 * category band would be in the wrong lane in the second view, and the second consumer
 * would fork it rather than fight it. Everything view-specific is a prop.
 *
 * The corollary is that this file has no layout code at all: it renders what it is
 * handed, and the only transform it owns is the hover tween, which is a scale.
 *
 * ## Dates are rendered by precision, never by the roll
 *
 * The label's date goes through `formatWhen` (`@shared/formatWhen`, P4.7), which is
 * driven by `whenPrecision`. `event.when` is a seeded ROLL inside `[whenMin, whenMax]`
 * — printing it for a year-precision event would state a month and a day the Bible
 * never gave, which is the exact fabrication the precision column exists to prevent
 * (§2.3). It is also why this component takes the whole event rather than a pre-formatted
 * string: a caller that formats the date itself is a caller that can get it wrong.
 *
 * ## Colour
 *
 * `CATEGORY_COLOR` via {@link eventNodeVisual} — one palette shared with the Tech Tree
 * and the export renderer (P4.3.6). No hex string for a category appears in this file.
 */

import { useFrame } from '@react-three/fiber';
import { Billboard, Text } from '@react-three/drei';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AdditiveBlending, SphereGeometry } from 'three';

import { formatWhen } from '@shared/formatWhen';

import {
  approachScale,
  eventNodeVisual,
  labelVisible,
  DATE_FONT_SIZE,
  EVENT_NODE_HALO_SCALE,
  EVENT_NODE_RADIUS,
  HOVER_SCALE,
  HOVER_TWEEN_SECONDS,
  LABEL_DATE_OFFSET_Y,
  LABEL_OFFSET_Y,
  TITLE_FONT_SIZE,
  type EventNodeState,
} from './eventNodeVisual';
import { useReducedMotion } from './reducedMotion';

import type { EventRow } from '@shared/types/index';
import type { ThreeEvent } from '@react-three/fiber';
import type { Group } from 'three';

export type { EventNodeState };

/**
 * The part of an event a node actually draws.
 *
 * A `Pick`, not `EventRow`, and not `HydratedEvent`: both of those satisfy it, so either
 * view can pass what it already has, while the type states exactly what this component
 * reads. The four date columns travel together because `formatWhen` needs all four —
 * `when` alone cannot be rendered honestly (§2.3).
 */
export type EventNodeEvent = Pick<
  EventRow,
  'id' | 'title' | 'category' | 'when' | 'whenMin' | 'whenMax' | 'whenPrecision'
>;

/**
 * The node's REVIEWED prop surface (P4.3.1).
 *
 * Not a frozen one. This comment used to read "props are pinned by P4.3.1, nothing may be
 * added here without changing that task", which stated a prohibition the task never
 * meant — `dimmed` was added to close the glow/filter gap (§5.2) and `labelled` below was
 * added by the P4 review. What P4.3.1 actually pins is that these props are a contract
 * shared by two views and the export renderer, so every addition is a documented decision
 * with a stated reason, never a convenience passed down because it was to hand.
 *
 * **The addition that is already expected.** P7.5 ramps opacity and emissive intensity as
 * a function of `|camera.z − stratum.z|`. That is a PER-FRAME channel into every node, and
 * everything below is read during React render, so expressing it as an ordinary prop would
 * re-render all 81 nodes sixty times a second to move two floats. The machinery it needs is
 * already in this file and merely unreachable from outside: `scaleRef` + `useFrame` +
 * {@link approachScale} already drive a transform per frame without a single render. Expect
 * P7.5 to add an `envelope` channel on that path — a subscribable value quantized to a step
 * below which nobody is told, exactly as `views/timeline/cameraChannel.ts` already gates the
 * HUD's re-renders on a day's worth of world units — rather than a plain number prop.
 */
export interface EventNodeProps {
  event: EventNodeEvent;
  /**
   * World-space position, computed by the caller. On the canonical scale
   * (`@shared/timeScale`) in both views — but this component never checks, and never
   * transforms it.
   */
  position: [number, number, number];
  state: EventNodeState;
  /**
   * Masked out by the current filter. ORTHOGONAL to `state`, not a value of it: §5.2
   * requires that a node can be glowing and filtered out at once and look like both.
   * Subtractive — it scales whatever `state` produced, and never moves the node.
   */
  dimmed?: boolean;
  /**
   * May this node draw its label?
   *
   * Set by the LAYOUT (`views/timeline/layout.ts`, P4.2.3), which is the only thing that
   * knows about a node's neighbours — this component is view-agnostic by construction and
   * cannot see past itself. Defaults to `true`, so a caller that does not de-collide —
   * P13's tech-tree lanes, a spec, a one-off `<EventNode>` — is unaffected.
   *
   * It never suppresses a label the reader asked for: {@link labelVisible} restores it on
   * hover and for any `state` other than `normal`.
   */
  labelled?: boolean;
  /** Uniform size multiplier, e.g. a stratum's depth falloff. Defaults to `1`. */
  scale?: number;
  onSelect?: (event: EventNodeEvent) => void;
  onHover?: (event: EventNodeEvent, hovered: boolean) => void;
}

/**
 * One unit sphere for every node in the scene.
 *
 * Eighty nodes would otherwise build eighty identical geometries. Radius is baked as
 * `1` and the real size comes from the mesh's `scale`, so state changing the radius
 * costs a transform rather than a rebuild. Module-level and never disposed on purpose:
 * it outlives every view that mounts, and disposing it when one unmounts would leave
 * the other holding a freed buffer.
 */
const NODE_GEOMETRY = new SphereGeometry(1, 24, 16);

/**
 * Vendored, never resolved from a CDN. `<Text>` with no `font` fetches a face from
 * jsdelivr at render time, which leaves every label BLANK offline with no error — in an
 * application that is loopback-bound and local-only by design. Same reasoning as the
 * vendored border geometry. See client/public/fonts/Sora-SemiBold.version.txt.
 */
const NODE_FONT = '/fonts/Sora-SemiBold.ttf';

/**
 * Neutral label ink and its outline, mirroring `--fg` / `--bg` in `client/src/styles.css`.
 *
 * Hard-coded because a CSS custom property cannot cross into a WebGL material. These are
 * chrome, NOT category colour: every colour that means something about the event comes
 * from `CATEGORY_COLOR` (P4.3.6), and none is written here.
 */
const LABEL_INK = '#e6e6e6';
const LABEL_OUTLINE = '#14171c';

/** The label must not steal the pointer from the node — or from the node behind it. */
const NO_RAYCAST = (): void => {};

export function EventNode({
  event,
  position,
  state,
  dimmed = false,
  labelled = true,
  scale = 1,
  onSelect,
  onHover,
}: EventNodeProps): React.JSX.Element {
  const reducedMotion = useReducedMotion();
  const [hovered, setHovered] = useState(false);
  const visual = eventNodeVisual(state, event.category, dimmed);

  /**
   * The hover tween's target. Read in `useFrame`, so it goes through a ref: the frame
   * callback is registered once and must see the current value without re-subscribing.
   */
  const targetScale = scale * (hovered ? HOVER_SCALE : 1);
  const targetScaleRef = useRef(targetScale);
  targetScaleRef.current = targetScale;

  const tweenSecondsRef = useRef(HOVER_TWEEN_SECONDS);
  tweenSecondsRef.current = reducedMotion ? 0 : HOVER_TWEEN_SECONDS;

  /**
   * The tween writes here, and this group carries NO `scale` prop.
   *
   * That separation is the point: R3F re-applies props on every commit, so a `scale`
   * prop plus a per-frame write would fight — the transform would snap back to the prop
   * value on the next render and the tween would stutter. Position lives on the OUTER
   * group, which has no per-frame writer, so the two never interact.
   */
  const scaleRef = useRef<Group>(null);

  useLayoutEffect(() => {
    // Seed the transform before the first paint: three's default scale is 1, which is
    // only the resting size when `scale` is 1. Mount only — re-running on a `scale`
    // change would snap a hovered node down before tweening it back up.
    const group = scaleRef.current;
    if (group !== null) group.scale.setScalar(targetScaleRef.current);
  }, []);

  useFrame((_state, delta) => {
    const group = scaleRef.current;
    if (group === null) return;
    const next = approachScale(
      group.scale.x,
      targetScaleRef.current,
      delta,
      tweenSecondsRef.current,
    );
    if (next !== group.scale.x) group.scale.setScalar(next);
  });

  useEffect(() => {
    // Pointer affordance. Guarded for non-DOM hosts, and cleaned up so a node that
    // unmounts mid-hover does not leave the cursor stuck.
    if (!hovered || typeof document === 'undefined') return undefined;
    const previous = document.body.style.cursor;
    document.body.style.cursor = 'pointer';
    return () => {
      document.body.style.cursor = previous;
    };
  }, [hovered]);

  const setHoverState = (next: boolean): void => {
    setHovered(next);
    onHover?.(event, next);
  };

  const handlePointerOver = (pointer: ThreeEvent<PointerEvent>): void => {
    // Without this the pointer falls through to every node behind this one, and a dense
    // month hovers as a column rather than as a node.
    pointer.stopPropagation();
    setHoverState(true);
  };

  const handlePointerOut = (): void => {
    setHoverState(false);
  };

  const handleClick = (pointer: ThreeEvent<MouseEvent>): void => {
    pointer.stopPropagation();
    onSelect?.(event);
  };

  const radius = EVENT_NODE_RADIUS * visual.radiusScale;

  return (
    <group position={position}>
      <group ref={scaleRef}>
        <mesh
          geometry={NODE_GEOMETRY}
          scale={radius}
          onPointerOver={handlePointerOver}
          onPointerOut={handlePointerOut}
          onClick={handleClick}
        >
          <meshStandardMaterial
            color={visual.color}
            emissive={visual.color}
            emissiveIntensity={visual.emissiveIntensity}
            transparent={visual.opacity < 1}
            opacity={visual.opacity}
            // The bloom pass reads raw luminance; tone mapping would clamp the emissive
            // peak below `luminanceThreshold` and the glow would never fire.
            toneMapped={false}
          />
        </mesh>

        {visual.haloOpacity > 0 && (
          <mesh
            geometry={NODE_GEOMETRY}
            scale={radius * EVENT_NODE_HALO_SCALE}
            raycast={NO_RAYCAST}
          >
            {/* Additive, per §5.2: glow ADDS a halo, filtering SUBTRACTS opacity, and the
                two have to stay visually distinguishable. `depthWrite={false}` keeps the
                shell from occluding the nodes behind it. */}
            <meshBasicMaterial
              color={visual.color}
              blending={AdditiveBlending}
              transparent
              opacity={visual.haloOpacity}
              depthWrite={false}
              toneMapped={false}
            />
          </mesh>
        )}

        {/* Suppressed only when the layout says this node's label collides with one it
            already granted AND the reader has shown no interest in it — see
            `labelVisible`. Unmounting rather than hiding is deliberate: a `<Text>` with
            `fillOpacity={0}` still costs a troika SDF build and a draw call, and at P5's
            density most labels are suppressed most of the time. */}
        {labelVisible(state, labelled, hovered) && (
          <Billboard position={[0, LABEL_OFFSET_Y, 0]}>
            <Text
              fontSize={TITLE_FONT_SIZE}
              font={NODE_FONT}
              color={LABEL_INK}
              fillOpacity={visual.labelOpacity}
              outlineWidth={0.02}
              outlineColor={LABEL_OUTLINE}
              anchorX="center"
              anchorY="middle"
              raycast={NO_RAYCAST}
            >
              {event.title}
            </Text>
            <Text
              position={[0, LABEL_DATE_OFFSET_Y, 0]}
              fontSize={DATE_FONT_SIZE}
              font={NODE_FONT}
              color={visual.color}
              fillOpacity={visual.labelOpacity}
              outlineWidth={0.02}
              outlineColor={LABEL_OUTLINE}
              anchorX="center"
              anchorY="middle"
              raycast={NO_RAYCAST}
            >
              {formatWhen(event)}
            </Text>
          </Billboard>
        )}
      </group>
    </group>
  );
}
