/**
 * `createModuleHost` — the one file that is a module's host **and** sees the shell (§13.1).
 *
 * The wall between a module and the app is drawn exactly here. `hostImpl.ts` imports the controller
 * and the store; every `modules/<id>/**` file imports `../host` and nothing else, enforced by an
 * ESLint rule and re-proved by a source scan in `modules.test.ts`. That is a one-file blast radius
 * for §13.9's stage 3 — an async, worker-hosted module tier changes this file and the module's
 * `await`s, and nothing in between.
 *
 * **Unwired members throw rather than lie.** `tool`, `files` and `scene.peakCentroid` are optional
 * dependencies whose defaults raise `ModuleHostError`, so a build that does not wire one reports
 * "the point tool is not available in this build" rather than silently behaving as though nothing
 * were selected. The shipping build wires all three — `ShellController.activateModule` passes the
 * engine's tool, `createHostFiles` and the engine's `peakCentroid` — and the stubs stay because the
 * distinction is what a harness and a future host version are built on.
 */

import type { Layer, LayerId, NewLayer, ProbeResult, CoordSpaceRef, vec3 } from '@tetravox/engine';
import type { ModuleManifest } from '../../../modules/manifest-types';
import type { ShellController } from '../store/controller';
import type { UiStore } from '../store/store';
import type {
  ExtensionBlock,
  ModuleEvents,
  ModuleHistory,
  ModuleHost,
  ModulePlacement,
  ModuleSceneEvent,
  PointSelection,
  PointToolSpec,
} from './host';
import { ModuleHostError } from './host';

/**
 * What the host is built over.
 *
 * `controller` and `store` are the shell. The other three are injected rather than reached for, so
 * `hostImpl.ts` stays testable without an engine and a build may legitimately ship without one of
 * them: absent, each becomes a stub that throws. They are optional rather than required-with-a-null
 * because "this build has no point tool" is a property of the build, not a value a caller chooses
 * per call.
 */
export interface ModuleHostDeps {
  controller: ShellController;
  store: UiStore;
  /** §4.7's point tool, as the four calls `host.tool` publishes. Absent: every member throws. */
  tool?: ModuleHost['tool'];
  /** `createHostFiles(manifest, allowPath)` over §5 rule 11's channels. Absent: every call rejects. */
  files?: ModuleHost['files'];
  /** The engine's `peakCentroid`, bound to a dataset lookup. Absent: it throws. */
  peakCentroid?: ModuleHost['scene']['peakCentroid'];
  /**
   * §4.3's point sampler over the dataset the module names (2026-09-03). Absent: it rejects.
   *
   * Injected like the three above, and for the same reason: `hostImpl.ts` stays testable without an
   * engine, and a build that does not wire it says so rather than answering an array of zeros.
   */
  sampleVolume?: ModuleHost['scene']['sampleVolume'];
  /** The engine's §4.7 screenshot, gated on the module being live. Absent: it rejects. */
  capture?: ModuleHost['capture'];
}

/** §13.2's cap. A block is a *record*, not a copy of the data — 256 KiB is generous for one. */
export const MAX_BLOCK_BYTES = 256 * 1024;

/** Default history depth. Bounded because a module's snapshots are whole arrays. */
const DEFAULT_HISTORY_LIMIT = 50;

/** Teardown callbacks per host, so `ModuleHost` itself keeps the shape §13.1 publishes. */
const DISPOSERS = new WeakMap<ModuleHost, (() => void)[]>();

function unavailable(what: string): never {
  throw new ModuleHostError(`${what} is not available in this build`);
}

/** The `tool` surface before P2: every member throws, none of them pretends. */
function stubTool(): ModuleHost['tool'] {
  return {
    setPointTool: (_spec: PointToolSpec | null) => unavailable('the point tool'),
    pointTool: () => unavailable('the point tool'),
    select: (_layerId: LayerId, _pointId: string | null) => unavailable('point selection'),
    selection: (): PointSelection | null => unavailable('point selection'),
  };
}

/** The `files` surface before P3: every member **rejects**, so `await` sees the same error. */
function stubFiles(): ModuleHost['files'] {
  const no = (what: string): Promise<never> =>
    Promise.reject(new ModuleHostError(`${what} is not available in this build`));
  return {
    readText: () => no('reading files'),
    siblings: () => no('sibling discovery'),
    openDialog: () => no('the open dialog'),
    saveDialog: () => no('the save dialog'),
    writeText: () => no('writing files'),
    writeBinary: () => no('writing files'),
  };
}

/** The `capture` surface before an engine is wired: it **rejects**, it does not answer an empty PNG. */
function stubCapture(): ModuleHost['capture'] {
  return {
    screenshot: () =>
      Promise.reject(new ModuleHostError('screenshots are not available in this build')),
  };
}

/**
 * A bounded undo stack.
 *
 * Snapshots, not commands: the engine has no command stack (§13.1 records that as the reason), so a
 * module's undo is "put the array back". `push` truncates the redo tail, which is what makes an edit
 * after an undo a new branch rather than a stack with a hole in it.
 */
export function createHistory<T>(limit = DEFAULT_HISTORY_LIMIT): ModuleHistory<T> {
  const past: T[] = [];
  const future: T[] = [];
  const depth = Math.max(1, Math.floor(limit));
  return {
    push(state: T): void {
      past.push(state);
      if (past.length > depth) past.shift();
      future.length = 0;
    },
    undo(): T | null {
      const previous = past.pop();
      if (previous === undefined) return null;
      future.push(previous);
      return previous;
    },
    redo(): T | null {
      const next = future.pop();
      if (next === undefined) return null;
      past.push(next);
      return next;
    },
    clear(): void {
      past.length = 0;
      future.length = 0;
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
  };
}

/** How many bytes this block's JSON is, or null when it cannot be serialised at all. */
export function blockBytes(data: unknown): number | null {
  let text: string;
  try {
    text = JSON.stringify(data ?? null);
  } catch {
    return null;
  }
  if (text === undefined) return null;
  return new TextEncoder().encode(text).length;
}

export function createModuleHost(deps: ModuleHostDeps, manifest: ModuleManifest): ModuleHost {
  const { controller, store } = deps;
  const id = manifest.id;
  const disposers: (() => void)[] = [];

  /**
   * Subscribe to one projection of the store, firing only when that projection's identity changed.
   *
   * The store is written on every cursor probe, so a listener that fired on every `setState` would
   * hand a module sixty `layers` events a second during a drag. Identity is the right comparison
   * because the controller replaces these arrays rather than mutating them (§4.4's "always replace,
   * never mutate" is the same rule the engine's instance buffers rely on).
   */
  const onProjection = <T>(
    select: (state: ReturnType<UiStore['getState']>) => T,
    cb: (value: T) => void
  ): (() => void) =>
    store.subscribe((state, previous) => {
      const next = select(state);
      if (next === select(previous)) return;
      cb(next);
    });

  const on = <E extends keyof ModuleEvents>(
    event: E,
    cb: (payload: ModuleEvents[E]) => void
  ): (() => void) => {
    const emit = cb as (payload: unknown) => void;
    switch (event) {
      case 'layers':
        return onProjection((s) => s.layers, emit);
      case 'datasets':
        return onProjection((s) => s.datasets, emit);
      case 'cursor':
        return onProjection((s) => s.cursor, emit);
      case 'sceneLoaded':
        return controller.onSceneEvent((e: ModuleSceneEvent) => {
          if (e.kind === 'loaded') emit({ blocks: e.blocks });
        });
      case 'sceneCleared':
        return controller.onSceneEvent((e: ModuleSceneEvent) => {
          if (e.kind === 'cleared') emit(undefined);
        });
      case 'pointTool':
        // The engine's own event, forwarded by `controller.attach()` the way `layers` and
        // `measurements` are — not a store projection, because a `dragEnd` is an edge and the store
        // holds no point-tool state to diff.
        return controller.onPointTool(emit);
      default:
        // Unreachable while `ModuleEvents` and this switch agree; a no-op unsubscribe rather than a
        // throw, because a module subscribes at activate time and refusing the subscription would
        // break activation rather than the feature.
        return () => {};
    }
  };

  const host: ModuleHost = {
    id,

    scene: {
      layers: (): readonly Layer[] => store.getState().layers,
      datasets: () => store.getState().datasets,
      addLayer: (spec: NewLayer): Layer => controller.addModuleLayer(id, spec),
      updateLayer: <T extends Layer>(layerId: LayerId, patch: Partial<T>): void =>
        controller.patchLayer<T>(layerId, patch),
      removeLayer: (layerId: LayerId): void => controller.removeLayer(layerId),
      cursor: (): vec3 => store.getState().cursor,
      setCursor: (world: vec3): void => controller.setCursorWorld(world),
      probe: (world: vec3): ProbeResult => controller.probeWorld(world),
      toSpace: (ref: CoordSpaceRef, world: vec3) => controller.toSpace(ref, world),
      fromSpace: (ref: CoordSpaceRef, value: vec3) => controller.fromSpace(ref, value),
      peakCentroid:
        deps.peakCentroid ??
        ((): vec3 | null => unavailable('the peak-centroid helper (`scene.peakCentroid`)')),
      // Appended 2026-09-03 with `host.ts`'s `scene.sampleVolume` (§13.1, §4.3). A **rejecting**
      // stub rather than a throwing one, because the member is a promise and a module that
      // `await`s it must see the refusal the same way it sees every other failure.
      sampleVolume:
        deps.sampleVolume ??
        ((): Promise<Float32Array> =>
          Promise.reject(
            new ModuleHostError(
              'the volume sampler (`scene.sampleVolume`) is not available in this build'
            )
          )),

      block: <T>(): T | null => {
        const block = controller.moduleBlock(id);
        return block === null ? null : (block.data as T);
      },
      setBlock: <T>(data: T | null): void => {
        if (manifest.sceneBlock === undefined) {
          throw new ModuleHostError(`${id} declares no sceneBlock in its manifest`);
        }
        if (data === null) {
          controller.setModuleBlock(id, null);
          return;
        }
        const bytes = blockBytes(data);
        if (bytes === null) throw new ModuleHostError(`${id}'s block is not JSON`);
        if (bytes > MAX_BLOCK_BYTES) {
          throw new ModuleHostError(
            `${id}'s block is ${bytes} bytes; the limit is ${MAX_BLOCK_BYTES} (§13.2)`
          );
        }
        controller.setModuleBlock(id, {
          module: id,
          version: manifest.sceneBlock.version,
          moduleVersion: manifest.version,
          data,
        } satisfies ExtensionBlock);
      },

      on,

      // Appended 2026-08-30 with `host.ts`'s `scene.activePlane` (§13.1): always wired, because the
      // controller and the store are required dependencies — there is no build in which the shell
      // exists and the active pane does not.
      activePlane: (): { normal: vec3; point: vec3 } | null => controller.activePlane(),
    },

    tool: deps.tool ?? stubTool(),
    files: deps.files ?? stubFiles(),
    capture: deps.capture ?? stubCapture(),

    ui: {
      setDirty: (dirty: boolean): void => controller.setModuleDirty(id, dirty),
      toast: (kind, text): void => controller.moduleToast(kind, manifest.title, text),
      confirm: (title, body, buttons) => controller.confirmDialog(title, body, buttons),
      status: (text: string | null): void => controller.setModuleStatus(id, text),
      // "Am I the module in the slot" — which since §13.10 is no longer the same question as "am I
      // live", and deliberately keeps its original meaning: `isActive` is what a module gates its
      // *slot* chrome on, and a popped-out module answering `true` here would draw the fold caret
      // and the aside-width layout inside its own window.
      isActive: (): boolean => store.getState().activeModule === id,

      // -- Pop-out (§13.10, 2026-08-31), appended --------------------------------------------
      // Both read `UiState.modulePlacement`, which the controller writes in the same `setState` as
      // `activeModule`, rather than a callback the controller fires: a module that never asks is
      // never told, and there is no ordering in which a module sees a placement the shell has not
      // rendered yet.
      placement: (): ModulePlacement => store.getState().modulePlacement[id] ?? 'docked',
      setPlacement: (placement: ModulePlacement): void =>
        controller.setModulePlacement(id, placement),
      onPlacement: (cb: (placement: ModulePlacement) => void): (() => void) => {
        let last = store.getState().modulePlacement[id] ?? 'docked';
        return store.subscribe((state) => {
          const next = state.modulePlacement[id] ?? 'docked';
          if (next === last) return;
          last = next;
          cb(next);
        });
      },
    },

    history: <T>(limit?: number): ModuleHistory<T> => createHistory<T>(limit),

    subscribe: (dispose: () => void): void => {
      disposers.push(dispose);
    },
  };

  DISPOSERS.set(host, disposers);
  return host;
}

/**
 * Run everything a module registered with `host.subscribe`, once.
 *
 * A separate function rather than a `dispose()` member so `ModuleHost` publishes exactly the surface
 * §13.1 describes — a module must not be able to tear its own host down and keep running against it.
 */
export function disposeModuleHost(host: ModuleHost): void {
  const disposers = DISPOSERS.get(host) ?? [];
  DISPOSERS.delete(host);
  for (const dispose of disposers.splice(0)) {
    try {
      dispose();
    } catch {
      // A module's teardown that throws must not leave the slot half-torn-down: the next disposer
      // still runs, and the shell's own cleanup in `deactivateModule` still happens.
    }
  }
}
