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
import type { BakedLut } from '../color/colormaps';
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
  // §7.4's cap VBO set, which names tag / owner / edgeMask as **buffers** rather than as the
  // textures the surface path fetches at `gl_VertexID / 3` — see {@link GpuStore.uploadCaps}.
  capInterpNodes: 5,
  capInterpT: 6,
  capTag: 7,
  capOwner: 8,
  capEdgeMask: 9,
} as const;

/** §7.4's default `edgeMask`: all three edges are real element edges. */
export const EDGE_MASK_ALL = 0b111;

/**
 * The `GpuStore` key of one mesh layer's cap VBO set: `${layerId}|caps`.
 *
 * Keyed by **layer**, not by dataset: `MeshLayer.clip` is per layer, so two layers over one mesh can
 * carry two different plane sets and two different cap buffers. (The `cut` they read is keyed by
 * `(datasetId, '3d-clip')` — §7.4's own key — so they share the worker round trip.)
 */
export function capKey(layerId: string): string {
  return `${layerId}|caps`;
}

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

/** Where one plane's cap triangles sit inside a {@link CapGeometry}'s buffers. */
export interface CapPlaneRange {
  /** Index into the layer's active clip planes — §7.4's cap rule disables exactly this one. */
  plane: number;
  firstVertex: number;
  vertexCount: number;
}

/** One of the two buffer sets §7.4's "double-buffered" cap upload alternates between. */
interface CapBufferSet {
  vao: VertexArray;
  buffers: Buffer[];
}

/**
 * §7.4's cap VBO set: *"pre-sized, double-buffered, written with `bufferSubData` after an orphaning
 * `bufferData(null)` — never a fresh sized `bufferData` per frame. Buffers grow by doubling and never
 * shrink during a drag."*
 *
 * Two sets, alternated per upload, so a `bufferSubData` never writes the store a still-in-flight draw
 * is reading; `Buffer.update` supplies the orphan and the doubling inside each one.
 */
export interface CapGeometry {
  /** The set holding the data of the last {@link GpuStore.uploadCaps}. */
  vao: VertexArray;
  vertexCount: number;
  triangleCount: number;
  planeRanges: CapPlaneRange[];
  /** The `CutSnapshot.generation` currently uploaded — the cache key against a stale re-upload. */
  generation: number;
  /** True once a node/element field or the tag index has been written at least once. */
  hasFields: boolean;
  /** Sum of every buffer's byte length, for §9.2's budget line. */
  bytes: number;
}

interface CapEntry extends CapGeometry {
  sets: [CapBufferSet, CapBufferSet];
  next: 0 | 1;
  /** CPU expansion arenas: per-triangle cut values broadcast to the triangle's three vertices. */
  tagArena: Int32Array;
  ownerArena: Uint32Array;
  edgeArena: Uint8Array;
}

/**
 * The three per-triangle cut arrays, broadcast to per-vertex.
 *
 * **Why this copy exists, and why it is not the geometry §5 rule 7 forbids.** `CutPayload` carries
 * `tag` / `ownerTet` / `edgeMask` once per *triangle*; §7.4's cap VBO set and §7.2.3 (*"cut caps …
 * are already de-indexed and carry `ownerElm`"*) both name them as per-*vertex* attributes, and the
 * frozen protocol has no per-vertex form. §7.4's own budget settles which reading is meant: *"~6 MB
 * per buffer set for ernie (62,966 cap triangles)"* is 188,898 vertices × (12 + 8 + 4 + 4 + 4 + 1) =
 * 5.95 MB — the per-**vertex** total, to three digits. So the broadcast is what the contract sized
 * for. It builds no geometry: no de-indexing (the cut arrives de-indexed), no normals (a uniform),
 * no new vertices — three integer writes per existing vertex, measured in
 * `docs/benchmarks/phase2-mesh.md`.
 */
function expandCapAttributes(
  snap: {
    tag: Int32Array;
    ownerTet: Uint32Array;
    edgeMask: Uint8Array;
    triangleCount: number;
  },
  denseTagOf: ReadonlyMap<number, number>,
  tagOut: Int32Array,
  ownerOut: Uint32Array,
  edgeOut: Uint8Array
): void {
  const n = snap.triangleCount;
  for (let t = 0, v = 0; t < n; t += 1) {
    const dense = denseTagOf.get(snap.tag[t] ?? 0) ?? 0;
    const owner = snap.ownerTet[t] ?? 0;
    const mask = snap.edgeMask[t] ?? EDGE_MASK_ALL;
    tagOut[v] = dense;
    ownerOut[v] = owner;
    edgeOut[v] = mask;
    v += 1;
    tagOut[v] = dense;
    ownerOut[v] = owner;
    edgeOut[v] = mask;
    v += 1;
    tagOut[v] = dense;
    ownerOut[v] = owner;
    edgeOut[v] = mask;
    v += 1;
  }
}

/** Grow by doubling, never shrink — §7.4's cap rule, on the CPU side of the upload. */
function growArena<T extends Int32Array | Uint32Array | Uint8Array>(
  current: T,
  need: number,
  make: (n: number) => T
): T {
  if (current.length >= need) return current;
  let cap = Math.max(1, current.length);
  while (cap < need) cap *= 2;
  return make(cap);
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

/**
 * **Appended by E-SLICE (Phase 2).** One layer's label styling, as two `N × 1 RGBA8` textures.
 *
 * * `palette` — the §7.3 dense-index palette with `visibleLabels`, `labelOpacity` and any per-label
 *   recolour already folded in. Hiding a label is `A = 0`; recolouring it rewrites `RGB`. Nothing in
 *   the shader branches on either, which is what makes R5's "every other pixel byte-identical"
 *   assertion true by construction.
 * * `attrs` — `R = 255` when the label is **selected**, for R5's outline emphasis. A second texture
 *   rather than two more rows of the first, because `gl/texture.ts`'s `createLut` builds `N × 1` and
 *   that file is not E-SLICE's to widen.
 *
 * Keyed **per layer**, not per dataset: `visibleLabels` and `labelOpacity` are `VolumeLayer` fields
 * (§4.4), so two layers on one atlas must be able to hide different regions. Label *colour* is not —
 * it lives in the dataset's `LabelTable`, which is what a LUT file holds and what A-SHELL exports.
 */
export interface LabelStyleGpu {
  palette: WebGLTexture;
  attrs: WebGLTexture;
  size: number;
}

/**
 * The `GpuStore` key of one layer's label styling: `${layerId}|${volumeIndex}`.
 *
 * The 4D index is in the key because a 4D label volume's dense index remap is per frame
 * (`VolumeFrameT.labelIds`), so frame 1's palette is not frame 0's.
 */
export function labelStyleKey(layerId: string, volumeIndex: number): string {
  return `${layerId}|${volumeIndex}`;
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
  /** E-SLICE (Phase 2): per-layer label styling, keyed by `labelStyleKey`. */
  readonly #labelStyles = new Map<string, LabelStyleGpu>();
  /** §7.4's node / element field tables and label palettes, keyed like the surfaces. */
  readonly #tables = new Map<string, { texture: WebGLTexture; width: number; size: number }>();
  /** §7.4's cap VBO sets, keyed by `capKey(layerId)`. */
  readonly #caps = new Map<string, CapEntry>();
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

  // ---------------------------------------------------------------------------------------------
  // §7.4's cap VBO set
  // ---------------------------------------------------------------------------------------------

  caps(key: string): CapGeometry | undefined {
    return this.#caps.get(key);
  }

  /**
   * Write one {@link CutSnapshot} into `key`'s cap buffers and return what to draw.
   *
   * Re-uploading the same `generation` is a no-op, so a re-render during a drag does not re-write
   * buffers that have not changed.
   *
   * `denseTagOf` maps a **tet tag** to its index in the layer's tag palette (`layers/mesh.ts`), which
   * is what makes `tagStyle` recolour / hide on a cap a palette re-upload rather than a re-cut (R5).
   */
  uploadCaps(
    key: string,
    snap: {
      generation: number;
      positions: Float32Array;
      interpNodes: Uint32Array;
      interpT: Float32Array;
      ownerTet: Uint32Array;
      tag: Int32Array;
      edgeMask: Uint8Array;
      planeRanges: readonly { plane: number; firstVertex: number; vertexCount: number }[];
      vertexCount: number;
      triangleCount: number;
    },
    denseTagOf: ReadonlyMap<number, number>
  ): CapGeometry {
    let entry = this.#caps.get(key);
    if (entry === undefined) {
      entry = {
        vao: null as never,
        vertexCount: 0,
        triangleCount: 0,
        planeRanges: [],
        generation: -1,
        hasFields: false,
        bytes: 0,
        sets: [this.#newCapSet(), this.#newCapSet()],
        next: 0,
        tagArena: new Int32Array(0),
        ownerArena: new Uint32Array(0),
        edgeArena: new Uint8Array(0),
      };
      entry.vao = entry.sets[0].vao;
      this.#caps.set(key, entry);
    }
    if (entry.generation === snap.generation && entry.vertexCount === snap.vertexCount)
      return entry;

    const n = snap.vertexCount;
    entry.tagArena = growArena(entry.tagArena, n, (m) => new Int32Array(m));
    entry.ownerArena = growArena(entry.ownerArena, n, (m) => new Uint32Array(m));
    entry.edgeArena = growArena(entry.edgeArena, n, (m) => new Uint8Array(m));
    expandCapAttributes(snap, denseTagOf, entry.tagArena, entry.ownerArena, entry.edgeArena);

    // Alternate sets: a `bufferSubData` never lands on the store the previous frame's draw is
    // still reading.
    const set = entry.sets[entry.next];
    entry.next = entry.next === 0 ? 1 : 0;
    const [pos, interpNodes, interpT, tag, owner, edge] = set.buffers as [
      Buffer,
      Buffer,
      Buffer,
      Buffer,
      Buffer,
      Buffer,
    ];
    pos.update(snap.positions.subarray(0, n * 3));
    interpNodes.update(snap.interpNodes.subarray(0, n * 2));
    interpT.update(snap.interpT.subarray(0, n));
    tag.update(entry.tagArena.subarray(0, n));
    owner.update(entry.ownerArena.subarray(0, n));
    edge.update(entry.edgeArena.subarray(0, n));

    entry.vao = set.vao;
    entry.vertexCount = n;
    entry.triangleCount = snap.triangleCount;
    entry.planeRanges = snap.planeRanges.map((r) => ({
      plane: r.plane,
      firstVertex: r.firstVertex,
      vertexCount: r.vertexCount,
    }));
    entry.generation = snap.generation;
    entry.hasFields = true;
    entry.bytes = n * (12 + 8 + 4 + 4 + 4 + 1);
    return entry;
  }

  /** Drop one layer's cap buffers — `removeLayer`, or a layer that stopped clipping. */
  dropCaps(key: string): void {
    const entry = this.#caps.get(key);
    if (entry === undefined) return;
    for (const set of entry.sets) {
      set.vao.dispose();
      for (const b of set.buffers) b.dispose();
    }
    this.#caps.delete(key);
  }

  /** One set of the §7.4 cap VBOs, with the attribute layout `shaders/mesh.ts`'s `TVX_CAP` reads. */
  #newCapSet(): CapBufferSet {
    const gl = this.#gl;
    const vao = new VertexArray(gl);
    const pos = new Buffer(gl, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
    const interpNodes = new Buffer(gl, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
    const interpT = new Buffer(gl, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
    const tag = new Buffer(gl, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
    const owner = new Buffer(gl, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
    const edge = new Buffer(gl, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
    vao.attrib(MESH_ATTR.position, pos, 3, gl.FLOAT);
    vao.attribI(MESH_ATTR.capInterpNodes, interpNodes, 2, gl.UNSIGNED_INT);
    vao.attrib(MESH_ATTR.capInterpT, interpT, 1, gl.FLOAT);
    vao.attribI(MESH_ATTR.capTag, tag, 1, gl.INT);
    vao.attribI(MESH_ATTR.capOwner, owner, 1, gl.UNSIGNED_INT);
    vao.attribI(MESH_ATTR.capEdgeMask, edge, 1, gl.UNSIGNED_BYTE);
    VertexArray.unbind(gl);
    return { vao, buffers: [pos, interpNodes, interpT, tag, owner, edge] };
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

  /**
   * Drop **one** surface variant by key.
   *
   * §7.4: "Isolation or clip changes invalidate both variants." The isolated geometry lands under a
   * different `surfaceKey` (the mask id is part of it), so the *old* mask's variants have to go one
   * key at a time — `dropSurfaces(datasetId)` would take another layer's geometry with them.
   */
  dropSurface(key: string): void {
    const g = this.#surfaces.get(key);
    if (g === undefined) return;
    g.vao.dispose();
    for (const b of g.buffers) b.dispose();
    if (g.ownerTexture !== null) this.#gl.deleteTexture(g.ownerTexture);
    if (g.edgeMaskTexture !== null) this.#gl.deleteTexture(g.edgeMaskTexture);
    this.#surfaces.delete(key);
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
  lut(scale: Scale, colormap: string, negative?: string): { texture: WebGLTexture } & BakedLut {
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
    // The whole bake comes back, not just `(lo, hi)`: `clipMax` is the `truncate` discard a LUT
    // cannot express (§4.2), and `rgba` is the strip the colour bar draws (§8) — both are functions
    // of exactly these three inputs, so re-deriving them at the call site would be a second bake.
    return { texture: tex, ...baked };
  }

  // -------------------------------------------------------------------------------------------
  // E-SLICE (Phase 2): per-layer label styling, and the 4D frame path.
  // -------------------------------------------------------------------------------------------

  /** One layer's label palette + selection table, or `undefined` while it is unstyled. */
  labelStyle(key: string): LabelStyleGpu | undefined {
    return this.#labelStyles.get(key);
  }

  /**
   * Upload (or re-upload) one layer's label styling.
   *
   * Re-upload replaces the texture rather than `texSubImage`-ing it, because `palette` changes size
   * when the 4D frame changes the dense index remap, and one path that always works beats two that
   * are each right half the time. An `N × 1 RGBA8` pair is at most 64 kB for the 65535-label cap.
   */
  uploadLabelStyle(key: string, palette: Uint8Array, attrs: Uint8Array): LabelStyleGpu {
    this.dropLabelStyle(key);
    const style: LabelStyleGpu = {
      palette: createLut(this.#gl, palette),
      attrs: createLut(this.#gl, attrs),
      size: palette.length / 4,
    };
    this.#labelStyles.set(key, style);
    return style;
  }

  /** Drop one layer's label styling. */
  dropLabelStyle(key: string): void {
    const existing = this.#labelStyles.get(key);
    if (existing === undefined) return;
    this.#gl.deleteTexture(existing.palette);
    this.#gl.deleteTexture(existing.attrs);
    this.#labelStyles.delete(key);
  }

  /** Drop every frame's label styling for one layer (`dispose`, `removeLayer`). */
  dropLabelStyles(layerId: string): void {
    for (const k of [...this.#labelStyles.keys()]) {
      if (k.startsWith(`${layerId}|`)) this.dropLabelStyle(k);
    }
  }

  /** Is this 4D frame already on the GPU? `volumeFrame` is only worth a round trip when it is not. */
  hasVolume(key: string): boolean {
    return this.#volumes.has(key);
  }

  dispose(): void {
    const gl = this.#gl;
    for (const s of this.#labelStyles.values()) {
      gl.deleteTexture(s.palette);
      gl.deleteTexture(s.attrs);
    }
    this.#labelStyles.clear();
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
    for (const entry of this.#caps.values()) {
      for (const set of entry.sets) {
        set.vao.dispose();
        for (const b of set.buffers) b.dispose();
      }
    }
    this.#caps.clear();
    if (this.#atlas !== null) gl.deleteTexture(this.#atlas);
    this.#atlas = null;
  }
}
