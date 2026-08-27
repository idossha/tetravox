/**
 * The §8 shell: dark theme, **left** layer panel, **centre** view grid, **right** info panel,
 * **top** toolbar, **status bar**.
 *
 * This component owns three things and nothing else:
 *  * the canvas the engine draws into, and the engine's lifetime;
 *  * the four §8 ways a file arrives — menu / ⌘O (both over IPC from main), drag-and-drop, CLI argv;
 *  * the §7.5 keyboard map, resolved by `lib/keymap.ts` and executed by the controller.
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
import { isEditableTarget, resolveKey } from '../lib/keymap';
import { requestFromDroppedFile, requestFromPath } from '../open/sources';
import type { OpenRequest } from '../open/sources';
import { bridge } from '../bridge';
import { ShellContext } from './context';
import { CoordinateBar } from './CoordinateBar';
import { InfoPanel } from './InfoPanel';
import { LayerPanel } from './LayerPanel';
import { StatusBar } from './StatusBar';
import { Toasts } from './Toasts';
import { Toolbar } from './Toolbar';
import { ViewGrid } from './ViewGrid';
import { Webgl2Error } from './Webgl2Error';

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
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  const startedRef = useRef(false);

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
    }

    // Runtime opens — menu Open…, ⌘O, a second instance, macOS `open-file` after ready.
    const off = bridge().onOpened((opened) => void openPaths(opened.map((o) => o.path)));
    return () => {
      cancelled = true;
      off();
    };
  }, [controller]);

  // ---- §7.5 keyboard map -----------------------------------------------------------------------
  useEffect(() => {
    if (controller === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      const command = resolveKey({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        editable: isEditableTarget(event.target),
      });
      if (command === null) return;
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

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    if (controller === null) return;
    // `dataTransfer.files` does not survive the first `await`, so snapshot it synchronously.
    const files = Array.from(event.dataTransfer.files);
    void (async () => {
      const requests: OpenRequest[] = [];
      for (const file of files) {
        const request = await requestFromDroppedFile(file);
        if (request !== null) requests.push(request);
      }
      controller.open(requests);
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
    <ShellContext.Provider value={controller === null ? null : { controller, store }}>
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
            <Toolbar />
            <div className="flex min-h-0 flex-1">
              <LayerPanel />
              <ViewGrid canvas={canvas} dpr={dpr} />
              <aside
                data-testid="right-panel"
                className="flex w-80 min-w-64 flex-col overflow-hidden border-l border-tvx-line bg-tvx-panel/40"
              >
                <CoordinateBar />
                <InfoPanel />
              </aside>
            </div>
            <StatusBar />
            <Toasts />
          </>
        )}
      </div>
    </ShellContext.Provider>
  );
}
