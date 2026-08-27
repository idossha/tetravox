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
import type {
  Aabb,
  ColormapName,
  DatasetId,
  Scale,
  vec3,
  VolumeDataset,
  VolumeLayer,
} from '../scene/types';
import { isColormapName } from '../color/colormaps';
import { ATLAS_H, ATLAS_W, buildAtlas } from './font';

/**
 * The `GpuStore` key of one 4D frame of a volume: `${datasetId}|${volumeIndex}`.
 *
 * Stepping the 4D index (§7.5's `,`/`.`) therefore selects a **different texture** rather than
 * mutating one in place, which is what lets `volumeFrame` (§6.5.2) upload the new frame beside the
 * old one.
 */
export function volumeKey(layer: Pick<VolumeLayer, 'datasetId' | 'volumeIndex'>): string {
  return `${layer.datasetId}|${layer.volumeIndex}`;
}

/**
 * The `GpuStore` key of one surface variant: `${datasetId}|${variant}|${maskId ?? ''}`.
 *
 * §7.4's cache key is `(dataset, maskId, clip state)`; the clip state joins in Phase 2, when a clip
 * change has to invalidate both variants.
 */
export function surfaceKey(
  datasetId: string,
  variant: 'indexed' | 'deindexed',
  maskId?: number
): string {
  return `${datasetId}|${variant}|${maskId ?? ''}`;
}

/**
 * The §7.4 mesh program's attribute locations, shared by `shaders/mesh.ts` and this file.
 *
 * `corner` and `edgeMask` exist only on the de-indexed variant (barycentric needs de-indexed
 * geometry: under `drawElements` `gl_VertexID` is the index value, not the corner ordinal);
 * `nodeIndex` exists only on the indexed one, where §6.5.1 defines it.
 */
export const MESH_ATTR = {
  position: 0,
  normal: 1,
  corner: 2,
  /** 3 is deliberately unused: §7.4's `edgeMask` is per triangle and lives in a texture, not here. */
  nodeIndex: 4,
} as const;

/** §7.4's default `edgeMask`: all three edges are real element edges. */
export const EDGE_MASK_ALL = 0b111;

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
  /** The de-indexed variant's `corner` attribute is bound (§7.4's barycentric edges). */
  hasCorner: boolean;
  /**
   * `R8UI` `edgeMask`, one texel per triangle (§7.4's 3-bit mask), or `null` when the payload had
   * none — in which case §7.4's "when a whole draw is unmasked" case applies and the shader compiles
   * the mask away to a constant `vec3(1)`, which costs less than the constant *attribute* §7.4
   * suggests: no attribute slot, no buffer, no fetch.
   */
  edgeMaskTexture: WebGLTexture | null;
  edgeMaskWidth: number;
  /** The indexed variant's `nodeIndex` attribute is bound (the node-field / label table's index). */
  hasNodeIndex: boolean;
  /**
   * Per-tag world AABB, or `null` for a single-tag surface where the dataset's own bounds serve.
   *
   * §7.2 sorts the transparent phases "back-to-front by the depth of the sheet that phase draws",
   * and with per-tag sub-draws the sheet is one tag's. Every tag of a nested tissue complex shares
   * the dataset bbox to within its own thickness, so a per-tag box is what makes the sort mean
   * anything at all — scalp's box is the head, GM's is inside it.
   */
  tagBounds: Map<number, Aabb> | null;
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

/**
 * The width of every `texelFetch`ed mesh table (node field, element field, label palette index).
 *
 * 2048 keeps the tallest real case — ernie's 5,900,498 element values — at 2,881 rows, inside the
 * 8,192 `MAX_TEXTURE_SIZE` the golden authority reports `[SwS]`.
 */
const TABLE_TEX_WIDTH = 2048;

/**
 * Per-tag world AABBs, for §7.2's two-phase sort.
 *
 * This is a read-only scan of arrays that already exist, not a vertex-buffer expansion: nothing is
 * built, de-indexed or normal-generated here, so §5 rule 7 is untouched. It runs once per uploaded
 * surface — measured 21 ms for ernie's 1,177,213 triangles `[M2Max]`, against a mesh load of
 * several seconds — and is skipped entirely for a single-tag surface, where the dataset's own
 * bounds already order the draw.
 */
function tagBoundsOf(p: SurfacePayload): Map<number, Aabb> | null {
  if (p.perTag.length < 2) return null;
  const pos = p.positions;
  const idx = p.indices;
  const out = new Map<number, Aabb>();
  for (const range of p.perTag) {
    const min: vec3 = [Infinity, Infinity, Infinity];
    const max: vec3 = [-Infinity, -Infinity, -Infinity];
    const end = range.first + range.count;
    for (let i = range.first; i < end; i += 1) {
      const v = idx === undefined ? i : (idx[i] ?? 0);
      for (let c = 0; c < 3; c += 1) {
        const x = pos[v * 3 + c] ?? 0;
        if (x < (min[c] ?? Infinity)) min[c] = x;
        if (x > (max[c] ?? -Infinity)) max[c] = x;
      }
    }
    if (min[0] <= max[0]) out.set(range.tag, { min, max });
  }
  return out.size > 0 ? out : null;
}

export class GpuStore {
  readonly #gl: WebGL2RenderingContext;
  readonly #volumes = new Map<string, VolumeGpu>();
  readonly #surfaces = new Map<string, SurfaceGeometry>();
  readonly #luts = new Map<string, WebGLTexture>();
  /** §7.4's node / element field tables and label palettes, keyed like the surfaces. */
  readonly #tables = new Map<string, { texture: WebGLTexture; width: number; size: number }>();
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

    // §7.4's de-indexed attributes: `position` + `normal` + `corner` (1 byte) only. `edgeMask` joins
    // them when the payload has one; when it does not, the array stays disabled and the pass supplies
    // a constant `0b111`, so "the common case costs zero memory".
    let hasCorner = false;
    if (!indexed && p.corner !== undefined) {
      const corner = new Buffer(gl, gl.ARRAY_BUFFER);
      corner.set(p.corner);
      buffers.push(corner);
      vao.attribI(MESH_ATTR.corner, corner, 1, gl.UNSIGNED_BYTE);
      hasCorner = true;
    }

    // §6.5.1's `nodeIndex` is "indexed only: vertex -> INTERNAL 0-based node index, which is what the
    // §7.4 node-field texture is indexed by". It is what makes a node field and a `.annot` label
    // readable without a second geometry variant.
    let hasNodeIndex = false;
    if (indexed && p.nodeIndex !== undefined) {
      const nodes = new Buffer(gl, gl.ARRAY_BUFFER);
      nodes.set(p.nodeIndex);
      buffers.push(nodes);
      vao.attribI(MESH_ATTR.nodeIndex, nodes, 1, gl.UNSIGNED_INT);
      hasNodeIndex = true;
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

    // §7.4's 3-bit `edgeMask`, one value per **triangle**, read at `gl_VertexID / 3` like the owner
    // table. It is a texture rather than the vertex attribute §7.4 names because the payload is per
    // triangle and the attribute would be per vertex: expanding it here would be a vertex-buffer
    // expansion on the UI thread, which §5 rule 7 puts in the worker. See docs/DECISIONS.md.
    let edgeMaskTexture: WebGLTexture | null = null;
    let edgeMaskWidth = 0;
    if (!indexed && p.edgeMask !== undefined && p.edgeMask.length > 0) {
      const n = p.edgeMask.length;
      edgeMaskWidth = Math.min(OWNER_TEX_WIDTH, Math.max(1, n));
      const rows = Math.max(1, Math.ceil(n / edgeMaskWidth));
      const padded = new Uint8Array(edgeMaskWidth * rows).fill(EDGE_MASK_ALL);
      padded.set(p.edgeMask);
      const tex = gl.createTexture();
      if (tex === null) throw new Error('createTexture returned null');
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8UI, edgeMaskWidth, rows);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        edgeMaskWidth,
        rows,
        gl.RED_INTEGER,
        gl.UNSIGNED_BYTE,
        padded
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.bindTexture(gl.TEXTURE_2D, null);
      edgeMaskTexture = tex;
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
      hasCorner,
      edgeMaskTexture,
      edgeMaskWidth,
      hasNodeIndex,
      tagBounds: tagBoundsOf(p),
    };
    this.#surfaces.set(key, g);
    return g;
  }

  /**
   * A `texelFetch`-only `R32F` table — §7.4's node-field / element-field texture.
   *
   * The values arrived from the worker's `field` op as a transferable; nothing here rearranges them.
   * Cached on `key`, so switching which field or component is displayed is "a texture swap, always
   * free" (§7.4) once both have been fetched.
   */
  meshTable(key: string): { texture: WebGLTexture; width: number; size: number } | undefined {
    return this.#tables.get(key);
  }

  uploadMeshTable(
    key: string,
    values: Float32Array
  ): { texture: WebGLTexture; width: number; size: number } {
    const existing = this.#tables.get(key);
    if (existing !== undefined) return existing;
    const gl = this.#gl;
    const n = Math.max(1, values.length);
    const width = Math.min(TABLE_TEX_WIDTH, n);
    const rows = Math.ceil(n / width);
    const padded = new Float32Array(width * rows);
    padded.set(values);
    const tex = gl.createTexture();
    if (tex === null) throw new Error('createTexture returned null');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, width, rows);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, rows, gl.RED, gl.FLOAT, padded);
    // NEAREST always: this table is `texelFetch`ed by an integer row, never filtered, so it needs no
    // `OES_texture_float_linear` and can never blend two nodes' values (§7.1's invariant).
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    const entry = { texture: tex, width, size: values.length };
    this.#tables.set(key, entry);
    return entry;
  }

  /**
   * The §7.4 label palette: `N x 2 RGBA8`.
   *
   * Row 0 is each label's colour with its visibility already folded into alpha; row 1's red channel
   * is whether it is selected. R5's recolour / hide / solo / select are therefore one 8N-byte
   * re-upload with no geometry touched at all, which is why `key` carries the table's content and a
   * changed key replaces the texture.
   */
  meshPalette(key: string): { texture: WebGLTexture; width: number; size: number } | undefined {
    return this.#tables.get(key);
  }

  uploadMeshPalette(
    key: string,
    rgba: Uint8Array
  ): { texture: WebGLTexture; width: number; size: number } {
    const existing = this.#tables.get(key);
    if (existing !== undefined) return existing;
    const gl = this.#gl;
    const size = rgba.length / 8; // two rows of RGBA8 per label
    const tex = gl.createTexture();
    if (tex === null) throw new Error('createTexture returned null');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, size, 2);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, size, 2, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    const entry = { texture: tex, width: size, size };
    this.#tables.set(key, entry);
    return entry;
  }

  /** Drop one table by key — a recoloured palette replaces its predecessor rather than leaking it. */
  dropMeshTable(key: string): void {
    const t = this.#tables.get(key);
    if (t === undefined) return;
    this.#gl.deleteTexture(t.texture);
    this.#tables.delete(key);
  }

  /** Drop every field table and palette of one dataset. Keys are `${datasetId}|…` like the rest. */
  dropMeshTables(datasetId: DatasetId): void {
    for (const [k, t] of [...this.#tables]) {
      if (k.startsWith(`${datasetId}|`)) {
        this.#gl.deleteTexture(t.texture);
        this.#tables.delete(k);
      }
    }
  }

  dropSurfaces(datasetId: DatasetId): void {
    for (const [k, g] of [...this.#surfaces]) {
      if (k.startsWith(`${datasetId}|`)) {
        g.vao.dispose();
        for (const b of g.buffers) b.dispose();
        if (g.ownerTexture !== null) this.#gl.deleteTexture(g.ownerTexture);
        if (g.edgeMaskTexture !== null) this.#gl.deleteTexture(g.edgeMaskTexture);
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
      if (g.edgeMaskTexture !== null) gl.deleteTexture(g.edgeMaskTexture);
    }
    this.#surfaces.clear();
    for (const t of this.#luts.values()) gl.deleteTexture(t);
    this.#luts.clear();
    for (const t of this.#tables.values()) gl.deleteTexture(t.texture);
    this.#tables.clear();
    if (this.#atlas !== null) gl.deleteTexture(this.#atlas);
    this.#atlas = null;
  }
}
