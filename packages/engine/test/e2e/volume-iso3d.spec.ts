/**
 * §4.4's `VolumeLayer.iso3d` in the 3D pane — §11 analytic assertions (directed task 2, 2026-08-28).
 *
 * Rule 0 (§11): *an agent cannot judge a PNG; it can judge a number.* Two numbers are computed from
 * first principles here and neither comes from a previous run:
 *
 * * **The colour at the pane centre.** The camera looks at the volume's centre, which is the centre
 *   of the analytic sphere, so under an orthographic camera the centre pixel is the point of the
 *   surface whose normal *is* the view direction. §7.4's headlight (`shaders/mesh.ts`) is then
 *   `rgb = base * (ambient + (1 - ambient) * diff) + spec` with `diff = dot(n, l) = 1` and
 *   `spec = pow(dot(n, h), 32) * 0.25 = 0.25`, so the expected byte triple is
 *   `round(255 * (base + 0.25))` — the ambient term drops out entirely at full diffuse, which is
 *   what makes this a closed-form expectation rather than a measured one.
 * * **The silhouette radius.** Under an orthographic camera a sphere of radius `R` mm is exactly
 *   `2R / mmPerPx` px wide, with no perspective enlargement to model. The tolerance is one **voxel**
 *   of screen extent plus one pixel, not one pixel alone: marching cubes returns a lattice
 *   approximation of the sphere, so its silhouette is quantised to the voxel grid — a tighter bound
 *   would be asserting against the fixture's sampling, not against the renderer.
 *
 * The fixture is built in the page: a 48³ float32 NIfTI whose sample is the distance to the centre,
 * so the `iso = R` level set is a sphere of radius `R` mm exactly. It is the same construction
 * `derived.spec.ts` uses for the standalone `iso` layer — deliberately, because the claim under test
 * here is that a **volume layer** reaches the same surface through `iso3d`, without a second layer.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectGolden, readCanvasRect } from '../helpers/pixels';
import type { VolumeIso3d } from '../../src/scene/types';

/** The canvas in `test/pages/scene.html`. */
const PANE = 768;

type ISO_COLOR_T = [number, number, number, number];
/**
 * The surface colour, chosen so **no channel clamps** once the specular 0.25 is added: `1.0` would
 * saturate to 255 and hide any error in the red channel entirely.
 */
const ISO_COLOR: ISO_COLOR_T = [0.6, 0.3, 0.1, 1];

/** §7.4's headlight at `diff = 1`, `spec = 0.25`: `round(255 * (base + 0.25))`. */
const EXPECTED_CENTRE = ISO_COLOR.slice(0, 3).map((c) => Math.round(255 * (c + 0.25)));

async function openScene(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/test/pages/scene.html');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);
  return errors;
}

interface SphereInfo {
  layerKind: string;
  layerCount: number;
  iso: number;
  expectedPx: number;
  isoStatus: { pending: number; total: number };
  ops: string[];
  errors: string[];
}

/**
 * A **volume** layer over the analytic sphere, with `iso3d` on, alone in a 3D pane.
 *
 * `showIn3D` stays false, so the only thing in the pane is the surface: a slice plane through the
 * middle of the volume would sit at the centre pixel and the centre-colour assertion would be
 * measuring the slice instead.
 */
async function sphereVolume(page: Page, opts: { color: [number, number, number, number] }) {
  return await page.evaluate(
    async ({ color, pane }): Promise<SphereInfo> => {
      const engine = window.__tvxEngine!;
      const N = 48;
      const R = 12;
      // --- a minimal NIfTI-1: 348-byte header, `vox_offset` 352, float32, identity sform.
      const buf = new ArrayBuffer(352 + N * N * N * 4);
      const dv = new DataView(buf);
      dv.setInt32(0, 348, true);
      dv.setInt16(40, 3, true); // dim[0] = 3
      dv.setInt16(42, N, true);
      dv.setInt16(44, N, true);
      dv.setInt16(46, N, true);
      dv.setInt16(70, 16, true); // datatype = NIFTI_TYPE_FLOAT32
      dv.setInt16(72, 32, true); // bitpix
      for (let i = 0; i < 8; i += 1) dv.setFloat32(76 + i * 4, 1, true); // pixdim
      dv.setFloat32(108, 352, true); // vox_offset
      dv.setFloat32(112, 1, true); // scl_slope
      dv.setFloat32(116, 0, true); // scl_inter
      dv.setInt16(254, 1, true); // sform_code = NIFTI_XFORM_SCANNER_ANAT
      dv.setFloat32(280, 1, true); // srow_x = (1,0,0,0)
      dv.setFloat32(296 + 4, 1, true); // srow_y = (0,1,0,0)
      dv.setFloat32(312 + 8, 1, true); // srow_z = (0,0,1,0)
      for (const [i, ch] of [...'n+1'].entries()) dv.setUint8(344 + i, ch.charCodeAt(0));
      const data = new Float32Array(buf, 352);
      const c = (N - 1) / 2;
      for (let k = 0; k < N; k += 1) {
        for (let j = 0; j < N; j += 1) {
          for (let i = 0; i < N; i += 1) {
            data[i + N * (j + N * k)] = Math.hypot(i - c, j - c, k - c);
          }
        }
      }

      const ds = await engine.addDataset({ kind: 'bytes', name: 'sphere.nii', bytes: buf });
      // A **volume** layer — not an `iso` one. `iso3d` is what makes it grow a surface.
      const layer = engine.addLayer({ datasetId: ds.id, kind: 'volume' });
      engine.updateLayer(layer.id, {
        showIn3D: false,
        iso3d: {
          enabled: true,
          iso: R,
          color: color as [number, number, number, number],
          opacity: 1,
          smooth: true,
          faceMode: 'both',
        },
      });
      engine.setLayout({ kind: '3d-only', cells: ['view3d'] });
      engine.resetView('view3d');
      engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });
      const cam = engine.scene.view3d.camera;
      engine.setView('view3d', { camera: { ...cam, orthographic: true } });
      await engine.whenSettled();
      engine.renderNow();
      const after = engine.scene.view3d.camera;
      const halfH = Math.tan(((after.fovYDeg * Math.PI) / 180) * 0.5) * after.distance;
      return {
        layerKind: layer.kind,
        // The surface is NOT a row in `Scene.layers`: it is owned by the volume layer, which is the
        // whole design. A second row here would mean the app's layer panel had grown one too.
        layerCount: engine.scene.layers.length,
        iso: R,
        expectedPx: (2 * R * pane) / (2 * halfH),
        isoStatus: engine.iso3dStatus(layer.id),
        ops: window.__tvxOps ?? [],
        errors: window.__tvxErrors ?? [],
      };
    },
    { ...opts, pane: PANE }
  );
}

/** The lit span across the pane's middle row, in pixels. */
function silhouette(row: Uint8Array): { first: number; last: number; width: number } {
  let first = -1;
  let last = -1;
  for (let x = 0; x < PANE; x += 1) {
    const o = x * 4;
    const lit = (row[o] ?? 0) > 40 || (row[o + 1] ?? 0) > 40 || (row[o + 2] ?? 0) > 40;
    if (lit) {
      if (first < 0) first = x;
      last = x;
    }
  }
  return { first, last, width: last - first + 1 };
}

test("a volume layer's iso3d surface renders in 3D with the radius its level implies", async ({
  page,
}) => {
  const errors = await openScene(page);
  // A saturated red-orange: the ratios are far enough apart that no lighting term can reorder them.
  const info = await sphereVolume(page, { color: [...ISO_COLOR] as ISO_COLOR_T });

  expect(errors).toEqual([]);
  expect(info.errors).toEqual([]);
  expect(info.layerKind, 'the layer the user added is a volume layer').toBe('volume');
  expect(info.layerCount, 'the surface is owned, not a second scene layer').toBe(1);
  // The surface really did go through the existing op — no new geometry path (§4.4's `iso3d`).
  expect(info.ops).toContain('marchingCubes');
  expect(info.isoStatus).toEqual({ pending: 0, total: 1 });

  // -- the colour at the pane centre ------------------------------------------------------------
  const centre = await readCanvasRect(page, PANE / 2, PANE / 2, 1, 1);
  const [r, g, b, a] = [centre[0] ?? 0, centre[1] ?? 0, centre[2] ?? 0, centre[3] ?? 0];
  expect(a, 'the centre of the pane is the surface, not the background').toBe(255);
  // `round(255 * (base + spec))`, from the headlight in `shaders/mesh.ts` at `diff = 1`. The
  // tolerance is 4/255: the surface is a marching-cubes lattice, so the facet under the centre pixel
  // has a normal within a fraction of a degree of the view vector rather than exactly along it.
  for (const [i, expected] of EXPECTED_CENTRE.entries()) {
    expect(Math.abs(([r, g, b][i] as number) - expected), `channel ${i}`).toBeLessThanOrEqual(4);
  }

  // -- the silhouette ---------------------------------------------------------------------------
  const row = await readCanvasRect(page, 0, PANE / 2, PANE, 1);
  const span = silhouette(row);
  expect(span.first, 'the surface must be on screen at all').toBeGreaterThan(0);
  const voxelPx = info.expectedPx / (2 * info.iso);
  expect(Math.abs(span.width - info.expectedPx)).toBeLessThanOrEqual(voxelPx + 1);
  // Centred: a surface built from the wrong 4D frame, or at the wrong origin, would be off-centre
  // even at the right width.
  expect(Math.abs((span.first + span.last) / 2 - PANE / 2)).toBeLessThanOrEqual(voxelPx + 1);
});

test('turning the iso3d switch off empties the 3D pane again', async ({ page }) => {
  const errors = await openScene(page);
  await sphereVolume(page, { color: [...ISO_COLOR] as ISO_COLOR_T });
  const off = await page.evaluate(async () => {
    const engine = window.__tvxEngine!;
    const layer = engine.scene.layers[0]!;
    const spec = (layer as { iso3d?: VolumeIso3d }).iso3d!;
    engine.updateLayer(layer.id, { iso3d: { ...spec, enabled: false } });
    await engine.whenSettled();
    engine.renderNow();
    return engine.iso3dStatus(layer.id);
  });
  expect(errors).toEqual([]);
  // Off means the layer owns nothing — not that it owns something invisible.
  expect(off).toEqual({ pending: 0, total: 0 });
  const row = await readCanvasRect(page, 0, PANE / 2, PANE, 1);
  expect(silhouette(row).first, 'nothing is lit once the switch is off').toBe(-1);
});

test('golden: volume-iso3d-sphere', async ({ page }) => {
  const errors = await openScene(page);
  const info = await sphereVolume(page, { color: [...ISO_COLOR] as ISO_COLOR_T });
  expect(errors).toEqual([]);
  expect(info.errors).toEqual([]);
  await expectGolden(page, 'volume-iso3d-sphere');
});
