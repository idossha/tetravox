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
