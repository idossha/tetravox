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
 *  2. **Writes go through a second, separate allow-list**, populated only by the Save dialog — and,
 *     since 2026-08-30, by **main handing the renderer a `*.tetravox.json` to open**
 *     ({@link allowOpenedScene}). Being allowed to read `T1.nii.gz` must never imply being allowed
 *     to overwrite it, and it still does not: the carve-out is exactly one compound extension, the
 *     app's own scene format, and it is minted where *main* names the file — the Open sheet, the
 *     `tetravox:open-scene` routing (argv, `open-file`, a second instance, Open Recent, Sample
 *     Data), the startup-scene drain, and a drop, whose path only `webUtils.getPathForFile` can
 *     produce. Opening `study.tetravox.json` **is** naming the file ⌘S will save over; before this,
 *     Save on an opened scene was refused with "not on the write list" and only Save As… worked
 *     (§5 rule 10, DECISIONS 2026-08-30).
 *
 *     **It is deliberately not `readSceneFile`'s job.** `tetravox:allow-path` is renderer-callable
 *     with no gesture, so "a read admits a write" let renderer script name any existing scene file,
 *     read it and then overwrite it — a silent clobber primitive that did not exist before the
 *     carve-out. The admission is minted only where main is the one choosing the path.
 *  3. **A hard size cap on both directions.** `MAX_SCENE_BYTES` is three orders of magnitude above a
 *     real `ViewSpec` and three orders below `ernie.msh`, so the cap is the line between "small JSON"
 *     and "a byte channel" being drawn in code instead of in a comment.
 */

import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { dialog } from 'electron';
import type { BrowserWindow } from 'electron';
import { allowPath, resolveAllowed } from './paths';
import { fileUrl } from './protocol';
import type { OpenedPath } from './menu';
import { OPEN_FILTERS, isScenePath } from './menu';

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

/**
 * §5 rule 10's carve-out, minted where **main hands the renderer a scene to open** (2026-08-30).
 *
 * The five callers are the five places main itself chooses the path: {@link showOpenSceneDialog},
 * `menu.ts#sendOpenScene` (the scene half of the `tetravox:opened` routing — argv, `open-file`, a
 * second instance, File ▸ Open Recent, Sample Data), the `tetravox:startup-scene` drain, and the
 * dropped-path channel, whose path can only come from `webUtils.getPathForFile` on a `File` the user
 * really dragged. Opening a scene *is* naming the file ⌘S will save over, so those are exactly the
 * gestures the admission belongs to.
 *
 * Not `readSceneFile`: `tetravox:allow-path` admits any existing absolute path with no gesture, so
 * an admission derived from a bare read is one renderer script can mint for itself — read, then
 * overwrite, for any `*.tetravox.json` on the disk.
 *
 * Both the resolved and the symlink-flattened form are admitted, because main hands out whichever it
 * holds — `sendOpenScene` sends `settings.json`'s remembered path, the Open sheet sends `realpath`'s
 * — and the renderer saves back the one it was given. They name one file; `writeSceneFile`'s check
 * is `resolve()` only, so both have to be on the list for either route to save.
 */
export function allowOpenedScene(candidate: unknown): string | null {
  if (typeof candidate !== 'string' || !isScenePath(candidate)) return null;
  const path = allowWrite(candidate);
  if (path === null) return null;
  try {
    const real = realpathSync(path);
    if (real !== path) allowWrite(real);
  } catch {
    // The file may have gone since main named it. The resolved form is still admitted, and
    // `writeSceneFile` is what will report the failure — with the OS's own reason.
  }
  return path;
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
 *
 * **A read admits nothing.** ⌘S on an opened scene works because {@link allowOpenedScene} ran where
 * main handed the path over, not because this function read it (§5 rule 10): the renderer can put
 * any existing path on the read allow-list itself, so a write derived from a read would be a write
 * the renderer could mint for any `*.tetravox.json` on the disk.
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
    const text = readFileSync(real, 'utf8');
    return { ok: true, path: real, text };
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

/**
 * File ▸ Open Scene… — one `*.tetravox.json`, allow-listed for reading **and**, when it is a scene,
 * admitted for writing: this is the sheet in which the user named the file ⌘S will save over
 * (§5 rule 10). A picked file that is not a scene gains nothing.
 */
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
  if (real === null) return null;
  allowOpenedScene(real);
  return { path: real, url: fileUrl(real) };
}

/** File ▸ Save Scene As… — the returned path is admitted for **writing** and for nothing else. */
export async function showSaveSceneDialog(
  win: BrowserWindow | null,
  defaultName: unknown
): Promise<string | null> {
  // The renderer sends a whole **path** now (directed task 13): `<first dataset's directory>/<name>
  // .tetravox.json`, so the dialog opens beside the data instead of in whatever directory the OS
  // last remembered. A bare name still works and still lands wherever the platform defaults to,
  // which is what every caller written before this did.
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
  return allowWrite(withSceneExtension(result.filePath));
}

/**
 * Give a chosen path §4.6's extension when it has none.
 *
 * A user who types `study` in the Save sheet means `study.tetravox.json`: without the suffix the
 * file association does not fire, `isScenePath` says it is not a scene, and dropping it back on the
 * window opens it as a dataset and fails. Anything that already ends in `.tetravox.json` — or that
 * the user deliberately gave another extension — is left exactly as typed.
 */
export function withSceneExtension(path: string): string {
  return /\.[^./\\]+$/.test(path) ? path : `${path}.${SCENE_EXTENSION}`;
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
