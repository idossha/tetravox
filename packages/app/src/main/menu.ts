/**
 * Application menu. **File ▸ Open… returns paths over IPC, never bytes** (§5 rule 3): the dialog
 * result is a `string[]`, main adds each to the `tetravox://file/…` allow-list, and the dataset
 * worker fetches them itself.
 */

import { Menu, dialog } from 'electron';
import type { BrowserWindow } from 'electron';
import { basename, dirname } from 'node:path';
import { allowPath, allowPaths } from './paths';
import { fileUrl } from './protocol';
import { readSettings, writeSettings } from './settings';

/** §12.3/§8: the formats the viewer opens. Kept in one place so the menu and the installer agree. */
export const OPEN_FILTERS = [
  // `json` is here so that ⌘O opens a scene as well as data (directed task 13): §8's ask is that a
  // `*.tetravox.json` behaves "like any other file", and a user who reaches for Open should not
  // have to know which Open they wanted. `sendOpened` routes on the name, not on the dialog.
  {
    name: 'Volumes, meshes and scenes',
    extensions: [
      'nii',
      'gz',
      'mgh',
      'mgz',
      'nrrd',
      'mha',
      'msh',
      'gii',
      'vtk',
      'vtu',
      'vtp',
      'stl',
      'ply',
      'obj',
      'off',
      'mesh',
      'geo',
      'pos',
      'json',
    ],
  },
  { name: 'NIfTI volume', extensions: ['nii', 'nii.gz'] },
  { name: 'FreeSurfer volume', extensions: ['mgh', 'mgz'] },
  { name: 'NRRD / MetaImage volume', extensions: ['nrrd', 'mha'] },
  { name: 'Gmsh mesh', extensions: ['msh'] },
  { name: 'GIfTI surface', extensions: ['gii'] },
  { name: 'VTK mesh', extensions: ['vtk', 'vtu', 'vtp'] },
  { name: 'STL / PLY / OBJ / OFF surface', extensions: ['stl', 'ply', 'obj', 'off'] },
  { name: 'MEDIT mesh', extensions: ['mesh'] },
  // Gmsh **parsed post-processing views** — SimNIBS's `eeg_positions/*.geo`, and the `.pos` a
  // Gmsh "Save As" writes. Not the geometry-script `.geo`, which the reader rejects by name.
  { name: 'Gmsh view (electrode positions)', extensions: ['geo', 'pos'] },
  { name: 'All files', extensions: ['*'] },
];

export interface OpenedPath {
  path: string;
  url: string;
}

/**
 * §4.6's extension, matched the way the app must match it: **on the whole compound suffix**.
 *
 * `.json` alone is not a scene — a `_LUT.json` colormap (§7.6) is a `.json` and opening one as a
 * scene would fail with "no datasets array" instead of loading a colormap.
 */
export function isScenePath(path: string): boolean {
  return /\.tetravox\.json$/i.test(path);
}

/** Split what the user opened into the data files and the scene files. */
export function splitScenes(paths: readonly string[]): { data: string[]; scenes: string[] } {
  const data: string[] = [];
  const scenes: string[] = [];
  for (const path of paths) (isScenePath(path) ? scenes : data).push(path);
  return { data, scenes };
}

export function toOpened(paths: readonly string[]): OpenedPath[] {
  return allowPaths(paths).map((path) => ({ path, url: fileUrl(path) }));
}

/** Show the Open dialog and allow-list what came back. Bytes stay on disk. */
export async function showOpenDialog(win: BrowserWindow | null): Promise<OpenedPath[]> {
  const result = win
    ? await dialog.showOpenDialog(win, {
        properties: ['openFile', 'multiSelections'],
        filters: OPEN_FILTERS,
      })
    : await dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        filters: OPEN_FILTERS,
      });
  if (result.canceled) return [];
  return toOpened(result.filePaths);
}

/**
 * Push opened paths at the renderer.
 *
 * A `*.tetravox.json` among them is **not** a dataset and is split off here (directed task 13), so
 * that one route — the menu, a drop, argv, `open-file`, a second instance — serves both kinds and
 * the renderer never has to sniff a filename. Only the **last** scene is opened: two scenes in one
 * gesture is a user selecting a range in a file picker, and loading them in sequence would show the
 * first for as long as it took to throw it away.
 */
export function sendOpened(win: BrowserWindow | null, opened: readonly OpenedPath[]): void {
  if (opened.length === 0) return;
  for (const item of opened) console.log(`[tetravox] open: ${item.path}`);
  const data = opened.filter((item) => !isScenePath(item.path));
  const scenes = opened.filter((item) => isScenePath(item.path));
  if (data.length > 0) win?.webContents.send('tetravox:opened', data);
  const last = scenes[scenes.length - 1];
  if (last !== undefined) sendOpenScene(win, last.path);
}

/** Ask the renderer to open one scene file by path (Open Recent, a drop, argv, `open-file`). */
export function sendOpenScene(win: BrowserWindow | null, path: string): void {
  win?.webContents.send('tetravox:open-scene', path);
}

/** The scene commands the File menu can ask the renderer to run (§4.6, §8). */
export type SceneCommand = 'new' | 'open' | 'save' | 'saveAs';

/** Ask the renderer to run a scene command. Main never builds or parses a `ViewSpec` itself. */
export function sendSceneCommand(win: BrowserWindow | null, command: SceneCommand): void {
  win?.webContents.send('tetravox:scene-command', command);
}

/** Ask the renderer to open the unified settings dialog (⌘,/Ctrl+,). */
export function sendOpenSettings(win: BrowserWindow | null): void {
  win?.webContents.send('tetravox:open-settings');
}

/** Ask the renderer to open the Sample Data dialog (File ▸ Sample Data…). */
export function sendOpenSampleData(win: BrowserWindow | null): void {
  win?.webContents.send('tetravox:open-sample-data');
}

/**
 * The File ▸ Open Recent submenu (directed task 13).
 *
 * Built from `settings.json` each time {@link buildMenu} runs, which is on launch and after every
 * scene save or open — an Electron menu is immutable once set, so "the list changed" is "rebuild
 * the menu", not "mutate the item". A path is allow-listed at **click** time rather than at build
 * time: allow-listing ten paths on every rebuild would admit files the user has not asked for this
 * session, and `allowPath` returning null on click doubles as the "it is gone" check.
 */
function recentSubmenu(
  getWindow: () => BrowserWindow | null
): Electron.MenuItemConstructorOptions[] {
  const recent = readSettings().recentScenes;
  if (recent.length === 0) {
    return [{ label: 'No recent scenes', enabled: false }];
  }
  return [
    ...recent.map((path) => ({
      label: basename(path),
      // The full path in the tooltip position a menu has: two scenes called `scene.tetravox.json`
      // in two directories are otherwise indistinguishable.
      sublabel: dirname(path),
      toolTip: path,
      click: (): void => {
        const win = getWindow();
        if (allowPath(path) === null) {
          console.log(`[tetravox] recent scene is gone: ${path}`);
          // Drop it and rebuild, so a menu never offers the same dead entry twice.
          writeSettings({ recentScenes: readSettings().recentScenes.filter((p) => p !== path) });
          buildMenu(getWindow);
          return;
        }
        sendOpenScene(win, path);
      },
    })),
    { type: 'separator' },
    {
      label: 'Clear Menu',
      click: (): void => {
        writeSettings({ recentScenes: [] });
        buildMenu(getWindow);
      },
    },
  ];
}

export function buildMenu(getWindow: () => BrowserWindow | null): void {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? ([{ role: 'appMenu' }] satisfies Electron.MenuItemConstructorOptions[]) : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const win = getWindow();
            sendOpened(win, await showOpenDialog(win));
          },
        },
        {
          label: 'Sample Data…',
          click: () => sendOpenSampleData(getWindow()),
        },
        { type: 'separator' },
        // Scene save/load is *asked for* here and *done* in the renderer: only the renderer holds
        // the `Engine` whose `serialize()` produces the `ViewSpec` (§4.6, §8), and main has no
        // business reconstructing one. The menu therefore sends a command, not a result.
        {
          label: 'New Scene',
          accelerator: 'CmdOrCtrl+N',
          click: () => sendSceneCommand(getWindow(), 'new'),
        },
        {
          label: 'Open Scene…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => sendSceneCommand(getWindow(), 'open'),
        },
        { label: 'Open Recent', submenu: recentSubmenu(getWindow) },
        {
          label: 'Save Scene',
          accelerator: 'CmdOrCtrl+S',
          click: () => sendSceneCommand(getWindow(), 'save'),
        },
        {
          label: 'Save Scene As…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => sendSceneCommand(getWindow(), 'saveAs'),
        },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => sendOpenSettings(getWindow()),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
