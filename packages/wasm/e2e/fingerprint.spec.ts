/**
 * §4.6 `DatasetRef.fingerprint`, through the real worker.
 *
 * The producer is `tvx_core::fingerprint` (`tvxfp1`), called by `load_volume` / `load_mesh` over the
 * bytes the loader was handed and **before** the parser frees them (§5 rule 5). The UI thread never
 * sees those bytes (§5 rule 3), so this spec is the only place the whole path — fetch, inflate,
 * digest, `VolumeMeta` / `MeshMeta` — can be asserted end to end.
 *
 * Rule 0 (§11): every expected value here is *computed*, never remembered. `tvxfp1` is reimplemented
 * in TypeScript from the algorithm §4.6 writes out and run over the same fixture bytes, so a spec
 * failure means the two implementations disagree — not that a recorded string moved.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { CAPS_FULL, REAL_DATA, fixtureUrl, fsUrl, must, open } from './fixtures';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** `tvxfp1-<len:16hex>-<hash:16hex>`, lower case (§4.6). */
const SHAPE = /^tvxfp1-[0-9a-f]{16}-[0-9a-f]{16}$/;

const MASK = (1n << 64n) - 1n;
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const FULL_LIMIT = 8 * 1024 * 1024;
const CHUNK = 1024 * 1024;

function fnv1a(seed: bigint, bytes: Uint8Array): bigint {
  let h = seed;
  for (const b of bytes) {
    h = ((h ^ BigInt(b)) * FNV_PRIME) & MASK;
  }
  return h;
}

function fmix64(input: bigint): bigint {
  let h = input;
  h ^= h >> 33n;
  h = (h * 0xff51afd7ed558ccdn) & MASK;
  h ^= h >> 33n;
  h = (h * 0xc4ceb9fe1a85ec53n) & MASK;
  h ^= h >> 33n;
  return h;
}

/** §4.6's `tvxfp1`, written a second time in another language over the same bytes. */
function tvxfp1(bytes: Uint8Array): string {
  const n = bytes.length;
  const lenLe = new Uint8Array(8);
  new DataView(lenLe.buffer).setBigUint64(0, BigInt(n), true);
  let h = fnv1a(FNV_OFFSET, lenLe);
  const mid = Math.floor(n / 2) - CHUNK / 2;
  const ranges: Array<[number, number]> =
    n <= FULL_LIMIT
      ? [[0, n]]
      : [
          [0, CHUNK],
          [mid, mid + CHUNK],
          [n - CHUNK, n],
        ];
  for (const [a, b] of ranges) h = fnv1a(h, bytes.subarray(a, b));
  const hex = (v: bigint): string => v.toString(16).padStart(16, '0');
  return `tvxfp1-${hex(BigInt(n))}-${hex(fmix64(h))}`;
}

/** The length half of a fingerprint, as a number. */
function digestedBytes(fingerprint: string): number {
  const parts = fingerprint.split('-');
  return Number.parseInt(parts[1] ?? '', 16);
}

function fixtureBytes(name: string): Uint8Array {
  const b = readFileSync(`${ROOT}/testdata/${name}`);
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}

async function volumeFingerprint(
  page: Page,
  url: string
): Promise<{ fingerprint: string; handle: number }> {
  await open(page);
  const out = await must(page, 'loadVolume', {
    source: { kind: 'url', url },
    caps: CAPS_FULL,
    wantLinear: true,
  });
  const meta = out.result?.meta as { fingerprint: string; handle: number };
  return meta;
}

async function meshFingerprint(
  page: Page,
  url: string,
  sidecars?: { lut?: string; opt?: string }
): Promise<string> {
  await open(page);
  const out = await must(page, 'loadMesh', {
    source: { kind: 'url', url, ...(sidecars === undefined ? {} : { sidecars }) },
    format: 'auto',
  });
  return (out.result?.meta as { fingerprint: string }).fingerprint;
}

test('VolumeMeta.fingerprint is tvxfp1 over the loader’s bytes, digit for digit', async ({
  page,
}) => {
  const meta = await volumeFingerprint(page, fixtureUrl('vol_u8.nii'));
  expect(meta.fingerprint).toMatch(SHAPE);
  // The independent implementation above, over the very bytes on disk.
  expect(meta.fingerprint).toBe(tvxfp1(fixtureBytes('vol_u8.nii')));
  // …and the length half really is the byte count, not a hash of it.
  expect(digestedBytes(meta.fingerprint)).toBe(fixtureBytes('vol_u8.nii').byteLength);
});

test('the same file loaded twice, in two workers, gives the same fingerprint', async ({ page }) => {
  const first = await volumeFingerprint(page, fixtureUrl('vol_f32.nii.gz'));
  const second = await volumeFingerprint(page, fixtureUrl('vol_f32.nii.gz'));
  expect(second.fingerprint).toBe(first.fingerprint);
  // A fresh worker means a fresh handle: the digest is of the bytes, not of the session.
  expect(second.handle).toBe(first.handle);
});

test('a different file gives a different fingerprint', async ({ page }) => {
  const seen = new Map<string, string>();
  for (const name of ['vol_u8.nii', 'vol_i16.nii.gz', 'vol_f32.nii.gz', 'vol_4d.nii.gz']) {
    const meta = await volumeFingerprint(page, fixtureUrl(name));
    expect(
      seen.get(meta.fingerprint),
      `${name} collides with ${seen.get(meta.fingerprint)}`
    ).toBeUndefined();
    seen.set(meta.fingerprint, name);
  }
  expect(seen.size).toBe(4);
});

test('one changed byte changes the fingerprint (§4.6)', async ({ page }) => {
  const plain = fixtureBytes('vol_u8.nii');
  await open(page);
  const outcome = await page.evaluate(
    async ([bytes, name]) => {
      const caps = { floatLinear: true, norm16: true, max3d: 2048 };
      const original = new Uint8Array(bytes as number[]);
      window.__tvx.open();
      const a = await window.__tvx.call('loadVolume', {
        source: { kind: 'bytes', name: name as string, bytes: original.slice().buffer },
        caps,
        wantLinear: true,
      });
      // The last voxel, so the file still parses: a fingerprint that only saw the header would
      // pass every other assertion in this spec and fail this one.
      const edited = original.slice();
      edited[edited.length - 1] = edited[edited.length - 1]! ^ 0x01;
      window.__tvx.open();
      const b = await window.__tvx.call('loadVolume', {
        source: { kind: 'bytes', name: name as string, bytes: edited.buffer },
        caps,
        wantLinear: true,
      });
      return { a, b };
    },
    [Array.from(plain), 'vol_u8.nii'] as const
  );

  expect(outcome.a.ok && outcome.b.ok).toBe(true);
  const fa = (outcome.a.result?.meta as { fingerprint: string }).fingerprint;
  const fb = (outcome.b.result?.meta as { fingerprint: string }).fingerprint;
  expect(fa).toBe(tvxfp1(plain));
  expect(fb).not.toBe(fa);
  // Same size, so only the hash half moved.
  expect(digestedBytes(fb)).toBe(digestedBytes(fa));
});

test('the digest is of the inflated bytes, so .nii and .nii.gz of one volume agree', async ({
  page,
}) => {
  // §5 rule 4 inflates in the worker before WASM sees a byte, so the container is not part of the
  // identity — which is what §4.6's relocate dialog wants: it is matching the dataset.
  const plain = await volumeFingerprint(page, fixtureUrl('vol_u8.nii'));
  const gzipped = await volumeFingerprint(page, fixtureUrl('vol_u8.nii.gz'));
  expect(gzipped.fingerprint).toBe(plain.fingerprint);
});

test('MeshMeta.fingerprint is tvxfp1 too, and the sidecars are not in it', async ({ page }) => {
  const bare = await meshFingerprint(page, fixtureUrl('mesh_v2_binary.msh'));
  expect(bare).toMatch(SHAPE);
  expect(bare).toBe(tvxfp1(fixtureBytes('mesh_v2_binary.msh')));

  // `.msh.opt` seeds tag colours (§6.2) and `_LUT.txt` seeds names; neither is the mesh, so
  // recolouring a tissue must not make the file look like a different one.
  const withSidecars = await meshFingerprint(page, fixtureUrl('mesh_v2_binary.msh'), {
    opt: fixtureUrl('mesh_v2_binary.msh.opt'),
    lut: fixtureUrl('mesh_v2_binary_LUT.txt'),
  });
  expect(withSidecars).toBe(bare);

  // Two meshes of the same lattice in different encodings are different *files*, and §4.6 keys the
  // relocate dialog on the file.
  const ascii = await meshFingerprint(page, fixtureUrl('mesh_v2_ascii.msh'));
  expect(ascii).not.toBe(bare);
  expect(ascii).toBe(tvxfp1(fixtureBytes('mesh_v2_ascii.msh')));
});

test.describe('real data', () => {
  test.skip(REAL_DATA === null, 'TETRAVOX_TESTDATA is unset');
  const root = REAL_DATA ?? '';

  test('T1.nii.gz fingerprints stably, and ernie.msh’s length half is its byte count', async ({
    page,
  }) => {
    const first = await volumeFingerprint(page, fsUrl(`${root}/m2m_ernie/T1.nii.gz`));
    const second = await volumeFingerprint(page, fsUrl(`${root}/m2m_ernie/T1.nii.gz`));
    expect(first.fingerprint).toMatch(SHAPE);
    expect(second.fingerprint).toBe(first.fingerprint);
    // 256×256×208 float32 + the 352-byte NIfTI-1 header: the digest saw the *inflated* stream.
    expect(digestedBytes(first.fingerprint)).toBe(256 * 256 * 208 * 4 + 352);

    const other = await volumeFingerprint(page, fsUrl(`${root}/m2m_ernie/final_tissues.nii.gz`));
    expect(other.fingerprint).not.toBe(first.fingerprint);
  });

  test('the reference meshes fingerprint stably and distinctly', async ({ page }) => {
    const ernie = await meshFingerprint(page, fsUrl(`${root}/m2m_ernie/ernie.msh`));
    const again = await meshFingerprint(page, fsUrl(`${root}/m2m_ernie/ernie.msh`), {
      opt: fsUrl(`${root}/m2m_ernie/ernie.msh.opt`),
    });
    expect(again).toBe(ernie);
    // AGENTS.md's mesh table, so the digest is provably over the whole 175.7 MiB file and not over
    // whatever prefix the fetch happened to deliver first.
    expect(digestedBytes(ernie)).toBe(184_207_351);

    const thalamus = await meshFingerprint(
      page,
      fsUrl(`${root}/Simulations/Thalamus/TI/mesh/Thalamus_TI.msh`)
    );
    expect(digestedBytes(thalamus)).toBe(255_005_467);
    // Same nodes, same tris, same tets — a different file, because it carries `TI_max`.
    expect(thalamus).not.toBe(ernie);
  });
});
