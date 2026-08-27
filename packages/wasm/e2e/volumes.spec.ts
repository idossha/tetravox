/**
 * Every committed fixture volume through the real worker, asserted against
 * `testdata/manifest.json` (§11: the manifest's numbers came from nibabel reading the fixtures back,
 * not from the writer that made them).
 *
 * What this proves that a Rust test cannot: the §6.5.1 `VolumeMeta` that reaches the UI thread
 * carries those numbers — in the wire's own units, layouts and names. The affine is the sharp case:
 * `tvx_nifti::Volume.affine` is row-major `[[f64;4];4]` and `VolumeMeta.affine` is a flat
 * column-major `Mat4x4` (§3), so a transpose that never happened would show up here and nowhere
 * else.
 */

import { expect, test } from '@playwright/test';

import type { ArraySummary } from './fixtures';
import {
  CAPS_FULL,
  CAPS_NO_NORM16,
  MANIFEST,
  call,
  fixtureUrl,
  must,
  open,
  sampleData,
  voxelIndex,
  volume,
} from './fixtures';

const num = (v: unknown): number => v as number;

/** A manifest float; non-finite values are the strings "NaN" / "Infinity" / "-Infinity". */
function manifestFloat(v: unknown): number {
  if (typeof v === 'number') return v;
  if (v === 'NaN') return Number.NaN;
  if (v === 'Infinity') return Number.POSITIVE_INFINITY;
  if (v === '-Infinity') return Number.NEGATIVE_INFINITY;
  return Number.NaN;
}

/** §6.1's rule, applied to the manifest's on-disk pair, from first principles. */
function applicableScaling(rawSlope: unknown, rawInter: unknown): [number, number] {
  const slope = manifestFloat(rawSlope);
  const inter = manifestFloat(rawInter);
  const applies =
    Number.isFinite(slope) && slope !== 0 && Number.isFinite(inter) && (slope !== 1 || inter !== 0);
  return applies ? [slope, inter] : [1, 0];
}

test.beforeEach(async ({ page }) => {
  await open(page);
});

test('every fixture volume loads, and its VolumeMeta is the manifest', async ({ page }) => {
  const names = Object.keys(MANIFEST.volumes ?? {}).sort();
  expect(names.length).toBeGreaterThanOrEqual(22);

  for (const name of names) {
    const want = volume(name);
    const out = await must(page, 'loadVolume', {
      source: { kind: 'url', url: fixtureUrl(name) },
      caps: CAPS_FULL,
      wantLinear: true,
    });
    const meta = out.result?.meta as Record<string, unknown>;

    expect(meta.name, name).toBe(name);
    expect(meta.dims, name).toEqual(want.dims);
    expect(meta.nvols, name).toBe(want.nvols);
    expect(meta.dtype, name).toBe(want.dtype);
    expect(meta.spacing as number[], name).toEqual(
      (want.spacing as number[]).map((s) => expect.closeTo(s, 6))
    );
    expect(meta.intentCode, name).toBe(want.intentCode);
    // §6.1: scaling is NEVER folded, and it is applied only when
    // `slope.is_finite() && slope != 0 && inter.is_finite() && (slope != 1 || inter != 0)`;
    // otherwise the pair is normalised to (1, 0). `vol_scl_nan.nii` is the fixture that exercises
    // the NaN guard — the manifest encodes its on-disk slope as the string "NaN".
    const [wantSlope, wantInter] = applicableScaling(want.sclSlopeOnDisk, want.sclInterOnDisk);
    expect(meta.sclSlope, name).toBeCloseTo(wantSlope, 6);
    expect(meta.sclInter, name).toBeCloseTo(wantInter, 4);
    expect(typeof meta.headerJson, name).toBe('string');

    // §3: the wire `Mat4x4` is FLAT, length 16, COLUMN-major — the transpose of the manifest's
    // row-major `[row][col]`. `w[col * 4 + row] = m[row][col]`, so `w[12..15]` is the translation.
    const affine = meta.affine as number[];
    const rows = want.affine as number[][];
    expect(affine, name).toHaveLength(16);
    for (let r = 0; r < 4; r += 1) {
      for (let c = 0; c < 4; c += 1) {
        expect(affine[c * 4 + r], `${name} affine[${r}][${c}]`).toBeCloseTo(num(rows[r]?.[c]), 5);
      }
    }

    // `data` is the RAW on-disk samples, kept on the UI thread for probes (§4.3): one element per
    // voxel per volume, in the file's own dtype, nothing folded.
    const data = out.result?.data as { kind: string; byteLength: number };
    const dims = want.dims as number[];
    const voxels = dims[0]! * dims[1]! * dims[2]! * num(want.nvols);
    const components = want.dtype === 'rgb24' ? 3 : want.dtype === 'rgba32' ? 4 : 1;
    const width =
      { u8: 1, i8: 1, rgb24: 1, rgba32: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4, f64: 8 }[
        want.dtype as string
      ] ?? 0;
    expect(data.kind, name).toBe('ArrayBuffer');
    expect(data.byteLength, name).toBe(voxels * components * width);
  }
});

test('stats are the manifest, in physical units, over volume 0 only', async ({ page }) => {
  for (const name of ['vol_u8.nii', 'vol_i16.nii.gz', 'vol_f32.nii.gz', 'vol_scl.nii']) {
    const want = volume(name);
    const stats = want.stats as Record<string, number>;
    const out = await must(page, 'loadVolume', {
      source: { kind: 'url', url: fixtureUrl(name) },
      caps: CAPS_FULL,
      wantLinear: true,
    });
    const meta = out.result?.meta as Record<string, unknown>;
    const got = meta.stats as Record<string, unknown>;
    expect(got.min, name).toBeCloseTo(stats.min!, 4);
    expect(got.max, name).toBeCloseTo(stats.max!, 4);
    expect(got.mean, name).toBeCloseTo(stats.sum! / stats.n!, 4);
    expect((got.percentiles as number[]).length, name).toBe(9);
    const histogram = got.histogram as ArraySummary;
    expect(histogram.kind, name).toBe('Uint32Array');
    expect(histogram.length, name).toBe(256);
    expect(histogram.sum, name).toBe(stats.n);
  }
});

test('`VolumeMeta.stats` is volume 0 only; `volumeFrame` is the only way to any other', async ({
  page,
}) => {
  const name = 'vol_4d.nii.gz';
  const want = volume(name);
  const dims = want.dims as number[];
  const spots = want.spotValues as Array<Record<string, unknown>>;

  const load = await must(page, 'loadVolume', {
    source: { kind: 'url', url: fixtureUrl(name) },
    caps: CAPS_FULL,
    wantLinear: true,
  });
  const meta = load.result?.meta as Record<string, unknown>;
  const handle = meta.handle as number;
  expect(meta.nvols).toBe(3);

  // Volume 0's stats, not the whole 4D array's: the manifest's `stats` covers all 180 samples and
  // maxes at 555, while volume 0 alone tops out at its own spot values.
  const vol0 = spots.filter((s) => s.volume === 0).map((s) => num(s.physical));
  const stats0 = meta.stats as Record<string, number>;
  expect(stats0.max).toBeLessThan(num((want.stats as Record<string, unknown>).max));
  expect(stats0.max).toBeGreaterThanOrEqual(Math.max(...vol0));

  // Every spot value, read out of the raw `data` buffer at the manifest's own voxel order
  // (i fastest, then j, then k, then volume).
  for (const spot of spots) {
    const index = voxelIndex(dims, spot.voxel as number[], num(spot.volume));
    const [got] = await sampleData(page, want.dtype as string, [index]);
    expect(got, `${name} ${JSON.stringify(spot.voxel)} vol ${String(spot.volume)}`).toBeCloseTo(
      num(spot.raw),
      4
    );
  }

  for (const index of [1, 2]) {
    const frame = await must(page, 'volumeFrame', {
      handle,
      volumeIndex: index,
      caps: CAPS_FULL,
      wantLinear: true,
    });
    const f = frame.result as Record<string, unknown>;
    expect(f.volumeIndex).toBe(index);
    const wanted = spots.filter((s) => s.volume === index).map((s) => num(s.physical));
    const fstats = f.stats as Record<string, number>;
    expect(fstats.max).toBeGreaterThanOrEqual(Math.max(...wanted));
    expect(fstats.min).toBeLessThanOrEqual(Math.min(...wanted));
    expect((f.gpuBytes as { kind: string }).kind).toBe('ArrayBuffer');
  }

  const past = await call(page, 'volumeFrame', {
    handle,
    volumeIndex: 3,
    caps: CAPS_FULL,
    wantLinear: true,
  });
  expect(past.ok).toBe(false);
  expect(past.error?.code).toBe('parse');
});

test('the §6.1 ladder reaches the wire, and R16 vs R32F is a capability decision', async ({
  page,
}) => {
  // Both format branches of the ladder, which §11 says the goldens can never both cover: SwiftShader
  // reports `norm16: false`, so the golden authority only ever sees the R32F one.
  const f32 = { kind: 'url' as const, url: fixtureUrl('vol_f32.nii.gz') };
  const withNorm16 = await must(page, 'loadVolume', {
    source: f32,
    caps: CAPS_FULL,
    wantLinear: true,
  });
  expect(
    ((withNorm16.result?.meta as Record<string, unknown>).gpu as Record<string, unknown>).format
  ).toBe('R16');

  await open(page);
  const withoutNorm16 = await must(page, 'loadVolume', {
    source: f32,
    caps: CAPS_NO_NORM16,
    wantLinear: true,
  });
  const gpu = (withoutNorm16.result?.meta as Record<string, unknown>).gpu as Record<
    string,
    unknown
  >;
  expect(gpu.format).toBe('R32F');
  expect(gpu.filterable).toBe(true);

  // §6.1: R16F is never selected. Half-float has an 11-bit mantissa, and `T1.nii.gz`'s max is
  // exactly 65535.0 against half's 65504 ceiling.
  for (const name of Object.keys(MANIFEST.volumes ?? {})) {
    await open(page);
    const out = await must(page, 'loadVolume', {
      source: { kind: 'url', url: fixtureUrl(name) },
      caps: CAPS_NO_NORM16,
      wantLinear: true,
    });
    const format = ((out.result?.meta as Record<string, unknown>).gpu as Record<string, unknown>)
      .format;
    expect(format, name).not.toBe('R16F');
  }
});

test('a label volume brings its ids, its dense remap and its LUT (§6.5.1)', async ({ page }) => {
  const name = 'labels_simnibs.nii.gz';
  const want = volume(name);
  const expected = (MANIFEST.sidecars?.labels_simnibs_LUT?.expected ??
    (MANIFEST.sidecars?.['labels_simnibs_LUT.txt'] as Record<string, unknown>).expected) as Array<
    Record<string, unknown>
  >;

  const out = await must(page, 'loadVolume', {
    source: {
      kind: 'url',
      url: fixtureUrl(name),
      sidecars: { lut: fixtureUrl('labels_simnibs_LUT.txt') },
    },
    caps: CAPS_FULL,
    // `want_linear` is false when the layer is a label (§6.1), which is what puts it on the
    // NEAREST rows of the ladder.
    wantLinear: false,
  });
  const meta = out.result?.meta as Record<string, unknown>;
  expect(meta.isLabel).toBe(true);
  expect((meta.gpu as Record<string, unknown>).format).toBe('R8UI');
  expect((meta.gpu as Record<string, unknown>).filterable).toBe(false);

  const ids = out.result?.labelIds as ArraySummary;
  expect(ids.kind).toBe('Uint32Array');
  expect(ids.length).toBe(want.uniqueCount);
  expect(ids.head.slice(0, ids.length)).toEqual(want.uniqueValues);

  // `denseIndexOf` is indexed BY ID, so it is as long as the largest id + 1 (530 -> 531 entries).
  const dense = out.result?.denseIndexOf as ArraySummary;
  expect(dense.kind).toBe('Uint32Array');
  expect(dense.max).toBe((want.uniqueCount as number) - 1);

  const table = meta.labelTable as Array<Record<string, unknown>>;
  expect(table).toHaveLength(expected.length);
  for (const [i, e] of expected.entries()) {
    expect(table[i]?.id, `entry ${i}`).toBe(e.id);
    expect(table[i]?.name, `entry ${i}`).toBe(e.name);
    expect(table[i]?.color, `entry ${i}`).toEqual(e.rgba255);
  }
});

test('a float32 label volume is still a label volume (§6.1)', async ({ page }) => {
  // The trap AGENTS.md names: `labeling.nii.gz` is float32 with 57 integral unique values, and an
  // `is_label` heuristic that requires an integer dtype misclassifies the atlas the app browses.
  const name = 'labels_float32.nii.gz';
  const want = volume(name);
  const out = await must(page, 'loadVolume', {
    source: { kind: 'url', url: fixtureUrl(name) },
    caps: CAPS_FULL,
    wantLinear: false,
  });
  const meta = out.result?.meta as Record<string, unknown>;
  expect(meta.dtype).toBe('f32');
  expect(meta.isLabel).toBe(true);
  expect((out.result?.labelIds as ArraySummary).length).toBe(want.uniqueCount);
});

test('a volume larger than caps.max3d fails loudly instead of drawing a hole', async ({ page }) => {
  const out = await call(page, 'loadVolume', {
    source: { kind: 'url', url: fixtureUrl('vol_u8.nii') },
    caps: { floatLinear: true, norm16: true, max3d: 4 },
    wantLinear: true,
  });
  expect(out.ok).toBe(false);
  expect(out.error?.code).toBe('unsupported');
  expect(out.error?.message).toMatch(/4/);
});

test('a `.gz` fixture and its uncompressed twin land on identical bytes', async ({ page }) => {
  // `vol_u8.nii` and `vol_u8.nii.gz` are the same volume, so the streaming
  // `DecompressionStream('gzip')` path and the plain path must agree exactly (§5 rule 4).
  const want = volume('vol_u8.nii');
  const spots = want.spotValues as Array<Record<string, unknown>>;
  const readings: number[][] = [];
  for (const name of ['vol_u8.nii', 'vol_u8.nii.gz']) {
    await open(page);
    await must(page, 'loadVolume', {
      source: { kind: 'url', url: fixtureUrl(name) },
      caps: CAPS_FULL,
      wantLinear: true,
    });
    const indices = spots.map((s) => voxelIndex(want.dims as number[], s.voxel as number[], 0));
    readings.push(await sampleData(page, 'u8', indices));
  }
  expect(readings[0]).toEqual(readings[1]);
  expect(readings[0]).toEqual(spots.map((s) => num(s.raw)));
});

test('a `bytes` source carries the same volume as its URL (§6.5.1 LoadSource)', async ({
  page,
}) => {
  const name = 'vol_u16.nii';
  const want = volume(name);
  const viaBytes = await page.evaluate(async (url) => {
    const bytes = await (await fetch(url)).arrayBuffer();
    return window.__tvx.call('loadVolume', {
      source: { kind: 'bytes', name: 'vol_u16.nii', bytes },
      caps: { floatLinear: true, norm16: true, max3d: 2048 },
      wantLinear: true,
    });
  }, fixtureUrl(name));
  expect(viaBytes.ok).toBe(true);
  const meta = (viaBytes.result as Record<string, unknown>).meta as Record<string, unknown>;
  expect(meta.name).toBe(name);
  expect(meta.dims).toEqual(want.dims);
  expect(meta.dtype).toBe('u16');
});
