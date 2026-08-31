/**
 * The bundling step, driven end to end against a **fixture store**
 * (`node --test scripts/fetch-locked-modules.test.mjs`).
 *
 * No module has been released yet, and this must be provable before one is: `--store <dir>` is the
 * seam that lets a directory of hash-named files stand in for a GitHub release, the same way
 * `TETRAVOX_SAMPLE_DIR` lets a fake cache stand in for the sample-data store. It changes only where
 * the bytes come from — the hash check is the same code on both paths, which is why these tests
 * prove the real one.
 *
 * The failures are what matter here, so each has its own fixture: a tampered file on disk, a store
 * that serves the wrong bytes, a stale index for a module the lock no longer bundles. A build that
 * cannot verify a bundled module must fail, and this is where that is watched happening.
 */

import { deepStrictEqual, match, ok, rejects, strictEqual } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  BUNDLED_INDEX,
  RESOURCES_MODULES,
  assetUrl,
  bundledIndex,
  fetchLocked,
  targetPath,
  verifyOnDisk,
} from './fetch-locked-modules.mjs';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const quiet = () => {};

const INDEX_JS = 'export const activate = () => ({});\n';
/** Different bytes, identical length — so a hash mismatch is what fires, not the byte count. */
const EVIL_JS = 'export const activate = () => ({ });';
const MANIFEST = '{"id":"tetravox.fixture","version":"1.0.0"}\n';

const roots = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A repo root, a store of hash-named assets, and the lock that points at them. */
function fixture({ bundled = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'tvx-modules-'));
  roots.push(base);
  const root = join(base, 'repo');
  const store = join(base, 'store');
  mkdirSync(root, { recursive: true });
  mkdirSync(store, { recursive: true });
  const files = [
    { name: 'index.js', bytes: INDEX_JS.length, sha256: sha256(INDEX_JS), body: INDEX_JS },
    { name: 'manifest.json', bytes: MANIFEST.length, sha256: sha256(MANIFEST), body: MANIFEST },
  ];
  for (const f of files) writeFileSync(join(store, f.sha256), f.body);
  const lock = {
    schema: 1,
    modules: [
      {
        id: 'tetravox.fixture',
        version: '1.0.0',
        hostApi: 1,
        repo: 'idossha/tetravox-fixture',
        tag: 'v1.0.0',
        bundled,
        files: files.map(({ name, bytes, sha256: hash }) => ({ name, bytes, sha256: hash })),
      },
    ],
  };
  return { base, root, store, lock, files };
}

const placed = (root, entry, name) => join(root, targetPath(entry, { name }));

// -- the derived facts ----------------------------------------------------------------------------

test('an asset is fetched by its own hash from the module repo release', () => {
  strictEqual(
    assetUrl({ repo: 'idossha/tetravox-seeg', tag: 'v1.0.0' }, { sha256: 'a'.repeat(64) }),
    `https://github.com/idossha/tetravox-seeg/releases/download/v1.0.0/${'a'.repeat(64)}`
  );
});

test('the on-disk layout is <root>/<id>/<version>/<name>', () => {
  strictEqual(
    targetPath({ id: 'tetravox.seeg', version: '1.0.0' }, { name: 'index.js' }),
    `${RESOURCES_MODULES}/tetravox.seeg/1.0.0/index.js`
  );
});

test('the shipped index is the lock without the entries that are not bundled', () => {
  const { lock } = fixture();
  const index = bundledIndex({
    schema: 1,
    modules: [...lock.modules, { ...lock.modules[0], id: 'lab.other', bundled: false }],
  });
  deepStrictEqual(
    index.modules.map((m) => m.id),
    ['tetravox.fixture']
  );
  deepStrictEqual(Object.keys(index.modules[0]).sort(), [
    'bundled',
    'files',
    'hostApi',
    'id',
    'repo',
    'tag',
    'version',
  ]);
});

// -- the happy path -------------------------------------------------------------------------------

test('a locked module is fetched from the store, verified, and placed where the app looks', async () => {
  const { root, store, lock } = fixture();
  const result = await fetchLocked({ root, lock, store, log: quiet });
  strictEqual(result.bundled, 1);
  deepStrictEqual(
    result.placed.map((p) => p.action),
    ['downloaded', 'downloaded']
  );
  strictEqual(readFileSync(placed(root, lock.modules[0], 'index.js'), 'utf8'), INDEX_JS);
  strictEqual(readFileSync(placed(root, lock.modules[0], 'manifest.json'), 'utf8'), MANIFEST);

  const index = JSON.parse(readFileSync(join(root, RESOURCES_MODULES, BUNDLED_INDEX), 'utf8'));
  deepStrictEqual(index, bundledIndex(lock));
});

test('a second run re-hashes what is there and downloads nothing', async () => {
  const { root, store, lock } = fixture();
  await fetchLocked({ root, lock, store, log: quiet });
  const again = await fetchLocked({ root, lock, store, log: quiet });
  deepStrictEqual(
    again.placed.map((p) => p.action),
    ['verified', 'verified']
  );
});

test('--verify-only passes over a tree the lock agrees with, and needs no store at all', async () => {
  const { root, store, lock } = fixture();
  await fetchLocked({ root, lock, store, log: quiet });
  const check = await fetchLocked({ root, lock, verifyOnly: true, log: quiet });
  deepStrictEqual(
    check.placed.map((p) => p.action),
    ['verified', 'verified']
  );
});

test('an entry that is not bundled is not fetched, and leaves no index behind', async () => {
  const { root, store, lock } = fixture({ bundled: false });
  const result = await fetchLocked({ root, lock, store, log: quiet });
  strictEqual(result.bundled, 0);
  ok(!existsSync(join(root, RESOURCES_MODULES, BUNDLED_INDEX)));
});

// -- the failures, which are the point -------------------------------------------------------------

test('a file whose bytes were tampered with on disk is refused by --verify-only, naming it', async () => {
  const { root, store, lock } = fixture();
  await fetchLocked({ root, lock, store, log: quiet });
  writeFileSync(placed(root, lock.modules[0], 'index.js'), EVIL_JS);
  await rejects(
    () => fetchLocked({ root, lock, verifyOnly: true, log: quiet }),
    (err) => err.message.includes('index.js') && err.message.includes('hashes')
  );
});

test('a tampered file is replaced by a normal run rather than being trusted for existing', async () => {
  const { root, store, lock } = fixture();
  await fetchLocked({ root, lock, store, log: quiet });
  writeFileSync(placed(root, lock.modules[0], 'index.js'), 'tampered\n');
  const again = await fetchLocked({ root, lock, store, log: quiet });
  strictEqual(again.placed[0].action, 'downloaded');
  strictEqual(readFileSync(placed(root, lock.modules[0], 'index.js'), 'utf8'), INDEX_JS);
});

test('a store that serves the wrong bytes fails the build and leaves nothing behind', async () => {
  const { root, store, lock } = fixture();
  writeFileSync(join(store, lock.modules[0].files[0].sha256), EVIL_JS);
  await rejects(
    () => fetchLocked({ root, lock, store, log: quiet }),
    (err) => {
      match(err.message, /the download hashes/);
      return err.message.includes('tetravox.fixture@1.0.0');
    }
  );
  ok(!existsSync(placed(root, lock.modules[0], 'index.js')), 'no file');
  ok(
    !existsSync(`${placed(root, lock.modules[0], 'index.js')}.part`),
    'no half-written file either'
  );
});

test('a truncated download is caught by the byte count as well as by the hash', () => {
  const { root, lock } = fixture();
  const target = placed(root, lock.modules[0], 'index.js');
  mkdirSync(join(root, RESOURCES_MODULES, 'tetravox.fixture/1.0.0'), { recursive: true });
  writeFileSync(target, INDEX_JS.slice(0, 5));
  match(verifyOnDisk(target, lock.modules[0].files[0]), /the lock says \d+ B/);
});

test('an absent file is absent under --verify-only and downloaded otherwise', async () => {
  const { root, store, lock } = fixture();
  const check = await fetchLocked({ root, lock, verifyOnly: true, log: quiet });
  deepStrictEqual(
    check.placed.map((p) => p.action),
    ['absent', 'absent']
  );
  await fetchLocked({ root, lock, store, log: quiet });
});

test('an index for a module the lock no longer bundles is removed, not left to mislead main', async () => {
  const { root, store, lock } = fixture();
  await fetchLocked({ root, lock, store, log: quiet });
  ok(existsSync(join(root, RESOURCES_MODULES, BUNDLED_INDEX)));
  await fetchLocked({ root, lock: { schema: 1, modules: [] }, store, log: quiet });
  ok(!existsSync(join(root, RESOURCES_MODULES, BUNDLED_INDEX)));
});

test('--verify-only refuses an index that does not match the lock', async () => {
  const { root, store, lock } = fixture();
  await fetchLocked({ root, lock, store, log: quiet });
  writeFileSync(join(root, RESOURCES_MODULES, BUNDLED_INDEX), '{"schema":1,"modules":[]}\n');
  await rejects(
    () => fetchLocked({ root, lock, verifyOnly: true, log: quiet }),
    (err) => err.message.includes(BUNDLED_INDEX)
  );
});

test('a store that does not have the asset says so, rather than writing an empty file', async () => {
  const { root, base, lock } = fixture();
  await rejects(
    () => fetchLocked({ root, lock, store: join(base, 'empty-store'), log: quiet }),
    (err) => err.message.includes('is not in the store')
  );
  ok(!existsSync(placed(root, lock.modules[0], 'index.js')));
});
