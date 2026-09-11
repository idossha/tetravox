/**
 * Pure editors for §4.4's `SurfaceLayer` (2026-09-06, R4/R5 of
 * `docs/ARCHITECTURE.md` §4.4/§8): each takes the layer (and the dataset when
 * it needs a field or a table) to a `Partial<SurfaceLayer>` the controller hands to
 * `Engine.updateLayer`. Nothing here imports from the mesh editor: a surface has one colour source
 * at a time, and that is the whole grammar.
 */

import type { MeshDataset, MeshFieldInfo, SurfaceLayer, vec4 } from '@tetravox/engine';

/** The node fields a surface can show as an overlay: every `source: 'node'` field of its dataset. */
export function overlayFields(dataset: MeshDataset): MeshFieldInfo[] {
  return dataset.fields.filter((f) => f.source === 'node');
}

/** The annotations a surface can show: every label table the dataset holds, by name. */
export function annotationNames(dataset: MeshDataset): string[] {
  return Object.keys(dataset.labelTables ?? {});
}

/** Back to the solid colour; the overlay and annotation choices are kept for the way back. */
export function showSolid(): Partial<SurfaceLayer> {
  return { colorMode: 'solid', showColorbar: false };
}

/**
 * Show a per-vertex scalar. The scale is re-seeded from **that field's** statistics — a ramp still
 * pinned to the previous overlay's range is the same bug as an unset window — and the colour bar
 * comes on with it, since an overlay without its legend is a picture with no units.
 */
export function showOverlay(dataset: MeshDataset, name: string): Partial<SurfaceLayer> {
  const field = overlayFields(dataset).find((f) => f.name === name);
  if (field === undefined) return {};
  return {
    colorMode: 'overlay',
    showColorbar: true,
    overlay: { name: field.name, component: 'mag' },
    scale: { kind: 'linear', lo: field.stats.min, hi: field.stats.max },
  };
}

/** Show an atlas. The mode and width of a previously shown annotation are kept. */
export function showAnnotation(
  dataset: MeshDataset,
  layer: SurfaceLayer,
  name: string
): Partial<SurfaceLayer> {
  const table = dataset.labelTables?.[name];
  if (table === undefined) return {};
  const prev = layer.annotation;
  return {
    colorMode: 'annotation',
    showColorbar: false,
    annotation: {
      name,
      table,
      mode: prev?.mode ?? 'fill',
      outlineWidthPx: prev?.outlineWidthPx ?? 1,
    },
  };
}

export function setAnnotationMode(
  layer: SurfaceLayer,
  mode: NonNullable<SurfaceLayer['annotation']>['mode']
): Partial<SurfaceLayer> {
  if (layer.annotation === undefined) return {};
  return { annotation: { ...layer.annotation, mode } };
}

export function setAnnotationOutlineWidth(
  layer: SurfaceLayer,
  outlineWidthPx: number
): Partial<SurfaceLayer> {
  if (layer.annotation === undefined) return {};
  return { annotation: { ...layer.annotation, outlineWidthPx: Math.max(0.5, outlineWidthPx) } };
}

/** The overlay's colour range; a heat scale keeps its midpoint clamped inside the new bounds. */
export function setOverlayRange(
  layer: SurfaceLayer,
  lo: number,
  hi: number
): Partial<SurfaceLayer> {
  const s = layer.scale;
  if (s.kind === 'linear') return { scale: { kind: 'linear', lo, hi } };
  return { scale: { ...s, min: lo, max: hi, mid: Math.min(Math.max(s.mid, lo), hi) } };
}

export function setSolidColor(layer: SurfaceLayer, rgb: vec4): Partial<SurfaceLayer> {
  return { solidColor: [rgb[0], rgb[1], rgb[2], layer.solidColor[3]] };
}

export function setOutline(on: boolean): Partial<SurfaceLayer> {
  return { contoursIn2D: on };
}

export function setOutlineWidth(width: number): Partial<SurfaceLayer> {
  return { contourWidthPx: Math.min(8, Math.max(0.5, width)) };
}

export function setOutlineColor(color: vec4): Partial<SurfaceLayer> {
  return { contourColor: color };
}

export function setEdges(on: boolean): Partial<SurfaceLayer> {
  return { edges: on };
}

export function setFlatShading(on: boolean): Partial<SurfaceLayer> {
  return { flatShading: on };
}

export function setBackFaces(on: boolean): Partial<SurfaceLayer> {
  return { faceMode: on ? 'both' : 'cull' };
}

/** `lh` / `rh` from the dataset name, else null — what the layer row leads with (R1). */
export function hemisphereLabel(name: string): string | null {
  const lower = name.toLowerCase();
  if (lower.startsWith('lh.')) return 'lh';
  if (lower.startsWith('rh.')) return 'rh';
  return null;
}
