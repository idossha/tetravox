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

/** What `surfaceSpaces` returns. Mirrors `main/surface-spaces.ts`, with each file admitted. */
export interface SurfaceSpacesReply {
  hemisphere: 'lh' | 'rh';
  /** What to call the target in the readout, e.g. `fsaverage lh.pial`. */
  targetName: string;
  /** The subject hemisphere's registered sphere, beside the opened surface. */
  subjectSphere: OpenedPath;
  /** `<subjects>/fsaverage/surf/<hemi>.sphere`. */
  fsavgSphere: OpenedPath;
  /** `<subjects>/fsaverage/surf/<hemi>.pial`, when there is one. */
  fsavgSurface?: OpenedPath;
}

export interface TetravoxBridge {
  /** File ▸ Open… / ⌘O. Returns paths, never bytes. */
  openDialog(): Promise<OpenedPath[]>;
  /**
   * The absolute path behind a dropped `File`, or `''` when it has none (§8 fallback).
   *
   * Also tells main *that a file was dropped*, which is the one drop signal main has (§5 rule 10,
   * 2026-08-30): `webUtils.getPathForFile` runs in preload and answers only for a `File` the user
   * really handed the page, so a path that comes out of here was named by a gesture. Main uses it
   * to admit a dropped `*.tetravox.json` for writing, and ignores everything else.
   */
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
  /**
   * §3's fsaverage lookup (directed task 8): the files a pick on an opened **surface** needs, or
   * null when the hemisphere is undeclared, the subject's `sphere.reg` is not beside it, or the
   * `freesurferSubjectsDir` setting is empty or points somewhere without an `fsaverage/surf`.
   */
  surfaceSpaces(path: string): Promise<SurfaceSpacesReply | null>;
  /** §8's settings dialog: pick one directory. Null when the user cancelled. */
  chooseDirectory(): Promise<string | null>;
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
  /**
   * One scene file to open, by path — File ▸ Open Recent, a `*.tetravox.json` dropped on the
   * window, one named on the command line, or one double-clicked in Finder (directed task 13).
   *
   * Separate from `onOpened` because a scene is not a dataset: `main/menu.ts` splits them, so the
   * renderer never sniffs a filename to decide which of the two a path is.
   */
  onOpenScene(listener: (path: string) => void): () => void;
  /**
   * The scene this launch should open, drained once — argv, a launch-time `open-file`, or
   * "reopen last scene on launch". Pulled rather than pushed, for the same reason
   * {@link startupPaths} is: a push races React's first commit.
   */
  startupScene(): Promise<string | null>;
  /**
   * Put a scene path at the head of File ▸ Open Recent and rebuild the menu. Returns the merged
   * settings, so the renderer's mirror of the list never has to be guessed at.
   */
  rememberScene(path: string): Promise<AppSettings | null>;

  // -- App settings (directed task 9, 2026-08-28) ------------------------------------------------
  // `main/settings.ts` owns the file; §5 keeps the filesystem there. Small JSON, like everything
  // else on this bridge.

  /** The persisted preferences. Never rejects: a missing or corrupt file yields the defaults. */
  settings(): Promise<AppSettings>;
  /** Merge a patch into the file and get the result back, so a caller knows the write landed. */
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  /** The `tetravoxrc` path (`main/settings.ts#configPath`), for the settings dialog's footer. */
  configPath(): Promise<string>;
  /** Reveal the rc file in the OS file manager (`shell.showItemInFolder`); creates it first if absent. */
  revealConfigFile(): Promise<void>;
  /** Menu Settings… (⌘,/Ctrl+,), pushed from main. */
  onOpenSettings(listener: () => void): () => void;

  // -- Sample Data (`main/sample-data.ts`) ---------------------------------------------------------
  // Main owns the network and the cache. The renderer sees the catalogue, per-sample status and
  // progress; an opened sample arrives through `onOpened` like any other file.

  /** The catalogue (`shared/sample-catalog.json`) and where downloads land. */
  sampleCatalog(): Promise<{ samples: Sample[]; cacheDir: string }>;
  /** Which samples are fully in the cache, and how big each is. */
  sampleStatuses(): Promise<SampleStatus[]>;
  /** Download what is missing, verify, and open. Resolves when the files have been pushed to `onOpened`. */
  sampleOpen(id: string): Promise<SampleOpenResult>;
  /** Abort an in-flight download; `false` when none was running. */
  sampleCancel(id: string): Promise<boolean>;
  /** Delete a sample's files from the cache; returns the refreshed statuses. */
  sampleRemove(id: string): Promise<SampleStatus[]>;
  /** Open the cache directory in the OS file manager. */
  sampleRevealCache(): Promise<void>;
  /** Download progress, pushed from main. */
  onSampleProgress(listener: (p: SampleProgress) => void): () => void;
  /** Menu File ▸ Sample Data…, pushed from main. */
  onOpenSampleData(listener: () => void): () => void;

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
  /**
   * A PNG of the whole window — panels, toolbar and status bar included — for a `view: "window"`
   * capture. Null on an ordinary launch. `width`/`height` resize the device-pixel-ratio capture
   * down to the size the action asked for.
   */
  jobCapture(width?: number, height?: number): Promise<Uint8Array | null>;
  /** Hand over a frame sequence: PNGs and a GIF always, MP4 when ffmpeg is on PATH. */
  jobFrames(payload: JobFramesPayload): Promise<JobFramesResult>;
  /** Progress, to the job runner's stdout (suppressed by `--quiet`). */
  jobLog(message: string): void;
  /** Report the run. Main writes `job-result.json` and exits 0 or 1. */
  jobDone(report: JobDonePayload): Promise<boolean>;

  // -- Module file IO (§5 rule 11, `main/module-io.ts`, 2026-08-30) ------------------------------
  // Small text and paths, like everything else here, and every call carries the module id: the
  // write list is per module, so one module's Save sheet admits nothing for another.

  /**
   * UTF-8 text of a path already on the `tetravox://file/…` allow-list — ≤ 1 MiB, and only
   * `.tsv .csv .json .txt .fcsv`. It admits nothing; `allowPath` and a user gesture still do that.
   */
  moduleReadText(moduleId: string, path: string): Promise<ModuleReadResult>;
  /** An Open sheet with a reader's own title and filters. The result is allow-listed for reading. */
  moduleOpenDialog(moduleId: string, opts: ModuleOpenOptions): Promise<OpenedPath[]>;
  /**
   * A Save sheet with a writer's title and filters. The chosen path **and** the writer's declared
   * same-directory siblings are admitted for writing; null when the user cancelled.
   */
  moduleSaveDialog(moduleId: string, opts: ModuleSaveOptions): Promise<ModuleSaveTarget | null>;
  /** Write text to a path this module's Save sheet admitted. `backup` copies the old file first. */
  moduleWriteText(
    moduleId: string,
    path: string,
    text: string,
    opts: { backup: boolean }
  ): Promise<ModuleWriteResult>;
  /**
   * Write **PNG bytes** to a path this module's Save sheet admitted — `.png` only, ≤ 32 MiB.
   *
   * The one place bytes legitimately cross this bridge outward (2026-09-03). §5 rule 3's "paths,
   * never bytes" is about *file* bytes coming **in** — a volume the renderer would then have to
   * parse — and `jobWrite` has written a PNG out over this same bridge since Phase 2. This is that
   * door, narrowed to one extension and given a module id so the write list still decides.
   */
  moduleWriteBinary(
    moduleId: string,
    path: string,
    bytes: Uint8Array,
    opts: { backup: boolean }
  ): Promise<ModuleWriteResult>;
  /**
   * Tell main this window has (or no longer has) unsaved module edits.
   *
   * Main calls `win.setDocumentEdited` with it and keeps the flag for §5 rule 12's `close` guard.
   * `send`, not `invoke`: it is a fact about the window, and nothing waits on the answer.
   */
  setDocumentEdited(edited: boolean): void;
  /**
   * Give this module's write admissions back (§5 rule 11, 2026-08-30).
   *
   * Sent when a module leaves the slot: its `savePath` dies with the instance, so nothing
   * legitimate can write to those paths again without a new Save sheet, and an admission that
   * outlives its editing session is a live capability against whatever subject the user has since
   * moved on to. `send`, not `invoke` — dropping a capability cannot fail.
   *
   * Optional so that a `TetravoxBridge` written before this member (a test's stand-in, an older
   * preload beside a newer renderer) is still one; the renderer calls it with `?.`.
   */
  moduleClearWrites?(moduleId: string): void;

  // -- Extensions (§13, `main/module-store.ts`, 2026-08-30) --------------------------------------
  // The Sample Data members again, for code instead of data. Main owns the network, the hashing, the
  // consent record and the `tetravox://module` map; the renderer sees a catalogue, card states and
  // progress. **No path ever crosses this half of the bridge**: an enabled module is reachable only
  // as `tetravox://module/<id>/<version>/<file>`, and only because main put it there.
  //
  // Every member is optional for the same reason `moduleClearWrites` is: a `TetravoxBridge` written
  // before them is still one, and the renderer calls them with `?.`.

  /** The catalogue (`shared/extensions-index.json`, or `TETRAVOX_EXT_INDEX`) and the install root. */
  moduleCatalog?(): Promise<{ modules: ExtensionEntry[]; dir: string }>;
  /** One card state per module: installed, enabled, updatable, and the derived permission list. */
  moduleStatuses?(): Promise<ModuleStatus[]>;
  /**
   * The manifests of every installed module, for the renderer's own `registerInstalledManifests()`.
   * Data, not a capability: knowing a module's title admits nothing.
   */
  moduleManifests?(): Promise<unknown[]>;
  /** Download and verify one version. Installing is **not** enabling; nothing is served by this. */
  moduleInstall?(id: string, version?: string): Promise<ModuleActionResult>;
  /** Abort an in-flight install; `false` when none was running. */
  moduleCancel?(id: string): Promise<boolean>;
  /**
   * Record the user's consent and make the module reachable: main re-hashes every file against the
   * install receipt and only then puts it on the `tetravox://module` map. This call **is** the
   * consent — the sheet is the renderer's, the grant is main's.
   */
  moduleEnable?(id: string): Promise<ModuleActionResult>;
  /** Withdraw consent: off the map, out of settings, and its write admissions revoked in main. */
  moduleDisable?(id: string): Promise<ModuleActionResult>;
  /** Disable, then delete the directory. */
  moduleRemove?(id: string): Promise<ModuleActionResult>;
  /** Open `~/.tetravox/modules/` in the OS file manager. */
  moduleRevealDir?(): Promise<void>;
  /** Install progress, pushed from main. */
  onModuleProgress?(listener: (p: ModuleProgress) => void): () => void;
  /**
   * Menu File ▸ Extensions…, pushed from main (2026-08-30).
   *
   * `onOpenSampleData`'s twin, and appended for the same reason it exists: an accelerator and a
   * native menu item live in main, and the dialog lives in the renderer. Main sends nothing but the
   * fact that the item was clicked — no id, no path, no catalogue — so this channel grants nothing
   * that the six invoke channels above do not already gate.
   */
  onOpenExtensions?(listener: () => void): () => void;

  // -- In-app updates (§12.4, `main/updater.ts`, 2026-08-31) --------------------------------------
  // One status object each way and clicks going in. Main owns the feed, the download and the
  // installer; nothing here can start an install without the user's gesture arriving first.
  //
  // Every member is optional for the same reason `moduleClearWrites` is: a `TetravoxBridge`
  // written before them is still one, and the renderer calls them with `?.`.

  /** The status as it stands — pulled on boot and on every open of the dialog, never guessed. */
  updateStatus?(): Promise<UpdateStatus>;
  /** Ask the feed now. Resolves with the answer; the same statuses also arrive on `onUpdateStatus`. */
  updateCheck?(): Promise<UpdateStatus>;
  /** Download the announced version. `'inplace'` installs only; the result carries the refusal. */
  updateDownload?(): Promise<UpdateActionResult>;
  /** Restart into the downloaded version — or, on a notify-only install, open the Releases page. */
  updateInstall?(): Promise<UpdateActionResult>;
  /** "Skip this version": the launch check stays quiet about exactly this one. */
  updateSkip?(version: string): Promise<UpdateStatus>;
  /** Status pushes from main — the launch check's find, download progress, the downloaded flag. */
  onUpdateStatus?(listener: (status: UpdateStatus) => void): () => void;
  /** Menu File ▸ Check for Updates…, pushed from main. Carries nothing but the click. */
  onOpenUpdates?(listener: () => void): () => void;
}

// Mirror `main/updater.ts`'s types; duplicated because preload must not import from main.
export type UpdatePhase =
  'idle' | 'checking' | 'available' | 'none' | 'downloading' | 'downloaded' | 'error';
export interface UpdateStatus {
  phase: UpdatePhase;
  /** `app.getVersion()` — the renderer's only version readout, so it rides along on every status. */
  current: string;
  available?: string;
  notes?: string;
  received?: number;
  total?: number;
  error?: string;
  /** `'inplace'` downloads and restarts; `'notify'` (`.deb`/`.tar.gz`) offers the Releases page; `'off'` is a dev build. */
  mode: 'inplace' | 'notify' | 'off';
  /** True on statuses born from the launch check, so the renderer toasts instead of assuming a dialog. */
  auto?: boolean;
}
export interface UpdateActionResult {
  ok: boolean;
  error?: string;
}

/** Mirrors `main/job.ts`'s `Job` plus the run's own two fields; kept structural, not imported. */
export interface JobSpec {
  job: {
    version?: number;
    scene: { path: string } | { files: string[]; preset: string };
    window?: { width: number; height: number; panels?: boolean };
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
  /** The frame number the first entry of `frames` takes; how a multi-action `sequence` numbers on. */
  startIndex?: number;
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

/** Mirrors `main/settings.ts`'s `ScreenshotDefaults`; duplicated for the same reason as `AppSettings`. */
export interface ScreenshotDefaults {
  background: 'scene' | 'white' | 'black' | 'transparent';
  dpi: number;
  scale?: number;
  autoTrim: boolean;
}

/** Mirrors `main/settings.ts`'s `AppSettings`; duplicated because preload must not import main. */
export interface AppSettings {
  theme: 'system' | 'light' | 'dark';
  /** The FreeSurfer subjects directory for §3's fsaverage lookup; `''` = unset (directed task 8). */
  freesurferSubjectsDir: string;
  /** File ▸ Open Recent — the last ten scene files, most recent first (directed task 13). */
  recentScenes: string[];
  /** "Reopen last scene on launch"; off by default (directed task 13). */
  reopenLastScene: boolean;
  /** Persisted §4.7 screenshot defaults, merged into `screenshotOptions` on startup. */
  screenshotDefaults: ScreenshotDefaults;
  /** "Check for updates on launch" (§12.4); on by default. Gates the automatic check only. */
  checkForUpdates: boolean;
  /** The one version the user said to skip (§12.4); `''` = none. */
  skippedUpdateVersion: string;
}

/** Mirrors `main/menu.ts`'s own union; duplicated because preload must not import from main. */
export type SceneCommand = 'new' | 'open' | 'save' | 'saveAs';

// Mirror `main/sample-data.ts`'s types; duplicated because preload must not import from main.
export interface SampleFile {
  name: string;
  bytes: number;
  sha256: string;
  url: string;
}
export interface Sample {
  id: string;
  title: string;
  group: string;
  description: string;
  thumbnail: string;
  source: string;
  sourceUrl: string;
  licence: string;
  files: SampleFile[];
  scene?: string;
}
export interface SampleStatus {
  id: string;
  cached: boolean;
  bytes: number;
}
export type SampleProgressState = 'downloading' | 'verifying' | 'done' | 'error' | 'cancelled';
export interface SampleProgress {
  id: string;
  file: string;
  received: number;
  total: number;
  state: SampleProgressState;
  error?: string;
}
export interface SampleOpenResult {
  ok: boolean;
  paths?: string[];
  error?: string;
}

/** The result of the two scene-file calls; mirrors `main/scene-io.ts`'s own type. */
export interface SceneIoResult {
  ok: boolean;
  path?: string;
  text?: string;
  error?: string;
}

// Mirror `main/module-io.ts`'s types; duplicated because preload must not import from main.
export interface ModuleDialogFilter {
  name: string;
  extensions: string[];
}
export interface ModuleOpenOptions {
  title: string;
  filters: ModuleDialogFilter[];
  /**
   * Which of the module's `readers` this sheet is for (2026-08-30, appended).
   *
   * Main looks the reader up in `MANIFESTS` and uses **its** title and extensions; the two fields
   * above are then the fallback for a module main does not know, still sanitised on arrival.
   */
  readerId?: string;
}
export interface ModuleSaveOptions extends ModuleOpenOptions {
  /** The writer's sibling templates — `{name}.{stamp}.bak`, `{stem}_editlog.json`. */
  siblings: string[];
  defaultPath: string | null;
  /** Which of the module's `writers` this sheet is for. See {@link ModuleOpenOptions.readerId}. */
  writerId?: string;
}
/** The chosen path, and each declared template's substituted absolute path beside it. */
export interface ModuleSaveTarget {
  path: string;
  siblings: Record<string, string>;
}
export type ModuleReadResult = { ok: true; text: string } | { ok: false; error: string };
export type ModuleWriteResult =
  { ok: true; backupPath: string | null } | { ok: false; error: string };

// Mirror `main/module-store.ts`'s types; duplicated because preload must not import from main.
export interface ExtensionFile {
  name: string;
  bytes: number;
  sha256: string;
  url: string;
}
export interface ExtensionVersion {
  version: string;
  hostApi: number;
  published?: string;
  files: ExtensionFile[];
}
export interface ExtensionEntry {
  id: string;
  title: string;
  summary: string;
  description?: string;
  repo?: string;
  author?: string;
  licence?: string;
  docs?: string;
  versions: ExtensionVersion[];
}
export interface ModuleStatus {
  id: string;
  title: string;
  installed: string | null;
  enabled: boolean;
  available: string | null;
  updatable: boolean;
  incompatible?: string;
  permissions: string[];
}
export interface ModuleActionResult {
  ok: boolean;
  error?: string;
  statuses: ModuleStatus[];
}
export type ModuleProgressState = 'downloading' | 'verifying' | 'done' | 'error' | 'cancelled';
export interface ModuleProgress {
  id: string;
  file: string;
  received: number;
  total: number;
  state: ModuleProgressState;
  error?: string;
}

const bridge: TetravoxBridge = {
  openDialog: () => ipcRenderer.invoke('tetravox:open-dialog'),
  getDroppedFilePath: (file) => {
    const path = webUtils.getPathForFile(file);
    // The drop gesture, reported to main. Only preload can produce this path, so this send is the
    // one thing renderer script cannot forge for a path of its choosing (§5 rule 10).
    if (path !== '') ipcRenderer.send('tetravox:dropped-path', path);
    return path;
  },
  allowPath: (path) => ipcRenderer.invoke('tetravox:allow-path', path),
  startupPaths: () => ipcRenderer.invoke('tetravox:startup-paths'),
  subjectSpaces: (path, explicitDir) =>
    ipcRenderer.invoke('tetravox:subject-spaces', path, explicitDir),
  surfaceSpaces: (path) => ipcRenderer.invoke('tetravox:surface-spaces', path),
  chooseDirectory: () => ipcRenderer.invoke('tetravox:choose-directory'),
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
  configPath: () => ipcRenderer.invoke('tetravox:config-path'),
  revealConfigFile: () => ipcRenderer.invoke('tetravox:reveal-config-file'),
  onOpenSettings: (listener) => {
    const wrapped = (): void => listener();
    ipcRenderer.on('tetravox:open-settings', wrapped);
    return () => ipcRenderer.removeListener('tetravox:open-settings', wrapped);
  },
  sampleCatalog: () => ipcRenderer.invoke('tetravox:sample-catalog'),
  sampleStatuses: () => ipcRenderer.invoke('tetravox:sample-statuses'),
  sampleOpen: (id) => ipcRenderer.invoke('tetravox:sample-open', id),
  sampleCancel: (id) => ipcRenderer.invoke('tetravox:sample-cancel', id),
  sampleRemove: (id) => ipcRenderer.invoke('tetravox:sample-remove', id),
  sampleRevealCache: () => ipcRenderer.invoke('tetravox:sample-reveal-cache'),
  onSampleProgress: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, p: SampleProgress): void => listener(p);
    ipcRenderer.on('tetravox:sample-progress', wrapped);
    return () => ipcRenderer.removeListener('tetravox:sample-progress', wrapped);
  },
  onOpenSampleData: (listener) => {
    const wrapped = (): void => listener();
    ipcRenderer.on('tetravox:open-sample-data', wrapped);
    return () => ipcRenderer.removeListener('tetravox:open-sample-data', wrapped);
  },
  jobSpec: () => ipcRenderer.invoke('tetravox:job-spec'),
  jobWrite: (name, bytes) => ipcRenderer.invoke('tetravox:job-write', { name, bytes }),
  jobCapture: (width, height) => ipcRenderer.invoke('tetravox:job-capture', width, height),
  jobFrames: (payload) => ipcRenderer.invoke('tetravox:job-frames', payload),
  jobLog: (message) => ipcRenderer.send('tetravox:job-log', message),
  jobDone: (report) => ipcRenderer.invoke('tetravox:job-done', report),
  onOpenScene: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, path: string): void => listener(path);
    ipcRenderer.on('tetravox:open-scene', wrapped);
    return () => ipcRenderer.removeListener('tetravox:open-scene', wrapped);
  },
  startupScene: () => ipcRenderer.invoke('tetravox:startup-scene'),
  rememberScene: (path) => ipcRenderer.invoke('tetravox:remember-scene', path),
  onSceneCommand: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, command: SceneCommand): void =>
      listener(command);
    ipcRenderer.on('tetravox:scene-command', wrapped);
    return () => ipcRenderer.removeListener('tetravox:scene-command', wrapped);
  },
  moduleReadText: (moduleId, path) =>
    ipcRenderer.invoke('tetravox:module-read-text', moduleId, path),
  moduleOpenDialog: (moduleId, opts) =>
    ipcRenderer.invoke('tetravox:module-open-dialog', moduleId, opts),
  moduleSaveDialog: (moduleId, opts) =>
    ipcRenderer.invoke('tetravox:module-save-dialog', moduleId, opts),
  moduleWriteText: (moduleId, path, text, opts) =>
    ipcRenderer.invoke('tetravox:module-write-text', moduleId, path, text, opts),
  moduleWriteBinary: (moduleId, path, bytes, opts) =>
    ipcRenderer.invoke('tetravox:module-write-binary', moduleId, path, bytes, opts),
  setDocumentEdited: (edited) => ipcRenderer.send('tetravox:set-document-edited', edited),
  moduleClearWrites: (moduleId) => ipcRenderer.send('tetravox:module-clear-writes', moduleId),
  // Extensions (§13, 2026-08-30). Ids and card states only — never a path, never a byte.
  moduleCatalog: () => ipcRenderer.invoke('tetravox:module-catalog'),
  moduleStatuses: () => ipcRenderer.invoke('tetravox:module-statuses'),
  moduleManifests: () => ipcRenderer.invoke('tetravox:module-manifests'),
  moduleInstall: (id, version) => ipcRenderer.invoke('tetravox:module-install', id, version),
  moduleCancel: (id) => ipcRenderer.invoke('tetravox:module-cancel', id),
  moduleEnable: (id) => ipcRenderer.invoke('tetravox:module-enable', id),
  moduleDisable: (id) => ipcRenderer.invoke('tetravox:module-disable', id),
  moduleRemove: (id) => ipcRenderer.invoke('tetravox:module-remove', id),
  moduleRevealDir: () => ipcRenderer.invoke('tetravox:module-reveal-dir'),
  onModuleProgress: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, p: ModuleProgress): void => listener(p);
    ipcRenderer.on('tetravox:module-progress', wrapped);
    return () => ipcRenderer.removeListener('tetravox:module-progress', wrapped);
  },
  onOpenExtensions: (listener) => {
    const wrapped = (): void => listener();
    ipcRenderer.on('tetravox:open-extensions', wrapped);
    return () => ipcRenderer.removeListener('tetravox:open-extensions', wrapped);
  },
  // In-app updates (§12.4, 2026-08-31). One status object each way; clicks in, never bytes.
  // 'update-state', not 'update-status': the pull and the push are different channels, like
  // `settings` vs the push channels everywhere else on this bridge.
  updateStatus: () => ipcRenderer.invoke('tetravox:update-state'),
  updateCheck: () => ipcRenderer.invoke('tetravox:update-check'),
  updateDownload: () => ipcRenderer.invoke('tetravox:update-download'),
  updateInstall: () => ipcRenderer.invoke('tetravox:update-install'),
  updateSkip: (version) => ipcRenderer.invoke('tetravox:update-skip', version),
  onUpdateStatus: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, status: UpdateStatus): void =>
      listener(status);
    ipcRenderer.on('tetravox:update-status', wrapped);
    return () => ipcRenderer.removeListener('tetravox:update-status', wrapped);
  },
  onOpenUpdates: (listener) => {
    const wrapped = (): void => listener();
    ipcRenderer.on('tetravox:open-updates', wrapped);
    return () => ipcRenderer.removeListener('tetravox:open-updates', wrapped);
  },
};

contextBridge.exposeInMainWorld('tetravox', bridge);
