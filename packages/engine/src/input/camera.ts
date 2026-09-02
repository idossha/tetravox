/**
 * What each §7.5 gesture does to a camera or a layer — **pure functions over plain numbers**.
 *
 * Nothing here touches the scene, the store or GL. Every one of these is the closed form of a gate
 * assertion: R2's "the world point under the pointer is unchanged (±0.1 mm)" is a property of
 * {@link zoomAbout} alone, and it is proved in `input/camera.test.ts` at exact arithmetic rather
 * than through a browser.
 */

import { quat as gquat, mat4 as glMat4 } from 'gl-matrix';
import { asGl, identity4 } from '../view/m4';
import type { Camera3D, quat, Scale, vec2, vec3 } from '../scene/types';

// -------------------------------------------------------------------------------------------
// 2D pan and zoom
// -------------------------------------------------------------------------------------------

/** R2: "clamped to [0.01, 20] mm/px". */
export const MIN_MM_PER_PX = 0.01;
export const MAX_MM_PER_PX = 20;

/**
 * One zoom notch. `⌘/Ctrl+wheel` up divides `mmPerPx` by this; `+` multiplies/divides about the
 * pane centre by the same amount, so the keyboard and the wheel agree step for step.
 */
export const ZOOM_STEP = 1.2;

/**
 * The `deltaY` one mouse-wheel notch reports in `DOM_DELTA_PIXEL`.
 *
 * Chromium reports 100 for a wheel notch and a small continuous value for a trackpad pinch, so
 * raising {@link ZOOM_STEP} to `deltaY / WHEEL_NOTCH` gives a notch exactly one step and a pinch a
 * smooth fraction of one — the same code path for both, which is what R2 asks for.
 */
export const WHEEL_NOTCH = 100;

export interface Camera2D {
  center: vec2;
  mmPerPx: number;
}

export function clampMmPerPx(mm: number): number {
  if (!Number.isFinite(mm) || mm <= 0) return MIN_MM_PER_PX;
  return Math.min(MAX_MM_PER_PX, Math.max(MIN_MM_PER_PX, mm));
}

/**
 * R2: zoom **about a point**, keeping the world point under it fixed.
 *
 * `offsetX` / `offsetY` are the pointer's offset from the pane centre in **plane** axes — `+x` along
 * `right`, `+y` along `up` — i.e. `offsetX = px + 0.5 − width/2` and `offsetY = height/2 − py − 0.5`
 * for a top-left-origin pixel.
 *
 * The world coordinate under that offset is `center + offset · mmPerPx` in each axis, so holding it
 * fixed across a change of scale is one line: `center' = center + (mm − mm') · offset`. It is exact,
 * which is why R2's gate can demand 0.1 mm on a real 256 mm volume. The anchor of the in-plane
 * frame (`view/geometry.ts`'s `planeAnchor`) cancels: it shifts `center` by a constant that zooming
 * does not touch.
 */
export function zoomAbout(
  cam: Camera2D,
  offsetX: number,
  offsetY: number,
  factor: number
): Camera2D {
  const mm = cam.mmPerPx;
  const next = clampMmPerPx(mm * factor);
  return {
    center: [cam.center[0] + (mm - next) * offsetX, cam.center[1] + (mm - next) * offsetY],
    mmPerPx: next,
  };
}

/** R2's `+` / `-`: the same zoom, about the pane centre, where the offsets are zero. */
export function zoomAboutCentre(cam: Camera2D, factor: number): Camera2D {
  return { center: [cam.center[0], cam.center[1]], mmPerPx: clampMmPerPx(cam.mmPerPx * factor) };
}

/**
 * R3's pan: a drag of `dxPx`/`dyPx` **top-left-origin device pixels** moves the image with the
 * pointer, so the world point at the pane centre moves the other way.
 */
export function panBy(cam: Camera2D, dxPx: number, dyPx: number): Camera2D {
  return {
    center: [cam.center[0] - dxPx * cam.mmPerPx, cam.center[1] + dyPx * cam.mmPerPx],
    mmPerPx: cam.mmPerPx,
  };
}

/** A wheel/pinch `deltaY` (already normalised to `DOM_DELTA_PIXEL`) as a zoom factor. */
export function wheelZoomFactor(deltaY: number): number {
  return Math.pow(ZOOM_STEP, deltaY / WHEEL_NOTCH);
}

/**
 * Normalise a `WheelEvent`'s delta to pixels.
 *
 * `deltaMode` is `DOM_DELTA_LINE` on Firefox and on some Linux configurations and `DOM_DELTA_PAGE`
 * on almost nothing — but a viewer that treats 3 lines as 3 pixels scrolls a hundredth of a slice
 * per notch there, which reads as "the wheel is broken".
 */
export function normaliseWheelDelta(delta: number, deltaMode: number): number {
  if (deltaMode === 1) return delta * 16;
  if (deltaMode === 2) return delta * WHEEL_NOTCH;
  return delta;
}

// -------------------------------------------------------------------------------------------
// Window/level and opacity (§7.5's right-drag and Shift+drag)
// -------------------------------------------------------------------------------------------

/** A full-pane horizontal drag multiplies the window width by `e^±2`; vertical shifts the centre. */
export const WINDOW_SENSITIVITY = 2;

/**
 * §7.5's right-drag: window/level on one layer's {@link Scale}.
 *
 * `nx` / `ny` are the drag in **fractions of the pane** (`dx / width`, `dy / height`), so the
 * gesture feels the same in a 2×2 cell as in a maximised pane. Horizontal is width (contrast),
 * vertical is centre (brightness); dragging **down** raises the centre, which darkens the image —
 * the Freeview/DICOM convention.
 *
 * Width moves multiplicatively so the gesture is scale-free and can never cross zero: a `T1.nii.gz`
 * window of 1200 and a `TI_max` window of 0.4 respond identically in relative terms.
 */
export function windowLevel(scale: Scale, nx: number, ny: number): Scale {
  const k = Math.exp(nx * WINDOW_SENSITIVITY);
  if (scale.kind === 'linear') {
    const width = Math.max(scale.hi - scale.lo, Number.EPSILON);
    const centre = (scale.lo + scale.hi) / 2 + ny * width * WINDOW_SENSITIVITY;
    const next = width * k;
    const [lo, hi] = positiveWidth(centre - next / 2, centre + next / 2);
    return { kind: 'linear', lo, hi };
  }
  const width = Math.max(scale.max - scale.min, Number.EPSILON);
  const shift = ny * width * WINDOW_SENSITIVITY;
  const centre = (scale.min + scale.max) / 2 + shift;
  const next = width * k;
  const [min, max] = positiveWidth(centre - next / 2, centre + next / 2);
  // `mid` keeps its position within the window rather than its absolute value, so the three-stop
  // ramp does not invert halfway through a drag.
  const t = width > 0 ? (scale.mid - scale.min) / width : 0.5;
  return { ...scale, min, max, mid: min + t * (max - min) };
}

/**
 * Guarantee `hi > lo` at float64's own floor.
 *
 * `windowLevel` is multiplicative, so a long enough narrowing drag reaches a width below the ulp of
 * the window's centre and `centre ± next/2` collapses to a single number. A zero-width window is a
 * divide-by-zero in every colormap bake downstream, so the last representable step is where it stops.
 */
function positiveWidth(lo: number, hi: number): [number, number] {
  if (hi > lo) return [lo, hi];
  const ulp = Math.max(Number.MIN_VALUE, Math.abs(lo) * 8 * Number.EPSILON);
  return [lo, lo + ulp];
}

/** §7.5's `Shift+drag`: dragging **up** makes the active layer more opaque. */
export function opacityAfterDrag(opacity: number, ny: number): number {
  return Math.min(1, Math.max(0, opacity - ny));
}

// -------------------------------------------------------------------------------------------
// The 3D camera (§7.5: left orbit, right pan, wheel dolly)
// -------------------------------------------------------------------------------------------

/** Radians of orbit per device pixel: a ~360 px drag is a half turn. */
export const ORBIT_RAD_PER_PX = Math.PI / 360;

/** One wheel notch of dolly. */
export const DOLLY_STEP = 1.2;

function columns(rotation: quat): { right: vec3; up: vec3 } {
  const m = identity4();
  glMat4.fromQuat(asGl(m), rotation as unknown as gquat);
  return {
    right: [m[0] ?? 1, m[1] ?? 0, m[2] ?? 0],
    up: [m[4] ?? 0, m[5] ?? 1, m[6] ?? 0],
  };
}

/**
 * Arcball orbit: rotate about the camera's **current** screen axes, so the drag direction always
 * matches the apparent motion however far the camera has already turned.
 *
 * `Camera3D.rotation` maps camera-local axes to world (its columns are right / up / back, which is
 * what `camera3dMatrices` reads), so a screen-space turn is a **pre**-multiplication in world space
 * by rotations about those two world-space axes. Post-multiplying instead — the common mistake —
 * gives a camera that tumbles about its own axes and gimbals as soon as it looks down.
 */
export function orbit(cam: Camera3D, dxPx: number, dyPx: number): Camera3D {
  const { right, up } = columns(cam.rotation);
  const yaw = gquat.setAxisAngle(
    gquat.create(),
    up as unknown as [number, number, number],
    -dxPx * ORBIT_RAD_PER_PX
  );
  const pitch = gquat.setAxisAngle(
    gquat.create(),
    right as unknown as [number, number, number],
    -dyPx * ORBIT_RAD_PER_PX
  );
  const delta = gquat.multiply(gquat.create(), yaw, pitch);
  const next = gquat.multiply(gquat.create(), delta, cam.rotation as unknown as gquat);
  gquat.normalize(next, next);
  return { ...cam, rotation: [next[0], next[1], next[2], next[3]] };
}

/** Millimetres per device pixel at the 3D camera's target plane. */
export function mmPerPx3D(cam: Camera3D, heightPx: number): number {
  if (heightPx <= 0) return 1;
  const halfH = Math.tan(((cam.fovYDeg * Math.PI) / 180) * 0.5) * cam.distance;
  return (2 * halfH) / heightPx;
}

/** §7.5's 3D right-drag: slide the target so the scene follows the pointer. */
export function pan3D(cam: Camera3D, dxPx: number, dyPx: number, heightPx: number): Camera3D {
  const { right, up } = columns(cam.rotation);
  const s = mmPerPx3D(cam, heightPx);
  return {
    ...cam,
    target: [
      cam.target[0] - right[0] * dxPx * s + up[0] * dyPx * s,
      cam.target[1] - right[1] * dxPx * s + up[1] * dyPx * s,
      cam.target[2] - right[2] * dxPx * s + up[2] * dyPx * s,
    ],
  };
}

/**
 * §7.5's 3D wheel dolly.
 *
 * Clamped inside the camera's own near/far — §7.2 fits those to the scene radius and warns that a
 * sub-millimetre near plane breaks depth ordering, so dollying through the near plane is not a thing
 * the user is allowed to do by accident.
 */
export function dolly(cam: Camera3D, deltaY: number): Camera3D {
  const factor = Math.pow(DOLLY_STEP, deltaY / WHEEL_NOTCH);
  const lo = cam.near * 2;
  const hi = cam.far * 0.5;
  const distance = Math.min(Math.max(cam.distance * factor, lo), Math.max(lo, hi));
  return { ...cam, distance };
}
