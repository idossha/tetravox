/**
 * **A surface's 2D outline coloured by its field (2026-09-18).**
 *
 * A surface in `colorMode:'field'` draws its plane intersection through the contour program's
 * `CONTOUR_SCALAR` variant: one interpolated node-field value per segment, the layer's baked LUT
 * sampled at it, the layer's `hide` threshold dropping the segment. Three things are asserted:
 *
 * 1. the colour at a computed segment midpoint is the LUT colour of the field value **there** —
 *    the value is computed here from the fixture's own field rule, never read back;
 * 2. a `hide` threshold removes exactly the segments whose value is below `lo`, with `hi` open;
 * 3. the golden.
 *
 * The fixture is `surface-contours.spec.ts`'s patch plus `surf.func.gii` — `scripts/gen-fixtures.py`
 * writes `f = 0.1·x + 0.01·y` over the patch's **pre-transform** vertices, and the surface is then
 * translated by `(2.5, −4, 7.25)`. `f` is linear, so the mean of two edge-hit values is exactly `f`
 * at the segment's midpoint, and a `gray` colormap on a linear scale writes the byte
 * `floor(256 · (f − lo)/(hi − lo))` in every channel (§7.6's `bakeScale`, sampled `NEAREST`).
 */

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
/** The Freeview-yellow default a solid outline has — the colour that must be absent. */
const YELLOW = [255, 230, 38] as const;

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

test('the outline at a segment midpoint is the LUT colour of the field value there @angle', async ({
  page,
}) => {
  const errors = await openFieldSurface(page, Z, MM_PER_PX);
  const segs = contourSegments([0, 0, 1], -Z);
  expect(segs.length).toBeGreaterThan(4);
  const img = await readCanvasRect(page, 0, 0, PANE, PANE);

  let checked = 0;
  for (const [a, b] of segs) {
    const mid: [number, number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    // The op averages the two hit values; `f` is linear, so that is `f(mid)` exactly.
    const want = greyFor((fieldAt(a) + fieldAt(b)) / 2);
    expect(greyFor(fieldAt(mid))).toBe(want);
    const [x, y] = axialPixel(mid, MM_PER_PX);
    const lit = litNear(img, x, y, 1);
    expect(lit.length, `a contour pixel near (${x}, ${y})`).toBeGreaterThan(0);
    // Any lit pixel in the box is on this segment's line (segments are ≥ 10 mm = 40 px apart in
    // the neighbouring rows), so every one must be the segment's grey — and a grey, not yellow.
    for (const c of lit) {
      const [r, g, bl] = c;
      expect(Math.abs(r - g) <= 2 && Math.abs(g - bl) <= 2, `grey at (${x}, ${y}): ${c}`).toBe(
        true
      );
      expect(Math.abs(r - want), `grey ${want} at (${x}, ${y}), got ${c}`).toBeLessThanOrEqual(3);
      expect(
        [0, 1, 2].every((k) => Math.abs(c[k]! - YELLOW[k]!) <= 2),
        'not yellow'
      ).toBe(false);
    }
    checked += 1;
  }
  expect(checked).toBe(segs.length);
  expect(errors).toEqual([]);
});

test('a `hide` threshold with `hi` open removes exactly the segments below `lo` @angle', async ({
  page,
}) => {
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

test('golden: surface-contours-scalar', async ({ page }) => {
  const errors = await openFieldSurface(page, Z, MM_PER_PX);
  await patchAndSettle(page, { colormap: 'viridis' });
  expect(errors).toEqual([]);
  await expectGolden(page, 'surface-contours-scalar');
});
