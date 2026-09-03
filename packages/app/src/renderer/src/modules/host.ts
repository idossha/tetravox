/**
 * `ModuleHost` — everything a module is allowed to do (ARCHITECTURE.md §13.1).
 *
 * **FROZEN (§12.3 item 6), at `MODULE_HOST_VERSION = 1`.** It was pre-freeze for exactly as long as
 * three of its members were backed by work that had not landed — `scene.peakCentroid` needed the
 * engine's bounded local read, `tool` the engine's point tool, `files` the main-process IO channels
 * — because a surface frozen before those existed would have been frozen around stubs. All three are
 * wired, so the surface is complete and this is the commit §13.1 said would freeze it. From here it
 * changes the way `api.ts` does: **additively**, with the `ARCHITECTURE.md` edit and the
 * `DECISIONS.md` entry in the same commit, and absent must reproduce the previous behaviour. A
 * breaking change bumps `MODULE_HOST_VERSION` and the registry test then refuses stale manifests.
 *
 * **Sync for the scene, async only where the app already is.** Reading and writing scene state is a
 * synchronous call into the engine through the controller, exactly as every §8 panel's is; files,
 * dialogs and confirmations are promises because they cross §5's process boundary or wait for a
 * person. §13.9 records what stage 3 (a sandboxed module in a worker) would cost: a mechanical
 * `await` pass over the modules that exist by then, not a redesign.
 *
 * **What is deliberately absent.** No `Engine`, no store, no `bridge()`, no React state. A module
 * receives this object and imports nothing else from the shell — enforced by an ESLint wall on
 * `modules/<id>/**` and re-proved by a source scan in `modules.test.ts`, because a lint rule can be
 * switched off inline and a test cannot.
 */

import type { ComponentType } from 'react';
import type {
  CoordSpaceRef,
  Dataset,
  DatasetId,
  Layer,
  LayerId,
  NewLayer,
  PointSelection,
  PointToolEvent,
  PointToolSpec,
  ProbeResult,
  vec3,
} from '@tetravox/engine';
import type { ModuleId } from '../../../modules/manifest-types';

/**
 * A module's own record inside a scene file — `ViewSpec.extensions[<moduleId>]` (§13.2).
 *
 * `data` is opaque to everything but the module that wrote it, and the rule that makes it portable is
 * that it **never contains a `LayerId` or a `DatasetId`**: both are reassigned on load, so a block
 * holding one would point at someone else's layer the second time a scene was opened. A module finds
 * its own layer by `LayerBase.module` instead.
 *
 * A build that does not carry the module keeps the block and writes it back untouched, so opening and
 * re-saving a colleague's scene never silently deletes their work.
 */
export interface ExtensionBlock {
  module: ModuleId;
  /** `manifest.sceneBlock.version` — the module's own schema version for `data`. */
  version: number;
  /** `manifest.version` — which build of the module wrote it, for provenance. */
  moduleVersion: string;
  data: unknown;
}

// -- The point tool's shapes -----------------------------------------------------------------
// **The engine's, re-exported, not restated.** `host.tool` is a facade over §4.7's five members and
// `ModuleEvents.pointTool` *is* `EngineEvents.pointTool`, so a second declaration of these three
// would be a second thing to keep in step with a frozen file. A module imports them from `../host`
// and never from `@tetravox/engine`, which is what the ESLint wall on `modules/<id>/**` requires
// (types from the engine are allowed there, but one import site is one place to change for §13.9).

export type { PointSelection, PointToolEvent, PointToolSpec };

/**
 * What a module can subscribe to.
 *
 * `layers` / `datasets` / `cursor` mirror the engine's own events; `sceneLoaded` and `sceneCleared`
 * are the app's, because loading a scene is an app gesture that spans several engine calls and a
 * module needs one edge rather than the six events those calls emit.
 */
export interface ModuleEvents {
  layers: readonly Layer[];
  datasets: readonly Dataset[];
  cursor: vec3;
  /** The engine's own `pointTool` event (§4.7), forwarded to the module in the slot. */
  pointTool: PointToolEvent;
  sceneLoaded: { blocks: Record<string, ExtensionBlock> };
  sceneCleared: void;
}

/**
 * The app-level scene edges, as one tagged union.
 *
 * `ModuleEvents` gives a module two separate subscriptions (`sceneLoaded`, `sceneCleared`); the
 * controller emits one stream and `hostImpl` splits it, because "a scene happened" is one edge in
 * the controller and two questions for a module.
 */
export type ModuleSceneEvent =
  { kind: 'loaded'; blocks: Record<string, ExtensionBlock> } | { kind: 'cleared' };

/**
 * Where a module's panel is showing (§13.10, 2026-08-31).
 *
 * `'docked'` is the §13.3 slot — one section of the right column, above the Info panel. `'window'`
 * is the module's own OS window, which exists so that several modules can be open at once and so
 * that a module needing real estate (a time-domain view, a table of a thousand contacts) can have a
 * monitor rather than 20 rem.
 *
 * **The module does not change process, thread or realm when it moves.** The popped-out window is a
 * same-origin popup the renderer portals the panel into, so `ModuleHost` stays synchronous — §12.3
 * item 6's freeze holds, and this addition is a layout fact rather than a new execution model. A
 * second `BrowserWindow` with its own renderer was the alternative and was rejected: it needs a
 * second module *instance* over one scene, and two contact editors over one electrodes table is a
 * merge conflict, not a feature.
 */
export type ModulePlacement = 'docked' | 'window';

/** A bounded undo stack over whatever snapshot a module chooses to push. */
export interface ModuleHistory<T> {
  push(state: T): void;
  undo(): T | null;
  redo(): T | null;
  clear(): void;
  canUndo(): boolean;
  canRedo(): boolean;
}

export interface ModuleHost {
  readonly id: ModuleId;

  scene: {
    layers(): readonly Layer[];
    datasets(): readonly Dataset[];
    /** Adds the layer and stamps it as this module's, so the panel shows a summary, not an editor. */
    addLayer(spec: NewLayer): Layer;
    updateLayer<T extends Layer>(id: LayerId, patch: Partial<T>): void;
    removeLayer(id: LayerId): void;
    cursor(): vec3;
    setCursor(world: vec3): void;
    probe(world: vec3): ProbeResult;
    toSpace(ref: CoordSpaceRef, w: vec3): vec3 | null;
    fromSpace(ref: CoordSpaceRef, p: vec3): vec3 | null;
    /**
     * The intensity-weighted peak inside a small box, in world millimetres.
     *
     * A §4.3 **bounded local read** (≤ 32³ voxels), not a scan — and it is the engine's arithmetic
     * (`derived/voxel-box.ts#peakCentroid`) rather than a module's precisely because §4.3 keeps
     * `VolumeDataset.data` out of reach for anything larger. `null` for a dataset that is not a
     * volume, for a query outside it, and for a box with nothing in it to weigh.
     */
    peakCentroid(datasetId: DatasetId, world: vec3, radiusMm: number): vec3 | null;
    /**
     * The dataset's scalar values at arbitrary world points (appended 2026-09-03, additively).
     *
     * `worldPoints` is `xyz` triples in world millimetres — `[x0, y0, z0, x1, y1, z1, …]`, the
     * layout a `PointsLayer`'s positions already have, so a caller hands them over unrepacked.
     * `order: 1` (the default) is trilinear, `order: 0` nearest; the answer is one value per point
     * and **`NaN` outside the volume**, never a clamp, because a clamp reports the face voxel's
     * intensity for a contact 40 mm outside the head and a `NaN` is a gap every plot already knows
     * how to draw.
     *
     * **Bounded, at 2,000,000 points** (`MAX_SAMPLE_POINTS`), and a larger request rejects with a
     * {@link ModuleHostError} rather than being truncated: this is §4.3's third read shape beside
     * the probe and the bounded box, and the cap is what keeps it from being a door to a
     * full-volume resampling loop. A caller who wants more wants a §6.5 op in the dataset's worker.
     *
     * **Where it runs.** In the renderer, in slices with a macrotask between them — *not* in a
     * worker, and the promise is what makes the yielding possible rather than a process hop. It
     * does not **block** the UI thread (a slice is ~1 ms), which is what §5 rule 6 asks for; it is
     * not off-thread either, because the only worker that already holds the volume is the §6.5
     * wasm one and every one of its ops is a frozen §6 Rust signature — a second TS worker would
     * need a second copy of a 200 MB volume, which is a worse trade than a yielding loop. Moving it
     * into such an op is the follow-up in `docs/ROADMAP.md`; nothing about this signature changes
     * when that happens, which is why it is a promise today.
     *
     * Rejects for a dataset id that is not a volume in this scene. Resolves to all-`NaN` for a
     * volume with no scalar to give (`rgb24` / `rgba32`, or samples that are not on this thread) —
     * a caller plotting three datasets wants the empty one to be a gap, not an exception.
     */
    sampleVolume(
      datasetId: DatasetId,
      worldPoints: Float32Array,
      opts?: { order?: 0 | 1; volumeIndex?: number }
    ): Promise<Float32Array>;
    /** This module's scene block (§13.2), or null. `≤ 256 KiB` of JSON. */
    block<T>(): T | null;
    setBlock<T>(data: T | null): void;
    on<E extends keyof ModuleEvents>(e: E, cb: (payload: ModuleEvents[E]) => void): () => void;

    /**
     * The plane the **active 2-D pane** is showing, or `null` when the active pane is the 3-D one
     * (appended 2026-08-30, additively; absent it was simply not askable).
     *
     * `{ normal, point }` where `point` is the cursor — §7.5's rule that a slice pane shows the
     * plane with the view's normal through the crosshair. It is here rather than derived by a
     * module for the same reason §8 forbids the app deriving a world point from a pane pixel: the
     * view's `{normal, up}` is engine state, and a module that reconstructed it from `SliceMode`
     * would be wrong on an oblique view and would not follow a rotation.
     *
     * What it is *for*: a contact editor lists each contact's distance from the plane the user is
     * looking at, which is the number that says "this one is on the slice you are on". Everything
     * else about a view — its camera, its zoom, its layer visibility — is deliberately still not
     * offered: this is the one fact a panel beside the panes has to know.
     */
    activePlane(): { normal: vec3; point: vec3 } | null;
  };

  /**
   * §7.5's point tool, as the four calls a module makes — the frozen §4.7 facade underneath.
   *
   * `select(layerId, null)` clears the selection; `setPointTool(null)` disarms and emits one
   * `cleared`. Arming **mutates the layer**: the engine materialises `p<index>` ids on a layer whose
   * points carry none, so a `layers` event fires on arm.
   */
  tool: {
    setPointTool(spec: PointToolSpec | null): void;
    pointTool(): PointToolSpec | null;
    select(layerId: LayerId, pointId: string | null): void;
    selection(): PointSelection | null;
  };

  /** §5 rule 11's four channels, through `hostFiles.ts`. Paths and small text, never bytes. */
  files: {
    readText(path: string): Promise<string | null>;
    /** Keys are the manifest's candidate templates; a value is the path that resolved, or null. */
    siblings(anchor: string): Promise<Record<string, string | null>>;
    openDialog(readerId: string): Promise<string[] | null>;
    saveDialog(
      writerId: string,
      defaultPath: string | null
    ): Promise<{ path: string; siblings: Record<string, string> } | null>;
    writeText(
      path: string,
      text: string,
      opts?: { backup?: boolean }
    ): Promise<{ ok: true; backupPath: string | null } | { ok: false; error: string }>;
    /**
     * The same write, for **PNG bytes** (appended 2026-09-03, additively).
     *
     * `.png` only and ≤ 32 MiB, and both halves are the point. The extension filter is what keeps
     * this from being a general byte channel — a module that could write any extension to a path a
     * Save sheet admitted could write a `.command` beside the table the user named — and the cap is
     * the line §5 draws between "a figure" and "a data channel": a 4096 × 4096 RGBA PNG of a 3-D
     * implant is ~6 MB, and 32 MiB is four of those.
     *
     * Everything else is {@link writeText}'s, unchanged and deliberately the same code path: the
     * same module-scoped write list, the same `.part` + rename, the same main-side `.bak` copy for
     * a writer that declared one, and the same allow-listing of the written path for reading back.
     */
    writeBinary(
      path: string,
      bytes: Uint8Array,
      opts?: { backup?: boolean }
    ): Promise<{ ok: true; backupPath: string | null } | { ok: false; error: string }>;
  };

  /**
   * **PNG bytes of what is on screen** (appended 2026-09-03, additively; absent, a module simply
   * could not ask).
   *
   * The engine's own §4.7 `screenshot` — the one File ▸ Save Screenshot and every `--job` capture
   * go through — narrowed to the four options a figure needs, so a module gets the app's picture
   * rather than one of its own. `target: 'grid'` is the whole view grid; `'view'` is one pane, and
   * `viewId` names it (omitted: the active one).
   *
   * **Limits, and why each one is here.**
   *
   * * It runs **only while the module is active** (`ui.isActive()`, or showing in its own window).
   *   A capture is a read of whatever the user has on screen, including datasets and layers this
   *   module never loaded, and a background module taking one is a screen read nobody asked for.
   * * The scene must have a view to capture. A module called before the grid exists gets a
   *   `ModuleHostError`, not a 1×1 PNG.
   * * `width`/`height` are clamped by the engine to what the drawing buffer can supersample to;
   *   omit both for the pane's own size.
   * * `background: 'transparent'` is the engine's transparent capture; `'theme'` is the scene's own
   *   background, which is what a figure that will sit in a report on white paper does **not**
   *   want by default and is therefore named rather than defaulted to.
   *
   * The bytes are a complete PNG file, ready for {@link ModuleHost.files}`.writeBinary`.
   */
  capture: {
    /**
     * Point the 3-D camera at an anatomical preset, and resolve once the engine has settled
     * (appended 2026-09-03, additively).
     *
     * The presets are §7.5's `1..6` under their anatomical names, in **RAS** — `x` is right, `y`
     * anterior, `z` superior — so `'superior'` looks straight down (`−z`) with anterior up, and
     * `'left'` puts the eye on `−x` with the nose to screen-left. They are the engine's own
     * rotations rather than a matrix an extension composes, for the reason §8 gives for every other
     * camera fact: a rotation an extension built would not be the picture the app's own `1..6` keys
     * and orientation cube produce, and a figure that disagrees with the app is worse than no
     * figure. `fit: true` refits the scene bounds first (§7.5's `r`), which is what a picture of a
     * whole implant wants and what a picture of the region the user is already looking at does not.
     *
     * **It resolves after `whenSettled()`**, so a `capture.screenshot` on the next line photographs
     * the view that was asked for rather than the one that was on screen when the call was made.
     * That is the entire reason it is a promise.
     *
     * **Nothing is restored.** There is no saved camera and no automatic undo: an extension that
     * wants four standard views calls this before each screenshot, and the user's 3-D view is left
     * at the **last preset asked for**. Restoring would be a second, invisible camera move — the
     * user would see the view snap back from a place they never asked it to go — and an extension
     * that wants the old camera back can take it by asking for a preset of its own choosing before
     * it finishes. `viewId` defaults to the 3-D view; a 2-D pane has no camera to preset and is
     * refused rather than silently ignored.
     */
    setView(
      preset: 'superior' | 'inferior' | 'left' | 'right' | 'anterior' | 'posterior',
      opts?: { viewId?: string; fit?: boolean }
    ): Promise<void>;
    screenshot(opts: {
      target: 'view' | 'grid';
      viewId?: string;
      width?: number;
      height?: number;
      background?: 'transparent' | 'theme';
    }): Promise<Uint8Array>;
  };

  ui: {
    /**
     * "This module has unsaved work." Distinct from `UiState.sceneDirty`, which any cursor click
     * sets and therefore cannot mean this (§13.3).
     */
    setDirty(dirty: boolean): void;
    toast(kind: 'info' | 'warn' | 'error', text: string): void;
    confirm(
      title: string,
      body: string,
      buttons: [string, string] | [string, string, string]
    ): Promise<0 | 1 | 2>;
    /** The module's status-bar cell. `null` removes it. Kept short — the strip does not scroll. */
    status(text: string | null): void;
    /**
     * "Am I the module in the slot." Unchanged in meaning by §13.10: a module showing in its own
     * window is live and answers `false` here, which is what a panel gating its docked-width chrome
     * wants. Ask {@link placement} for where it is showing.
     */
    isActive(): boolean;

    /**
     * Where this module's panel is showing (§13.10, appended 2026-08-31, additively).
     *
     * Absent, every module was docked, so `'docked'` is what a build without pop-out reported and
     * what a module that never asks still behaves as. A panel uses it to *reflow* — a window has the
     * room for a two-column layout the 20 rem aside does not — and for nothing else: it is a layout
     * fact, not a capability, and no host member is gated on it.
     */
    placement(): ModulePlacement;
    /**
     * Ask to be moved. The shell may dock at most one module at a time, so `setPlacement('docked')`
     * pops whatever held the slot out to its own window — nothing is ever unloaded by a move.
     *
     * A no-op when the module is already there, and — like every other move — it does not
     * re-activate: the instance, its history and its layers are the same objects afterwards.
     */
    setPlacement(placement: ModulePlacement): void;
    /** Subscribe to moves. Returns the unsubscribe, like `scene.on`. */
    onPlacement(cb: (placement: ModulePlacement) => void): () => void;
  };

  history<T>(limit?: number): ModuleHistory<T>;

  /** Register a teardown to run when the module is disposed. */
  subscribe(dispose: () => void): void;
}

/**
 * What `activate` returns: the module itself.
 *
 * `Panel` is **chrome only** — §8's "no logic in React" applies inside a module exactly as it does
 * outside it, so a panel reads module state and calls `runCommand`, and every command is one function
 * a job file can also reach through `runOperation` (§13.6). That is what keeps "there is no
 * automation-only code path" literally true.
 */
export interface ModuleInstance {
  Panel: ComponentType;
  runCommand(id: string, args?: Record<string, unknown>): void | Promise<void>;
  /** The job-file entry point (§13.6). Absent = the module declares no operations. */
  runOperation?(op: string, args: Record<string, unknown>): Promise<Record<string, unknown> | void>;
  /** A reader hit. `false` means "not mine after all" and the ordinary load carries on. */
  openPath?(readerId: string, path: string): Promise<boolean>;
  /** A sibling hit beside a dataset that just landed. Keys are the candidate templates. */
  onSibling?(anchor: string, found: Record<string, string | null>): Promise<void>;
  /** A scene carrying this module's block was opened, or the module was re-activated over one. */
  restoreBlock?(block: ExtensionBlock): Promise<void>;
  dirty(): boolean;
  dispose(): void;
}

export type ModuleActivate = (host: ModuleHost) => ModuleInstance | Promise<ModuleInstance>;

/**
 * What the host throws rather than pretending.
 *
 * A member a build does not wire throws this instead of returning a plausible-looking `null`: "this
 * build has no point tool" and "there is no point selected" must not be the same answer, or a module
 * written against the second would silently do nothing against the first. Every member is wired in
 * the shipping build; `createModuleHost`'s optional dependencies keep the distinction available to a
 * harness, and a module still uses it for its own refusals.
 */
export class ModuleHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModuleHostError';
  }
}
