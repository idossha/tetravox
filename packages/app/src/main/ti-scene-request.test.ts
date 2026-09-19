/** Authored filesystem fixtures; node --test dev/upstream/tetravox-live-scene/*.test.ts. */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
  chmod,
  stat,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { handleTiSceneRequest } from './ti-scene-request';
import type { TiSceneRequest } from '../shared/ti-scene-protocol';

async function fixture(
  run: (root: string, request: TiSceneRequest, file: string) => Promise<void>
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ti-scene-protocol-')));
  try {
    const viewer = join(root, 'code/ti-toolbox/viewer');
    await mkdir(join(viewer, 'scenes'), { recursive: true });
    await mkdir(join(root, 'requests'), { mode: 0o700 });
    const source = join(viewer, 'result.tetravox.json');
    await writeFile(source, '{"cursor":[0,0,0]}');
    const request: TiSceneRequest = {
      protocol: 1,
      id: 'a'.repeat(32),
      nonce: 'b'.repeat(64),
      action: 'save-scene',
      scenePath: source,
      destination: join(viewer, 'scenes/edited.tetravox.json'),
    };
    const file = join(root, 'requests/request.json');
    await writeFile(file, JSON.stringify(request), { mode: 0o600 });
    await run(root, request, file);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('saves live renderer edits, preserves original recipe, acknowledges after file exists', async () =>
  fixture(async (_root, request, file) => {
    await handleTiSceneRequest(file, async () => ({
      scenePath: request.scenePath,
      text: '{"cursor":[7,8,9],"layers":[{"opacity":0.2}]}',
    }));
    assert.deepEqual(JSON.parse(await readFile(request.destination!, 'utf8')).cursor, [7, 8, 9]);
    assert.deepEqual(JSON.parse(await readFile(request.scenePath, 'utf8')).cursor, [0, 0, 0]);
    assert.deepEqual(JSON.parse(await readFile(`${file}.receipt.json`, 'utf8')), {
      protocol: 1,
      id: request.id,
      nonce: request.nonce,
      ok: true,
      path: request.destination,
    });
    await handleTiSceneRequest(file, async () => {
      throw new Error('Replay dispatched');
    });
  }));

test('create-only save never replaces existing file', async () =>
  fixture(async (_root, request, file) => {
    await writeFile(request.destination!, 'existing saved edits');
    await handleTiSceneRequest(file, async () => ({ scenePath: request.scenePath, text: '{}' }));
    assert.equal(await readFile(request.destination!, 'utf8'), 'existing saved edits');
    assert.equal(JSON.parse(await readFile(`${file}.receipt.json`, 'utf8')).ok, false);
  }));

test('wrong renderer scene or missing session fails without writing', async () =>
  fixture(async (_root, _request, file) => {
    await handleTiSceneRequest(file, async () => {
      throw new Error('Viewer is not bound to this TI session');
    });
    assert.match(JSON.parse(await readFile(`${file}.receipt.json`, 'utf8')).error, /not bound/);
  }));

test('project escape is refused before renderer dispatch', async () =>
  fixture(async (root, request, file) => {
    request.destination = join(root, 'outside.tetravox.json');
    await writeFile(file, JSON.stringify(request));
    await handleTiSceneRequest(file, async () => {
      throw new Error('Must not dispatch');
    });
    assert.match(JSON.parse(await readFile(`${file}.receipt.json`, 'utf8')).error, /outside/);
  }));

test.skipIf(process.platform === 'win32')('non-private requests cannot issue commands', async () =>
  fixture(async (_root, _request, file) => {
    await chmod(file, 0o644);
    await assert.rejects(
      handleTiSceneRequest(file, async () => {
        throw new Error('Must not dispatch');
      }),
      /not private/
    );
  })
);

test('first open creates canonical scenes directory for native Save As', async () =>
  fixture(async (_root, request, file) => {
    const directory = dirname(request.destination!);
    await rm(directory, { recursive: true });
    request.action = 'open-scene';
    delete request.destination;
    await writeFile(file, JSON.stringify(request));
    await handleTiSceneRequest(file, async () => ({ scenePath: request.scenePath }));
    assert.equal((await stat(directory)).isDirectory(), true);
    assert.equal(JSON.parse(await readFile(`${file}.receipt.json`, 'utf8')).ok, true);
  }));

test.skipIf(process.platform === 'win32')(
  'binding rejects an existing scenes directory symlink escape',
  async () =>
    fixture(async (root, request, file) => {
      const directory = dirname(request.destination!);
      await rm(directory, { recursive: true });
      await symlink(root, directory, 'dir');
      request.action = 'open-scene';
      delete request.destination;
      await writeFile(file, JSON.stringify(request));
      await handleTiSceneRequest(file, async () => {
        throw new Error('Must not dispatch');
      });
      assert.match(
        JSON.parse(await readFile(`${file}.receipt.json`, 'utf8')).error,
        /not canonical/
      );
    })
);
