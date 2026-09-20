/** Authored filesystem fixtures for the generic native scene API; no viewer or GUI is launched. */
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
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleSceneRequest } from './scene-api-request';
import type { SceneRequest } from '../shared/scene-api-protocol';

async function fixture(
  run: (root: string, source: string, request: SceneRequest, file: string) => Promise<void>
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tetravox-scene-api-')));
  try {
    await mkdir(join(root, 'My scene exports'));
    await mkdir(join(root, 'requests'), { mode: 0o700 });
    const source = join(root, 'source.tetravox.json');
    await writeFile(source, '{"cursor":[0,0,0]}');
    const request: SceneRequest = {
      protocol: 1,
      id: 'a'.repeat(32),
      action: 'save-scene',
      path: join(root, 'My scene exports', 'edited scene.tetravox.json'),
    };
    const file = join(root, 'requests/request.json');
    await writeFile(file, JSON.stringify(request), { mode: 0o600 });
    await run(root, source, request, file);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('exports live state to an arbitrary folder without prior API open and preserves source', async () =>
  fixture(async (_root, source, request, file) => {
    await handleSceneRequest(file, async () => ({
      scenePath: source,
      text: '{"cursor":[7,8,9],"layers":[{"opacity":0.2}]}',
    }));
    assert.deepEqual(JSON.parse(await readFile(request.path, 'utf8')).cursor, [7, 8, 9]);
    assert.deepEqual(JSON.parse(await readFile(source, 'utf8')).cursor, [0, 0, 0]);
    assert.deepEqual(JSON.parse(await readFile(`${file}.receipt.json`, 'utf8')), {
      protocol: 1,
      id: request.id,
      ok: true,
      path: request.path,
    });
    await handleSceneRequest(file, async () => {
      throw new Error('Replay dispatched');
    });
  }));

test('create-only save preserves an existing destination', async () =>
  fixture(async (_root, source, request, file) => {
    await writeFile(request.path, 'existing saved edits');
    await handleSceneRequest(file, async () => ({ scenePath: source, text: '{}' }));
    assert.equal(await readFile(request.path, 'utf8'), 'existing saved edits');
    assert.equal(JSON.parse(await readFile(`${file}.receipt.json`, 'utf8')).ok, false);
  }));

test('explicit overwrite replaces an existing regular file atomically', async () =>
  fixture(async (_root, source, request, file) => {
    await writeFile(request.path, 'old scene');
    request.overwrite = true;
    await writeFile(file, JSON.stringify(request));
    await handleSceneRequest(file, async () => ({ scenePath: source, text: '{"cursor":[4,5,6]}' }));
    assert.deepEqual(JSON.parse(await readFile(request.path, 'utf8')).cursor, [4, 5, 6]);
    assert.equal(JSON.parse(await readFile(`${file}.receipt.json`, 'utf8')).ok, true);
  }));

test('optional expected scene guard rejects a different live attachment', async () =>
  fixture(async (_root, source, request, file) => {
    request.expectedScenePath = source;
    await writeFile(file, JSON.stringify(request));
    await handleSceneRequest(file, async () => ({
      scenePath: '/different.tetravox.json',
      text: '{}',
    }));
    assert.equal(JSON.parse(await readFile(`${file}.receipt.json`, 'utf8')).ok, false);
    await assert.rejects(readFile(request.path), { code: 'ENOENT' });
  }));

test('generic open accepts a regular scene outside any project convention', async () =>
  fixture(async (_root, source, request, file) => {
    request.action = 'open-scene';
    request.path = source;
    await writeFile(file, JSON.stringify(request));
    await handleSceneRequest(file, async (received) => {
      assert.equal(received.path, source);
      return { scenePath: source };
    });
    assert.deepEqual(JSON.parse(await readFile(`${file}.receipt.json`, 'utf8')), {
      protocol: 1,
      id: request.id,
      ok: true,
      path: source,
    });
  }));

test('invalid extension cannot dispatch a save', async () =>
  fixture(async (root, _source, request, file) => {
    request.path = join(root, 'other.txt');
    await writeFile(file, JSON.stringify(request));
    let dispatched = false;
    await handleSceneRequest(file, async () => {
      dispatched = true;
      return { text: '{}' };
    });
    assert.equal(dispatched, false);
    assert.equal(JSON.parse(await readFile(`${file}.receipt.json`, 'utf8')).ok, false);
  }));

test.skipIf(process.platform === 'win32')('non-private requests cannot issue commands', async () =>
  fixture(async (_root, _source, _request, file) => {
    await chmod(file, 0o644);
    await assert.rejects(
      handleSceneRequest(file, async () => {
        throw new Error('Must not dispatch');
      }),
      /not private/
    );
  })
);

test.skipIf(process.platform === 'win32')(
  'overwrite never follows a destination symlink',
  async () =>
    fixture(async (_root, source, request, file) => {
      await symlink(source, request.path);
      request.overwrite = true;
      await writeFile(file, JSON.stringify(request));
      await handleSceneRequest(file, async () => ({
        scenePath: source,
        text: '{"clobbered":true}',
      }));
      assert.equal(JSON.parse(await readFile(`${file}.receipt.json`, 'utf8')).ok, false);
      assert.deepEqual(JSON.parse(await readFile(source, 'utf8')).cursor, [0, 0, 0]);
    })
);
