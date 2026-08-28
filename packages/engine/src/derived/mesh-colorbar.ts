/**
 * The **mesh** colour bar's `ColorbarSpec` producer (§8, ROADMAP P2-11).
 *
 * `overlay/colorbar.ts` states the seam this file is one half of: *a colour bar is one renderer with
 * two producers.* A volume layer builds a spec from its `Scale` / `Threshold` / colormap (E-SLICE); a
 * mesh field layer builds one from its `MeshFieldInfo` (this file); neither draws, so the two
 * Phase-2 owners who need bars do not edit one function.
 *
 * What §8 asks a bar to carry, and where each part comes from:
 *
 * * **the ramp** — the same `bakeScale` the shader samples, so the bar and the geometry cannot
 *   disagree about what a value looks like; 512 wide when `negative === 'separate'` (§7.6);
 * * **ticks** at the scale endpoints, plus `mid` for `kind: 'heat'`;
 * * **notches** where `Threshold.lo` / `.hi` fall along the bar, omitted when the threshold is the
 *   open interval a layer starts with — an infinite bound has no position on a bar;
 * * **units**, from `MeshFieldMeta.units` (the Gmsh view name), which is already on the wire.
 */

import { bakeScale, isColormapName } from '../color/colormaps';
import { glyphColorT, glyphScaling, glyphScalingWord, referenceMagnitude } from './glyph-scale';
import type { ColorbarSpec, ColorbarTick } from '../overlay/colorbar';
import type { ColormapName, MeshDataset, MeshLayer, Scale } from '../scene/types';

/** Where a physical value sits along a baked bar, 0..1. */
export function tickPosition(scale: Scale, v: number): number {
  const lo = scale.kind === 'linear' ? scale.lo : -scale.max;
  const hi = scale.kind === 'linear' ? scale.hi : scale.max;
  if (!(hi > lo)) return 0;
  return Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
}

function label(v: number): string {
  if (!Number.isFinite(v)) return '';
  const a = Math.abs(v);
  if (a !== 0 && (a < 0.01 || a >= 100000)) return v.toExponential(2).toUpperCase();
  const rounded = Math.round(v * 1000) / 1000;
  return String(rounded);
}

/**
 * The bar for one mesh layer, or `null` when the layer shows no scalar.
 *
 * A `colorMode` of `'tag'`, `'solid'` or `'label'` has no continuous scale to describe — §8 asks for
 * "one per visible scalar layer" — and the tissue table (A-PROPS) is what describes a tag palette.
 */
export function meshColorbarSpec(layer: MeshLayer, ds: MeshDataset): ColorbarSpec | null {
  if (!layer.visible || !layer.showColorbar) return null;
  if (layer.colorMode !== 'field' || layer.field === undefined) return null;
  const info = ds.fields.find(
    (f) => f.name === layer.field?.name && f.source === layer.field.source
  );

  const name: ColormapName = isColormapName(layer.colormap) ? layer.colormap : 'gray';
  const negative: ColormapName =
    layer.colormapNegative !== undefined && isColormapName(layer.colormapNegative)
      ? layer.colormapNegative
      : 'blue-cyan';
  const baked = bakeScale(layer.scale, name, negative);

  const ticks: ColorbarTick[] = [
    { t: 0, label: label(baked.lo) },
    { t: 1, label: label(baked.hi) },
  ];
  if (layer.scale.kind === 'heat') {
    ticks.splice(1, 0, {
      t: tickPosition(layer.scale, layer.scale.mid),
      label: label(layer.scale.mid),
    });
  }

  const notches: number[] = [];
  const t = layer.threshold;
  if (Number.isFinite(t.lo)) notches.push(tickPosition(layer.scale, t.lo));
  if (Number.isFinite(t.hi)) notches.push(tickPosition(layer.scale, t.hi));

  return {
    layerId: layer.id,
    title: layer.field.name,
    ...(info?.units !== undefined ? { units: info.units } : {}),
    ramp: baked.rgba,
    ticks,
    notches,
    position: 'right',
  };
}

/**
 * The **glyph** colour bar (added 2026-08-28 for directed task 7).
 *
 * `colorBy: 'magnitude'` has always sampled the layer's colormap over `[0, reference]`, and nothing
 * on screen said so — the ramp had no bar, no numbers and no name, which on a field whose magnitude
 * runs 8.56e-13 … 57.79 is a picture nobody can read a value off. This is the same
 * {@link ColorbarSpec} the field bar uses, over the glyph's own range, with the **scaling named in
 * the title** (`E |LOG10|`), because the length and the colour are two encodings of one quantity and
 * a bar that describes only the colour invites reading the length off the wrong map.
 *
 * `null` when the layer is hidden, has no glyphs, or colours them solid — a solid colour is not a
 * scale, exactly as `colorMode: 'solid'` gets no bar.
 */
export function glyphColorbarSpec(layer: MeshLayer, ds: MeshDataset): ColorbarSpec | null {
  const spec = layer.glyphs;
  if (spec === undefined || !layer.visible || !layer.showColorbar) return null;
  if (spec.colorBy !== 'magnitude') return null;
  const info = ds.fields.find((f) => f.name === spec.field.name && f.source === spec.field.source);
  const ref = referenceMagnitude(glyphScaling(spec), info?.stats);

  const name: ColormapName = isColormapName(layer.colormap) ? layer.colormap : 'gray';
  const negative: ColormapName =
    layer.colormapNegative !== undefined && isColormapName(layer.colormapNegative)
      ? layer.colormapNegative
      : 'blue-cyan';
  // The renderer indexes its LUT by `glyphColorT`, so the bar is that map sampled at even *value*
  // steps: position p along the bar is the value `ref·p`, painted the colour the arrow at that value
  // gets. Under `log` the ramp is therefore compressed at the top exactly as the lengths are, which
  // is what makes the `LOG10` in the title a description rather than a caption.
  const baked = bakeScale({ kind: 'linear', lo: 0, hi: 1 }, name, negative);
  const texels = baked.rgba.length / 4;
  const ramp = new Uint8Array(baked.rgba.length);
  for (let i = 0; i < texels; i += 1) {
    const t = glyphColorT(glyphScaling(spec), (ref * (i + 0.5)) / texels, ref);
    const src = Math.min(texels - 1, Math.max(0, Math.round(t * (texels - 1)))) * 4;
    ramp.set(baked.rgba.subarray(src, src + 4), i * 4);
  }

  return {
    layerId: `${layer.id}|glyphs`,
    // `render/font.ts` has no `|`, so the magnitude is spelled `MAG` (see `glyphLegendLine`).
    title: `MAG ${spec.field.name} ${glyphScalingWord(spec)}`,
    ...(info?.units !== undefined ? { units: info.units } : {}),
    ramp,
    ticks: [
      { t: 0, label: label(0) },
      { t: 1, label: label(ref) },
    ],
    notches: [],
    position: 'right',
  };
}
