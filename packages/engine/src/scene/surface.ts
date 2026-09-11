/**
 * The surface layer's own module (2026-09-06, R5 of `docs/ARCHITECTURE.md` §4.4/§8):
 * its defaults and its **projection** onto the `MeshLayer` shape the triangle passes draw.
 *
 * §7.4 draws a surface with the same shaders as a tet mesh's boundary, and that is not going to
 * change — a second shader set for the same triangles would be the renderer rewrite the contract
 * refuses. What is different is the *model*: a surface has one colour source, no tissue tags, no
 * interior. So the renderer keeps reading a `MeshLayer`, and this file is the one place that says
 * how a `SurfaceLayer` reads as one. `layers/mesh.ts` imports nothing from here (R5's import wall);
 * `layers/surface.ts` wraps the mesh runtime around the projection.
 */

import type { Layer, MeshDataset, MeshLayer, SurfaceLayer } from './types';

export function isSurfaceLayer(layer: Layer): layer is SurfaceLayer {
  return layer.kind === 'surface';
}

/** `SurfaceLayer` → the `MeshLayer` the §7.4 passes draw. Pure; cached per layer object below. */
export function toMeshLayer(layer: SurfaceLayer): MeshLayer {
  const out: MeshLayer = {
    id: layer.id,
    datasetId: layer.datasetId,
    name: layer.name,
    visible: layer.visible,
    opacity: layer.opacity,
    pickable: layer.pickable,
    showColorbar: layer.showColorbar,
    ...(layer.module === undefined ? {} : { module: layer.module }),
    kind: 'mesh',
    colorMode:
      layer.colorMode === 'overlay' && layer.overlay !== undefined
        ? 'field'
        : layer.colorMode === 'annotation' && layer.annotation !== undefined
          ? 'label'
          : 'solid',
    solidColor: layer.solidColor,
    colormap: layer.colormap,
    scale: layer.scale,
    threshold: layer.threshold,
    tagStyle: {},
    edges: { surface: layer.edges, caps: false },
    edgeColor: layer.edgeColor,
    edgeWidthPx: layer.edgeWidthPx,
    flatShading: layer.flatShading,
    faceMode: layer.faceMode,
    clip: { planes: layer.clip.planes, caps: false, capColorMode: 'inherit' },
    contoursIn2D: layer.contoursIn2D,
    contourWidthPx: layer.contourWidthPx,
    fillIn2D: false,
    contourColor: layer.contourColor,
  };
  if (layer.colormapNegative !== undefined) out.colormapNegative = layer.colormapNegative;
  if (layer.overlay !== undefined) {
    out.field = { source: 'node', name: layer.overlay.name, component: layer.overlay.component };
  }
  if (layer.annotation !== undefined) out.label = { ...layer.annotation };
  return out;
}

const PROJECTIONS = new WeakMap<SurfaceLayer, MeshLayer>();

/**
 * The mesh-shaped view of any layer the triangle passes can draw: a mesh layer itself, or a
 * surface's projection (memoised per layer object, so a render frame that asks twice gets one
 * object and `JSON.stringify`-keyed caches stay stable). `null` for every other kind.
 */
export function meshView(layer: Layer): MeshLayer | null {
  if (layer.kind === 'mesh') return layer;
  if (layer.kind !== 'surface') return null;
  let m = PROJECTIONS.get(layer);
  if (m === undefined) {
    m = toMeshLayer(layer);
    PROJECTIONS.set(layer, m);
  }
  return m;
}

/** `lh` / `rh` from a FreeSurfer-style name, else null — what the layer row leads with. */
export function hemisphereOfName(name: string): 'lh' | 'rh' | null {
  const lower = name.toLowerCase();
  if (lower.startsWith('lh.')) return 'lh';
  if (lower.startsWith('rh.')) return 'rh';
  return null;
}

/** Which of a dataset's label tables a surface's annotation names, if it is still there. */
export function annotationTable(
  ds: MeshDataset,
  layer: SurfaceLayer
): SurfaceLayer['annotation'] | undefined {
  const a = layer.annotation;
  if (a === undefined) return undefined;
  const table = ds.labelTables?.[a.name];
  return table === undefined ? undefined : { ...a, table };
}
