/**
 * The 3D pieces both the Corridor (P4) and the Tech Tree (P13) mount.
 *
 * Everything here is view-agnostic by construction: no module in this directory imports
 * a store, a time scale, or anything from `views/timeline/` or `views/tech-tree/`. If a
 * file here ever needs one of those, it belongs in the view instead — that dependency is
 * the first step of the fork this directory exists to prevent (P4.3, P4.4).
 */

export { EventNode } from './EventNode';
export type { EventNodeEvent, EventNodeProps, EventNodeState } from './EventNode';

// `eventNodeVisual` is the pure half of `EventNode`, and everything it decides is
// re-exported here — including the label geometry, which a VIEW's layout needs in order to
// de-collide labels (`views/timeline/layout.ts`, P4.2.3). That direction is the allowed
// one: the view reaches in, this directory never reaches out.
export {
  approachScale,
  eventNodeVisual,
  labelHalfWidth,
  labelVisible,
  DATE_FONT_SIZE,
  DIMMED_EMISSIVE,
  DIMMED_OPACITY,
  EVENT_NODE_HALO_SCALE,
  EVENT_NODE_RADIUS,
  HOVER_SCALE,
  HOVER_TWEEN_SECONDS,
  LABEL_ADVANCE_RATIO,
  LABEL_DATE_OFFSET_Y,
  LABEL_MIN_HALF_WIDTH,
  LABEL_OFFSET_Y,
  NODE_FOOTPRINT_ABOVE,
  NODE_FOOTPRINT_BELOW,
  NODE_FOOTPRINT_HEIGHT,
  TITLE_FONT_SIZE,
} from './eventNodeVisual';
export type { EventNodeVisual } from './eventNodeVisual';

export { Scene3D } from './Scene3D';
export type { Scene3DProps } from './Scene3D';

export {
  DEFAULT_BLOOM,
  DEFAULT_CAMERA_POSE,
  DEFAULT_LIGHTING,
  DEFAULT_STARFIELD,
  resolveSceneSettings,
} from './sceneSettings';
export type {
  BloomSettings,
  CameraPose,
  LightingSettings,
  SceneSettings,
  SceneSettingsInput,
  StarfieldSettings,
} from './sceneSettings';

export {
  readSystemReducedMotion,
  ReducedMotionContext,
  REDUCED_MOTION_QUERY,
  subscribeSystemReducedMotion,
  useReducedMotion,
  useSystemReducedMotion,
} from './reducedMotion';
