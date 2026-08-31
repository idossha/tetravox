/**
 * Electron main (§5, §7.1, §8).
 *
 * Order matters and is not negotiable:
 *  1. `registerSchemesAsPrivileged` — **before** `app.whenReady()`, or the scheme is not standard,
 *     not secure, and module Workers under it cannot fetch.
 *  2. the launch switches (§7.1, directive C8) — also before ready.
 *  3. `protocol.handle` — after ready.
 *  4. `win.loadURL('tetravox://app/index.html')` — **never** `loadFile()`.
 *
 * In `electron-vite dev` the renderer comes from the dev server instead (`ELECTRON_RENDERER_URL`), so
 * HMR works; `TETRAVOX_FORCE_PROTOCOL=1` forces the `tetravox://` path even there. The **packaged**
 * app has no dev server and always takes the `tetravox://` path, which is what ROADMAP Phase-0 gate 2
 * demands.
 */

import { BrowserWindow, app, dialog, ipcMain, nativeTheme, session, shell } from 'electron';
import { mkdirSync, writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { collectCliPaths } from './cli';
import {
  buildMenu,
  sendOpenScene,
  sendOpened,
  showOpenDialog,
  splitScenes,
  toOpened,
} from './menu';
import type { OpenedPath } from './menu';
import { allowPath } from './paths';
import { installCloseGuard, registerModuleIpc } from './module-io';
import { discoverSubjectSpaces } from './subject-spaces';
import { discoverSurfaceSpaces } from './surface-spaces';
import { fileUrl, handleScheme, registerScheme } from './protocol';
import { installedManifests } from '../modules/manifests';
import {
  cancelSample,
  catalogue,
  materialiseScene,
  removeSample,
  revealSampleCache,
  sampleById,
  sampleCacheDir,
  sampleStatuses,
  startSample,
} from './sample-data';
// §13's downloadable extensions (`module-store.ts`, 2026-08-30). Imported before `job-runner` is
// used below, because `bootstrapInstalledModules()` has to have run before a job file is validated.
import {
  bootstrapInstalledModules,
  cancelInstall,
  catalogue as moduleCatalogue,
  disableModuleAction,
  enableModuleAction,
  installModuleAction,
  moduleDir,
  moduleStatuses,
  removeModuleAction,
  revealModuleDir,
} from './module-store';
import {
  armWatchdog,
  jobRequest,
  isJobRun,
  onRendererGone,
  prepareJob,
  registerJobIpc,
  rememberInvocation,
} from './job-runner';
import {
  allowOpenedScene,
  readSceneFile,
  showOpenSceneDialog,
  showRelocateDialog,
  showSaveSceneDialog,
  writeSceneFile,
} from './scene-io';
import { windowMode } from './window';
import {
  configPath,
  ensureRcFile,
  readSettings,
  rememberRecentScene,
  writeSettings,
} from './settings';

/**
 * `BrowserWindow.backgroundColor` for this launch: the `bg` token of the theme the renderer will
 * resolve to. Kept in step with `renderer/src/theme/tokens.ts` by `theme/tokens.test.ts`,
 * which reads this function's two literals out of this file.
 */
function startupBackground(): string {
  const choice = readSettings().theme;
  const dark = choice === 'system' ? nativeTheme.shouldUseDarkColors : choice === 'dark';
  return dark ? '#16181c' : '#ffffff';
}

const here = fileURLToPath(new URL('.', import.meta.url));
const rendererRoot = join(here, '..', 'renderer');
const preload = join(here, '..', 'preload', 'index.mjs');

// 1. Privileged scheme (§5, directive A2).
registerScheme();

// 2. Launch policy (§7.1, directive C8). Chromium M137 removed the automatic SwiftShader fallback, so
// without this switch a blocklisted driver yields `getContext('webgl2') === null` instead of a slow
// but working context. The developer-extensions switch is what makes `EXT_disjoint_timer_query_webgl2`
// a live path for the §8 status bar's GPU-ms readout.
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.commandLine.appendSwitch('enable-webgl-developer-extensions');

/**
 * **Software-GL mode** — `--software-gl` or `TETRAVOX_SOFTWARE_GL=1`, and never on by default.
 *
 * `enable-unsafe-swiftshader` above only *permits* a fallback to SwiftShader; it does not conjure
 * one where Chromium cannot bring up a GL/EGL display at all, and a hosted CI runner with no GPU is
 * exactly that case. Both failures the v0.2.0 release run hit are this:
 *
 *   - Linux under Xvfb: the GPU process has a display but no usable driver, so shader compilation
 *     dies with `vertex shader failed to compile: (no log)` — a lost context, not a bad shader.
 *   - macOS x64 with no Metal device (`macos-26-intel`): `Initialization of all (1) EGL display
 *     types failed ... Exiting GPU process`, so there is no context to fall back *from*.
 *
 * Naming ANGLE's SwiftShader backend explicitly gives the GPU process a display it can always
 * create, and `disable-gpu-compositing` keeps the (already offscreen) compositor off the same
 * missing device. `--disable-gpu` is deliberately NOT in this set: it disables the GPU process
 * wholesale and takes WebGL2 with it, so the smoke test could not render at all.
 *
 * The mode is opt-in because it is a *weaker* claim — a SwiftShader frame proves the pipeline, not
 * the platform driver — so the mac arm64 leg, which has a real GPU, stays off it (docs/RELEASING.md).
 */
const SOFTWARE_GL =
  process.argv.includes('--software-gl') || process.env['TETRAVOX_SOFTWARE_GL'] === '1';
if (SOFTWARE_GL) {
  app.commandLine.appendSwitch('use-gl', 'angle');
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
  app.commandLine.appendSwitch('disable-gpu-compositing');
}

/**
 * `Tetravox --version` — print the version and exit 0, before anything opens a window.
 *
 * Electron's own `--version` handling lives in the `electron` **CLI wrapper**, not in the runtime, so
 * a packaged binary given `--version` does not print anything: it launches the app and sits there
 * until something kills it (the Windows `package` leg died exactly that way, killed at its 180 s
 * smoke timeout). The launch-and-exit smoke check §12.1 asks of the optional Windows leg needs this
 * to exist in the app itself.
 *
 * `writeSync(1, …)` and not `console.log`: `app.exit()` terminates immediately and does not drain an
 * async pipe write, so a buffered line would be lost on the way out.
 */
if (process.argv.slice(1).some((arg) => arg === '--version' || arg === '-v')) {
  try {
    writeSync(1, `Tetravox ${app.getVersion()} (electron ${process.versions.electron})\n`);
  } catch {
    // No stdout to write to (a detached GUI launch). Exiting 0 is still the right answer.
  }
  app.exit(0);
}

/**
 * `'offscreen'` under `TETRAVOX_E2E_OFFSCREEN=1` (what `e2e/fixtures.ts` sets by default on macOS):
 * the window is built and never shown, so a test run cannot take the screen or the keyboard focus.
 * `TETRAVOX_E2E_HEADED=1` forces `'normal'` back. A user launch sets neither and is `'normal'`.
 * `src/main/window.ts` has the measurements behind the choice.
 */
const MODE = windowMode();

/**
 * `Tetravox --job job.json --out DIR [--quiet]` (`job-runner.ts`, `docs/AUTOMATION.md`).
 *
 * Parsed **before** `whenReady`, so a malformed job exits without ever creating a GPU context, and so
 * `createWindow` can size the window from the job rather than from the interactive default. A launch
 * with no `--job` gets `null` here and every line below behaves exactly as it did.
 */
/**
 * The installed extensions, read **before** `prepareJob` (§13.6, 2026-08-30).
 *
 * A `--job` run validates its actions against the modules this launch carries, and an installed
 * module is one of them — so the set has to be known before the job file is parsed, not after
 * `whenReady`. It is a handful of small JSON files off disk, which is the same order of work as
 * reading `settings.json`, and it is what makes "every problem in a job file is reported at once,
 * before anything is loaded" still true once a module can arrive from outside the build.
 */
bootstrapInstalledModules();

const JOB = prepareJob(process.argv, process.cwd());
if (JOB !== null) rememberInvocation(JOB);

/** How long a job may run before it is declared hung. Ten minutes covers a 36-frame orbit on ernie. */
const JOB_TIMEOUT_MS = Number(process.env['TETRAVOX_JOB_TIMEOUT_MS'] ?? 600_000);

let mainWindow: BrowserWindow | null = null;
const getWindow = (): BrowserWindow | null => mainWindow;

/**
 * The renderer's launch query, from `--tvx-search=<querystring>` or `TETRAVOX_SEARCH`.
 *
 * The window is loaded with `loadURL('tetravox://app/index.html')` (§5) and there is nowhere else to
 * put a launch option the renderer can read on its **first** render — an IPC round trip is a commit
 * too late. It carries exactly two kinds of thing, both dev/test only: `ui=phase0`, which selects the
 * Phase-0 walking skeleton that ROADMAP gate items 2/3/8 are proved by, and the stand-in engine's
 * knobs (`engine=`, `mockStepMs=`, `mockParseFail=`, `forceWebgl2Null=`).
 *
 * `collectCliPaths` already drops anything starting with `-`, so this never looks like a file. The
 * value is re-serialised rather than concatenated, so a malformed one cannot smuggle a second `?` or
 * a `#` into the URL.
 */
export function launchSearch(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): string {
  const PREFIX = '--tvx-search=';
  const fromArgv = argv.find((arg) => arg.startsWith(PREFIX))?.slice(PREFIX.length);
  const raw = fromArgv ?? env['TETRAVOX_SEARCH'] ?? '';
  if (raw === '') return '';
  const search = new URLSearchParams(raw).toString();
  return search === '' ? '' : `?${search}`;
}

/**
 * Where the §8 screenshot button's PNG lands.
 *
 * The renderer hands the `Blob` to an `<a download>`; Electron's default for a download with no
 * `savePath` is a **Save As dialog**, which would hang the app behind a modal nobody asked for and
 * would hang the E2E outright. Setting the path turns it into a plain write and lets main log where
 * the file went. `TETRAVOX_DOWNLOAD_DIR` redirects it, which is how the E2E asserts a real PNG
 * rather than a MIME type.
 */
function installDownloadHandler(): void {
  session.defaultSession.on('will-download', (_event, item) => {
    const dir = process.env['TETRAVOX_DOWNLOAD_DIR'] ?? app.getPath('downloads');
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // Fall through: `setSavePath` into a missing directory fails the item, which is reported below.
    }
    const target = join(dir, item.getFilename());
    item.setSavePath(target);
    item.once('done', (_e, state) => {
      console.log(`[tetravox] download ${state}: ${target}`);
    });
  });
}

/** Phase-0 fixture: a real file on disk in both dev and packaged, for the gate's file-fetch leg. */
function phase0FixturePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'phase0-fixture.bin')
    : join(app.getAppPath(), 'resources', 'phase0-fixture.bin');
}

function createWindow(): BrowserWindow {
  // A job renders at the size it asked for: the offscreen window IS the render target, and
  // `ScreenshotOptions.width` scales *up* from the pane it captured, so a 400 px pane upscaled to
  // 1400 is a blurrier picture than a 1400 px pane captured as it stands.
  const jobWindow = jobRequest()?.job.window;
  const win = new BrowserWindow({
    width: jobWindow?.width ?? 1280,
    height: jobWindow?.height ?? 860,
    // Below this the §8 three-column layout has nothing left for the view grid: the two side panels
    // are 18 rem and 20 rem, so a window narrower than ~960 px would show panels and no viewport.
    // The interactive floor exists because below it the §8 three-column layout has no room for the
    // view grid. A job has no panels to squeeze — it screenshots the engine — so it sets its own.
    minWidth: jobWindow === undefined ? 960 : 1,
    minHeight: jobWindow === undefined ? 600 : 1,
    show: false,
    // The window's own paint, before the renderer has produced a frame — so it must be the theme
    // the renderer is *about* to apply, or every launch in the light theme opens on a black
    // rectangle for a few hundred milliseconds (directed task 9, 2026-08-28). `settings.json` holds
    // the choice; `system` asks Electron, which is the same signal `prefers-color-scheme` gives the
    // renderer a moment later.
    backgroundColor: startupBackground(),
    title: 'Tetravox',
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      // ESM preloads require an unsandboxed renderer; electron-vite emits ESM because the package is
      // `"type": "module"`. Context isolation and `nodeIntegration: false` still stand, and no bytes
      // or filesystem handles cross the bridge (§5 rule 3).
      sandbox: false,
      webgl: true,
    },
  });

  // The one behavioural difference of `'offscreen'`: `show()` is never called, so the window exists,
  // renders on the GPU and answers CDP, but never reaches the screen or the window server's focus
  // chain. `ready-to-show` still fires; only the reaction to it is suppressed.
  if (MODE === 'normal') win.once('ready-to-show', () => win.show());

  const search = launchSearch(process.argv);
  const devServer = process.env['ELECTRON_RENDERER_URL'];
  if (devServer && process.env['TETRAVOX_FORCE_PROTOCOL'] !== '1') {
    void win.loadURL(devServer + search);
  } else {
    void win.loadURL(`tetravox://app/index.html${search}`);
  }
  return win;
}

// Single instance, so a second `tetravox file.nii` hands its paths to the running window (§8).
//
// **A `--job` run is exempt.** The lock's purpose is that opening a file joins the window you are
// already looking at; a batch render has no such window and must not hand its argv to a developer's
// running copy and then exit 0 having produced nothing. It is also what makes two jobs runnable at
// once, which a CI matrix will do on its first day.
if (!isJobRun() && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv, cwd) => {
    const opened = toOpened(collectCliPaths(argv, app.getAppPath(), cwd));
    if (mainWindow && MODE === 'normal') {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    sendOpened(mainWindow, opened);
  });

  // Startup paths are **pulled** by the renderer, not pushed at it. A push on `did-finish-load` races
  // React's first commit: the preload only registers the listener once `onOpened` is called from an
  // effect, so a message sent before that commit is dropped. Runtime opens (menu, second instance,
  // `open-file` after ready) are pushed, because by then the listener exists.
  let startupPaths: OpenedPath[] = [];
  /**
   * The scene this launch should open, drained by `tetravox:startup-scene` (directed task 13).
   *
   * Held apart from `startupPaths` because a `*.tetravox.json` is not a dataset: the renderer's two
   * routes are "add these datasets" and "replace the scene with this file", and mixing them would
   * make the second one race the first. Last writer wins — argv, then `open-file`, then the
   * "reopen last scene" setting, which only fills a slot none of the others claimed.
   */
  let startupScene: string | null = null;

  // macOS `open-file` fires before ready when the app is launched by opening a document — which is
  // how a double-clicked `*.tetravox.json` arrives, now that the installer registers the extension.
  app.on('open-file', (event, path) => {
    event.preventDefault();
    const opened = toOpened([path]);
    if (mainWindow) sendOpened(mainWindow, opened);
    else {
      const { scenes } = splitScenes(opened.map((o) => o.path));
      const scene = scenes[scenes.length - 1];
      if (scene !== undefined) startupScene = scene;
      startupPaths = [...startupPaths, ...opened.filter((o) => !scenes.includes(o.path))];
    }
  });

  // IPC: dialogs, menus, **paths** and CLI args only. Never bytes (§5 rule 3).
  ipcMain.handle('tetravox:open-dialog', async () => showOpenDialog(getWindow()));
  ipcMain.handle('tetravox:allow-path', (_event, path: unknown) => {
    if (typeof path !== 'string') return null;
    const real = allowPath(path);
    return real === null ? null : { path: real, url: fileUrl(real) };
  });
  /**
   * A path behind a **dropped** `File` (§5 rule 10, 2026-08-30). Sent by preload from
   * `getDroppedFilePath`, and reachable no other way: `webUtils.getPathForFile` answers only for a
   * `File` the user really handed the page, and renderer script cannot manufacture one for a path
   * of its choosing. That is what makes a drop a *gesture* main can trust, and it is why the ⌘S
   * carve-out survives for a dropped scene while `tetravox:allow-path` — which any script may call
   * for any existing path — earns nothing.
   *
   * `allowOpenedScene` ignores everything that is not a `*.tetravox.json`, so the dropped volumes
   * and meshes that also come through here are a no-op; the read side is still `allowPath`'s.
   */
  ipcMain.on('tetravox:dropped-path', (_event, path: unknown) => {
    allowOpenedScene(path);
  });
  /**
   * §8's MNI spaces (directed task 8): what registration, if any, governs a volume the user opened.
   *
   * The reply carries the affine as **text** (≤ 64 kB) and the warps as allow-listed
   * `tetravox://file/…` URLs — never their bytes, which the dataset worker fetches for itself.
   */
  ipcMain.handle('tetravox:subject-spaces', (_event, path: unknown, explicit: unknown) => {
    if (typeof path !== 'string') return null;
    const found = discoverSubjectSpaces(path, typeof explicit === 'string' ? explicit : undefined);
    if (found === null) return null;
    const admit = (p: string | undefined): { path: string; url: string } | undefined => {
      if (p === undefined) return undefined;
      const real = allowPath(p);
      return real === null ? undefined : { path: real, url: fileUrl(real) };
    };
    return {
      subjectDir: found.subjectDir,
      toMniDir: found.toMniDir,
      ...(found.affine !== undefined ? { affine: found.affine } : {}),
      ...(admit(found.forwardField) !== undefined
        ? { forwardField: admit(found.forwardField) }
        : {}),
      ...(admit(found.inverseField) !== undefined
        ? { inverseField: admit(found.inverseField) }
        : {}),
    };
  });
  /**
   * §3's fsaverage lookup (directed task 8): the four files a pick on a subject surface needs.
   *
   * Paths only, each admitted to the `tetravox://file/…` allow-list — the workers fetch them. The
   * subjects directory comes from `settings.json`, so the renderer does not have to pass it and
   * cannot pass one the user did not choose.
   */
  ipcMain.handle('tetravox:surface-spaces', (_event, path: unknown) => {
    if (typeof path !== 'string') return null;
    const found = discoverSurfaceSpaces(path, readSettings().freesurferSubjectsDir);
    if (found === null) return null;
    const admit = (p: string | undefined): { path: string; url: string } | undefined => {
      if (p === undefined) return undefined;
      const real = allowPath(p);
      return real === null ? undefined : { path: real, url: fileUrl(real) };
    };
    const subjectSphere = admit(found.subjectSphere);
    const fsavgSphere = admit(found.fsavgSphere);
    if (subjectSphere === undefined || fsavgSphere === undefined) return null;
    const fsavgSurface = admit(found.fsavgSurface);
    return {
      hemisphere: found.hemisphere,
      targetName: found.targetName,
      subjectSphere,
      fsavgSphere,
      ...(fsavgSurface !== undefined ? { fsavgSurface } : {}),
    };
  });

  /** The Browse button of §8's settings dialog. One directory, or null when the user cancelled. */
  ipcMain.handle('tetravox:choose-directory', async () => {
    const window = getWindow();
    const options = {
      properties: ['openDirectory' as const],
      title: 'FreeSurfer subjects directory',
    };
    const result =
      window === null
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(window, options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  });

  ipcMain.handle('tetravox:startup-paths', () => {
    const opened = startupPaths;
    startupPaths = [];
    return opened;
  });
  // The startup scene, and §5 rule 10's admission with it: argv, a double-clicked document and the
  // "reopen last scene" setting are all main naming the file this launch will save over.
  ipcMain.handle('tetravox:startup-scene', () => {
    const scene = startupScene;
    startupScene = null;
    if (scene !== null) allowOpenedScene(scene);
    return scene;
  });
  /**
   * File ▸ Open Recent's list, written by the renderer after every successful save or open.
   *
   * The menu is rebuilt here rather than in the renderer because an Electron menu is immutable once
   * set: "the list changed" is "build a new menu", and only main can do that.
   */
  ipcMain.handle('tetravox:remember-scene', (_event, path: unknown) => {
    if (typeof path !== 'string' || path === '') return readSettings();
    const settings = rememberRecentScene(path);
    buildMenu(getWindow);
    return settings;
  });
  ipcMain.handle('tetravox:phase0-fixture', () => {
    const real = allowPath(phase0FixturePath());
    return real === null ? null : { path: real, url: fileUrl(real) };
  });
  // The `--job` channels (`job-runner.ts`). Registered unconditionally: a normal launch asks for a
  // spec once, is told `null`, and takes the UI path.
  registerJobIpc();
  // §13's module file IO (`module-io.ts`, §5 rule 11). Registered unconditionally for the same
  // reason: a build whose modules never open a file simply never calls these. `isJob` only silences
  // the write-revocation channel, whose renderer-side trigger (a module leaving the slot) is a step
  // a batch run takes between two actions rather than the end of an editing session.
  registerModuleIpc({ isJob: isJobRun() });

  ipcMain.on('tetravox:log', (_event, message: unknown) => {
    console.log(`[tetravox:renderer] ${String(message)}`);
  });

  // Scene save/load (§4.6, §8). Small JSON, capped and allow-listed in `scene-io.ts`; the dataset
  // bytes behind a `DatasetRef` still never cross IPC — the worker fetches them itself (§5 rule 3).
  ipcMain.handle('tetravox:open-scene-dialog', async () => showOpenSceneDialog(getWindow()));
  ipcMain.handle('tetravox:save-scene-dialog', async (_event, defaultName: unknown) =>
    showSaveSceneDialog(getWindow(), defaultName)
  );
  ipcMain.handle('tetravox:relocate-dialog', async (_event, missingName: unknown) =>
    showRelocateDialog(getWindow(), missingName)
  );
  // §8's theme switch (directed task 9, 2026-08-28). Two calls, both small JSON: the renderer asks
  // for the persisted choice on boot and writes the new one when the user picks. `set` returns the
  // merged settings, so the renderer never has to guess whether the write landed.
  ipcMain.handle('tetravox:settings', () => readSettings());
  ipcMain.handle('tetravox:set-settings', (_event, patch: unknown) => writeSettings(patch));
  // -- rc-style config file (directed task: unified settings, 2026-08-28) ------------------------
  ipcMain.handle('tetravox:config-path', () => configPath());
  ipcMain.handle('tetravox:reveal-config-file', () => {
    ensureRcFile();
    shell.showItemInFolder(configPath());
  });
  ipcMain.handle('tetravox:read-scene', (_event, path: unknown) => readSceneFile(path));
  ipcMain.handle('tetravox:write-scene', (_event, path: unknown, text: unknown) =>
    writeSceneFile(path, text)
  );
  // -- Sample Data (§8, `sample-data.ts`) ---------------------------------------------------------
  // Main downloads, verifies and allow-lists; the renderer gets ids, progress and — through the same
  // `tetravox:opened` push the Open dialog uses — paths. Never bytes.
  ipcMain.handle('tetravox:sample-catalog', () => ({
    samples: catalogue(),
    cacheDir: sampleCacheDir(),
  }));
  ipcMain.handle('tetravox:sample-statuses', () => sampleStatuses());
  ipcMain.handle('tetravox:sample-open', async (_event, id: unknown) => {
    const sample = typeof id === 'string' ? sampleById(id) : undefined;
    if (sample === undefined) return { ok: false, error: `unknown sample ${String(id)}` };
    try {
      const paths = await startSample(sample, (p) =>
        getWindow()?.webContents.send('tetravox:sample-progress', p)
      );
      // A sample with a shipped scene opens *configured* — layout, presets, camera — through the
      // scene route, which replaces what is on screen exactly as Open Scene… does. The files are
      // allow-listed first: the scene's bare `DatasetRef.path`s resolve beside it (§4.6), and the
      // renderer's relocate check asks main about each one.
      const scene = materialiseScene(sample);
      toOpened(paths);
      if (scene !== null) sendOpenScene(getWindow(), scene);
      else sendOpened(getWindow(), toOpened(paths));
      return { ok: true, paths };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });
  ipcMain.handle('tetravox:sample-cancel', (_event, id: unknown) =>
    typeof id === 'string' ? cancelSample(id) : false
  );
  ipcMain.handle('tetravox:sample-remove', (_event, id: unknown) => {
    const sample = typeof id === 'string' ? sampleById(id) : undefined;
    if (sample !== undefined) removeSample(sample);
    return sampleStatuses();
  });
  ipcMain.handle('tetravox:sample-reveal-cache', () => revealSampleCache());
  // -- Extensions (§13, `module-store.ts`, 2026-08-30) ---------------------------------------------
  // The Sample Data shape, one door further in: main downloads, hashes, consents and serves, and the
  // renderer sees ids, progress numbers and card states. The one difference from the block above is
  // that the payload is **script**, so nothing here hands the renderer a path — an enabled module is
  // reachable only as `tetravox://module/<id>/<version>/<file>`, off a map only `enableModule` fills.
  ipcMain.handle('tetravox:module-catalog', () => ({
    modules: moduleCatalogue(),
    dir: moduleDir(),
  }));
  ipcMain.handle('tetravox:module-statuses', () => moduleStatuses());
  ipcMain.handle('tetravox:module-install', async (_event, id: unknown, version: unknown) =>
    installModuleAction(id, version, (p) =>
      getWindow()?.webContents.send('tetravox:module-progress', p)
    )
  );
  ipcMain.handle('tetravox:module-cancel', (_event, id: unknown) =>
    typeof id === 'string' ? cancelInstall(id) : false
  );
  // Enable **is** consent: the renderer shows the sheet, the user says yes, and this is the message
  // that says so. Everything the consent buys — the protocol map entry, a place in `validateJob`'s
  // manifest list — is granted here and nowhere else.
  ipcMain.handle('tetravox:module-enable', (_event, id: unknown) => enableModuleAction(id));
  // …and withdrawing it is main's own act: the map entries go, the settings key goes, and the
  // module's write admissions are revoked here rather than being asked for back over
  // `tetravox:module-clear-writes`, which a renderer that has been taken over simply never sends.
  ipcMain.handle('tetravox:module-disable', (_event, id: unknown) => disableModuleAction(id));
  ipcMain.handle('tetravox:module-remove', (_event, id: unknown) => removeModuleAction(id));
  ipcMain.handle('tetravox:module-reveal-dir', () => revealModuleDir());
  /**
   * The installed manifests, for the renderer's own `registerInstalledManifests()`.
   *
   * The same array registered in **both** processes (§13.1): main needs it to validate a job action
   * before a window exists, and the renderer needs it because `manifestFor` is called synchronously
   * while rendering — a layer's owner badge, the status cells, a toast naming a module. Manifests
   * are data (no DOM type, no `node:` import), so this is one small JSON round trip and not a
   * capability: knowing a module's title admits nothing.
   */
  ipcMain.handle('tetravox:module-manifests', () => installedManifests());

  void app.whenReady().then(() => {
    // No dock icon for a run that has no window: the bounce and the icon are themselves a visible
    // interruption, and on macOS the dock is what a background Electron would otherwise announce
    // itself with. `app.dock` is undefined off darwin.
    if (MODE === 'offscreen') void app.dock?.hide();

    // 3. Serve the scheme (§5, directive A2).
    handleScheme(rendererRoot);
    ensureRcFile();
    buildMenu(getWindow);
    installDownloadHandler();

    const cliPaths = toOpened(collectCliPaths(process.argv, app.getAppPath(), process.cwd()));
    for (const item of cliPaths) console.log(`[tetravox] argv: ${item.path}`);
    const cliSplit = splitScenes(cliPaths.map((item) => item.path));
    const cliScene = cliSplit.scenes[cliSplit.scenes.length - 1];
    if (cliScene !== undefined) startupScene = cliScene;
    startupPaths = [...startupPaths, ...cliPaths.filter((i) => !cliSplit.scenes.includes(i.path))];

    // "Reopen last scene on launch" (directed task 13), off by default. It fills the startup slot
    // **only** when nothing else claimed it: a launch that names a file — `Tetravox study.nii.gz`,
    // a double-clicked scene — is a user saying what they want open, and a remembered scene must
    // never overrule that. `allowPath` doubles as the existence check, so a scene on a disk that is
    // no longer mounted is skipped rather than reported as a failure the user did not ask for.
    const settings = readSettings();
    const last = settings.recentScenes[0];
    if (
      startupScene === null &&
      startupPaths.length === 0 &&
      settings.reopenLastScene &&
      last !== undefined &&
      !isJobRun()
    ) {
      const real = allowPath(last);
      if (real === null) console.log(`[tetravox] last scene is gone: ${last}`);
      else startupScene = real;
    }

    mainWindow = createWindow();
    mainWindow.on('closed', () => {
      mainWindow = null;
    });
    // §5 rule 12: unsaved **module** edits interrupt a close. Inert for a `--job` window, which has
    // nobody to answer the box and would hang until the watchdog, and inert under
    // `TETRAVOX_E2E_DISCARD=1`, which is how a windowless e2e closes a window it made dirty — but
    // only in a build that runs tests: `app.isPackaged` closes that seam, so ambient environment
    // cannot switch off a shipped build's only unsaved-work guard (2026-08-30).
    installCloseGuard(mainWindow, { isJob: isJobRun(), packaged: app.isPackaged });

    if (isJobRun() && mainWindow !== null) {
      // A job that never reports is a job that hung: without these two the process would sit alive
      // with no window on screen and nothing to notice it by.
      armWatchdog(mainWindow, JOB_TIMEOUT_MS);
      mainWindow.webContents.on('render-process-gone', (_event, details) =>
        onRendererGone(`renderer process gone: ${details.reason}`)
      );
      mainWindow.webContents.on('did-fail-load', (_event, code, description) =>
        onRendererGone(`the renderer failed to load: ${description} (${code})`)
      );
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow();
        mainWindow.on('closed', () => {
          mainWindow = null;
        });
        // The same guard, with the same `packaged` seam-closing argument as the first window's:
        // a window re-created after a macOS dock click protects unsaved module edits exactly as
        // the one it replaced did (§5 rule 12).
        installCloseGuard(mainWindow, { isJob: isJobRun(), packaged: app.isPackaged });
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
