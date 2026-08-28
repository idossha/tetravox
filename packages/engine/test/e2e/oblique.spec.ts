/**
 * §7.5's **oblique affordances** — the gizmo, its rotate handles, plane-from-3-points, and the
 * presets that get a pane back.
 *
 * §7.5 closes: *"`mode:'oblique'` is fully supported by the model and the shader path from Phase 1
 * and gets its **affordances** (gizmo, rotate handles, plane-from-3-points) in Phase 2."* The plane
 * maths already worked; what did not exist was any way to reach an oblique plane from the viewer.
 *
 * `src/overlay/gizmo.test.ts` proves the geometry without a context. This file proves the two things
 * only a live engine can: that the gizmo is **drawn** (in the 3D pane, over the mesh it manipulates,
 * un-clipped as §7.2 requires) and that grabbing a handle changes the plane every other pane draws.
 * Two goldens go with it, `scene-gizmo-oblique` and `scene-plane-from-3-points`, exactly as E-SCENE's
 * §11 obligations list them.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { expectGolden, readCanvasPixels } from '../helpers/pixels';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const fixture = (name: string): string => `/@fs${REPO}testdata/${name}`;

const CANVAS = 768;
const HALF = CANVAS / 2;
/** 2×2 panes in canvas pixels, top-left origin — what `page.mouse` takes. */
const PANES = {
  axial: { x: 0, y: 0, width: HALF, height: HALF },
  view3d: { x: HALF, y: HALF, width: HALF, height: HALF },
} as const;

type Vec3 = [number, number, number];

async function openScene(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/test/pages/scene.html?aa=off');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);
  return errors;
}

async function load(page: Page, url: string, kind: 'volume' | 'mesh'): Promise<void> {
  await page.evaluate(
    async ([u, k]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({ kind: 'path', path: u as string });
      engine.addLayer({ datasetId: ds.id, kind: k as 'volume' | 'mesh' });
      engine.setLayout({ kind: '2x2', cells: ['axial', 'coronal', 'sagittal', 'view3d'] });
      await engine.whenSettled();
    },
    [url, kind] as const
  );
}

const settle = async (page: Page): Promise<void> => {
  await page.evaluate(async () => {
    await window.__tvxEngine!.whenSettled();
  });
};

/**
 * How many gizmo-coloured pixels one pane holds, counted inside the page.
 *
 * `passes/overlay.ts`'s `GIZMO_COLOR` is `[0.25, 0.85, 0.95, 0.95]`, i.e. rgb(64, 217, 242) at
 * alpha 0.95. The match below is **that colour**, not "bright in blue": the mesh fixture's own tag
 * palette has plenty of blue-ish surface, and a loose predicate counted 3,332 of its pixels as gizmo
 * before the gizmo existed. Blending 5 % of any background shifts a channel by at most 13, which is
 * the tolerance.
 */
async function gizmoPixels(
  page: Page,
  pane: { x: number; y: number; width: number; height: number }
): Promise<number> {
  return await page.evaluate((p) => {
    const canvas = document.querySelector('canvas') as HTMLCanvasElement;
    const gl = canvas.getContext('webgl2')!;
    window.__tvxRender?.();
    const px = new Uint8Array(p.width * p.height * 4);
    gl.readPixels(
      p.x,
      canvas.height - p.y - p.height,
      p.width,
      p.height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      px
    );
    let n = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (
        Math.abs(px[i]! - 64) <= 13 &&
        Math.abs(px[i + 1]! - 217) <= 13 &&
        Math.abs(px[i + 2]! - 242) <= 13
      ) {
        n += 1;
      }
    }
    return n;
  }, pane);
}

const normalOf = async (page: Page, viewId: string): Promise<Vec3> =>
  await page.evaluate((id) => {
    const view = window.__tvxEngine!.views.find((v) => v.id === id) as { normal: Vec3 };
    return [...view.normal] as Vec3;
  }, viewId);

const upOf = async (page: Page, viewId: string): Promise<Vec3> =>
  await page.evaluate((id) => {
    const view = window.__tvxEngine!.views.find((v) => v.id === id) as { up: Vec3 };
    return [...view.up] as Vec3;
  }, viewId);

const modeOf = async (page: Page, viewId: string): Promise<string> =>
  await page.evaluate((id) => {
    const view = window.__tvxEngine!.views.find((v) => v.id === id) as { mode: string };
    return view.mode;
  }, viewId);

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Put the 3D camera somewhere the gizmo is seen obliquely rather than face-on. */
async function tiltCamera(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const engine = window.__tvxEngine!;
    const view3d = engine.scene.view3d;
    // A quaternion for −0.6 rad about X then 0.4 about Y, written out so the page needs no library.
    const hx = -0.3;
    const hy = 0.2;
    const [cx, sx, cy, sy] = [Math.cos(hx), Math.sin(hx), Math.cos(hy), Math.sin(hy)];
    engine.setView(view3d.id, {
      camera: { ...view3d.camera, rotation: [sx * cy, cx * sy, -sx * sy, cx * cy] },
    });
    await engine.whenSettled();
  });
}

// ===========================================================================================
// The gizmo
// ===========================================================================================

test('@angle oblique: the gizmo draws in the 3D pane only, and only when it is shown', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = await openScene(page);
  await load(page, fixture('mesh_v2_binary.msh'), 'mesh');
  await tiltCamera(page);

  expect(await gizmoPixels(page, PANES.view3d), 'nothing before showGizmo').toBe(0);

  await page.evaluate(() => {
    window.__tvxEngine!.showGizmo('axial');
  });
  await settle(page);
  const drawn = await gizmoPixels(page, PANES.view3d);
  // A ring, two arcs, a stem and three knobs at this radius is hundreds of pixels, not a handful.
  expect(drawn, 'the gizmo is drawn').toBeGreaterThan(200);
  // 2D panes never draw it: the gizmo manipulates their plane and would be edge-on inside them.
  expect(await gizmoPixels(page, PANES.axial), 'not in a 2D pane').toBe(0);

  await page.evaluate(() => {
    window.__tvxEngine!.showGizmo(null);
  });
  await settle(page);
  expect(await gizmoPixels(page, PANES.view3d), 'gone again').toBe(0);
  expect(errors).toEqual([]);
});

test('@angle oblique: dragging a rotate handle rotates the plane, and the pane does not roll', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = await openScene(page);
  await load(page, fixture('mesh_v2_binary.msh'), 'mesh');
  await tiltCamera(page);
  await page.evaluate(() => {
    window.__tvxEngine!.showGizmo('axial');
  });
  await settle(page);

  const before = { normal: await normalOf(page, 'axial'), up: await upOf(page, 'axial') };
  expect(before.normal).toEqual([0, 0, 1]);

  // Find the handle the way a user does: by asking what is under a pixel. Scanning the pane with
  // the engine's own hit test uses nothing a test-only accessor would have to expose, and it proves
  // the thing that matters — that the handle is reachable from the pane's coordinates at all.
  const found = await page.evaluate(() => {
    const engine = window.__tvxEngine!;
    const rect = engine.paneRect('view3d')!;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let y = 0; y < rect.height; y += 6) {
      for (let x = 0; x < rect.width; x += 6) {
        if (engine.gizmoAt('view3d', x, y) === 'rotateU') {
          sx += x;
          sy += y;
          n += 1;
        }
      }
    }
    return n > 0 ? { x: Math.round(sx / n), y: Math.round(sy / n), rect, n } : null;
  });
  expect(found, 'the rotateU handle is reachable from pane pixels').not.toBeNull();
  const canvasX = found!.rect.x + found!.x;
  const canvasY = found!.rect.y + found!.y;
  expect(
    await page.evaluate(
      ([x, y]) => window.__tvxEngine!.gizmoAt('view3d', x as number, y as number),
      [found!.x, found!.y] as const
    )
  ).toBe('rotateU');

  await page.mouse.move(canvasX, canvasY);
  await page.mouse.down();
  await page.mouse.move(canvasX + 90, canvasY, { steps: 9 });
  await page.mouse.up();
  await settle(page);

  const after = { normal: await normalOf(page, 'axial'), up: await upOf(page, 'axial') };
  // The plane turned...
  expect(dot(after.normal, before.normal)).toBeLessThan(0.999);
  expect(Math.hypot(...after.normal)).toBeCloseTo(1, 5);
  expect(await modeOf(page, 'axial')).toBe('oblique');
  // ...and `up` came with it: still in the plane, still unit. A rotate that left `up` out of the
  // plane would be silently re-orthogonalised by `sliceBasis`, i.e. the pane would roll.
  expect(dot(after.up, after.normal)).toBeCloseTo(0, 5);
  expect(Math.hypot(...after.up)).toBeCloseTo(1, 5);
  // The rotation is about `up`, so `up` itself is unchanged — that is what "no roll" means here.
  for (const k of [0, 1, 2] as const) expect(after.up[k]).toBeCloseTo(before.up[k] ?? 0, 5);
  expect(errors).toEqual([]);
});

test('@angle oblique: dragging the translate handle slides the plane along its normal', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = await openScene(page);
  await load(page, fixture('mesh_v2_binary.msh'), 'mesh');
  await tiltCamera(page);
  await page.evaluate(() => {
    window.__tvxEngine!.showGizmo('axial');
  });
  await settle(page);

  const before = await page.evaluate(
    () => [...window.__tvxEngine!.scene.cursor] as [number, number, number]
  );
  await page.evaluate(() => {
    window.__tvxEngine!.gizmoDrag('translate', 0, -40);
  });
  await settle(page);
  const after = await page.evaluate(
    () => [...window.__tvxEngine!.scene.cursor] as [number, number, number]
  );

  // §4.5: the plane is derived from the cursor, so translating the plane **is** moving the cursor,
  // along the axial normal (+Z) and nowhere else.
  expect(after[2]).toBeGreaterThan(before[2]);
  expect(after[0]).toBeCloseTo(before[0], 9);
  expect(after[1]).toBeCloseTo(before[1], 9);
  expect(errors).toEqual([]);
});

test('scene-gizmo-oblique golden', async ({ page }) => {
  test.setTimeout(120_000);
  await openScene(page);
  await load(page, fixture('mesh_v2_binary.msh'), 'mesh');
  await tiltCamera(page);
  await page.evaluate(() => {
    const engine = window.__tvxEngine!;
    // An oblique plane, so the gizmo is photographed doing the job it exists for.
    engine.setView('axial', {
      mode: 'oblique',
      normal: [0.5773502691896258, 0.5773502691896258, 0.5773502691896258],
      up: [0, 0, 1],
    });
    engine.showGizmo('axial');
  });
  await settle(page);
  await expectGolden(page, 'scene-gizmo-oblique');
});

// ===========================================================================================
// Plane from three points
// ===========================================================================================

test('@angle oblique: three clicks set the plane through them, and the cursor to their centroid', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = await openScene(page);
  await load(page, fixture('vol_f32.nii.gz'), 'volume');

  const points: Vec3[] = [
    [0, 0, 0],
    [10, 0, 0],
    [0, 10, 5],
  ];
  const ok = await page.evaluate(
    ([id, p]) => {
      const engine = window.__tvxEngine!;
      const [a, b, c] = p as Vec3[];
      return engine.setViewPlaneFromPoints(id as string, a!, b!, c!);
    },
    ['axial', points] as const
  );
  expect(ok).toBe(true);
  await settle(page);

  // The expected normal, computed here: normalize((b−a) × (c−a)) = normalize((0,-50,100)).
  const expected: Vec3 = [0, -50, 100];
  const len = Math.hypot(...expected);
  const normal = await normalOf(page, 'axial');
  for (const k of [0, 1, 2] as const) {
    expect(normal[k], `normal axis ${k}`).toBeCloseTo((expected[k] ?? 0) / len, 5);
  }
  expect(await modeOf(page, 'axial')).toBe('oblique');
  // The cursor is the centroid — on the plane by construction, and the point the clicks were about.
  const cursor = await page.evaluate(
    () => [...window.__tvxEngine!.scene.cursor] as [number, number, number]
  );
  expect(cursor[0]).toBeCloseTo(10 / 3, 5);
  expect(cursor[1]).toBeCloseTo(10 / 3, 5);
  expect(cursor[2]).toBeCloseTo(5 / 3, 5);
  expect(errors).toEqual([]);
});

test('@angle oblique: the collector consumes exactly three clicks and refuses a collinear triple', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = await openScene(page);
  await load(page, fixture('vol_f32.nii.gz'), 'volume');

  const pending = async (): Promise<number | null> =>
    await page.evaluate(() => window.__tvxEngine!.planeFromPointsPending);
  expect(await pending()).toBeNull();

  await page.evaluate(() => {
    window.__tvxEngine!.beginPlaneFromPoints('axial');
  });
  expect(await pending()).toBe(0);

  const before = await page.evaluate(
    () => [...window.__tvxEngine!.scene.cursor] as [number, number, number]
  );
  // Three clicks in the axial pane. While collecting, a click contributes a point instead of
  // setting the cursor — which is the whole difference from a normal left-click.
  const clicks: [number, number][] = [
    [90, 100],
    [250, 130],
    [160, 300],
  ];
  for (const [i, [x, y]] of clicks.entries()) {
    await page.mouse.move(PANES.axial.x + x, PANES.axial.y + y);
    await page.mouse.down();
    await page.mouse.up();
    if (i < clicks.length - 1) expect(await pending(), `after click ${i + 1}`).toBe(i + 1);
  }
  await settle(page);
  // The third click disarms the collector and sets the plane.
  expect(await pending()).toBeNull();
  expect(await modeOf(page, 'axial')).toBe('oblique');
  const after = await page.evaluate(
    () => [...window.__tvxEngine!.scene.cursor] as [number, number, number]
  );
  expect(after).not.toEqual(before);

  // Collinear points have no plane: the call fails rather than producing a NaN normal.
  const normal = await normalOf(page, 'axial');
  const refused = await page.evaluate(() =>
    window.__tvxEngine!.setViewPlaneFromPoints('axial', [0, 0, 0], [1, 1, 1], [3, 3, 3])
  );
  expect(refused).toBe(false);
  expect(await normalOf(page, 'axial')).toEqual(normal);
  expect(errors).toEqual([]);
});

// ===========================================================================================
// Presets — the way back
// ===========================================================================================

test('@angle oblique: `setSliceMode` puts a rotated pane back on a §3 preset', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await openScene(page);
  await load(page, fixture('vol_f32.nii.gz'), 'volume');

  await page.evaluate(() => {
    window.__tvxEngine!.setViewPlaneFromPoints('axial', [0, 0, 0], [10, 0, 0], [0, 10, 5]);
  });
  expect(await modeOf(page, 'axial')).toBe('oblique');

  // §3's preset normals and ups, transcribed: axial +Z / anterior up, coronal −Y / superior up,
  // sagittal −X / superior up.
  const presets: [string, Vec3, Vec3][] = [
    ['axial', [0, 0, 1], [0, 1, 0]],
    ['coronal', [0, -1, 0], [0, 0, 1]],
    ['sagittal', [-1, 0, 0], [0, 0, 1]],
  ];
  for (const [mode, normal, up] of presets) {
    await page.evaluate((m) => {
      window.__tvxEngine!.setSliceMode('axial', m as 'axial' | 'coronal' | 'sagittal');
    }, mode);
    expect(await modeOf(page, 'axial'), mode).toBe(mode);
    expect(await normalOf(page, 'axial'), `${mode} normal`).toEqual(normal);
    expect(await upOf(page, 'axial'), `${mode} up`).toEqual(up);
  }
  expect(errors).toEqual([]);
});

test('scene-plane-from-3-points golden', async ({ page }) => {
  test.setTimeout(120_000);
  await openScene(page);
  await load(page, fixture('vol_f32.nii.gz'), 'volume');
  await page.evaluate(() => {
    const engine = window.__tvxEngine!;
    // Three points taken from the **fixture's own bounding box**, so the plane provably cuts through
    // the data rather than past it: a golden of an empty pane photographs nothing. A continuous
    // scalar volume rather than a label one for the same reason — every voxel of it is drawn.
    const ds = [...engine.scene.datasets.values()][0]!;
    const { min, max } = ds.bounds;
    const mid = (k: number): number => (min[k]! + max[k]!) / 2;
    const span = (k: number): number => max[k]! - min[k]!;
    engine.setViewPlaneFromPoints(
      'axial',
      [min[0]!, min[1]!, mid(2)],
      [max[0]!, min[1]!, mid(2) + span(2) * 0.3],
      [min[0]!, max[1]!, mid(2) - span(2) * 0.3]
    );
    // Refit: the pane's zoom was computed for the axial plane it no longer has.
    engine.resetView('axial');
  });
  await settle(page);
  await expectGolden(page, 'scene-plane-from-3-points');
});

test('@angle oblique: a pane far from the fit still reports its pixels — no NaN normal escapes', async ({
  page,
}) => {
  const errors = await openScene(page);
  await load(page, fixture('vol_f32.nii.gz'), 'volume');
  await page.evaluate(() => {
    window.__tvxEngine!.setViewPlaneFromPoints('axial', [0, 0, 0], [10, 0, 0], [0, 10, 5]);
  });
  await settle(page);
  // A NaN normal blanks the pane and every readback becomes zero; a real one does not.
  const [px] = await readCanvasPixels(page, [[HALF / 2, HALF / 2]]);
  expect(px?.[3]).toBe(255);
  expect(errors).toEqual([]);
});
