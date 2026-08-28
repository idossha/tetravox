/**
 * The four job presets (`docs/AUTOMATION.md`, `docs/PLAN-2026-08-28-directed.md` task 4).
 *
 * A preset is "auto-configure the visualisation" — the maintainer's ask (4) — and it is expressed
 * here as **pure functions from what is loaded to a list of `Engine.updateLayer` patches**. Nothing
 * in this file touches an `Engine`, a canvas or a `window`, which is what lets it be unit-tested at
 * the same altitude as each kind's `panels/layers/<kind>/state.ts`, the §8 property editors this
 * file deliberately mirrors.
 *
 * Every number a preset picks is derived from the data it was given — never typed in. `ti-field-on-t1`
 * thresholds at the field's own 90th percentile, which is a different value for every simulation, and
 * `p90` is computed from `Stats.histogram` because §4.2's `PercentileKey` union stops at 95 and 50.
 * A hard-coded 0.2 V/m would render an empty pane on one subject and a solid block on the next.
 */

import type {
  Dataset,
  Layer,
  LayerId,
  MeshLayer,
  MeshDataset,
  Stats,
  VolumeLayer,
  VolumeDataset,
} from '@tetravox/engine';

export type PresetName = 'plain' | 'ti-field-on-t1' | 'mesh-tissues-translucent' | 'atlas-outline';

/** One `Engine.updateLayer` call. */
export interface LayerPatch {
  layerId: LayerId;
  patch: Partial<Layer>;
}

export interface PresetPlan {
  /** Applied in order, before any of the job's own `set` actions. */
  patches: LayerPatch[];
  /** Bottom→top layer order, when the preset needs one. Empty means "leave it alone". */
  order: LayerId[];
  /** What the preset could not find, verbatim into `job-result.json`. */
  warnings: string[];
}

const EMPTY: PresetPlan = { patches: [], order: [], warnings: [] };

// ------------------------------------------------------------------------------------------------
// Statistics
// ------------------------------------------------------------------------------------------------

/**
 * A percentile from `Stats.histogram`, for the ones §4.2's `PercentileKey` does not carry.
 *
 * The histogram is 256 bins over `[histogramLo, histogramHi]`, so this is exact to within a bin —
 * 0.4 % of the range — and the value is then linearly interpolated inside the bin it lands in. That
 * is the right accuracy for a display threshold and the wrong one for a reported measurement, so
 * nothing outside display code should call it.
 *
 * `p` is in 0..100. Returns `stats.min` for an empty histogram, which is the honest answer for a
 * volume that is entirely one value.
 */
export function percentileFromHistogram(stats: Stats, p: number): number {
  const bins = stats.histogram;
  let total = 0;
  for (const n of bins) total += n;
  if (total === 0 || bins.length === 0) return stats.min;
  const target = (Math.max(0, Math.min(100, p)) / 100) * total;
  const width = (stats.histogramHi - stats.histogramLo) / bins.length;
  let running = 0;
  for (let i = 0; i < bins.length; i += 1) {
    const n = bins[i] as number;
    if (running + n >= target && n > 0) {
      const within = (target - running) / n;
      return stats.histogramLo + (i + within) * width;
    }
    running += n;
  }
  return stats.histogramHi;
}

// ------------------------------------------------------------------------------------------------
// Finding things
// ------------------------------------------------------------------------------------------------

export interface PresetInput {
  layers: readonly Layer[];
  /** Every loaded dataset, keyed by id — `Scene.datasets` as a plain map. */
  datasets: ReadonlyMap<string, Dataset>;
}

function datasetOf(input: PresetInput, layer: Layer): Dataset | undefined {
  return input.datasets.get(layer.datasetId);
}

/** A structural T1: a scalar (non-label) volume whose name does not look like a field. */
function findAnatomy(input: PresetInput): { layer: VolumeLayer; dataset: VolumeDataset } | null {
  for (const layer of input.layers) {
    if (layer.kind !== 'volume') continue;
    const dataset = datasetOf(input, layer);
    if (dataset === undefined || dataset.kind !== 'volume' || dataset.isLabel) continue;
    if (/ti_max|_ti|field|magne/i.test(dataset.name)) continue;
    return { layer, dataset };
  }
  return null;
}

/** A label volume: `isLabel`, which is a header fact and not a name guess. */
function findLabels(input: PresetInput): { layer: VolumeLayer; dataset: VolumeDataset } | null {
  for (const layer of input.layers) {
    if (layer.kind !== 'volume') continue;
    const dataset = datasetOf(input, layer);
    if (dataset?.kind === 'volume' && dataset.isLabel) return { layer, dataset };
  }
  return null;
}

/**
 * The TI field, as either a NIfTI or a mesh — the plan names both ("a TI_max NIfTI **or** mesh field").
 *
 * A volume qualifies by name (a name ending `_TI_max.nii.gz`, which is what SimNIBS writes); a mesh qualifies by
 * **carrying a field**, which is a fact about the file rather than about its name, and the field
 * chosen is `TI_max` when it is there and the first scalar otherwise.
 */
function findField(
  input: PresetInput
):
  | { kind: 'volume'; layer: VolumeLayer; stats: Stats; units?: string }
  | { kind: 'mesh'; layer: MeshLayer; dataset: MeshDataset; field: MeshDataset['fields'][number] }
  | null {
  for (const layer of input.layers) {
    if (layer.kind !== 'volume') continue;
    const dataset = datasetOf(input, layer);
    if (dataset?.kind !== 'volume' || dataset.isLabel) continue;
    if (/ti_max|_ti\b|magne|field/i.test(dataset.name)) {
      return {
        kind: 'volume',
        layer,
        stats: dataset.stats,
        ...(dataset.units === undefined ? {} : { units: dataset.units }),
      };
    }
  }
  for (const layer of input.layers) {
    if (layer.kind !== 'mesh') continue;
    const dataset = datasetOf(input, layer);
    if (dataset?.kind !== 'mesh' || dataset.fields.length === 0) continue;
    const named = dataset.fields.find((f) => /ti_max/i.test(f.name));
    const scalar = dataset.fields.find((f) => f.ncomp === 1);
    const field = named ?? scalar ?? (dataset.fields[0] as MeshDataset['fields'][number]);
    return { kind: 'mesh', layer, dataset, field };
  }
  return null;
}

// ------------------------------------------------------------------------------------------------
// §7.6 tissue tags
// ------------------------------------------------------------------------------------------------

/**
 * SimNIBS tissue tags, tets and their `1000 + tag` surfaces (`docs/TESTING.md`'s census).
 *
 * Tag 4 is deliberately absent from the census — tags are not contiguous — so these are listed
 * rather than generated from a range.
 */
export const TISSUE_TAGS = {
  wm: [1, 1001],
  gm: [2, 1002],
  csf: [3, 1003],
  scalp: [5, 1005],
  bone: [7, 8, 1007, 1008],
} as const;

/** The plan's translucency: scalp 0.3, bone 0.5, opaque GM/WM. */
export const TRANSLUCENT_TISSUE_OPACITY: Record<number, number> = {};
for (const tag of TISSUE_TAGS.scalp) TRANSLUCENT_TISSUE_OPACITY[tag] = 0.3;
for (const tag of TISSUE_TAGS.bone) TRANSLUCENT_TISSUE_OPACITY[tag] = 0.5;
for (const tag of [...TISSUE_TAGS.gm, ...TISSUE_TAGS.wm]) TRANSLUCENT_TISSUE_OPACITY[tag] = 1;

// ------------------------------------------------------------------------------------------------
// The presets
// ------------------------------------------------------------------------------------------------

/**
 * `ti-field-on-t1` — a grey T1 with the TI field over it as a thresholded heat overlay.
 *
 * The numbers, and where each comes from:
 *
 * * **`threshold.lo = p90`**, mode `hide`. Below the 90th percentile a TI field is the noise floor
 *   plus the scalp rim, and drawing it hides the anatomy the overlay exists to sit on.
 * * **`scale = heat(p90, p97, p99.9)`**. `min` matches the threshold so the first visible voxel is
 *   the first coloured one; `max` is p99.9 and not the maximum, because `Thalamus_TI.msh`'s TI_max
 *   reaches 10.29 V/m against a p99.9 two orders of magnitude below it and a max-anchored scale
 *   renders the whole brain in the bottom colour.
 * * **`showColorbar`**, because a heat overlay without its scale is a picture of nothing (§8 makes
 *   colour bars "required in screenshots").
 */
function tiFieldOnT1(input: PresetInput): PresetPlan {
  const warnings: string[] = [];
  const patches: LayerPatch[] = [];
  const order: LayerId[] = [];

  const anatomy = findAnatomy(input);
  const field = findField(input);
  if (anatomy === null)
    warnings.push('ti-field-on-t1: no structural volume found for the base layer');
  if (field === null) {
    warnings.push(
      'ti-field-on-t1: no TI field found (a *_TI_max.nii.gz, or a mesh carrying a field)'
    );
    return { patches, order, warnings };
  }

  if (anatomy !== null) {
    patches.push({
      layerId: anatomy.layer.id,
      patch: { colormap: 'gray', opacity: 1, visible: true } as Partial<VolumeLayer>,
    });
    order.push(anatomy.layer.id);
  }

  const stats = field.kind === 'volume' ? field.stats : field.field.stats;
  const lo = percentileFromHistogram(stats, 90);
  const mid = percentileFromHistogram(stats, 97);
  const hi = percentileFromHistogram(stats, 99.9);
  // A field whose p90 and p99.9 coincide (a constant volume) would give a zero-width scale, which is
  // a division by zero in the shader's normalisation rather than a flat picture.
  const max = hi > lo ? hi : lo + Math.max(1e-6, Math.abs(lo) * 0.1);

  const shared = {
    colormap: 'hot' as const,
    scale: {
      kind: 'heat' as const,
      min: lo,
      mid,
      max,
      truncate: false,
      inverse: false,
      negative: 'hide' as const,
    },
    threshold: {
      lo,
      hi: Number.POSITIVE_INFINITY,
      symmetric: false,
      mode: 'hide' as const,
      softEdge: 0,
    },
    showColorbar: true,
    visible: true,
  };

  if (field.kind === 'volume') {
    patches.push({
      layerId: field.layer.id,
      patch: { ...shared, opacity: 0.85 } as Partial<VolumeLayer>,
    });
  } else {
    patches.push({
      layerId: field.layer.id,
      patch: {
        ...shared,
        colorMode: 'field',
        field: { source: field.field.source, name: field.field.name, component: 'mag' },
        opacity: 1,
      } as Partial<MeshLayer>,
    });
  }
  order.push(field.layer.id);
  // Anything the preset did not name keeps its relative position, above the two it did.
  for (const layer of input.layers) if (!order.includes(layer.id)) order.push(layer.id);
  return { patches, order, warnings };
}

/** `mesh-tissues-translucent` — scalp 0.3 / bone 0.5 over opaque GM and WM (the plan's numbers). */
function meshTissuesTranslucent(input: PresetInput): PresetPlan {
  const patches: LayerPatch[] = [];
  const warnings: string[] = [];
  let found = false;
  for (const layer of input.layers) {
    if (layer.kind !== 'mesh') continue;
    const dataset = datasetOf(input, layer);
    if (dataset?.kind !== 'mesh') continue;
    found = true;
    // Only tags the file actually has: writing a style for a tag that is not there is harmless but
    // makes the serialised scene claim tissues the mesh does not contain.
    const tagStyle: MeshLayer['tagStyle'] = { ...layer.tagStyle };
    for (const tag of dataset.tags) {
      const opacity = TRANSLUCENT_TISSUE_OPACITY[tag.id];
      if (opacity === undefined) continue;
      const existing = tagStyle[tag.id];
      tagStyle[tag.id] = {
        visible: true,
        opacity,
        ...(existing?.color === undefined ? {} : { color: existing.color }),
      };
    }
    patches.push({
      layerId: layer.id,
      // `faceMode: 'both'` because a translucent scalp with back faces culled shows the inside of the
      // head through the front of it, which reads as a hole rather than as translucency.
      patch: { tagStyle, colorMode: 'tag', faceMode: 'both', visible: true } as Partial<MeshLayer>,
    });
  }
  if (!found) warnings.push('mesh-tissues-translucent: no mesh layer to style');
  return { patches, order: [], warnings };
}

/** `atlas-outline` — the label volume as outlines over whatever anatomy is loaded. */
function atlasOutline(input: PresetInput): PresetPlan {
  const patches: LayerPatch[] = [];
  const order: LayerId[] = [];
  const warnings: string[] = [];
  const labels = findLabels(input);
  if (labels === null) {
    warnings.push('atlas-outline: no label volume found (a volume whose header says it is one)');
    return { patches, order, warnings };
  }
  const anatomy = findAnatomy(input);
  if (anatomy !== null) {
    patches.push({
      layerId: anatomy.layer.id,
      patch: { colormap: 'gray', opacity: 1 } as Partial<VolumeLayer>,
    });
    order.push(anatomy.layer.id);
  }
  patches.push({
    layerId: labels.layer.id,
    patch: {
      labelMode: 'outline',
      outlineWidthPx: 2,
      interpolation: 'nearest',
      opacity: 1,
      visible: true,
    } as Partial<VolumeLayer>,
  });
  order.push(labels.layer.id);
  for (const layer of input.layers) if (!order.includes(layer.id)) order.push(layer.id);
  return { patches, order, warnings };
}

/** The whole preset table. `plain` is a real entry, not a null check: "load it and leave it alone". */
export function planPreset(preset: PresetName, input: PresetInput): PresetPlan {
  switch (preset) {
    case 'plain':
      return EMPTY;
    case 'ti-field-on-t1':
      return tiFieldOnT1(input);
    case 'mesh-tissues-translucent':
      return meshTissuesTranslucent(input);
    case 'atlas-outline':
      return atlasOutline(input);
  }
}
