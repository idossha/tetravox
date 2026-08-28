/**
 * The points editor's pure half (§4.4's `PointsLayer`).
 *
 * A points layer is "electrodes, ROI spheres from JSON/CSV, and SimNIBS `eeg_positions/*.csv`", and
 * — unlike every other layer — it is **not backed by a dataset worker**: the points arrive with the
 * layer. So the "source" this panel shows is the layer's own provenance, and the editable state is
 * the shape/radius/colour block plus per-point overrides.
 */

import type { Dataset, PointsLayer, vec3, vec4 } from '@tetravox/engine';

export interface PointRow {
  index: number;
  name: string;
  position: vec3;
  /** The effective radius: the point's own override, else the layer's. */
  radiusMm: number;
  /** The effective colour: the point's own override, else the layer's. */
  color: vec4;
  overridden: boolean;
}

export function pointRows(layer: PointsLayer): PointRow[] {
  return (layer.points ?? []).map((p, index) => ({
    index,
    name: p.name ?? `#${index + 1}`,
    position: p.position,
    radiusMm: p.radiusMm ?? layer.radiusMm,
    color: p.color ?? layer.color,
    overridden: p.color !== undefined || p.radiusMm !== undefined,
  }));
}

/** Search over the point names — an EEG net is 185 rows and scrolling it is not a UI. */
export function filterPoints(rows: readonly PointRow[], query: string): PointRow[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...rows];
  return rows.filter((r) => r.name.toLowerCase().includes(q));
}

/** What the panel prints for "source": the file the points came in with, and how many there are. */
export function pointsSourceText(dataset: Dataset | undefined, layer: PointsLayer): string {
  const n = (layer.points ?? []).length;
  const where = dataset?.path ?? dataset?.name ?? layer.name;
  return `${where} · ${n.toLocaleString()} point${n === 1 ? '' : 's'}`;
}

export function setPointsRadius(_layer: PointsLayer, radiusMm: number): Partial<PointsLayer> {
  return { radiusMm: Math.max(0, radiusMm) };
}

export function setPointsColor(_layer: PointsLayer, color: vec4): Partial<PointsLayer> {
  return { color };
}

export function setPointsShape(
  _layer: PointsLayer,
  shape: PointsLayer['shape']
): Partial<PointsLayer> {
  return { shape };
}

export function setShowLabels(_layer: PointsLayer, showLabels: boolean): Partial<PointsLayer> {
  return { showLabels };
}

// -----------------------------------------------------------------------------------------------
// Parsed Gmsh views (`.geo` / `.pos`, directed task 6). Additive: every knob below is optional on
// the layer and absent means the Phase-2 behaviour.
// -----------------------------------------------------------------------------------------------

/** Label text size, as a multiple of the pane's own font size. Clamped to a legible range. */
export function setLabelScale(_layer: PointsLayer, labelScale: number): Partial<PointsLayer> {
  return { labelScale: Math.min(4, Math.max(0.5, labelScale)) };
}

/**
 * Solid colour vs. the per-point value through a colormap.
 *
 * Switching to `'value'` seeds the range from the points themselves when the layer has none, so
 * the first click shows a spread rather than one flat colour — and a layer whose values are all
 * equal (every SimNIBS net writes `{0}`) gets a degenerate range, which `packPoints` maps to the
 * colormap's midpoint rather than dividing by zero.
 */
export function setValueMode(
  layer: PointsLayer,
  valueMode: NonNullable<PointsLayer['valueMode']>
): Partial<PointsLayer> {
  if (valueMode !== 'value' || layer.valueRange !== undefined) return { valueMode };
  const values = (layer.points ?? [])
    .map((p) => p.value)
    .filter((v): v is number => v !== undefined);
  if (values.length === 0) return { valueMode };
  return { valueMode, valueRange: { lo: Math.min(...values), hi: Math.max(...values) } };
}

export function setPointsColormap(_layer: PointsLayer, colormap: string): Partial<PointsLayer> {
  return { colormap };
}

/** Does this layer carry per-point values at all? Only then is the value/colormap row useful. */
export function hasPointValues(layer: PointsLayer): boolean {
  return (layer.points ?? []).some((p) => p.value !== undefined);
}

function patchPoint(
  layer: PointsLayer,
  index: number,
  edit: (p: PointsLayer['points'][number]) => PointsLayer['points'][number]
): Partial<PointsLayer> {
  const points = layer.points ?? [];
  if (points[index] === undefined) return {};
  return { points: points.map((p, i) => (i === index ? edit(p) : p)) };
}

export function setPointColor(
  layer: PointsLayer,
  index: number,
  color: vec4
): Partial<PointsLayer> {
  return patchPoint(layer, index, (p) => ({ ...p, color }));
}

export function setPointRadius(
  layer: PointsLayer,
  index: number,
  radiusMm: number
): Partial<PointsLayer> {
  return patchPoint(layer, index, (p) => ({ ...p, radiusMm: Math.max(0, radiusMm) }));
}

/** Drop a point's overrides so it follows the layer again. */
export function resetPoint(layer: PointsLayer, index: number): Partial<PointsLayer> {
  return patchPoint(layer, index, (p) => {
    const next = { ...p };
    delete next.color;
    delete next.radiusMm;
    return next;
  });
}
