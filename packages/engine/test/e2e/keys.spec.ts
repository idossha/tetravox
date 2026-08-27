/**
 * P2-09 — the in-plane cursor nudge, and the §7.5 keyboard surface around it.
 *
 * §7.5 lists two bindings and Phase 1 had one: the arrows and PgUp/PgDn both stepped along the plane
 * **normal**, so pressing → in the axial pane changed the axial slice. `Engine.nudgeCursor` is the
 * missing half, and it is the one `api.ts` change E-SCENE owns.
 *
 * The expectations are derived, never remembered: §3's preset bases are transcribed below and the
 * step comes from the volume's own affine, so what is asserted is that the engine moved the cursor
 * exactly one voxel along the direction §7.5 names — including the two things a laterality bug hides
 * behind, which is why they are separate tests: the **radiological** mirror, and the fact that a
 * `m2m_ernie` affine permutes the voxel axes so "right" is not voxel `i`.
 *
 * Tagged `@angle` so both projects run it; none of it is renderer-specific.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const fixture = (name: string): string => `/@fs${REPO}testdata/${name}`;

const TESTDATA = process.env.TETRAVOX_TESTDATA ?? '';
const hasRealData = TESTDATA !== '' && existsSync(`${TESTDATA}/m2m_ernie/T1.nii.gz`);

/**
 * Two fixtures, for two different properties.
 *
 * `GRID` is **axis-aligned at 1 mm** — `vol_asym.nii`'s affine is the identity plus a translation,
 * and `m2m_ernie/T1.nii.gz`'s is a permutation with `qfac = -1` `[DATA]`, so on either one a step of
 * `step_mm` lands exactly on the next voxel plane and "one nudge moves exactly one voxel" is an
 * equality rather than a bound.
 *
 * `OBLIQUE` is `vol_f32.nii.gz`, whose affine is **rotated and anisotropic**
 * (pixdim 1 / 1.5 / 2 through a rotation `[FIXTURE]`). There the pane's `right` is not a voxel axis,
 * the effective step is the voxel-plane spacing along that direction rather than `step_mm`, and the
 * anti-drift rule has to hold anyway. That is the case worth 200 iterations.
 */
const GRID = hasRealData
  ? `/@fs${TESTDATA}/m2m_ernie/T1.nii.gz`
  : `/@fs${REPO}testdata/vol_asym.nii`;
const OBLIQUE = `/@fs${REPO}testdata/vol_f32.nii.gz`;

type Vec3 = [number, number, number];

/**
 * §3's canonical bases in **neurological**, transcribed rather than imported: `right = cross(up,
 * normal)` with §3's preset normals (axial `+Z`, coronal `−Y`, sagittal `−X`).
 */
const BASIS: Record<'axial' | 'coronal' | 'sagittal', { right: Vec3; up: Vec3 }> = {
  axial: { right: [1, 0, 0], up: [0, 1, 0] },
  coronal: { right: [1, 0, 0], up: [0, 0, 1] },
  sagittal: { right: [0, -1, 0], up: [0, 0, 1] },
};

async function openScene(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/test/pages/scene.html');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);
  return errors;
}

async function load(page: Page, url: string, cells: string[]): Promise<void> {
  await page.evaluate(
    async ([u, ids]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({ kind: 'path', path: u as string });
      engine.addLayer({ datasetId: ds.id, kind: 'volume' });
      engine.setLayout({
        kind: (ids as string[]).length === 4 ? '2x2' : '1x1',
        cells: ids as string[],
      });
      await engine.whenSettled();
    },
    [url, cells] as const
  );
}

const cursorOf = async (page: Page): Promise<Vec3> =>
  await page.evaluate(() => [...window.__tvxEngine!.scene.cursor] as [number, number, number]);

async function nudge(page: Page, viewId: string, dx: number, dy: number): Promise<void> {
  await page.evaluate(
    ([id, x, y]) => {
      window.__tvxEngine!.nudgeCursor(id as string, x as number, y as number);
    },
    [viewId, dx, dy] as const
  );
}

/**
 * `step_mm` for a direction, computed here from the volume's affine by §7.5's own rule
 * (`max over voxel axes a of |dot(dir, A[:,a])|`). Asking the engine would be a tautology.
 */
async function stepAlong(page: Page, dir: Vec3): Promise<number> {
  return await page.evaluate(
    (d) => {
      const engine = window.__tvxEngine!;
      const ds = [...engine.scene.datasets.values()].find((x) => x.kind === 'volume')!;
      const a = (ds as { affine: Float32Array }).affine;
      let best = 0;
      for (let col = 0; col < 3; col += 1) {
        const dot =
          (d as number[])[0]! * a[col * 4]! +
          (d as number[])[1]! * a[col * 4 + 1]! +
          (d as number[])[2]! * a[col * 4 + 2]!;
        best = Math.max(best, Math.abs(dot));
      }
      return best;
    },
    dir as unknown as number[]
  );
}

/** The component of `b − a` along `dir`, and the length of everything left over. */
function decompose(a: Vec3, b: Vec3, dir: Vec3): { along: number; off: number } {
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const along = d[0] * dir[0] + d[1] * dir[1] + d[2] * dir[2];
  const rest: Vec3 = [d[0] - along * dir[0], d[1] - along * dir[1], d[2] - along * dir[2]];
  return { along, off: Math.hypot(rest[0], rest[1], rest[2]) };
}

// ===========================================================================================
// The nudge itself
// ===========================================================================================

test('@angle P2-09: an arrow moves the cursor one voxel along the pane’s right / up, and nowhere else', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = await openScene(page);
  await load(page, GRID, ['axial', 'coronal', 'sagittal', 'view3d']);

  for (const pane of ['axial', 'coronal', 'sagittal'] as const) {
    const { right, up } = BASIS[pane];
    const stepRight = await stepAlong(page, right);
    const stepUp = await stepAlong(page, up);

    // One nudge to land on the grid — the *first* one from an arbitrary cursor also carries the
    // snap correction, and §7.5's step is what a nudge moves once the cursor is on a voxel plane.
    await nudge(page, pane, 1, 0);
    const a = await cursorOf(page);
    await nudge(page, pane, 1, 0);
    const b = await cursorOf(page);
    const dRight = decompose(a, b, right);
    expect(dRight.along, `${pane}: one step right`).toBeCloseTo(stepRight, 4);
    // Nothing at all in the other two directions: the snap is along `right` alone.
    expect(dRight.off, `${pane}: right-nudge stays on its axis`).toBeLessThan(1e-4);

    await nudge(page, pane, 0, 1);
    const c = await cursorOf(page);
    await nudge(page, pane, 0, 1);
    const d = await cursorOf(page);
    const dUp = decompose(c, d, up);
    expect(dUp.along, `${pane}: one step up`).toBeCloseTo(stepUp, 4);
    expect(dUp.off, `${pane}: up-nudge stays on its axis`).toBeLessThan(1e-4);
  }
  expect(errors).toEqual([]);
});

test('@angle P2-09: the arrows nudge IN the plane — the slice index does not move (that is PgUp/PgDn)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = await openScene(page);
  await load(page, GRID, ['axial']);

  const before = await cursorOf(page);
  await nudge(page, 'axial', 1, 0);
  await nudge(page, 'axial', 0, 1);
  const after = await cursorOf(page);
  // The axial normal is +Z (§3), and this is the defect P2-09 exists for: Phase 1's arrows moved
  // the cursor along it, i.e. changed the slice.
  expect(after[2]).toBeCloseTo(before[2], 9);
  expect(after[0]).not.toBeCloseTo(before[0], 6);
  expect(after[1]).not.toBeCloseTo(before[1], 6);

  // ...while `stepCursor` moves along the normal and not in the plane, which is the other half.
  await page.evaluate(() => {
    window.__tvxEngine!.stepCursor('axial', 1);
  });
  const stepped = await cursorOf(page);
  expect(stepped[2]).not.toBeCloseTo(after[2], 6);
  expect(stepped[0]).toBeCloseTo(after[0], 9);
  expect(stepped[1]).toBeCloseTo(after[1], 9);
  expect(errors).toEqual([]);
});

test('@angle P2-09: the radiological mirror flips which way → moves the cursor, and only that', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = await openScene(page);
  await load(page, GRID, ['axial']);

  // Land on the voxel grid first. "One step right" and "one step left" are exact negatives of each
  // other only from a point already on a voxel plane: from anywhere else each snaps to the nearest
  // plane in its own direction, which are at different distances — a property of the snap, not of
  // the mirror, and one that would make this assertion measure the wrong thing.
  await nudge(page, 'axial', 1, 0);
  const start = await cursorOf(page);
  await nudge(page, 'axial', 1, 0);
  const neuro = await cursorOf(page);

  await page.evaluate(
    (c) => {
      const engine = window.__tvxEngine!;
      engine.setCursor(c as [number, number, number]);
      engine.setRadiological(true);
    },
    start as unknown as number[]
  );
  await nudge(page, 'axial', 1, 0);
  const radio = await cursorOf(page);

  // §3: radiological negates `right` and nothing else. Screen-right is the same key either way, so
  // the world displacement is exactly opposite — this is the laterality-safety assertion for the
  // keyboard, the twin of the drag one in `pointer.spec.ts`.
  for (const k of [0, 1, 2] as const) {
    expect(radio[k] - start[k], `axis ${k}`).toBeCloseTo(-(neuro[k] - start[k]), 4);
  }
  // `up` is untouched by the flip: an up-nudge lands in the same world place in both conventions.
  await page.evaluate(
    (c) => {
      window.__tvxEngine!.setCursor(c as [number, number, number]);
    },
    start as unknown as number[]
  );
  await nudge(page, 'axial', 0, 1);
  const radioUp = await cursorOf(page);
  await page.evaluate(
    (c) => {
      const engine = window.__tvxEngine!;
      engine.setRadiological(false);
      engine.setCursor(c as [number, number, number]);
    },
    start as unknown as number[]
  );
  await nudge(page, 'axial', 0, 1);
  const neuroUp = await cursorOf(page);
  for (const k of [0, 1, 2] as const) expect(radioUp[k]).toBeCloseTo(neuroUp[k] ?? 0, 9);
  expect(errors).toEqual([]);
});

test('@angle P2-09: 100 nudges out and 100 back return to the starting point exactly, on a rotated affine (§11’s anti-drift rule)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = await openScene(page);
  // The hard case on purpose: `vol_f32.nii.gz`'s affine is rotated and anisotropic, so the pane's
  // `right` is not a voxel axis and the snap has real work to do on every single step.
  await load(page, OBLIQUE, ['axial']);

  for (const [label, dx, dy] of [
    ['right', 1, 0],
    ['up', 0, 1],
  ] as const) {
    // Start off the grid, so the first nudge carries a snap correction the rest must not repeat.
    await page.evaluate(() => {
      window.__tvxEngine!.setCursor([0.317, -0.233, 0.451]);
    });
    await nudge(page, 'axial', dx, dy);
    const settled = await cursorOf(page);

    for (let i = 0; i < 100; i += 1) await nudge(page, 'axial', dx, dy);
    const far = await cursorOf(page);
    const travelled = Math.hypot(far[0] - settled[0], far[1] - settled[1], far[2] - settled[2]);
    expect(travelled, `${label}: 100 nudges went somewhere`).toBeGreaterThan(50);

    for (let i = 0; i < 100; i += 1) await nudge(page, 'axial', -dx, -dy);
    const back = await cursorOf(page);
    for (const k of [0, 1, 2] as const) {
      expect(back[k], `${label}: axis ${k} after 200 nudges`).toBeCloseTo(settled[k] ?? 0, 4);
    }
  }
  expect(errors).toEqual([]);
});

test('@angle P2-09: a mesh-only scene nudges at 1 mm, and the 3D pane has no in-plane nudge at all', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = await openScene(page);
  await page.evaluate(async (u) => {
    const engine = window.__tvxEngine!;
    const ds = await engine.addDataset({ kind: 'path', path: u });
    engine.addLayer({ datasetId: ds.id, kind: 'mesh' });
    engine.setLayout({ kind: '2x2', cells: ['axial', 'coronal', 'sagittal', 'view3d'] });
    await engine.whenSettled();
  }, fixture('mesh_v2_binary.msh'));

  // R4's rule, applied in-plane: with no volume the step is 1 mm, not a fraction of a bbox.
  const before = await cursorOf(page);
  await nudge(page, 'axial', 1, 0);
  const after = await cursorOf(page);
  expect(after[0] - before[0]).toBeCloseTo(1, 6);
  expect(after[1]).toBeCloseTo(before[1], 9);
  expect(after[2]).toBeCloseTo(before[2], 9);

  // A `View3D` has no in-plane basis; the call is a no-op rather than a guess.
  await nudge(page, 'view3d', 1, 1);
  expect(await cursorOf(page)).toEqual(after);
  expect(errors).toEqual([]);
});
