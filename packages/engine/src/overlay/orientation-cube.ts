/**
 * The **orientation cube** — §7.2's pass-3 corner item for a 3D pane (directed task 10, 2026-08-28).
 *
 * §8 calls the 2D chrome "a laterality-safety requirement, not decoration", and the 3D pane has the
 * same problem with none of the same answers: its four edge letters tell you which way is up *at the
 * edges*, but nothing tells you which way the head is facing once the camera has been orbited off a
 * preset. The cube is that: six faces labelled `A / P / L / R / S / I`, drawn with the **camera's own
 * rotation** so it turns exactly as the anatomy turns, and clickable — a face is the preset that
 * looks at it.
 *
 * Three properties this module is built around:
 *
 * * **Its own tiny projection.** The cube must be the same size at every dolly and must not be
 *   clipped by the scene's near plane, so it is *not* drawn through the pane's view-projection like
 *   the gizmo is. It is an orthographic projection of a unit cube onto a fixed box in the pane's
 *   corner, and the only thing it takes from the camera is the **rotation**.
 * * **One projection for the picture and for the hit test.** {@link cubeFaces} produces both, exactly
 *   as `overlay/gizmo.ts`'s `handlePoints` does — a face you can see and a face you can click have to
 *   be the same four corners, or the cube is a picture of a control rather than a control.
 * * **Theme-aware without new tokens.** A face is `halo` mixed toward `text` by its shading term and
 *   the letters are `text` itself, so the cube inverts with the theme for the same reason the halo
 *   does: `text` over `halo` is the one pair §7.2 already guarantees is legible in both, and mixing
 *   between them keeps the letter the brightest thing on the cube in a dark theme and the darkest in
 *   a light one.
 *
 * World RAS (§3) is what fixes the labelling: `+x` right, `+y` anterior, `+z` superior. A face's
 * letter *is* its outward normal's anatomical name, so the cube cannot disagree with the edge letters
 * — both are derived, neither is a table of per-view strings.
 */

import type { OverlayBuilder, OverlayMetrics } from './builder';
import { GLYPH_H } from '../render/font';
import type { quat, vec3, vec4 } from '../scene/types';

/** The six anatomical directions, spelled as the letters drawn on the faces. */
export type CubeFace = 'A' | 'P' | 'L' | 'R' | 'S' | 'I';

/** Side of the cube's box in **unscaled** overlay pixels; multiplied by `OverlayMetrics.scale`. */
export const CUBE_PX = 56;

/**
 * Face letter per outward normal, in world RAS (§3).
 *
 * The order is the `1..6` preset order (`view/geometry.ts`'s `presetRotation`), so the cube and the
 * keyboard presets are the same six views in the same six directions.
 */
export const CUBE_FACES: readonly { face: CubeFace; normal: vec3 }[] = [
  { face: 'A', normal: [0, 1, 0] },
  { face: 'P', normal: [0, -1, 0] },
  { face: 'L', normal: [-1, 0, 0] },
  { face: 'R', normal: [1, 0, 0] },
  { face: 'S', normal: [0, 0, 1] },
  { face: 'I', normal: [0, 0, -1] },
];

/** Where the cube's box sits in the pane: **bottom-right**, in pane pixels, bottom-left origin. */
export interface CubeLayout {
  /** Centre of the box. */
  cx: number;
  cy: number;
  /** Half the box's side. */
  half: number;
  /**
   * Pixels per unit of the cube's half-extent.
   *
   * `half / √3`, because the furthest corner of a cube with half-extent 1 is `√3` from its centre:
   * at that scale **no rotation can push a corner outside the box**, so the cube never grows into
   * the corner info or the badge as the camera turns.
   */
  k: number;
}

/**
 * The box, bottom-right, one `pad` off both edges.
 *
 * Bottom-right is the corner nothing else claims: §8 puts the corner info bottom-left, the RAD/NEU
 * badge top-right, the colour bars down the right edge from under the badge, and the orientation
 * letters at the four edge *midpoints*. The 2D scale bar takes this corner too, and the two never
 * share a pane — a cube is a 3D item and a scale bar is a 2D one.
 */
export function cubeLayout(m: OverlayMetrics): CubeLayout {
  // Never larger than a third of the smaller pane dimension: a 96 mm pane in a 2×2 layout must not
  // be half cube.
  const side = Math.min(CUBE_PX * m.scale, Math.floor(Math.min(m.widthPx, m.heightPx) / 3));
  const half = Math.max(1, side / 2);
  return {
    cx: m.widthPx - m.pad - half,
    cy: m.pad + half,
    half,
    k: half / Math.sqrt(3),
  };
}

/** The camera's world-space axes, straight out of its rotation quaternion (`gl-matrix` order). */
export interface CameraBasis {
  right: vec3;
  up: vec3;
  /** The axis pointing **from the target toward the eye** — `camera3dMatrices`' `back`. */
  back: vec3;
}

/**
 * `Camera3D.rotation` → the three world axes of the camera.
 *
 * The same three columns `view/geometry.ts` reads out of `mat4.fromQuat` to place the eye, written
 * out here rather than imported so this module stays pure arithmetic on a quaternion and §11 can
 * check it against a hand-computed rotation.
 */
export function cameraBasis(q: quat): CameraBasis {
  const [x, y, z, w] = q;
  return {
    right: [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)],
    up: [2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)],
    back: [2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)],
  };
}

function dot3(a: vec3, b: vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** One visible face: its projected quad, its centre, and how squarely it faces the viewer. */
export interface CubeFaceQuad {
  face: CubeFace;
  /** Corners in pane pixels, bottom-left origin, in winding order. */
  corners: [number, number][];
  /** Centre of the face in pane pixels. */
  center: [number, number];
  /** `dot(normal, back)` — 1 when the face is square to the camera, 0 when it is edge-on. */
  facing: number;
}

/**
 * Every **front-facing** face of the cube, back-to-front.
 *
 * Back-to-front because §7.2's pass 3 has no depth test: painting them in this order is what makes
 * the nearest face the one you see, and — with the hit test walking the same list in reverse — the
 * one you click.
 *
 * A face is front-facing when its outward normal has a positive component along the camera's `back`
 * axis. The `1e-4` is not a tolerance but a rule: at exactly 0 the face is edge-on, projects to a
 * zero-area sliver, and drawing it would put a one-pixel line of a face nobody can see across the
 * cube's silhouette.
 */
export function cubeFaces(layout: CubeLayout, rotation: quat): CubeFaceQuad[] {
  const basis = cameraBasis(rotation);
  const project = (p: vec3): [number, number] => [
    layout.cx + dot3(p, basis.right) * layout.k,
    layout.cy + dot3(p, basis.up) * layout.k,
  ];
  const out: CubeFaceQuad[] = [];
  for (const { face, normal } of CUBE_FACES) {
    const facing = dot3(normal, basis.back);
    if (facing <= 1e-4) continue;
    // The two axes the face spans, and an ordering that keeps the quad convex in projection.
    const axis = normal[0] !== 0 ? 0 : normal[1] !== 0 ? 1 : 2;
    const u: vec3 = axis === 0 ? [0, 1, 0] : [1, 0, 0];
    const v: vec3 = axis === 2 ? [0, 1, 0] : [0, 0, 1];
    const corner = (su: number, sv: number): [number, number] =>
      project([
        normal[0] + su * u[0] + sv * v[0],
        normal[1] + su * u[1] + sv * v[1],
        normal[2] + su * u[2] + sv * v[2],
      ]);
    out.push({
      face,
      corners: [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)],
      center: project(normal),
      facing,
    });
  }
  out.sort((a, b) => a.facing - b.facing);
  return out;
}

/** True when `(x, y)` is inside the convex quad, by the sign of the four edge cross products. */
function insideQuad(corners: [number, number][], x: number, y: number): boolean {
  let positive = 0;
  let negative = 0;
  for (let i = 0; i < corners.length; i += 1) {
    const a = corners[i]!;
    const b = corners[(i + 1) % corners.length]!;
    const cross = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    if (cross > 0) positive += 1;
    else if (cross < 0) negative += 1;
  }
  return positive === 0 || negative === 0;
}

/**
 * Which face a pane pixel is over — the click target, in the same pane pixels the drawing uses
 * (bottom-left origin).
 *
 * Walks {@link cubeFaces} from the front backwards, so a pixel where two faces overlap in projection
 * belongs to the one that is drawn on top. `null` outside the cube's silhouette, which is what lets
 * the pointer layer fall through to an orbit.
 */
export function cubeFaceAt(
  layout: CubeLayout,
  rotation: quat,
  x: number,
  y: number
): CubeFace | null {
  const faces = cubeFaces(layout, rotation);
  for (let i = faces.length - 1; i >= 0; i -= 1) {
    const f = faces[i]!;
    if (insideQuad(f.corners, x, y)) return f.face;
  }
  return null;
}

/** The cube's two colours — the theme's `text` and `halo`, and nothing else (§7.2). */
export interface CubeColors {
  /** Letters and edges, and the tone every face is mixed **toward**. */
  text: vec4;
  /** The tone every face is mixed **from** — the theme's background side. */
  halo: vec4;
}

/** The faces' shading range, as a fraction of the way from `halo` to `text`. */
export const CUBE_SHADE_MIN = 0.18;
export const CUBE_SHADE_MAX = 0.48;
/** Edges are brighter than any face, so the silhouette and the seams read at every orientation. */
export const CUBE_EDGE_SHADE = 0.7;

/** `halo → text` at `t`, keeping `text`'s alpha: the one mix this file does. */
function shadeOf(c: CubeColors, t: number): vec4 {
  return [
    c.halo[0] + (c.text[0] - c.halo[0]) * t,
    c.halo[1] + (c.text[1] - c.halo[1]) * t,
    c.halo[2] + (c.text[2] - c.halo[2]) * t,
    c.text[3],
  ];
}

/**
 * Append the cube.
 *
 * The shading is `facing` itself — the cosine between the face normal and the view direction — mapped
 * into {@link CUBE_SHADE_MIN}…{@link CUBE_SHADE_MAX} of the way from `halo` to `text`. That is a real
 * Lambert term on a real normal rather than a per-face constant, so the three visible faces separate
 * at every orientation instead of only at the cardinal ones, and it costs one multiply.
 *
 * The ceiling is deliberate and is what keeps the **letter** the brightest thing on the cube: §11
 * decodes the letters off the framebuffer with the same template matcher §8's chrome uses, and a face
 * as bright as its own label decodes as a filled cell rather than as an `A`.
 */
export function drawOrientationCube(
  b: OverlayBuilder,
  m: OverlayMetrics,
  rotation: quat,
  colors: CubeColors
): void {
  const layout = cubeLayout(m);
  const faces = cubeFaces(layout, rotation);
  const letterScale = Math.max(1, Math.round(layout.half / 12));
  const edge = Math.max(1, m.scale);

  const edgeColor = shadeOf(colors, CUBE_EDGE_SHADE);
  for (const f of faces) {
    const t =
      CUBE_SHADE_MIN + (CUBE_SHADE_MAX - CUBE_SHADE_MIN) * Math.min(1, Math.max(0, f.facing));
    b.quad(f.corners[0]!, f.corners[1]!, f.corners[2]!, f.corners[3]!, shadeOf(colors, t));
    // The silhouette and the interior seams, so three faces of one tone still read as a cube.
    for (let i = 0; i < 4; i += 1) {
      strokeSegment(b, f.corners[i]!, f.corners[(i + 1) % 4]!, edge, edgeColor);
    }
    // Only the face square enough to read gets its letter: a 15°-from-edge-on face is four pixels
    // tall in projection and a glyph on it is a smudge, not a label.
    if (f.facing > 0.25) {
      b.text(
        f.face,
        f.center[0],
        f.center[1] - (GLYPH_H * letterScale) / 2,
        letterScale,
        colors.text,
        'center'
      );
    }
  }
}

/** A screen-space thick line, the §7.0.6 way — `gl.lineWidth()` is a no-op `[M2Max]`. */
function strokeSegment(
  b: OverlayBuilder,
  a: [number, number],
  c: [number, number],
  width: number,
  color: vec4
): void {
  const dx = c[0] - a[0];
  const dy = c[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  const nx = (-dy / len) * (width / 2);
  const ny = (dx / len) * (width / 2);
  b.quad(
    [a[0] + nx, a[1] + ny],
    [c[0] + nx, c[1] + ny],
    [c[0] - nx, c[1] - ny],
    [a[0] - nx, a[1] - ny],
    color
  );
}
