/**
 * The isosurface editor's pure half (§4.4's `IsosurfaceLayer`).
 *
 * An isosurface has one source — a volume (`marchingCubes`) or a mesh field (`marchingTets`), both of
 * which landed in `tvx-geom` in Phase 1 — one `iso` level, a colour, `smooth` and `faceMode`. The
 * only piece of real logic is **where the slider's range comes from**: it is the source's own `Stats`,
 * because an iso level typed against the wrong field's range is a surface the user cannot find.
 */

import type { Dataset, IsosurfaceLayer, MeshDataset, VolumeDataset, vec4 } from '@tetravox/engine';

export interface IsoSourceOption {
  /** `vol:<datasetId>` or `mesh:<datasetId>:<node|elm>:<name>`. */
  key: string;
  label: string;
  lo: number;
  hi: number;
}

function volumeOption(ds: VolumeDataset): IsoSourceOption {
  return {
    key: `vol:${ds.id}`,
    label: `${ds.name} (volume)`,
    lo: ds.stats.min,
    hi: ds.stats.max,
  };
}

function meshOptions(ds: MeshDataset): IsoSourceOption[] {
  return ds.fields.map((f) => ({
    key: `mesh:${ds.id}:${f.source}:${f.name}`,
    label: `${ds.name} · ${f.name} (${f.source})`,
    lo: f.stats.min,
    hi: f.stats.max,
  }));
}

/** Every source in the scene an isosurface can be built from, volumes first. */
export function isoSourceOptions(datasets: readonly Dataset[]): IsoSourceOption[] {
  const out: IsoSourceOption[] = [];
  for (const ds of datasets) if (ds.kind === 'volume') out.push(volumeOption(ds));
  for (const ds of datasets) if (ds.kind === 'mesh') out.push(...meshOptions(ds));
  return out;
}

/** The key of the layer's current source, so the `<select>` shows what the layer actually holds. */
export function isoSourceKey(layer: IsosurfaceLayer): string {
  const field = layer.source.field;
  return field === undefined
    ? `vol:${layer.source.datasetId}`
    : `mesh:${layer.source.datasetId}:${field.source}:${field.name}`;
}

export function findIsoSource(
  options: readonly IsoSourceOption[],
  key: string
): IsoSourceOption | null {
  return options.find((o) => o.key === key) ?? null;
}

/** The `[lo, hi]` the iso slider spans, or `[0, 1]` when the source is not in the scene any more. */
export function isoRange(
  options: readonly IsoSourceOption[],
  layer: IsosurfaceLayer
): { lo: number; hi: number } {
  const found = findIsoSource(options, isoSourceKey(layer));
  if (found === null || !(found.hi > found.lo)) return { lo: 0, hi: 1 };
  return { lo: found.lo, hi: found.hi };
}

/**
 * Switching source moves `iso` to the **midpoint of the new range**, because the old level is a
 * number in the old field's units — `TI_max` peaks at 10.29 and `final_tissues` at 10, but `T1` at
 * 65535, so carrying the value across produces an empty surface and no clue why.
 */
export function selectIsoSource(
  options: readonly IsoSourceOption[],
  key: string
): Partial<IsosurfaceLayer> {
  const found = findIsoSource(options, key);
  if (found === null) return {};
  const iso = (found.lo + found.hi) / 2;
  if (key.startsWith('vol:')) {
    return { source: { datasetId: key.slice(4), volumeIndex: 0 }, iso };
  }
  const [, datasetId, source, ...rest] = key.split(':');
  if (datasetId === undefined || (source !== 'node' && source !== 'elm')) return {};
  return {
    source: { datasetId, field: { source, name: rest.join(':'), component: 'mag' } },
    iso,
  };
}

export function setIso(_layer: IsosurfaceLayer, iso: number): Partial<IsosurfaceLayer> {
  return { iso };
}

export function setIsoColor(_layer: IsosurfaceLayer, color: vec4): Partial<IsosurfaceLayer> {
  return { color };
}

export function setIsoSmooth(_layer: IsosurfaceLayer, smooth: boolean): Partial<IsosurfaceLayer> {
  return { smooth };
}

export function setIsoFaceMode(
  _layer: IsosurfaceLayer,
  faceMode: IsosurfaceLayer['faceMode']
): Partial<IsosurfaceLayer> {
  return { faceMode };
}

/** A step that is usable at both ends of the reference data: 1/200 of the source's range. */
export function isoStep(range: { lo: number; hi: number }): number {
  const span = range.hi - range.lo;
  return span > 0 ? span / 200 : 0.01;
}
