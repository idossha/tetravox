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
  { name: 'Volumes and meshes', extensions: ['nii', 'gz', 'msh', 'gii'] },
  { name: 'NIfTI volume', extensions: ['nii', 'nii.gz'] },
  { name: 'Gmsh mesh', extensions: ['msh'] },
  { name: 'GIfTI surface', extensions: ['gii'] },
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
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
