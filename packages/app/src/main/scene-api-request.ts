/** User-scoped native scene requests with explicit output paths and completion receipts. */
import { constants } from 'node:fs';
import { open, lstat, realpath, link, rm, rename } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { randomBytes } from 'node:crypto';

import type { SceneRequest, SceneSnapshot, SceneReceipt } from '../shared/scene-api-protocol';
const MAX_REQUEST = 16 * 1024;
const MAX_SCENE = 16 * 1024 * 1024;

async function privateRequest(file: string): Promise<SceneRequest> {
  if (!isAbsolute(file)) throw new Error('Request path must be absolute');
  const parent = await lstat(dirname(file));
  const info = await lstat(file);
  if (!parent.isDirectory() || parent.isSymbolicLink() || !info.isFile() || info.isSymbolicLink())
    throw new Error('Request must be a private regular file');
  if (
    process.platform !== 'win32' &&
    ((info.mode & 0o077) !== 0 ||
      (parent.mode & 0o077) !== 0 ||
      info.uid !== process.getuid?.() ||
      parent.uid !== process.getuid?.())
  )
    throw new Error('Request is not private to the current user');
  if (
    info.size > MAX_REQUEST ||
    Date.now() - info.mtimeMs > 60_000 ||
    info.mtimeMs > Date.now() + 5_000
  )
    throw new Error('Request is oversized or expired');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let request: unknown;
  try {
    const checked = await handle.stat();
    if (checked.dev !== info.dev || checked.ino !== info.ino || checked.size > MAX_REQUEST)
      throw new Error('Request changed while opening');
    const buffer = Buffer.alloc(MAX_REQUEST + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_REQUEST) throw new Error('Request is oversized');
    request = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally {
    await handle.close();
  }
  if (!request || typeof request !== 'object') throw new Error('Invalid request');
  const value = request as SceneRequest;
  if (
    value.protocol !== 1 ||
    typeof value.id !== 'string' ||
    !/^[a-f0-9]{32}$/.test(value.id) ||
    !['open-scene', 'save-scene'].includes(value.action) ||
    typeof value.path !== 'string' ||
    (value.expectedScenePath !== undefined && typeof value.expectedScenePath !== 'string') ||
    (value.overwrite !== undefined && typeof value.overwrite !== 'boolean')
  )
    throw new Error('Invalid request');
  return value;
}

async function validatePath(request: SceneRequest): Promise<void> {
  const path = request.path;
  if (
    !isAbsolute(path) ||
    normalize(path) !== path ||
    !path.endsWith('.tetravox.json') ||
    (await realpath(dirname(path))) !== dirname(path)
  ) {
    throw new Error('Scene path must be absolute and canonical with a .tetravox.json suffix');
  }
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (await realpath(path)) !== path)
      throw new Error('Scene target must be a canonical regular file');
    if (request.action === 'save-scene' && request.overwrite !== true)
      throw new Error('Scene already exists; overwrite was not requested');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || request.action === 'open-scene')
      throw error;
  }
}

/** Publish staged bytes atomically; replacement requires an explicit overwrite request. */
async function createAtomic(file: string, text: string, overwrite = false): Promise<void> {
  const temporary = join(dirname(file), `.scene-save-${randomBytes(16).toString('hex')}`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (overwrite) await rename(temporary, file);
    else await link(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Dispatch returns the current renderer state, optionally conditioned on an attachment path. */
export async function handleSceneRequest(
  file: string,
  dispatch: (request: SceneRequest) => Promise<SceneSnapshot>
): Promise<void> {
  const request = await privateRequest(file);
  const receiptPath = `${file}.receipt.json`;
  // Replays never cause a second open/save. The receipt itself is also create-only.
  try {
    await lstat(receiptPath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const receipt: SceneReceipt = { protocol: 1, id: request.id, ok: false };
  try {
    await validatePath(request);
    const snapshot = await dispatch(request);
    if (request.action === 'open-scene' && snapshot.scenePath !== request.path)
      throw new Error('Viewer did not open the requested scene');
    if (
      request.action === 'save-scene' &&
      request.expectedScenePath !== undefined &&
      snapshot.scenePath !== request.expectedScenePath
    )
      throw new Error('Viewer scene does not match expectedScenePath');
    if (request.action === 'save-scene') {
      const text = snapshot.text;
      if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_SCENE)
        throw new Error('Invalid scene snapshot');
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('Invalid scene snapshot');
      // Recheck filesystem scope after waiting for the renderer.
      await validatePath(request);
      await createAtomic(request.path, text, request.overwrite === true);
    }
    receipt.path = request.path;
    receipt.ok = true;
  } catch (error) {
    receipt.error = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
  }
  await createAtomic(receiptPath, JSON.stringify(receipt));
}
