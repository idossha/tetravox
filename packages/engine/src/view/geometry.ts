/**
 * View bases, slice planes, cameras and orientation letters — §3, §4.5, §7.5.
 *
 * The one rule everything here follows (§3):
 * * `right = cross(up, normal)` in **neurological**; `radiological` negates `right` **only** — a
 *   mirror about the vertical screen axis, never touching `up`. This is the only definition, and it
 *   is what makes the flag well-defined for oblique planes.
 * * The slice plane is **derived, never stored**: `plane = { normal, offset: -dot(normal, cursor) }`.
 *   One source of truth (the cursor) means cursor sync is identical for canonical and oblique views.
 */

import { mat4 as glMat4, quat, vec3 as gvec3 } from 'gl-matrix';
import type { mat4 } from '../scene/types';
import { asGl, identity4 } from './m4';
import type { Aabb, Camera3D, Plane, SliceMode, SliceView, vec3 } from '../scene/types';

export interface SliceBasis {
  right: vec3;
  up: vec3;
  normal: vec3;
}

function norm(v: vec3): vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 1];
}

function cross(a: vec3, b: vec3): vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function dot3(a: vec3, b: vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** §3's canonical preset normals: axial `+Z`, coronal `+Y`, sagittal `+X`. */
export function presetNormal(mode: SliceMode): vec3 {
  switch (mode) {
    case 'axial':
      return [0, 0, 1];
    case 'coronal':
      return [0, 1, 0];
    case 'sagittal':
      return [1, 0, 0];
    case 'oblique':
      return norm([1, 1, 1]);
  }
}

/** Screen-up for each preset: anterior up for axial, superior up otherwise. */
export function presetUp(mode: SliceMode): vec3 {
  return mode === 'axial' ? [0, 1, 0] : [0, 0, 1];
}

/**
 * The orthonormal screen basis of a slice view.
 *
 * `up` is re-orthogonalised (§4.5: `up <- normalize(up - (up·n)n)`); a degenerate `up` — one within
 * `1e-4` of parallel to the normal — falls back to whichever world axis is least aligned with the
 * normal, rather than producing NaNs.
 */
export function sliceBasis(
  view: Pick<SliceView, 'normal' | 'up'>,
  radiological: boolean
): SliceBasis {
  const n = norm(view.normal);
  let u: vec3 = view.up;
  const d = dot3(u, n);
  u = [u[0] - d * n[0], u[1] - d * n[1], u[2] - d * n[2]];
  if (Math.hypot(u[0], u[1], u[2]) < 1e-4) {
    const ax =
      Math.abs(n[0]) < Math.abs(n[1])
        ? Math.abs(n[0]) < Math.abs(n[2])
          ? 0
          : 2
        : Math.abs(n[1]) < Math.abs(n[2])
          ? 1
          : 2;
    const fallback: vec3 = ax === 0 ? [1, 0, 0] : ax === 1 ? [0, 1, 0] : [0, 0, 1];
    const d2 = dot3(fallback, n);
    u = [fallback[0] - d2 * n[0], fallback[1] - d2 * n[1], fallback[2] - d2 * n[2]];
  }
  u = norm(u);
  let r = cross(u, n);
  if (radiological) r = [-r[0], -r[1], -r[2]];
  return { right: norm(r), up: u, normal: n };
}

/** §4.5: derived from the cursor, never stored. Keep side is `dot(normal, x) + offset >= 0`. */
export function slicePlane(view: Pick<SliceView, 'normal'>, cursor: vec3): Plane {
  const n = norm(view.normal);
  return { normal: n, offset: -dot3(n, cursor) };
}

/**
 * Orthographic view-projection for a 2D slice pane.
 *
 * The plane is centred on the cursor's projection and panned by `camera.center`; `mmPerPx` sets the
 * zoom. Depth runs `-halfDepth .. +halfDepth` along the normal so a `showIn3D` plane and a 2D pane
 * use the same sign convention.
 */
export function sliceViewProj(
  view: SliceView,
  cursor: vec3,
  widthPx: number,
  heightPx: number,
  radiological: boolean,
  halfDepth: number
): { viewProj: mat4; basis: SliceBasis } {
  const basis = sliceBasis(view, radiological);
  const { right, up, normal } = basis;
  // World -> plane coordinates, with the cursor at the origin.
  const m = new Float32Array([
    right[0],
    up[0],
    normal[0],
    0,
    right[1],
    up[1],
    normal[1],
    0,
    right[2],
    up[2],
    normal[2],
    0,
    0,
    0,
    0,
    1,
  ]);
  // Column-major: the triples above are the basis vectors as ROWS, so this is world -> view rotation.
  const t = identity4();
  glMat4.fromTranslation(asGl(t), [-cursor[0], -cursor[1], -cursor[2]]);
  const viewM = identity4();
  glMat4.multiply(asGl(viewM), asGl(m), asGl(t));

  const halfW = (widthPx * view.camera.mmPerPx) / 2;
  const halfH = (heightPx * view.camera.mmPerPx) / 2;
  const cx = view.camera.center[0];
  const cy = view.camera.center[1];
  const proj = identity4();
  // GL looks down -Z, and the basis puts the slice normal on +Z, so near/far are mirrored.
  glMat4.ortho(asGl(proj), cx - halfW, cx + halfW, cy - halfH, cy + halfH, -halfDepth, halfDepth);
  const viewProj = identity4();
  glMat4.multiply(asGl(viewProj), asGl(proj), asGl(viewM));
  return { viewProj, basis };
}

/** The anatomical letter for a world direction, world space being scanner RAS mm (§3). */
export function letterFor(d: vec3): 'R' | 'L' | 'A' | 'P' | 'S' | 'I' {
  const ax =
    Math.abs(d[0]) >= Math.abs(d[1]) && Math.abs(d[0]) >= Math.abs(d[2])
      ? 0
      : Math.abs(d[1]) >= Math.abs(d[2])
        ? 1
        : 2;
  const positive = (d[ax] ?? 0) >= 0;
  if (ax === 0) return positive ? 'R' : 'L';
  if (ax === 1) return positive ? 'A' : 'P';
  return positive ? 'S' : 'I';
}

/**
 * The four edge letters of a 2D pane, **derived from the basis** — never hardcoded per pane (§8).
 * This is a laterality-safety requirement, so it is a pure function of the basis and is unit-tested
 * against every preset in both conventions.
 */
export function edgeLetters(basis: SliceBasis): {
  left: string;
  right: string;
  top: string;
  bottom: string;
} {
  const r = basis.right;
  const u = basis.up;
  return {
    right: letterFor(r),
    left: letterFor([-r[0], -r[1], -r[2]]),
    top: letterFor(u),
    bottom: letterFor([-u[0], -u[1], -u[2]]),
  };
}

// -------------------------------------------------------------------------------------------
// 3D camera
// -------------------------------------------------------------------------------------------

export interface Camera3DMatrices {
  view: mat4;
  proj: mat4;
  viewProj: mat4;
  /** World-space eye position, for the headlight. */
  eye: vec3;
}

export function camera3dMatrices(
  cam: Camera3D,
  widthPx: number,
  heightPx: number
): Camera3DMatrices {
  const rot = identity4();
  glMat4.fromQuat(asGl(rot), cam.rotation as unknown as quat);
  // The camera sits `distance` along the rotated +Z axis, looking at `target`.
  const back = gvec3.fromValues(rot[8] ?? 0, rot[9] ?? 0, rot[10] ?? 1);
  const eye = gvec3.create();
  gvec3.scaleAndAdd(eye, cam.target as unknown as gvec3, back, cam.distance);
  const up = gvec3.fromValues(rot[4] ?? 0, rot[5] ?? 1, rot[6] ?? 0);
  const view = identity4();
  glMat4.lookAt(asGl(view), eye, cam.target as unknown as gvec3, up);

  const aspect = heightPx > 0 ? widthPx / heightPx : 1;
  const proj = identity4();
  if (cam.orthographic) {
    // Match the perspective framing at the target plane, so toggling `o` does not jump the zoom.
    const halfH = Math.tan(((cam.fovYDeg * Math.PI) / 180) * 0.5) * cam.distance;
    glMat4.ortho(asGl(proj), -halfH * aspect, halfH * aspect, -halfH, halfH, cam.near, cam.far);
  } else {
    glMat4.perspective(asGl(proj), (cam.fovYDeg * Math.PI) / 180, aspect, cam.near, cam.far);
  }
  const viewProj = identity4();
  glMat4.multiply(asGl(viewProj), asGl(proj), asGl(view));
  return { view, proj, viewProj, eye: [eye[0], eye[1], eye[2]] };
}

/**
 * Fit a 3D camera to `bounds` (§7.2).
 *
 * `near = max(1 mm, fitRadius / 1000)`, `far = fitRadius * 8`. **Never a fixed sub-millimetre near
 * plane** — 0.01 mm breaks depth ordering even at 0.1 mm separation `[M2Max]`.
 */
export function fitCamera(cam: Camera3D, bounds: Aabb, fovYDeg = cam.fovYDeg): Camera3D {
  const center: vec3 = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
  const radius =
    Math.max(
      1,
      0.5 *
        Math.hypot(
          bounds.max[0] - bounds.min[0],
          bounds.max[1] - bounds.min[1],
          bounds.max[2] - bounds.min[2]
        )
    ) || 1;
  const distance = radius / Math.max(1e-3, Math.sin(((fovYDeg * Math.PI) / 180) * 0.5));
  return {
    ...cam,
    target: center,
    distance,
    fovYDeg,
    near: Math.max(1, radius / 1000),
    far: radius * 8,
  };
}

/** The `1..6` preset rotations (§7.5) — anterior, posterior, left, right, superior, inferior. */
export function presetRotation(index: number): [number, number, number, number] {
  const q = quat.create();
  switch (index) {
    case 1: // A — camera in front, looking back along -Y
      quat.rotateX(q, quat.create(), -Math.PI / 2);
      break;
    case 2: // P
      quat.rotateX(q, quat.create(), Math.PI / 2);
      quat.rotateY(q, q, Math.PI);
      break;
    case 3: // L — camera on -X
      quat.rotateY(q, quat.create(), -Math.PI / 2);
      quat.rotateX(q, q, -Math.PI / 2);
      break;
    case 4: // R — camera on +X
      quat.rotateY(q, quat.create(), Math.PI / 2);
      quat.rotateX(q, q, -Math.PI / 2);
      break;
    case 5: // S — camera above, +Z toward viewer (identity)
      quat.identity(q);
      break;
    case 6: // I
      quat.rotateX(q, quat.create(), Math.PI);
      break;
    default:
      quat.identity(q);
  }
  return [q[0], q[1], q[2], q[3]];
}

/**
 * §7.5's slice step, defined once so it needs no rewrite for oblique:
 * `step_mm = max over voxel axes a of |dot(normal, A[:,a])|`, where `A` is the 3×3 of the topmost
 * visible volume layer's affine. Falls back to `min(spacing)` of any volume, else
 * `bboxDiagonal / 256` for mesh-only scenes.
 */
export function stepMm(
  normal: vec3,
  affine: Float32Array | null,
  spacing: vec3 | null,
  bounds: Aabb | null
): number {
  if (affine !== null) {
    let best = 0;
    for (let a = 0; a < 3; a += 1) {
      // Column-major `mat4`: column `a` occupies slots `4a .. 4a+2`.
      const col: vec3 = [affine[a * 4] ?? 0, affine[a * 4 + 1] ?? 0, affine[a * 4 + 2] ?? 0];
      best = Math.max(best, Math.abs(dot3(normal, col)));
    }
    if (best > 1e-6) return best;
  }
  if (spacing !== null) {
    const m = Math.min(spacing[0], spacing[1], spacing[2]);
    if (m > 1e-6) return m;
  }
  if (bounds !== null) {
    const diag = Math.hypot(
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2]
    );
    if (diag > 1e-6) return diag / 256;
  }
  return 1;
}
