/**
 * §7.5's pointer layer — the R1 / R2 / R3 gate (P2-01, P2-02, P2-03, P2-04).
 *
 * Every assertion below is one of `docs/requirements/2026-08-27-maintainer.md`'s "Gate test:"
 * clauses, driven by **synthetic pointer events** through `page.mouse` — real `pointerdown` /
 * `pointermove` / `pointerup` / `wheel` from Chromium's input pipeline, not `dispatchEvent`, so what
 * is tested is the path a user's hand takes.
 *
 * The expected world points are derived **independently** of the engine, from §3's preset basis
 * table written out below and the pane camera read back out of the scene. Asking `view/geometry.ts`
 * where a pixel lands and then asserting that the engine put the cursor there would be a tautology;
 * the pure form of the same maths is proved separately in `src/view/plane-anchor.test.ts` and
 * `src/input/camera.test.ts`.
 *
 * Tagged `@angle` so both Playwright projects run it — the gate is about state and about
 * before/after pixel identity, neither of which is renderer-specific, and R1's whole subject is a
 * gesture a user performs on the real GPU.
 */

import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { expectGolden, readCanvasPixels } from '../helpers/pixels';
import { readCornerInfo } from '../helpers/chrome';
// E-MESH's fixture geometry, reused rather than re-derived: §11's "assert a pixel the `interacting`
// level would have changed" needs a fragment whose edge factor is known in closed form, and the
// 3×3×3 lattice under this camera is where that pixel is already worked out (`mesh-support.ts`).
import { FRONT_FACE_CAMERA, PANE } from './mesh-support';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const fixture = (name: string): string => `/@fs${REPO}testdata/${name}`;
/** Ground truth for the label colours R5 asserts — the authored LUT expectation, not the engine. */
const manifest = JSON.parse(readFileSync(`${REPO}testdata/manifest.json`, 'utf8')) as {
  sidecars: Record<string, { expected: { id: number; name: string; rgba255: number[] }[] }>;
};

const TESTDATA = process.env.TETRAVOX_TESTDATA ?? '';
const T1 = TESTDATA === '' ? '' : `/@fs${TESTDATA}/m2m_ernie/T1.nii.gz`;
const hasRealData = TESTDATA !== '' && existsSync(`${TESTDATA}/m2m_ernie/T1.nii.gz`);

/** The scene page's canvas, and therefore every pane rectangle below. */
const CANVAS = 768;
const HALF = CANVAS / 2;

/** 2×2 pane rectangles in canvas pixels, **top-left origin** — the coordinates `page.mouse` takes. */
const PANES = {
  axial: { x: 0, y: 0, width: HALF, height: HALF },
  coronal: { x: HALF, y: 0, width: HALF, height: HALF },
  sagittal: { x: 0, y: HALF, width: HALF, height: HALF },
  view3d: { x: HALF, y: HALF, width: HALF, height: HALF },
} as const;

/** The same rectangles with `gl.viewport`'s bottom-left origin, for `readCornerInfo`. */
const GL_PANES = {
  axial: { x: 0, y: HALF, width: HALF, height: HALF },
  coronal: { x: HALF, y: HALF, width: HALF, height: HALF },
  sagittal: { x: 0, y: 0, width: HALF, height: HALF },
  view3d: { x: HALF, y: 0, width: HALF, height: HALF },
} as const;

type Vec3 = [number, number, number];

/**
 * §3's canonical bases, transcribed rather than imported: `right = cross(up, normal)` in
 * neurological, with §3's preset normals (axial `+Z`, coronal `−Y`, sagittal `−X`).
 */
const BASIS: Record<'axial' | 'coronal' | 'sagittal', { right: Vec3; up: Vec3; normal: Vec3 }> = {
  axial: { right: [1, 0, 0], up: [0, 1, 0], normal: [0, 0, 1] },
  coronal: { right: [1, 0, 0], up: [0, 0, 1], normal: [0, -1, 0] },
  sagittal: { right: [0, -1, 0], up: [0, 0, 1], normal: [-1, 0, 0] },
};

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

interface PaneCamera {
  center: [number, number];
  mmPerPx: number;
  cursor: Vec3;
  /** The scene bbox centre — the in-plane origin `camera.center` is measured from (R3). */
  anchor: Vec3;
  /** §3: radiological negates `right` **only** — a mirror about the vertical screen axis. */
  radiological: boolean;
}

/**
 * The world point a pane pixel addresses, derived from first principles.
 *
 * `world = anchor + right·(cx + sx) + up·(cy + sy) + normal·(cursor·normal − anchor·normal)`, with
 * `sx = (px + 0.5 − w/2)·mmPerPx` and `sy = (h/2 − py − 0.5)·mmPerPx` — §11's pixel-centre
 * convention, the one the orientation tests already assert against.
 */
function worldOfPixel(
  mode: 'axial' | 'coronal' | 'sagittal',
  cam: PaneCamera,
  px: number,
  py: number,
  paneW = HALF,
  paneH = HALF
): Vec3 {
  const base = BASIS[mode];
  const b = cam.radiological ? { ...base, right: base.right.map((v) => -v) as Vec3 } : base;
  const sx = cam.center[0] + (px + 0.5 - paneW / 2) * cam.mmPerPx;
  const sy = cam.center[1] + (paneH / 2 - py - 0.5) * cam.mmPerPx;
  const alongNormal = dot(cam.cursor, b.normal) - dot(cam.anchor, b.normal);
  return [0, 1, 2].map(
    (k) => cam.anchor[k]! + b.right[k]! * sx + b.up[k]! * sy + b.normal[k]! * alongNormal
  ) as Vec3;
}

async function openScene(page: Page, query = ''): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/test/pages/scene.html${query}`);
  await page.waitForFunction(() => window.__tvxEngine !== undefined);
  return errors;
}

/** Load one dataset, add its layer, apply a layout, and settle. */
async function load(
  page: Page,
  url: string,
  kind: 'volume' | 'mesh',
  layout: string[]
): Promise<void> {
  await page.evaluate(
    async ([u, k, cells]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({ kind: 'path', path: u as string });
      engine.addLayer({ datasetId: ds.id, kind: k as 'volume' | 'mesh' });
      const ids = cells as string[];
      engine.setLayout({
        kind: ids.length === 4 ? '2x2' : '1x1',
        cells: ids,
      });
      await engine.whenSettled();
    },
    [url, kind, layout] as const
  );
}

/** The pane camera plus the two points every derivation needs. */
async function cameraOf(page: Page, viewId: string): Promise<PaneCamera> {
  return await page.evaluate((id) => {
    const engine = window.__tvxEngine!;
    const view = engine.views.find((v) => v.id === id)!;
    const cam = (view as { camera: { center: [number, number]; mmPerPx: number } }).camera;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const ds of engine.scene.datasets.values()) {
      for (let k = 0; k < 3; k += 1) {
        min[k] = Math.min(min[k]!, ds.bounds.min[k]!);
        max[k] = Math.max(max[k]!, ds.bounds.max[k]!);
      }
    }
    return {
      center: [cam.center[0], cam.center[1]] as [number, number],
      mmPerPx: cam.mmPerPx,
      cursor: [...engine.scene.cursor] as [number, number, number],
      anchor: [0, 1, 2].map((k) => (min[k]! + max[k]!) / 2) as [number, number, number],
      radiological: engine.scene.radiological,
    };
  }, viewId);
}

const cursorOf = async (page: Page): Promise<Vec3> =>
  await page.evaluate(() => [...window.__tvxEngine!.scene.cursor] as [number, number, number]);

const settle = async (page: Page): Promise<void> => {
  await page.evaluate(async () => {
    await window.__tvxEngine!.whenSettled();
  });
};

/**
 * One wheel notch, **waited on**.
 *
 * `page.mouse.wheel` resolves once the event has been *dispatched* to the renderer, not once the
 * page has handled it, and `whenSettled()` called a microsecond later sees an engine with nothing
 * pending and returns straight away — so a `cursorOf` right after it can read the cursor from before
 * the notch. On the SwiftShader project the handler happened to win that race; on the headed ANGLE
 * one it does not, which is how a step of `1` was read as `2.5`: two notches, one reading. Waiting
 * for the cursor to actually move is the only synchronisation that means anything here.
 */
/**
 * Press `key` until `mmPerPx` reaches `want`, or give up after `limit` presses.
 *
 * Same race as {@link wheelNotch}, one input away: `page.keyboard.press` resolves once the event has
 * been *dispatched*, so a tight loop of 80 presses can outrun the handler and land one step short of
 * the clamp — 0.06 instead of 0.05, seen on the headed ANGLE project and never on SwiftShader.
 * Pressing until the value arrives is the only synchronisation that means anything; the limit is
 * generous, and the assertion after the call is what fails if the clamp is wrong.
 */
async function pressZoomUntil(page: Page, key: string, want: number, limit: number): Promise<void> {
  for (let i = 0; i < limit; i += 1) {
    if ((await cameraOf(page, 'axial')).mmPerPx === want) return;
    await page.keyboard.press(key);
  }
  await settle(page);
}

async function wheelNotch(page: Page, deltaY: number): Promise<void> {
  const before = (await cursorOf(page))[2];
  await page.mouse.wheel(0, deltaY);
  await page.waitForFunction(
    (z) => (window.__tvxEngine!.scene.cursor[2] as number) !== z,
    before as number
  );
  await settle(page);
}

/**
 * The crosshair's centroid inside one pane, in pane pixels — how R1's "the 3D crosshair moves" is
 * measured.
 *
 * `CROSSHAIR_COLOR` is `[1, 0.85, 0.2, 0.9]` over a near-black background, so its ink is the only
 * thing in the pane that is bright in red and green and **dark in blue**; the chrome text is
 * `[0.92, 0.94, 0.98]` and fails the blue test, which is what keeps the orientation letters and the
 * badge out of the centroid. Scanned inside the page so a 384×384 pane is not marshalled out.
 */
async function crosshairCentroid(
  page: Page,
  pane: { x: number; y: number; width: number; height: number }
): Promise<{ x: number; y: number; count: number }> {
  return await page.evaluate((p) => {
    const canvas = document.querySelector('canvas') as HTMLCanvasElement;
    const gl = canvas.getContext('webgl2')!;
    window.__tvxRender?.();
    const px = new Uint8Array(p.width * p.height * 4);
    // The pane's rect is top-left; readPixels is bottom-left.
    gl.readPixels(
      p.x,
      canvas.height - p.y - p.height,
      p.width,
      p.height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      px
    );
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i]!;
      const g = px[i + 1]!;
      const b = px[i + 2]!;
      if (r > 170 && g > 130 && b < 110) {
        const idx = i / 4;
        sx += idx % p.width;
        sy += Math.floor(idx / p.width);
        n += 1;
      }
    }
    return { x: n > 0 ? sx / n : -1, y: n > 0 ? sy / n : -1, count: n };
  }, pane);
}

/** `SLICE n` from one pane's corner block, decoded out of the framebuffer. */
async function sliceReadout(page: Page, pane: keyof typeof GL_PANES): Promise<string> {
  const lines = await readCornerInfo(page, {
    canvasHeight: CANVAS,
    pane: GL_PANES[pane],
    lineCount: 3,
    length: 'SLICE 000'.length,
  });
  return lines[2]?.trim() ?? '';
}

// ===========================================================================================
// R1 — mouse manipulation, not only arrow keys
// ===========================================================================================

test('@angle R1: a synthetic left-drag in the axial pane moves the cursor to the world point the pane camera implies (±½ voxel)', async ({
  page,
}) => {
  test.skip(!hasRealData, 'needs TETRAVOX_TESTDATA');
  test.setTimeout(120_000);
  const errors = await openScene(page);
  await load(page, T1, 'volume', ['axial', 'coronal', 'sagittal', 'view3d']);

  const before = {
    cursor: await cursorOf(page),
    coronal: await sliceReadout(page, 'coronal'),
    sagittal: await sliceReadout(page, 'sagittal'),
    axial: await sliceReadout(page, 'axial'),
    crosshair3d: await crosshairCentroid(page, PANES.view3d),
  };
  // The 3D pane must be drawing a crosshair at all before "it moved" can mean anything.
  expect(before.crosshair3d.count, 'the 3D pane draws a crosshair').toBeGreaterThan(20);

  const cam = await cameraOf(page, 'axial');
  // A drag well inside the axial pane, ending somewhere the cursor has never been.
  const a = { x: 150, y: 210 };
  const b = { x: 236, y: 148 };
  const expected = worldOfPixel('axial', cam, b.x, b.y);

  await page.mouse.move(PANES.axial.x + a.x, PANES.axial.y + a.y);
  await page.mouse.down();
  await page.mouse.move(PANES.axial.x + b.x, PANES.axial.y + b.y, { steps: 8 });
  await page.mouse.up();
  await settle(page);

  const after = await page.evaluate(() => {
    const engine = window.__tvxEngine!;
    const probe = engine.probe(engine.scene.cursor);
    return {
      cursor: [...engine.scene.cursor] as [number, number, number],
      probeWorld: probe.world as [number, number, number],
      voxel: probe.rows[0]?.voxel ?? null,
      value: probe.rows[0]?.value ?? null,
      errors: window.__tvxErrors ?? [],
    };
  });

  expect(errors).toEqual([]);
  expect(after.errors).toEqual([]);
  // `T1.nii.gz` is 1 mm isotropic, so half a voxel is 0.5 mm.
  for (const k of [0, 1, 2] as const) {
    expect(
      Math.abs(after.cursor[k] - expected[k]),
      `cursor[${k}] within ½ voxel of the world point pixel (${b.x}, ${b.y}) addresses`
    ).toBeLessThanOrEqual(0.5);
  }
  expect(after.cursor).not.toEqual(before.cursor);
  // §4.7's `probe` — what §8's info panel reads — describes the same point, on a real voxel.
  expect(after.probeWorld).toEqual(after.cursor);
  expect(after.voxel, 'the cursor landed inside the volume').not.toBeNull();
  expect(after.value).not.toBeNull();

  // "the coronal and sagittal corner SLICE readouts change accordingly". `T1.nii.gz`'s affine
  // (AGENTS.md) maps world x = k − 99.737457, y = −i + 154.1875, z = j − 143.642273, so the pane's
  // stepping voxel index is `j` for axial, `i` for coronal and `k` for sagittal. A drag in the axial
  // pane moves x and y — the coronal and sagittal indices — and cannot move z.
  const wantCoronal = `SLICE ${Math.round(154.1875 - after.cursor[1])}`;
  const wantSagittal = `SLICE ${Math.round(after.cursor[0] + 99.737457)}`;
  expect(await sliceReadout(page, 'coronal')).toBe(wantCoronal);
  expect(await sliceReadout(page, 'sagittal')).toBe(wantSagittal);
  expect(wantCoronal, 'the coronal readout changed').not.toBe(before.coronal);
  expect(wantSagittal, 'the sagittal readout changed').not.toBe(before.sagittal);
  expect(await sliceReadout(page, 'axial'), 'an in-plane drag cannot move the axial slice').toBe(
    before.axial
  );

  // "and the 3D crosshair moves".
  const crosshair3d = await crosshairCentroid(page, PANES.view3d);
  expect(crosshair3d.count).toBeGreaterThan(20);
  expect(
    Math.hypot(crosshair3d.x - before.crosshair3d.x, crosshair3d.y - before.crosshair3d.y),
    'the 3D crosshair followed the cursor'
  ).toBeGreaterThan(2);
});

test('@angle R1: the same on a synthetic fixture, in every 2D pane and in both conventions', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = await openScene(page);
  await load(page, fixture('vol_asym.nii'), 'volume', ['axial', 'coronal', 'sagittal', 'view3d']);

  for (const radiological of [false, true]) {
    await page.evaluate(async (rad) => {
      const engine = window.__tvxEngine!;
      engine.setRadiological(rad as boolean);
      await engine.whenSettled();
    }, radiological);

    for (const mode of ['axial', 'coronal', 'sagittal'] as const) {
      const pane = PANES[mode];
      const cam = await cameraOf(page, mode);
      const target = { x: 137, y: 251 };
      const expected = worldOfPixel(mode, cam, target.x, target.y);

      await page.mouse.move(pane.x + 200, pane.y + 200);
      await page.mouse.down();
      await page.mouse.move(pane.x + target.x, pane.y + target.y, { steps: 4 });
      await page.mouse.up();
      await settle(page);

      const cursor = await cursorOf(page);
      for (const k of [0, 1, 2] as const) {
        expect(
          Math.abs(cursor[k] - expected[k]),
          `${mode} (radiological=${radiological}) cursor[${k}]`
        ).toBeLessThanOrEqual(0.5);
      }
    }
  }
  expect(errors).toEqual([]);
});

test('@angle R1: double-click in the 3D pane sets the cursor to the pick hit', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await openScene(page);
  await load(page, fixture('mesh_v2_binary.msh'), 'mesh', ['view3d']);
  await page.evaluate(async () => {
    const engine = window.__tvxEngine!;
    engine.resetView('view3d');
    await engine.whenSettled();
    // §7.4: the de-indexed pick geometry is built lazily in the worker on the first pick, and a pick
    // issued before it lands returns null. Gate 5 warms it the same way.
    engine.pick('view3d', 384, 384);
    await engine.whenSettled();
  });

  const picks = await page.evaluate(() => {
    const engine = window.__tvxEngine!;
    const out: unknown[] = [];
    engine.on('pick', (p) => out.push(p));
    (window as unknown as { __picks: unknown[] }).__picks = out;
    return out.length;
  });
  expect(picks).toBe(0);

  // The mesh fills the pane after a fit, so the centre is on it.
  await page.mouse.dblclick(CANVAS / 2, CANVAS / 2);
  await settle(page);

  const r = await page.evaluate(() => {
    const engine = window.__tvxEngine!;
    const list = (window as unknown as { __picks: { world: number[] }[] }).__picks;
    const hit = list.filter((p) => p !== null).at(-1) ?? null;
    return { hit, cursor: [...engine.scene.cursor] as [number, number, number] };
  });
  expect(errors).toEqual([]);
  expect(r.hit, 'the double-click hit the mesh').not.toBeNull();
  expect(r.cursor[0]).toBeCloseTo(r.hit!.world[0]!, 6);
  expect(r.cursor[1]).toBeCloseTo(r.hit!.world[1]!, 6);
  expect(r.cursor[2]).toBeCloseTo(r.hit!.world[2]!, 6);
});

test('@angle R1: a left-drag in the 3D pane orbits — the image changes, the cursor does not', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = await openScene(page);
  await load(page, fixture('mesh_v2_binary.msh'), 'mesh', ['view3d']);
  await page.evaluate(async () => {
    const engine = window.__tvxEngine!;
    engine.resetView('view3d');
    await engine.whenSettled();
  });

  const sample: [number, number][] = [];
  for (let x = 240; x < 540; x += 30) for (let y = 240; y < 540; y += 30) sample.push([x, y]);
  const before = await readCanvasPixels(page, sample);
  const cursorBefore = await cursorOf(page);
  const camBefore = await page.evaluate(
    () => (window.__tvxEngine!.scene.view3d.camera.rotation as number[]).slice() as number[]
  );

  await page.mouse.move(CANVAS / 2, CANVAS / 2);
  await page.mouse.down();
  await page.mouse.move(CANVAS / 2 + 120, CANVAS / 2 + 40, { steps: 10 });
  await page.mouse.up();
  await settle(page);

  const after = await readCanvasPixels(page, sample);
  const camAfter = await page.evaluate(
    () => (window.__tvxEngine!.scene.view3d.camera.rotation as number[]).slice() as number[]
  );
  const changed = after.filter((p, i) => p.some((c, k) => c !== before[i]![k])).length;

  expect(errors).toEqual([]);
  expect(camAfter, 'the orbit rotated the camera').not.toEqual(camBefore);
  expect(changed, 'the 3D image changed under the orbit').toBeGreaterThan(sample.length / 10);
  expect(await cursorOf(page), 'an orbit never moves the cursor').toEqual(cursorBefore);
});

// ===========================================================================================
// R2 — zooming in and out of panes
// ===========================================================================================

test('@angle R2: ⌘/Ctrl+wheel zooms about the pointer — mmPerPx shrinks by the step, the world point under P is unchanged (±0.1 mm), and `r` restores the fit', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = await openScene(page);
  const url = hasRealData ? T1 : fixture('vol_asym.nii');
  await load(page, url, 'volume', ['axial']);
  // The auto-fit at load framed a 2x2 cell; `r` refits the pane as it is now, so the baseline has to
  // be taken after the layout, or "restores the fit" compares two different fits.
  await page.evaluate(async () => {
    const engine = window.__tvxEngine!;
    engine.resetView('axial');
    await engine.whenSettled();
  });

  const fit = await cameraOf(page, 'axial');
  // `input/camera.ts`'s ZOOM_STEP, and `WHEEL_NOTCH = 100` — one notch is exactly one step.
  const ZOOM_STEP = 1.2;
  // **Leave room under the [0.05, 20] clamp before measuring a zoom-in step.** The fit of the 8 mm
  // synthetic fixture is `max(0.05, …)` — the 0.05 floor exactly — where one notch in is a no-op and
  // the assertion below would be measuring the clamp instead of the zoom. (`TETRAVOX_TESTDATA` is
  // unset in CI by design, so that is the path CI takes.) Three notches out, about the pane centre,
  // so `camera.center` is still [0,0] and "about the pointer moved it" keeps its meaning.
  await page.evaluate(async (factor) => {
    const engine = window.__tvxEngine!;
    (engine as unknown as { zoomView(id: string, f: number): void }).zoomView('axial', factor);
    await engine.whenSettled();
  }, ZOOM_STEP ** 3);
  const base = await cameraOf(page, 'axial');
  expect(base.center).toEqual([0, 0]);
  // Off-centre on both axes, or a zoom about the centre would pass by accident.
  const P = { x: 190, y: 470 };
  const worldUnderP = worldOfPixel('axial', base, P.x, P.y, CANVAS, CANVAS);

  await page.mouse.move(P.x, P.y);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  await settle(page);

  const zoomed = await cameraOf(page, 'axial');
  expect(zoomed.mmPerPx, 'one notch in is one step').toBeCloseTo(base.mmPerPx / ZOOM_STEP, 9);
  expect(zoomed.mmPerPx).toBeLessThan(base.mmPerPx);

  const stillUnderP = worldOfPixel('axial', zoomed, P.x, P.y, CANVAS, CANVAS);
  for (const k of [0, 1, 2] as const) {
    expect(
      Math.abs(stillUnderP[k] - worldUnderP[k]),
      `the world point under the pointer is unchanged on axis ${k}`
    ).toBeLessThanOrEqual(0.1);
  }
  // Zooming about the pointer *must* have moved the pane centre — that is what "about the pointer"
  // means, and a zoom about the centre would leave it at [0,0].
  expect(zoomed.center).not.toEqual(base.center);

  // Out again returns the scale exactly.
  await page.mouse.move(P.x, P.y);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 100);
  await page.keyboard.up('Control');
  await settle(page);
  expect((await cameraOf(page, 'axial')).mmPerPx).toBeCloseTo(base.mmPerPx, 9);

  // `r` restores the fit — the pointer is over the pane, which is what scopes the key to it (R2).
  // Zooming **out** here rather than in, so the state `r` has to undo is off the clamp on either
  // fixture: the synthetic one's fit is already at the floor.
  await page.mouse.move(P.x, P.y);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 300);
  await page.keyboard.up('Control');
  await settle(page);
  expect((await cameraOf(page, 'axial')).mmPerPx).toBeGreaterThan(fit.mmPerPx);
  await page.keyboard.press('r');
  await settle(page);
  const refit = await cameraOf(page, 'axial');
  expect(refit.center).toEqual([0, 0]);
  expect(refit.mmPerPx).toBeCloseTo(fit.mmPerPx, 9);
  expect(errors).toEqual([]);
});

test('@angle R2: `+` and `-` zoom about the pane centre, and mmPerPx is clamped to [0.05, 20]', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = await openScene(page);
  await load(page, fixture('vol_asym.nii'), 'volume', ['axial']);
  const fit = await cameraOf(page, 'axial');

  await page.mouse.move(CANVAS / 2, CANVAS / 2);
  await page.keyboard.press('-');
  await settle(page);
  const out = await cameraOf(page, 'axial');
  expect(out.mmPerPx).toBeCloseTo(fit.mmPerPx * 1.2, 9);
  expect(out.center, 'about the CENTRE leaves the pan alone').toEqual(fit.center);

  await page.keyboard.press('+');
  await settle(page);
  expect((await cameraOf(page, 'axial')).mmPerPx).toBeCloseTo(fit.mmPerPx, 9);

  await pressZoomUntil(page, '-', 20, 80);
  await settle(page);
  expect((await cameraOf(page, 'axial')).mmPerPx, 'clamped at the 20 mm/px ceiling').toBe(20);
  await pressZoomUntil(page, '+', 0.05, 160);
  await settle(page);
  expect((await cameraOf(page, 'axial')).mmPerPx, 'clamped at the 0.05 mm/px floor').toBe(0.05);
  expect(errors).toEqual([]);
});

test('@angle R2: the corner block gains a ×zoom readout when the pane leaves its fit, and loses it again', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = await openScene(page);
  await load(page, fixture('vol_asym.nii'), 'volume', ['axial']);
  await page.evaluate(async () => {
    const engine = window.__tvxEngine!;
    engine.resetView('axial');
    await engine.whenSettled();
  });

  // Decoded out of the framebuffer, not read from scene state (§11, `helpers/chrome.ts`): the corner
  // block is a few hundred pixels of a 589,824-pixel pane, so a golden cannot police it.
  const corner = async (lines: number): Promise<string[]> =>
    await readCornerInfo(page, {
      canvasHeight: CANVAS,
      pane: { x: 0, y: 0, width: CANVAS, height: CANVAS },
      lineCount: lines,
      length: 'RAS -00.0 -00.0 -00.0'.length,
    });

  // At the fit there is nothing to report, so the block is the §8 three: mode, RAS, slice index.
  const atFit = await corner(3);
  expect(atFit[0]?.trim()).toBe('AXIAL');
  expect(atFit[2]?.trim()).toMatch(/^SLICE /);

  // Two notches out is 1.2^-2 = 0.69x.
  await page.mouse.move(CANVAS / 2, CANVAS / 2);
  await page.keyboard.press('-');
  await page.keyboard.press('-');
  await settle(page);
  const zoomed = await corner(4);
  expect(zoomed[0]?.trim()).toBe('AXIAL');
  expect(zoomed[3]?.trim()).toBe(`ZOOM ${(1 / 1.2 ** 2).toFixed(2)}X`);

  // Two notches back in, and the readout goes away rather than printing 1.00X under an unzoomed pane.
  await page.keyboard.press('+');
  await page.keyboard.press('+');
  await settle(page);
  expect((await corner(3))[2]?.trim()).toMatch(/^SLICE /);
  expect(errors).toEqual([]);
});

// ===========================================================================================
// R3 — move the crosshair, not the scan
// ===========================================================================================

test('@angle R3: a left-drag moves the cursor and leaves camera.center and the scan pixels alone; a middle-drag does the opposite', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = await openScene(page);
  const url = hasRealData ? T1 : fixture('vol_asym.nii');
  await load(page, url, 'volume', ['axial']);

  const cam0 = await cameraOf(page, 'axial');
  const a = { x: 300, y: 400 };
  const b = { x: 380, y: 340 };
  const worldA = worldOfPixel('axial', cam0, a.x, a.y, CANVAS, CANVAS);
  const worldB = worldOfPixel('axial', cam0, b.x, b.y, CANVAS, CANVAS);

  // A fixed screen point far from the crosshair before **and** after the drag: the crosshair is a
  // full-width and full-height rule through the cursor, so Q must share neither row nor column with
  // either position, and must miss the corner block and the badge.
  const Q: [number, number][] = [
    [120, 120],
    [120, 600],
    [640, 620],
    [200, 500],
  ];
  const canvasEl: Locator = page.locator('#gl');
  const pixelsBefore = await readCanvasPixels(canvasEl, Q);

  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await settle(page);
  const cursorAtA = await cursorOf(page);
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
  await settle(page);

  const cursorAtB = await cursorOf(page);
  const cam1 = await cameraOf(page, 'axial');

  // "a left-drag from A to B moves the cursor by the world delta A→B"
  for (const k of [0, 1, 2] as const) {
    expect(cursorAtA[k], `pointerdown at A set the cursor to world(A) on axis ${k}`).toBeCloseTo(
      worldA[k],
      6
    );
    expect(
      cursorAtB[k] - cursorAtA[k],
      `the cursor moved by the world delta on axis ${k}`
    ).toBeCloseTo(worldB[k] - worldA[k], 6);
  }
  // "…while `camera.center` is unchanged"
  expect(cam1.center, 'a left-drag never pans').toEqual(cam0.center);
  expect(cam1.mmPerPx).toBe(cam0.mmPerPx);

  // "…the pixel colour at a fixed screen point away from the crosshair is byte-identical
  // before/after the left-drag (the scan did not move)."
  const pixelsAfter = await readCanvasPixels(canvasEl, Q);
  for (let i = 0; i < Q.length; i += 1) {
    expect(
      pixelsAfter[i],
      `pixel ${Q[i]!.join(',')} is byte-identical — the scan did not move`
    ).toEqual(pixelsBefore[i]);
  }

  // "a middle-drag moves `camera.center` while the cursor is unchanged"
  const cursorBeforePan = await cursorOf(page);
  await page.mouse.move(300, 300);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(360, 330, { steps: 6 });
  await page.mouse.up({ button: 'middle' });
  await settle(page);

  const cam2 = await cameraOf(page, 'axial');
  expect(await cursorOf(page), 'a pan never moves the cursor').toEqual(cursorBeforePan);
  expect(cam2.center[0]).toBeCloseTo(cam1.center[0] - 60 * cam1.mmPerPx, 6);
  expect(cam2.center[1]).toBeCloseTo(cam1.center[1] + 30 * cam1.mmPerPx, 6);
  expect(errors).toEqual([]);
});

test('@angle R3: space+drag pans and does not move the cursor', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await openScene(page);
  await load(page, fixture('vol_asym.nii'), 'volume', ['axial']);
  const cam0 = await cameraOf(page, 'axial');
  const cursor0 = await cursorOf(page);

  await page.mouse.move(300, 300);
  await page.keyboard.down('Space');
  await page.mouse.down();
  await page.mouse.move(350, 280, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  await settle(page);

  const cam1 = await cameraOf(page, 'axial');
  expect(await cursorOf(page), 'space+drag is a pan, not a cursor move').toEqual(cursor0);
  expect(cam1.center[0]).toBeCloseTo(cam0.center[0] - 50 * cam0.mmPerPx, 6);
  expect(cam1.center[1]).toBeCloseTo(cam0.center[1] - 20 * cam0.mmPerPx, 6);
  expect(errors).toEqual([]);
});

// ===========================================================================================
// §7.5's remaining 2D gestures, and P2-02/P2-04
// ===========================================================================================

test('@angle §7.5: the wheel steps slices along the normal, reversibly — §11 anti-drift', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = await openScene(page);
  await load(page, fixture('vol_asym.nii'), 'volume', ['axial']);

  // Wheel = slice ±1, along the normal only, and N steps out and back return to the same voxel
  // exactly (§11's anti-drift rule).
  //
  // The scene opens with the cursor on the bbox centre, which on an 8³ volume is voxel 3.5 —
  // between two planes. The first notch therefore both steps and snaps; from there every notch is
  // exactly one voxel, which is what the rule is about.
  const preStart = await cursorOf(page);
  await page.mouse.move(CANVAS / 2, CANVAS / 2);
  await wheelNotch(page, -100);
  const start = await cursorOf(page);
  expect(start[0], 'the snap never moves the cursor in-plane').toBeCloseTo(preStart[0], 9);
  expect(start[1]).toBeCloseTo(preStart[1], 9);

  await wheelNotch(page, -100);
  const stepped = await cursorOf(page);
  expect(stepped[2] - start[2], 'one notch is one 1 mm voxel along the axial normal').toBeCloseTo(
    1,
    9
  );
  expect(stepped[0], 'and nothing in-plane').toBeCloseTo(start[0], 9);
  expect(stepped[1]).toBeCloseTo(start[1], 9);

  for (let i = 0; i < 20; i += 1) await wheelNotch(page, -100);
  expect((await cursorOf(page))[2] - stepped[2]).toBeCloseTo(20, 9);
  for (let i = 0; i < 20; i += 1) await wheelNotch(page, 100);
  expect(await cursorOf(page), 'the snap makes stepping exactly reversible').toEqual(stepped);

  expect(errors).toEqual([]);
});

test('@angle §7.5: right-drag is window/level on the active layer, Shift+drag is its opacity', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = await openScene(page);
  // A **non-label** volume: §7.5 excludes label volumes from window/level in both roles, because a
  // label layer's `Scale` addresses a dense index rather than a physical value. `vol_asym.nii` is
  // one (u8, two unique values); `vol_f32.nii.gz` runs -3.5 … 55.0 with fractional samples.
  await load(page, fixture('vol_f32.nii.gz'), 'volume', ['axial']);
  expect(
    await page.evaluate(() => {
      const ds = [...window.__tvxEngine!.scene.datasets.values()][0];
      return ds !== undefined && ds.kind === 'volume' ? ds.isLabel : true;
    }),
    'window/level needs a non-label volume'
  ).toBe(false);

  const scale0 = await page.evaluate(() => {
    const l = window.__tvxEngine!.scene.layers[0] as { scale: { lo: number; hi: number } };
    return { lo: l.scale.lo, hi: l.scale.hi };
  });
  await page.mouse.move(300, 300);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(420, 300, { steps: 6 });
  await page.mouse.up({ button: 'right' });
  await settle(page);
  const scale1 = await page.evaluate(() => {
    const l = window.__tvxEngine!.scene.layers[0] as { scale: { lo: number; hi: number } };
    return { lo: l.scale.lo, hi: l.scale.hi };
  });
  // `windowLevel` is multiplicative: nx = 120/768, width *= exp(2 * nx).
  expect(scale1.hi - scale1.lo, 'dragging right widens the window').toBeCloseTo(
    (scale0.hi - scale0.lo) * Math.exp((2 * 120) / CANVAS),
    6
  );
  // Horizontal only: the centre is where it was.
  expect((scale1.lo + scale1.hi) / 2).toBeCloseTo((scale0.lo + scale0.hi) / 2, 6);

  // Shift+drag = the active layer's opacity; up is more opaque, so start below 1.
  await page.evaluate(async () => {
    const engine = window.__tvxEngine!;
    engine.updateLayer(engine.scene.layers[0]!.id, { opacity: 0.5 });
    await engine.whenSettled();
  });
  await page.mouse.move(300, 400);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.move(300, 300, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await settle(page);
  const opacity = await page.evaluate(() => window.__tvxEngine!.scene.layers[0]!.opacity);
  expect(opacity, 'dragging up by 100 of 768 px raises opacity by 100/768').toBeCloseTo(
    0.5 + 100 / CANVAS,
    6
  );
  expect(errors).toEqual([]);
});

test('@angle P2-02: `interacting` is entered on input, cleared after the settle, and whenSettled() waits for it', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = await openScene(page);
  await load(page, fixture('vol_asym.nii'), 'volume', ['axial']);

  const qualities = await page.evaluate(() => {
    const engine = window.__tvxEngine!;
    const out: string[] = [];
    engine.on('quality', (q) => out.push(q.name));
    (window as unknown as { __quality: string[] }).__quality = out;
    return out.length;
  });
  expect(qualities).toBe(0);

  await page.mouse.move(300, 300);
  await page.mouse.down();
  const during = await page.evaluate(() => ({
    interacting: (window.__tvxEngine as unknown as { interacting: boolean }).interacting,
    quality: window.__tvxEngine!.scene.quality.name,
  }));
  expect(during.interacting, 'pointerdown enters `interacting`').toBe(true);
  expect(during.quality).toBe('interacting');
  await page.mouse.up();

  // `whenSettled()` resolves only after the flag has cleared (§7.2), and the frame it leaves behind
  // is full quality — §7.2: "leaving it triggers exactly one full-quality re-render".
  await settle(page);
  const after = await page.evaluate(() => ({
    interacting: (window.__tvxEngine as unknown as { interacting: boolean }).interacting,
    quality: window.__tvxEngine!.scene.quality.name,
    events: (window as unknown as { __quality: string[] }).__quality,
  }));
  expect(after.interacting).toBe(false);
  expect(after.quality).toBe('full');
  // Announced, never silent (§7.2).
  expect(after.events).toEqual(['interacting', 'full']);
  expect(errors).toEqual([]);
});

/**
 * §11's named E-SCENE obligation, in full: *"`whenSettled()` after a synthetic drag resolves only
 * after `interacting` clears; the frame drawn then is full quality (**assert a pixel that the
 * `interacting` level would have changed**)."*
 *
 * The test above asserts the flag and the two `quality` events. That is the state half, and on its
 * own it is satisfied by a `QualityLevel` nothing reads — which is what `Scene.quality` was until
 * `render/passes/mesh.ts` started consuming `edges`. This is the pixel half, and it is the one that
 * cannot pass unless the level really applies.
 *
 * The subject is §7.2's `edges false`. On the committed 3×3×3 lattice under `FRONT_FACE_CAMERA` the
 * pane's vertical centre line is the `y = 0` triangle edge shared by the front face's four quads, so
 * a pixel 0.5 px from it has `1 − smoothstep(w − 0.5, w + 0.5, 0.5) = 1` at `w = 4.25` and is
 * therefore **exactly** the edge colour — `mix(rgb, uEdgeColor.rgb, 1 · 1)`. With `edges` off there
 * is no `TVX_EDGES` branch at all and the same fragment is the lit tag colour. Two colours that
 * differ by construction, at a pixel named by the projection rather than found by looking.
 */
test('@angle P2-02 §11: the frame `whenSettled()` leaves is full quality, at a pixel `interacting` changes', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = await openScene(page);
  await load(page, fixture('mesh_v2_binary.msh'), 'mesh', ['view3d']);

  /** 200 px below the pane centre on the `y = 0` grid line — `mesh-gate.spec.ts`'s own probe. */
  const EDGE_PIXEL: [number, number] = [PANE / 2, PANE / 2 + 200];
  const EDGE_RED: [number, number, number] = [255, 0, 0];

  const patch = async (p: Record<string, unknown>): Promise<void> => {
    await page.evaluate(async (q) => {
      const engine = window.__tvxEngine!;
      engine.updateLayer(engine.scene.layers[0]!.id, q as never);
      for (let i = 0; i < 40; i += 1) {
        await engine.whenSettled();
        await new Promise((r) => setTimeout(r, 25));
      }
      await engine.whenSettled();
    }, p);
  };

  await page.evaluate(async (camera) => {
    const engine = window.__tvxEngine!;
    engine.setView('view3d', { camera: camera as never });
    engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });
    await engine.whenSettled();
  }, FRONT_FACE_CAMERA);

  // The control: the same fragment with the edge contributing nothing.
  //
  // `edges: { surface: false }` would be the wrong control, and the difference is the point of
  // §7.2's rule that a fallback level may change *resolution* and not *content*. `layers/mesh.ts`
  // picks the geometry variant from the **layer's** settings, not from the quality level, so a drag
  // does not swap the de-indexed surface out from under itself — no re-upload, no reflow, and the
  // normals stay flat. Turning the layer's own `edges.surface` off *does* swap it (back to the
  // indexed variant, whose averaged corner normals shade the same fragment differently: measured
  // 82,200,97 against 58,169,71 here), which is a different picture for a reason that has nothing to
  // do with the edge. A transparent edge colour keeps the variant and removes only the edge.
  await patch({
    edges: { surface: true, caps: false },
    edgeColor: [1, 0, 0, 0],
    edgeWidthPx: 4.25,
  });
  const [noEdges] = await readCanvasPixels(page, [EDGE_PIXEL]);

  await patch({
    edges: { surface: true, caps: false },
    edgeColor: [1, 0, 0, 1],
    edgeWidthPx: 4.25,
  });
  const [full] = await readCanvasPixels(page, [EDGE_PIXEL]);
  for (let c = 0; c < 3; c += 1) {
    expect(full![c], `full quality: the edge pixel is the edge colour, channel ${c}`).toBe(
      EDGE_RED[c]
    );
  }
  expect(
    [...noEdges!].slice(0, 3),
    'the two levels must differ at this pixel, or the assertion proves nothing'
  ).not.toEqual([...full!].slice(0, 3));

  // Hold the pointer down: §7.2 enters `interacting` on pointerdown. No movement, so the camera and
  // the geometry are exactly what they were — only the `QualityLevel` moved.
  await page.mouse.move(200, 200);
  await page.mouse.down();
  const during = await page.evaluate(() => window.__tvxEngine!.scene.quality);
  expect(during.name).toBe('interacting');
  expect(during.edges, '§7.2: the interacting level names `edges false`').toBe(false);
  const [dragging] = await readCanvasPixels(page, [EDGE_PIXEL]);
  expect(
    [...dragging!],
    '`edges false` really applies: the edge pixel is the un-edged frame, byte for byte'
  ).toEqual([...noEdges!]);

  await page.mouse.up();
  await settle(page);
  const [settled] = await readCanvasPixels(page, [EDGE_PIXEL]);
  expect(
    [...settled!],
    'the frame `whenSettled()` leaves behind is full quality, byte for byte'
  ).toEqual([...full!]);
  expect(errors).toEqual([]);
});

test('@angle P2-04: hovering a 2D pane emits `hover` with the world point, and blank when the pointer leaves', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = await openScene(page);
  await load(page, fixture('vol_asym.nii'), 'volume', ['axial', 'coronal', 'sagittal', 'view3d']);

  await page.evaluate(() => {
    const engine = window.__tvxEngine!;
    const out: (number[] | null)[] = [];
    engine.on('hover', (h) => out.push(h === null ? null : [...h]));
    (window as unknown as { __hover: (number[] | null)[] }).__hover = out;
  });

  const cam = await cameraOf(page, 'axial');
  const at = { x: 160, y: 210 };
  const expected = worldOfPixel('axial', cam, at.x, at.y);
  await page.mouse.move(PANES.axial.x + at.x, PANES.axial.y + at.y);
  await page.mouse.move(PANES.axial.x + at.x + 1, PANES.axial.y + at.y);
  await page.mouse.move(PANES.axial.x + at.x, PANES.axial.y + at.y);

  const hovered = await page.evaluate(() => {
    const engine = window.__tvxEngine!;
    const out = (window as unknown as { __hover: (number[] | null)[] }).__hover;
    const last = out.at(-1);
    return {
      last,
      sceneHover: engine.scene.hover === null ? null : [...engine.scene.hover],
      // §8's `Mouse` block reads `probe(hoverWorld)`, and the row must carry the voxel and value.
      row: engine.scene.hover === null ? null : (engine.probe(engine.scene.hover).rows[0] ?? null),
    };
  });
  expect(hovered.last).not.toBeNull();
  for (const k of [0, 1, 2] as const) {
    expect(Math.abs((hovered.last as number[])[k]! - expected[k])).toBeLessThanOrEqual(0.5);
  }
  expect(hovered.sceneHover).toEqual(hovered.last);
  expect(hovered.row, 'the Mouse block has a row to render').not.toBeNull();
  expect((hovered.row as { voxel?: number[] }).voxel, 'with a voxel index').toBeDefined();

  // §8: "blank when the pointer leaves a view". Moving off the canvas entirely.
  await page.mouse.move(CANVAS + 60, 40);
  const left = await page.evaluate(() => {
    const out = (window as unknown as { __hover: (number[] | null)[] }).__hover;
    // Wrapped, because the value under test *is* `null` and `?? ` would erase the difference
    // between "the last event was null" and "there was no last event".
    return { count: out.length, last: out.length === 0 ? 'none' : out[out.length - 1] };
  });
  expect(left.count).toBeGreaterThan(0);
  expect(left.last, 'the Mouse block blanks when the pointer leaves').toBeNull();
  expect(
    await page.evaluate(() => window.__tvxEngine!.scene.hover),
    'and `Scene.hover` with it'
  ).toBeNull();

  // §8's budget: **volume hover ≤ 16 ms**, timed inside the page the way the Phase-1 gate timed
  // progress and cancel. What is measured is the whole synchronous path a `pointermove` takes —
  // hit-test, ray ∩ plane, emit, and the `probe` the `Mouse` block renders from.
  const ms = await page.evaluate(() => {
    const engine = window.__tvxEngine as unknown as {
      hoverAtScreen(id: string, x: number, y: number): void;
      probe(w: [number, number, number]): unknown;
      scene: { hover: [number, number, number] | null };
    };
    const t0 = performance.now();
    const N = 200;
    for (let i = 0; i < N; i += 1) {
      engine.hoverAtScreen('axial', 100 + (i % 64), 120 + (i % 47));
      const h = engine.scene.hover;
      if (h !== null) engine.probe(h);
    }
    return (performance.now() - t0) / N;
  });
  console.log(`[bench] volume hover -> Mouse row ${ms.toFixed(4)} ms (§8 budget 16 ms)`);
  expect(ms, '§8: volume hover ≤ 16 ms').toBeLessThan(16);
  expect(errors).toEqual([]);
});

test('@angle P2-04: the Mouse block fills on ernie inside §8’s ≤ 16 ms / ≤ 50 ms budgets', async ({
  page,
}) => {
  test.skip(!hasRealData, 'needs TETRAVOX_TESTDATA');
  test.setTimeout(180_000);
  const errors = await openScene(page);
  await load(page, T1, 'volume', ['axial', 'coronal', 'sagittal', 'view3d']);
  await page.evaluate(async (mesh) => {
    const engine = window.__tvxEngine!;
    const ds = await engine.addDataset({ kind: 'path', path: mesh as string });
    engine.addLayer({ datasetId: ds.id, kind: 'mesh' });
    await engine.whenSettled();
  }, `/@fs${TESTDATA}/m2m_ernie/ernie.msh`);

  // Both halves timed **inside the page** (§8, and the ownership map's real-data gate item), on the
  // synchronous path a `pointermove` takes: hit-test → ray ∩ plane → emit → the `probe` the Mouse
  // block renders. The mesh row is served from the layer's own latest-wins `locate` key, so it is
  // read rather than awaited — which is exactly what keeps a hover off the cut queue.
  const bench = await page.evaluate(() => {
    const engine = window.__tvxEngine as unknown as {
      hoverAtScreen(id: string, x: number, y: number): void;
      probe(w: [number, number, number]): { rows: { kind: string; value?: unknown }[] };
      scene: { hover: [number, number, number] | null; cursor: [number, number, number] };
    };
    const run = (n: number): number => {
      const t0 = performance.now();
      for (let i = 0; i < n; i += 1) {
        engine.hoverAtScreen('axial', 150 + (i % 61), 150 + (i % 53));
        const h = engine.scene.hover;
        if (h !== null) engine.probe(h);
      }
      return (performance.now() - t0) / n;
    };
    run(20);
    const perHover = run(200);
    const rows = engine.probe(engine.scene.cursor).rows;
    return { perHover, kinds: rows.map((r) => r.kind) };
  });

  console.log(
    `[bench] ernie hover -> Mouse rows ${bench.perHover.toFixed(4)} ms ` +
      '(§8 budgets: volume 16 ms, mesh 50 ms)'
  );
  expect(bench.kinds, 'the Mouse block has a row per layer').toEqual(['volume', 'mesh']);
  expect(bench.perHover, '§8: the hover path is inside both budgets').toBeLessThan(16);
  expect(errors).toEqual([]);
});

// ===========================================================================================
// R4's E-SCENE half — stepping with no volume in the scene
// ===========================================================================================

test('@angle R4: the wheel and stepCursor sweep a mesh with NO volume loaded, 1 mm per step', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = await openScene(page);
  await load(page, fixture('mesh_v2_binary.msh'), 'mesh', [
    'axial',
    'coronal',
    'sagittal',
    'view3d',
  ]);

  const hasVolume = await page.evaluate(() =>
    [...window.__tvxEngine!.scene.datasets.values()].some((d) => d.kind === 'volume')
  );
  expect(hasVolume, 'this scene has no volume at all').toBe(false);

  const start = await cursorOf(page);
  await page.mouse.move(PANES.axial.x + 200, PANES.axial.y + 200);
  await page.mouse.wheel(0, -100);
  await settle(page);
  const one = await cursorOf(page);
  expect(one[2] - start[2], 'R4: 1 mm per step with no volume loaded').toBeCloseTo(1, 6);
  expect(one[0]).toBeCloseTo(start[0], 6);
  expect(one[1]).toBeCloseTo(start[1], 6);

  // Twenty notches sweep 20 mm, and the API path agrees with the wheel path.
  for (let i = 0; i < 19; i += 1) await page.mouse.wheel(0, -100);
  await settle(page);
  expect((await cursorOf(page))[2] - start[2]).toBeCloseTo(20, 6);

  await page.evaluate(async () => {
    const engine = window.__tvxEngine!;
    engine.stepCursor('axial', -20);
    await engine.whenSettled();
  });
  expect((await cursorOf(page))[2]).toBeCloseTo(start[2], 6);
  expect(errors).toEqual([]);
});

// ===========================================================================================
// R5's E-SCENE half — a pick/probe carries the label id and the tissue tag under the pointer
// ===========================================================================================

test('@angle R5: clicking a labelled voxel probes that label — id, name, and the pixel it painted', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = await openScene(page);
  const LUT = 'labels_simnibs_LUT.txt';
  await page.evaluate(
    async ([url, lut]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({
        kind: 'path',
        path: url as string,
        sidecars: { lut: lut as string },
      });
      engine.addLayer({ datasetId: ds.id, kind: 'volume' });
      engine.setLayout({ kind: '1x1', cells: ['axial'] });
      engine.setView('axial', { camera: { center: [0, 0], mmPerPx: 0.05 } });
      // The crosshair is drawn **at** the click, so with it on the pixel under the pointer is the
      // crosshair's colour and not the region's. R5 is about which region was clicked, not about
      // the chrome, so the chrome comes off for the pixel half of the assertion.
      engine.setAnnotations({ crosshair: false });
      await engine.whenSettled();
    },
    [fixture('labels_simnibs.nii.gz'), fixture(LUT)] as const
  );

  // Freeview's behaviour, and the half of R5 the Region panel needs: a click in a pane must say
  // which region was clicked. Several points, so a single transparent-label pixel cannot carry it.
  const points: [number, number][] = [
    [384, 384],
    [360, 400],
    [410, 360],
    [384, 420],
  ];
  const expected = manifest.sidecars[LUT]!.expected;
  let asserted = 0;

  for (const [x, y] of points) {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.up();
    await settle(page);

    const row = await page.evaluate(() => {
      const engine = window.__tvxEngine!;
      const r = engine.probe(engine.scene.cursor).rows[0];
      return r === undefined
        ? null
        : { labelId: r.labelId ?? null, labelName: r.labelName ?? null, value: r.value ?? null };
    });
    if (row === null || row.labelId === null) continue;

    const entry = expected.find((e) => e.id === row.labelId);
    expect(entry, `label ${row.labelId} is in the LUT`).toBeDefined();
    expect(row.labelName, 'the probe row names the region').toBe(entry!.name);
    expect(row.value, 'and carries its raw value').toBe(row.labelId);

    // …and it is the region actually painted there: an opaque entry must match the pixel exactly.
    if ((entry!.rgba255[3] ?? 0) === 255) {
      const [pixel] = await readCanvasPixels(page, [[x, y]]);
      expect(
        [pixel![0], pixel![1], pixel![2]],
        `the pixel under the click is label ${row.labelId}'s colour`
      ).toEqual([entry!.rgba255[0], entry!.rgba255[1], entry!.rgba255[2]]);
      asserted += 1;
    }
  }
  expect(asserted, 'at least one click landed on an opaque labelled region').toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('@angle R5: a 3D pick probes the tissue tag under the pointer — id and name', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = await openScene(page);
  await page.evaluate(
    async ([url, lut]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({
        kind: 'path',
        path: url as string,
        sidecars: { lut: lut as string },
      });
      engine.addLayer({ datasetId: ds.id, kind: 'mesh' });
      engine.setLayout({ kind: '3d-only', cells: ['view3d'] });
      engine.resetView('view3d');
      await engine.whenSettled();
      // §7.4: the de-indexed pick geometry is built lazily on the first pick.
      engine.pick('view3d', 384, 384);
      await engine.whenSettled();
    },
    [fixture('mesh_v2_binary.msh'), fixture('mesh_v2_binary_LUT.txt')] as const
  );

  await page.mouse.dblclick(384, 384);
  await settle(page);

  // The mesh row is a `locate` round trip (§6.3), so it lands after the pick — the same poll gate 5
  // uses. This is what a Region panel would wire a tissue-table selection to.
  const row = await page.evaluate(async () => {
    const engine = window.__tvxEngine!;
    for (let i = 0; i < 200; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
      const r = engine.probe(engine.scene.cursor).rows.find((x) => x.kind === 'mesh');
      if (r?.tag !== undefined) {
        return { tag: r.tag, tagName: r.tagName ?? null, elementId: r.elementId ?? null };
      }
    }
    return null;
  });

  expect(errors).toEqual([]);
  expect(row, 'the probe row carries the tissue tag under the pointer').not.toBeNull();
  expect(row!.tag).toBeGreaterThan(0);
  expect(row!.elementId, 'and the Gmsh element number an element panel reads').not.toBeNull();
});

// ===========================================================================================
// P2-03 — per-view dirty bits
// ===========================================================================================

test('@angle P2-03: a camera gesture repaints one pane, a cursor move repaints all of them', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = await openScene(page);
  await load(page, fixture('vol_asym.nii'), 'volume', ['axial', 'coronal', 'sagittal', 'view3d']);

  const arm = async (): Promise<void> => {
    await page.evaluate(() => {
      const engine = window.__tvxEngine!;
      const seen: string[] = [];
      (window as unknown as { __frames: string[] }).__frames = seen;
      engine.on('frame', (f) => seen.push(f.viewId));
    });
  };
  /** The panes painted so far, after letting two animation frames run. */
  const painted = async (): Promise<string[]> =>
    await page.evaluate(async () => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return [...new Set((window as unknown as { __frames: string[] }).__frames)];
    });

  // An orbit changes the 3D camera and nothing else — the three slice panes keep the pixels the
  // previous frame left in the drawing buffer. Sampled **during** the gesture, before the settle:
  // §7.2 requires leaving `interacting` to trigger one full-quality re-render, and that one is
  // scene-wide by design, so a post-settle sample would measure the settle rather than the gesture.
  await arm();
  await page.mouse.move(PANES.view3d.x + 150, PANES.view3d.y + 150);
  await page.mouse.down();
  await page.mouse.move(PANES.view3d.x + 220, PANES.view3d.y + 190, { steps: 6 });
  await page.mouse.up();
  expect(await painted(), 'an orbit repaints the 3D pane alone').toEqual(['view3d']);

  // …and the settle then repaints everything, exactly once.
  await settle(page);
  expect((await painted()).sort(), 'leaving `interacting` re-renders every pane').toEqual(
    ['axial', 'coronal', 'sagittal', 'view3d'].sort()
  );

  // A cursor move changes every pane's crosshair and two panes' slices, so it is scene-wide from
  // the first frame.
  await arm();
  await page.mouse.move(PANES.axial.x + 140, PANES.axial.y + 160);
  await page.mouse.down();
  await page.mouse.up();
  expect((await painted()).sort(), 'a cursor move repaints all four').toEqual(
    ['axial', 'coronal', 'sagittal', 'view3d'].sort()
  );
  await settle(page);
  expect(errors).toEqual([]);
});

// ===========================================================================================
// §11 (2) — the regression golden
// ===========================================================================================

/**
 * `scene-crosshair-after-drag` — R3, as a picture.
 *
 * Untagged, so it runs on `chromium-swiftshader` only: §11 stores goldens per renderer class and
 * `test/golden/angle-metal/` does not exist. On the synthetic fixture rather than on ernie, so it is
 * a regression test in CI, where `TETRAVOX_TESTDATA` is deliberately unset.
 *
 * What it pins is the pair the analytic assertions above make separately: the crosshair sits away
 * from the pane centre (it followed the drag) **and** the cube is exactly where the un-dragged frame
 * put it (the scan did not follow). A regression to the cursor-anchored frame moves the cube and
 * leaves the crosshair centred — a change no `maxDiffPixelRatio` can absorb.
 */
test('§11 golden: scene-crosshair-after-drag', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await openScene(page);
  // `labels_simnibs.nii.gz` + its LUT, the same pair `slice.spec.ts` uses: every voxel of it is a
  // coloured region, so "the scan did not move" is a claim about pixels the eye can check and the
  // comparator can measure. `vol_asym.nii` is 87 % zeros and would have made a mostly-black frame.
  await page.evaluate(
    async ([url, lut]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({
        kind: 'path',
        path: url as string,
        sidecars: { lut: lut as string },
      });
      engine.addLayer({ datasetId: ds.id, kind: 'volume' });
      engine.setLayout({ kind: '1x1', cells: ['axial'] });
      engine.setView('axial', { camera: { center: [0, 0], mmPerPx: 0.05 } });
      await engine.whenSettled();
    },
    [fixture('labels_simnibs.nii.gz'), fixture('labels_simnibs_LUT.txt')] as const
  );

  await page.mouse.move(384, 384);
  await page.mouse.down();
  await page.mouse.move(300, 470, { steps: 8 });
  await page.mouse.up();
  await settle(page);

  expect(errors).toEqual([]);
  await expectGolden(page, 'scene-crosshair-after-drag');
});
