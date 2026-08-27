/**
 * Scene-file IO for `*.tetravox.json` (§4.6, §8: "Scene save/load").
 *
 * The §5 rule the preload bridge is built on — **paths and small JSON only, never bytes** — is what
 * shapes this file. A `ViewSpec` is a few kilobytes of JSON, so it may cross IPC; a dataset never
 * does, and nothing here will read one. Three guards keep that true rather than merely intended:
 *
 *  1. **Reads go through the `tetravox://file/…` allow-list** (`paths.ts`), so the renderer can only
 *     read back a scene the *user* named through a dialog or a drop. A `readTextFile` with no
 *     allow-list check would be the arbitrary-file-read primitive `paths.ts` exists to prevent.
 *  2. **Writes go through a second, separate allow-list**, populated only by the Save dialog. Being
 *     allowed to *read* `T1.nii.gz` must never imply being allowed to overwrite it.
 *  3. **A hard size cap on both directions.** `MAX_SCENE_BYTES` is three orders of magnitude above a
 *     real `ViewSpec` and three orders below `ernie.msh`, so the cap is the line between "small JSON"
 *     and "a byte channel" being drawn in code instead of in a comment.
 */

import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { dialog } from 'electron';
import type { BrowserWindow } from 'electron';
import { allowPath, resolveAllowed } from './paths';
import { fileUrl } from './protocol';
import type { OpenedPath } from './menu';
import { OPEN_FILTERS } from './menu';

/** §4.6's file extension, in one place so the dialog filters and the default name agree. */
export const SCENE_EXTENSION = 'tetravox.json';

export const SCENE_FILTERS = [
  { name: 'Tetravox scene', extensions: ['tetravox.json', 'json'] },
  { name: 'All files', extensions: ['*'] },
];

/**
 * 8 MiB. A `ViewSpec` for a two-dataset scene is ~6 kB; the largest plausible one — dozens of layers
 * each with a `visibleLabels` array — is still under a megabyte. Anything past this is not a scene.
 */
export const MAX_SCENE_BYTES = 8 * 1024 * 1024;

/** Paths the user chose in a **Save** dialog. Separate from the read allow-list on purpose. */
const writable = new Set<string>();

/** Canonicalise for the writable set. The file may not exist yet, so `realpath` is not an option. */
function normalise(candidate: string): string | null {
  if (!candidate || !isAbsolute(candidate)) return null;
  return resolve(candidate);
}

/** Admit a path for writing. Only the Save dialog calls this. */
export function allowWrite(candidate: string): string | null {
  const path = normalise(candidate);
  if (path === null) return null;
  writable.add(path);
  return path;
}

export function isWritable(candidate: string): boolean {
  const path = normalise(candidate);
  return path !== null && writable.has(path);
}

/** Test seam, mirroring `paths.ts`'s. */
export function clearWriteList(): void {
  writable.clear();
}

export interface SceneIoResult {
  ok: boolean;
  /** The canonical path that was read or written, when it succeeded. */
  path?: string;
  text?: string;
  error?: string;
}

/**
 * Read a scene file the user named. Returns an error string rather than throwing: the renderer turns
 * it into a §8 toast, and a rejected IPC call there would be an unhandled rejection instead.
 */
export function readSceneFile(candidate: unknown): SceneIoResult {
  if (typeof candidate !== 'string') return { ok: false, error: 'not a path' };
  const real = resolveAllowed(candidate);
  if (real === null) return { ok: false, error: 'not on the allow-list' };
  try {
    const size = statSync(real).size;
    if (size > MAX_SCENE_BYTES) {
      return { ok: false, error: `${size} bytes exceeds the ${MAX_SCENE_BYTES}-byte scene cap` };
    }
    return { ok: true, path: real, text: readFileSync(real, 'utf8') };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Write a scene file to a path the Save dialog admitted, and allow-list it for reading back. */
export function writeSceneFile(candidate: unknown, text: unknown): SceneIoResult {
  if (typeof candidate !== 'string' || typeof text !== 'string') {
    return { ok: false, error: 'not a path and a string' };
  }
  const path = normalise(candidate);
  if (path === null || !writable.has(path)) return { ok: false, error: 'not on the write list' };
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_SCENE_BYTES) {
    return { ok: false, error: `${bytes} bytes exceeds the ${MAX_SCENE_BYTES}-byte scene cap` };
  }
  try {
    writeFileSync(path, text, 'utf8');
    // Saving is also how a scene becomes readable: the user named this path, so "Open" on it next
    // must work without a second dialog.
    allowPath(path);
    return { ok: true, path };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** File ▸ Open Scene… — one `*.tetravox.json`, allow-listed for reading. */
export async function showOpenSceneDialog(win: BrowserWindow | null): Promise<OpenedPath | null> {
  const options: Electron.OpenDialogOptions = {
    title: 'Open scene',
    properties: ['openFile'],
    filters: SCENE_FILTERS,
  };
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  const first = result.canceled ? undefined : result.filePaths[0];
  if (first === undefined) return null;
  const real = allowPath(first);
  return real === null ? null : { path: real, url: fileUrl(real) };
}

/** File ▸ Save Scene As… — the returned path is admitted for **writing** and for nothing else. */
export async function showSaveSceneDialog(
  win: BrowserWindow | null,
  defaultName: unknown
): Promise<string | null> {
  const name = typeof defaultName === 'string' && defaultName !== '' ? defaultName : 'scene';
  const options: Electron.SaveDialogOptions = {
    title: 'Save scene',
    defaultPath: name,
    filters: SCENE_FILTERS,
  };
  const result = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options);
  if (result.canceled || result.filePath === undefined || result.filePath === '') return null;
  return allowWrite(result.filePath);
}

/**
 * The relocate dialog's file picker (§8: "a missing dataset opens a 'relocate' dialog").
 *
 * It is `showOpenDialog` with the dataset's name in the title, so the user is told *which* missing
 * file they are replacing rather than being shown a bare picker.
 */
export async function showRelocateDialog(
  win: BrowserWindow | null,
  missingName: unknown
): Promise<OpenedPath | null> {
  const name = typeof missingName === 'string' ? missingName : 'dataset';
  const options: Electron.OpenDialogOptions = {
    title: `Locate ${name}`,
    properties: ['openFile'],
    filters: OPEN_FILTERS,
  };
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  const first = result.canceled ? undefined : result.filePaths[0];
  if (first === undefined) return null;
  const real = allowPath(first);
  return real === null ? null : { path: real, url: fileUrl(real) };
}
