/** User-scoped, create-only TI handoff. No listening socket or arbitrary file writer. */
import { constants } from 'node:fs';
import { open, lstat, realpath, link, unlink, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, basename, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

import type { TiSceneRequest, TiSceneSnapshot, TiSceneReceipt } from '../shared/ti-scene-protocol';
const MAX_REQUEST = 16 * 1024;
const MAX_SCENE = 16 * 1024 * 1024;

async function privateRequest(file: string): Promise<TiSceneRequest> {
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
  const value = request as TiSceneRequest;
  if (
    value.protocol !== 1 ||
    typeof value.id !== 'string' ||
    typeof value.nonce !== 'string' ||
    !/^[a-f0-9]{32}$/.test(value.id) ||
    !/^[a-f0-9]{64}$/.test(value.nonce) ||
    !['open-scene', 'save-scene'].includes(value.action) ||
    typeof value.scenePath !== 'string'
  )
    throw new Error('Invalid request');
  return value;
}

async function validateScope(request: TiSceneRequest): Promise<void> {
  if (
    !isAbsolute(request.scenePath) ||
    (await realpath(request.scenePath)) !== request.scenePath ||
    !request.scenePath.endsWith('.tetravox.json')
  )
    throw new Error('Scene is not canonical');
  const marker = `${sep}code${sep}ti-toolbox${sep}viewer${sep}`;
  const boundary = request.scenePath.lastIndexOf(marker);
  if (boundary < 1) throw new Error('Scene is outside the TI project viewer directory');
  const expected = join(
    request.scenePath.slice(0, boundary),
    'code',
    'ti-toolbox',
    'viewer',
    'scenes'
  );
  if (request.action === 'open-scene') {
    if ((await realpath(dirname(expected))) !== dirname(expected))
      throw new Error('Project viewer directory is not canonical');
    try {
      await mkdir(expected, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if ((await realpath(expected)) !== expected || !(await lstat(expected)).isDirectory())
      throw new Error('Project scenes directory is not canonical');
    return;
  }
  const destination = request.destination;
  if (
    typeof destination !== 'string' ||
    !isAbsolute(destination) ||
    !destination.endsWith('.tetravox.json')
  )
    throw new Error('Invalid saved scene name');
  const stem = basename(destination).slice(0, -'.tetravox.json'.length);
  if (
    Array.from(stem).length > 80 ||
    !/^[\p{L}\p{N}_ -][\p{L}\p{N}_. -]*$/u.test(stem) ||
    stem.includes('..')
  )
    throw new Error('Invalid saved scene name');
  if (dirname(destination) !== expected || (await realpath(expected)) !== expected)
    throw new Error('Destination is outside the current project scenes directory');
}

/** Stage bytes in the destination filesystem; hard-link publication never replaces a file. */
async function createAtomic(file: string, text: string): Promise<void> {
  const temporary = join(dirname(file), `.ti-save-${randomBytes(16).toString('hex')}`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporary, file);
  } finally {
    await unlink(temporary);
  }
}

/** Dispatch must return the current renderer state, with its independent host-session check. */
export async function handleTiSceneRequest(
  file: string,
  dispatch: (request: TiSceneRequest) => Promise<TiSceneSnapshot>
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
  const receipt: TiSceneReceipt = { protocol: 1, id: request.id, nonce: request.nonce, ok: false };
  try {
    await validateScope(request);
    const snapshot = await dispatch(request);
    if (snapshot.scenePath !== request.scenePath)
      throw new Error('Viewer scene no longer matches the TI session');
    if (request.action === 'save-scene') {
      const text = snapshot.text;
      if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_SCENE)
        throw new Error('Invalid scene snapshot');
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('Invalid scene snapshot');
      // Recheck filesystem scope after waiting for the renderer.
      await validateScope(request);
      await createAtomic(request.destination!, text);
      receipt.path = request.destination;
    } else receipt.path = request.scenePath;
    receipt.ok = true;
  } catch (error) {
    receipt.error = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
  }
  await createAtomic(receiptPath, JSON.stringify(receipt));
}
