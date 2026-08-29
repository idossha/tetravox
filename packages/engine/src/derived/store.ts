/**
 * `DerivedStore` — every GPU resource the derived pass draws from, keyed the way it is consumed.
 *
 * Four kinds of thing live here, and each is keyed so that the expensive half is shared and the
 * cheap half is per-consumer:
 *
 * * **Pane cuts**, keyed `(layerId, viewId)`. One `CutSource` request per 2D pane, on that pane's
 *   `` `pane:${viewId}` `` key, so a sweep replaces its own pending request instead of queueing one
 *   per step (R4: "the 2D cut is served by the shared cut-manager (latest-wins), so sweeping never
 *   queues"). The uploaded geometry is a position VBO plus the two per-triangle tables `fillIn2D`
 *   reads and one instance buffer `contoursIn2D` draws.
 * * **Tag LUTs**, keyed `(layerId, tagStyle digest)` — one small RGBA8 table per layer, re-uploaded
 *   only when `tagStyle` changes.
 * * **Element field tables**, keyed `(datasetId, source, name, component)` — one `R32F` table per
 *   field, uploaded once and reused by every pane. §7.4: "switching which field or component is
 *   displayed is a **texture swap**, always free."
 * * **Surface position tables**, keyed `(datasetId)` — the de-indexed positions and `ownerElm` a
 *   surface `GlyphSpec` reads its origins from.
 * * **Centroid tables**, keyed `(datasetId, stride, visible tet tags)` — §6.5.2's `meshCentroids`,
 *   the origins a `GlyphSpec` with `origins: 'volume'` reads instead. Keyed by the *request* and not
 *   by the dataset because the op does the striding and the tag filtering, so a different visible
 *   set is a different table rather than a different draw.
 *
 * **Nothing in this file builds geometry.** Every array uploaded arrived from a dataset worker as a
 * transferable (§5 rule 7); the only allocations are the tag LUT (kilobytes) and the two
 * `Float32Array`s of shared template geometry, neither of which is dataset geometry.
 */

import { Buffer, VertexArray } from '../gl/buffer';
import { createTable, updateTable } from './tables';
import type { Table } from './tables';
import { buildTagLut } from './tag-lut';
import type { CutRequestOptions, CutSnapshot, CutSource } from './cut-source';
import { cutKeyForPane } from '../compute/cut-manager';
import { CONTOUR_STRIP } from '../shaders/contour';
import { POINT_QUAD } from '../shaders/points';
import { POINT_INSTANCE_FLOATS, packPoints } from '../layers/points';
import type { ComputeClient } from '@tetravox/wasm';
import type { ComponentSel, PlaneT, SurfacePayload } from '@tetravox/protocol';
import type {
  DatasetId,
  LayerId,
  MeshDataset,
  MeshLayer,
  PointsLayer,
  ViewId,
} from '../scene/types';

/** What one pane's cut has on the GPU right now. */
export interface PaneCutGeometry {
  /** Bumped by the source once per landed cut; the pass redraws whatever is current. */
  generation: number;
  vao: VertexArray;
  positions: Buffer;
  values: Buffer | null;
  vertexCount: number;
  triangleCount: number;
  tagTable: Table | null;
  ownerTable: Table | null;
  /**
   * `GlyphSpec.in2D`: the cut's positions as an `R32F` table, the same layout `surfaceTables`
   * gives the 3D surface path, so the glyph shader reads a cut triangle's centroid the way it reads
   * a surface triangle's. Built on first use by {@link DerivedStore.paneGlyphOrigins} from
   * {@link positionSource}, never per frame, and only for a layer that asks.
   */
  posTable: Table | null;
  /** The generation {@link posTable} was built from, so a new cut rebuilds it once. */
  posTableGeneration: number;
  /** The worker's own positions array of the current cut, kept for {@link posTable}. */
  positionSource: Float32Array | null;
  /** `contoursIn2D`: the per-instance segment endpoints, 6 floats each. */
  contourVao: VertexArray;
  contourStrip: Buffer;
  contourBuffer: Buffer;
  contourInstances: number;
  /** The array currently in {@link contourBuffer}, so an unchanged result is not re-uploaded. */
  contourSource: Float32Array | null;
  /** True when the segments came from the `contours` op rather than from the cut (triangle meshes). */
  contoursFromSurfaceOp: boolean;
}

interface TagLutEntry {
  table: Table;
  key: string;
  count: number;
}

interface FieldEntry {
  table: Table | null;
  pending: boolean;
}

/**
 * Everything `packPoints` reads besides the `points` array itself — the cache key for the instance
 * buffer's colours. Cheap to build (five scalars) and compared once per layer per frame.
 */
function pointColorKey(layer: PointsLayer): string {
  const c = layer.color;
  return [
    layer.valueMode ?? 'solid',
    layer.colormap ?? '',
    layer.valueRange?.lo ?? '',
    layer.valueRange?.hi ?? '',
    layer.radiusMm,
    c[0],
    c[1],
    c[2],
    c[3],
  ].join('|');
}

/** One points layer's instanced draw: the shared quad plus its per-instance buffer (§7.4). */
export interface PointInstances {
  vao: VertexArray;
  count: number;
}

interface PointEntry {
  vao: VertexArray;
  quad: Buffer;
  instances: Buffer;
  count: number;
  /** The `points` array on the GPU, so an unchanged layer is never re-uploaded. */
  source: PointsLayer['points'] | null;
  /**
   * The colour inputs that were baked into the instance buffer.
   *
   * `source` alone is not enough any more: `valueMode: 'value'` resolves each point's colour on
   * the CPU (`layers/points.ts`), so flipping the colormap changes the buffer while leaving the
   * `points` array identical — and the layer would have kept drawing in the old colours.
   */
  colorKey: string;
}

/** One points layer's `SL` segments: the shared strip plus the segment buffer (§7.0.6). */
interface LineEntry {
  vao: VertexArray;
  strip: Buffer;
  segments: Buffer;
  count: number;
  source: Float32Array | null;
}

interface SurfaceTables {
  positions: Table;
  owner: Table;
  tag: Table;
  triangleCount: number;
}

/**
 * The volumetric glyph origins — §6.5.2's `meshCentroids`, one point per surviving tet.
 *
 * There is no `tag` table here on purpose: the op filters by tag **before** it strides, so the rows
 * that came back are exactly the ones to draw. That is also why this is keyed by the request rather
 * than by the dataset — a different stride or a different visible-tag set is a different table, and
 * hiding a tissue must not leave its arrows on screen.
 */
export interface CentroidTables {
  positions: Table;
  owner: Table;
  /** Origins, i.e. `positions.count / 3` and `owner.count`. */
  count: number;
}

/**
 * The CPU side of a glyph draw's three inputs, kept **only** while
 * {@link DerivedStore.retainGlyphSources} is on (§11's real-data glyph test; see
 * `derived/glyph-readback.ts`).
 *
 * Off by default and off in the app: retaining ernie's GM centroids at stride 1 is 16 MB of
 * positions and 5 MB of owners that the renderer has no use for once they are texture rows.
 */
export interface GlyphSources {
  positions: Float32Array;
  owner: Uint32Array;
  /** Surface path only: the per-triangle `faceTag` the tag LUT is indexed with. */
  faceTag?: Uint32Array;
}

/** The `ComputeClient` slice this store needs, plus the mesh handle behind a dataset id. */
export interface DerivedTarget {
  client: ComputeClient;
  handle: number;
}

export class DerivedStore {
  /** §11's glyph readback; see {@link DerivedStore.retainGlyphSources}. */
  #retain = false;
  readonly #sources = new Map<string, GlyphSources | Float32Array>();

  readonly #gl: WebGL2RenderingContext;
  readonly #cuts: CutSource;
  readonly #target: (id: DatasetId) => DerivedTarget | undefined;
  readonly #requestRender: () => void;
  readonly #track: <T>(p: Promise<T>) => Promise<T>;

  readonly #panes = new Map<string, PaneCutGeometry>();
  readonly #paneKeys = new Map<string, { datasetId: DatasetId; cutKey: string }>();
  /**
   * One `onCut` subscription per cut key, so a landed cut **repaints the pane**.
   *
   * `paneCut` is pull-based — it requests during the draw and reads the snapshot back — which is
   * right for a pane whose plane is derived from the cursor, but it leaves nothing to notice that
   * the answer arrived. Without this a cross-section only appeared on the next frame something else
   * happened to dirty, and `whenSettled()` reported a settled scene whose cut was not on screen.
   * Keyed by `${datasetId} ${cutKey}` and not by layer, because the cut is the dataset's.
   */
  readonly #cutSubs = new Map<string, () => void>();
  readonly #tagLuts = new Map<LayerId, TagLutEntry>();
  readonly #fields = new Map<string, FieldEntry>();
  readonly #points = new Map<LayerId, PointEntry>();
  readonly #lines = new Map<LayerId, LineEntry>();
  readonly #surfaces = new Map<DatasetId, SurfaceTables>();
  readonly #surfacePending = new Set<DatasetId>();
  /** Volumetric glyph origins, keyed `(datasetId, stride, visible tet tags)`. */
  readonly #centroids = new Map<string, CentroidTables>();
  readonly #centroidPending = new Set<string>();
  /** Segments from the `contours` op, for triangle-only meshes, keyed `(datasetId, viewId)`. */
  readonly #surfaceContours = new Map<string, { plane: PlaneT; segments: Float32Array | null }>();

  constructor(
    gl: WebGL2RenderingContext,
    cuts: CutSource,
    target: (id: DatasetId) => DerivedTarget | undefined,
    requestRender: () => void,
    track: <T>(p: Promise<T>) => Promise<T>
  ) {
    this.#gl = gl;
    this.#cuts = cuts;
    this.#target = target;
    this.#requestRender = requestRender;
    this.#track = track;
  }

  // -------------------------------------------------------------------------------------------
  // Pane cuts
  // -------------------------------------------------------------------------------------------

  /**
   * Ask for this pane's cut and return whatever is currently on the GPU for it.
   *
   * Called once per (layer, pane) per frame. The request is idempotent on the plane — the source
   * drops a repeat of the identical plane set — so a re-render that changed nothing costs nothing.
   */
  paneCut(
    layer: MeshLayer,
    ds: MeshDataset,
    viewId: ViewId,
    plane: PlaneT,
    opts: CutRequestOptions
  ): PaneCutGeometry | null {
    const key = `${layer.id}|${viewId}`;
    // The key is E-MESH's to name (R4's per-consumer latest-wins), so it is derived, not spelt.
    const cutKey = cutKeyForPane(viewId);
    this.#paneKeys.set(key, { datasetId: ds.id, cutKey });
    if (ds.nTets > 0) {
      this.#subscribeCut(ds.id, cutKey);
      this.#cuts.requestCut(ds.id, cutKey, [plane], opts);
      const snap = this.#cuts.getCut(ds.id, cutKey);
      if (snap === null) return this.#panes.get(key) ?? null;
      const existing = this.#panes.get(key);
      if (existing !== undefined && existing.generation === snap.generation) return existing;
      return this.#uploadPaneCut(key, snap, layer);
    }
    // A triangle-only mesh (GIfTI, FreeSurfer, `.stl`) has no tets to cut, so its 2D representation
    // is the `contours` op — §6.3's `surface_contours` — and there is no fill.
    return this.#surfaceContourGeometry(key, ds, viewId, plane, opts.maskId ?? undefined);
  }

  /**
   * The GL objects one pane's cut lives in. Created once and rewritten in place thereafter — §7.4's
   * cap-upload rule: `bufferSubData` after an orphaning `bufferData(null)` ({@link Buffer.update}),
   * grown by doubling, never a fresh sized `bufferData` per frame.
   */
  #createPaneGeometry(key: string, contoursFromSurfaceOp: boolean): PaneCutGeometry {
    const gl = this.#gl;
    const vao = new VertexArray(gl);
    const positions = new Buffer(gl, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
    vao.attrib(0, positions, 3, gl.FLOAT);
    VertexArray.unbind(gl);

    const contourVao = new VertexArray(gl);
    const contourStrip = new Buffer(gl, gl.ARRAY_BUFFER);
    contourStrip.set(CONTOUR_STRIP);
    const contourBuffer = new Buffer(gl, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
    contourVao.attrib(0, contourStrip, 2, gl.FLOAT);
    // Two views of one buffer: `edgeSegments` / `boundarySegments` are 6 floats per segment, so the
    // endpoints are attribute 1 at offset 0 and attribute 2 at offset 12, both with divisor 1. No
    // CPU expansion, and the array is bound exactly as the worker produced it.
    contourVao.attrib(1, contourBuffer, 3, gl.FLOAT, false, 24, 0);
    contourVao.attrib(2, contourBuffer, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(contourVao.vao);
    gl.vertexAttribDivisor(1, 1);
    gl.vertexAttribDivisor(2, 1);
    VertexArray.unbind(gl);

    const g: PaneCutGeometry = {
      generation: -1,
      vao,
      positions,
      values: null,
      vertexCount: 0,
      triangleCount: 0,
      tagTable: null,
      ownerTable: null,
      posTable: null,
      posTableGeneration: -1,
      positionSource: null,
      contourVao,
      contourStrip,
      contourBuffer,
      contourInstances: 0,
      contourSource: null,
      contoursFromSurfaceOp,
    };
    this.#panes.set(key, g);
    return g;
  }

  #uploadPaneCut(key: string, snap: CutSnapshot, layer: MeshLayer): PaneCutGeometry {
    const gl = this.#gl;
    const g = this.#panes.get(key) ?? this.#createPaneGeometry(key, false);
    const tris = snap.tag.length;
    g.positions.update(snap.positions);
    g.positionSource = snap.positions;
    g.vertexCount = snap.positions.length / 3;
    g.triangleCount = tris;
    if (tris > 0) {
      g.tagTable = updateTable(gl, g.tagTable, 'u32', snap.tag, tris);
      g.ownerTable = updateTable(gl, g.ownerTable, 'u32', snap.ownerTet, tris);
    }

    // A node field arrives already interpolated, one value per vertex, so it is a plain attribute.
    const fieldName = layer.field?.source === 'node' ? layer.field.name : undefined;
    const nodeValues = fieldName === undefined ? undefined : snap.fields[fieldName];
    if (nodeValues !== undefined && nodeValues.length === g.vertexCount) {
      if (g.values === null) {
        g.values = new Buffer(gl, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
        g.vao.attrib(1, g.values, 1, gl.FLOAT);
        VertexArray.unbind(gl);
      }
      g.values.update(nodeValues);
    }

    const segs = snap.boundarySegments;
    g.contourBuffer.update(segs);
    g.contourInstances = Math.floor(segs.length / 6);
    g.contourSource = segs;
    g.contoursFromSurfaceOp = false;
    g.generation = snap.generation;
    return g;
  }

  /** The `contours` op path, for a mesh with no tets. Latest-wins on its own per-pane key. */
  #surfaceContourGeometry(
    key: string,
    ds: MeshDataset,
    viewId: ViewId,
    plane: PlaneT,
    maskId: number | undefined
  ): PaneCutGeometry | null {
    const ck = `${ds.id}|${viewId}`;
    const state = this.#surfaceContours.get(ck);
    const same =
      state !== undefined &&
      state.plane.offset === plane.offset &&
      state.plane.normal[0] === plane.normal[0] &&
      state.plane.normal[1] === plane.normal[1] &&
      state.plane.normal[2] === plane.normal[2];
    if (!same) {
      this.#surfaceContours.set(ck, { plane, segments: state?.segments ?? null });
      const target = this.#target(ds.id);
      if (target !== undefined) {
        void this.#track(
          target.client.call(`contours:${ds.id}:${viewId}`, 'contours', {
            handle: target.handle,
            plane,
            maskId,
          })
        )
          .then((res) => {
            const now = this.#surfaceContours.get(ck);
            if (now === undefined || now.plane !== plane) return;
            now.segments = res.segments;
            this.#requestRender();
          })
          .catch(() => {
            /* superseded or cancelled: not an error under latest-wins */
          });
      }
    }
    const segments = this.#surfaceContours.get(ck)?.segments ?? null;
    if (segments === null) return this.#panes.get(key) ?? null;
    const g = this.#panes.get(key) ?? this.#createPaneGeometry(key, true);
    if (g.contourSource !== segments) {
      g.contourBuffer.update(segments);
      g.contourInstances = Math.floor(segments.length / 6);
      g.contourSource = segments;
      g.contoursFromSurfaceOp = true;
    }
    return g;
  }

  /**
   * The cut's positions as a table for `GlyphSpec.in2D` (`render/passes/derived.ts`), or `null`
   * while the pane has no cut. Uploaded once per landed cut and only when asked, so a layer without
   * 2D glyphs never pays for it.
   */
  paneGlyphOrigins(layerId: LayerId, viewId: ViewId): Table | null {
    const g = this.#panes.get(`${layerId}|${viewId}`);
    if (g === undefined || g.positionSource === null || g.triangleCount === 0) return null;
    if (g.posTable === null || g.posTableGeneration !== g.generation) {
      g.posTable = updateTable(
        this.#gl,
        g.posTable,
        'f32',
        g.positionSource,
        g.positionSource.length
      );
      g.posTableGeneration = g.generation;
    }
    return g.posTable;
  }

  /**
   * The contour segments **currently on the GPU** for one (layer, pane) — the ones the last frame
   * drew (§7.4's contour pick, directed task 12).
   *
   * Read-only and pull-only: it never requests anything, so asking on a click cannot start a cut,
   * and a pane that has not drawn yet answers `null` rather than a stale array from another plane.
   * The array is the worker's own, held by `#uploadPaneCut` / `#surfaceContourGeometry` as
   * `contourSource` for exactly this identity comparison, so this costs no copy.
   */
  paneContourSegments(layerId: LayerId, viewId: ViewId): Float32Array | null {
    const g = this.#panes.get(`${layerId}|${viewId}`);
    if (g === undefined || g.contourInstances === 0) return null;
    return g.contourSource;
  }

  // -------------------------------------------------------------------------------------------
  // Tag LUT
  // -------------------------------------------------------------------------------------------

  tagLut(layer: MeshLayer, ds: MeshDataset): { table: Table; count: number } {
    const built = buildTagLut(layer, ds);
    const existing = this.#tagLuts.get(layer.id);
    if (existing !== undefined && existing.key === built.key) {
      return { table: existing.table, count: existing.count };
    }
    // Two blocks of `count` texels: colour + alpha, then the per-tag paint flag (`tag-lut.ts`).
    const table = updateTable(
      this.#gl,
      existing?.table ?? null,
      'rgba8',
      built.rgba,
      Math.max(1, built.count) * 2
    );
    const entry: TagLutEntry = { table, key: built.key, count: Math.max(1, built.count) };
    this.#tagLuts.set(layer.id, entry);
    return { table, count: entry.count };
  }

  // -------------------------------------------------------------------------------------------
  // Points
  // -------------------------------------------------------------------------------------------

  /**
   * The instance buffer of one points layer, uploaded on first use and whenever `points` is
   * replaced. Eight floats per point (`derived`/`layers/points.ts`), so a 256-electrode net is
   * 8 KB — the reason a points layer needs no worker at all.
   */
  pointInstances(layer: PointsLayer): PointInstances | null {
    const gl = this.#gl;
    let e = this.#points.get(layer.id);
    if (e === undefined) {
      const vao = new VertexArray(gl);
      const quad = new Buffer(gl, gl.ARRAY_BUFFER);
      quad.set(POINT_QUAD);
      const instances = new Buffer(gl, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
      const stride = POINT_INSTANCE_FLOATS * 4;
      vao.attrib(0, quad, 2, gl.FLOAT);
      vao.attrib(1, instances, 3, gl.FLOAT, false, stride, 0);
      vao.attrib(2, instances, 4, gl.FLOAT, false, stride, 12);
      vao.attrib(3, instances, 1, gl.FLOAT, false, stride, 28);
      gl.bindVertexArray(vao.vao);
      gl.vertexAttribDivisor(1, 1);
      gl.vertexAttribDivisor(2, 1);
      gl.vertexAttribDivisor(3, 1);
      VertexArray.unbind(gl);
      e = { vao, quad, instances, count: 0, source: null, colorKey: '' };
      this.#points.set(layer.id, e);
    }
    const colorKey = pointColorKey(layer);
    if (e.source !== layer.points || e.colorKey !== colorKey) {
      e.instances.update(packPoints(layer));
      e.count = layer.points.length;
      e.source = layer.points;
      e.colorKey = colorKey;
    }
    return e.count > 0 ? { vao: e.vao, count: e.count } : null;
  }

  /**
   * The `SL` segments of a points layer, as a contour-shaped instanced VAO (task 6).
   *
   * Same packing and the same two-views-of-one-buffer trick as a cut's `boundarySegments` — 6
   * floats per segment, attributes 1 and 2 at offsets 0 and 12 with divisor 1 — so the segments
   * draw through the §7.0.6 screen-space quad expansion and get a **constant screen width** at
   * every zoom, exactly like a 2D contour. `gl.lineWidth()` is a no-op (`[1,1]` `[M2Max]`).
   */
  lineSegments(layer: PointsLayer): PointInstances | null {
    const gl = this.#gl;
    const source = layer.lineSegments;
    if (source === undefined || source.length < 6) return null;
    let e = this.#lines.get(layer.id);
    if (e === undefined) {
      const vao = new VertexArray(gl);
      const strip = new Buffer(gl, gl.ARRAY_BUFFER);
      strip.set(CONTOUR_STRIP);
      const segments = new Buffer(gl, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
      vao.attrib(0, strip, 2, gl.FLOAT);
      vao.attrib(1, segments, 3, gl.FLOAT, false, 24, 0);
      vao.attrib(2, segments, 3, gl.FLOAT, false, 24, 12);
      gl.bindVertexArray(vao.vao);
      gl.vertexAttribDivisor(1, 1);
      gl.vertexAttribDivisor(2, 1);
      VertexArray.unbind(gl);
      e = { vao, strip, segments, count: 0, source: null };
      this.#lines.set(layer.id, e);
    }
    if (e.source !== source) {
      e.segments.update(source);
      e.count = Math.floor(source.length / 6);
      e.source = source;
    }
    return e.count > 0 ? { vao: e.vao, count: e.count } : null;
  }

  // -------------------------------------------------------------------------------------------
  // Element fields
  // -------------------------------------------------------------------------------------------

  /**
   * The `R32F` table of one field's values, or `null` while the `field` op is in flight.
   *
   * Uploaded once per (dataset, field, component) and shared by every pane, which is what §7.4 means
   * by a field switch being "a texture swap, always free".
   */
  /**
   * Keep the arrays behind the glyph tables so a test can read back what was drawn (§11).
   *
   * Test-only, and it changes nothing about the draw: the tables are uploaded from the same arrays
   * either way. Turn it on **before** the ops are requested — an already-cached table has no array
   * to hand back, and the readback returns `null` rather than guessing.
   */
  retainGlyphSources(on: boolean): void {
    this.#retain = on;
    if (!on) this.#sources.clear();
  }

  /** The retained arrays for one key, or `null`. Keys are the private ones below. */
  glyphSources(key: string): GlyphSources | Float32Array | null {
    return this.#sources.get(key) ?? null;
  }

  /** The `meshCentroids` key {@link DerivedStore.centroidTables} caches under. */
  static centroidKey(ds: MeshDataset, stride: number, tags: readonly number[]): string {
    return `${ds.id}|${stride}|${[...tags].sort((a, b) => a - b).join(',')}`;
  }

  /** The `field` key {@link DerivedStore.fieldTable} caches under. */
  static fieldKey(
    ds: MeshDataset,
    source: 'node' | 'elm',
    name: string,
    component: ComponentSel
  ): string {
    return `${ds.id}|${source}|${name}|${String(component)}`;
  }

  fieldTable(
    ds: MeshDataset,
    source: 'node' | 'elm',
    name: string,
    component: ComponentSel
  ): Table | null {
    const key = `${ds.id}|${source}|${name}|${String(component)}`;
    const entry = this.#fields.get(key);
    if (entry !== undefined) return entry.table;
    const target = this.#target(ds.id);
    if (target === undefined) return null;
    const fresh: FieldEntry = { table: null, pending: true };
    this.#fields.set(key, fresh);
    void this.#track(
      target.client.call(`field:${key}`, 'field', {
        handle: target.handle,
        source,
        name,
        component,
      })
    )
      .then((res) => {
        if (this.#retain) this.#sources.set(key, res.values);
        fresh.table = createTable(this.#gl, 'f32', res.values, res.values.length);
        fresh.pending = false;
        this.#requestRender();
      })
      .catch(() => {
        this.#fields.delete(key);
      });
    return null;
  }

  // -------------------------------------------------------------------------------------------
  // Surface tables (glyph origins)
  // -------------------------------------------------------------------------------------------

  /**
   * The de-indexed surface as three tables — positions, `ownerElm`, `faceTag`.
   *
   * §7.4 puts glyph origins on the surface (see `docs/DECISIONS.md`, "glyph origins"), and a
   * de-indexed `SurfacePayload` already carries every one of them. Requested lazily, once.
   */
  surfaceTables(ds: MeshDataset): SurfaceTables | null {
    const have = this.#surfaces.get(ds.id);
    if (have !== undefined) return have;
    if (this.#surfacePending.has(ds.id)) return null;
    const target = this.#target(ds.id);
    if (target === undefined) return null;
    this.#surfacePending.add(ds.id);
    const op = ds.hasTris ? 'surface' : 'boundary';
    void this.#track(
      target.client.call(`glyphgeom:${ds.id}`, op, {
        handle: target.handle,
        variant: 'deindexed',
      })
    )
      .then((payload: SurfacePayload) => {
        const gl = this.#gl;
        if (this.#retain) {
          this.#sources.set(`surface|${ds.id}`, {
            positions: payload.positions,
            owner: new Uint32Array(
              payload.ownerElm.buffer,
              payload.ownerElm.byteOffset,
              payload.ownerElm.length
            ),
            faceTag: new Uint32Array(
              payload.faceTag.buffer,
              payload.faceTag.byteOffset,
              payload.faceTag.length
            ),
          });
        }
        this.#surfaces.set(ds.id, {
          positions: createTable(gl, 'f32', payload.positions, payload.positions.length),
          owner: createTable(gl, 'u32', payload.ownerElm, payload.ownerElm.length),
          tag: createTable(gl, 'u32', payload.faceTag, payload.faceTag.length),
          triangleCount: payload.ownerElm.length,
        });
        this.#surfacePending.delete(ds.id);
        this.#requestRender();
      })
      .catch(() => {
        this.#surfacePending.delete(ds.id);
      });
    return null;
  }

  /**
   * The volumetric glyph origins for one request — §6.5.2's `meshCentroids`, uploaded as two tables.
   *
   * `null` while the op is in flight, exactly like {@link DerivedStore.surfaceTables}; the pass skips
   * the draw and the `.then` marks the frame dirty. `stride` and `tags` are the op's own arguments,
   * not a post-filter: §7.4 restricts origins "to visible tags", and doing it in the worker is what
   * keeps a 4,722,625-tet mesh off the wire (ernie at stride 64 is 73,792 origins, 39 ms → 7.3 ms
   * `[M2Max]`, recorded in `docs/DECISIONS.md`).
   *
   * `tags` is sorted into the key so that two spellings of the same visible set share one table.
   */
  centroidTables(ds: MeshDataset, stride: number, tags: readonly number[]): CentroidTables | null {
    const sorted = [...tags].sort((a, b) => a - b);
    const key = `${ds.id}|${stride}|${sorted.join(',')}`;
    const have = this.#centroids.get(key);
    if (have !== undefined) return have;
    if (this.#centroidPending.has(key)) return null;
    const target = this.#target(ds.id);
    if (target === undefined) return null;
    this.#centroidPending.add(key);
    void this.#track(
      target.client.meshCentroids(`glyphorigins:${key}`, {
        handle: target.handle,
        stride,
        // An empty list would be "no tags", not "every tag" — omit it instead.
        ...(sorted.length > 0 ? { tags: sorted } : {}),
      })
    )
      .then((payload) => {
        const gl = this.#gl;
        const count = payload.ownerTet.length;
        if (this.#retain) {
          this.#sources.set(key, { positions: payload.positions, owner: payload.ownerTet });
        }
        this.#centroids.set(key, {
          positions: createTable(gl, 'f32', payload.positions, payload.positions.length),
          owner: createTable(gl, 'u32', payload.ownerTet, count),
          count,
        });
        this.#centroidPending.delete(key);
        this.#requestRender();
      })
      .catch(() => {
        this.#centroidPending.delete(key);
      });
    return null;
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------------------------

  /** Repaint when this key's cut lands. Idempotent: one subscription per `(dataset, key)`. */
  #subscribeCut(datasetId: DatasetId, cutKey: string): void {
    const id = `${datasetId} ${cutKey}`;
    if (this.#cutSubs.has(id)) return;
    this.#cutSubs.set(
      id,
      this.#cuts.onCut(datasetId, cutKey, () => {
        this.#requestRender();
      })
    );
  }

  /** Unsubscribe and release one cut key. */
  #releaseCut(datasetId: DatasetId, cutKey: string): void {
    const id = `${datasetId} ${cutKey}`;
    this.#cutSubs.get(id)?.();
    this.#cutSubs.delete(id);
    this.#cuts.releaseCut(datasetId, cutKey);
  }

  /** Drop one layer's per-pane geometry — its cut keys go with it. */
  dropLayer(id: LayerId): void {
    for (const [k, g] of [...this.#panes]) {
      if (!k.startsWith(`${id}|`)) continue;
      this.#disposePane(g);
      this.#panes.delete(k);
      const meta = this.#paneKeys.get(k);
      if (meta !== undefined) this.#releaseCut(meta.datasetId, meta.cutKey);
      this.#paneKeys.delete(k);
    }
    const lut = this.#tagLuts.get(id);
    if (lut !== undefined) {
      this.#gl.deleteTexture(lut.table.texture);
      this.#tagLuts.delete(id);
    }
    const pts = this.#points.get(id);
    if (pts !== undefined) {
      pts.vao.dispose();
      pts.quad.dispose();
      pts.instances.dispose();
      this.#points.delete(id);
    }
    const lines = this.#lines.get(id);
    if (lines !== undefined) {
      lines.vao.dispose();
      lines.strip.dispose();
      lines.segments.dispose();
      this.#lines.delete(id);
    }
  }

  dropDataset(id: DatasetId): void {
    for (const [k, off] of [...this.#cutSubs]) {
      if (!k.startsWith(`${id} `)) continue;
      off();
      this.#cutSubs.delete(k);
    }
    const s = this.#surfaces.get(id);
    if (s !== undefined) {
      this.#gl.deleteTexture(s.positions.texture);
      this.#gl.deleteTexture(s.owner.texture);
      this.#gl.deleteTexture(s.tag.texture);
      this.#surfaces.delete(id);
    }
    for (const [k, f] of [...this.#fields]) {
      if (!k.startsWith(`${id}|`)) continue;
      if (f.table !== null) this.#gl.deleteTexture(f.table.texture);
      this.#fields.delete(k);
    }
    for (const [k, c] of [...this.#centroids]) {
      if (!k.startsWith(`${id}|`)) continue;
      this.#gl.deleteTexture(c.positions.texture);
      this.#gl.deleteTexture(c.owner.texture);
      this.#centroids.delete(k);
    }
    for (const k of [...this.#surfaceContours.keys()]) {
      if (k.startsWith(`${id}|`)) this.#surfaceContours.delete(k);
    }
  }

  dispose(): void {
    for (const g of this.#panes.values()) this.#disposePane(g);
    this.#panes.clear();
    this.#paneKeys.clear();
    for (const off of this.#cutSubs.values()) off();
    this.#cutSubs.clear();
    for (const l of this.#tagLuts.values()) this.#gl.deleteTexture(l.table.texture);
    this.#tagLuts.clear();
    for (const e of this.#points.values()) {
      e.vao.dispose();
      e.quad.dispose();
      e.instances.dispose();
    }
    this.#points.clear();
    for (const e of this.#lines.values()) {
      e.vao.dispose();
      e.strip.dispose();
      e.segments.dispose();
    }
    this.#lines.clear();
    for (const f of this.#fields.values())
      if (f.table !== null) this.#gl.deleteTexture(f.table.texture);
    this.#fields.clear();
    for (const s of this.#surfaces.values()) {
      this.#gl.deleteTexture(s.positions.texture);
      this.#gl.deleteTexture(s.owner.texture);
      this.#gl.deleteTexture(s.tag.texture);
    }
    this.#surfaces.clear();
    for (const c of this.#centroids.values()) {
      this.#gl.deleteTexture(c.positions.texture);
      this.#gl.deleteTexture(c.owner.texture);
    }
    this.#centroids.clear();
    this.#surfaceContours.clear();
  }

  #disposePane(g: PaneCutGeometry): void {
    const gl = this.#gl;
    g.vao.dispose();
    g.positions.dispose();
    g.values?.dispose();
    g.contourVao.dispose();
    g.contourStrip.dispose();
    g.contourBuffer.dispose();
    if (g.tagTable !== null) gl.deleteTexture(g.tagTable.texture);
    if (g.ownerTable !== null) gl.deleteTexture(g.ownerTable.texture);
    if (g.posTable !== null) gl.deleteTexture(g.posTable.texture);
  }
}
