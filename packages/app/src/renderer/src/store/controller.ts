/**
 * The only place the shell talks to the `Engine` (§8: "Everything the UI can do must be reachable
 * from the `Engine` API alone. No logic in React.").
 *
 * React components call methods on this object and read the store; they never hold an `Engine`. That
 * keeps two properties testable without a DOM: every user action is a §4.7 call, and every piece of
 * rendered state came from an engine event.
 *
 * The one piece of real sequencing here is the load queue. `addDataset` resolves at the *end* of a
 * load while `progress` carries the `datasetId` from the first phase, so a card exists before it knows
 * its own id — and Cancel can be pressed in that window. Loads therefore run **one at a time**: with
 * worker-per-dataset (§5 rule 1), two 492 MB meshes in flight is two wasm heaps at once (§9.2), and
 * sequencing also makes "this progress event belongs to the one unbound card" unambiguous.
 */

import type {
  Dataset,
  DatasetId,
  Engine,
  LayerId,
  LayoutKind,
  LoadProgress,
  ViewId,
  VolumeLayer,
  vec3,
} from '@tetravox/engine';
import type { UiStore } from './store';
import { activeLayer, datasetOf } from './store';
import { requestFromPath } from '../open/sources';
import type { OpenRequest } from '../open/sources';
import type { Command } from '../lib/keymap';
import { LAYOUT_CYCLE, layoutCells, nextLayout } from '../lib/layout';
import { heapReporter, viewCommands } from '../engine/commands';
import * as loads from '../lib/loads';
import * as toasts from '../lib/toasts';
import { pushFrame } from '../lib/metrics';
import { formatTriple, parseTriple, roundVoxel, voxelToWorld, worldToVoxel } from '../lib/coords';
import { bridge } from '../bridge';

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'io';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ShellController {
  private readonly unsubscribers: (() => void)[] = [];
  private queue: OpenRequest[] = [];
  private draining = false;
  private inflight: { ticket: number; datasetId: DatasetId | null } | null = null;
  private ticketSeq = 0;
  private toastSeq = 0;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly engine: Engine,
    private readonly store: UiStore,
    private readonly now: () => number = () => performance.now()
  ) {}

  // ------------------------------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------------------------------

  attach(): void {
    const { engine, store } = this;
    const commands = viewCommands(engine);

    store.setState({
      status: 'ready',
      caps: engine.caps,
      radiological: engine.scene.radiological,
      crosshair: engine.scene.annotations.crosshair,
      cursor: engine.scene.cursor,
      layoutKind: engine.scene.layout.kind,
      cells: engine.scene.layout.cells,
      activeViewId: engine.scene.layout.cells[0] ?? null,
      quality: engine.scene.quality.name,
    });
    this.syncLayers();
    this.reprobeCursor();

    this.unsubscribers.push(
      engine.on('datasets', (datasets: Dataset[]) => {
        store.setState({ datasets: [...datasets], heapBytes: this.readHeap(datasets) });
      }),
      engine.on('layers', () => this.syncLayers()),
      engine.on('cursor', (world: vec3) => {
        store.setState({ cursor: world, cursorProbe: engine.probe(world), coordDraft: null });
      }),
      engine.on('hover', (world: vec3 | null) => {
        store.setState({
          hover: world,
          hoverProbe: world === null ? null : engine.probe(world),
        });
      }),
      engine.on('progress', (progress) => this.onProgress(progress)),
      engine.on('frame', (frame) => {
        store.setState((s) => ({
          metrics: pushFrame(s.metrics, { at: this.now(), cpuMs: frame.cpuMs, gpuMs: frame.gpuMs }),
          quality: frame.quality,
        }));
      }),
      engine.on('quality', (quality) => store.setState({ quality: quality.name })),
      engine.on('error', (error) => this.onEngineError(error))
    );

    if (commands === null) {
      bridge().log('engine has no view commands: r / 1-6 / c are disabled (see DECISIONS.md)');
    }

    // §8: "fps = frames drawn in the last second (0 when idle is correct under render-on-demand)".
    // Nothing re-renders when nothing is drawn, so the decay to zero needs its own heartbeat.
    this.tickTimer = setInterval(() => {
      store.setState((s) => ({
        tick: s.tick + 1,
        loads: loads.pruneCards(s.loads, this.now()),
        toasts: toasts.pruneToasts(s.toasts, this.now()),
      }));
    }, 500);
  }

  detach(): void {
    for (const off of this.unsubscribers.splice(0)) off();
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  private readHeap(datasets: readonly Dataset[]): Record<DatasetId, number> {
    const reporter = heapReporter(this.engine);
    if (reporter === null) return {};
    const out: Record<DatasetId, number> = {};
    for (const dataset of datasets) {
      const bytes = reporter.heapBytes(dataset.id);
      if (bytes !== undefined) out[dataset.id] = bytes;
    }
    return out;
  }

  private syncLayers(): void {
    const { engine, store } = this;
    store.setState({
      layers: [...engine.scene.layers],
      activeLayerId: engine.scene.activeLayerId,
      datasets: [...engine.scene.datasets.values()],
    });
    this.reprobeCursor();
  }

  private reprobeCursor(): void {
    const { engine, store } = this;
    const state = store.getState();
    store.setState({
      cursorProbe: engine.probe(state.cursor),
      hoverProbe: state.hover === null ? null : engine.probe(state.hover),
    });
  }

  // ------------------------------------------------------------------------------------------
  // Opening
  // ------------------------------------------------------------------------------------------

  /** Queue one or more datasets. Cards appear immediately, in request order. */
  open(requests: readonly OpenRequest[]): void {
    if (requests.length === 0) return;
    const now = this.now();
    const cards = requests.map((r) => loads.newCard(++this.ticketSeq, r.name, r.path, now));
    this.queue.push(...requests.map((r, i) => ({ ...r, ticket: cards[i]?.ticket })));
    this.store.setState((s) => ({ loads: [...s.loads, ...cards] }));
    void this.drain();
  }

  async openDialog(): Promise<void> {
    const opened = await bridge().openDialog();
    if (opened.length === 0) return;
    const requests: OpenRequest[] = [];
    for (const item of opened) {
      const request = await requestFromPath(item.path);
      if (request !== null) requests.push(request);
    }
    this.open(requests);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift() as OpenRequest & { ticket?: number };
        const ticket = next.ticket ?? 0;
        const card = this.store.getState().loads.find((c) => c.ticket === ticket);
        // Cancelled while queued: never started, so there is no worker to terminate.
        if (card === undefined || card.cancelRequested) {
          this.store.setState((s) => ({
            loads: loads.failCard(s.loads, ticket, 'cancelled before it started', this.now(), true),
          }));
          continue;
        }
        await this.runOne(next, ticket);
      }
    } finally {
      this.draining = false;
    }
  }

  private async runOne(request: OpenRequest, ticket: number): Promise<void> {
    const { store, engine } = this;
    this.inflight = { ticket, datasetId: null };
    store.setState((s) => ({ loads: loads.startCard(s.loads, ticket, this.now()) }));
    const startedAt = this.now();
    try {
      const dataset = await engine.addDataset(request.source);
      const elapsed = this.now() - startedAt;
      store.setState((s) => ({
        loads: loads.finishCard(s.loads, ticket, dataset.id, this.now()),
        lastLoadMs: { ...s.lastLoadMs, [dataset.id]: elapsed },
      }));
      // §4.7: a dataset is not a layer. Opening a file means both, and both are engine calls.
      engine.addLayer({
        datasetId: dataset.id,
        kind: dataset.kind === 'volume' ? 'volume' : 'mesh',
      });
      engine.requestRender();
    } catch (error: unknown) {
      const code = errorCode(error);
      const message = errorMessage(error);
      store.setState((s) => ({
        loads: loads.failCard(s.loads, ticket, message, this.now(), code === 'cancelled'),
      }));
      if (toasts.isToastWorthy(code)) this.toast(code, request.name, message);
    } finally {
      this.inflight = null;
    }
  }

  private onProgress(progress: LoadProgress): void {
    const inflight = this.inflight;
    if (inflight === null) return;
    if (inflight.datasetId === null) {
      inflight.datasetId = progress.datasetId;
      // Cancel was pressed before the id existed; issue it now that it does (§5 rule 6).
      const card = this.store.getState().loads.find((c) => c.ticket === inflight.ticket);
      if (card?.cancelRequested === true) this.engine.cancelDataset(progress.datasetId);
    }
    this.store.setState((s) => ({
      loads: loads.applyProgress(s.loads, inflight.ticket, progress),
    }));
  }

  private onEngineError(error: { code: string; message: string; datasetId?: DatasetId }): void {
    // A load's failure is reported by the `addDataset` rejection, which carries the request's name;
    // an error for a dataset that is not loading is one only this event knows about.
    if (this.inflight !== null) return;
    if (toasts.isToastWorthy(error.code)) this.toast(error.code, null, error.message);
  }

  private toast(code: string, name: string | null, detail: string): void {
    const title = toasts.titleForCode(code);
    this.store.setState((s) => ({
      toasts: toasts.pushToast(s.toasts, {
        id: ++this.toastSeq,
        tone: 'error',
        title: name === null ? title : `${title}: ${name}`,
        detail,
        at: this.now(),
      }),
    }));
  }

  dismissToast(id: number): void {
    this.store.setState((s) => ({ toasts: toasts.dismissToast(s.toasts, id) }));
  }

  /**
   * Cancel a load. §5 rule 6: there is no abort flag to poll, so this ends in `worker.terminate()`
   * inside the engine. A card that has not bound its `datasetId` yet records the intent instead, and
   * `onProgress` issues the call the moment the id arrives.
   */
  cancelLoad(ticket: number): void {
    const card = this.store.getState().loads.find((c) => c.ticket === ticket);
    if (card === undefined || !loads.isActive(card)) return;
    this.store.setState((s) => ({ loads: loads.requestCancel(s.loads, ticket) }));

    if (card.state === 'queued') {
      // Never started, so there is no worker to terminate — and no `addDataset` promise that would
      // ever settle this card. Dropping it from the queue without closing it here is what left the
      // card spinning at "queued" forever.
      this.queue = this.queue.filter((r) => (r as { ticket?: number }).ticket !== ticket);
      this.store.setState((s) => ({
        loads: loads.failCard(s.loads, ticket, 'cancelled before it started', this.now(), true),
      }));
      return;
    }
    // In flight. If the id is already known this is the terminate; if it is not, `onProgress` issues
    // it the moment the first progress event reveals the id.
    if (card.datasetId != null) this.engine.cancelDataset(card.datasetId);
  }

  dismissLoad(ticket: number): void {
    this.store.setState((s) => ({ loads: loads.dismissCard(s.loads, ticket) }));
  }

  // ------------------------------------------------------------------------------------------
  // Layers
  // ------------------------------------------------------------------------------------------

  setActiveLayer(id: LayerId | null): void {
    this.engine.setActiveLayer(id);
  }

  toggleVisible(id: LayerId): void {
    const layer = this.store.getState().layers.find((l) => l.id === id);
    if (layer === undefined) return;
    this.engine.updateLayer(id, { visible: !layer.visible });
    this.engine.requestRender();
  }

  setOpacity(id: LayerId, opacity: number): void {
    this.engine.updateLayer(id, { opacity: Math.max(0, Math.min(1, opacity)) });
    this.engine.requestRender();
  }

  removeLayer(id: LayerId): void {
    this.engine.removeLayer(id);
    this.engine.requestRender();
  }

  /** Close the dataset too — §5 rule 1, the only way its wasm linear memory comes back. */
  closeDataset(id: DatasetId): void {
    this.engine.removeDataset(id);
    this.engine.requestRender();
  }

  /** `delta: +1` moves the layer up the visible list (later in the bottom→top array). */
  moveLayer(id: LayerId, delta: -1 | 1): void {
    const order = this.store.getState().layers.map((l) => l.id);
    const from = order.indexOf(id);
    if (from === -1) return;
    const to = from + delta;
    if (to < 0 || to >= order.length) return;
    const next = [...order];
    next.splice(from, 1);
    next.splice(to, 0, id);
    this.engine.reorderLayers(next);
    this.engine.requestRender();
  }

  cycleActiveLayer(delta: -1 | 1): void {
    const state = this.store.getState();
    if (state.layers.length === 0) return;
    const ids = state.layers.map((l) => l.id);
    const current = ids.indexOf(state.activeLayerId ?? '');
    const next =
      current === -1
        ? delta === 1
          ? 0
          : ids.length - 1
        : (current + delta + ids.length) % ids.length;
    this.engine.setActiveLayer(ids[next] as LayerId);
  }

  stepVolumeIndex(delta: -1 | 1): void {
    const state = this.store.getState();
    const layer = activeLayer(state);
    if (layer === null || layer.kind !== 'volume') return;
    const dataset = datasetOf(state, layer);
    if (dataset === null || dataset.kind !== 'volume') return;
    const next = layer.volumeIndex + delta;
    if (next < 0 || next >= dataset.nvols) return;
    this.engine.updateLayer<VolumeLayer>(layer.id, { volumeIndex: next });
    this.engine.requestRender();
  }

  // ------------------------------------------------------------------------------------------
  // Views
  // ------------------------------------------------------------------------------------------

  setLayout(kind: LayoutKind): void {
    const { engine } = this;
    const preferred = this.store.getState().activeViewId;
    const cells = layoutCells(kind, engine.scene.slices, engine.scene.view3d, preferred);
    engine.setLayout({ kind, cells });
    const activeViewId = cells.includes(preferred ?? '') ? preferred : (cells[0] ?? null);
    this.store.setState({ layoutKind: kind, cells, activeViewId });
    engine.requestRender();
  }

  cycleLayout(): void {
    this.setLayout(nextLayout(this.store.getState().layoutKind));
  }

  setActiveView(id: ViewId): void {
    this.store.setState({ activeViewId: id });
  }

  setRadiological(on: boolean): void {
    this.engine.setRadiological(on);
    this.store.setState({ radiological: on });
    this.engine.requestRender();
  }

  toggleCrosshair(): void {
    const commands = viewCommands(this.engine);
    if (commands === null) return;
    const next = !this.store.getState().crosshair;
    commands.setAnnotations({ crosshair: next });
    this.store.setState({ crosshair: next });
    this.engine.requestRender();
  }

  resetActiveView(): void {
    const commands = viewCommands(this.engine);
    const viewId = this.store.getState().activeViewId;
    if (commands === null || viewId === null) return;
    commands.resetView(viewId);
    this.engine.requestRender();
  }

  cameraPreset(
    preset: Parameters<NonNullable<ReturnType<typeof viewCommands>>['cameraPreset']>[1]
  ): void {
    const commands = viewCommands(this.engine);
    if (commands === null) return;
    commands.cameraPreset(this.engine.scene.view3d.id, preset);
    this.engine.requestRender();
  }

  toggleOrthographic(): void {
    const view3d = this.engine.scene.view3d;
    this.engine.setView(view3d.id, {
      camera: { ...view3d.camera, orthographic: !view3d.camera.orthographic },
    });
    this.engine.requestRender();
  }

  stepCursor(steps: -1 | 1): void {
    const viewId = this.store.getState().activeViewId;
    if (viewId === null) return;
    this.engine.stepCursor(viewId, steps);
  }

  // ------------------------------------------------------------------------------------------
  // Coordinate bar (§8)
  // ------------------------------------------------------------------------------------------

  setCoordSpace(space: 'ras' | 'voxel'): void {
    this.store.setState({ coordSpace: space, coordDraft: null });
  }

  setCoordDraft(text: string | null): void {
    this.store.setState({ coordDraft: text });
  }

  /** What the field shows when the user is not editing: the cursor, in the selected space. */
  coordText(): string {
    const state = this.store.getState();
    if (state.coordDraft !== null) return state.coordDraft;
    if (state.coordSpace === 'ras') return formatTriple(state.cursor);
    const dataset = datasetOf(state, activeLayer(state));
    if (dataset === null || dataset.kind !== 'volume') return formatTriple(state.cursor);
    return formatTriple(roundVoxel(worldToVoxel(dataset.inverseAffine, state.cursor)), 0);
  }

  /** Enter in the coordinate bar. Returns false when the text is not a triple (§8: paste rules). */
  jumpToCoordinate(text: string): boolean {
    const triple = parseTriple(text);
    if (triple === null) return false;
    const state = this.store.getState();
    if (state.coordSpace === 'ras') {
      this.engine.setCursor(triple);
      return true;
    }
    const dataset = datasetOf(state, activeLayer(state));
    if (dataset === null || dataset.kind !== 'volume') return false;
    this.engine.setCursor(voxelToWorld(dataset.affine, triple));
    return true;
  }

  /** §8: the copy button yields `-42.0 18.0 6.0`. */
  async copyCoordinate(): Promise<string> {
    const text = this.coordText();
    try {
      await globalThis.navigator?.clipboard?.writeText(text);
    } catch {
      // A denied clipboard is not a reason to lose the value; the field still shows it.
    }
    return text;
  }

  async pasteCoordinate(): Promise<boolean> {
    try {
      const text = await globalThis.navigator?.clipboard?.readText();
      if (typeof text !== 'string') return false;
      this.setCoordDraft(text);
      return this.jumpToCoordinate(text);
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------------------------------
  // Screenshot (§4.7, §8)
  // ------------------------------------------------------------------------------------------

  async screenshot(): Promise<boolean> {
    const blob = await this.engine.screenshot({
      target: 'grid',
      background: 'scene',
      include: {
        colorbar: true,
        orientationLabels: true,
        crosshair: this.store.getState().crosshair,
        cornerInfo: true,
        scaleBar: false,
      },
      autoTrim: false,
      dpi: 144,
    });
    // Reading an 8-byte signature off a screenshot is not "raw file bytes on the UI thread" (§5 rule
    // 3) — the blob was produced here. It is what turns "a Blob came back" into "a PNG came back".
    const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const isPng = signature.every((b, i) => head[i] === b);
    this.store.setState({
      lastScreenshot: { bytes: blob.size, type: blob.type, isPng, at: this.now() },
    });
    if (isPng && typeof document !== 'undefined') {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `tetravox-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }
    return isPng;
  }

  // ------------------------------------------------------------------------------------------
  // §7.5 keyboard commands
  // ------------------------------------------------------------------------------------------

  runCommand(command: Command): void {
    switch (command.kind) {
      case 'cycleLayout':
        return this.cycleLayout();
      case 'toggleCrosshair':
        return this.toggleCrosshair();
      case 'resetView':
        return this.resetActiveView();
      case 'cameraPreset':
        return this.cameraPreset(command.preset);
      case 'toggleOrthographic':
        return this.toggleOrthographic();
      case 'cycleActiveLayer':
        return this.cycleActiveLayer(command.delta);
      case 'toggleActiveLayerVisible': {
        const id = this.store.getState().activeLayerId;
        if (id !== null) this.toggleVisible(id);
        return;
      }
      case 'reorderActiveLayer': {
        const id = this.store.getState().activeLayerId;
        if (id !== null) this.moveLayer(id, command.delta);
        return;
      }
      case 'stepVolumeIndex':
        return this.stepVolumeIndex(command.delta);
      case 'stepCursor':
        return this.stepCursor(command.steps);
    }
  }

  /** The four layouts the §8 toolbar offers. */
  get layouts(): readonly LayoutKind[] {
    return LAYOUT_CYCLE;
  }
}
