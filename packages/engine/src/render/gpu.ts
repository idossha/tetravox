/**
 * Per-dataset GPU resources and their upload paths.
 *
 * Everything here consumes buffers that arrived from a dataset worker as transferables. **Nothing
 * in this file builds geometry**: no de-indexing, no normal generation, no vertex-buffer expansion —
 * §5 rule 7 puts all three in the worker, and the engine "never builds a vertex buffer
 * element-by-element". The one expansion the contract does allow the GPU to make is the per-face
 * lookup, which is a `texelFetch` at `gl_VertexID / 3` against {@link GpuStore.ownerTexture}
 * (§7.2.3, §7.4) rather than a per-vertex attribute.
 */

import type { SurfacePayload } from '@tetravox/protocol';
import { Buffer, VertexArray } from '../gl/buffer';
import { bytesPerVoxel, createAlpha2D, createLut, createTexture3D } from '../gl/texture';
import { bakeScale } from '../color/colormaps';
import type { ColormapName, DatasetId, Scale, VolumeDataset } from '../scene/types';
import { isColormapName } from '../color/colormaps';
import { ATLAS_H, ATLAS_W, buildAtlas } from './font';

export interface SurfaceGeometry {
  vao: VertexArray;
  buffers: Buffer[];
  triangleCount: number;
  vertexCount: number;
  perTag: { tag: number; first: number; count: number }[];
  indexed: boolean;
  /** `R32UI` `ownerElm`, one texel per triangle, for the pick pass. */
  ownerTexture: WebGLTexture | null;
  ownerWidth: number;
}

export interface VolumeGpu {
  texture: WebGLTexture;
  integer: boolean;
  /** LINEAR is legal on this format on this GPU (§6.1's payload, not a guess). */
  filterable: boolean;
  /** `CODE_FULL * payload.scale` — see `shaders.ts`'s header. */
  valueScale: number;
  valueOffset: number;
  palette: WebGLTexture | null;
  paletteSize: number;
  bytes: number;
}

/** `CODE_FULL` per §6.1: what GL's `[0,1]` read must be multiplied by to recover the stored code. */
function codeFull(format: VolumeDataset['gpu']['format']): number {
  switch (format) {
    case 'R8':
      return 255;
    case 'R16':
      return 65535;
    // Integer formats hand the shader the stored value directly; R32F stores physical units with
    // scale 1 / offset 0.
    case 'R8UI':
    case 'R16UI':
    case 'R16F':
    case 'R32F':
    case 'RGBA8':
      return 1;
  }
}

/** The largest 2D texture width used for the per-triangle owner table. */
const OWNER_TEX_WIDTH = 2048;

export class GpuStore {
  readonly #gl: WebGL2RenderingContext;
  readonly #volumes = new Map<string, VolumeGpu>();
  readonly #surfaces = new Map<string, SurfaceGeometry>();
  readonly #luts = new Map<string, WebGLTexture>();
  #atlas: WebGLTexture | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.#gl = gl;
  }

  /** The bitmap font atlas, uploaded once. */
  fontAtlas(): WebGLTexture {
    if (this.#atlas === null) {
      this.#atlas = createAlpha2D(this.#gl, ATLAS_W, ATLAS_H, buildAtlas());
    }
    return this.#atlas;
  }

  volume(key: string): VolumeGpu | undefined {
    return this.#volumes.get(key);
  }

  /**
   * Upload one 4D frame of a volume. `key` is `${datasetId}|${volumeIndex}`, so stepping the 4D
   * index (§7.5's `,`/`.`) replaces the texture rather than mutating one in place.
   */
  uploadVolume(
    key: string,
    ds: VolumeDataset,
    gpuBytes: ArrayBuffer,
    gpu: VolumeDataset['gpu'],
    linear: boolean,
    palette: Uint8Array | null
  ): VolumeGpu {
    const existing = this.#volumes.get(key);
    if (existing !== undefined) return existing;
    const { texture, fmt } = createTexture3D(this.#gl, {
      dims: ds.dims,
      format: gpu.format,
      bytes: gpuBytes,
      filterable: gpu.filterable,
      // §4.4: `interpolation` is forced to 'nearest' when the dataset is a label volume, and §7.2
      // forbids ever degrading it as a quality knob — it is a reading, not a rendering setting.
      linear: linear && !ds.isLabel,
      chunked: gpu.chunked,
    });
    const v: VolumeGpu = {
      texture,
      integer: fmt.integer,
      filterable: gpu.filterable && !fmt.integer,
      valueScale: codeFull(gpu.format) * gpu.scale,
      valueOffset: gpu.offset,
      palette: palette !== null ? createLut(this.#gl, palette) : null,
      paletteSize: palette !== null ? palette.length / 4 : 0,
      bytes: ds.dims[0] * ds.dims[1] * ds.dims[2] * bytesPerVoxel(gpu.format),
    };
    this.#volumes.set(key, v);
    return v;
  }

  /** Drop every frame of one dataset. */
  dropVolume(datasetId: DatasetId): void {
    for (const [k, v] of [...this.#volumes]) {
      if (k.startsWith(`${datasetId}|`)) {
        this.#gl.deleteTexture(v.texture);
        if (v.palette !== null) this.#gl.deleteTexture(v.palette);
        this.#volumes.delete(k);
      }
    }
  }

  surface(key: string): SurfaceGeometry | undefined {
    return this.#surfaces.get(key);
  }

  /**
   * Upload a `SurfacePayload` exactly as the worker produced it.
   *
   * `key` is `` `${datasetId}|${variant}|${maskId ?? ''}` `` — §7.4's cache key, minus the clip
   * state that Phase 2 adds.
   */
  uploadSurface(key: string, p: SurfacePayload): SurfaceGeometry {
    const existing = this.#surfaces.get(key);
    if (existing !== undefined) return existing;
    const gl = this.#gl;
    const vao = new VertexArray(gl);
    const buffers: Buffer[] = [];

    const pos = new Buffer(gl, gl.ARRAY_BUFFER);
    pos.set(p.positions);
    buffers.push(pos);
    vao.attrib(0, pos, 3, gl.FLOAT);

    const nrm = new Buffer(gl, gl.ARRAY_BUFFER);
    nrm.set(p.normals);
    buffers.push(nrm);
    vao.attrib(1, nrm, 3, gl.FLOAT);

    const indexed = p.variant === 'indexed' && p.indices !== undefined;
    if (indexed && p.indices !== undefined) {
      const idx = new Buffer(gl, gl.ELEMENT_ARRAY_BUFFER);
      idx.set(p.indices);
      buffers.push(idx);
      vao.elements(idx);
    }
    VertexArray.unbind(gl);

    // The per-triangle owner table, as an R32UI 2D texture (§7.2.3): one texel per triangle, read in
    // the pick vertex shader at `gl_VertexID / 3`. Only the de-indexed variant can be picked, since
    // an indexed draw has no per-corner identity.
    let ownerTexture: WebGLTexture | null = null;
    let ownerWidth = 0;
    if (!indexed) {
      const n = p.ownerElm.length;
      ownerWidth = Math.min(OWNER_TEX_WIDTH, Math.max(1, n));
      const rows = Math.max(1, Math.ceil(n / ownerWidth));
      const padded = new Uint32Array(ownerWidth * rows);
      padded.set(p.ownerElm);
      const tex = gl.createTexture();
      if (tex === null) throw new Error('createTexture returned null');
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32UI, ownerWidth, rows);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        ownerWidth,
        rows,
        gl.RED_INTEGER,
        gl.UNSIGNED_INT,
        padded
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.bindTexture(gl.TEXTURE_2D, null);
      ownerTexture = tex;
    }

    const g: SurfaceGeometry = {
      vao,
      buffers,
      triangleCount: p.ownerElm.length,
      vertexCount: p.positions.length / 3,
      perTag: p.perTag,
      indexed,
      ownerTexture,
      ownerWidth,
    };
    this.#surfaces.set(key, g);
    return g;
  }

  dropSurfaces(datasetId: DatasetId): void {
    for (const [k, g] of [...this.#surfaces]) {
      if (k.startsWith(`${datasetId}|`)) {
        g.vao.dispose();
        for (const b of g.buffers) b.dispose();
        if (g.ownerTexture !== null) this.#gl.deleteTexture(g.ownerTexture);
        this.#surfaces.delete(k);
      }
    }
  }

  /**
   * A baked colormap LUT, cached on the bake's inputs. §7.6: `kind:'heat'` "costs nothing extra in
   * the shader — it is a different bake", which is only true if the bake is memoised.
   */
  lut(
    scale: Scale,
    colormap: string,
    negative?: string
  ): { texture: WebGLTexture; lo: number; hi: number } {
    const name: ColormapName = isColormapName(colormap) ? colormap : 'gray';
    const neg: ColormapName =
      negative !== undefined && isColormapName(negative) ? negative : 'blue-cyan';
    const key = `${JSON.stringify(scale)}|${name}|${neg}`;
    let tex = this.#luts.get(key);
    const baked = bakeScale(scale, name, neg);
    if (tex === undefined) {
      tex = createLut(this.#gl, baked.rgba);
      this.#luts.set(key, tex);
    }
    return { texture: tex, lo: baked.lo, hi: baked.hi };
  }

  dispose(): void {
    const gl = this.#gl;
    for (const v of this.#volumes.values()) {
      gl.deleteTexture(v.texture);
      if (v.palette !== null) gl.deleteTexture(v.palette);
    }
    this.#volumes.clear();
    for (const g of this.#surfaces.values()) {
      g.vao.dispose();
      for (const b of g.buffers) b.dispose();
      if (g.ownerTexture !== null) gl.deleteTexture(g.ownerTexture);
    }
    this.#surfaces.clear();
    for (const t of this.#luts.values()) gl.deleteTexture(t);
    this.#luts.clear();
    if (this.#atlas !== null) gl.deleteTexture(this.#atlas);
    this.#atlas = null;
  }
}
