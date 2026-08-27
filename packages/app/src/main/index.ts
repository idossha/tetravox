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

import { BrowserWindow, app, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { collectCliPaths } from './cli';
import { buildMenu, sendOpened, showOpenDialog, toOpened } from './menu';
import type { OpenedPath } from './menu';
import { allowPath } from './paths';
import { fileUrl, handleScheme, registerScheme } from './protocol';

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

let mainWindow: BrowserWindow | null = null;
const getWindow = (): BrowserWindow | null => mainWindow;

/** Phase-0 fixture: a real file on disk in both dev and packaged, for the gate's file-fetch leg. */
function phase0FixturePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'phase0-fixture.bin')
    : join(app.getAppPath(), 'resources', 'phase0-fixture.bin');
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    backgroundColor: '#0b0b0f',
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

  win.once('ready-to-show', () => win.show());

  const devServer = process.env['ELECTRON_RENDERER_URL'];
  if (devServer && process.env['TETRAVOX_FORCE_PROTOCOL'] !== '1') {
    void win.loadURL(devServer);
  } else {
    void win.loadURL('tetravox://app/index.html');
  }
  return win;
}

// Single instance, so a second `tetravox file.nii` hands its paths to the running window (§8).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv, cwd) => {
    const opened = toOpened(collectCliPaths(argv, app.getAppPath(), cwd));
    if (mainWindow) {
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
  ipcMain.on('tetravox:log', (_event, message: unknown) => {
    console.log(`[tetravox:renderer] ${String(message)}`);
  });

  void app.whenReady().then(() => {
    // 3. Serve the scheme (§5, directive A2).
    handleScheme(rendererRoot);
    buildMenu(getWindow);

    const cliPaths = toOpened(collectCliPaths(process.argv, app.getAppPath(), process.cwd()));
    startupPaths = [...startupPaths, ...cliPaths];
    for (const item of cliPaths) console.log(`[tetravox] argv: ${item.path}`);

    mainWindow = createWindow();
    mainWindow.on('closed', () => {
      mainWindow = null;
    });

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
