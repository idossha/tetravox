/**
 * `src/input/` — §7.5's pointer and gesture layer (P2-01, and maintainer requirements R1/R2/R3).
 *
 * Three layers, deliberately separated so that only the thinnest of them needs a browser to test:
 *
 * | File | What it is | How it is tested |
 * |---|---|---|
 * | `gestures.ts` | which gesture a press means, and the drag bookkeeping | vitest, no DOM |
 * | `camera.ts` | what each gesture does to a camera or a layer, in closed form | vitest, exact arithmetic |
 * | `interaction.ts` | §7.2's `interacting` flag and the adaptive-quality hook | vitest, injected clock |
 * | `pointer.ts` | the DOM bindings, and nothing else | Playwright, `test/e2e/pointer.spec.ts` |
 *
 * **Shared-file rule: additive only.** Append an export; never
 * reorder or repurpose an existing one.
 */

export { GestureMachine, resolveGesture, NO_MODIFIERS } from './gestures';
export type { GestureEvent, GestureKind, Modifiers, PanePoint } from './gestures';
// §13's point tool (2026-08-30): what a press landed on, as an options bag rather than a fifth
// positional boolean.
export type { GestureTargets } from './gestures';
export {
  clampMmPerPx,
  dolly,
  mmPerPx3D,
  normaliseWheelDelta,
  opacityAfterDrag,
  orbit,
  pan3D,
  panBy,
  wheelZoomFactor,
  windowLevel,
  zoomAbout,
  zoomAboutCentre,
  DOLLY_STEP,
  MAX_MM_PER_PX,
  MIN_MM_PER_PX,
  ORBIT_RAD_PER_PX,
  WHEEL_NOTCH,
  WINDOW_SENSITIVITY,
  ZOOM_STEP,
} from './camera';
export type { Camera2D } from './camera';
export {
  adaptiveLevel,
  median,
  InteractionState,
  DEFAULT_SETTLE_MS,
  FRAME_BUDGET_MS_60HZ,
  FRAME_WINDOW,
  QUALITY_LEVELS,
} from './interaction';
export type { InteractionOptions } from './interaction';
export { PointerLayer } from './pointer';
export type { PaneHit, PointerHost } from './pointer';
