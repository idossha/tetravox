/**
 * `testdata/manifest.json` and the URLs the worker fetches, for the §6.5 e2e.
 *
 * Every expected number in these specs comes from the manifest — written by nibabel, SimNIBS and the
 * Gmsh Python API reading the fixtures back, never by the writer that made them (§11) — or from
 * AGENTS.md's real-data tables. Nothing is retyped from a previous run's output.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Page } from '@playwright/test';
import type { GpuCapsT, OpArgs, OpName, Phase } from '@tetravox/protocol';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

export interface ManifestValue {
  [k: string]: unknown;
}

export const MANIFEST = JSON.parse(
  readFileSync(`${ROOT}/testdata/manifest.json`, 'utf8')
) as Record<string, Record<string, ManifestValue>>;

export function volume(name: string): ManifestValue {
  const v = MANIFEST.volumes?.[name];
  if (v === undefined) throw new Error(`testdata/manifest.json has no volume ${name}`);
  return v;
}

export function meshEntry(section: string, name: string): ManifestValue {
  const v = MANIFEST[section]?.[name];
  if (v === undefined) throw new Error(`testdata/manifest.json has no ${section}/${name}`);
  return v;
}

/** A committed fixture, over the harness's own origin. */
export const fixtureUrl = (name: string): string => `/testdata/${name}`;

/** A file outside the repo (real data), served through vite's `/@fs` escape hatch. */
export const fsUrl = (absolutePath: string): string => `/@fs${absolutePath}`;

/** `$TETRAVOX_TESTDATA`, or `null` — real-data specs **skip**, never fail, when it is unset. */
export const REAL_DATA: string | null = process.env.TETRAVOX_TESTDATA ?? null;

/** The §7.1 capability set an M-series Mac reports; the R16 branch of the §6.1 ladder. */
export const CAPS_FULL: GpuCapsT = { floatLinear: true, norm16: true, max3d: 2048 };
/** SwiftShader's: `norm16: false`, which is why goldens cannot cover R16 (§11, docs/TESTING.md). */
export const CAPS_NO_NORM16: GpuCapsT = { floatLinear: true, norm16: false, max3d: 2048 };

export interface ProgressRecord {
  id: number;
  phase: Phase;
  done: number;
  total: number;
}

export interface CallOutcome {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
  heapBytes: number;
  progress: ProgressRecord[];
  /** Wall-clock ms from the call to the first `Progress` (§9.1 row 6). */
  firstProgressMs: number;
  elapsedMs: number;
}

/** A typed array as the harness summarises it: exact length, ends, extrema and sum. */
export interface ArraySummary {
  kind: string;
  length: number;
  head: number[];
  min: number;
  max: number;
  sum: number;
  nonFinite: number;
}

export async function open(page: Page): Promise<void> {
  await page.goto('/packages/wasm/e2e/pages/harness.html');
  await page.waitForFunction(() => window.__tvx !== undefined);
  await page.evaluate(() => {
    window.__tvx.open();
  });
}

export async function call<K extends OpName>(
  page: Page,
  op: K,
  args: OpArgs[K],
  key = 'e2e'
): Promise<CallOutcome> {
  return page.evaluate(
    ([o, a, k]) =>
      window.__tvx.call(o as OpName, a as OpArgs[OpName], k as string) as Promise<CallOutcome>,
    [op, args, key] as const
  );
}

/** `call`, refusing anything but success — so a spec that meant to assert values says so. */
export async function must<K extends OpName>(
  page: Page,
  op: K,
  args: OpArgs[K],
  key = 'e2e'
): Promise<CallOutcome> {
  const out = await call(page, op, args, key);
  if (!out.ok) throw new Error(`${op} failed: ${out.error?.code} ${out.error?.message}`);
  return out;
}

export async function sample(page: Page, path: string, indices: number[]): Promise<number[]> {
  return page.evaluate(([p, i]) => window.__tvx.sample(p as string, i as number[]), [
    path,
    indices,
  ] as const);
}

export async function sampleData(page: Page, dtype: string, indices: number[]): Promise<number[]> {
  return page.evaluate(([d, i]) => window.__tvx.sampleData(d as string, i as number[]), [
    dtype,
    indices,
  ] as const);
}

/** Index of voxel `(i, j, k)` in volume `v` — i fastest, then j, then k, then volume (manifest). */
export function voxelIndex(dims: number[], voxel: number[], vol: number, components = 1): number {
  const [nx, ny, nz] = dims as [number, number, number];
  const [i, j, k] = voxel as [number, number, number];
  return (((vol * nz + k) * ny + j) * nx + i) * components;
}

/**
 * Does this module actually contain `tvx-geom` (§6.3)?
 *
 * `tvx-geom` is the Phase-0 `unimplemented!()` stub on `main`, and `tvx-wasm` builds its §6.3 call
 * sites behind a default-off `geom` feature so a stub cannot trap the module (see
 * `crates/tvx-wasm/src/geom.rs` and `docs/DECISIONS.md`). The geometry specs ask the module itself
 * rather than reading a flag, so the day the feature is turned on they start running with no edit
 * here.
 */
export async function geomAvailable(page: Page): Promise<boolean> {
  await open(page);
  const load = await call(page, 'loadMesh', {
    source: { kind: 'url', url: fixtureUrl('mesh_v2_ascii.msh') },
    format: 'auto',
  });
  if (!load.ok) return false;
  const handle = (load.result?.meta as { handle: number }).handle;
  const surface = await call(page, 'surface', { handle, variant: 'indexed' });
  if (surface.ok) return true;
  return surface.error?.code !== 'unsupported';
}

export const GEOM_SKIP =
  'tvx-geom §6.3 is still the Phase-0 stub; rebuild with `--features geom` (docs/DECISIONS.md)';
