/**
 * Default scene, views and layers (§4.4, §4.5).
 *
 * Every default here is deterministic — no clock, no random ids — because §11's goldens are
 * captured from a scene built by these functions, and a non-deterministic default would make every
 * golden racy.
 *
 * **Shared-file rule (see `docs/PHASE2-OWNERSHIP.md`): additive only.** E-SCENE owns this file;
 * E-SLICE and E-MESH both append to it. Append a layer kind's defaults at the end of its section
 * — and **never change an existing default**, which would move every golden that layer appears in
 * and is a `docs/DECISIONS.md` conversation, not a patch.
 */

import { identity4 } from '../view/m4';
import { presetNormal, presetUp } from '../view/geometry';
import type {
  ColormapName,
  IsosurfaceLayer,
  Layer,
  MeshDataset,
  MeshLayer,
  PointsLayer,
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
    quality: { name: 'full', dprScale: 1, msaa: 4, capDecimation: 1, oit: false },
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

/** §7.4's default surface contour width, in render-target pixels — the brief's 1.5 px. */
export const DEFAULT_SURFACE_CONTOUR_WIDTH_PX = 1.5;

/**
 * **One colour per surface** (§7.4, directed task 12), in load order.
 *
 * The maintainer's reference is a Freeview screenshot: the pial surface's intersection drawn as a
 * thin **yellow** outline on all three 2D panes. So entry 0 is that yellow, and the rest are a
 * non-neon set — chosen by eye against `T1.nii.gz`'s grey ramp for the one thing that matters here,
 * which is telling two outlines apart where they run a millimetre from each other over an
 * anatomical grey. Deliberately **not** the electrode amber (`[1, 0.85, 0.2, 1]`): a montage's
 * spheres and a surface's outline share a pane, and a viewer must not have to guess which is which.
 *
 * Cyan is absent for the same reason the brief excludes it — it is the colour Freeview gives the
 * white-matter surface, and reusing it for an arbitrary second surface would be a false cue.
 */
export const SURFACE_CONTOUR_PALETTE: readonly vec4[] = [
  [1.0, 0.9, 0.15, 1], // yellow — Freeview's pial
  [0.45, 0.78, 0.42, 1], // green
  [0.95, 0.5, 0.3, 1], // orange
  [0.6, 0.62, 0.95, 1], // periwinkle
  [0.9, 0.45, 0.68, 1], // rose
  [0.55, 0.82, 0.8, 1], // teal
];

/** The palette entry a surface opened `index`-th takes; wraps, because a scene may hold more. */
export function surfaceContourColor(index: number): vec4 {
  const n = SURFACE_CONTOUR_PALETTE.length;
  return SURFACE_CONTOUR_PALETTE[((index % n) + n) % n] as vec4;
}

/**
 * A **surface**: a triangle-only mesh (§6.2's GIfTI, FreeSurfer, STL/PLY/OBJ and `.geo` triangles).
 *
 * `nTets === 0` is the whole test, and it is the same one `derived/store.ts` branches on to send
 * this dataset down the `contours` op instead of `cut` — so "what draws an outline" and "what is
 * styled as an outline" cannot drift apart.
 */
export function isSurfaceMesh(ds: MeshDataset): boolean {
  return ds.nTets === 0;
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
    // **R4 (`docs/requirements/2026-08-27-maintainer.md`): "Default when a mesh is opened: fill and
    // contours on."** A maintainer requirement wins over the contract where the two disagree, and
    // this is the one place they do: §4.4 shipped both `false` in Phase 1 because nothing drew a
    // mesh in a 2D pane at all. No Phase-1 golden contains a mesh in a 2D pane, so no golden moves.
    // See `docs/DECISIONS.md`, 2026-08-27.
    contoursIn2D: true,
    contourWidthPx: 1,
    fillIn2D: true,
    // **Directed task 12: a surface is not a tissue complex, and opens differently.** It has no
    // tets, so `fillIn2D` has nothing to fill (`derived/store.ts` sends it to the `contours` op
    // and returns no polygons) — leaving it on would advertise a control that does nothing. Its
    // contour is the whole of its 2D presence, so it gets the brief's 1.5 px and its own palette
    // colour, first surface yellow like Freeview. **Nothing here moves for a tet mesh**: the three
    // lines above are still what `ernie.msh` opens with, so no R4 golden moves.
    ...(isSurfaceMesh(ds)
      ? {
          contoursIn2D: true,
          contourWidthPx: DEFAULT_SURFACE_CONTOUR_WIDTH_PX,
          fillIn2D: false,
          contourColor: surfaceContourColor(0),
        }
      : {}),
    // §4.4's `MeshLayer.label`, seeded from the dataset's own `<LabelTable>` / colortable.
    //
    // **`colorMode` is deliberately left at `'tag'`.** Seeding the *table* is what makes
    // `colorMode:'label'` selectable at all — `layers/mesh.ts` refuses the mode without one, and
    // §8's field selector greys it out — but which colouring a surface opens in is the user's
    // choice, and switching it here would change what every `.label.gii` looks like on open.
    // Appended, never edited: `label` is `undefined` for every mesh that carries no table, which
    // is every mesh in every golden that existed before this line.
    ...defaultMeshLabel(ds),
  };
}

/**
 * The `MeshLayer.label` block for a mesh that came with a `<LabelTable>` (`.label.gii`) or a
 * colortable (`.annot`), or `{}` for one that did not.
 *
 * §6.5.1 keys `MeshMeta.labelTables` by **node-field name**, and the layer's `label.name` is that
 * same key — it is the field the shader reads the dense index out of. When a file carries more than
 * one (nothing in the reference data does), the first is seeded and the rest are reachable through
 * §8's field selector; picking arbitrarily would be worse than picking the first.
 */
function defaultMeshLabel(ds: MeshDataset): { label?: MeshLayer['label'] } {
  const entries = Object.entries(ds.labelTables ?? {});
  const first = entries[0];
  if (first === undefined) return {};
  return { label: { name: first[0], table: first[1], mode: 'fill', outlineWidthPx: 1 } };
}

/**
 * `defaultMeshLayer` with §7.6's `.msh.opt` seeding applied (E-SCENE, appended).
 *
 * It only ever fires for a dataset the host gave a sidecar for (`app/.../lib/sidecars.ts` derives
 * the candidates), so a mesh opened without one — which is every mesh in every Phase-1 golden —
 * gets exactly `defaultMeshLayer`.
 */
function seededMeshLayer(id: string, ds: MeshDataset): MeshLayer {
  return seedMeshLayerFromOpt(defaultMeshLayer(id, ds), ds).layer;
}

/** Electrodes and ROI spheres are drawn over anatomy (§8), so the default is a high-contrast amber. */
const DEFAULT_POINT_COLOR: vec4 = [1, 0.85, 0.2, 1];
const DEFAULT_ISO_COLOR: vec4 = [0.85, 0.85, 0.88, 1];

/**
 * §4.4's `IsosurfaceLayer` (E-DERIVED, appended).
 *
 * The isovalue seeds from the source's own statistics rather than from a constant: the 98th
 * percentile of a scalar volume is a surface that encloses something, where a hardcoded `0.5` is
 * empty on every scalar volume that is not a probability map. A **label** volume is the case `0.5`
 * is right for, and it is the one §11's "isosurface of `final_tissues.nii.gz` at 0.5" names.
 */
export function defaultIsoLayer(id: string, ds: VolumeDataset | MeshDataset): IsosurfaceLayer {
  const field = ds.kind === 'mesh' ? ds.fields[0] : undefined;
  const iso =
    ds.kind === 'volume'
      ? ds.isLabel
        ? 0.5
        : ds.stats.percentiles['98']
      : (field?.stats.percentiles['98'] ?? 0.5);
  return {
    id,
    datasetId: ds.id,
    name: `${ds.name} iso`,
    visible: true,
    opacity: 1,
    pickable: false,
    showColorbar: false,
    kind: 'iso',
    source: {
      datasetId: ds.id,
      volumeIndex: ds.kind === 'volume' ? 0 : undefined,
      field:
        field === undefined
          ? undefined
          : { source: field.source, name: field.name, component: 'mag' },
    },
    iso,
    color: DEFAULT_ISO_COLOR,
    smooth: true,
    // Marching cubes / tets return a closed, consistently wound surface, so back-face culling is
    // safe here in a way §7.4 says it is not for a tagged tissue complex.
    faceMode: 'cull',
  };
}

/** §4.4's `PointsLayer` (E-DERIVED, appended). The points arrive with the layer, not with a worker. */
export function defaultPointsLayer(id: string, ds: VolumeDataset | MeshDataset): PointsLayer {
  return {
    id,
    datasetId: ds.id,
    name: 'Points',
    visible: true,
    opacity: 1,
    pickable: false,
    showColorbar: false,
    kind: 'points',
    points: [],
    shape: 'sphere',
    radiusMm: 4,
    color: DEFAULT_POINT_COLOR,
    showLabels: false,
    ...geoSeed(ds),
  };
}

/**
 * The parsed-view half of a points layer's defaults (`.geo` / `.pos`, task 6).
 *
 * `{}` for every other dataset, which is what keeps `defaultPointsLayer` byte-identical for the
 * Phase-2 callers and their goldens.
 *
 * **Labels default ON here and only here.** A `.geo` electrode net is 187 spheres that are
 * indistinguishable without their names — the file exists to say which electrode is which — while
 * a points layer built from a CSV of ROI centres has no names at all. So the default follows the
 * data: on when the view brought text, off otherwise.
 *
 * When the counts match, each label's text is also copied onto its point. SimNIBS writes one `T3`
 * per `SP`, in order, 5 mm above it (`AGENTS.md` real-data numbers), so index pairing is exact —
 * and a nearest-anchor match would be the thing that silently mislabels a dense net. When they do
 * not match the labels still draw, from their own anchors; only the probe row goes unnamed.
 */
function geoSeed(ds: VolumeDataset | MeshDataset): Partial<PointsLayer> {
  if (ds.kind !== 'mesh' || ds.geo === undefined) return {};
  const geo = ds.geo;
  const paired = geo.labels.length === geo.points.length;
  const values = geo.points.map((p) => p.value);
  const lo = values.length > 0 ? Math.min(...values) : 0;
  const hi = values.length > 0 ? Math.max(...values) : 0;
  const seed: Partial<PointsLayer> = {
    name: geo.viewNames[0] ?? 'Points',
    points: geo.points.map((p, i) => {
      const text = paired ? geo.labels[i]?.text : undefined;
      return text === undefined
        ? { position: p.position, value: p.value }
        : { position: p.position, value: p.value, name: text };
    }),
    showLabels: geo.labels.length > 0,
    labelScale: 1,
    valueMode: 'solid',
    colormap: 'viridis',
    valueRange: { lo, hi },
    lineWidthPx: 2,
    // A parsed view's radius is not in the file (Gmsh's `PointSize` is a screen size, not a world
    // one), so it is the layer default — 4 mm, about an EEG electrode.
  };
  if (geo.labels.length > 0) seed.labels = geo.labels;
  if (geo.lineSegments.length > 0) seed.lineSegments = geo.lineSegments;
  return seed;
}

/**
 * The default layer for a dataset, of a given kind.
 *
 * `kind` is optional and defaults to the dataset's own, so every Phase-1 call site is unchanged.
 * Without it `Engine.addLayer({ kind: 'iso' })` could not work at all: the facade builds the layer
 * from this function and then re-imposes `base.kind`, so a caller-requested kind this function never
 * produced was silently replaced by the dataset's own.
 */
export function defaultLayerFor(
  id: string,
  ds: VolumeDataset | MeshDataset,
  kind?: Layer['kind']
): Layer {
  // A parsed view with no triangles (every SimNIBS electrode net) is points, not a mesh: its
  // default mesh layer would be an empty surface and the file would look like it failed to open.
  const own =
    ds.kind === 'volume' ? 'volume' : ds.geo !== undefined && !ds.hasTris ? 'points' : 'mesh';
  const want = kind ?? own;
  switch (want) {
    case 'volume':
      return ds.kind === 'volume' ? defaultVolumeLayer(id, ds) : seededMeshLayer(id, ds);
    case 'mesh':
      return ds.kind === 'mesh' ? seededMeshLayer(id, ds) : defaultVolumeLayer(id, ds);
    case 'iso':
      return defaultIsoLayer(id, ds);
    case 'points':
      return defaultPointsLayer(id, ds);
  }
}

export { identity4 };

// ---------------------------------------------------------------------------------------------
// Appended by E-SCENE: `.msh.opt` seeding (§7.6). Shared-file rule: additive only.
// ---------------------------------------------------------------------------------------------

/**
 * Gmsh `View[n].ColormapNumber` → a §7.6 `ColormapName`.
 *
 * **Deliberately partial.** Gmsh's colour-table numbering is a list of names, and guessing at the
 * ones this project has no independent reading for would silently paint a field in the wrong
 * colours — the failure mode a viewer must never have. So the table covers the number the reference
 * data actually uses — SimNIBS writes `ColormapNumber = 2` in every `.msh.opt` it produces `[DATA]`,
 * which is Gmsh's rainbow/jet, the colouring a SimNIBS user sees in Gmsh — plus the four whose Gmsh
 * names are a §7.6 name exactly. Anything else leaves the layer's own default alone, which is a
 * viewer disagreeing with Gmsh about a colormap rather than lying about a field.
 */
export const MSH_OPT_COLORMAPS: Record<number, ColormapName> = {
  2: 'jet',
  7: 'hot',
  9: 'gray',
  13: 'bone',
  18: 'cool',
};

/** Which fields a `.msh.opt` actually seeded, for §7.6's "defaults from X.msh.opt" chip. */
export interface MshOptSeed {
  /** The sidecar's name, for the chip: `<mesh>.msh.opt`. */
  file: string;
  /** Field names, in the order they appear in `MeshLayer`. */
  seeded: string[];
}

/**
 * Seed a mesh layer from its `.msh.opt` (§7.6: "seeds tag colours/visibility, field range, colormap
 * and colorbar on open, with a 'defaults from X.msh.opt' chip and a one-click Reset").
 *
 * Mutates nothing: it returns the patched layer and the list of what it touched, so A-SHELL's chip
 * can name the fields and its Reset can put back `defaultMeshLayer`'s values by rebuilding the layer
 * without the sidecar.
 *
 * A dataset with no `.msh.opt` — every mesh the caller opened without one, which is every mesh in
 * every Phase-1 golden — comes back untouched with `seed: null`.
 */
/** Exact equality on §4.1's 0..1 quadruple — the wire bytes round-trip exactly, so `===` is right. */
function sameColor(a: vec4, b: vec4 | undefined): boolean {
  return b !== undefined && a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

export function seedMeshLayerFromOpt(
  layer: MeshLayer,
  ds: MeshDataset
): { layer: MeshLayer; seed: MshOptSeed | null } {
  const opt = ds.opt;
  if (opt === undefined) return { layer, seed: null };
  const seeded: string[] = [];
  const next: MeshLayer = { ...layer };

  // Tag visibility, and a tag colour **only where the dataset does not already carry it**.
  //
  // §6.2's ladder resolves a `.msh.opt` colour onto `MeshTag.color` when the sidecar reached the
  // loader, which is every real open — so writing it into `tagStyle` as well duplicated the same
  // fact into the place R5 reserves for the *user's* edit. The consequence, found at the Phase-2
  // merge: every tag looked recoloured from the moment the file opened, so A-PROPS's per-row Reset
  // and its "recoloured" marker could not tell a seed from an edit, and neither could a scene file.
  // Seeding what the dataset already says is not needed for a Reset either — the reset drops the
  // override and `tagColor()` falls through to `MeshTag.color`, which is the same value.
  // A dataset whose tags were built without the sidecar still gets the colour seeded here.
  const tagStyle: MeshLayer['tagStyle'] = {};
  let tagColours = 0;
  for (const tag of ds.tags) {
    const base = layer.tagStyle[tag.id] ?? { visible: true, opacity: 1 };
    const color = opt.tagColor[tag.id];
    const already = color !== undefined && sameColor(color, tag.color);
    if (color !== undefined && !already) tagColours += 1;
    tagStyle[tag.id] = color !== undefined && !already ? { ...base, color } : base;
  }
  next.tagStyle = tagStyle;
  if (tagColours > 0) seeded.push('tagStyle.color');
  if (Object.keys(opt.tagVisible).length > 0) seeded.push('tagStyle.visible');

  // The first `View[n]` block. SimNIBS writes exactly one, and a mesh's field range, colormap and
  // colour bar are per-view in Gmsh's model as they are per-layer in §4.4's.
  const view = opt.views[0];
  if (view !== undefined) {
    // `RangeType = 2` is Gmsh's "custom", and only then do `CustomMin` / `CustomMax` mean anything:
    // with RangeType 1 they are whatever the last save happened to leave behind.
    if (view.rangeType === 2 && view.customMin !== undefined && view.customMax !== undefined) {
      if (view.customMax > view.customMin) {
        next.scale = { kind: 'linear', lo: view.customMin, hi: view.customMax };
        seeded.push('scale');
      }
    }
    const colormap =
      view.colormapNumber !== undefined ? MSH_OPT_COLORMAPS[view.colormapNumber] : undefined;
    if (colormap !== undefined) {
      next.colormap = colormap;
      seeded.push('colormap');
    }
    if (view.showScale === true) {
      next.showColorbar = true;
      seeded.push('showColorbar');
    }
  }

  return seeded.length > 0
    ? { layer: next, seed: { file: `${ds.name}.opt`, seeded } }
    : { layer, seed: null };
}
