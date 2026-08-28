/**
 * Synthetic §4.3 datasets and §4.4 layers for the no-GL engine.
 *
 * Every field of the frozen scene model is filled with a *plausible* value, not a zero: the point of
 * developing the shell against a stand-in is that the panels are laid out against the shapes they will
 * really receive — sparse label ids, an oblique affine, non-contiguous mesh tags, an element field.
 *
 * Numbers here are shaped after the reference dataset (AGENTS.md) so the panels are sized for real
 * data, but they are **invented**; nothing in this file is a reference value and no test asserts one
 * against `TETRAVOX_TESTDATA`.
 */

import type {
  Aabb,
  Dataset,
  DatasetId,
  Layer,
  LayerId,
  MeshDataset,
  MeshTag,
  MshOptions,
  PercentileKey,
  Stats,
  VolumeDataset,
  mat4,
  vec3,
} from '@tetravox/engine';

const PERCENTILE_KEYS: readonly PercentileKey[] = [
  '0.1',
  '1',
  '2',
  '5',
  '50',
  '95',
  '98',
  '99',
  '99.9',
];

export function makeStats(min: number, max: number): Stats {
  const percentiles = {} as Record<PercentileKey, number>;
  const fractions: Record<PercentileKey, number> = {
    '0.1': 0.001,
    '1': 0.01,
    '2': 0.02,
    '5': 0.05,
    '50': 0.5,
    '95': 0.95,
    '98': 0.98,
    '99': 0.99,
    '99.9': 0.999,
  };
  for (const key of PERCENTILE_KEYS) percentiles[key] = min + (max - min) * fractions[key];
  const histogram = new Uint32Array(256);
  for (let i = 0; i < 256; i++) histogram[i] = 1 + ((i * 7919) % 97);
  return {
    min,
    max,
    mean: (min + max) / 2,
    percentiles,
    histogram,
    histogramLo: min,
    histogramHi: max,
  };
}

/** Column-major (§3): scaling on the diagonal, translation in `m[12..14]`. */
export function scaleTranslate(spacing: vec3, origin: vec3): mat4 {
  const m = new Float32Array(16);
  m[0] = spacing[0];
  m[5] = spacing[1];
  m[10] = spacing[2];
  m[12] = origin[0];
  m[13] = origin[1];
  m[14] = origin[2];
  m[15] = 1;
  return m;
}

export function invertScaleTranslate(spacing: vec3, origin: vec3): mat4 {
  const m = new Float32Array(16);
  m[0] = 1 / spacing[0];
  m[5] = 1 / spacing[1];
  m[10] = 1 / spacing[2];
  m[12] = -origin[0] / spacing[0];
  m[13] = -origin[1] / spacing[1];
  m[14] = -origin[2] / spacing[2];
  m[15] = 1;
  return m;
}

export function identity(): mat4 {
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

function boundsOf(dims: vec3, spacing: vec3, origin: vec3): Aabb {
  return {
    min: origin,
    max: [
      origin[0] + (dims[0] - 1) * spacing[0],
      origin[1] + (dims[1] - 1) * spacing[1],
      origin[2] + (dims[2] - 1) * spacing[2],
    ],
  };
}

/** `.nii` / `.nii.gz` / `.mgz` → volume; everything else the viewer accepts → mesh. */
export type DatasetKindGuess = 'volume' | 'mesh' | 'unsupported';

const VOLUME_EXT = ['.nii', '.nii.gz', '.mgz', '.mgh'];
const MESH_EXT = ['.msh', '.gii', '.stl', '.ply', '.obj', '.surf', '.pial', '.white', '.central'];

export function guessKind(name: string): DatasetKindGuess {
  const lower = name.toLowerCase();
  if (VOLUME_EXT.some((e) => lower.endsWith(e))) return 'volume';
  if (MESH_EXT.some((e) => lower.endsWith(e))) return 'mesh';
  // FreeSurfer surfaces have no extension at all: `lh.pial`, `rh.central`.
  if (/(^|\/)(lh|rh)\.[a-z]+$/.test(lower)) return 'mesh';
  return 'unsupported';
}

/** A label volume when the name looks like a segmentation — the §7.6 `isLabel` path, exercised. */
function looksLikeLabels(name: string): boolean {
  return /label|tissue|seg|aparc|aseg|atlas/i.test(name);
}

/**
 * A plausible `toTemplate` (§4.3) for the coordinate bar's MNI column (audit P2-10).
 *
 * `sform_code`/`qform_code` = 4 is MNI152, and E-SCENE derives the real one in `scene/fromMeta.ts`.
 * The stand-in offers one **only when asked** (`?mockTemplate=1`) so both of the shell's states —
 * the column live, and the column greyed with its reason — are reachable in an E2E. On subject data
 * absent is the common case: a SimNIBS `m2m` T1 is `sform_code = 2`, not 4.
 *
 * A 12 mm anterior shift and no rotation, so a test can assert an offset rather than a matrix.
 */
export function mniToTemplate(): NonNullable<VolumeDataset['toTemplate']> {
  return { name: 'MNI152', kind: 'affine', matrix: scaleTranslate([1, 1, 1], [0, 12, 0]) };
}

export function makeVolume(
  id: DatasetId,
  name: string,
  path: string | undefined,
  handle: number,
  workerId: number,
  options: { toTemplate?: boolean } = {}
): VolumeDataset {
  const isLabel = looksLikeLabels(name);
  const dims: vec3 = [256, 256, 208];
  const spacing: vec3 = [1, 1, 1];
  const origin: vec3 = [-99.737457, -128.1875, -143.642273];
  const data = isLabel ? new Uint16Array(64) : new Float32Array(64);
  for (let i = 0; i < data.length; i++) data[i] = isLabel ? i % 11 : i * 3.5;
  const stats = isLabel ? makeStats(0, 10) : makeStats(-41.807507, 65535);
  const labelIds = isLabel ? Uint32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) : undefined;
  const denseIndexOf = isLabel ? Uint32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) : undefined;
  const entries = isLabel
    ? [
        { id: 0, name: 'Unassigned', color: [0, 0, 0, 0] as [number, number, number, number] },
        {
          id: 1,
          name: 'White matter',
          color: [0.9, 0.9, 0.85, 1] as [number, number, number, number],
        },
        {
          id: 2,
          name: 'Grey matter',
          color: [0.55, 0.55, 0.6, 1] as [number, number, number, number],
        },
        { id: 3, name: 'CSF', color: [0.3, 0.5, 0.95, 1] as [number, number, number, number] },
        { id: 5, name: 'Scalp', color: [0.95, 0.75, 0.6, 1] as [number, number, number, number] },
        { id: 10, name: 'Muscle', color: [0.8, 0.3, 0.3, 1] as [number, number, number, number] },
      ]
    : [];

  return {
    kind: 'volume',
    id,
    name,
    ...(path === undefined ? {} : { path }),
    dims,
    nvols: /_4d|bold|dwi/i.test(name) ? 3 : 1,
    affine: scaleTranslate(spacing, origin),
    inverseAffine: invertScaleTranslate(spacing, origin),
    spacing,
    bounds: boundsOf(dims, spacing, origin),
    dtype: isLabel ? 'u16' : 'f32',
    data,
    sclSlope: 1,
    sclInter: 0,
    isLabel,
    ...(labelIds === undefined ? {} : { labelIds }),
    ...(denseIndexOf === undefined ? {} : { denseIndexOf }),
    ...(isLabel ? { labelTable: { entries, byId: new Map(entries.map((e) => [e.id, e])) } } : {}),
    stats,
    units: isLabel ? undefined : 'a.u.',
    gpu: {
      format: isLabel ? 'R16UI' : 'R32F',
      scale: 1,
      offset: 0,
      filterable: !isLabel,
      chunked: false,
    },
    ...(options.toTemplate === true ? { toTemplate: mniToTemplate() } : {}),
    // §8's header panel shows this verbatim. Shaped after a real 348-byte NIfTI header rather than
    // three fields, because the panel's real-data gate item is that `scl_slope` reads **1** — the
    // on-disk value — and not nibabel's NaN (`AGENTS.md`); a stub with no `scl_slope` could not
    // catch a panel that dropped it.
    headerJson: JSON.stringify({
      sizeof_hdr: 348,
      dim: [3, ...dims, 1, 1, 1, 1],
      datatype: isLabel ? 512 : 16,
      bitpix: isLabel ? 16 : 32,
      pixdim: [-1, 1, 1, 1, 0, 0, 0, 0],
      scl_slope: 1,
      scl_inter: 0,
      qform_code: options.toTemplate === true ? 4 : 2,
      sform_code: options.toTemplate === true ? 4 : 2,
      quatern_b: 0.5,
      quatern_c: -0.5,
      quatern_d: -0.5,
      qoffset_x: origin[0],
      qoffset_y: origin[1],
      qoffset_z: origin[2],
      xyzt_units: 2,
      descrip: 'Tetravox stand-in volume',
    }),
    worker: { id: workerId },
    handle,
  };
}

/**
 * Non-contiguous tags on purpose: §7.6 "tag 4 is absent from ernie".
 *
 * Also **paired** on purpose, the way a real `.msh` is: a tissue is a volume tag `t` over its tets
 * and a surface tag `t + 1000` over its tris, sharing one `.msh.opt` name. Grey matter and the
 * electrode carry both halves; White matter, CSF and Scalp carry only the volume half here, so the
 * Region panel's lone-tag row has a fixture too.
 */
const MESH_TAGS: readonly Omit<MeshTag, 'color'>[] = [
  { id: 1, name: 'White matter', kind: 'tet', count: 517_144 },
  { id: 2, name: 'Grey matter', kind: 'tet', count: 1_340_029 },
  { id: 3, name: 'CSF', kind: 'tet', count: 874_602 },
  { id: 5, name: 'Scalp', kind: 'tet', count: 567_089 },
  { id: 101, name: 'Electrode', kind: 'tet', count: 84 },
  { id: 1002, name: 'Grey matter', kind: 'tri', count: 335_930 },
  { id: 1101, name: 'Electrode', kind: 'tri', count: 28 },
];

const TAG_COLORS: readonly [number, number, number, number][] = [
  [0.86, 0.86, 0.82, 1],
  [0.55, 0.55, 0.62, 1],
  [0.35, 0.55, 0.95, 1],
  [0.95, 0.76, 0.62, 1],
  [0.6, 0.6, 0.68, 1],
  [0.98, 0.85, 0.2, 1],
  [0.9, 0.4, 0.4, 1],
];

/**
 * The `MshOptions` a `<mesh>.msh.opt` sidecar seeds (§6.2, §7.6).
 *
 * `fromMeta` is the one place that divides by 255 (§4.1), so these are already 0..1 — the same form
 * the engine's real `MeshMeta.opt` arrives in after conversion. Tag 3 is hidden and tags 1 and 2 are
 * recoloured away from the default palette, so the "defaults from X.msh.opt" chip's Reset has
 * something visibly different to restore.
 */
export function mockMshOptions(tags: readonly MeshTag[]): MshOptions {
  const tagColor: Record<number, [number, number, number, number]> = {};
  const tagVisible: Record<number, boolean> = {};
  for (const [index, tag] of tags.entries()) {
    tagColor[tag.id] = [0.1 + index * 0.12, 0.8 - index * 0.1, 0.4, 1];
    tagVisible[tag.id] = tag.id !== 3;
  }
  return {
    tagColor,
    tagVisible,
    views: [{ name: 'TI_max', customMin: 0, customMax: 0.5, showScale: true, rangeType: 2 }],
  };
}

export function makeMesh(
  id: DatasetId,
  name: string,
  path: string | undefined,
  handle: number,
  workerId: number,
  options: { opt?: boolean } = {}
): MeshDataset {
  const hasTris = !/tetonly|grey_/i.test(name);
  const tags: MeshTag[] = MESH_TAGS.filter((t) => hasTris || t.kind === 'tet').map((t, i) => ({
    ...t,
    color: TAG_COLORS[i % TAG_COLORS.length] as [number, number, number, number],
  }));
  return {
    kind: 'mesh',
    id,
    name,
    ...(path === undefined ? {} : { path }),
    transform: identity(),
    appliedTransform: identity(),
    bounds: {
      min: [-84.436612, -92.398125, -128.860523],
      max: [83.3978, 136.15704, 99.951712],
    },
    nNodes: 847_165,
    nTris: hasTris ? 1_177_213 : 0,
    nTets: 4_722_625,
    hasTris,
    fields: [
      {
        name: 'TI_max',
        source: 'elm',
        ncomp: 1,
        n: 5_899_838,
        units: 'V/m',
        partial: false,
        stats: makeStats(1.0863735014567724e-12, 10.293712064403254),
      },
      {
        name: 'E',
        source: 'elm',
        ncomp: 3,
        n: 5_900_498,
        units: 'V/m',
        partial: false,
        stats: makeStats(8.563626769948982e-13, 57.78990622669672),
      },
    ],
    tags,
    skipped: [],
    ...(options.opt === true ? { opt: mockMshOptions(tags) } : {}),
    orient: { components: 1, openComponents: 0, nonManifoldEdges: 0, flippedComponents: 0 },
    topologyBuilt: false,
    worker: { id: workerId },
    handle,
  };
}

/** A layer with every §4.4 field at its documented default, for `dataset`. */
export function defaultLayer(dataset: Dataset, layerId: LayerId): Layer {
  const base = {
    id: layerId,
    datasetId: dataset.id,
    name: dataset.name,
    visible: true,
    opacity: 1,
    pickable: true,
    showColorbar: true,
  };
  if (dataset.kind === 'volume') {
    return {
      ...base,
      kind: 'volume',
      volumeIndex: 0,
      colormap: dataset.isLabel ? 'gray' : 'gray',
      scale: { kind: 'linear', lo: dataset.stats.min, hi: dataset.stats.max },
      threshold: {
        lo: dataset.stats.min,
        hi: dataset.stats.max,
        symmetric: false,
        mode: 'hide',
        softEdge: 0,
      },
      interpolation: dataset.isLabel ? 'nearest' : 'linear',
      labelMode: 'fill',
      outlineWidthPx: 1,
      showIn3D: false,
      precision: 'auto',
    };
  }
  const tagStyle: Record<number, { visible: boolean; opacity: number }> = {};
  for (const tag of dataset.tags) tagStyle[tag.id] = { visible: true, opacity: 1 };
  return {
    ...base,
    kind: 'mesh',
    colorMode: 'tag',
    solidColor: [0.7, 0.7, 0.75, 1],
    colormap: 'viridis',
    scale: { kind: 'linear', lo: 0, hi: 1 },
    threshold: { lo: 0, hi: 1, symmetric: false, mode: 'hide', softEdge: 0 },
    tagStyle,
    edges: { surface: false, caps: false },
    edgeColor: [0, 0, 0, 1],
    edgeWidthPx: 1,
    flatShading: false,
    faceMode: dataset.orient.openComponents > 0 ? 'both' : 'cull',
    clip: { planes: [], caps: true, capColorMode: 'inherit' },
    contoursIn2D: false,
    contourWidthPx: 1,
    fillIn2D: false,
  };
}
