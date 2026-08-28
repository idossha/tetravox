/**
 * Wire → scene model (§4.3).
 *
 * **This file is the only place in the engine that divides a colour by 255.** §4.1 makes that
 * normative: Rust and the §6.5 wire keep `[u8; 4]`, everything past this file is RGBA 0..1 floats,
 * and `expectPixel` (§11) asserts the **wire** bytes for a tag-coloured pixel.
 *
 * It is also where the §3 matrix-layout boundary is crossed: a wire `Mat4x4` is flat, length 16,
 * **column-major**, which is exactly gl-matrix's `mat4` layout, so the affine passes through
 * unchanged — while `inverseAffine` is computed here once, since the shader needs it per fragment.
 */

import { asGl, identity4 } from '../view/m4';
import { mat4 as glMat4 } from 'gl-matrix';
import type { GeoPayloadT, LabelEntryT, MeshMeta, StatsT, VolumeMeta } from '@tetravox/protocol';
import type {
  Aabb,
  DatasetId,
  GeoData,
  LabelTable,
  MeshDataset,
  MeshFieldInfo,
  MeshTag,
  MshOptions,
  PercentileKey,
  Stats,
  TypedArray,
  vec3,
  vec4,
  VolumeDataset,
  WorkerRef,
} from './types';

const PERCENTILE_KEYS: PercentileKey[] = ['0.1', '1', '2', '5', '50', '95', '98', '99', '99.9'];

/** The single 0..255 → 0..1 conversion (§4.1). */
export function colorFromWire(c: [number, number, number, number]): vec4 {
  return [c[0] / 255, c[1] / 255, c[2] / 255, c[3] / 255];
}

export function statsFromWire(s: StatsT): Stats {
  const percentiles = {} as Record<PercentileKey, number>;
  PERCENTILE_KEYS.forEach((k, i) => {
    percentiles[k] = s.percentiles[i] ?? 0;
  });
  return {
    min: s.min,
    max: s.max,
    mean: s.mean,
    percentiles,
    histogram: s.histogram,
    histogramLo: s.histogramLo,
    histogramHi: s.histogramHi,
  };
}

export function labelTableFromWire(entries: LabelEntryT[]): LabelTable {
  const list = entries.map((e) => ({ id: e.id, name: e.name, color: colorFromWire(e.color) }));
  return { entries: list, byId: new Map(list.map((e) => [e.id, e])) };
}

function typedArrayFor(dtype: VolumeMeta['dtype'], data: ArrayBuffer): TypedArray {
  switch (dtype) {
    case 'u8':
    case 'rgb24':
    case 'rgba32':
      return new Uint8Array(data);
    case 'i8':
      return new Int8Array(data);
    case 'u16':
      return new Uint16Array(data);
    case 'i16':
      return new Int16Array(data);
    case 'u32':
      return new Uint32Array(data);
    case 'i32':
      return new Int32Array(data);
    case 'f32':
      return new Float32Array(data);
    case 'f64':
      return new Float64Array(data);
  }
}

/**
 * §4.3's `toTemplate`, derived from the NIfTI header — P2-10, and **no protocol change** (the
 * ownership map's "explicitly not gaps" table says so; this is why).
 *
 * `VolumeMeta.headerJson` carries every raw header field, including `sform_code` / `qform_code` and
 * the `affineSource` the reader chose between them (`crates/tvx-nifti/src/read.rs`). NIfTI-1 defines
 * code **4** as `NIFTI_XFORM_MNI_152`: the world coordinates that affine produces *are* MNI152 mm. So
 * the transform from world RAS to the template is the **identity**, and `ProbeResult.mni` is the
 * cursor itself — which is why a matrix is still the right shape when it is `I`: a future `MNI305`,
 * or a real registration, slots into the same field.
 *
 * The code consulted is the one belonging to the affine that was actually **used**, never "either of
 * them": a volume with `sform_code = 2` (scanner anat — what every `m2m_ernie` volume has `[DATA]`)
 * and a stale `qform_code = 4` is in scanner space, and reporting MNI for it would put a coordinate
 * in a paper that is wrong by centimetres. Codes other than 4 — including 5,
 * `NIFTI_XFORM_TEMPLATE_OTHER`, which names no particular template — yield `undefined`, and §8's MNI
 * column then does not appear.
 */
export function toTemplateFromHeader(headerJson: string): VolumeDataset['toTemplate'] {
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(headerJson) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const source = header.affineSource;
  const key = source === 'qform' ? 'qform_code' : source === 'sform' ? 'sform_code' : null;
  if (key === null) return undefined;
  // 4 = NIFTI_XFORM_MNI_152.
  if (header[key] !== 4) return undefined;
  return { name: 'MNI152', kind: 'affine', matrix: identity4() };
}

/** `matrix · world`, for `ProbeResult.mni` (§4.7). Column-major `mat4`, like everything in §3. */
export function applyAffine(m: Float32Array, w: vec3): vec3 {
  return [
    (m[0] ?? 0) * w[0] + (m[4] ?? 0) * w[1] + (m[8] ?? 0) * w[2] + (m[12] ?? 0),
    (m[1] ?? 0) * w[0] + (m[5] ?? 0) * w[1] + (m[9] ?? 0) * w[2] + (m[13] ?? 0),
    (m[2] ?? 0) * w[0] + (m[6] ?? 0) * w[1] + (m[10] ?? 0) * w[2] + (m[14] ?? 0),
  ];
}

/** World-space AABB of a volume: all eight voxel-grid corners through the affine. */
export function volumeBounds(dims: vec3, affine: Float32Array): Aabb {
  const min: vec3 = [Infinity, Infinity, Infinity];
  const max: vec3 = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 8; c += 1) {
    // Voxel *centres* are at integer indices (§3), so the grid spans 0 .. dims-1.
    const i = (c & 1) === 0 ? 0 : dims[0] - 1;
    const j = (c & 2) === 0 ? 0 : dims[1] - 1;
    const k = (c & 4) === 0 ? 0 : dims[2] - 1;
    for (let r = 0; r < 3; r += 1) {
      const v =
        (affine[r] ?? 0) * i +
        (affine[4 + r] ?? 0) * j +
        (affine[8 + r] ?? 0) * k +
        (affine[12 + r] ?? 0);
      if (v < (min[r] ?? 0)) min[r] = v;
      if (v > (max[r] ?? 0)) max[r] = v;
    }
  }
  return { min, max };
}

export function volumeDatasetFromMeta(
  id: DatasetId,
  meta: VolumeMeta,
  data: ArrayBuffer,
  worker: WorkerRef,
  path: string | undefined,
  labelIds: Uint32Array | undefined,
  denseIndexOf: Uint32Array | undefined
): VolumeDataset {
  // A wire Mat4x4 is already column-major, i.e. gl-matrix layout (§3).
  const affine = new Float32Array(meta.affine);
  const inverseAffine = identity4();
  glMat4.invert(asGl(inverseAffine), asGl(affine));
  const toTemplate = toTemplateFromHeader(meta.headerJson);
  return {
    kind: 'volume',
    id,
    name: meta.name,
    path,
    dims: meta.dims,
    nvols: meta.nvols,
    affine,
    inverseAffine,
    spacing: meta.spacing,
    bounds: volumeBounds(meta.dims, affine),
    dtype: meta.dtype,
    data: typedArrayFor(meta.dtype, data),
    sclSlope: meta.sclSlope,
    sclInter: meta.sclInter,
    isLabel: meta.isLabel,
    labelIds,
    denseIndexOf,
    labelTable: meta.labelTable !== undefined ? labelTableFromWire(meta.labelTable) : undefined,
    stats: statsFromWire(meta.stats),
    units: meta.units,
    gpu: meta.gpu,
    headerJson: meta.headerJson,
    // P2-10: derived here, from the header the loader already sends (§8's MNI column, §4.7's
    // `ProbeResult.mni`). Assigned only when it exists, so the field stays absent rather than
    // becoming an explicit `undefined` a `JSON.stringify` would have to carry.
    ...(toTemplate !== undefined ? { toTemplate } : {}),
    worker,
    handle: meta.handle,
  };
}

function fieldFromWire(f: MeshMeta['fields'][number]): MeshFieldInfo {
  return {
    name: f.name,
    source: f.source,
    ncomp: f.ncomp,
    n: f.n,
    units: f.units,
    partial: f.partial,
    stats: statsFromWire(f.stats),
  };
}

function optFromWire(opt: NonNullable<MeshMeta['opt']>): MshOptions {
  const tagColor: Record<number, vec4> = {};
  for (const [k, v] of Object.entries(opt.tagColor)) tagColor[Number(k)] = colorFromWire(v);
  const tagVisible: Record<number, boolean> = {};
  for (const [k, v] of Object.entries(opt.tagVisible)) tagVisible[Number(k)] = v;
  return { tagColor, tagVisible, views: opt.views };
}

/**
 * `MeshMeta.labelTables` — the `<LabelTable>` a `.label.gii` carries, or a `.annot`'s colortable —
 * keyed by the node-field name §6.5.1 keys it by.
 *
 * `undefined` rather than `{}` when the file has none, so `MeshDataset.labelTables !== undefined`
 * reads as "this mesh has a label table" without a length check at every call site.
 */
export function labelTablesFromWire(
  tables: MeshMeta['labelTables']
): Record<string, LabelTable> | undefined {
  if (tables === undefined) return undefined;
  const out: Record<string, LabelTable> = {};
  for (const [name, entries] of Object.entries(tables)) out[name] = labelTableFromWire(entries);
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * `GeoPayloadT` → {@link GeoData} (§6.5.1).
 *
 * The typed arrays arrived transferred, so they are read here into the small object arrays the
 * scene model uses — 187 electrodes is 187 objects, four orders of magnitude away from the sizes
 * §5 rule 3 exists for. `lineSegments` stays a `Float32Array`: it feeds a vertex buffer verbatim.
 */
export function geoFromWire(geo: GeoPayloadT): GeoData {
  const points: GeoData['points'] = [];
  for (let i = 0; i < geo.pointValues.length; i += 1) {
    points.push({
      position: [geo.points[i * 3] ?? 0, geo.points[i * 3 + 1] ?? 0, geo.points[i * 3 + 2] ?? 0],
      value: geo.pointValues[i] ?? 0,
      view: geo.pointView[i] ?? 0,
    });
  }
  const labels: GeoData['labels'] = geo.labelTexts.map((text, i) => ({
    position: [
      geo.labelPositions[i * 3] ?? 0,
      geo.labelPositions[i * 3 + 1] ?? 0,
      geo.labelPositions[i * 3 + 2] ?? 0,
    ] as vec3,
    text,
  }));
  return {
    points,
    labels,
    lineSegments: geo.lineSegments,
    viewNames: geo.viewNames,
    views: geo.views.map((v) => ({
      name: v.name,
      points: v.points,
      labels: v.labels,
      lines: v.lines,
      tris: v.tris,
    })),
    bounds: { min: geo.bounds.min, max: geo.bounds.max },
  };
}

export function meshDatasetFromMeta(
  id: DatasetId,
  meta: MeshMeta,
  worker: WorkerRef,
  path: string | undefined,
  geo?: GeoPayloadT
): MeshDataset {
  const tags: MeshTag[] = meta.tags.map((t) => ({
    id: t.id,
    name: t.name,
    color: colorFromWire(t.color),
    kind: t.kind,
    count: t.count,
  }));
  return {
    kind: 'mesh',
    id,
    name: meta.name,
    path,
    transform: identity4(),
    appliedTransform: new Float32Array(meta.appliedTransform),
    dataSpace: meta.dataSpace,
    transformedSpace: meta.transformedSpace,
    bounds: { min: meta.bounds.min, max: meta.bounds.max },
    nNodes: meta.nNodes,
    nTris: meta.nTris,
    nTets: meta.nTets,
    hasTris: meta.hasTris,
    fields: meta.fields.map(fieldFromWire),
    labelTables: labelTablesFromWire(meta.labelTables),
    geo: geo === undefined ? undefined : geoFromWire(geo),
    tags,
    skipped: meta.skipped,
    opt: meta.opt !== undefined ? optFromWire(meta.opt) : undefined,
    orient: {
      components: meta.orient.components,
      openComponents: meta.orient.openComponents,
      nonManifoldEdges: meta.orient.nonManifoldEdges,
      flippedComponents: meta.orient.flippedComponents,
    },
    topologyBuilt: false,
    worker,
    handle: meta.handle,
  };
}
