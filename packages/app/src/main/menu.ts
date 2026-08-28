/**
 * Application menu. **File ▸ Open… returns paths over IPC, never bytes** (§5 rule 3): the dialog
 * result is a `string[]`, main adds each to the `tetravox://file/…` allow-list, and the dataset
 * worker fetches them itself.
 */

import { Menu, dialog } from 'electron';
import type { BrowserWindow } from 'electron';
import { allowPaths } from './paths';
import { fileUrl } from './protocol';

/** §12.3/§8: the formats the viewer opens. Kept in one place so the menu and the installer agree. */
export const OPEN_FILTERS = [
  { name: 'Volumes and meshes', extensions: ['nii', 'gz', 'msh', 'gii', 'geo', 'pos'] },
  { name: 'NIfTI volume', extensions: ['nii', 'nii.gz'] },
  { name: 'Gmsh mesh', extensions: ['msh'] },
  { name: 'GIfTI surface', extensions: ['gii'] },
  // Gmsh **parsed post-processing views** — SimNIBS's `eeg_positions/*.geo`, and the `.pos` a
  // Gmsh "Save As" writes. Not the geometry-script `.geo`, which the reader rejects by name.
  { name: 'Gmsh view (electrode positions)', extensions: ['geo', 'pos'] },
  { name: 'All files', extensions: ['*'] },
];

export interface OpenedPath {
  path: string;
  url: string;
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

/** Push opened paths at the renderer, which logs them (Phase 0) and will load them (Phase 1). */
export function sendOpened(win: BrowserWindow | null, opened: readonly OpenedPath[]): void {
  if (opened.length === 0) return;
  for (const item of opened) console.log(`[tetravox] open: ${item.path}`);
  win?.webContents.send('tetravox:opened', opened);
}

/** The scene commands the File menu can ask the renderer to run (§4.6, §8). */
export type SceneCommand = 'new' | 'open' | 'save' | 'saveAs';

/** Ask the renderer to run a scene command. Main never builds or parses a `ViewSpec` itself. */
export function sendSceneCommand(win: BrowserWindow | null, command: SceneCommand): void {
  win?.webContents.send('tetravox:scene-command', command);
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
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
