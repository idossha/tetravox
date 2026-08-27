/**
 * `CutManager` — the single owner of every mesh dataset's `cut` op (§6.5.2, `mesh_cut` in §6.4).
 *
 * **Why one owner rather than two callers.** The exact per-element cut polygons `plane_cut` returns
 * feed *two* unrelated consumers:
 *
 * * the **3D caps** of §7.4 (positions / `ownerTet` / `tag` / `edgeMask` / `interpNodes` / `interpT`),
 *   drawn in the same pass as their owning layer, with that layer's opacity; and
 * * the **2D overlay** of §7.4's last bullet — `Cut.edge_segments` for `contoursIn2D`, and the cut
 *   polygons themselves for `fillIn2D`.
 *
 * §7.4 says so explicitly: "`Cut.edge_segments` is **not** used in the 3D passes — it exists for the
 * 2D overlay". Two consumers issuing their own `cut` for the same planes would double the 2.7 ms
 * (12.9 ms in wasm `[M2Max]`) per drag frame and could disagree about which cut is current.
 *
 * **Named requests, one per consumer (R4).** A viewer that shows a mesh cross-section in the axial,
 * coronal and sagittal panes *and* clips the 3D view has **four** live plane sets, and they change
 * at different times: sweeping the axial pane must not starve the coronal pane's cut, and dragging
 * the 3D clip gizmo must not cancel any of the three. So a request is keyed on `(datasetId, key)`
 * and latest-wins applies **per key** — {@link CUT_KEY_3D_CLIP} for the layer's clip planes,
 * {@link cutKeyForPane} for each 2D pane's cursor plane. One key's drag can never supersede
 * another's, because the key is also the `ComputeClient` latest-wins key (§5 rule 6).
 *
 * **Latest-wins is the only drag mechanism** (§5 rule 6, §7.4). `plane_cut` stays *exact, always* —
 * there is no coarse-while-held proxy, because it would add a visible pop on release and a second
 * code path to the feature the product is judged on.
 *
 * ## Two facts that decided this shape
 *
 * **1. `recycle: true` cannot serve the engine.** §6.4's `CutOut` pool lives in the *worker*, and
 * §6.5.1's `'recycled'` reply is `{ mode, truncated, counts }` — **no arrays**
 * (`packages/wasm/src/dispatch.ts` transfers nothing for it: "the pool stays in the worker"). A
 * dataset worker has no GL context, so nothing there can consume the pool either. A recycled cut is
 * therefore geometry the engine can never read. This class requests `recycle: false` and reads the
 * transferred `'buffers'` reply; the `'recycled'` branch is still handled, because a worker may
 * answer it, and it degrades to one re-request without the flag.
 *
 * **2. The arena that matters is on this side.** §7.4's cap upload is "a pre-sized, double-buffered
 * VBO set … grown by doubling and never shrunk during a drag", which needs the CPU-side arrays to
 * live at a stable address and length across a drag. So this class keeps **one arena per key**:
 * positions / `interpNodes` / `interpT` / `ownerTet` / `tag` / `edgeMask` / the interpolated fields,
 * grown by doubling, never shrunk, each cut packed into it plane-major. A {@link CutSnapshot}
 * exposes `subarray` views of exactly the used length.
 *
 * **Snapshot lifetime, stated once.** A snapshot is frozen, its `generation` is monotonic per key,
 * and a stale generation is never delivered. Its typed arrays are **views into that key's arena**
 * and stay valid until the next cut for the same key lands — which is what makes the recycle
 * possible at all. Read them in the frame you were handed them (upload to GL, or walk the segments
 * into an overlay buffer); never retain one across a request.
 */

import type { CutCounts, CutPayload, OpArgs, OpResult, PlaneT } from '@tetravox/protocol';
import type { DatasetId, Plane } from '../scene/types';

/**
 * The slice of `ComputeClient` a cut needs.
 *
 * Narrow on purpose: it is what lets the unit tests drive this class with a fake worker, and it
 * documents which ops a manager may issue. `field` is here because {@link CutRequestOptions.fields}
 * is served by fetching the whole field once and interpolating it onto the cut — the frozen §6.5.2
 * `cut` op takes no field argument.
 */
export interface CutClient {
  call(key: string, op: 'cut', args: OpArgs['cut']): Promise<OpResult['cut']>;
  call(key: string, op: 'field', args: OpArgs['field']): Promise<OpResult['field']>;
}

/** How a `datasetId` resolves to its worker client and mesh handle. */
export type CutSource = (datasetId: DatasetId) => { client: CutClient; handle: number } | undefined;

/** One field to carry on the cut, named exactly as `MeshFieldInfo` names it. */
export interface CutFieldRef {
  source: 'node' | 'elm';
  name: string;
}

export interface CutRequestOptions {
  /**
   * Fields to interpolate onto the cut. A **node** field lands per vertex
   * (`mix(f[n0], f[n1], interpT)` — §7.4's cap rule, evaluated here for consumers that cannot run a
   * vertex shader); an **elm** field lands per triangle (`f[ownerTet − 1]`).
   *
   * Opt-in, and absent by default: the 3D cap path does the same `mix` in the vertex shader from
   * `interpNodes`/`interpT`, so "changing the displayed field costs zero re-cut" (§7.4) and costs no
   * CPU work either. This exists for `fillIn2D` / `contoursIn2D`, whose colouring is decided on the
   * CPU, and it is why {@link CutSnapshot.fields} is empty unless asked for.
   */
  fields?: CutFieldRef[];
  /** The isolation mask in force (`compute/isolate-manager.ts`). `null` and `undefined` both mean none. */
  maskId?: number | null;
  /** Keep `Cut.edge_segments` (§7.4: the 2D overlay's input, never the 3D passes'). */
  wantEdges: boolean;
  /** Keep `Cut.boundary_segments`. */
  wantBoundary: boolean;
}

/** Where one plane's geometry sits inside a snapshot's plane-major arrays. */
export interface CutPlaneRange {
  /**
   * Index into {@link CutSnapshot.planes}. §7.4's cap rule disables `CLIP_DISTANCE(plane)` for the
   * draw of this range and leaves the others enabled.
   */
  plane: number;
  firstVertex: number;
  vertexCount: number;
  firstTriangle: number;
  triangleCount: number;
  firstEdgeSegment: number;
  edgeSegmentCount: number;
  firstBoundarySegment: number;
  boundarySegmentCount: number;
}

/**
 * One cut, as both consumers read it. Frozen; its arrays are arena views (see the file header).
 *
 * Triangles are **de-indexed**: `positions` is 3 floats per vertex, three vertices per triangle, so
 * triangle `t` owns vertices `3t, 3t+1, 3t+2` — the same layout the de-indexed `SurfacePayload`
 * uses, and the one §7.4's barycentric edges need.
 */
export interface CutSnapshot {
  /** The planes this cut was computed for, in request order. */
  planes: PlaneT[];
  /** Monotonic per key; increments once per landed cut. */
  generation: number;
  /** The mask this cut was computed under, or `undefined`. */
  maskId: number | undefined;
  /** 3 per vertex. */
  positions: Float32Array;
  /** 2 per vertex: the two INTERNAL node indices this vertex was interpolated between (§6.5.1). */
  interpNodes: Uint32Array;
  /** 1 per vertex. */
  interpT: Float32Array;
  /** 1 per triangle — Gmsh element number (§6.2), 1-based. */
  ownerTet: Uint32Array;
  /** 1 per triangle. */
  tag: Int32Array;
  /** 1 per triangle, low 3 bits (§7.4). */
  edgeMask: Uint8Array;
  /** 6 per segment — 2D overlay only. Empty when `wantEdges` was false. */
  edgeSegments: Float32Array;
  /** 6 per segment — 2D overlay only. Empty when `wantBoundary` was false. */
  boundarySegments: Float32Array;
  /** Per requested field: one value per vertex for a node field, per triangle for an elm field. */
  fields: Record<string, Float32Array>;
  /** Plane-major offsets into every array above. */
  planeRanges: CutPlaneRange[];
  /** `positions.length / 3`. */
  vertexCount: number;
  /** `ownerTet.length`. */
  triangleCount: number;
}

/**
 * The cut currently on screen for one key.
 *
 * Keeps the shape Phase 1 published (`generation` / `planes` / `maskId` / `cuts`); `snapshot` is
 * what Phase 2's consumers read.
 */
export interface CutState {
  generation: number;
  /** The planes this cut was computed for — §7.4 allows at most 6. */
  planes: PlaneT[];
  maskId: number | undefined;
  /** One entry per plane that produced geometry, exactly as the worker sent it. */
  cuts: CutPayload[];
  /** The packed, arena-backed form both consumers read. */
  snapshot: CutSnapshot;
}

/** §7.4: "up to 6 world-space planes". */
export const MAX_CUT_PLANES = 6;

/** The key of a mesh layer's own clip planes (§7.4). */
export const CUT_KEY_3D_CLIP = '3d-clip';

/** The key of one 2D pane's cursor plane (R4). */
export function cutKeyForPane(viewId: string): string {
  return `pane:${viewId}`;
}

function samePlanes(a: readonly PlaneT[], b: readonly PlaneT[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((p, i) => {
    const q = b[i];
    return (
      q !== undefined &&
      p.offset === q.offset &&
      p.normal[0] === q.normal[0] &&
      p.normal[1] === q.normal[1] &&
      p.normal[2] === q.normal[2]
    );
  });
}

function sameFields(a: readonly CutFieldRef[], b: readonly CutFieldRef[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((f, i) => b[i]?.source === f.source && b[i]?.name === f.name);
}

function toPlaneT(p: Plane | PlaneT): PlaneT {
  return { normal: [p.normal[0], p.normal[1], p.normal[2]], offset: p.offset };
}

/** Grow by doubling, never shrink — §7.4's cap-upload rule, applied to the CPU side. */
function grow<T extends Float32Array | Uint32Array | Int32Array | Uint8Array>(
  current: T,
  need: number,
  make: (n: number) => T
): T {
  if (current.length >= need) return current;
  let cap = Math.max(1, current.length);
  while (cap < need) cap *= 2;
  return make(cap);
}

/** One key's recycled output arrays. */
interface CutArena {
  positions: Float32Array;
  interpNodes: Uint32Array;
  interpT: Float32Array;
  ownerTet: Uint32Array;
  tag: Int32Array;
  edgeMask: Uint8Array;
  edgeSegments: Float32Array;
  boundarySegments: Float32Array;
  fields: Map<string, Float32Array>;
}

function emptyArena(): CutArena {
  return {
    positions: new Float32Array(0),
    interpNodes: new Uint32Array(0),
    interpT: new Float32Array(0),
    ownerTet: new Uint32Array(0),
    tag: new Int32Array(0),
    edgeMask: new Uint8Array(0),
    edgeSegments: new Float32Array(0),
    boundarySegments: new Float32Array(0),
    fields: new Map(),
  };
}

interface CutRequest {
  planes: PlaneT[];
  maskId: number | undefined;
  fields: CutFieldRef[];
  wantEdges: boolean;
  wantBoundary: boolean;
}

/** Everything one `(datasetId, key)` owns: its request lifecycle, its arena and its listeners. */
class CutEntry {
  readonly #client: CutClient;
  readonly #handle: number;
  /** §5 rule 6's latest-wins key. Distinct per consumer, which is the whole point (R4). */
  readonly #clientKey: string;

  #ticket = 0;
  #latest = 0;
  #requested: CutRequest | null = null;
  #state: CutState | null = null;
  #generation = 0;
  #disposed = false;
  readonly #arena: CutArena = emptyArena();
  readonly #listeners = new Set<(snap: CutSnapshot | null) => void>();
  /** Field values, cached per `${source}:${name}` — a field never changes for a loaded mesh. */
  readonly #fieldCache = new Map<string, Float32Array>();
  #required: CutCounts[] = [];
  /**
   * §6.4's pool flag. `false` from the start: a `'recycled'` reply carries no arrays and the pool
   * never leaves the worker, so the engine could not read the geometry (see the file header).
   */
  #recycle = false;

  constructor(client: CutClient, handle: number, clientKey: string) {
    this.#client = client;
    this.#handle = handle;
    this.#clientKey = clientKey;
  }

  state(): CutState | null {
    return this.#state;
  }

  snapshot(): CutSnapshot | null {
    return this.#state?.snapshot ?? null;
  }

  requiredCounts(): readonly CutCounts[] {
    return this.#required;
  }

  get recycling(): boolean {
    return this.#recycle;
  }

  subscribe(cb: (snap: CutSnapshot | null) => void): () => void {
    this.#listeners.add(cb);
    return () => {
      this.#listeners.delete(cb);
    };
  }

  request(planes: readonly PlaneT[], opts: CutRequestOptions): void {
    if (this.#disposed) return;
    if (planes.length > MAX_CUT_PLANES) {
      throw new Error(`§7.4 allows at most ${MAX_CUT_PLANES} clip planes, got ${planes.length}`);
    }
    const next: CutRequest = {
      planes: planes.map(toPlaneT),
      maskId: opts.maskId ?? undefined,
      fields: (opts.fields ?? []).map((f) => ({ source: f.source, name: f.name })),
      wantEdges: opts.wantEdges,
      wantBoundary: opts.wantBoundary,
    };
    const prev = this.#requested;
    if (
      prev !== null &&
      prev.maskId === next.maskId &&
      prev.wantEdges === next.wantEdges &&
      prev.wantBoundary === next.wantBoundary &&
      sameFields(prev.fields, next.fields) &&
      samePlanes(prev.planes, next.planes)
    ) {
      // Re-requesting an identical cut is a no-op, which keeps a re-render during a drag from
      // re-cutting geometry that has not moved.
      return;
    }
    this.#requested = next;
    if (next.planes.length === 0) {
      // No planes is not a cut with zero triangles; it is *no cut*, and the consumers must stop
      // drawing caps rather than keep the last ones.
      this.#latest = ++this.#ticket;
      this.#publish(null);
      return;
    }
    void this.#issue(next, this.#recycle);
  }

  async #issue(req: CutRequest, recycle: boolean): Promise<void> {
    const ticket = ++this.#ticket;
    this.#latest = ticket;
    let res: OpResult['cut'];
    let fieldValues: Map<string, Float32Array>;
    try {
      // Issued on the same latest-wins key, so a superseded drag frame drops these too; they are
      // cached, so a whole drag pays for a field once.
      fieldValues = await this.#fields(req.fields);
      res = await this.#client.call(this.#clientKey, 'cut', {
        handle: this.#handle,
        planes: req.planes,
        maskId: req.maskId,
        recycle,
      });
    } catch {
      // A superseded or cancelled cut is normal under latest-wins; it is not an error (§5 rule 6).
      return;
    }
    if (this.#disposed || ticket !== this.#latest) return;

    if (res.mode === 'recycled') {
      // §6.5.1: `truncated` means the pool was too small and **nothing was written**, and `counts`
      // are the required sizes. Either way the engine cannot read a worker-owned pool, so the only
      // useful response is to re-ask without the flag.
      this.#required = res.counts.map((c) => ({ ...c }));
      if (recycle) {
        this.#recycle = false;
        await this.#issue(req, false);
      }
      return;
    }
    this.#publish(this.#pack(req, res.cuts, fieldValues));
  }

  /** Fetch (and cache) the field arrays a request asked to carry. */
  async #fields(refs: readonly CutFieldRef[]): Promise<Map<string, Float32Array>> {
    const out = new Map<string, Float32Array>();
    for (const ref of refs) {
      const cacheKey = `${ref.source}:${ref.name}`;
      let values = this.#fieldCache.get(cacheKey);
      if (values === undefined) {
        const res = await this.#client.call(this.#clientKey, 'field', {
          handle: this.#handle,
          source: ref.source,
          name: ref.name,
          component: 'mag',
        });
        values = res.values;
        this.#fieldCache.set(cacheKey, values);
      }
      out.set(ref.name, values);
    }
    return out;
  }

  /**
   * Pack one `cut` reply into this key's arena, plane-major, and build the snapshot.
   *
   * The copy is what buys a stable address and length across a drag (§7.4's cap VBO set). Shape for
   * ernie's mid-axial cut: 62,966 cap triangles ⇒ 188,898 vertices ⇒ ~2.3 MB of positions `[M2Max]`.
   */
  #pack(
    req: CutRequest,
    cuts: readonly CutPayload[],
    fieldValues: ReadonlyMap<string, Float32Array>
  ): CutState {
    let vertices = 0;
    let triangles = 0;
    let edgeSegs = 0;
    let boundarySegs = 0;
    for (const c of cuts) {
      vertices += c.positions.length / 3;
      triangles += c.ownerTet.length;
      if (req.wantEdges) edgeSegs += c.edgeSegments.length / 6;
      if (req.wantBoundary) boundarySegs += c.boundarySegments.length / 6;
    }

    const a = this.#arena;
    a.positions = grow(a.positions, vertices * 3, (n) => new Float32Array(n));
    a.interpNodes = grow(a.interpNodes, vertices * 2, (n) => new Uint32Array(n));
    a.interpT = grow(a.interpT, vertices, (n) => new Float32Array(n));
    a.ownerTet = grow(a.ownerTet, triangles, (n) => new Uint32Array(n));
    a.tag = grow(a.tag, triangles, (n) => new Int32Array(n));
    a.edgeMask = grow(a.edgeMask, triangles, (n) => new Uint8Array(n));
    a.edgeSegments = grow(a.edgeSegments, edgeSegs * 6, (n) => new Float32Array(n));
    a.boundarySegments = grow(a.boundarySegments, boundarySegs * 6, (n) => new Float32Array(n));

    const planeRanges: CutPlaneRange[] = [];
    let v = 0;
    let t = 0;
    let e = 0;
    let b = 0;
    for (const c of cuts) {
      const nv = c.positions.length / 3;
      const nt = c.ownerTet.length;
      const ne = req.wantEdges ? c.edgeSegments.length / 6 : 0;
      const nb = req.wantBoundary ? c.boundarySegments.length / 6 : 0;
      a.positions.set(c.positions, v * 3);
      a.interpNodes.set(c.interpNodes, v * 2);
      a.interpT.set(c.interpT, v);
      a.ownerTet.set(c.ownerTet, t);
      a.tag.set(c.tag, t);
      a.edgeMask.set(c.edgeMask, t);
      if (ne > 0) a.edgeSegments.set(c.edgeSegments.subarray(0, ne * 6), e * 6);
      if (nb > 0) a.boundarySegments.set(c.boundarySegments.subarray(0, nb * 6), b * 6);
      planeRanges.push({
        plane: c.plane,
        firstVertex: v,
        vertexCount: nv,
        firstTriangle: t,
        triangleCount: nt,
        firstEdgeSegment: e,
        edgeSegmentCount: ne,
        firstBoundarySegment: b,
        boundarySegmentCount: nb,
      });
      v += nv;
      t += nt;
      e += ne;
      b += nb;
    }

    const fields: Record<string, Float32Array> = {};
    for (const ref of req.fields) {
      const values = fieldValues.get(ref.name);
      if (values === undefined) continue;
      const perVertex = ref.source === 'node';
      const need = perVertex ? vertices : triangles;
      let dst = a.fields.get(ref.name);
      if (dst === undefined || dst.length < need) {
        dst = grow(dst ?? new Float32Array(0), need, (n) => new Float32Array(n));
        a.fields.set(ref.name, dst);
      }
      if (perVertex) {
        // §7.4's cap rule verbatim: `mix` the two interpolation endpoints by `interpT`.
        for (let i = 0; i < need; i += 1) {
          const n0 = a.interpNodes[i * 2] ?? 0;
          const n1 = a.interpNodes[i * 2 + 1] ?? 0;
          const f0 = values[n0] ?? 0;
          const f1 = values[n1] ?? 0;
          dst[i] = f0 + (f1 - f0) * (a.interpT[i] ?? 0);
        }
      } else {
        // `ownerTet` is a **Gmsh element number** (§6.2) and is 1-based; an element field is indexed
        // by the 0-based element row. Confusing the two is the one thing §6.3 warns about.
        for (let i = 0; i < need; i += 1) {
          const owner = a.ownerTet[i] ?? 0;
          dst[i] = values[owner > 0 ? owner - 1 : 0] ?? 0;
        }
      }
      fields[ref.name] = dst.subarray(0, need);
    }

    const snapshot: CutSnapshot = Object.freeze({
      planes: req.planes,
      generation: ++this.#generation,
      maskId: req.maskId,
      positions: a.positions.subarray(0, vertices * 3),
      interpNodes: a.interpNodes.subarray(0, vertices * 2),
      interpT: a.interpT.subarray(0, vertices),
      ownerTet: a.ownerTet.subarray(0, triangles),
      tag: a.tag.subarray(0, triangles),
      edgeMask: a.edgeMask.subarray(0, triangles),
      edgeSegments: a.edgeSegments.subarray(0, edgeSegs * 6),
      boundarySegments: a.boundarySegments.subarray(0, boundarySegs * 6),
      fields,
      planeRanges,
      vertexCount: vertices,
      triangleCount: triangles,
    });
    return {
      generation: snapshot.generation,
      planes: req.planes,
      maskId: req.maskId,
      cuts: [...cuts],
      snapshot,
    };
  }

  #publish(state: CutState | null): void {
    this.#state = state;
    for (const cb of [...this.#listeners]) cb(state?.snapshot ?? null);
  }

  /**
   * Drop this key's cut and stop applying results.
   *
   * The worker's pool goes with the worker (§5 rule 1: closing a dataset is `worker.terminate()`),
   * so there is nothing to free on the other side.
   */
  dispose(): void {
    this.#disposed = true;
    this.#listeners.clear();
    this.#state = null;
    this.#requested = null;
    this.#fieldCache.clear();
  }
}

/**
 * The engine's one cut manager. E-MESH owns it; E-DERIVED consumes {@link CutManager.getCut} /
 * {@link CutManager.onCut} and may not edit this file.
 */
export class CutManager {
  readonly #source: CutSource;
  readonly #entries = new Map<string, CutEntry>();

  constructor(source: CutSource) {
    this.#source = source;
  }

  /** `datasetId` cannot contain a space (`engine.ts` mints `dsN`), so this is unambiguous. */
  static #id(datasetId: DatasetId, key: string): string {
    return `${datasetId} ${key}`;
  }

  #entry(datasetId: DatasetId, key: string, create: boolean): CutEntry | undefined {
    const id = CutManager.#id(datasetId, key);
    let entry = this.#entries.get(id);
    if (entry === undefined && create) {
      const src = this.#source(datasetId);
      if (src === undefined) return undefined;
      entry = new CutEntry(src.client, src.handle, `cut:${key}`);
      this.#entries.set(id, entry);
    }
    return entry;
  }

  /**
   * Ask for a cut of `datasetId` under `key`. Latest-wins **per (datasetId, key)**; re-requesting an
   * identical cut is a no-op.
   *
   * Keys: {@link CUT_KEY_3D_CLIP} for a layer's clip planes, {@link cutKeyForPane} for a 2D pane's
   * cursor plane.
   */
  requestCut(
    datasetId: DatasetId,
    key: string,
    planes: readonly (Plane | PlaneT)[],
    opts: CutRequestOptions
  ): void {
    const entry = this.#entry(datasetId, key, true);
    entry?.request(planes.map(toPlaneT), opts);
  }

  /** The cut on screen for `(datasetId, key)`, or `null` before the first result lands. */
  getCut(datasetId: DatasetId, key: string): CutSnapshot | null {
    return this.#entry(datasetId, key, false)?.snapshot() ?? null;
  }

  /**
   * Subscribe to `(datasetId, key)`. Returns an unsubscribe.
   *
   * Subscribing creates the entry, so a consumer may listen before anything requests — which is what
   * lets a 2D pane wire itself up at layer-creation time.
   */
  onCut(datasetId: DatasetId, key: string, cb: (snap: CutSnapshot | null) => void): () => void {
    const entry = this.#entry(datasetId, key, true);
    if (entry === undefined) return () => undefined;
    return entry.subscribe(cb);
  }

  /** Drop one key's cut, its arena and its listeners. */
  releaseCut(datasetId: DatasetId, key: string): void {
    const id = CutManager.#id(datasetId, key);
    this.#entries.get(id)?.dispose();
    this.#entries.delete(id);
  }

  /** Drop every key belonging to one dataset — `removeDataset` / `removeLayer`. */
  releaseDataset(datasetId: DatasetId): void {
    const prefix = `${datasetId} `;
    for (const [id, entry] of [...this.#entries]) {
      if (id.startsWith(prefix)) {
        entry.dispose();
        this.#entries.delete(id);
      }
    }
  }

  /** The full {@link CutState} for one key — the Phase-1 shape, kept for the cap-upload path. */
  current(datasetId: DatasetId, key: string): CutState | null {
    return this.#entry(datasetId, key, false)?.state() ?? null;
  }

  /** `Cut.edge_segments` per plane — the 2D `contoursIn2D` consumer's input (§7.4). */
  edgeSegments(datasetId: DatasetId, key: string): Float32Array[] {
    const snap = this.getCut(datasetId, key);
    if (snap === null) return [];
    return snap.planeRanges.map((r) =>
      snap.edgeSegments.subarray(
        r.firstEdgeSegment * 6,
        (r.firstEdgeSegment + r.edgeSegmentCount) * 6
      )
    );
  }

  /** The cut polygons themselves — the `fillIn2D` consumer's input (§7.4). */
  capPolygons(datasetId: DatasetId, key: string): CutPayload[] {
    return this.current(datasetId, key)?.cuts ?? [];
  }

  /** The sizes the last truncated recycle reported, if a worker ever answers `'recycled'`. */
  requiredCounts(datasetId: DatasetId, key: string): readonly CutCounts[] {
    return this.#entry(datasetId, key, false)?.requiredCounts() ?? [];
  }

  /** True while this key still asks the worker to use its `CutOut` pool (§6.4). Off by default. */
  recycling(datasetId: DatasetId, key: string): boolean {
    return this.#entry(datasetId, key, false)?.recycling ?? false;
  }

  /** Every live `(datasetId, key)` — for tests and the status bar. */
  keys(): { datasetId: DatasetId; key: string }[] {
    return [...this.#entries.keys()].map((id) => {
      const space = id.indexOf(' ');
      return { datasetId: id.slice(0, space), key: id.slice(space + 1) };
    });
  }

  dispose(): void {
    for (const entry of this.#entries.values()) entry.dispose();
    this.#entries.clear();
  }
}
