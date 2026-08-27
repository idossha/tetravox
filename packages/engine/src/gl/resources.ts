/**
 * Engine-private GPU resources — `docs/ARCHITECTURE.md` §4.5.
 *
 * Declared here and **not** in `scene/types.ts`, which is frozen and holds no GL objects. GL objects
 * live in an engine-private map keyed by `DatasetId`.
 */

import type { DatasetId } from '../scene/types';

export interface MeshGeometry {
  vao: WebGLVertexArrayObject;
  buffers: WebGLBuffer[];
  perTag: { tag: number; first: number; count: number }[];
  /**
   * `` `${datasetId}|${maskId ?? ''}|${generation}|${clipStateHash}` `` — `generation` per §6.5.2's
   * lifecycle rules, so a re-isolation to a numerically identical mask still invalidates cached
   * geometry.
   */
  cacheKey: string;
}

export interface GpuResources {
  /** One 3D texture per (dataset, selected 4D index). */
  volumeTexture?: WebGLTexture;
  /** N×1 RGBA8, label datasets only. */
  paletteTexture?: WebGLTexture;
  /** 2D R32F, mesh datasets — cap interpolation + de-indexed field lookup. */
  nodeFieldTexture?: WebGLTexture;
  indexed?: MeshGeometry;
  deindexed?: MeshGeometry;
  /** Double-buffered, grown by doubling (§7.4). */
  capBuffers?: [MeshGeometry, MeshGeometry];
}

export type GpuResourceMap = Map<DatasetId, GpuResources>;
