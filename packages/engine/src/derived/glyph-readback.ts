/**
 * **Test-only**: the glyph instances a frame would draw, as numbers.
 *
 * §11's rule 0 — "an agent cannot judge a PNG; it can judge a number" — has a hole where glyphs are
 * concerned. Everything that decides where an arrow starts, which way it points and how long it is
 * happens in the vertex shader, out of one origin table and three field tables, so the only evidence
 * a golden PNG offers is that *some* arrows appeared. The verification directed task 7 asks for —
 * origin within 0.01 mm of the element centroid, direction within 1° of `E`, length equal to the
 * scaling model's — needs the instances themselves.
 *
 * This produces them from the **same arrays the tables were uploaded from** (`DerivedStore`'s
 * retained sources) and the **same plan the pass executes** (`derived/glyph-plan.ts`), so what it
 * reports is the draw's own inputs and indexing, not a re-derivation of them. What it does not cover
 * is the shader arithmetic downstream of those inputs; that is the `glyph-length` pixel test's job,
 * which measures a drawn arrow in pane pixels against {@link glyphLengthMm}.
 *
 * Nothing in the engine calls this outside `Engine.glyphInstances`, and that is gated on
 * `DerivedStore.retainGlyphSources`, which the app never turns on.
 */

import { glyphPlan } from './glyph-plan';
import { glyphLengthMm } from './glyph-scale';
import { visibleTetTags } from './tag-lut';
import { DerivedStore } from './store';
import type { GlyphSources } from './store';
import type { MeshDataset, MeshLayer, vec3 } from '../scene/types';

export interface GlyphInstance {
  /** Gmsh element number the field row was read from. */
  element: number;
  /** Origin in dataset (model) space, millimetres. */
  origin: vec3;
  /** The field vector at `element`, unnormalised. */
  vector: vec3;
  magnitude: number;
  /** Arrow length in millimetres — 0 means the instance is dropped (`vAlpha = 0`). */
  lengthMm: number;
}

/**
 * `null` when the sources are not retained or an op has not landed yet — never a partial answer,
 * because a test that silently compared 0 instances would pass.
 */
export function readGlyphInstances(
  store: DerivedStore,
  layer: MeshLayer,
  ds: MeshDataset
): GlyphInstance[] | null {
  const spec = layer.glyphs;
  if (spec === undefined) return null;
  const surface = store.surfaceTables(ds);
  const plan = glyphPlan(layer, ds, spec, surface?.triangleCount ?? 0);

  const fields: Float32Array[] = [];
  for (const c of [0, 1, 2] as const) {
    const f = store.glyphSources(DerivedStore.fieldKey(ds, spec.field.source, spec.field.name, c));
    if (f === null || !(f instanceof Float32Array)) return null;
    fields.push(f);
  }
  const [fx, fy, fz] = fields as [Float32Array, Float32Array, Float32Array];

  let origins: GlyphSources;
  let count: number;
  let stride: number;
  if (plan.volume) {
    const tags = visibleTetTags(layer, ds);
    if (tags.length === 0) return [];
    const src = store.glyphSources(DerivedStore.centroidKey(ds, plan.stride, tags));
    if (src === null || src instanceof Float32Array) return null;
    origins = src;
    count = src.owner.length;
    // The op already strided and already filtered by tag: row `g` is instance `g`.
    stride = 1;
  } else {
    const src = store.glyphSources(`surface|${ds.id}`);
    if (src === null || src instanceof Float32Array || surface === null) return null;
    origins = src;
    stride = plan.stride;
    count = Math.max(0, Math.floor((surface.triangleCount - 1) / stride) + 1);
  }

  const hidden = (tag: number): boolean => (layer.tagStyle[tag]?.visible ?? true) === false;
  const out: GlyphInstance[] = [];
  for (let g = 0; g < count; g += 1) {
    let origin: vec3;
    let element: number;
    if (plan.volume) {
      const p = g * 3;
      origin = [
        origins.positions[p] ?? 0,
        origins.positions[p + 1] ?? 0,
        origins.positions[p + 2] ?? 0,
      ];
      element = origins.owner[g] ?? 0;
    } else {
      const tri = g * stride;
      if (hidden(origins.faceTag?.[tri] ?? 0)) continue;
      const v = tri * 9;
      origin = [0, 0, 0];
      for (let k = 0; k < 3; k += 1) {
        origin[0] += (origins.positions[v + k * 3] ?? 0) / 3;
        origin[1] += (origins.positions[v + k * 3 + 1] ?? 0) / 3;
        origin[2] += (origins.positions[v + k * 3 + 2] ?? 0) / 3;
      }
      element = origins.owner[tri] ?? 0;
    }
    // §6.5.2 licenses `row = element - 1` only when `MeshMeta.identityElementNumbers` holds; the
    // shader does the same subtraction, so a mesh where it does not hold is broken in both.
    const fi = Math.max(0, element - 1);
    const vector: vec3 = [fx[fi] ?? 0, fy[fi] ?? 0, fz[fi] ?? 0];
    const magnitude = Math.hypot(vector[0], vector[1], vector[2]);
    if (plan.slab.half > 0) {
      // The shader tests the **world** origin (`uModel * origin`); so does this, or a dataset with a
      // non-identity transform would keep a different set of arrows here than on screen.
      const w = apply(ds.transform, origin);
      const d =
        plan.slab.plane[0] * w[0] +
        plan.slab.plane[1] * w[1] +
        plan.slab.plane[2] * w[2] +
        plan.slab.plane[3];
      if (Math.abs(d) > plan.slab.half) continue;
    }
    const lengthMm = magnitude > 0 ? glyphLengthMm(plan.scaling, magnitude, plan.refMag) : 0;
    if (lengthMm <= 0) continue;
    out.push({ element, origin, vector, magnitude, lengthMm });
  }
  return out;
}

/** Column-major mat4 times a point. */
function apply(m: Float32Array, p: vec3): vec3 {
  return [
    (m[0] ?? 1) * p[0] + (m[4] ?? 0) * p[1] + (m[8] ?? 0) * p[2] + (m[12] ?? 0),
    (m[1] ?? 0) * p[0] + (m[5] ?? 1) * p[1] + (m[9] ?? 0) * p[2] + (m[13] ?? 0),
    (m[2] ?? 0) * p[0] + (m[6] ?? 0) * p[1] + (m[10] ?? 1) * p[2] + (m[14] ?? 0),
  ];
}
