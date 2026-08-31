/**
 * The selection and hover rings of §7.2's pass 3 — §13's point editing (2026-08-30).
 *
 * A point-editing tool has to say *which* point it is about, and it has to say it on the picture:
 * §8's panel row and §7.2.3's pick target are both somewhere else, and a user dragging a contact
 * needs to see the one they grabbed before they move it. So the answer is a ring around the drawn
 * disc, in {@link OverlayTheme.select}, at the disc's own radius plus a small gap.
 *
 * Two things here are load-bearing.
 *
 * **The ring's radius is derived from the shader's rule, not guessed.** {@link discRadiusPx}
 * reproduces `shaders/points.ts` exactly — the sphere ∩ plane radius, the `dot` branch's constant
 * pixel radius, and the ghost's full radius — and returns `null` for a point the shader culls. A
 * ring at a radius the disc does not have is worse than no ring: it says the tool has selected
 * something other than what the user sees. **The same function is the CPU hit test's**:
 * `layers/points.ts#pointAtPane` imports it and re-exports it under its own name, because a hit rule
 * restated in a second place is a hit rule that drifts away from the picture — exactly as
 * `gizmoHandleAt` shares `handlePoints` with `drawGizmo`. Calling it with `offPlaneOpacity: 0` is
 * the whole of §4.7's "ghosts are never hit".
 *
 * **It is screen-space quad expansion**, like the gizmo's ring and the measurement's segment:
 * `gl.lineWidth()` is a no-op (§7.0.6), so a "1 px" ring is a strip of quads and its width is in
 * overlay pixels scaled by `OverlayMetrics.scale`, which keeps it the same thickness at every zoom.
 *
 * Pure: it takes an {@link OverlayBuilder} and returns nothing, so §11 asserts its geometry with no
 * GL context at all.
 */

import type { OverlayBuilder, OverlayMetrics } from './builder';
import type { vec4 } from '../scene/types';

/** Segments in a ring. 32 keeps a 40 px circle visibly round inside the pass's one draw call. */
export const POINT_RING_SEGMENTS = 32;
/** How far outside the disc the ring sits, in unscaled overlay pixels — §7.2's "r + 2 px". */
export const POINT_RING_GAP_PX = 2;
/** Ring width, in unscaled overlay pixels: the selection's, then the hover's. */
export const POINT_RING_WIDTH_PX = 2;
export const POINT_HOT_RING_WIDTH_PX = 1;
/** No ring smaller than this, in unscaled overlay pixels: a 1 px circle is a dot, not a ring. */
export const POINT_RING_MIN_RADIUS_PX = 4;
/**
 * The `dot` branch's screen radius, in **CSS** pixels — `derived.ts`'s `uDotPx` before `uiScale`.
 *
 * The one radius in this file that is authored in CSS pixels rather than world millimetres, which
 * is why it is the one the CPU rule multiplies by `uiScale`.
 *
 * Exported so the two are one number: a hit test or a ring that hard-coded 4 here would silently
 * stop matching the picture the day the marker got bigger.
 */
export const DOT_RADIUS_PX = 4;

/** The smallest and largest `dotRadiusPx` a layer may ask for, in CSS pixels (§4.4). */
export const DOT_RADIUS_MIN_PX = 0.5;
export const DOT_RADIUS_MAX_PX = 64;

/** What a points layer needs to say how big its discs are. A structural type: §11 builds one by hand. */
export interface DiscShape {
  shape: 'sphere' | 'dot';
  radiusMm: number;
  offPlaneOpacity?: number;
  /** §4.4's `dotRadiusPx` (2026-08-30) — CSS pixels; absent is {@link DOT_RADIUS_PX}. */
  dotRadiusPx?: number;
}

/**
 * The `dot` branch's radius for one layer, in **CSS** pixels — {@link DOT_RADIUS_PX} unless the
 * layer asked for another, clamped to {@link DOT_RADIUS_MIN_PX}…{@link DOT_RADIUS_MAX_PX} (§4.4).
 *
 * One function, exported, because three places have to agree about it and a fourth would drift:
 * `derived.ts` sends `uDotPx = dotRadiusPxOf(layer) · uiScale` to the shader, {@link discRadiusPx}
 * uses it for the ring and for `pointAtPane`'s hit radius, and §11 asserts all three against the
 * same number. Clamped rather than trusted because a scene file is editable text: `NaN` would make
 * the whole quad vanish and 5000 would fill the pane with one marker.
 */
export function dotRadiusPxOf(layer: { dotRadiusPx?: number }): number {
  const asked = layer.dotRadiusPx;
  if (asked === undefined || !Number.isFinite(asked)) return DOT_RADIUS_PX;
  return Math.min(DOT_RADIUS_MAX_PX, Math.max(DOT_RADIUS_MIN_PX, asked));
}

/**
 * The radius, in **pane pixels**, at which a 2D pane draws one point of a points layer — or `null`
 * when it draws nothing there.
 *
 * `shaders/points.ts`, restated on the CPU and nowhere else:
 *
 * * the disc is the sphere ∩ plane circle, `sqrt(r² − d²)` for the signed plane distance `d`;
 * * `|d| ≥ r` is off this slice: `null`, unless {@link DiscShape.offPlaneOpacity} is above 0, in
 *   which case the ghost is drawn at the **full** radius `r`;
 * * `shape: 'dot'` replaces whichever of those radii applies with `dotRadiusPxOf(layer) · uiScale`
 *   pixels — a constant `4 · uiScale` unless §4.4's `dotRadiusPx` says otherwise — after the same
 *   cull: a screen-space marker is culled by world distance and drawn by pixels.
 *
 * **The units, because getting them wrong is the failure this function exists to prevent.**
 * `mmPerPx` is `Camera2D.mmPerPx`, and that is millimetres per **device** pixel, not per CSS pixel:
 * `fitMmPerPx` is fed device-pixel viewport rectangles, `sliceViewProj`'s ortho box is
 * `widthPx · mmPerPx` over a device-pixel `widthPx`, and `paneToWorld`/`worldToPane` take
 * device-pixel pane coordinates. So `radiusMm / mmPerPx` is **already** in the render target's
 * pixels and must not be scaled again — the shader draws the sphere's cross-section at exactly that
 * many device pixels (`shaders/points.ts` expands a world-space quad of radius `r` mm and nothing
 * else is applied to it). `uiScale` appears in the `dot` branch alone, because that branch is the
 * only one whose radius is authored in CSS pixels: `derived.ts` sends
 * `uDotPx = dotRadiusPxOf(layer) · uiScale`, so the CPU's number is that same expression and the two
 * agree at every DPR and at every size §4.4's `dotRadiusPx` asks for.
 *
 * Until 2026-08-30 the sphere branch multiplied by `uiScale` too, which on a Retina display put the
 * selection ring and the CPU hit radius at **twice** the radius of the disc the pane had drawn: a
 * ring visibly detached from its contact, and a click a whole disc-radius outside a contact still
 * grabbing it. Every §11 pane is DPR 1, where `uiScale` is 1 and the error is invisible, which is
 * why the suite could not see it — `point-ring.test.ts` now pins the DPR-2 case explicitly.
 */
export function discRadiusPx(
  layer: DiscShape,
  pointRadiusMm: number,
  signedDistanceMm: number,
  mmPerPx: number,
  uiScale: number
): number | null {
  const r = pointRadiusMm;
  const rr = r * r - signedDistanceMm * signedDistanceMm;
  let radiusMm: number;
  if (rr > 0) {
    radiusMm = Math.sqrt(rr);
  } else if ((layer.offPlaneOpacity ?? 0) > 0) {
    radiusMm = r;
  } else {
    return null;
  }
  if (layer.shape === 'dot') return dotRadiusPxOf(layer) * uiScale;
  if (!(mmPerPx > 0)) return null;
  // No `uiScale`: `mmPerPx` is already per device pixel. See the units note above.
  return radiusMm / mmPerPx;
}

/**
 * The radius the ring is actually drawn at, given the disc's — the one place the gap and the floor
 * are applied, exported because §11 reads a pixel *on* the ring and has to know where it is.
 */
export function ringRadiusPx(discPx: number, scale: number): number {
  return Math.max(POINT_RING_MIN_RADIUS_PX * scale, discPx + POINT_RING_GAP_PX * scale);
}

/**
 * Append a ring centred on `(x, y)` in pane pixels, origin **bottom-left** like every overlay item.
 *
 * `radiusPx` is the **disc's** radius; the gap is added here, once, so no caller has to remember it.
 */
export function drawPointRing(
  b: OverlayBuilder,
  m: OverlayMetrics,
  center: readonly [number, number],
  radiusPx: number,
  widthPx: number,
  color: vec4
): void {
  const r = ringRadiusPx(radiusPx, m.scale);
  const half = Math.max(0.5, (widthPx * m.scale) / 2);
  let prev: [number, number] = [center[0] + r, center[1]];
  for (let i = 1; i <= POINT_RING_SEGMENTS; i += 1) {
    const t = (i / POINT_RING_SEGMENTS) * Math.PI * 2;
    const next: [number, number] = [center[0] + r * Math.cos(t), center[1] + r * Math.sin(t)];
    segment(b, prev, next, half, color);
    prev = next;
  }
}

/** A thick screen-space segment, as one quad — §7.0.6's expansion, `overlay/measure.ts`'s primitive. */
function segment(
  b: OverlayBuilder,
  a: readonly [number, number],
  c: readonly [number, number],
  halfWidth: number,
  color: vec4
): void {
  const dx = c[0] - a[0];
  const dy = c[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (!(len > 1e-6)) return;
  const nx = (-dy / len) * halfWidth;
  const ny = (dx / len) * halfWidth;
  b.quad(
    [a[0] + nx, a[1] + ny],
    [c[0] + nx, c[1] + ny],
    [c[0] - nx, c[1] - ny],
    [a[0] - nx, a[1] - ny],
    color
  );
}
