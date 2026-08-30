/**
 * The §8 shell: dark theme, **left** layer panel, **centre** view grid, **right** info panel,
 * **top** toolbar, **status bar**.
 *
 * This component owns three things and nothing else:
 *  * the canvas the engine draws into, and the engine's lifetime;
 *  * the four §8 ways a file arrives — menu / ⌘O (both over IPC from main), drag-and-drop, CLI argv;
 *  * the §7.5 keyboard map, resolved by `keyboard/keymap.ts` and executed by the controller.
 *
 * Every one of those ends in an `Engine` call. There is no scene state in React.
 *
 * The canvas is created **imperatively, once**, and adopted by `ViewGrid`. A `<canvas>` rendered
 * inside a conditional branch is a different element on either side of the branch, and the engine
 * would keep drawing into the one it was handed at boot; `getContext` is sticky, so that mistake is
 * invisible until the first frame lands nowhere.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { useStore } from 'zustand';
import type { Engine } from '@tetravox/engine';
import { createEngine, engineImpl, webgl2Available } from '../engine/factory';
import { ShellController } from '../store/controller';
import { uiStore } from '../store/store';
import type { UiStore } from '../store/store';
import { isEditableTarget, resolveKey } from '../keyboard/keymap';
import { requestFromDroppedFile, requestFromPath } from '../open/sources';
import { isScenePath } from '../lib/scene';
import type { OpenRequest } from '../open/sources';
import { bridge } from '../bridge';
import { maybeRunJob } from '../automation/run';
import { ShellContext } from './context';
import { CoordinateBar } from '../panels/coordinate/CoordinateBar';
import { HeaderPanel } from '../panels/info/HeaderPanel';
import { InfoPanel } from '../panels/info/InfoPanel';
import { LayerPanel } from '../panels/layers/LayerPanel';
import { MeasurePanel } from '../panels/measure/MeasurePanel';
import { ModuleSlot } from '../modules/ModuleSlot';
import { MshOptChip } from './MshOptChip';
import { ShellDialogs } from './ShellDialogs';
import { StatusBar } from './StatusBar';
import { Toasts } from './Toasts';
import { Toolbar } from '../toolbar/Toolbar';
import { ViewGrid } from './ViewGrid';
import { Webgl2Error } from './Webgl2Error';
import { NARROW_BREAKPOINT_PX } from '../lib/panels';

/**
 * A collapsed sidebar's thin rail — a chevron and nothing else, `data-testid` per side. §8 gives the
 * sidebars no rail of their own, so this is where "collapsed" gets its 1.5rem of chrome.
 */
function PanelRail({
  side,
  testId,
  label,
  onClick,
}: {
  side: 'left' | 'right';
  testId: string;
  label: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <div
      data-testid={`${side}-panel-rail`}
      className={
        'flex w-6 flex-shrink-0 flex-col items-center bg-tvx-panel/40 py-1 ' +
        (side === 'left' ? 'border-r border-tvx-line' : 'border-l border-tvx-line')
      }
    >
      <button
        type="button"
        data-testid={testId}
        aria-label={label}
        title={label}
        className="tvx-btn tvx-btn-sm"
        onClick={onClick}
      >
        {side === 'left' ? '›' : '‹'}
      </button>
    </div>
  );
}

/** The right `<aside>`, unchanged in content — only which container renders it moved. */
function RightPanel({ onCollapse }: { onCollapse: () => void }): React.JSX.Element {
  return (
    <aside
      data-testid="right-panel"
      className="flex w-80 min-w-64 flex-col overflow-hidden border-l border-tvx-line bg-tvx-panel/40"
    >
      <div className="flex items-center justify-end border-b border-tvx-line px-1 py-0.5">
        <button
          type="button"
          data-testid="right-panel-collapse"
          aria-label="Collapse the info panel"
          title="Collapse the info panel (⌃])"
          className="tvx-btn tvx-btn-sm"
          onClick={onCollapse}
        >
          ›
        </button>
      </div>
      <CoordinateBar />
      {/* §7.6's chip is mounted here rather than inside the mesh property editor, which
        is A-PROPS's directory. It renders nothing unless the active layer is a mesh
        that had a `.msh.opt` beside it — see `MshOptChip.tsx`. */}
      <MshOptChip />
      {/* Directed task 11: the measurement list, above the info panel — it is about
        the picture rather than about the layer under the cursor, and it renders
        nothing at all while the mode is off and nothing has been placed. */}
      <MeasurePanel />
      {/* §13.3: the module slot, between the measurement strip and the Info scroller. It renders
        nothing at all with no module active — `MeasurePanel`'s idiom — so the DOM is unchanged
        while it is idle, and it sits **outside** the scroller below so its `max-h-[55%]` is a hard
        cap rather than a suggestion. */}
      <ModuleSlot />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <InfoPanel />
        <div className="border-t border-tvx-line" />
        <HeaderPanel />
      </div>
    </aside>
  );
}

export interface ShellProps {
  /** Tests mount against their own store; the app uses the singleton. */
  store?: UiStore;
}

/** `?forceWebgl2Null=1` shows the §8 error screen without needing a blocklisted driver. */
function forcedWebgl2Null(): boolean {
  return new URLSearchParams(globalThis.location?.search ?? '').get('forceWebgl2Null') === '1';
}

export function Shell({ store = uiStore }: ShellProps): React.JSX.Element {
  const [controller, setController] = useState<ShellController | null>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const impl = useMemo(() => engineImpl(), []);
  const status = useStore(store, (s) => s.status);
  // A `--job` window draws the view grid and nothing else: see `UiState.jobMode`.
  const jobMode = useStore(store, (s) => s.jobMode);
  const leftPanelCollapsed = useStore(store, (s) => s.leftPanelCollapsed);
  const rightPanelCollapsed = useStore(store, (s) => s.rightPanelCollapsed);
  // §13.3's narrow-mode rule. Below `NARROW_BREAKPOINT_PX` the right aside normally becomes a
  // temporary overlay whose backdrop closes on **any** click — including a click in a pane, which is
  // exactly what a module asks the user for. While one is active the aside therefore stays in flow.
  const moduleActive = useStore(store, (s) => s.activeModule !== null);
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  const startedRef = useRef(false);
  const startedJobRef = useRef(false);

  // ---- adaptive layout: a narrow window auto-collapses both sidebars to a rail, and the rail's
  // chevron opens the panel as a temporary overlay rather than pushing `ViewGrid` — the grid still
  // reflows on its own either way, because collapsing a sidebar is a flex-layout change to the same
  // host `ViewGrid`'s `ResizeObserver` already watches. --------------------------------------------
  const [narrow, setNarrow] = useState(
    typeof window === 'undefined'
      ? false
      : (window.matchMedia?.(`(max-width: ${NARROW_BREAKPOINT_PX}px)`)?.matches ?? false)
  );
  const [leftOverlayOpen, setLeftOverlayOpen] = useState(false);
  const [rightOverlayOpen, setRightOverlayOpen] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(`(max-width: ${NARROW_BREAKPOINT_PX}px)`);
    const onChange = (): void => setNarrow(query.matches);
    onChange();
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  // The overlay is a "narrow window" affordance only — leaving narrow mode (a resize back to a wide
  // window) is what a user expects to restore the pushed layout, not a temporary overlay left open.
  useEffect(() => {
    if (!narrow) {
      setLeftOverlayOpen(false);
      setRightOverlayOpen(false);
    }
  }, [narrow]);

  const canvas = useMemo(() => {
    const element = document.createElement('canvas');
    element.setAttribute('data-testid', 'engine-canvas');
    element.className = 'absolute inset-0 h-full w-full';
    return element;
  }, []);

  // ---- engine lifetime -------------------------------------------------------------------------
  useEffect(() => {
    // §1: a WebGL2 context is a precondition. The stand-in needs none, so only the real engine's
    // path probes for one — probing on the stand-in would hide the shell behind an error screen on
    // every GPU-less CI runner.
    if (forcedWebgl2Null() || (impl === 'real' && !webgl2Available())) {
      store.setState({ status: 'webgl2-null', impl });
      return;
    }
    let created: Engine;
    try {
      created = createEngine(canvas, { impl });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      store.setState({ status: 'failed', statusMessage: message, impl });
      setFailure(message);
      return;
    }
    store.setState({ impl });
    const next = new ShellController(created, store);
    next.attach();
    setController(next);
    setEngine(created);
    created.requestRender();
    return () => {
      next.detach();
      setController(null);
      setEngine(null);
      created.destroy();
    };
  }, [canvas, impl, store]);

  // ---- the four §8 ways a file arrives ---------------------------------------------------------
  useEffect(() => {
    if (controller === null) return;
    let cancelled = false;

    const openPaths = async (paths: readonly string[]): Promise<void> => {
      const requests: OpenRequest[] = [];
      for (const path of paths) {
        const request = await requestFromPath(path);
        if (request !== null) requests.push(request);
      }
      if (!cancelled) controller.open(requests);
    };

    // Startup paths are **pulled**: main captured CLI argv and any launch-time `open-file` before the
    // window existed, and a push on `did-finish-load` would race React's first commit. `startedRef`
    // keeps StrictMode's double-mount from draining an empty queue twice — harmless, but the log
    // line it prints is not.
    if (!startedRef.current) {
      startedRef.current = true;
      void bridge()
        .startupPaths()
        .then((opened) => openPaths(opened.map((o) => o.path)));
      // A scene named on the command line, double-clicked in Finder, or remembered by "reopen last
      // scene on launch" (directed task 13). Its own drain, because a scene *replaces* the scene
      // and the dataset route *adds* to it — main never puts both in the same launch.
      void bridge()
        .startupScene()
        .then((path) => {
          if (path !== null && !cancelled) void controller.openScenePath(path);
        });
    }

    // Runtime opens — menu Open…, ⌘O, a second instance, macOS `open-file` after ready.
    const off = bridge().onOpened((opened) => void openPaths(opened.map((o) => o.path)));
    // …and the scene half of the same routes, split by main so nothing here sniffs a filename.
    const offScene = bridge().onOpenScene((path) => {
      if (!cancelled) void controller.openScenePath(path);
    });
    // File ▸ Sample Data…: the dialog, and the download progress main pushes while it is up.
    const offSample = bridge().onOpenSampleData(() => {
      if (!cancelled) void controller.openSampleData();
    });
    const offProgress = bridge().onSampleProgress((p) => {
      if (!cancelled) controller.onSampleProgress(p);
    });
    return () => {
      cancelled = true;
      off();
      offScene();
      offSample();
      offProgress();
    };
  }, [controller]);

  // ---- `--job`: the automation runner (`automation/run.ts`, `docs/AUTOMATION.md`) ---------------
  // Asked once, after the engine exists. Every ordinary launch gets `null` back and nothing happens;
  // a `--job` launch runs the script and main exits the process from `job-done`. `startedJobRef`
  // keeps StrictMode's double-mount from starting the same job twice.
  useEffect(() => {
    if (controller === null || engine === null) return;
    if (startedJobRef.current) return;
    startedJobRef.current = true;
    void maybeRunJob({ controller, engine, store });
  }, [controller, engine, store]);

  // ---- scene commands from the File menu (§4.6, §8) ---------------------------------------------
  // Main owns the accelerators, the renderer owns the `Engine` whose `serialize()` makes the spec.
  useEffect(() => {
    if (controller === null) return;
    return bridge().onSceneCommand((command) => void controller.runSceneCommand(command));
  }, [controller]);

  // ---- Menu ▸ Settings… (⌘,/Ctrl+,), pushed from main (directed task: unified settings) --------
  useEffect(() => {
    if (controller === null) return;
    return bridge().onOpenSettings(() => controller.openSettingsTab('appearance'));
  }, [controller]);

  // ---- §7.5 keyboard map -----------------------------------------------------------------------
  useEffect(() => {
    if (controller === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      // `?` and F1 open the help sheet. They are handled *here* rather than in `keymap.ts`, which is
      // E-SCENE's file and is the §7.5 map — opening a shell panel is not a §7.5 binding. `resolveKey`
      // returns null for both, so this cannot shadow a command.
      if (
        !isEditableTarget(event.target) &&
        (event.key === '?' || event.key === 'F1') &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        event.preventDefault();
        controller.toggleKeyboardHelp();
        return;
      }
      const command = resolveKey({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        editable: isEditableTarget(event.target),
      });
      if (command === null) {
        // §13.5: the core map declined it, so the active module — if there is one — is offered the
        // chord. Nothing module-specific reaches this file: `handleModuleKey` reads the manifest and
        // answers whether it consumed the key.
        if (
          controller.handleModuleKey({
            key: event.key,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            shiftKey: event.shiftKey,
            altKey: event.altKey,
            editable: isEditableTarget(event.target),
          })
        ) {
          event.preventDefault();
        }
        return;
      }
      event.preventDefault();
      controller.runCommand(command);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [controller]);

  // ---- the E2E handle --------------------------------------------------------------------------
  useEffect(() => {
    window.__tetravox = { store, controller, engine };
    return () => {
      delete window.__tetravox;
    };
  }, [controller, engine, store]);

  // A stable context value: `controller` and `store` never change identity between renders, and an
  // inline object literal here would re-render every consumer on every keystroke in the coordinate bar.
  const shellContext = useMemo(
    () => (controller === null ? null : { controller, store }),
    [controller, store]
  );

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    if (controller === null) return;
    // `dataTransfer.files` does not survive the first `await`, so snapshot it synchronously.
    const files = Array.from(event.dataTransfer.files);
    void (async () => {
      const requests: OpenRequest[] = [];
      // A `*.tetravox.json` dropped on the window opens the **scene** (directed task 13). It is
      // decided on the `File`'s own name rather than on the path, because a drop is the one route
      // where there may be no path at all — and the last one wins, for the same reason main's
      // `sendOpened` takes the last: two scenes in one drop would show the first only to discard it.
      let scene: string | null = null;
      for (const file of files) {
        if (isScenePath(file.name)) {
          const path = bridge().getDroppedFilePath(file);
          if (path !== '') {
            scene = path;
            continue;
          }
          // No backing path: the scene file's own bytes are unreadable to us by design (§5 rule 3
          // keeps `readFile` off this bridge, and main will only read an allow-listed path).
          controller.reportSceneError(`${file.name} was dropped without a path on disk`);
          continue;
        }
        const request = await requestFromDroppedFile(file);
        if (request !== null) requests.push(request);
      }
      if (requests.length > 0) controller.open(requests);
      if (scene !== null) await controller.openScenePath(scene);
    })();
  };

  if (status === 'webgl2-null' || failure !== null) {
    return (
      <div data-testid="shell" data-engine-impl={impl} className="h-full bg-tvx-bg text-tvx-text">
        <Webgl2Error detail={failure} />
      </div>
    );
  }

  return (
    <ShellContext.Provider value={shellContext}>
      <div
        data-testid="shell"
        data-engine-impl={impl}
        data-ready={controller !== null}
        className="relative flex h-full flex-col bg-tvx-bg text-tvx-text"
        onDragOver={(event) => event.preventDefault()}
        onDrop={onDrop}
      >
        {controller === null ? (
          <div
            data-testid="shell-booting"
            className="grid h-full place-items-center text-xs text-tvx-dim"
          >
            starting the engine…
          </div>
        ) : (
          <>
            {jobMode ? null : <Toolbar />}
            <div className="flex min-h-0 flex-1">
              {jobMode ? null : (
                <div className="relative flex" data-testid="left-panel-region">
                  {narrow || leftPanelCollapsed ? (
                    // The rail stays in flow even while the overlay sits open above it — the whole
                    // point of "overlaid rather than pushing the view grid" is that opening it must
                    // not change how much flex-row width the grid gets.
                    <PanelRail
                      side="left"
                      testId="left-panel-expand"
                      label="Expand the layer panel"
                      onClick={() =>
                        narrow ? setLeftOverlayOpen(true) : controller.toggleLeftPanel()
                      }
                    />
                  ) : (
                    <LayerPanel />
                  )}
                  {narrow && leftOverlayOpen && (
                    <>
                      <div
                        data-testid="left-panel-backdrop"
                        className="fixed inset-0 z-20 bg-black/30"
                        onClick={() => setLeftOverlayOpen(false)}
                      />
                      <div className="absolute inset-y-0 left-0 z-30 shadow-xl">
                        <LayerPanel />
                      </div>
                    </>
                  )}
                </div>
              )}
              <ViewGrid canvas={canvas} dpr={dpr} />
              {jobMode ? null : (
                <div className="relative flex" data-testid="right-panel-region">
                  {(narrow && !moduleActive) || rightPanelCollapsed ? (
                    <PanelRail
                      side="right"
                      testId="right-panel-expand"
                      label="Expand the info panel"
                      onClick={() =>
                        narrow && !moduleActive
                          ? setRightOverlayOpen(true)
                          : controller.toggleRightPanel()
                      }
                    />
                  ) : (
                    <RightPanel onCollapse={() => controller.toggleRightPanel()} />
                  )}
                  {narrow && !moduleActive && rightOverlayOpen && (
                    <>
                      <div
                        data-testid="right-panel-backdrop"
                        className="fixed inset-0 z-20 bg-black/30"
                        onClick={() => setRightOverlayOpen(false)}
                      />
                      <div className="absolute inset-y-0 right-0 z-30 shadow-xl">
                        <RightPanel onCollapse={() => setRightOverlayOpen(false)} />
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
            {jobMode ? null : <StatusBar />}
            <Toasts />
            <ShellDialogs />
          </>
        )}
      </div>
    </ShellContext.Provider>
  );
}
