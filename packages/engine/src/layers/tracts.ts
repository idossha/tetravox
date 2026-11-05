/**
 * The `tracts` layer's runtime (§7.4.1). It decides what to ask the dataset's worker for and when; the
 * pass draws. Probing is a worker round trip, as a mesh's is, so a row is served from the last answer.
 */

import type { TractGroupRowT, TractProbeHitT, TractStyleSpecT } from '@tetravox/protocol';
import type { ProbeRow } from '../api';
import { bakeScale, isColormapName } from '../color/colormaps';
import { formatTick, type ColorbarSpec } from '../overlay/colorbar';
import { TractLayerGpu } from '../render/tract-gpu';
import { isSliceView } from '../scene/store';
import type {
  ColormapName,
  Dataset,
  LayerId,
  TractFieldInfo,
  TractogramDataset,
  TractsLayer,
  vec3,
  View,
} from '../scene/types';
import { pickableIn, visibleIn } from './runtime';
import type { DrawItem, LayerRuntime, LayerRuntimeContext, PickItem } from './runtime';

function colormapOf(name: string): ColormapName {
  return isColormapName(name) ? name : 'gray';
}

/** How far a cursor may be from a point and still be "on" a streamline. */
export const TRACT_PROBE_RADIUS_MM = 2;
/** Any point of a picked streamline will do: the pick already said which one. */
const PICKED_RADIUS_MM = 1000;

/** The worker's view of a layer's style: changing anything else must not re-run it. */
export function tractStyleSpec(layer: TractsLayer): TractStyleSpecT {
  const spec: TractStyleSpecT = {};
  if (layer.streamlineFilter !== undefined) spec.filter = layer.streamlineFilter;
  if (layer.groupField !== undefined) spec.groupField = layer.groupField;
  if (layer.visibleGroups !== undefined) spec.visibleGroups = layer.visibleGroups;
  return spec;
}

export function tractFieldOf(
  layer: TractsLayer,
  ds: TractogramDataset
): { kind: 'vertex' | 'streamline'; info: TractFieldInfo } | null {
  if (layer.field === undefined) return null;
  if (layer.colorMode === 'vertex') {
    const info = ds.vertexFields.find((f) => f.name === layer.field);
    return info === undefined ? null : { kind: 'vertex', info };
  }
  if (layer.colorMode === 'streamline') {
    const info = ds.streamlineFields.find((f) => f.name === layer.field);
    return info === undefined ? null : { kind: 'streamline', info };
  }
  return null;
}

export class TractsLayerRuntime implements LayerRuntime {
  readonly kind = 'tracts' as const;
  readonly id: LayerId;
  readonly datasetId: string;
  readonly #ctx: LayerRuntimeContext;
  #layer: TractsLayer;
  #gpu: TractLayerGpu | null = null;
  #generation = -1;
  #geometryPending = false;
  #scalarKey = '';
  #scalarWanted = '';
  #styleKey: string | null = null;
  #styleInfo: { visibleStreamlines: number; groups: TractGroupRowT[] } | null = null;
  #hit: { world: vec3; hit: TractProbeHitT | null } | null = null;
  #picked: { world: vec3; held: number } | null = null;
  #disposed = false;

  constructor(layer: TractsLayer, _ds: Dataset, ctx: LayerRuntimeContext) {
    this.#layer = layer;
    this.id = layer.id;
    this.datasetId = layer.datasetId;
    this.#ctx = ctx;
    this.#sync();
  }

  get layer(): TractsLayer {
    return this.#layer;
  }

  get #ds(): TractogramDataset | null {
    const ds = this.#ctx.dataset(this.datasetId);
    return ds?.kind === 'tractogram' ? ds : null;
  }

  applyPatch(next: TractsLayer): void {
    this.#layer = next;
    this.#sync();
  }

  /** A field was added or the worker's arrays were replaced. */
  datasetChanged(): void {
    this.#sync();
  }

  styleInfo(): { visibleStreamlines: number; groups: TractGroupRowT[] } | null {
    return this.#styleInfo;
  }

  #sync(): void {
    const ds = this.#ds;
    if (ds === null || this.#disposed) return;
    if (this.#generation !== ds.generation) {
      if (this.#geometryPending) return;
      this.#loadGeometry(ds);
      return;
    }
    if (this.#gpu === null) return;
    this.#syncStyle(ds);
    this.#syncScalar(ds);
  }

  #loadGeometry(ds: TractogramDataset): void {
    const client = this.#ctx.client(this.datasetId);
    if (client === undefined) return;
    const generation = ds.generation;
    const existing = this.#ctx.gpu.tractGeometry(this.datasetId, generation);
    if (existing !== undefined) {
      this.#adoptGeometry(generation);
      this.#sync();
      return;
    }
    this.#geometryPending = true;
    void this.#ctx
      .track(
        client.call(`geometry:${this.datasetId}:${generation}`, 'tractGeometry', {
          handle: ds.handle,
        })
      )
      .then((payload) => {
        this.#geometryPending = false;
        if (this.#disposed) return;
        this.#ctx.gpu.uploadTractGeometry(this.datasetId, generation, payload);
        this.#adoptGeometry(generation);
        this.#sync();
        this.#ctx.requestRender();
      })
      .catch((e: unknown) => {
        this.#geometryPending = false;
        this.#report(e);
      });
  }

  #adoptGeometry(generation: number): void {
    const geometry = this.#ctx.gpu.tractGeometry(this.datasetId, generation);
    if (geometry === undefined) return;
    this.#gpu?.dispose();
    this.#gpu = new TractLayerGpu(this.#ctx.gpu.gl, geometry);
    this.#generation = generation;
    this.#scalarKey = '';
    this.#scalarWanted = '';
    this.#styleKey = null;
    this.#hit = null;
  }

  #syncStyle(ds: TractogramDataset): void {
    const spec = tractStyleSpec(this.#layer);
    const key = JSON.stringify(spec);
    if (key === this.#styleKey) return;
    const client = this.#ctx.client(this.datasetId);
    if (client === undefined) return;
    this.#styleKey = key;
    void this.#ctx
      .track(client.call(`${this.id}:tract-style`, 'tractStyle', { handle: ds.handle, spec }))
      .then((res) => {
        if (this.#disposed || this.#gpu === null || key !== this.#styleKey) return;
        this.#gpu.setStyle(res.rgba);
        this.#styleInfo = { visibleStreamlines: res.visibleStreamlines, groups: res.groups };
        this.#hit = null;
        this.#ctx.requestRender();
        this.#ctx.layerChanged?.(this.id);
      })
      .catch((e: unknown) => this.#ignoreSuperseded(e));
  }

  #syncScalar(ds: TractogramDataset): void {
    const gpu = this.#gpu;
    if (gpu === null) return;
    const field = tractFieldOf(this.#layer, ds);
    if (field === null) {
      if (this.#scalarKey !== '') gpu.setScalar(null);
      this.#scalarKey = '';
      this.#scalarWanted = '';
      return;
    }
    // A re-sampled field keeps its name and changes its values: the statistics tell them apart.
    const stamp = `${field.kind}|${field.info.name}|${field.info.stats.min}|${field.info.stats.max}|${field.info.stats.mean}`;
    if (stamp === this.#scalarKey || stamp === this.#scalarWanted) return;
    const client = this.#ctx.client(this.datasetId);
    if (client === undefined) return;
    this.#scalarWanted = stamp;
    void this.#ctx
      .track(
        client.call(`${this.id}:tract-scalar`, 'tractScalar', {
          handle: ds.handle,
          kind: field.kind,
          name: field.info.name,
        })
      )
      .then((res) => {
        if (this.#disposed || this.#gpu === null || stamp !== this.#scalarWanted) return;
        this.#gpu.setScalar(res);
        this.#scalarKey = stamp;
        this.#ctx.requestRender();
      })
      .catch((e: unknown) => this.#ignoreSuperseded(e));
  }

  #ignoreSuperseded(e: unknown): void {
    if ((e as { code?: string }).code === 'cancelled') return;
    this.#report(e);
  }

  #report(e: unknown): void {
    this.#ctx.reportError?.(this.datasetId, e instanceof Error ? e.message : String(e));
  }

  /** §7.2.3's pick named a streamline; the next probe at that point reads it, not its neighbour. */
  notePick(world: vec3, held: number): void {
    this.#picked = { world, held };
  }

  refreshProbe(world: vec3): void {
    const ds = this.#ds;
    const client = this.#ctx.client(this.datasetId);
    if (ds === null || client === undefined || this.#generation !== ds.generation) return;
    const p = this.#picked;
    const picked = p !== null && dist(p.world, world) < 1e-4 ? p.held : undefined;
    void this.#ctx
      .track(
        client.call(`${this.id}:tract-probe`, 'tractProbe', {
          handle: ds.handle,
          world,
          radiusMm: picked === undefined ? TRACT_PROBE_RADIUS_MM : PICKED_RADIUS_MM,
          ...(picked === undefined ? {} : { streamline: picked }),
        })
      )
      .then((res) => {
        if (this.#disposed) return;
        this.#hit = { world, hit: res.hit };
        this.#ctx.probeLanded?.(world);
      })
      .catch((e: unknown) => this.#ignoreSuperseded(e));
  }

  probeRow(world: vec3): ProbeRow {
    const row: ProbeRow = { layerId: this.id, layerName: this.#layer.name, kind: 'tracts' };
    const h = this.#hit;
    if (h === null || h.hit === null || dist(h.world, world) > 1e-4) return row;
    const unitsOf = (list: TractFieldInfo[], name: string, own?: string): string | undefined =>
      own ?? list.find((f) => f.name === name)?.units;
    const ds = this.#ds;
    row.elementId = h.hit.held;
    row.streamline = h.hit.streamline;
    row.vertex = h.hit.vertex;
    row.vertexWorld = h.hit.world;
    row.fields = h.hit.vertexFields.map((f) => ({
      name: f.name,
      value: f.value,
      ...(unitsOf(ds?.vertexFields ?? [], f.name, f.units) === undefined
        ? {}
        : { units: unitsOf(ds?.vertexFields ?? [], f.name, f.units) as string }),
    }));
    row.streamlineFields = h.hit.streamlineFields;
    row.groups = h.hit.groups;
    return row;
  }

  ensurePickGeometry(): void {}

  drawItems(view: View): DrawItem[] {
    const gpu = this.#gpu;
    if (gpu === null || !gpu.hasStyle || !visibleIn(this.#layer, view)) return [];
    return [{ kind: 'tracts', layer: this.#layer, gpu }];
  }

  pickItems(view: View): PickItem[] {
    const gpu = this.#gpu;
    if (gpu === null || !gpu.hasStyle || isSliceView(view) || !pickableIn(this.#layer)) return [];
    return [{ kind: 'tracts', layer: this.#layer, gpu }];
  }

  colorbarSpec(position: ColorbarSpec['position'] = 'right'): ColorbarSpec | null {
    const layer = this.#layer;
    const ds = this.#ds;
    if (!layer.showColorbar || ds === null) return null;
    const field = tractFieldOf(layer, ds);
    if (field === null) return null;
    const baked = bakeScale(
      layer.scale,
      colormapOf(layer.colormap),
      layer.colormapNegative === undefined ? undefined : colormapOf(layer.colormapNegative)
    );
    const span = baked.hi - baked.lo;
    const at = (v: number): number => (span === 0 ? 0 : (v - baked.lo) / span);
    const s = layer.scale;
    const ticks =
      s.kind === 'heat'
        ? [s.min, s.mid, s.max].map((v) => ({ t: at(v), label: formatTick(v) }))
        : [
            { t: 0, label: formatTick(s.lo) },
            { t: 1, label: formatTick(s.hi) },
          ];
    return {
      layerId: this.id,
      title: field.info.name,
      ...(field.info.units === undefined ? {} : { units: field.info.units }),
      exactTitle: true,
      ramp: baked.rgba,
      ticks,
      notches: [layer.threshold.lo, layer.threshold.hi]
        .filter((v) => Number.isFinite(v))
        .map(at)
        .filter((t) => t >= 0 && t <= 1),
      position,
    };
  }

  dispose(): void {
    this.#disposed = true;
    this.#gpu?.dispose();
    this.#gpu = null;
  }
}

function dist(a: vec3, b: vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
