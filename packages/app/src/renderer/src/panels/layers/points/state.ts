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
