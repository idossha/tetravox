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

/** What `subjectSpaces` returns. Mirrors `main/subject-spaces.ts`, with the warps admitted. */
export interface SubjectSpacesReply {
  subjectDir: string;
  toMniDir: string;
  /** `MNI2conform_*DOF.txt` verbatim — MNI → subject; subject → MNI is its inverse. */
  affine?: { file: string; text: string };
  /** `Conform2MNI_nonl.nii.gz` — subject → MNI. */
  forwardField?: OpenedPath;
  /** `MNI2Conform_nonl.nii.gz` — MNI → subject. */
  inverseField?: OpenedPath;
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
  /**
   * §8's MNI spaces (directed task 8): the SimNIBS `toMNI/` registration governing an opened volume,
   * or null when there is none. The affine comes back as text; the two warps come back as
   * allow-listed URLs, so their bytes never cross this bridge (§5 rule 3).
   */
  subjectSpaces(path: string, explicitDir?: string): Promise<SubjectSpacesReply | null>;
  /** Phase-0 gate 3: an allow-listed fixture the worker fetches over `tetravox://file/…`. */
  phase0Fixture(): Promise<OpenedPath | null>;
  /** Paths pushed from main: menu Open, CLI argv, macOS `open-file`, second instance. */
  onOpened(listener: (paths: OpenedPath[]) => void): () => void;
  /** Renderer → main-process stdout, so an e2e run and a terminal see the same log. */
  log(message: string): void;

  // -- Phase 2, scene save/load (§4.6, §8) -------------------------------------------------------
  // Still **paths and small JSON**: a `ViewSpec` is a few kB, and main caps both directions at
  // `MAX_SCENE_BYTES` (`main/scene-io.ts`). Reads go through the `tetravox://file/…` allow-list;
  // writes go through a *separate* list that only the Save dialog fills, so being able to read
  // `T1.nii.gz` never implies being able to overwrite it.

  /** File ▸ Open Scene… — one `*.tetravox.json`, allow-listed for reading. */
  openSceneDialog(): Promise<OpenedPath | null>;
  /** File ▸ Save Scene As… — the chosen path, admitted for writing and nothing else. */
  saveSceneDialog(defaultName: string): Promise<string | null>;
  /** Pick a replacement for a dataset the scene could not find (§8's relocate dialog). */
  relocateDialog(missingName: string): Promise<OpenedPath | null>;
  /** Read an allow-listed scene file. `ok: false` carries the reason; it never throws. */
  readSceneFile(path: string): Promise<SceneIoResult>;
  /** Write a scene file to a path `saveSceneDialog` returned. */
  writeSceneFile(path: string, text: string): Promise<SceneIoResult>;
  /** File-menu scene commands, pushed from main. The renderer owns the `Engine`, so it does the work. */
  onSceneCommand(listener: (command: SceneCommand) => void): () => void;

  // -- App settings (directed task 9, 2026-08-28) ------------------------------------------------
  // `main/settings.ts` owns the file; §5 keeps the filesystem there. Small JSON, like everything
  // else on this bridge.

  /** The persisted preferences. Never rejects: a missing or corrupt file yields the defaults. */
  settings(): Promise<AppSettings>;
  /** Merge a patch into the file and get the result back, so a caller knows the write landed. */
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>;

  // -- The automation surface (`--job`, `main/job-runner.ts`, `docs/AUTOMATION.md`) ---------------
  // The one place bytes cross this bridge, and they are **not** file bytes: a PNG the renderer just
  // rendered off its own canvas, bounded by the window size. §5 rule 3 keeps *dataset* bytes off the
  // UI thread and out of IPC — those still reach the worker over `tetravox://file/…` — and the
  // screenshot button already reads exactly such a blob back today (`controller.saveScreenshot`).
  // Main writes the files, because main owns the filesystem.

  /** The job this window was launched for, or null on every ordinary launch. */
  jobSpec(): Promise<JobSpec | null>;
  /** Write one PNG under `--out`. The name is re-checked against the out directory in main. */
  jobWrite(name: string, bytes: Uint8Array): Promise<JobWriteResult>;
  /** Hand over a frame sequence: PNGs and a GIF always, MP4 when ffmpeg is on PATH. */
  jobFrames(payload: JobFramesPayload): Promise<JobFramesResult>;
  /** Progress, to the job runner's stdout (suppressed by `--quiet`). */
  jobLog(message: string): void;
  /** Report the run. Main writes `job-result.json` and exits 0 or 1. */
  jobDone(report: JobDonePayload): Promise<boolean>;
}

/** Mirrors `main/job.ts`'s `Job` plus the run's own two fields; kept structural, not imported. */
export interface JobSpec {
  job: {
    version?: number;
    scene: { path: string } | { files: string[]; preset: string };
    window?: { width: number; height: number };
    actions: Record<string, unknown>[];
  };
  outDir: string;
  quiet: boolean;
}

export interface JobWriteResult {
  ok: boolean;
  file?: string;
  error?: string;
}

export interface JobFramesPayload {
  base: string;
  fps: number;
  gif: boolean;
  mp4: boolean;
  colors?: number;
  frames: Uint8Array[];
}

export interface JobFramesResult {
  ok: boolean;
  files?: string[];
  warnings?: string[];
  error?: string;
}

export interface JobDonePayload {
  ok: boolean;
  outputs: { action: number; type: string; files: string[]; ms: number }[];
  warnings: string[];
  errors: string[];
  loadMs: number;
}

/** Mirrors `main/settings.ts`'s `AppSettings`; duplicated because preload must not import main. */
export interface AppSettings {
  theme: 'system' | 'light' | 'dark';
}

/** Mirrors `main/menu.ts`'s own union; duplicated because preload must not import from main. */
export type SceneCommand = 'new' | 'open' | 'save' | 'saveAs';

/** The result of the two scene-file calls; mirrors `main/scene-io.ts`'s own type. */
export interface SceneIoResult {
  ok: boolean;
  path?: string;
  text?: string;
  error?: string;
}

const bridge: TetravoxBridge = {
  openDialog: () => ipcRenderer.invoke('tetravox:open-dialog'),
  getDroppedFilePath: (file) => webUtils.getPathForFile(file),
  allowPath: (path) => ipcRenderer.invoke('tetravox:allow-path', path),
  startupPaths: () => ipcRenderer.invoke('tetravox:startup-paths'),
  subjectSpaces: (path, explicitDir) =>
    ipcRenderer.invoke('tetravox:subject-spaces', path, explicitDir),
  phase0Fixture: () => ipcRenderer.invoke('tetravox:phase0-fixture'),
  onOpened: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, paths: OpenedPath[]): void =>
      listener(paths);
    ipcRenderer.on('tetravox:opened', wrapped);
    return () => ipcRenderer.removeListener('tetravox:opened', wrapped);
  },
  log: (message) => ipcRenderer.send('tetravox:log', message),
  openSceneDialog: () => ipcRenderer.invoke('tetravox:open-scene-dialog'),
  saveSceneDialog: (defaultName) => ipcRenderer.invoke('tetravox:save-scene-dialog', defaultName),
  relocateDialog: (missingName) => ipcRenderer.invoke('tetravox:relocate-dialog', missingName),
  readSceneFile: (path) => ipcRenderer.invoke('tetravox:read-scene', path),
  writeSceneFile: (path, text) => ipcRenderer.invoke('tetravox:write-scene', path, text),
  settings: () => ipcRenderer.invoke('tetravox:settings'),
  setSettings: (patch) => ipcRenderer.invoke('tetravox:set-settings', patch),
  jobSpec: () => ipcRenderer.invoke('tetravox:job-spec'),
  jobWrite: (name, bytes) => ipcRenderer.invoke('tetravox:job-write', { name, bytes }),
  jobFrames: (payload) => ipcRenderer.invoke('tetravox:job-frames', payload),
  jobLog: (message) => ipcRenderer.send('tetravox:job-log', message),
  jobDone: (report) => ipcRenderer.invoke('tetravox:job-done', report),
  onSceneCommand: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, command: SceneCommand): void =>
      listener(command);
    ipcRenderer.on('tetravox:scene-command', wrapped);
    return () => ipcRenderer.removeListener('tetravox:scene-command', wrapped);
  },
};

contextBridge.exposeInMainWorld('tetravox', bridge);
