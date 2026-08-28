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
import type {
  Aabb,
  Camera3D,
  Plane,
  SliceMode,
  SliceView,
  vec3,
  VolumeDataset,
} from '../scene/types';

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

/**
 * §3's canonical preset normals: axial `+Z`, coronal `−Y`, sagittal `−X`.
 *
 * A plane and its opposite normal are the **same plane** — the sign chooses only which side the
 * camera sits on — and §3 fixes those signs so that all three presets obey the handedness rule
 * rather than contradicting it. With coronal `+Y`, `right = cross(up, normal)` is `−X`: the
 * subject's left lands on screen **right** while the axial pane puts it on screen left, i.e. one
 * `NEU` badge over two opposite conventions. `−Y` gives `right = +X`, and `−X` gives `right = −Y`,
 * which is what makes §11's three orientation tests — a bright left-anterior-superior cube on
 * screen-**left** in neurological, in *each* of the three views — simultaneously true.
 */
export function presetNormal(mode: SliceMode): vec3 {
  switch (mode) {
    case 'axial':
      return [0, 0, 1];
    case 'coronal':
      return [0, -1, 0];
    case 'sagittal':
      return [-1, 0, 0];
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
 * Which **voxel** axis of `affine` a plane with this world normal steps along, and how far.
 *
 * `axis = argmax_a |dot(normal, A[:,a])|` over the 3×3 of a column-major `mat4`, and `mm` is that
 * maximum. One definition serves §7.5's slice step *and* §8's corner "slice index", which is the
 * point: **neither may assume a voxel axis per view mode.** Every `m2m_*` volume in the reference
 * dataset permutes them — `T1.nii.gz` maps `world x ← k`, `world y ← −i`, `world z ← j` `[DATA]`,
 * so its axial planes step along voxel `j` and its sagittal planes along voxel `k`.
 */
export function voxelAxisAlong(
  normal: vec3,
  affine: Float32Array
): { axis: 0 | 1 | 2; mm: number } {
  let axis: 0 | 1 | 2 = 2;
  let best = -1;
  for (let a = 0; a < 3; a += 1) {
    // Column-major `mat4`: column `a` occupies slots `4a .. 4a+2`.
    const col: vec3 = [affine[a * 4] ?? 0, affine[a * 4 + 1] ?? 0, affine[a * 4 + 2] ?? 0];
    const d = Math.abs(dot3(normal, col));
    if (d > best) {
      best = d;
      axis = a as 0 | 1 | 2;
    }
  }
  return { axis, mm: best };
}

/**
 * The slice step of a scene with **no volume in it** — R4's "else 1 mm (configurable)".
 *
 * A mesh-only scene has no voxel grid to step through, and R4 requires the wheel, PgUp/PgDn and the
 * arrows to sweep the mesh anyway.
 */
export const MESH_ONLY_STEP_MM = 1;

/**
 * §7.5's slice step, defined once so it needs no rewrite for oblique:
 * `step_mm = max over voxel axes a of |dot(normal, A[:,a])|`, where `A` is the 3×3 of the topmost
 * visible volume layer's affine. Falls back to `min(spacing)` of any volume, else
 * {@link MESH_ONLY_STEP_MM} for mesh-only scenes.
 *
 * **The mesh-only fallback is 1 mm, not §7.5's `bboxDiagonal / 256`** (maintainer requirement R4,
 * 2026-08-27). The diagonal rule made one wheel notch mean a different distance per file — 1.32 mm
 * on `ernie.msh`, 0.53 mm on `lh.central.gii` — for a gesture whose whole job is to sweep a mesh at
 * a predictable rate. `meshOnlyMm` is the "(configurable)" R4 asks for.
 */
export function stepMm(
  normal: vec3,
  affine: Float32Array | null,
  spacing: vec3 | null,
  bounds: Aabb | null,
  meshOnlyMm: number = MESH_ONLY_STEP_MM
): number {
  if (affine !== null) {
    const best = voxelAxisAlong(normal, affine).mm;
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
    if (diag > 1e-6) return meshOnlyMm;
  }
  return meshOnlyMm;
}

/**
 * World mm → voxel index, through a volume's `inverseAffine`.
 *
 * Scene maths, not rendering: the probe path (`layers/volume.ts`), the slice-step snap (`engine.ts`)
 * and the corner slice index (`render/passes/overlay.ts`) all need it, and it used to live in
 * `render/renderer.ts` with two of those three importing it out of a rendering module.
 */
export function worldToVoxel(ds: VolumeDataset, w: vec3): vec3 {
  const m = ds.inverseAffine;
  return [
    (m[0] ?? 0) * w[0] + (m[4] ?? 0) * w[1] + (m[8] ?? 0) * w[2] + (m[12] ?? 0),
    (m[1] ?? 0) * w[0] + (m[5] ?? 0) * w[1] + (m[9] ?? 0) * w[2] + (m[13] ?? 0),
    (m[2] ?? 0) * w[0] + (m[6] ?? 0) * w[1] + (m[10] ?? 0) * w[2] + (m[14] ?? 0),
  ];
}

/**
 * Slide `world` along `dir` until the voxel index that direction steps along is an **integer**.
 *
 * §7.5's anti-drift rule — "snap the cursor's along-normal component to the nearest voxel plane" —
 * read literally, and shared by both keyboard steps: `stepCursor` snaps along the plane normal
 * (PgUp/PgDn and the wheel), `nudgeCursor` along the pane's `right` and `up` (the arrows, P2-09).
 *
 * "Along `dir`" is the whole point. Rounding all three voxel indices instead — which Phase 1 did —
 * also drags the cursor sideways to the nearest voxel *centre*, so one step moves it in a direction
 * the user did not ask for. Solving for the distance along `dir` that puts the stepping index
 * (`voxelAxisAlong`, the same derivation §8's corner readout uses) on an integer cannot touch the
 * other two axes, and is correct for an oblique plane as well as a canonical one.
 *
 * The rate is non-zero by construction: `axis` is the argmax of exactly this projection.
 */
export function snapAlong(ds: VolumeDataset, world: vec3, dir: vec3): vec3 {
  const { axis } = voxelAxisAlong(dir, ds.affine);
  const v = worldToVoxel(ds, world);
  const m = ds.inverseAffine;
  const rate = (m[axis] ?? 0) * dir[0] + (m[4 + axis] ?? 0) * dir[1] + (m[8 + axis] ?? 0) * dir[2];
  if (!(Math.abs(rate) > 1e-9)) return world;
  const t = (Math.round(v[axis] ?? 0) - (v[axis] ?? 0)) / rate;
  return [world[0] + dir[0] * t, world[1] + dir[1] * t, world[2] + dir[2] * t];
}

// -------------------------------------------------------------------------------------------
// Oblique affordances — §7.5's gizmo, rotate handles and plane-from-3-points
// -------------------------------------------------------------------------------------------

/**
 * The plane through three world points, as a `{ normal, up }` a `SliceView` can adopt.
 *
 * §7.5's third oblique affordance. `normal = normalize((b − a) × (c − a))`, and `up` is the
 * in-plane direction closest to the world superior axis — with the world **anterior** axis as the
 * fallback for a plane that is itself axial, where "superior" has no in-plane component at all. That
 * rule is what keeps the resulting pane readable rather than rolled to an arbitrary angle: the same
 * choice §3's presets make (`presetUp` is `+Z` for coronal and sagittal, `+Y` for axial).
 *
 * Returns `null` for three collinear (or coincident) points, where no plane exists — a clicked
 * third point on the line through the first two must fail visibly, not produce a NaN normal.
 */
export function planeFromPoints(
  a: vec3,
  b: vec3,
  c: vec3,
  minArea = 1e-6
): { normal: vec3; up: vec3 } | null {
  const ab: vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac: vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = cross(ab, ac);
  // |ab × ac| is twice the triangle's area: zero exactly when the three points are collinear.
  if (Math.hypot(n[0], n[1], n[2]) <= minArea) return null;
  const normal = norm(n);
  const superior: vec3 = [0, 0, 1];
  let up = reject(superior, normal);
  if (Math.hypot(up[0], up[1], up[2]) < 1e-4) up = reject([0, 1, 0], normal);
  return { normal, up: norm(up) };
}

/** `v` with its component along the unit vector `n` removed. */
function reject(v: vec3, n: vec3): vec3 {
  const d = dot3(v, n);
  return [v[0] - d * n[0], v[1] - d * n[1], v[2] - d * n[2]];
}

/**
 * Rotate a plane's `{ normal, up }` by `angle` radians about an **in-plane** axis.
 *
 * The gizmo's two rotate handles, and the only correct way to write them: rotating the normal alone
 * would leave `up` pointing out of the new plane, and `sliceBasis` would then re-orthogonalise it to
 * whatever fell out — the pane would roll by an amount nobody asked for. Rodrigues on both vectors
 * keeps the frame rigid, so a rotate handle rotates the view and does not also spin it.
 */
export function rotatePlane(
  normal: vec3,
  up: vec3,
  axis: vec3,
  angle: number
): { normal: vec3; up: vec3 } {
  const k = norm(axis);
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  const rodrigues = (v: vec3): vec3 => {
    const kv = cross(k, v);
    const kd = dot3(k, v) * (1 - cosA);
    return [
      v[0] * cosA + kv[0] * sinA + k[0] * kd,
      v[1] * cosA + kv[1] * sinA + k[1] * kd,
      v[2] * cosA + kv[2] * sinA + k[2] * kd,
    ];
  };
  const n = norm(rodrigues(normal));
  return { normal: n, up: norm(reject(rodrigues(up), n)) };
}

// -------------------------------------------------------------------------------------------
// The pane's in-plane origin — §7.5 / maintainer requirement R3
// -------------------------------------------------------------------------------------------

/**
 * The `mmPerPx` that fits `bounds` into a square pane of `px` pixels — §7.5's `r`, in one place.
 *
 * `0.62` of the bounding-box **diagonal** rather than of an axis: a slice plane can cut a volume at
 * any angle, so the widest thing a pane may have to show is the diagonal, and fitting to an axis
 * leaves an oblique cut clipped. The `0.05` floor is R2's clamp, applied here so a fit is never a
 * value the zoom would refuse.
 *
 * Shared by `resetView`, the auto-fit on the first dataset, and §8's corner `ZOOM` readout — three
 * places that each had (or would have grown) a copy, and where a disagreement means `r` produces a
 * pane the readout then calls 0.98x.
 */
export function fitMmPerPx(bounds: Aabb, px: number): number {
  const diag = Math.hypot(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2]
  );
  return Math.max(0.05, (diag * 0.62) / Math.max(1, px));
}

/**
 * The world point a 2D pane's in-plane coordinates are measured from.
 *
 * **This is the change R3 asks for**, and it is worth stating plainly because §4.5's inline comment
 * on `SliceView.camera.center` still reads "relative to the cursor's projection". It was, and that
 * is exactly the defect R3 names: with the cursor as the in-plane origin, moving the cursor moves
 * the *image* under a crosshair pinned to the pane — "move the scan, not the crosshair". Freeview
 * does the opposite, and so does every viewer a user of this one has used.
 *
 * So the in-plane origin is the **scene bounding-box centre**, which no interaction moves, and
 * `camera.center` is the pan offset from it. Consequences, all of them intended:
 *
 * * a left-drag moves the cursor and leaves every non-crosshair pixel byte-identical (R3's gate);
 * * `resetView` (`center = [0,0]`) frames the *data*, not wherever the cursor happens to be;
 * * the first dataset still opens exactly as it did, because `#onFirstDataset` puts the cursor on
 *   the bbox centre — anchor and cursor coincide there, so no Phase-1 golden moves.
 *
 * The **along-normal** component is still the cursor's, and the plane is still derived from the
 * cursor alone (§4.5) — only the in-plane origin changed.
 */
export function planeAnchor(bounds: Aabb): vec3 {
  return [
    ((bounds.min[0] ?? 0) + (bounds.max[0] ?? 0)) / 2,
    ((bounds.min[1] ?? 0) + (bounds.max[1] ?? 0)) / 2,
    ((bounds.min[2] ?? 0) + (bounds.max[2] ?? 0)) / 2,
  ];
}

/**
 * The view a pane is actually **rendered** with: `camera.center` re-expressed in the cursor-relative
 * frame that {@link sliceViewProj} (and the slice quad, and the crosshair) already speak.
 *
 * The alternative was to teach `sliceViewProj`, `SlicePass.quadHalfFor`, `SlicePass.#writeQuad` and
 * `OverlayPass`'s crosshair placement about the anchor — four call sites in three files, two of them
 * owned by other Phase-2 agents. Folding the anchor into one number instead leaves every one of them
 * literally unchanged and still correct:
 *
 * * `sliceViewProj` centres the ortho box on `center`, so the pane centres on `anchor + center`;
 * * `quadHalfFor`'s `paneHalf + |center|` is the distance from the quad's centre (the cursor) to the
 *   pane's far corner — which is what it was always meant to be, and only becomes true once
 *   `center` is measured from the cursor;
 * * `OverlayPass` draws the crosshair at `rect/2 − center/mmPerPx`, i.e. at the cursor, which is now
 *   a point that moves on screen instead of a fixed one.
 */
export function effectiveSliceView(
  view: SliceView,
  cursor: vec3,
  anchor: vec3,
  radiological: boolean
): SliceView {
  const { right, up } = sliceBasis(view, radiological);
  const d: vec3 = [anchor[0] - cursor[0], anchor[1] - cursor[1], anchor[2] - cursor[2]];
  return {
    ...view,
    camera: {
      ...view.camera,
      center: [view.camera.center[0] + dot3(d, right), view.camera.center[1] + dot3(d, up)],
    },
  };
}

/** A pane rectangle, in device pixels — `ViewportRect` without the import cycle. */
export interface PaneSize {
  width: number;
  height: number;
}

/**
 * Pane-local pixel (**top-left origin**, the convention `readPixel` and every pointer event use)
 * → the world point on that pane's slice plane.
 *
 * The sample point is the pixel *centre*, `p + 0.5`, which is the convention §11's orientation tests
 * already assert against ("pixel `p` samples `(p + 0.5 − PANE/2)·mmPerPx`"). Inverse of
 * {@link worldToPane} to floating-point exactness.
 */
export function paneToWorld(
  view: SliceView,
  cursor: vec3,
  anchor: vec3,
  radiological: boolean,
  rect: PaneSize,
  xLocal: number,
  yLocal: number
): vec3 {
  const basis = sliceBasis(view, radiological);
  const eff = effectiveSliceView(view, cursor, anchor, radiological);
  const mm = eff.camera.mmPerPx;
  const u = eff.camera.center[0] + (xLocal + 0.5 - rect.width / 2) * mm;
  const v = eff.camera.center[1] + (rect.height / 2 - yLocal - 0.5) * mm;
  return [
    cursor[0] + basis.right[0] * u + basis.up[0] * v,
    cursor[1] + basis.right[1] * u + basis.up[1] * v,
    cursor[2] + basis.right[2] * u + basis.up[2] * v,
  ];
}

/** World → pane-local pixel, **top-left origin**. Exact inverse of {@link paneToWorld}. */
export function worldToPane(
  view: SliceView,
  cursor: vec3,
  anchor: vec3,
  radiological: boolean,
  rect: PaneSize,
  world: vec3
): [number, number] {
  const basis = sliceBasis(view, radiological);
  const eff = effectiveSliceView(view, cursor, anchor, radiological);
  const mm = eff.camera.mmPerPx;
  const d: vec3 = [world[0] - cursor[0], world[1] - cursor[1], world[2] - cursor[2]];
  const u = dot3(d, basis.right);
  const v = dot3(d, basis.up);
  return [
    (u - eff.camera.center[0]) / mm + rect.width / 2 - 0.5,
    rect.height / 2 - (v - eff.camera.center[1]) / mm - 0.5,
  ];
}

/**
 * Project a world point into a 3D pane, **top-left origin**, or `null` when it is behind the eye.
 *
 * The 3D crosshair (R1: "the 3D crosshair moves") is the only caller today; it is here rather than
 * in the overlay pass because it is camera geometry and the pass owns no maths.
 */
export function worldToPane3D(
  viewProj: mat4,
  rect: PaneSize,
  world: vec3
): [number, number] | null {
  const m = viewProj;
  const x = (m[0] ?? 0) * world[0] + (m[4] ?? 0) * world[1] + (m[8] ?? 0) * world[2] + (m[12] ?? 0);
  const y = (m[1] ?? 0) * world[0] + (m[5] ?? 0) * world[1] + (m[9] ?? 0) * world[2] + (m[13] ?? 0);
  const w =
    (m[3] ?? 0) * world[0] + (m[7] ?? 0) * world[1] + (m[11] ?? 0) * world[2] + (m[15] ?? 1);
  if (!(Math.abs(w) > 1e-9) || w < 0) return null;
  return [((x / w) * 0.5 + 0.5) * rect.width - 0.5, (0.5 - (y / w) * 0.5) * rect.height - 0.5];
}
