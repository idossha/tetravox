/** Scalar contours: analytic LUT/threshold values along triangle-plane intersections. */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { expectGolden, readCanvasRect } from '../helpers/pixels';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const fixture = (name: string): string => `/@fs${REPO}testdata/${name}`;
const SURFACE = fixture('surf_gzipb64.surf.gii');
const FUNC = fixture('surf.func.gii');

const PANE = 768;
const CX = PANE / 2;
const CY = PANE / 2;
const BG = [10, 13, 18] as const;

const XFORM: [number, number, number] = [2.5, -4, 7.25];
/** `f` over the patch's pre-transform vertices, so the world point is un-translated first. */
const LO = -3.2;
const HI = 3.2;

function fieldAt(w: readonly [number, number, number]): number {
  return 0.1 * (w[0] - XFORM[0]) + 0.01 * (w[1] - XFORM[1]);
}

function fixtureVertices(): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let j = 0; j < 4; j += 1) {
    for (let i = 0; i < 4; i += 1) {
      const x = -30 + 20 * i;
      const y = -20 + (40 / 3) * j;
      const z = 5 * Math.cos((Math.PI * i) / 3) + 2 * Math.sin((Math.PI * j) / 3);
      out.push([x + XFORM[0], y + XFORM[1], z + XFORM[2]]);
    }
  }
  return out;
}

function fixtureTriangles(): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let j = 0; j < 3; j += 1) {
    for (let i = 0; i < 3; i += 1) {
      const a = j * 4 + i;
      out.push([a, a + 1, a + 5]);
      out.push([a, a + 5, a + 4]);
    }
  }
  return out;
}

type Seg = [[number, number, number], [number, number, number]];

function contourSegments(normal: [number, number, number], offset: number): Seg[] {
  const verts = fixtureVertices();
  const out: Seg[] = [];
  for (const tri of fixtureTriangles()) {
    const p = tri.map((k) => verts[k] as [number, number, number]);
    const d = p.map((q) => normal[0] * q[0] + normal[1] * q[1] + normal[2] * q[2] + offset);
    const hits: [number, number, number][] = [];
    for (let k = 0; k < 3; k += 1) {
      const da = d[k] as number;
      const db = d[(k + 1) % 3] as number;
      if (da >= 0 === db >= 0) continue;
      const t = da / (da - db);
      const pa = p[k] as [number, number, number];
      const pb = p[(k + 1) % 3] as [number, number, number];
      hits.push([
        pa[0] + (pb[0] - pa[0]) * t,
        pa[1] + (pb[1] - pa[1]) * t,
        pa[2] + (pb[2] - pa[2]) * t,
      ]);
    }
    if (hits.length === 2) out.push([hits[0]!, hits[1]!]);
  }
  return out;
}

function sceneAnchor(): [number, number, number] {
  const verts = fixtureVertices();
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const v of verts) {
    for (let k = 0; k < 3; k += 1) {
      lo[k] = Math.min(lo[k]!, v[k]!);
      hi[k] = Math.max(hi[k]!, v[k]!);
    }
  }
  return [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, (lo[2]! + hi[2]!) / 2];
}

function axialPixel(w: readonly [number, number, number], mmPerPx: number): [number, number] {
  const a = sceneAnchor();
  return [
    Math.round(CX + (w[0] - a[0]) / mmPerPx - 0.5),
    Math.round(CY - (w[1] - a[1]) / mmPerPx - 0.5),
  ];
}

function greyFor(v: number): number {
  const t = Math.min(1, Math.max(0, (v - LO) / (HI - LO)));
  return Math.min(255, Math.floor(t * 256));
}

function px(img: Uint8Array, x: number, y: number): [number, number, number] {
  const i = (y * PANE + x) * 4;
  return [img[i] ?? 0, img[i + 1] ?? 0, img[i + 2] ?? 0];
}

function isBg(c: readonly number[]): boolean {
  return [0, 1, 2].every((k) => Math.abs(c[k]! - BG[k]!) <= 2);
}

/** The non-background pixels in a `±r` box, so a sub-pixel line position is not a miss. */
function litNear(img: Uint8Array, x: number, y: number, r: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let dy = -r; dy <= r; dy += 1) {
    for (let dx = -r; dx <= r; dx += 1) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= PANE || yy >= PANE) continue;
      const c = px(img, xx, yy);
      if (!isBg(c)) out.push(c);
    }
  }
  return out;
}

declare global {
  interface Window {
    __tvxScalarLayer?: string;
  }
}

/** The patch with its scalar attached and coloured by it, on an axial pane at `z`. */
async function openFieldSurface(page: Page, z: number, mmPerPx: number): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/test/pages/scene.html');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);
  await page.evaluate(
    async ([surf, func, zz, scale, lo, hi]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({ kind: 'path', path: surf as string });
      const layer = engine.addLayer({ datasetId: ds.id, kind: 'mesh' });
      window.__tvxScalarLayer = layer.id;
      const updated = await engine.attachSurfaceData(ds.id, { kind: 'path', path: func as string });
      const field = updated.fields.find((f) => f.source === 'node');
      if (field === undefined) throw new Error('no node field after attach');
      engine.setLayout({ kind: '1x1', cells: ['axial'] });
      engine.setCursor([0, 0, zz as number]);
      engine.setView('axial', { camera: { center: [0, 0], mmPerPx: scale as number } });
      engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });
      engine.updateLayer(layer.id, {
        colorMode: 'field',
        field: { source: 'node', name: field.name, component: 'mag' },
        colormap: 'gray',
        scale: { kind: 'linear', lo: lo as number, hi: hi as number },
        threshold: { lo: null, hi: null, symmetric: false, mode: 'clamp', softEdge: 0 },
      } as never);
      for (let i = 0; i < 40; i += 1) {
        await engine.whenSettled();
        await new Promise((r) => setTimeout(r, 25));
      }
      await engine.whenSettled();
    },
    [SURFACE, FUNC, z, mmPerPx, LO, HI] as const
  );
  return errors;
}

async function patchAndSettle(page: Page, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (p) => {
    const engine = window.__tvxEngine!;
    engine.updateLayer(window.__tvxScalarLayer!, p as never);
    for (let i = 0; i < 40; i += 1) {
      await engine.whenSettled();
      await new Promise((r) => setTimeout(r, 25));
    }
    await engine.whenSettled();
  }, patch);
}

const Z = 8;
const MM_PER_PX = 0.25;

test('contour colours interpolate continuously between endpoints @angle', async ({ page }) => {
  const errors = await openFieldSurface(page, Z, MM_PER_PX);
  const img = await readCanvasRect(page, 0, 0, PANE, PANE);
  let checked = 0;
  for (const [a, b] of contourSegments([0, 0, 1], -Z)) {
    for (const t of [0.2, 0.5, 0.8]) {
      const point = a.map((v, i) => v + (b[i]! - v) * t) as [number, number, number];
      const [x, y] = axialPixel(point, MM_PER_PX);
      const lit = litNear(img, x, y, 1);
      expect(lit.length).toBeGreaterThan(0);
      const want = greyFor(fieldAt(point));
      for (const c of lit) {
        expect(Math.abs(c[0] - want)).toBeLessThanOrEqual(4);
        expect(Math.max(...c) - Math.min(...c)).toBeLessThanOrEqual(2);
      }
      checked += 1;
    }
  }
  expect(checked).toBeGreaterThan(12);
  expect(errors).toEqual([]);
});

test('a `hide` threshold with `hi` open removes samples below `lo` @angle', async ({ page }) => {
  test.slow();
  const errors = await openFieldSurface(page, Z, MM_PER_PX);
  const segs = contourSegments([0, 0, 1], -Z);
  const values = segs.map(([a, b]) => (fieldAt(a) + fieldAt(b)) / 2);
  // A `lo` strictly between two segment values, so both sides of the gate are populated.
  const sorted = [...values].sort((p, q) => p - q);
  const lo =
    (sorted[Math.floor(sorted.length / 2) - 1]! + sorted[Math.floor(sorted.length / 2)]!) / 2;
  await patchAndSettle(page, {
    threshold: { lo, hi: null, symmetric: false, mode: 'hide', softEdge: 0 },
  });
  const img = await readCanvasRect(page, 0, 0, PANE, PANE);
  let kept = 0;
  let dropped = 0;
  segs.forEach(([a, b], i) => {
    const mid: [number, number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const [x, y] = axialPixel(mid, MM_PER_PX);
    const lit = litNear(img, x, y, 1).length;
    if (values[i]! >= lo) {
      expect(lit, `segment ${i} (value ${values[i]} ≥ ${lo}) is drawn`).toBeGreaterThan(0);
      kept += 1;
    } else {
      expect(lit, `segment ${i} (value ${values[i]} < ${lo}) is gone`).toBe(0);
      dropped += 1;
    }
  });
  expect(kept).toBeGreaterThan(0);
  expect(dropped).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('a threshold cuts within one segment and a soft edge ramps alpha @angle', async ({ page }) => {
  const errors = await openFieldSurface(page, Z, MM_PER_PX);
  const segment = contourSegments([0, 0, 1], -Z).sort(
    (a, b) => Math.abs(fieldAt(b[1]) - fieldAt(b[0])) - Math.abs(fieldAt(a[1]) - fieldAt(a[0]))
  )[0]!;
  const [a, b] = fieldAt(segment[0]) < fieldAt(segment[1]) ? segment : [segment[1], segment[0]];
  const lo = (fieldAt(a) + fieldAt(b)) / 2;
  const span = fieldAt(b) - fieldAt(a);
  const point = (t: number) => a.map((v, i) => v + (b[i]! - v) * t) as [number, number, number];
  await patchAndSettle(page, {
    threshold: { lo, hi: null, symmetric: false, mode: 'hide', softEdge: 0 },
  });
  const hard = await readCanvasRect(page, 0, 0, PANE, PANE);
  expect(litNear(hard, ...axialPixel(point(0.25), MM_PER_PX), 1)).toHaveLength(0);
  expect(litNear(hard, ...axialPixel(point(0.75), MM_PER_PX), 1).length).toBeGreaterThan(0);
  // At t=.75: halfway through a ramp of half the endpoint span => smoothstep(.5)=.5.
  await patchAndSettle(page, {
    threshold: { lo, hi: null, symmetric: false, mode: 'hide', softEdge: span / (2 * (HI - LO)) },
  });
  const soft = await readCanvasRect(page, 0, 0, PANE, PANE);
  const [x, y] = axialPixel(point(0.75), MM_PER_PX);
  const samples = litNear(soft, x, y, 0);
  expect(samples).toHaveLength(1);
  const grey = greyFor(fieldAt(point(0.75)));
  for (let k = 0; k < 3; k += 1) {
    expect(Math.abs(samples[0]![k]! - (grey + BG[k]!) / 2)).toBeLessThanOrEqual(7);
  }
  expect(errors).toEqual([]);
});

test('signed heat colors and symmetric thresholds match the surface LUT @angle', async ({
  page,
}) => {
  const errors = await openFieldSurface(page, Z, MM_PER_PX);
  const scale = {
    kind: 'heat',
    min: 0,
    mid: HI / 2,
    max: HI,
    truncate: false,
    inverse: false,
    negative: 'mirror',
  };
  await patchAndSettle(page, {
    scale,
    threshold: { lo: 0.1, hi: null, mode: 'hide', symmetric: true, softEdge: 0 },
  });
  const mirrored = await readCanvasRect(page, 0, 0, PANE, PANE);
  await patchAndSettle(page, { scale: { ...scale, negative: 'hide' } });
  const positive = await readCanvasRect(page, 0, 0, PANE, PANE);
  let negatives = 0;
  let positives = 0;
  for (const [a, b] of contourSegments([0, 0, 1], -Z)) {
    const point = a.map((v, i) => (v + b[i]!) / 2) as [number, number, number];
    const value = fieldAt(point);
    if (Math.abs(value) < 0.2) continue;
    const [x, y] = axialPixel(point, MM_PER_PX);
    const lit = litNear(mirrored, x, y, 0);
    expect(lit).toHaveLength(1);
    const want = Math.round((255 * Math.abs(value)) / HI);
    expect(Math.abs(lit[0]![0] - want)).toBeLessThanOrEqual(4);
    if (value < 0) {
      expect(litNear(positive, x, y, 0)).toHaveLength(0);
      negatives += 1;
    } else {
      expect(litNear(positive, x, y, 0)).toHaveLength(1);
      positives += 1;
    }
  }
  expect(negatives).toBeGreaterThan(0);
  expect(positives).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('a translated surface is cut in its model coordinates @angle', async ({ page }) => {
  const errors = await openFieldSurface(page, Z, MM_PER_PX);
  const before = await readCanvasRect(page, 0, 0, PANE, PANE);
  await page.evaluate(() => {
    const e = window.__tvxEngine!;
    const layer = e.scene.layers.find((l) => l.id === window.__tvxScalarLayer)!;
    const ds = e.scene.datasets.get(layer.datasetId)!;
    if (ds.kind !== 'mesh') throw new Error('mesh required');
    ds.transform[14] = 100;
    e.setCursor([0, 0, 108]);
  });
  await patchAndSettle(page, {});
  const after = await readCanvasRect(page, 0, 0, PANE, PANE);
  let mismatches = 0;
  for (let i = 0; i < before.length; i += 1)
    if (Math.abs(before[i]! - after[i]!) > 2) mismatches += 1;
  expect(mismatches).toBe(0);
  expect(errors).toEqual([]);
});

test('stationary contours switch scalar, annotation and solid bindings and refresh replaced fields @angle', async ({
  page,
}) => {
  test.slow();
  const errors = await openFieldSurface(page, Z, MM_PER_PX);
  const scalar = await readCanvasRect(page, 0, 0, PANE, PANE);
  await page.evaluate(async (path) => {
    const e = window.__tvxEngine!;
    const layer = e.scene.layers.find((l) => l.id === window.__tvxScalarLayer)!;
    const ds = await e.attachSurfaceData(layer.datasetId, { kind: 'path', path });
    e.updateLayer(layer.id, {
      colorMode: 'label',
      label: {
        name: 'surf_regions.label.gii',
        table: ds.labelTables!['surf_regions.label.gii']!,
        mode: 'fill',
        outlineWidthPx: 1,
      },
    } as never);
  }, fixture('surf_regions.label.gii'));
  await patchAndSettle(page, {});
  const annotation = await readCanvasRect(page, 0, 0, PANE, PANE);
  await patchAndSettle(page, { colorMode: 'field' });
  expect(await readCanvasRect(page, 0, 0, PANE, PANE)).toEqual(scalar);
  await patchAndSettle(page, { colorMode: 'solid' });
  expect(await readCanvasRect(page, 0, 0, PANE, PANE)).not.toEqual(annotation);
  await patchAndSettle(page, { colorMode: 'label' });
  expect(await readCanvasRect(page, 0, 0, PANE, PANE)).toEqual(annotation);
  await patchAndSettle(page, { colorMode: 'field' });
  await page.evaluate(async () => {
    const e = window.__tvxEngine!;
    const layer = e.scene.layers.find((l) => l.id === window.__tvxScalarLayer)!;
    if (layer.kind !== 'mesh' || !layer.field) throw new Error('field layer required');
    const text = `<GIFTI Version="1.0" NumberOfDataArrays="1"><DataArray Intent="NIFTI_INTENT_SHAPE" DataType="NIFTI_TYPE_FLOAT32" ArrayIndexingOrder="RowMajorOrder" Dimensionality="1" Dim0="16" Encoding="ASCII" Endian="LittleEndian"><Data>${Array(16).fill(1).join(' ')}</Data></DataArray></GIFTI>`;
    await e.attachSurfaceData(layer.datasetId, {
      kind: 'bytes',
      name: layer.field.name,
      bytes: new TextEncoder().encode(text).buffer,
    });
    // No cursor or layer change: attachment itself must invalidate and request repaint.
    for (let i = 0; i < 40; i += 1) {
      await e.whenSettled();
      await new Promise((r) => setTimeout(r, 25));
    }
  });
  const replaced = await readCanvasRect(page, 0, 0, PANE, PANE);
  for (const [a, b] of contourSegments([0, 0, 1], -Z)) {
    const point = a.map((v, i) => (v + b[i]!) / 2) as [number, number, number];
    const lit = litNear(replaced, ...axialPixel(point, MM_PER_PX), 0);
    expect(lit).toHaveLength(1);
    expect(Math.abs(lit[0]![0] - greyFor(1))).toBeLessThanOrEqual(2);
  }
  expect(errors).toEqual([]);
});

test('golden: surface-contours-scalar', async ({ page }) => {
  const errors = await openFieldSurface(page, Z, MM_PER_PX);
  await patchAndSettle(page, { colormap: 'viridis' });
  expect(errors).toEqual([]);
  await expectGolden(page, 'surface-contours-scalar');
});
