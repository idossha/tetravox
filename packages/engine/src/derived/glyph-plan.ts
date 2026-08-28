/**
 * What one `GlyphSpec` draw *is*, decided once and read by two consumers.
 *
 * `render/passes/derived.ts` turns this into uniforms and a draw call;
 * `derived/glyph-readback.ts` turns the same object into the list of instances the §11 real-data
 * test compares against numpy. They share this function so a test cannot pass by asserting a
 * different plan than the one the renderer executes — the failure mode a hand-rolled second copy
 * of the stride arithmetic would have had.
 */

import { glyphScaling, referenceMagnitude } from './glyph-scale';
import type { GlyphScaling, GlyphSpec, MeshDataset, MeshLayer, vec4 } from '../scene/types';

export interface GlyphPlan {
  /** `origins: 'volume'` — one origin per tet, from `meshCentroids`. */
  volume: boolean;
  /** Every `stride`-th member of the chosen population (`subsample`, either spelling). */
  stride: number;
  scaling: GlyphScaling;
  /** The magnitude that maps to `scaling.lengthMm`. */
  refMag: number;
  /** `onCutPlaneOnly`: `(normal.xyz, offset)` in world mm, and the half-thickness. `half <= 0` = off. */
  slab: { plane: vec4; half: number };
}

export function glyphPlan(
  layer: MeshLayer,
  ds: MeshDataset,
  spec: GlyphSpec,
  surfaceTriangles: number
): GlyphPlan {
  const volume = spec.origins === 'volume';
  // The stride's denominator is whatever the chosen source counts: surface triangles, or tets.
  const population = volume ? ds.nTets : surfaceTriangles;
  const stride =
    'everyNth' in spec.subsample
      ? Math.max(1, Math.round(spec.subsample.everyNth))
      : Math.max(1, Math.ceil(population / Math.max(1, spec.subsample.maxCount)));
  const scaling = glyphScaling(spec);
  const info = ds.fields.find((f) => f.name === spec.field.name && f.source === spec.field.source);
  return {
    volume,
    stride,
    scaling,
    refMag: Math.max(1e-20, referenceMagnitude(scaling, info?.stats)),
    slab: glyphSlab(layer, spec),
  };
}

/**
 * §7.4's "when a cut plane is active and `clipToCutPlane`, elements the plane intersects", which the
 * renderer never implemented — the directed-task-7 verification found the flag inert.
 *
 * In a 3D pane the layer's **first enabled clip plane** is the only cut plane there is, so that is
 * what the slab is centred on. With no enabled plane the restriction has nothing to restrict to and
 * stays off, rather than silently blanking the layer.
 */
export function glyphSlab(layer: MeshLayer, spec: GlyphSpec): { plane: vec4; half: number } {
  const off: { plane: vec4; half: number } = { plane: [0, 0, 1, 0], half: 0 };
  if (spec.onCutPlaneOnly !== true && spec.clipToCutPlane !== true) return off;
  const p = layer.clip.planes.find((c) => c.enabled);
  if (p === undefined) return off;
  const n = p.plane.normal;
  return { plane: [n[0], n[1], n[2], p.plane.offset], half: Math.max(1e-6, spec.cutSlabMm ?? 1) };
}
