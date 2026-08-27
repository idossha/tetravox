/**
 * Preload bridge (§5, §8).
 *
 * The whole surface is **paths and small JSON**. There is deliberately no `readFile`: Electron IPC
 * structured-clones over Mojo and *copies* ArrayBuffers, so a byte channel here would put a 492 MB
 * copy on the UI thread — exactly what §5 rule 3 and AGENTS rule 7 forbid. The dataset worker fetches
 * `tetravox://file/…` itself.
 *
 * Drag-and-drop uses `webUtils.getPathForFile` (§8). When it returns `''` — a `File` with no backing
 * path — the renderer must **not** call `file.arrayBuffer()`; it posts the `File` itself to the worker
 * as `LoadSource.kind: 'file'`, which is structured-cloneable and costs the UI thread nothing.
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';

export interface OpenedPath {
  path: string;
  url: string;
}

export interface TetravoxBridge {
  /** File ▸ Open… / ⌘O. Returns paths, never bytes. */
  openDialog(): Promise<OpenedPath[]>;
  /** The absolute path behind a dropped `File`, or `''` when it has none (§8 fallback). */
  getDroppedFilePath(file: File): string;
  /** Add a dropped path to the `tetravox://file/…` allow-list; returns its fetchable URL. */
  allowPath(path: string): Promise<OpenedPath | null>;
  /** Paths from CLI argv / a launch-time `open-file`, drained once. Pulled, not pushed: see main. */
  startupPaths(): Promise<OpenedPath[]>;
  /** Phase-0 gate 3: an allow-listed fixture the worker fetches over `tetravox://file/…`. */
  phase0Fixture(): Promise<OpenedPath | null>;
  /** Paths pushed from main: menu Open, CLI argv, macOS `open-file`, second instance. */
  onOpened(listener: (paths: OpenedPath[]) => void): () => void;
  /** Renderer → main-process stdout, so an e2e run and a terminal see the same log. */
  log(message: string): void;
}

const bridge: TetravoxBridge = {
  openDialog: () => ipcRenderer.invoke('tetravox:open-dialog'),
  getDroppedFilePath: (file) => webUtils.getPathForFile(file),
  allowPath: (path) => ipcRenderer.invoke('tetravox:allow-path', path),
  startupPaths: () => ipcRenderer.invoke('tetravox:startup-paths'),
  phase0Fixture: () => ipcRenderer.invoke('tetravox:phase0-fixture'),
  onOpened: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, paths: OpenedPath[]): void =>
      listener(paths);
    ipcRenderer.on('tetravox:opened', wrapped);
    return () => ipcRenderer.removeListener('tetravox:opened', wrapped);
  },
  log: (message) => ipcRenderer.send('tetravox:log', message),
};

contextBridge.exposeInMainWorld('tetravox', bridge);
