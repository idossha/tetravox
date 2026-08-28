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
  CoordSpaceOption,
  CoordSpaceRef,
  DatasetRef,
  Engine,
  Layer,
  LayerId,
  LayoutKind,
  LoadProgress,
  MeshLayer,
  ProbeResult,
  ScreenshotOptions,
  ViewId,
  TemplateSpace,
  ViewSpec,
  VolumeLayer,
  vec3,
} from '@tetravox/engine';
import {
  measurementFocus,
  parseTextAffine,
  sidecarPathsFor,
  subjectToMniAffine,
} from '@tetravox/engine';
import type { CoordSpace, DialogKind, RelocateRow, SettingsTab, UiStore } from './store';
import type { ScreenshotDefaults } from '../../../preload/index';
import {
  activeLayer,
  collapseAllAction,
  datasetOf,
  pruneCollapsed,
  sameSpace,
  templateSource,
  WORLD_SPACE,
} from './store';
import { requestFromPath } from '../open/sources';
import type { OpenRequest } from '../open/sources';
import type { Command } from '../keyboard/keymap';
import { LAYOUT_CYCLE, layoutCells, migrateSpecLayout, nextLayout } from '../lib/layout';
import * as loads from '../lib/loads';
import * as toasts from '../lib/toasts';
import { pushFrame } from '../lib/metrics';
import { formatTriple, parseTriple } from '../lib/coords';
import { readPngInfo } from '../lib/png';
import { baseName } from '../lib/sidecars';
import {
  defaultScenePath,
  dirName,
  layersToRestore,
  parseScene,
  relocationCandidates,
  serialiseScene,
} from '../lib/scene';
import { formatLut, fromLabelEntries, lutFileName } from '../lib/lut';
import type { LutEntry, LutFormat } from '../lib/lut';
import { bridge } from '../bridge';
// A-PROPS, appended: the clip-plane 'follow cursor' arithmetic, kept pure and unit-tested beside the
// editor that offers it (§8 forbids logic in React, not a pure function the controller calls).
import {
  anyPlaneFollowsCursor,
  planesThroughCursor,
  setClipFollowsCursor,
} from '../panels/layers/mesh/state';
import type { RegionStat, SelectionState } from '../panels/regions/regions';
import type { SceneCommand } from '../bridge';
import type { SubjectSpacesReply, SurfaceSpacesReply } from '../../../preload/index';
import { applyTheme, enginePatch, isThemeChoice, resolveTheme } from '../theme/theme';
import type { ThemeChoice } from '../theme/theme';

/** A fresh identity `mat4`, for a `TemplateSpace` that carries only a warp (directed task 8). */
function identityMat4(): Float32Array {
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

/** Squared-free distance, for the two "is this still the point we asked about" checks above. */
function dist3(a: vec3, b: vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

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
  /** Directed task 8: what main found beside each volume, so the warps can be loaded on demand. */
  private readonly subjectSpaceFiles = new Map<DatasetId, SubjectSpacesReply>();
  /** In-flight (or finished) deformation-field loads, so selecting the space twice loads once. */
  private readonly fieldLoads = new Map<DatasetId, Promise<void>>();
  /** Surfaces whose fsaverage correspondence has been attempted, so a re-render does not retry. */
  private readonly fsaverageAttached = new Set<DatasetId>();
  /** Sphere / fsaverage-surface datasets by path — one load per file, however many surfaces use it. */
  private readonly helperDatasets = new Map<string, DatasetId>();
  private readonly helperLoads = new Map<string, Promise<DatasetId | null>>();
  private ticketSeq = 0;
  private toastSeq = 0;
  /**
   * Guards `loadTheme`'s screenshot-defaults merge (directed task: unified settings, 2026-08-28)
   * against a race with a caller that edits `screenshotOptions` before that `settings()` round trip
   * resolves — `setScreenshotOptions`/`setScreenshotDefaults` flip this, and a merge that has
   * already lost the race for the user's edit must not clobber it back to the persisted default.
   */
  private screenshotOptionsTouched = false;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  /** The `prefers-color-scheme` subscription, live only while the choice is `'system'`. */
  private themeMedia: { query: MediaQueryList; off: () => void } | null = null;

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

    // §8 lists colour bars as chrome of the running product, and ROADMAP Phase 2 makes them
    // "required in screenshots". `scene/defaults.ts` starts them **off** and nothing may change an
    // existing default there — it would move every golden that layer appears in — so the app turns
    // them on for its own scene, once, at attach. The toolbar's `Bars` button is the way back off.
    // Before this, `annotations.colorbars` was false and `setAnnotations` was called from exactly
    // one place (`toggleCrosshair`), so a colour bar could not be seen in the product at all: a
    // mesh coloured by `TI_max` over [1.09e-12, 10.29] was a flat blue head with no scale.
    engine.setAnnotations({
      colorbars: store.getState().colorbars,
      // Directed task 10: same argument as the colour bars above — the engine default stays off so
      // §11's goldens do not move, and the app turns both on for its own scene, once, at attach.
      scaleBar: store.getState().scaleBar,
      orientationCube: store.getState().orientationCube,
    });
    store.setState({
      status: 'ready',
      caps: engine.caps,
      radiological: engine.scene.radiological,
      crosshair: engine.scene.annotations.crosshair,
      colorbars: engine.scene.annotations.colorbars,
      scaleBar: engine.scene.annotations.scaleBar,
      orientationCube: engine.scene.annotations.orientationCube,
      cursor: engine.scene.cursor,
      layoutKind: engine.scene.layout.kind,
      cells: engine.scene.layout.cells,
      activeViewId: engine.scene.layout.cells[0] ?? null,
      quality: engine.scene.quality.name,
    });
    // The theme, before anything is drawn: `setThemeChoice` reaches both the CSS variables and
    // `Engine.setTheme`, so the first frame carries the right chrome rather than flipping to it.
    // `loadTheme` then corrects the choice from `settings.json` if the user picked one — a promise,
    // and harmless to be late for, because main opened the window in that same theme's background.
    this.setThemeChoice(this.store.getState().themeChoice, { persist: false });
    void this.loadTheme();
    this.syncLayers();
    this.reprobeCursor();

    this.unsubscribers.push(
      engine.on('datasets', (datasets: Dataset[]) => {
        store.setState({ datasets: [...datasets], heapBytes: this.readHeap(datasets) });
        this.markDirty();
      }),
      engine.on('layers', () => {
        this.syncLayers();
        this.markDirty();
      }),
      engine.on('cursor', (world: vec3) => {
        store.setState({ cursor: world, cursorProbe: engine.probe(world), coordDraft: null });
        this.markDirty();
      }),
      // Directed task 8: an async mesh row (`locate`, `nearestVertex`) landed for a point that is
      // still the cursor or the hover. Only the probe is replaced — not the cursor, and not the
      // coordinate bar's draft, which the `cursor` handler clears and a user may be mid-way through.
      engine.on('probe', ({ world, result }: { world: vec3; result: ProbeResult }) => {
        const state = store.getState();
        if (state.hover !== null && dist3(state.hover, world) < 1e-6) {
          store.setState({ hoverProbe: result });
        }
        if (dist3(state.cursor, world) < 1e-6) store.setState({ cursorProbe: result });
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
        // §4.5's cameras have no event of their own, and a pan / orbit / dolly is exactly what
        // draws at `interacting` quality (§7.2). That makes an interacting frame the one signal the
        // app already receives for "the user is moving a camera", which is a scene change like any
        // other (directed task 13).
        if (frame.quality === 'interacting') this.markDirty();
      }),
      engine.on('quality', (quality) => store.setState({ quality: quality.name })),
      // Directed task 11: the measurement list. Its own event, so a click in measure mode does not
      // rebuild the layer panel (see `EngineEvents.measurements`).
      engine.on('measurements', (measurements) => store.setState({ measurements })),
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
    this.themeMedia?.off();
    this.themeMedia = null;
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
    const layers = [...engine.scene.layers];
    // §4.4's `iso3d` progress travels on this event, because a derived surface is not a row in
    // `Scene.layers` and has no event of its own — the engine emits `layers` when one starts or
    // finishes building (directed task 2, 2026-08-28).
    const iso3dPending: Record<LayerId, { pending: number; total: number }> = {};
    for (const layer of layers) {
      if (layer.kind !== 'volume') continue;
      const status = engine.iso3dStatus(layer.id);
      if (status.total > 0) iso3dPending[layer.id] = status;
    }
    store.setState((s) => ({
      layers,
      activeLayerId: engine.scene.activeLayerId,
      datasets: [...engine.scene.datasets.values()],
      iso3dPending,
      // A-COLLAPSE: forget the disclosure of a layer that is gone, so closing and reopening a
      // dataset does not resurrect a collapsed row. `pruneCollapsed` returns the same object when
      // there is nothing to drop, which keeps the panel from re-rendering on every layers event.
      collapsedLayers: pruneCollapsed(s.collapsedLayers, layers),
    }));
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
      //
      // The kind is the **dataset's own**, which `defaultLayerFor` decides: a Gmsh parsed view with
      // no triangles (every SimNIBS electrode net) is points, not an empty mesh surface. Naming a
      // kind here would have opened `GSN-HydroCel-185.geo` as a blank layer.
      for (const kind of layerKindsFor(dataset)) engine.addLayer({ datasetId: dataset.id, kind });
      engine.requestRender();
      // Directed task 8: ask main whether a SimNIBS `toMNI/` governs this volume. Fire-and-forget —
      // a registration that is not there, or a bridge that is not there, must not fail the load.
      if (dataset.kind === 'volume') void this.attachSubjectSpaces(dataset.id, dataset.path);
      // …and the fsaverage correspondence for a surface, when the subjects directory is set and the
      // spheres are where they should be. Silent on every miss (`attachFsaverage`).
      if (dataset.kind === 'mesh') void this.attachFsaverage(dataset.id, dataset.path);
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
    this.markDirty();
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
    this.markDirty();
    this.engine.setRadiological(on);
    this.store.setState({ radiological: on });
    this.engine.requestRender();
  }

  // ------------------------------------------------------------------------------------------
  // §8's theme switch (directed task 9, 2026-08-28)
  // ------------------------------------------------------------------------------------------

  /**
   * Adopt the persisted choice, at attach.
   *
   * The value comes from main's `settings.json` over the preload bridge, so it is a promise, so the
   * first paint happens in whatever `data-theme` the window already carried — which main chose for
   * `BrowserWindow.backgroundColor` from the same file. The two agree, so the round trip is
   * invisible; without main's half it would be a flash.
   */
  async loadTheme(): Promise<void> {
    const settings = await bridge().settings();
    this.setThemeChoice(isThemeChoice(settings.theme) ? settings.theme : 'system', {
      persist: false,
    });
    // Directed task 8's other persisted preference, and directed task 13's two, in the same round
    // trip: the recents list the settings dialog mirrors and the reopen-on-launch switch.
    const screenshotDefaults = settings.screenshotDefaults;
    this.store.setState((s) => ({
      freesurferSubjectsDir: settings.freesurferSubjectsDir,
      recentScenes: [...(settings.recentScenes ?? [])],
      reopenLastScene: settings.reopenLastScene ?? false,
      screenshotDefaults: screenshotDefaults ?? s.screenshotDefaults,
      // Merge the persisted defaults into the live options the screenshot dialog edits, so a
      // background/dpi/autoTrim set once in the settings dialog applies from the very first shot —
      // unless the caller already edited `screenshotOptions` while this round trip was in flight,
      // in which case that edit has the stronger claim (see `screenshotOptionsTouched`).
      screenshotOptions:
        screenshotDefaults === undefined || this.screenshotOptionsTouched
          ? s.screenshotOptions
          : { ...s.screenshotOptions, ...screenshotDefaults },
    }));
    void bridge()
      .configPath()
      .then((path) => this.store.setState({ configPath: path }));
  }

  // ------------------------------------------------------------------------------------------
  // §8's unified settings dialog (directed task: unified settings, 2026-08-28)
  // ------------------------------------------------------------------------------------------

  /** Open the settings dialog on a given tab; also used by "Defaults…" inside the screenshot dialog. */
  openSettingsTab(tab: SettingsTab): void {
    this.store.setState({ settingsTab: tab, dialog: 'settings' });
  }

  /**
   * Persist a screenshot-defaults patch and merge it into the live `screenshotOptions` the
   * screenshot dialog edits, so the Capture tab changes what "Screenshot" and a fresh dialog open
   * both do immediately, not just what a *future* app launch does.
   */
  async setScreenshotDefaults(patch: Partial<ScreenshotDefaults>): Promise<void> {
    this.screenshotOptionsTouched = true;
    this.store.setState((s) => ({
      screenshotDefaults: { ...s.screenshotDefaults, ...patch },
      screenshotOptions: { ...s.screenshotOptions, ...patch },
    }));
    try {
      await bridge().setSettings({
        screenshotDefaults: { ...this.store.getState().screenshotDefaults, ...patch },
      });
    } catch {
      // An unwritable preference still applies to this session (`main/settings.ts`).
    }
  }

  /** The footer's "Reveal" button: show `tetravoxrc` in the OS file manager. */
  async revealConfigFile(): Promise<void> {
    await bridge().revealConfigFile();
  }

  /** §8's settings dialog: "Reopen last scene on launch" (directed task 13). */
  async setReopenLastScene(on: boolean): Promise<void> {
    this.store.setState({ reopenLastScene: on });
    await bridge().setSettings({ reopenLastScene: on });
  }

  // ------------------------------------------------------------------------------------------
  // §8's settings dialog — the FreeSurfer subjects directory (directed task 8)
  // ------------------------------------------------------------------------------------------

  /**
   * Persist the subjects directory and re-attach fsaverage to every surface already open.
   *
   * The re-attach is the point: a user sets this *because* they are looking at a surface and want
   * the fsaverage row, and a setting that only took effect on the next file they opened would look
   * broken. `''` clears it, and every correspondence with it.
   */
  async setFreesurferSubjectsDir(dir: string): Promise<void> {
    this.store.setState({ freesurferSubjectsDir: dir });
    try {
      await bridge().setSettings({ freesurferSubjectsDir: dir });
    } catch {
      // An unwritable preference still applies to this session (`main/settings.ts`).
    }
    for (const dataset of this.store.getState().datasets) {
      if (dataset.kind !== 'mesh') continue;
      if (dir.length === 0) {
        void this.engine.attachFsaverage({ surfaceId: dataset.id, clear: true });
      } else {
        this.fsaverageAttached.delete(dataset.id);
        void this.attachFsaverage(dataset.id, dataset.path);
      }
    }
  }

  /** §8's settings dialog Browse button. Returns the chosen directory, or null when cancelled. */
  async browseFreesurferSubjectsDir(): Promise<string | null> {
    const dir = await bridge().chooseDirectory();
    if (dir === null) return null;
    await this.setFreesurferSubjectsDir(dir);
    return dir;
  }

  /**
   * Attach the fsaverage correspondence for one opened surface, when every piece is on disk.
   *
   * Fire-and-forget, and silent on every miss: a `.msh` head model, a surface with no hemisphere in
   * its name, a subject with no `sphere.reg`, an unset subjects directory and a `false` from the
   * engine are all the ordinary case, and none of them is worth a toast. The two spheres and the
   * fsaverage surface load as datasets with **no layer**, exactly like the `toMNI/` warps.
   */
  private async attachFsaverage(datasetId: DatasetId, path: string | undefined): Promise<void> {
    if (path === undefined || this.fsaverageAttached.has(datasetId)) return;
    let reply: SurfaceSpacesReply | null;
    try {
      reply = await bridge().surfaceSpaces(path);
    } catch {
      return;
    }
    if (reply === null) return;
    this.fsaverageAttached.add(datasetId);

    const load = async (p: string): Promise<DatasetId | null> => {
      // One dataset per file, however many surfaces of the hemisphere are open: `lh.sphere` is the
      // same 163,842 vertices for every subject in the session, and re-reading it per surface would
      // be the whole cost of the feature paid again for nothing.
      const cached = this.helperDatasets.get(p);
      if (cached !== undefined) return cached;
      const pending = this.helperLoads.get(p);
      if (pending !== undefined) return await pending;
      const promise = this.engine
        .addDataset({ kind: 'path', path: p })
        .then((ds) => {
          this.helperDatasets.set(p, ds.id);
          return ds.id;
        })
        .catch(() => null);
      this.helperLoads.set(p, promise);
      return await promise;
    };

    const subjectSphereId = await load(reply.subjectSphere.path);
    const fsavgSphereId = await load(reply.fsavgSphere.path);
    if (subjectSphereId === null || fsavgSphereId === null) {
      this.fsaverageAttached.delete(datasetId);
      return;
    }
    const fsavgSurfaceId =
      reply.fsavgSurface === undefined ? null : await load(reply.fsavgSurface.path);

    const ok = await this.engine.attachFsaverage({
      surfaceId: datasetId,
      subjectSphereId,
      fsavgSphereId,
      ...(fsavgSurfaceId !== null ? { fsavgSurfaceId } : {}),
      targetName: reply.targetName,
    });
    if (!ok) this.fsaverageAttached.delete(datasetId);
  }

  /**
   * §8's toolbar switch: System / Light / Dark, applied live and persisted.
   *
   * Live means *live*: the CSS variables flip under the running DOM (no reload, no remount) and the
   * engine's §7.2 chrome flips with them in the same call. Doing only the first is the failure this
   * method exists to prevent — a white toolbar over near-white orientation letters on a dark pane.
   */
  setThemeChoice(choice: ThemeChoice, opts: { persist?: boolean } = {}): void {
    this.store.setState({ themeChoice: choice });
    this.watchSystemTheme(choice);
    this.applyResolvedTheme();
    if (opts.persist !== false) void bridge().setSettings({ theme: choice });
  }

  /** Resolve the current choice, stamp it on the document, and hand it to the engine. */
  private applyResolvedTheme(): void {
    const name = resolveTheme(this.store.getState().themeChoice);
    this.store.setState({ theme: name });
    applyTheme(name);
    this.engine.setTheme(enginePatch(name));
    this.engine.requestRender();
  }

  /**
   * Follow the OS while — and only while — the choice is `'system'`.
   *
   * A listener that stayed attached under an explicit choice would be harmless today (the resolver
   * ignores the system for one) but would fire a render per OS change forever, and it is the kind of
   * subscription that outlives the thing it belonged to. `detach()` drops it either way.
   */
  private watchSystemTheme(choice: ThemeChoice): void {
    this.themeMedia?.off();
    this.themeMedia = null;
    if (choice !== 'system' || typeof globalThis.matchMedia !== 'function') return;
    const query = globalThis.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (): void => this.applyResolvedTheme();
    query.addEventListener('change', onChange);
    this.themeMedia = { query, off: () => query.removeEventListener('change', onChange) };
  }

  toggleCrosshair(): void {
    this.markDirty();
    const next = !this.store.getState().crosshair;
    this.engine.setAnnotations({ crosshair: next });
    this.store.setState({ crosshair: next });
    this.engine.requestRender();
  }

  /** §8's colour bars — one per visible scalar layer, drawn in the overlay pass (§7.2). */
  // -- measurements (directed task 11, 2026-08-28) ----------------------------------------------

  /**
   * §7.5's `m`, and the toolbar's Measure button — the same call from both.
   *
   * The mode lives in the engine; the store's copy is a projection kept in step here rather than by
   * an event, because the engine has no `measureMode` event and does not need one: nothing but this
   * method and the key that routes to it can change it.
   */
  toggleMeasureMode(): void {
    this.setMeasureMode(!this.store.getState().measureMode);
  }

  setMeasureMode(on: boolean): void {
    this.engine.setMeasureMode(on);
    this.store.setState({ measureMode: on });
    this.engine.requestRender();
  }

  /** `Esc`. Nothing already placed is touched. */
  cancelMeasurement(): void {
    this.engine.cancelMeasurement();
  }

  /** §8's panel row delete button. */
  removeMeasurement(id: string): void {
    this.engine.removeMeasurement(id);
  }

  /**
   * §8's panel row jump-to: put the cursor on the measurement, so every pane slices through it.
   *
   * The midpoint for a segment and the **vertex** for an angle (`measurementFocus`) — the point the
   * measurement is about in each case. Setting the cursor is all it takes: §4.5 derives every 2D
   * pane's plane from the cursor, so all three panes arrive at the measurement together.
   */
  jumpToMeasurement(id: string): void {
    const measurement = this.store.getState().measurements.find((m) => m.id === id);
    if (measurement === undefined) return;
    const focus = measurementFocus(measurement);
    if (focus === null) return;
    this.engine.setCursor(focus);
    this.engine.requestRender();
  }

  toggleColorbars(): void {
    this.markDirty();
    const next = !this.store.getState().colorbars;
    this.engine.setAnnotations({ colorbars: next });
    this.store.setState({ colorbars: next });
    this.engine.requestRender();
  }

  /**
   * §4.5's `scaleBar` — the millimetre rule in every 2D pane (directed task 10, 2026-08-28).
   *
   * A `ZOOM 1.42X` corner line is a ratio to a fit the reader never saw, so without this a lesion
   * measured off a screenshot is measured in pixels.
   */
  toggleScaleBar(): void {
    const next = !this.store.getState().scaleBar;
    this.engine.setAnnotations({ scaleBar: next });
    this.store.setState({ scaleBar: next });
    this.engine.requestRender();
  }

  /** §4.5's `orientationCube` — the 3D pane's clickable A/P/L/R/S/I cube (directed task 10). */
  toggleOrientationCube(): void {
    const next = !this.store.getState().orientationCube;
    this.engine.setAnnotations({ orientationCube: next });
    this.store.setState({ orientationCube: next });
    this.engine.requestRender();
  }

  resetActiveView(): void {
    this.markDirty();
    const viewId = this.store.getState().activeViewId;
    if (viewId === null) return;
    this.engine.resetView(viewId);
    this.engine.requestRender();
  }

  cameraPreset(preset: CameraPreset): void {
    this.markDirty();
    this.engine.cameraPreset(this.engine.scene.view3d.id, preset);
    this.engine.requestRender();
  }

  toggleOrthographic(): void {
    this.markDirty();
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

  /**
   * §7.5's arrows — the in-plane nudge (P2-09), as opposed to PgUp/PgDn's {@link stepCursor}.
   *
   * One `Engine` call and no arithmetic: the pane's `right` / `up` basis is engine geometry, and §8
   * puts it there ("everything the UI can do must be reachable from the `Engine` API alone. No logic
   * in React").
   */
  nudgeCursor(dx: -1 | 0 | 1, dy: -1 | 0 | 1): void {
    const viewId = this.store.getState().activeViewId;
    if (viewId === null) return;
    this.engine.nudgeCursor(viewId, dx, dy);
  }

  // ------------------------------------------------------------------------------------------
  // Coordinate bar (§8)
  // ------------------------------------------------------------------------------------------

  /**
   * Directed task 8: the space is a `CoordSpaceRef`, and every conversion is an `Engine` call.
   *
   * Phase 2's three string cases could not name a per-volume space, and §8 forbids React computing
   * one anyway ("everything the UI can do must be reachable from the `Engine` API alone"). So the
   * selector is `engine.coordinateSpaces()`, the readout is `engine.toSpace`, and Enter is
   * `engine.fromSpace` — this controller only decides what to do when one of them says null.
   */
  setCoordSpace(space: CoordSpace): void {
    this.store.setState({ coordSpace: space, coordDraft: null });
    // Selecting the nonlinear MNI space is the trigger that loads the 97 MB warp: nothing else in
    // the app needs it, and paying for it on every subject volume opened would be a second load of
    // the dataset's own size before the first picture is on screen.
    if (space.space === 'mni-nonlinear') void this.ensureDeformationFields(space.datasetId);
  }

  /** §8's selector, straight off the facade. */
  coordinateSpaces(): CoordSpaceOption[] {
    return this.engine.coordinateSpaces();
  }

  setCoordDraft(text: string | null): void {
    this.store.setState({ coordDraft: text });
  }

  /** The space the bar is actually reading in — the chosen one, or world when it stopped resolving. */
  private effectiveSpace(): { ref: CoordSpaceRef; decimals: number } {
    const state = this.store.getState();
    const options = this.engine.coordinateSpaces();
    const match = options.find((o) => sameSpace(o.ref, state.coordSpace) && o.enabled);
    if (match !== undefined) return { ref: match.ref, decimals: match.decimals };
    return { ref: WORLD_SPACE, decimals: 1 };
  }

  /** What the field shows when the user is not editing: the cursor, in the selected space. */
  coordText(): string {
    const state = this.store.getState();
    if (state.coordDraft !== null) return state.coordDraft;
    const { ref, decimals } = this.effectiveSpace();
    const value = this.engine.toSpace(ref, state.cursor);
    // A ref that stopped resolving falls back to world rather than to a stale or blank triple: the
    // bar is a laterality-safety readout, and an empty one is worse than a correct one in a
    // different space, which the selector is already showing the name of.
    return formatTriple(value ?? state.cursor, decimals);
  }

  /** Enter in the coordinate bar. Returns false when the text is not a triple (§8: paste rules). */
  jumpToCoordinate(text: string): boolean {
    const triple = parseTriple(text);
    if (triple === null) return false;
    const world = this.engine.fromSpace(this.effectiveSpace().ref, triple);
    // Null is a transform that cannot accept input (a singular registration, a warp that is not
    // loaded). Jumping to the wrong place is worse than refusing to jump.
    if (world === null) return false;
    this.engine.setCursor(world);
    return true;
  }

  // ------------------------------------------------------------------------------------------
  // Template registration (§8's MNI spaces, directed task 8)
  // ------------------------------------------------------------------------------------------

  /**
   * Attach the SimNIBS `toMNI/` registration beside a volume, when there is one.
   *
   * The **affine only**, at this point. The two warps are 97 MB and 230 MB on the reference subject
   * and nothing on screen needs them until the user asks for the nonlinear space, so they are named
   * here and loaded by {@link Controller.ensureDeformationFields}. Until then the selector lists
   * `MNI152 (nonlinear)` disabled, with "no Conform2MNI_nonl.nii.gz loaded for this subject" on it —
   * §8's rule that an unavailable space is greyed with the reason, never hidden.
   */
  private async attachSubjectSpaces(datasetId: DatasetId, path: string | undefined): Promise<void> {
    if (path === undefined) return;
    let reply: SubjectSpacesReply | null;
    try {
      reply = await bridge().subjectSpaces(path);
    } catch {
      return;
    }
    if (reply === null) return;
    this.subjectSpaceFiles.set(datasetId, reply);

    // `MNI2conform_*DOF.txt` is MNI → subject; the readout wants subject → MNI, which is its
    // inverse (`simnibs/utils/transformations.py`, `warp_coordinates`).
    const parsed = reply.affine === undefined ? null : parseTextAffine(reply.affine.text);
    const space: TemplateSpace = {
      name: 'MNI152',
      kind: 'simnibs',
      matrix: parsed === null ? identityMat4() : subjectToMniAffine(parsed),
      hasAffine: parsed !== null,
      nonlinearAvailable: reply.forwardField !== undefined,
      ...(parsed !== null && reply.affine !== undefined ? { affineFile: reply.affine.file } : {}),
    };
    this.engine.setTemplateSpace(datasetId, space);
  }

  /**
   * Load the two deformation fields for a subject, once, on demand.
   *
   * They go through `engine.addDataset` like any other volume — same worker, same `tetravox://file/…`
   * fetch, same fingerprint — but deliberately get **no layer**: nobody wants to look at a warp, and
   * `view/coord-spaces.ts` filters a referenced field out of the space menu for the same reason.
   */
  private async ensureDeformationFields(datasetId: DatasetId): Promise<void> {
    const files = this.subjectSpaceFiles.get(datasetId);
    if (files === undefined || this.fieldLoads.has(datasetId)) return;
    const dataset = this.store.getState().datasets.find((d) => d.id === datasetId);
    const existing = dataset?.kind === 'volume' ? dataset.toTemplate : undefined;
    if (existing?.forwardFieldId !== undefined) return;

    // Each field is attached **as it lands**, not after both. The forward warp is what the readout
    // needs, and it is the smaller of the two (97 MB against 230 MB); making the whole space wait
    // for the return warp would hold the number the user asked for behind one they have not asked
    // for yet.
    const attach = (patch: { forwardFieldId?: DatasetId; inverseFieldId?: DatasetId }): void => {
      const current = this.store.getState().datasets.find((d) => d.id === datasetId);
      const base = current?.kind === 'volume' ? current.toTemplate : undefined;
      if (base === undefined) return;
      this.engine.setTemplateSpace(datasetId, { ...base, ...patch });
    };

    const load = (async (): Promise<void> => {
      try {
        if (files.forwardField !== undefined) {
          const ds = await this.engine.addDataset({ kind: 'path', path: files.forwardField.path });
          attach({ forwardFieldId: ds.id });
        }
        if (files.inverseField !== undefined) {
          const ds = await this.engine.addDataset({ kind: 'path', path: files.inverseField.path });
          attach({ inverseFieldId: ds.id });
        }
      } catch (error: unknown) {
        this.toast(errorCode(error), 'toMNI warp', errorMessage(error));
      }
    })();
    this.fieldLoads.set(datasetId, load);
    await load;
  }

  /**
   * The cursor in one named space, already formatted — for the bar's permanent readout rows.
   *
   * Null when the space does not resolve, which the row renders as its `reason` rather than as a
   * blank: "MNI152 (nonlinear) — loading Conform2MNI_nonl.nii.gz…" is information, "—" is not.
   */
  coordInSpace(ref: CoordSpaceRef): string | null {
    const option = this.engine.coordinateSpaces().find((o) => sameSpace(o.ref, ref));
    const value = this.engine.toSpace(ref, this.store.getState().cursor);
    return value === null ? null : formatTriple(value, option?.decimals ?? 1);
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
      case 'nudgeCursor':
        return this.nudgeCursor(command.dx, command.dy);
      case 'toggleMeasure':
        return this.toggleMeasureMode();
      case 'cancelMeasurement':
        return this.cancelMeasurement();
    }
  }

  /** The four layouts the §8 toolbar offers. */
  get layouts(): readonly LayoutKind[] {
    return LAYOUT_CYCLE;
  }

  // ------------------------------------------------------------------------------------------
  // §8 property editors, histogram and region panel (A-PROPS) — appended, per the shared-file rule
  // per the shared-file rule. Nothing above this line changed.
  // ------------------------------------------------------------------------------------------

  /**
   * The one call every §8 property control ends in.
   *
   * The editors build a `Partial<Layer>` in a pure function (each kind's own `state.ts`,
   * `panels/layers/volume/patches.ts`, `panels/regions/regions.ts`) and hand it here; §8's "no logic
   * in React" then holds by construction, because React never sees anything but an input event and
   * this method. An empty patch is not a render: a control that resolved to no change must cost
   * nothing.
   */
  patchLayer<T extends Layer>(id: LayerId, patch: Partial<T>): void {
    if (Object.keys(patch).length === 0) return;
    this.engine.updateLayer<T>(id, patch);
    this.engine.requestRender();
  }

  /**
   * The same call, for the three §7.4 switches that are **async loads with a progress state, not
   * instant checkboxes**: the first `edges.surface`, the first element field and the first
   * `colorMode:'label'` on a given mask each make the dataset's worker build the de-indexed geometry
   * variant. The panel shows a pending badge for `key` until the engine has settled — `whenSettled()`
   * (§7.2) is the frozen facade's own "what you asked for is on screen", so the badge cannot outlive
   * the build or clear before it starts.
   */
  async patchLayerAsync<T extends Layer>(
    id: LayerId,
    patch: Partial<T>,
    key: 'edges' | 'elmField' | 'label'
  ): Promise<void> {
    if (Object.keys(patch).length === 0) return;
    this.setMeshPending(id, key, true);
    try {
      this.engine.updateLayer<T>(id, patch);
      this.engine.requestRender();
      await this.engine.whenSettled();
    } finally {
      this.setMeshPending(id, key, false);
    }
  }

  private setMeshPending(id: LayerId, key: string, on: boolean): void {
    this.store.setState((s) => {
      const current = s.meshPending[id] ?? [];
      const next = on
        ? current.includes(key)
          ? current
          : [...current, key]
        : current.filter((k) => k !== key);
      if (next.length === current.length) return {};
      const map = { ...s.meshPending };
      if (next.length === 0) delete map[id];
      else map[id] = next;
      return { meshPending: map };
    });
  }

  /**
   * Jump the cursor to a world point — R5's double-click-to-centroid, and the points panel's "go to
   * this electrode".
   */
  setCursorWorld(world: vec3): void {
    this.engine.setCursor(world);
  }

  /** Region-panel highlight. Chrome only — visibility goes through {@link patchLayer}. */
  selectRegions(layerId: LayerId, selection: SelectionState): void {
    this.store.setState((s) => ({
      regionSelection: { ...s.regionSelection, [layerId]: selection },
    }));
  }

  /** Record a `labelCentroids` (§6.5.2) result for a layer. */
  setRegionStats(layerId: LayerId, stats: readonly RegionStat[]): void {
    this.store.setState((s) => ({
      regionStats: { ...s.regionStats, [layerId]: [...stats] },
    }));
  }

  /**
   * Fill in R5's per-row voxel **count** and centroid, from §4.7's `labelCentroids`.
   *
   * The op runs in the dataset's worker (§4.3 keeps `VolumeDataset.data` on this thread "for probes
   * only", and a scan of 256×256×208 voxels is not a probe) and the engine caches it per
   * `(dataset, volumeIndex)`, so calling this once per mount is one pass over the volume for the
   * whole session. An empty answer — a layer that is not a label volume, or a worker that has gone
   * away — is recorded as such, so the panel stops asking and keeps rendering `—`.
   */
  async loadRegionStats(layerId: LayerId): Promise<void> {
    if (this.store.getState().regionStats[layerId] !== undefined) return;
    const rows = await this.engine.labelCentroids(layerId);
    this.setRegionStats(
      layerId,
      rows.map((r) => ({ id: r.id, count: r.count, centroid: r.centroid }))
    );
  }

  /**
   * 'Follow cursor' for a clip plane: while it is on, the plane's `offset` is re-derived from the
   * cursor on every `cursor` event, so the cut sweeps with the crosshair.
   *
   * The flag is `ClipPlane.followCursor` (§4.4, added by the Phase-2 integrator), so it is one
   * `updateLayer` like every other control and it survives `serialize()` / `load()`. The arithmetic
   * stays out of React either way: `planesThroughCursor` is a pure function in
   * `panels/layers/mesh/state.ts` and this class is its only caller.
   */
  setClipFollowsCursor(layerId: LayerId, index: number, on: boolean): void {
    const layer = this.store.getState().layers.find((l) => l.id === layerId);
    if (layer === undefined || layer.kind !== 'mesh') return;
    this.patchLayer<MeshLayer>(layerId, setClipFollowsCursor(layer, index, on));
    if (!on) return;
    this.ensureClipCursorSubscription();
    this.applyClipFollowsCursor(layerId);
  }

  /** Move every following plane of `layerId` — or of every layer — through the current cursor. */
  applyClipFollowsCursor(layerId?: LayerId): void {
    const state = this.store.getState();
    const cursor = state.cursor;
    for (const layer of state.layers) {
      if (layerId !== undefined && layer.id !== layerId) continue;
      if (layer.kind !== 'mesh') continue;
      const patch = planesThroughCursor(layer, cursor);
      if (Object.keys(patch).length > 0) this.engine.updateLayer<MeshLayer>(layer.id, patch);
    }
    this.engine.requestRender();
  }

  private clipCursorSubscribed = false;

  /**
   * One `cursor` subscription for every following plane, attached on first use and torn down by
   * `detach()` with the rest. One per plane would re-issue the same `updateLayer` once per plane per
   * cursor event.
   *
   * A scene **loaded** from disk can arrive with following planes without anything calling
   * `setClipFollowsCursor`, so `resyncFromEngine` arms this too.
   */
  private ensureClipCursorSubscription(): void {
    if (this.clipCursorSubscribed) return;
    this.clipCursorSubscribed = true;
    this.unsubscribers.push(
      this.engine.on('cursor', () => {
        const layers = this.store.getState().layers;
        if (!layers.some((l) => l.kind === 'mesh' && anyPlaneFollowsCursor(l))) return;
        this.applyClipFollowsCursor();
      })
    );
  }
  // ============================================================================================
  // Phase 2. Appended per the shared-file rule: new methods at
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
    this.screenshotOptionsTouched = true;
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
    this.screenshotOptionsTouched = true;
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

  /**
   * Mark the scene as changed since its last save or load — the title bar's `•`.
   *
   * A plain boolean rather than a comparison against the saved `ViewSpec`: `serialize()` walks every
   * layer and dataset, and this runs on the cursor path. Being *conservative* is the design — a
   * drag that ends where it began still marks the scene dirty, because an unnecessary save prompt
   * costs a keystroke and a missed one costs the work.
   *
   * A scene with nothing in it is never dirty: opening the app and moving the crosshair over an
   * empty grid must not offer to save an empty scene.
   */
  private markDirty(): void {
    if (this.store.getState().sceneDirty) return;
    if (this.engine.scene.datasets.size === 0) return;
    this.store.setState({ sceneDirty: true });
    this.syncTitle();
  }

  /**
   * The window title: `<scene name> • — Tetravox` (§8, directed task 13).
   *
   * `document.title` and not an IPC call: Electron mirrors it onto the `BrowserWindow`, so one
   * assignment reaches the title bar, the window menu and the macOS window list, and the E2E can
   * read it from the page it is already driving.
   */
  private syncTitle(): void {
    if (typeof document === 'undefined') return;
    const { sceneFile, sceneDirty } = this.store.getState();
    const mark = sceneDirty ? ' •' : '';
    document.title = sceneFile === null ? `Tetravox${mark}` : `${sceneFile.name}${mark} — Tetravox`;
  }

  /** Close every dataset, which is the only way their wasm heaps come back (§5 rule 1). */
  newScene(): void {
    for (const dataset of [...this.engine.scene.datasets.values()]) {
      this.engine.removeDataset(dataset.id);
    }
    this.store.setState({
      sceneFile: null,
      sceneError: null,
      sceneDirty: false,
      relocate: null,
      dialog: 'none',
      loads: [],
    });
    // "New" is an empty scene, and §4.5's measurements are scene state like everything else here —
    // removing the datasets drops their layers but says nothing about a measurement, which has no
    // dataset to be dropped with (directed task 11).
    for (const m of [...this.store.getState().measurements]) this.engine.removeMeasurement(m.id);
    this.setMeasureMode(false);
    this.syncTitle();
    this.engine.requestRender();
    this.syncLayers();
  }

  /** Save to the attached file when there is one, else fall through to Save As. */
  async saveScene(): Promise<boolean> {
    const attached = this.store.getState().sceneFile;
    if (attached === null) return this.saveSceneAs();
    return this.writeScene(attached.path);
  }

  /**
   * ⇧⌘S. The sheet opens on `<first dataset's directory>/<name>.tetravox.json` (directed task 13),
   * so the common gesture — save this beside the data I am looking at — is one keystroke and Enter.
   */
  async saveSceneAs(): Promise<boolean> {
    const path = await bridge().saveSceneDialog(defaultScenePath(this.engine.serialize()));
    if (path === null) return false;
    return this.writeScene(path);
  }

  private async writeScene(path: string): Promise<boolean> {
    // `setSceneDir` is what makes §4.6's `DatasetRef.path` relative to **this** file rather than to
    // the datasets' common directory, so a scene saved somewhere else still resolves relatively.
    this.engine.setSceneDir?.(dirName(path));
    const spec = this.engine.serialize();
    // No `measurements` extra: `Engine.serialize()` writes `Scene.measurements` itself now
    // (directed task 11), so `spec` already carries the live list — see `SceneExtras`.
    const text = serialiseScene(spec, path, { theme: this.store.getState().themeChoice });
    const result = await bridge().writeSceneFile(path, text);
    if (!result.ok) {
      const message = result.error ?? 'could not write the scene file';
      this.store.setState({ sceneError: message });
      this.toast('io', baseName(path), message);
      return false;
    }
    const saved = result.path ?? path;
    this.store.setState({
      sceneFile: { path: saved, name: baseName(saved), savedAt: this.now() },
      sceneError: null,
      sceneDirty: false,
    });
    this.syncTitle();
    void this.rememberRecent(saved);
    return true;
  }

  /**
   * Push a path to the head of File ▸ Open Recent, and mirror the list back into the store.
   *
   * Main owns `settings.json` and the menu, so this is one round trip that both persists the entry
   * and rebuilds the menu; the reply is the merged settings, which is what the settings dialog
   * renders. Failure is silent on purpose — a recent-files list that could not be written is not a
   * reason to fail a save that already landed on disk.
   */
  private async rememberRecent(path: string): Promise<void> {
    const settings = await bridge().rememberScene(path);
    if (settings !== null) this.store.setState({ recentScenes: [...settings.recentScenes] });
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
    // A scene that arrives by **drop** has never been through a dialog, so main has not admitted it
    // to the `tetravox://file/…` allow-list and `readSceneFile` would refuse it (directed task 13).
    // The call is idempotent, so the dialog and Open Recent routes — which are already admitted —
    // take the same line, and a path that no longer exists returns null here and is reported as a
    // missing file rather than as a permissions error.
    const admitted = await bridge().allowPath(scenePath);
    if (admitted === null) {
      const message = 'the scene file could not be found';
      this.reportSceneError(message, baseName(scenePath));
      return false;
    }
    const read = await bridge().readSceneFile(admitted.path);
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

  /** Show a scene failure where §8 shows one: the toolbar's scene slot, and a toast. */
  reportSceneError(message: string, name = 'scene'): void {
    this.store.setState({ sceneError: message });
    this.toast('io', name, message);
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
    // §5 directive A2: `tetravox://file/…` serves only what main has allow-listed, and `Engine.load`
    // asks the loader for each ref's §6.5.1 sidecars — derived from wherever the dataset resolved
    // to (`sidecarPathsFor`, the engine's own function, so the two cannot drift). Without this the
    // request 403s and the sidecar is silently absent again: the tissue table reads `tag 1099` and
    // the head is the fallback palette. `allowPath` doubles as the existence check, so a sidecar
    // that did not travel with its dataset is simply not listed and the load carries on without it.
    for (const ref of spec.datasets) {
      const path = resolved[ref.id];
      if (path === undefined) continue;
      for (const sidecar of Object.values(sidecarPathsFor(ref, path))) {
        if (sidecar !== undefined) await bridge().allowPath(sidecar);
      }
    }
    try {
      await this.engine.load(
        migrateSpecLayout(spec),
        (ref: DatasetRef) => resolved[ref.id] ?? null
      );
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

    // §4.6 v2's optional theme: applied when the scene names one, ignored when it does not, so a
    // scene never silently overrides a preference it said nothing about (directed task 13).
    if (spec.theme !== undefined) this.setThemeChoice(spec.theme);

    this.engine.setSceneDir?.(dirName(scenePath));
    this.engine.requestRender();
    this.resyncFromEngine();
    this.store.setState({
      sceneFile: { path: scenePath, name: baseName(scenePath), savedAt: null },
      sceneError: null,
      // A scene that has just been loaded is exactly the file on disk. The loads above emit
      // `datasets` and `layers`, which mark it dirty, so this must come **after** them.
      sceneDirty: false,
    });
    this.syncTitle();
    void this.rememberRecent(scenePath);
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
    // A loaded scene can bring `followCursor` planes with it (§4.4), and nothing called
    // `setClipFollowsCursor` to arm the subscription for them.
    if (this.engine.scene.layers.some((l) => l.kind === 'mesh' && anyPlaneFollowsCursor(l))) {
      this.ensureClipCursorSubscription();
    }
    const { engine, store } = this;
    store.setState({
      radiological: engine.scene.radiological,
      crosshair: engine.scene.annotations.crosshair,
      colorbars: engine.scene.annotations.colorbars,
      scaleBar: engine.scene.annotations.scaleBar,
      orientationCube: engine.scene.annotations.orientationCube,
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

  // ------------------------------------------------------------------------------------------
  // A-COLLAPSE (appended): the layer panel's disclosures. Chrome only — no §4.7 call belongs
  // here, because whether a row is shut is not something the engine has an opinion about.
  // ------------------------------------------------------------------------------------------

  setLayerCollapsed(id: LayerId, collapsed: boolean): void {
    this.store.setState((s) => {
      if ((s.collapsedLayers[id] === true) === collapsed) return {};
      const next = { ...s.collapsedLayers };
      if (collapsed) next[id] = true;
      else delete next[id];
      return { collapsedLayers: next };
    });
  }

  toggleLayerCollapsed(id: LayerId): void {
    this.setLayerCollapsed(id, this.store.getState().collapsedLayers[id] !== true);
  }

  /** The panel-header control: shut every row while any is open, otherwise open them all. */
  setAllLayersCollapsed(collapsed: boolean): void {
    this.store.setState((s) => {
      if (!collapsed)
        return Object.keys(s.collapsedLayers).length === 0 ? {} : { collapsedLayers: {} };
      const next: Record<LayerId, boolean> = {};
      for (const layer of s.layers) next[layer.id] = true;
      return { collapsedLayers: next };
    });
  }

  toggleAllLayersCollapsed(): void {
    this.setAllLayersCollapsed(collapseAllAction(this.store.getState()) === 'collapse');
  }
}

/** A filename-safe ISO timestamp: `:` and `.` are illegal or awkward on at least one platform. */
function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * The layers a freshly opened dataset gets, bottom→top.
 *
 * A volume is one volume layer and an ordinary mesh is one mesh layer. A Gmsh **parsed
 * post-processing view** (`.geo` / `.pos`) is whichever of the two it actually contains, and a file
 * that contains both gets both:
 *
 * * an electrode net — every SimNIBS `eeg_positions/*.geo` — has no triangles at all, so naming
 *   `'mesh'` unconditionally opened `GSN-HydroCel-185.geo` as a blank surface layer;
 * * a view with `ST`/`SQ` triangles *and* `SP` points is a field on a surface *plus* the markers
 *   drawn over it, and dropping either half silently loses data the file carries.
 *
 * The surface goes first so the markers draw over it, which is §4.4's bottom→top order and what
 * §4.4 means by electrodes over anatomy.
 *
 * Exported so it is a value a test can check, not a conditional buried in a `try`.
 */
export function layerKindsFor(dataset: Dataset): Layer['kind'][] {
  if (dataset.kind === 'volume') return ['volume'];
  const geo = dataset.geo;
  if (geo === undefined) return ['mesh'];
  const kinds: Layer['kind'][] = [];
  if (dataset.hasTris) kinds.push('mesh');
  if (geo.points.length > 0 || geo.labels.length > 0 || geo.lineSegments.length > 0) {
    kinds.push('points');
  }
  return kinds.length > 0 ? kinds : ['mesh'];
}
