/**
 * Default scene, views and layers (§4.4, §4.5).
 *
 * Every default here is deterministic — no clock, no random ids — because §11's goldens are
 * captured from a scene built by these functions, and a non-deterministic default would make every
 * golden racy.
 */

import { identity4 } from '../view/m4';
import { presetNormal, presetUp } from '../view/geometry';
import type {
  Layer,
  MeshDataset,
  MeshLayer,
  Scene,
  SliceMode,
  SliceView,
  Threshold,
  vec4,
  View3D,
  VolumeDataset,
  VolumeLayer,
} from './types';

export const AXIAL_VIEW_ID = 'axial';
export const CORONAL_VIEW_ID = 'coronal';
export const SAGITTAL_VIEW_ID = 'sagittal';
export const VIEW3D_ID = 'view3d';

const NO_THRESHOLD: Threshold = {
  lo: Number.NEGATIVE_INFINITY,
  hi: Number.POSITIVE_INFINITY,
  symmetric: false,
  mode: 'clamp',
  softEdge: 0,
};

export function defaultSliceView(id: string, mode: SliceMode): SliceView {
  return {
    id,
    mode,
    normal: presetNormal(mode),
    up: presetUp(mode),
    camera: { center: [0, 0], mmPerPx: 0.5 },
  };
}

export function defaultView3D(): View3D {
  return {
    id: VIEW3D_ID,
    camera: {
      target: [0, 0, 0],
      distance: 400,
      // Identity rotation looks down -Z from +Z: the superior preset (§7.5 key `5`).
      rotation: [0, 0, 0, 1],
      fovYDeg: 35,
      orthographic: false,
      near: 1,
      far: 2000,
    },
    showSlicePlanes: false,
  };
}

export function defaultScene(): Scene {
  const slices = [
    defaultSliceView(AXIAL_VIEW_ID, 'axial'),
    defaultSliceView(CORONAL_VIEW_ID, 'coronal'),
    defaultSliceView(SAGITTAL_VIEW_ID, 'sagittal'),
  ];
  return {
    version: 1,
    datasets: new Map(),
    layers: [],
    activeLayerId: null,
    slices,
    view3d: defaultView3D(),
    layout: { kind: '2x2', cells: [AXIAL_VIEW_ID, CORONAL_VIEW_ID, SAGITTAL_VIEW_ID, VIEW3D_ID] },
    cursor: [0, 0, 0],
    hover: null,
    radiological: false,
    background: [0.04, 0.05, 0.07, 1],
    lighting: { ambient: 0.25, headlight: true },
    annotations: {
      orientationLabels: true,
      cornerInfo: true,
      conventionBadge: true,
      scaleBar: false,
      colorbars: false,
      crosshair: true,
    },
    transparency: { mode: 'twoPhase' },
    quality: { name: 'full', dprScale: 1, msaa: 4, edges: true, capDecimation: 1, oit: false },
  };
}

/**
 * The default window for a scalar volume: the 2nd–98th percentile.
 *
 * Not min..max. `m2m_ernie/T1.nii.gz` has a physical max of **exactly 65535.0** `[DATA]` against a
 * brain that lives in the low hundreds, so a min..max window renders an almost-black slice. The
 * percentiles are exact (§6.1 computes them with no sampling), so this is deterministic.
 */
export function defaultWindow(ds: VolumeDataset): { lo: number; hi: number } {
  const p = ds.stats.percentiles;
  const lo = p['2'];
  const hi = p['98'];
  return hi > lo
    ? { lo, hi }
    : { lo: ds.stats.min, hi: ds.stats.max > ds.stats.min ? ds.stats.max : ds.stats.min + 1 };
}

export function defaultVolumeLayer(id: string, ds: VolumeDataset): VolumeLayer {
  const w = defaultWindow(ds);
  return {
    id,
    datasetId: ds.id,
    name: ds.name,
    visible: true,
    opacity: 1,
    pickable: true,
    showColorbar: true,
    kind: 'volume',
    volumeIndex: 0,
    colormap: 'gray',
    scale: { kind: 'linear', lo: w.lo, hi: w.hi },
    threshold: NO_THRESHOLD,
    // §4.4: forced to 'nearest' when the dataset is a label volume.
    interpolation: ds.isLabel ? 'nearest' : 'linear',
    labelMode: 'fill',
    outlineWidthPx: 1,
    showIn3D: false,
    precision: 'auto',
  };
}

const DEFAULT_MESH_COLOR: vec4 = [0.78, 0.78, 0.8, 1];

export function defaultMeshLayer(id: string, ds: MeshDataset): MeshLayer {
  return {
    id,
    datasetId: ds.id,
    name: ds.name,
    visible: true,
    opacity: 1,
    pickable: true,
    showColorbar: false,
    kind: 'mesh',
    colorMode: 'tag',
    solidColor: DEFAULT_MESH_COLOR,
    colormap: 'viridis',
    scale: { kind: 'linear', lo: 0, hi: 1 },
    threshold: NO_THRESHOLD,
    // §6.2's ladder already resolved names and colours per tag; `.msh.opt` visibility seeds the
    // style map so a `Hide "*"` sidecar is respected on open (§7.6).
    tagStyle: Object.fromEntries(
      ds.tags.map((t) => [t.id, { visible: ds.opt?.tagVisible[t.id] ?? true, opacity: 1 }])
    ),
    edges: { surface: false, caps: false },
    edgeColor: [0, 0, 0, 1],
    edgeWidthPx: 1,
    flatShading: false,
    // §7.4: 'both' is forced when the surface has open components — which every tagged tissue
    // complex has, because an interface triangle's winding is arbitrary.
    faceMode: ds.orient.openComponents > 0 ? 'both' : 'cull',
    clip: { planes: [], caps: true, capColorMode: 'inherit' },
    contoursIn2D: false,
    contourWidthPx: 1,
    fillIn2D: false,
  };
}

export function defaultLayerFor(id: string, ds: VolumeDataset | MeshDataset): Layer {
  return ds.kind === 'volume' ? defaultVolumeLayer(id, ds) : defaultMeshLayer(id, ds);
}

export { identity4 };
