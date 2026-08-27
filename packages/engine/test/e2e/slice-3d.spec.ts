/**
 * §7.3's `showIn3D` planes, and §11's **Overlay compositing in 3D** property on a synthetic scene.
 *
 * Phase 1 drew volumes in 2D panes only; §7.2 pass 1 also draws, in a **3D** pane, "the plane of
 * each `SliceView` whose owning volume layer has `showIn3D`". Two things have to be true there and
 * are asserted here over **every pixel of the pane**, never on a sample grid:
 *
 * 1. **The planes appear, and only when asked.** Toggling `showIn3D` is the whole difference between
 *    an empty 3D pane and a populated one.
 * 2. **Two layers on one plane composite exactly as they do in 2D.** §7.3's rule is shared plane
 *    geometry plus `invariant gl_Position` ⇒ bit-identical depth ⇒ `LEQUAL` passes for every layer of
 *    that plane. §11 states the consequence as an *independence* property: at opacity 1 the composite
 *    must not move by one byte when the layer underneath it is hidden or re-windowed, while each of
 *    those visibly changes the base on its own. One z-fought pixel anywhere breaks it, and no
 *    tolerance can hide it.
 *
 * The real-data half of the same named test — `Thalamus_TI_subject_TI_max.nii.gz` over `T1.nii.gz`,
 * with the golden — is `slice-realdata.spec.ts`. This file is its synthetic twin and runs in CI,
 * where `TETRAVOX_TESTDATA` is deliberately unset.
 *
 * There is deliberately **no full-plane depth prepass** (§7.3): the planes are one draw per (layer,
 * plane) and nothing else, so a 3D pane's depth buffer is written only where a volume layer actually
 * paints and a mesh behind the plane stays visible through the gap.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const fixture = (name: string): string => `/@fs${REPO}testdata/${name}`;

/** Not a label volume (§6.1: min is −11700), so it takes the colormap-and-blend path §11 names. */
const VOL = 'vol_i16.nii.gz';
const PANE = 768;

async function open3d(page: Page): Promise<void> {
  await page.goto('/test/pages/scene.html');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);
}

test('showIn3D: the planes appear in the 3D pane only when the layer asks for them', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await open3d(page);

  const r = await page.evaluate(
    async ([url, pane]) => {
      const engine = window.__tvxEngine!;
      const P = pane as number;
      const gl = document.querySelector('canvas')!.getContext('webgl2')!;
      const grab = (): Uint8Array => {
        engine.renderNow();
        const px = new Uint8Array(P * P * 4);
        gl.readPixels(0, 0, P, P, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return px;
      };
      const ds = await engine.addDataset({ kind: 'path', path: url as string });
      const layer = engine.addLayer({ datasetId: ds.id, kind: 'volume' });
      engine.setLayout({ kind: '3d-only', cells: ['view3d'] });
      engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });
      engine.resetView('view3d');
      await engine.whenSettled();
      const off = grab();
      engine.updateLayer(layer.id, { showIn3D: true });
      await engine.whenSettled();
      const on = grab();

      // The `showIn3D: false` frame **is** the chrome frame — §8's RAD/NEU badge is not optional,
      // so it is in both. Its pixels name themselves and are excluded from every count below.
      const bg = engine.scene.background.map((c) => Math.round(c * 255));
      const isChrome = new Uint8Array(P * P);
      let paintedOff = 0;
      let paintedOn = 0;
      let changed = 0;
      for (let i = 0; i < P * P; i += 1) {
        const a = [off[i * 4] ?? 0, off[i * 4 + 1] ?? 0, off[i * 4 + 2] ?? 0];
        const b = [on[i * 4] ?? 0, on[i * 4 + 1] ?? 0, on[i * 4 + 2] ?? 0];
        if (!(a[0] === bg[0] && a[1] === bg[1] && a[2] === bg[2])) {
          isChrome[i] = 1;
          paintedOff += 1;
          continue;
        }
        if (!(b[0] === bg[0] && b[1] === bg[1] && b[2] === bg[2])) paintedOn += 1;
        if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) changed += 1;
      }
      // Every pixel the planes paint is a grey from the `gray` LUT (r == g == b), because the
      // fixture is a scalar volume under the default colormap. A stray colour would mean the label
      // branch or an uninitialised palette reached a 3D draw.
      let nonGrey = 0;
      for (let i = 0; i < P * P; i += 1) {
        if (isChrome[i] === 1) continue;
        const r0 = on[i * 4] ?? 0;
        const g0 = on[i * 4 + 1] ?? 0;
        const b0 = on[i * 4 + 2] ?? 0;
        if (r0 === bg[0] && g0 === bg[1] && b0 === bg[2]) continue;
        if (r0 !== g0 || g0 !== b0) nonGrey += 1;
      }
      return { paintedOff, paintedOn, changed, nonGrey, errors: window.__tvxErrors ?? [] };
    },
    [fixture(VOL), PANE] as const
  );

  expect(pageErrors).toEqual([]);
  expect(r.errors).toEqual([]);
  // Chrome is off and the badge is the only thing left, so "nothing drawn" is a small number.
  expect(r.paintedOff, '§8’s badge is the only thing an empty 3D pane draws').toBeLessThan(
    PANE * PANE * 0.01
  );
  expect(r.paintedOn, 'the three planes must cover a real part of the pane').toBeGreaterThan(
    PANE * PANE * 0.02
  );
  expect(r.changed).toBeGreaterThan(0);
  expect(r.nonGrey, 'a scalar layer painted a non-grey pixel in 3D').toBe(0);
});

test('overlay compositing in 3D: independence over every pixel at opacity 1 (§11)', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await open3d(page);

  const r = await page.evaluate(
    async ([url, pane]) => {
      const engine = window.__tvxEngine!;
      const P = pane as number;
      const gl = document.querySelector('canvas')!.getContext('webgl2')!;
      const grab = (): Uint8Array => {
        engine.renderNow();
        const px = new Uint8Array(P * P * 4);
        gl.readPixels(0, 0, P, P, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return px;
      };
      const diff = (a: Uint8Array, b: Uint8Array): number => {
        let d = 0;
        for (let i = 0; i < a.length; i += 4) {
          if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) d += 1;
        }
        return d;
      };

      // The same file twice: two datasets, two layers, one footprint. Whether the top layer's
      // pixels depend on the bottom one is exactly what §11's exact-100 % clause asks.
      const base = await engine.addDataset({ kind: 'path', path: url as string });
      const baseLayer = engine.addLayer({ datasetId: base.id, kind: 'volume' });
      engine.setLayout({ kind: '3d-only', cells: ['view3d'] });
      engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });
      engine.updateLayer(baseLayer.id, { showIn3D: true });
      engine.resetView('view3d');
      await engine.whenSettled();
      const baseOnly = grab();

      const scale0 = (
        engine.scene.layers[0] as { scale: { kind: 'linear'; lo: number; hi: number } }
      ).scale;
      const scale1 = {
        kind: 'linear' as const,
        lo: scale0.lo,
        hi: scale0.lo + (scale0.hi - scale0.lo) * 3,
      };
      engine.updateLayer(baseLayer.id, { scale: scale1 });
      await engine.whenSettled();
      const baseRewindowed = grab();
      engine.updateLayer(baseLayer.id, { scale: scale0 });
      await engine.whenSettled();

      const over = await engine.addDataset({ kind: 'path', path: url as string });
      const overLayer = engine.addLayer({ datasetId: over.id, kind: 'volume' });
      engine.updateLayer(overLayer.id, { showIn3D: true, opacity: 1, colormap: 'viridis' });
      await engine.whenSettled();
      const composited = grab();

      engine.updateLayer(baseLayer.id, { scale: scale1 });
      await engine.whenSettled();
      const compositedRewindowed = grab();
      engine.updateLayer(baseLayer.id, { scale: scale0, visible: false });
      await engine.whenSettled();
      const compositedNoBase = grab();

      const bg = engine.scene.background.map((c) => Math.round(c * 255));
      let footprint = 0;
      for (let i = 0; i < composited.length; i += 4) {
        if (composited[i] !== bg[0] || composited[i + 1] !== bg[1] || composited[i + 2] !== bg[2]) {
          footprint += 1;
        }
      }

      return {
        pixels: P * P,
        footprint,
        controlRewindow: diff(baseOnly, baseRewindowed),
        controlOverlayCovers: diff(baseOnly, composited),
        leakRewindow: diff(composited, compositedRewindowed),
        leakHidden: diff(composited, compositedNoBase),
        errors: window.__tvxErrors ?? [],
      };
    },
    [fixture(VOL), PANE] as const
  );

  expect(pageErrors).toEqual([]);
  expect(r.errors).toEqual([]);
  // The controls: both perturbations of the base really do change what is on screen…
  expect(r.controlRewindow, 're-windowing the base must visibly change it').toBeGreaterThan(
    r.pixels * 0.005
  );
  expect(r.controlOverlayCovers, 'the overlay must change a real part of the view').toBeGreaterThan(
    r.pixels * 0.005
  );
  expect(r.footprint, 'the planes must cover a real part of the pane').toBeGreaterThan(
    r.pixels * 0.02
  );
  // …and yet the composite does not move by a single pixel. That is the exact-100 % footprint,
  // under `depthFunc(LEQUAL)` with `depthMask(true)` on shared plane geometry.
  expect(r.leakRewindow, 'a base re-window must not reach through an opaque overlay in 3D').toBe(0);
  expect(r.leakHidden, 'nor must hiding the base entirely').toBe(0);
});
