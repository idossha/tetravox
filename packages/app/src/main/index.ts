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

import { BrowserWindow, app, ipcMain, nativeTheme, session } from 'electron';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { collectCliPaths } from './cli';
import { buildMenu, sendOpened, showOpenDialog, toOpened } from './menu';
import type { OpenedPath } from './menu';
import { allowPath } from './paths';
import { fileUrl, handleScheme, registerScheme } from './protocol';
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
  readSceneFile,
  showOpenSceneDialog,
  showRelocateDialog,
  showSaveSceneDialog,
  writeSceneFile,
} from './scene-io';
import { windowMode } from './window';
import { readSettings, writeSettings } from './settings';

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

  // macOS `open-file` fires before ready when the app is launched by opening a document.
  app.on('open-file', (event, path) => {
    event.preventDefault();
    const opened = toOpened([path]);
    if (mainWindow) sendOpened(mainWindow, opened);
    else startupPaths = [...startupPaths, ...opened];
  });

  // IPC: dialogs, menus, **paths** and CLI args only. Never bytes (§5 rule 3).
  ipcMain.handle('tetravox:open-dialog', async () => showOpenDialog(getWindow()));
  ipcMain.handle('tetravox:allow-path', (_event, path: unknown) => {
    if (typeof path !== 'string') return null;
    const real = allowPath(path);
    return real === null ? null : { path: real, url: fileUrl(real) };
  });
  ipcMain.handle('tetravox:startup-paths', () => {
    const opened = startupPaths;
    startupPaths = [];
    return opened;
  });
  ipcMain.handle('tetravox:phase0-fixture', () => {
    const real = allowPath(phase0FixturePath());
    return real === null ? null : { path: real, url: fileUrl(real) };
  });
  // The `--job` channels (`job-runner.ts`). Registered unconditionally: a normal launch asks for a
  // spec once, is told `null`, and takes the UI path.
  registerJobIpc();

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
  ipcMain.handle('tetravox:read-scene', (_event, path: unknown) => readSceneFile(path));
  ipcMain.handle('tetravox:write-scene', (_event, path: unknown, text: unknown) =>
    writeSceneFile(path, text)
  );

  void app.whenReady().then(() => {
    // No dock icon for a run that has no window: the bounce and the icon are themselves a visible
    // interruption, and on macOS the dock is what a background Electron would otherwise announce
    // itself with. `app.dock` is undefined off darwin.
    if (MODE === 'offscreen') void app.dock?.hide();

    // 3. Serve the scheme (§5, directive A2).
    handleScheme(rendererRoot);
    buildMenu(getWindow);
    installDownloadHandler();

    const cliPaths = toOpened(collectCliPaths(process.argv, app.getAppPath(), process.cwd()));
    startupPaths = [...startupPaths, ...cliPaths];
    for (const item of cliPaths) console.log(`[tetravox] argv: ${item.path}`);

    mainWindow = createWindow();
    mainWindow.on('closed', () => {
      mainWindow = null;
    });

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
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
