/**
 * Colour bars — **Phase 2**, and required in every screenshot from then on (§8, §11).
 *
 * Empty but typed, so the shape is settled before two agents need it: §8 asks for "one per visible
 * scalar layer — colormap, numeric ticks at the scale endpoints and at `mid` for heat, the threshold
 * cut drawn as a notch, the field name, and units from `Field.units`", plus per-layer `showColorbar`
 * and a right/bottom position.
 *
 * The seam this file exists to define: **a colour bar is one renderer with two producers.** A volume
 * layer builds a {@link ColorbarSpec} from its `Scale` / `Threshold` / colormap, a mesh field layer
 * builds one from its `Field`, and both hand it here. Neither producer draws, so neither owns the
 * drawing, and the two Phase-2 agents that need bars do not edit the same function.
 */

import type { OverlayBuilder, OverlayMetrics } from './builder';
import type { vec4 } from '../scene/types';

export interface ColorbarTick {
  /** 0..1 along the bar. */
  t: number;
  label: string;
}

export interface ColorbarSpec {
  /** Which layer this bar belongs to, so the pass can order bars the way the layers are ordered. */
  layerId: string;
  /** Field or layer name, drawn beside the bar. */
  title: string;
  /** From `Field.units` — NIfTI `xyz_units` / `intent_name`, or the Gmsh view name. */
  units?: string;
  /** The baked 256×1 (or 512×1, when `negative === 'separate'`) RGBA8 ramp. */
  ramp: Uint8Array;
  /** Endpoints, and `mid` for `kind: 'heat'`. */
  ticks: ColorbarTick[];
  /** Where `Threshold.lo` / `.hi` fall along the bar, drawn as a notch. */
  notches: number[];
  position: 'right' | 'bottom';
}

/**
 * Append one colour bar's geometry. **Phase 2 fills this in** (owner: E-SLICE, per
 * `docs/PHASE2-OWNERSHIP.md`); it is a no-op today so that `Annotations.colorbars` can already be
 * `false` in the scene defaults without a second code path.
 */
export function drawColorbar(
  _b: OverlayBuilder,
  _m: OverlayMetrics,
  _spec: ColorbarSpec,
  _textColor: vec4
): void {
  // PHASE 2: the ramp as a quad strip sampling `spec.ramp`, ticks with `labelWithHalo`, notches as
  // 1 px rects. Nothing is drawn until then — `Scene.annotations.colorbars` defaults to false.
}
