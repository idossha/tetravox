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
  CameraPreset,
  Dataset,
  DatasetId,
  DatasetRef,
  Engine,
  Layer,
  LayerId,
  LayoutKind,
  LoadProgress,
  MeshLayer,
  ScreenshotOptions,
  ViewId,
  ViewSpec,
  VolumeLayer,
  vec3,
} from '@tetravox/engine';
import type { CoordSpace, DialogKind, RelocateRow, UiStore } from './store';
import { activeLayer, datasetOf, templateSource } from './store';
import { requestFromPath } from '../open/sources';
import type { OpenRequest } from '../open/sources';
import type { Command } from '../keyboard/keymap';
import { LAYOUT_CYCLE, layoutCells, nextLayout } from '../lib/layout';
import * as loads from '../lib/loads';
import * as toasts from '../lib/toasts';
import { pushFrame } from '../lib/metrics';
import { formatTriple, parseTriple, roundVoxel, voxelToWorld, worldToVoxel } from '../lib/coords';
import { templateToWorld, worldToTemplate } from '../lib/coords';
import { readPngInfo } from '../lib/png';
import { baseName } from '../lib/sidecars';
import {
  defaultSceneName,
  dirName,
  layersToRestore,
  parseScene,
  relocationCandidates,
  serialiseScene,
} from '../lib/scene';
import { formatLut, fromLabelEntries, lutFileName } from '../lib/lut';
import type { LutEntry, LutFormat } from '../lib/lut';
import { bridge } from '../bridge';
import type { SceneCommand } from '../bridge';

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'io';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A request plus the ticket of the card that is already on screen for it. */
type QueuedRequest = OpenRequest & { ticket: number };

export class ShellController {
  private readonly unsubscribers: (() => void)[] = [];
  private queue: QueuedRequest[] = [];
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
    const out: Record<DatasetId, number> = {};
    for (const dataset of datasets) {
      const bytes = this.engine.heapBytes(dataset.id);
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
    this.queue.push(
      ...requests.map((r, i) => ({ ...r, ticket: (cards[i] as loads.LoadCard).ticket }))
    );
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
        const next = this.queue.shift() as QueuedRequest;
        const ticket = next.ticket;
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
      this.queue = this.queue.filter((r) => r.ticket !== ticket);
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
    const next = !this.store.getState().crosshair;
    this.engine.setAnnotations({ crosshair: next });
    this.store.setState({ crosshair: next });
    this.engine.requestRender();
  }

  resetActiveView(): void {
    const viewId = this.store.getState().activeViewId;
    if (viewId === null) return;
    this.engine.resetView(viewId);
    this.engine.requestRender();
  }

  cameraPreset(preset: CameraPreset): void {
    this.engine.cameraPreset(this.engine.scene.view3d.id, preset);
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

  /** Widened in Phase 2 to include `'mni'` (audit P2-10); `'ras'` and `'voxel'` are unchanged. */
  setCoordSpace(space: CoordSpace): void {
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
    if (state.coordSpace === 'mni') {
      // The column is offered only when a `toTemplate` exists (§8), so falling back to world here is
      // the "the user switched space and then closed that dataset" case, not a normal one.
      const source = templateSource(state);
      if (source === null) return formatTriple(state.cursor);
      return formatTriple(worldToTemplate(source.toTemplate.matrix, state.cursor));
    }
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
    if (state.coordSpace === 'mni') {
      const source = templateSource(state);
      if (source === null) return false;
      // A singular `toTemplate` cannot be inverted, and jumping to the wrong place would be worse
      // than refusing (`lib/coords.ts`), so the field rejects instead of guessing.
      const world = templateToWorld(source.toTemplate.matrix, triple);
      if (world === null) return false;
      this.engine.setCursor(world);
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

  /**
   * The toolbar's one-click screenshot.
   *
   * Phase 2 gave this a *source* for its options — `UiState.screenshotOptions`, which the §4.7
   * dialog edits — and moved the render, the PNG check and the download into `saveScreenshot`, so
   * the button and the dialog's Save take the same path and the pHYs read-back happens on both.
   * The signature and the outcome are unchanged: it resolves `true` when a PNG was produced.
   */
  screenshot(): Promise<boolean> {
    return this.saveScreenshot(this.snapshotOptions());
  }

  /** The options the dialog last left, or §8's defaults. */
  snapshotOptions(): ScreenshotOptions {
    return this.store.getState().screenshotOptions;
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

  // ============================================================================================
  // Phase 2 — A-SHELL. Appended per `docs/PHASE2-OWNERSHIP.md`'s shared-file rule: new methods at
  // the end of the class, no existing signature changed.
  // ============================================================================================

  // ------------------------------------------------------------------------------------------
  // Dialogs (§8)
  // ------------------------------------------------------------------------------------------

  openDialogKind(dialog: DialogKind): void {
    this.store.setState({ dialog });
  }

  closeDialog(): void {
    this.store.setState({ dialog: 'none' });
  }

  toggleKeyboardHelp(): void {
    this.store.setState((s) => ({ dialog: s.dialog === 'keyboard' ? 'none' : 'keyboard' }));
  }

  /** The panes the screenshot dialog's `target: 'view'` selector offers (§4.7). */
  viewIds(): ViewId[] {
    return this.engine.views.map((v) => v.id);
  }

  // ------------------------------------------------------------------------------------------
  // Screenshot, with the whole §4.7 option set (audit P2-06)
  // ------------------------------------------------------------------------------------------

  setScreenshotOptions(options: ScreenshotOptions): void {
    this.store.setState({ screenshotOptions: options });
  }

  /** Render one with these options and hand back the Blob — the dialog's Preview, unfiltered. */
  captureScreenshot(options: ScreenshotOptions): Promise<Blob> {
    return this.engine.screenshot(options);
  }

  /**
   * Render and save. §11's obligation lives here rather than only in a test: the PNG's own `pHYs`
   * chunk is **parsed** and compared with the requested DPI, and what was found is recorded on
   * `lastScreenshot`, so a `dpi` the engine silently dropped is visible in the product.
   */
  async saveScreenshot(options: ScreenshotOptions): Promise<boolean> {
    this.store.setState({ screenshotOptions: options, dialog: 'none' });
    const blob = await this.engine.screenshot(options);
    // Reading back a blob this process just produced is not "raw file bytes on the UI thread"
    // (§5 rule 3): nothing was read from disk, and a screenshot is bounded by the canvas.
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const info = readPngInfo(bytes);
    const isPng = info !== null;
    this.store.setState({
      lastScreenshot: {
        bytes: blob.size,
        type: blob.type,
        isPng,
        at: this.now(),
        ...(info === null ? {} : { width: info.width, height: info.height }),
        ...(info?.dpi === undefined ? {} : { dpi: info.dpi }),
        ...(options.dpi === undefined ? {} : { requestedDpi: options.dpi }),
      },
    });
    if (isPng) this.download(blob, `tetravox-${timestamp()}.png`);
    return isPng;
  }

  /** One `<a download>`, which main turns into a plain write (`installDownloadHandler`). */
  private download(blob: Blob, filename: string): void {
    if (typeof document === 'undefined') return;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  // ------------------------------------------------------------------------------------------
  // Scene save/load — §4.6, §8, audit P2-07
  // ------------------------------------------------------------------------------------------

  /** Close every dataset, which is the only way their wasm heaps come back (§5 rule 1). */
  newScene(): void {
    for (const dataset of [...this.engine.scene.datasets.values()]) {
      this.engine.removeDataset(dataset.id);
    }
    this.store.setState({
      sceneFile: null,
      sceneError: null,
      relocate: null,
      dialog: 'none',
      loads: [],
    });
    this.engine.requestRender();
    this.syncLayers();
  }

  /** Save to the attached file when there is one, else fall through to Save As. */
  async saveScene(): Promise<boolean> {
    const attached = this.store.getState().sceneFile;
    if (attached === null) return this.saveSceneAs();
    return this.writeScene(attached.path);
  }

  async saveSceneAs(): Promise<boolean> {
    const path = await bridge().saveSceneDialog(defaultSceneName(this.engine.serialize()));
    if (path === null) return false;
    return this.writeScene(path);
  }

  private async writeScene(path: string): Promise<boolean> {
    const spec = this.engine.serialize();
    const result = await bridge().writeSceneFile(path, serialiseScene(spec, path));
    if (!result.ok) {
      const message = result.error ?? 'could not write the scene file';
      this.store.setState({ sceneError: message });
      this.toast('io', baseName(path), message);
      return false;
    }
    this.store.setState({
      sceneFile: { path, name: baseName(path), savedAt: this.now() },
      sceneError: null,
    });
    return true;
  }

  /** File ▸ Open Scene…, and the toolbar's scene-open button. */
  async openSceneDialog(): Promise<boolean> {
    const opened = await bridge().openSceneDialog();
    if (opened === null) return false;
    return this.openScenePath(opened.path);
  }

  /**
   * Open a scene file by path.
   *
   * The resolve order is §4.6's, and the relocate dialog appears only for what none of the candidates
   * found: `path` against the scene's own directory, then `absPath`, then the basename beside the
   * scene. `bridge().allowPath` doubles as the existence check — it returns null for a path that does
   * not resolve — which is what keeps the renderer from stat-ing the filesystem itself (§5 rule 9).
   */
  async openScenePath(scenePath: string): Promise<boolean> {
    const read = await bridge().readSceneFile(scenePath);
    if (!read.ok || read.text === undefined) {
      const message = read.error ?? 'could not read the scene file';
      this.store.setState({ sceneError: message });
      this.toast('io', baseName(scenePath), message);
      return false;
    }
    const parsed = parseScene(read.text);
    if (!parsed.ok || parsed.spec === undefined) {
      const message = parsed.error ?? 'not a Tetravox scene';
      this.store.setState({ sceneError: message });
      this.toast('parse', baseName(scenePath), message);
      return false;
    }

    const spec = parsed.spec;
    const sceneDir = dirName(scenePath);
    const resolved: Record<string, string> = {};
    const missing: RelocateRow[] = [];
    for (const ref of spec.datasets) {
      const tried = relocationCandidates(ref, sceneDir);
      let found: string | null = null;
      for (const candidate of tried) {
        const allowed = await bridge().allowPath(candidate);
        if (allowed !== null) {
          found = allowed.path;
          break;
        }
      }
      if (found === null) missing.push({ ref, tried, picked: null });
      else resolved[ref.id] = found;
    }

    if (missing.length > 0) {
      // §8: "a missing dataset opens a 'relocate' dialog". The scene is not applied until the user
      // has answered — half a scene with the wrong datasets in it is worse than no scene at all.
      this.store.setState({
        relocate: { spec, scenePath, resolved, missing },
        dialog: 'relocate',
        sceneError: null,
      });
      return false;
    }
    return this.applyScene(spec, scenePath, resolved);
  }

  /** The relocate dialog's answer: one path per missing ref, `null` for the ones to skip. */
  async resolveRelocate(paths: readonly (string | null)[]): Promise<boolean> {
    const request = this.store.getState().relocate;
    if (request === null) return false;
    const resolved = { ...request.resolved };
    for (const [index, row] of request.missing.entries()) {
      const path = paths[index] ?? null;
      if (path !== null) resolved[row.ref.id] = path;
    }
    this.store.setState({ relocate: null, dialog: 'none' });
    return this.applyScene(request.spec, request.scenePath, resolved);
  }

  cancelRelocate(): void {
    this.store.setState({ relocate: null, dialog: 'none' });
  }

  /** Open the OS picker for one missing ref; returns the path the user chose, or null. */
  async pickRelocation(ref: DatasetRef): Promise<string | null> {
    const opened = await bridge().relocateDialog(ref.name);
    return opened === null ? null : opened.path;
  }

  /**
   * Hand the spec to `Engine.load`, then reconcile.
   *
   * Two things happen after `load` that are the shell's and not the engine's. **The dataset-id
   * remap**: `load` re-adds datasets with fresh ids, so the spec's ids mean nothing afterwards and
   * the map from one to the other is built from the path each ref resolved to — the same path that
   * was handed to `resolve`. **The layer reconcile** (`lib/scene.ts`): `Engine.load` does not restore
   * `spec.layers` today (audit P2-07, E-SCENE's), so the shell asks for the layers that are missing.
   * When P2-07 lands, `layersToRestore` finds counterparts and returns nothing.
   */
  private async applyScene(
    spec: ViewSpec,
    scenePath: string,
    resolved: Record<string, string>
  ): Promise<boolean> {
    this.newScene();
    try {
      await this.engine.load(spec, (ref: DatasetRef) => resolved[ref.id] ?? null);
    } catch (error: unknown) {
      const message = errorMessage(error);
      this.store.setState({ sceneError: message });
      this.toast(errorCode(error), baseName(scenePath), message);
      return false;
    }

    const byPath = new Map<string, DatasetId>();
    for (const dataset of this.engine.scene.datasets.values()) {
      if (dataset.path !== undefined) byPath.set(dataset.path, dataset.id);
    }
    const datasetIdMap = new Map<string, DatasetId>();
    for (const ref of spec.datasets) {
      const path = resolved[ref.id];
      const live = path === undefined ? undefined : byPath.get(path);
      if (live !== undefined) datasetIdMap.set(ref.id, live);
    }

    for (const add of layersToRestore({
      specLayers: spec.layers,
      liveLayers: this.engine.scene.layers,
      datasetIdMap,
    })) {
      this.engine.addLayer({
        ...(add.patch as Partial<Layer>),
        datasetId: add.datasetId,
        kind: add.kind,
      });
    }

    // `activeLayerId` cannot be assigned from the spec — those ids went with the old datasets — so
    // it is re-derived positionally, which carries the same information the spec had.
    const specIndex = spec.layers.findIndex((l) => l.id === spec.activeLayerId);
    const live = this.engine.scene.layers;
    if (specIndex >= 0 && specIndex < live.length) {
      this.engine.setActiveLayer((live[specIndex] as Layer).id);
    }

    this.engine.requestRender();
    this.resyncFromEngine();
    this.store.setState({
      sceneFile: { path: scenePath, name: baseName(scenePath), savedAt: null },
      sceneError: null,
    });
    return true;
  }

  /**
   * Re-read the scene projections the store caches.
   *
   * `Engine.load` writes cursor, layout and the radiological flag straight into the scene store
   * without emitting `cursor` or `layers` for each, so after a load the UI's projections would still
   * describe the previous scene. Everything read here comes from `engine.scene`; nothing is computed.
   */
  private resyncFromEngine(): void {
    const { engine, store } = this;
    store.setState({
      radiological: engine.scene.radiological,
      crosshair: engine.scene.annotations.crosshair,
      cursor: engine.scene.cursor,
      layoutKind: engine.scene.layout.kind,
      cells: [...engine.scene.layout.cells],
      activeViewId: engine.scene.layout.cells[0] ?? null,
      quality: engine.scene.quality.name,
    });
    this.syncLayers();
  }

  /** The File menu's scene commands, pushed from main (`main/menu.ts`). */
  async runSceneCommand(command: SceneCommand): Promise<void> {
    switch (command) {
      case 'new':
        return this.newScene();
      case 'open':
        await this.openSceneDialog();
        return;
      case 'save':
        await this.saveScene();
        return;
      case 'saveAs':
        await this.saveSceneAs();
        return;
    }
  }

  // ------------------------------------------------------------------------------------------
  // Coordinate bar — the MNI column (audit P2-10)
  // ------------------------------------------------------------------------------------------

  /** `VolumeDataset.toTemplate` for the MNI column, or null when no loaded volume carries one. */
  templateSource(): ReturnType<typeof templateSource> {
    return templateSource(this.store.getState());
  }

  // ------------------------------------------------------------------------------------------
  // `.msh.opt` defaults chip + Reset (§7.6; audit P2-11)
  // ------------------------------------------------------------------------------------------

  /**
   * Re-seed a mesh layer from its `.msh.opt` sidecar.
   *
   * §7.6: "`<mesh>.msh.opt` seeds tag colours/visibility, field range, colormap and colorbar on open,
   * with a 'defaults from X.msh.opt' chip and a one-click Reset." E-SCENE owns the *seeding* in
   * `scene/fromMeta.ts`; this is the Reset, and it re-applies the same source — `MeshDataset.opt`,
   * which lives on the dataset and is therefore still intact after the user has edited the layer.
   *
   * `MshOptions.tagColor` is already 0..1 (§4.1 converts once, in `fromMeta`), so this copies the
   * colours through without arithmetic. A second `/255` here is exactly the bug §4.1 forbids.
   */
  resetMeshOptDefaults(layerId: LayerId): boolean {
    const state = this.store.getState();
    const layer = state.layers.find((l) => l.id === layerId);
    if (layer === undefined || layer.kind !== 'mesh') return false;
    const dataset = state.datasets.find((d) => d.id === layer.datasetId);
    if (dataset === undefined || dataset.kind !== 'mesh' || dataset.opt === undefined) return false;

    const opt = dataset.opt;
    const tagStyle: MeshLayer['tagStyle'] = {};
    for (const tag of dataset.tags) {
      const color = opt.tagColor[tag.id];
      tagStyle[tag.id] = {
        visible: opt.tagVisible[tag.id] ?? true,
        opacity: 1,
        ...(color === undefined ? {} : { color }),
      };
    }
    const view = opt.views[0];
    const patch: Partial<MeshLayer> = { tagStyle };
    if (view?.customMin !== undefined && view.customMax !== undefined) {
      patch.scale = { kind: 'linear', lo: view.customMin, hi: view.customMax };
    }
    if (view?.showScale !== undefined) patch.showColorbar = view.showScale;
    this.engine.updateLayer<MeshLayer>(layerId, patch);
    this.engine.requestRender();
    return true;
  }

  // ------------------------------------------------------------------------------------------
  // R5 — "Save LUT…": export the edited label colours
  // ------------------------------------------------------------------------------------------

  /**
   * The rows a "Save LUT…" would write for one layer, or null when it has no label table.
   *
   * Three sources, matching R5's "one Region panel for every labelled thing": a label **volume**'s
   * `labelTable`, a mesh layer's `label.table` for `.annot` / `.label.gii`, and a mesh's **tissue
   * tags**, where an edited colour lives on `tagStyle[id].color` and the name on `MeshTag.name`.
   * A-PROPS's colour picker writes into exactly those three places, so this reads edits without
   * needing a second copy of them.
   */
  lutEntriesFor(layerId: LayerId): LutEntry[] | null {
    const state = this.store.getState();
    const layer = state.layers.find((l) => l.id === layerId);
    if (layer === undefined) return null;
    const dataset = state.datasets.find((d) => d.id === layer.datasetId);
    if (dataset === undefined) return null;

    if (layer.kind === 'volume' && dataset.kind === 'volume') {
      const table = dataset.labelTable;
      return table === undefined ? null : fromLabelEntries(table.entries);
    }
    if (layer.kind === 'mesh' && dataset.kind === 'mesh') {
      if (layer.label !== undefined) return fromLabelEntries(layer.label.table.entries);
      if (dataset.tags.length === 0) return null;
      return dataset.tags.map((tag) => ({
        id: tag.id,
        name: tag.name ?? `tag_${tag.id}`,
        color: layer.tagStyle[tag.id]?.color ?? tag.color,
      }));
    }
    return null;
  }

  /** Write a layer's label colours out as a LUT §7.6's own parsers can read back. */
  async saveLut(layerId: LayerId, format: LutFormat = 'simnibs'): Promise<boolean> {
    const entries = this.lutEntriesFor(layerId);
    if (entries === null || entries.length === 0) {
      this.store.setState({ sceneError: 'that layer has no label table to export' });
      return false;
    }
    const layer = this.store.getState().layers.find((l) => l.id === layerId);
    const path = await bridge().saveSceneDialog(lutFileName(layer?.name ?? 'labels'));
    if (path === null) return false;
    const result = await bridge().writeSceneFile(path, formatLut(entries, format));
    if (!result.ok) {
      const message = result.error ?? 'could not write the LUT';
      this.store.setState({ sceneError: message });
      this.toast('io', baseName(path), message);
      return false;
    }
    this.store.setState({ sceneError: null });
    return true;
  }

  // ------------------------------------------------------------------------------------------
  // Header panel (§8: the raw header, `VolumeDataset.headerJson`, verbatim)
  // ------------------------------------------------------------------------------------------

  setHeaderDataset(id: DatasetId | null): void {
    this.store.setState({ headerDatasetId: id });
  }
}

/** A filename-safe ISO timestamp: `:` and `.` are illegal or awkward on at least one platform. */
function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
