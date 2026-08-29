/**
 * Colour bars — **required in every screenshot from Phase 2 on** (§8, §11).
 *
 * §8 asks for "one per visible scalar layer — colormap, numeric ticks at the scale endpoints and at
 * `mid` for heat, the threshold cut drawn as a notch, the field name, and units from `Field.units`",
 * plus per-layer `showColorbar` and a right/bottom position.
 *
 * The seam this file exists to define: **a colour bar is one renderer with two producers.** A volume
 * layer builds a {@link ColorbarSpec} from its `Scale` / `Threshold` / colormap
 * ({@link volumeColorbarSpec}); a mesh field layer builds one from its `Field`; and both hand it to
 * {@link drawColorbar}. Neither producer draws, so neither owns the drawing, and the two Phase-2
 * owners that need bars do not edit the same function.
 *
 * The bar is drawn into the GL framebuffer like the rest of the chrome, never into a DOM layer above
 * it: §11 requires it in every golden, and a DOM overlay is invisible to `readPixel` and to
 * `screenshot()` — which is the same as not testing it.
 */

import type { OverlayBuilder, OverlayMetrics } from './builder';
import { CELL_W, GLYPH_H } from '../render/font';
import { lutTexelOf } from '../color/colormaps';
import type { BakedLut } from '../color/colormaps';
import type { vec4, VolumeDataset, VolumeLayer } from '../scene/types';

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

/** Bar geometry, derived from the pane so every producer gets the same shape. */
export interface ColorbarLayout {
  /** Bar thickness across its short axis, in pane pixels. */
  thickness: number;
  /** Bar length along its long axis. */
  length: number;
  /** Distance between stacked bars. */
  pitch: number;
}

/**
 * The bar's own metrics.
 *
 * The right-hand bar deliberately leaves a **two-character gutter** at the pane edge: §8's
 * orientation letters sit at the edge midpoints (`R` on the right, at half height), and a bar drawn
 * flush to the edge would overprint the one piece of chrome §8 calls a laterality-safety
 * requirement rather than decoration.
 */
export function colorbarLayout(m: OverlayMetrics, position: 'right' | 'bottom'): ColorbarLayout {
  const thickness = 8 * m.scale;
  if (position === 'bottom') {
    const length = Math.max(40 * m.scale, Math.min(Math.round(m.widthPx * 0.38), 220 * m.scale));
    return { thickness, length, pitch: thickness + m.lineH * 2 + m.pad };
  }
  const length = Math.max(40 * m.scale, Math.min(Math.round(m.heightPx * 0.38), 160 * m.scale));
  return { thickness, length, pitch: length + m.lineH * 2 + m.pad };
}

/**
 * Append one colour bar's geometry; `slot` places bars 0, 1, 2… down (or along) the pane.
 *
 * Pure and side-effect-free, like every other item in this directory, so §11 can assert the layout
 * without a GL context.
 */
export function drawColorbar(
  b: OverlayBuilder,
  m: OverlayMetrics,
  spec: ColorbarSpec,
  textColor: vec4,
  slot = 0
): void {
  const layout = colorbarLayout(m, spec.position);
  const glyphH = GLYPH_H * m.scale;
  const title = spec.units === undefined ? spec.title : `${spec.title} (${spec.units})`;
  const notchThickness = Math.max(1, m.scale);

  if (spec.position === 'bottom') {
    const x0 = m.pad;
    const y0 = m.pad + m.lineH + slot * layout.pitch;
    drawBacking(b, x0, y0, layout.length, layout.thickness, m.scale, textColor);
    for (let p = 0; p < layout.length; p += 1) {
      b.rect(x0 + p, y0, 1, layout.thickness, rampAt(spec.ramp, (p + 0.5) / layout.length));
    }
    for (const n of spec.notches) {
      const x = x0 + Math.round(n * (layout.length - notchThickness));
      b.rect(x, y0, notchThickness, layout.thickness, textColor);
    }
    for (const tick of spec.ticks) {
      const x = x0 + tick.t * layout.length;
      b.labelWithHalo(
        tick.label,
        x,
        y0 - glyphH - 2 * m.scale,
        m.scale,
        textColor,
        tickAlign(tick.t)
      );
    }
    b.labelWithHalo(title, x0, y0 + layout.thickness + 2 * m.scale, m.scale, textColor, 'left');
    return;
  }

  // Right: the bar column sits inside the two-character gutter, with ticks right-aligned to its
  // left and the title above it. Bars stack downward from **two** text lines under the top edge:
  // the RAD/NEU badge owns the first line, and the title used to sit on it — `TI MAX` against
  // `NEU` in the same corner (2026-08-29). One clear line between them.
  const x0 = m.widthPx - m.pad - 2 * CELL_W * m.scale - layout.thickness;
  const top = m.heightPx - m.pad - glyphH - 2 * m.lineH - slot * layout.pitch;
  const y0 = top - layout.length;
  drawBacking(b, x0, y0, layout.thickness, layout.length, m.scale, textColor);
  for (let p = 0; p < layout.length; p += 1) {
    b.rect(x0, y0 + p, layout.thickness, 1, rampAt(spec.ramp, (p + 0.5) / layout.length));
  }
  for (const n of spec.notches) {
    const y = y0 + Math.round(n * (layout.length - notchThickness));
    b.rect(x0, y, layout.thickness, notchThickness, textColor);
  }
  for (const tick of spec.ticks) {
    // The label's baseline, not its centre, so the first and last tick stay inside the bar.
    const y = y0 + tick.t * (layout.length - glyphH);
    b.labelWithHalo(tick.label, x0 - 2 * m.scale, y, m.scale, textColor, 'right');
  }
  b.labelWithHalo(title, x0 + layout.thickness, top + 2 * m.scale, m.scale, textColor, 'right');
}

/**
 * A dark plate behind the bar, plus a hairline frame.
 *
 * The ramp carries the `Scale`'s own alpha — a `heat` scale is transparent below `min`, a
 * thresholded one outside its window — so without a plate the dead band would show the anatomy
 * through it and read as part of the colormap rather than as a gap in it.
 */
function drawBacking(
  b: OverlayBuilder,
  x: number,
  y: number,
  w: number,
  h: number,
  scale: number,
  textColor: vec4
): void {
  const t = Math.max(1, scale);
  b.rect(x - t, y - t, w + 2 * t, h + 2 * t, [textColor[0], textColor[1], textColor[2], 0.55]);
  b.rect(x, y, w, h, [0.05, 0.05, 0.06, 1]);
}

/** Keep the first and last tick inside the bar rather than centred off its end. */
function tickAlign(t: number): 'left' | 'center' | 'right' {
  return t <= 0.001 ? 'left' : t >= 0.999 ? 'right' : 'center';
}

/** The ramp colour at `t` along the bar, sampled the way the shader samples the LUT: NEAREST. */
function rampAt(ramp: Uint8Array, t: number): vec4 {
  const width = Math.max(1, ramp.length / 4);
  const i = Math.min(width - 1, Math.max(0, Math.floor(t * width))) * 4;
  return [
    (ramp[i] ?? 0) / 255,
    (ramp[i + 1] ?? 0) / 255,
    (ramp[i + 2] ?? 0) / 255,
    (ramp[i + 3] ?? 0) / 255,
  ];
}

/**
 * A tick number, in the 45 characters the bitmap font has (`render/font.ts`).
 *
 * There are no lowercase glyphs, so an exponent is `1.2E-3` and never `1.2e-3`: a missing glyph
 * decodes as a space, and a colour bar that silently loses its exponent is worse than one with no
 * exponent at all.
 */
export function formatTick(v: number): string {
  if (!Number.isFinite(v)) return '';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 100000 || a < 0.001) return v.toExponential(1).toUpperCase();
  if (a >= 100) return String(Math.round(v));
  if (a >= 1) return trimZeros(v.toFixed(2));
  return trimZeros(v.toFixed(3));
}

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/**
 * §8's colour bar for a **volume** layer: the ramp the slice shader samples, and the same numbers.
 *
 * The displayed value range is not always the baked LUT's range. A `heat` scale bakes over
 * `[-max, max]` so one texture serves both signs, but with `negative: 'hide'` the lower half is
 * entirely transparent and a bar showing it would be half empty and misleading — so the bar shows
 * `[0, max]` there, and the whole `[-max, max]` when the negative branch is displayed.
 *
 * Ticks follow §8: the endpoints, plus `mid` for heat — and `0` when the bar straddles it, because a
 * two-sided heat bar with an unlabelled centre cannot be read.
 *
 * Returns `null` for a label volume — those get §8's region panel, not a continuous ramp — and for a
 * layer with `showColorbar` off.
 */
export function volumeColorbarSpec(
  layer: VolumeLayer,
  ds: VolumeDataset,
  baked: BakedLut
): ColorbarSpec | null {
  if (!layer.showColorbar || ds.isLabel) return null;
  const scale = layer.scale;
  const twoSided = scale.kind === 'heat' && scale.negative !== 'hide';
  const v0 = scale.kind === 'linear' ? scale.lo : twoSided ? -scale.max : 0;
  const v1 = scale.kind === 'linear' ? scale.hi : scale.max;
  const at = (v: number): number => (v1 > v0 ? (v - v0) / (v1 - v0) : 0);

  const ticks: ColorbarTick[] = [{ t: 0, label: formatTick(v0) }];
  if (scale.kind === 'heat') {
    if (twoSided) ticks.push({ t: at(0), label: '0' });
    if (scale.mid > v0 && scale.mid < v1) {
      ticks.push({ t: at(scale.mid), label: formatTick(scale.mid) });
    }
  }
  ticks.push({ t: 1, label: formatTick(v1) });

  const notches: number[] = [];
  for (const edge of [layer.threshold.lo, layer.threshold.hi]) {
    if (!Number.isFinite(edge)) continue;
    const t = at(edge);
    if (t > 0 && t < 1) notches.push(t);
  }

  return {
    layerId: layer.id,
    title: layer.name,
    units: ds.units,
    // The strip is the baked LUT restricted to the displayed range, taken on the shader's own texel
    // grid, so the bar and the slice cannot disagree about which colour a value has.
    ramp: sliceRamp(baked, v0, v1),
    ticks,
    notches,
    position: 'right',
  };
}

/** The baked LUT's texels for `[v0, v1]`, in bar order (low → high). */
function sliceRamp(baked: BakedLut, v0: number, v1: number): Uint8Array {
  const lo = Math.min(lutTexelOf(baked, v0), lutTexelOf(baked, v1));
  const hi = Math.max(lutTexelOf(baked, v0), lutTexelOf(baked, v1));
  return baked.rgba.slice(lo * 4, (hi + 1) * 4);
}
