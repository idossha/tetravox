/**
 * The shared arrow template §7.4's `GlyphSpec` draw is instanced from: "one instanced draw of a
 * shared **cone+shaft** VAO".
 *
 * A unit arrow along **+Z**, from 0 to 1, radius `SHAFT_R`, with the head occupying the last
 * `HEAD_LEN` of the length. `SIDES` sides, so the whole template is
 * `SIDES · 2` shaft triangles + `SIDES` cone triangles + `SIDES` head-base triangles.
 *
 * This is **not** dataset geometry, so building it here does not cross AGENTS rule 7: it is 24
 * triangles of constant, deterministic template, generated once per engine and never again, and the
 * per-glyph work is entirely the vertex shader's frame construction (`shaders/glyph.ts`). The rule
 * that "the engine never builds a vertex buffer element-by-element" is about the millions of
 * vertices a mesh has, which is exactly why §7.4 asks for one shared VAO rather than one arrow mesh
 * per element.
 */

export const SIDES = 8;
export const SHAFT_R = 0.06;
export const HEAD_R = 0.16;
export const HEAD_LEN = 0.3;

export interface ArrowTemplate {
  positions: Float32Array;
  normals: Float32Array;
  vertexCount: number;
}

/** `shape: 'line'` is the same template with no head — a plain shaft to the tip. */
export function buildArrow(withHead: boolean): ArrowTemplate {
  const pos: number[] = [];
  const nrm: number[] = [];
  const shaftTop = withHead ? 1 - HEAD_LEN : 1;
  const push = (p: [number, number, number], n: [number, number, number]): void => {
    pos.push(p[0], p[1], p[2]);
    nrm.push(n[0], n[1], n[2]);
  };
  for (let i = 0; i < SIDES; i += 1) {
    const a0 = (i / SIDES) * Math.PI * 2;
    const a1 = ((i + 1) / SIDES) * Math.PI * 2;
    const c0 = Math.cos(a0);
    const s0 = Math.sin(a0);
    const c1 = Math.cos(a1);
    const s1 = Math.sin(a1);

    // Shaft: two triangles per side, normals radial.
    const p00: [number, number, number] = [c0 * SHAFT_R, s0 * SHAFT_R, 0];
    const p01: [number, number, number] = [c1 * SHAFT_R, s1 * SHAFT_R, 0];
    const p10: [number, number, number] = [c0 * SHAFT_R, s0 * SHAFT_R, shaftTop];
    const p11: [number, number, number] = [c1 * SHAFT_R, s1 * SHAFT_R, shaftTop];
    const n0: [number, number, number] = [c0, s0, 0];
    const n1: [number, number, number] = [c1, s1, 0];
    push(p00, n0);
    push(p01, n1);
    push(p11, n1);
    push(p00, n0);
    push(p11, n1);
    push(p10, n0);

    if (!withHead) continue;

    // Head base, facing back down -Z.
    const b0: [number, number, number] = [c0 * HEAD_R, s0 * HEAD_R, shaftTop];
    const b1: [number, number, number] = [c1 * HEAD_R, s1 * HEAD_R, shaftTop];
    const down: [number, number, number] = [0, 0, -1];
    push([0, 0, shaftTop], down);
    push(b1, down);
    push(b0, down);

    // Cone. The side normal tilts by the head's slope, so the tip is not lit as a flat disc.
    const slope = HEAD_R / HEAD_LEN;
    const nc0: [number, number, number] = [c0, s0, slope];
    const nc1: [number, number, number] = [c1, s1, slope];
    push(b0, nc0);
    push(b1, nc1);
    push([0, 0, 1], [(c0 + c1) / 2, (s0 + s1) / 2, slope]);
  }
  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nrm),
    vertexCount: pos.length / 3,
  };
}
