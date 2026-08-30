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
 * person. §13.8 records what stage 2 (runtime-loaded modules in a worker) would cost: a mechanical
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
// (types from the engine are allowed there, but one import site is one place to change for §13.8).

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
    /** This module's scene block (§13.2), or null. `≤ 256 KiB` of JSON. */
    block<T>(): T | null;
    setBlock<T>(data: T | null): void;
    on<E extends keyof ModuleEvents>(e: E, cb: (payload: ModuleEvents[E]) => void): () => void;
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
    isActive(): boolean;
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
