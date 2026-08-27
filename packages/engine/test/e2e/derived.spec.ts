/**
 * E-DERIVED's §11 analytic pixel assertions, on the committed synthetic fixtures.
 *
 * Rule 0 (§11): *an agent cannot judge a PNG; it can judge a number.* Every expected RGBA below is
 * computed from first principles — from `testdata/manifest.json`'s authored `.msh.opt` tag→colour
 * map, from the lattice's own construction rule ("tets with centroid z < mid → 1, else 2"), and from
 * the projection the pane camera defines — never from a previous run.
 *
 * `mesh_v2_binary.msh` is the lattice: a 20 mm cube of 48 tets over a 3×3×3 node grid, tag 1 below
 * `z = 0` and tag 2 above it, with `mesh_v2_binary.msh.opt` giving tag 1 `(230, 230, 210)`, tag 2
 * `(129, 129, 129)` and — the useful part — `tagVisible[1] = false`. So the default open already
 * exercises R5's "hiding a tag removes its colour from the pane pixels while others are unchanged",
 * and turning it on exercises the positive half.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { expectGolden, expectPixel, readCanvasPixels, readCanvasRect } from '../helpers/pixels';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const fixture = (name: string): string => `/@fs${REPO}testdata/${name}`;

const LATTICE = fixture('mesh_v2_binary.msh');
const LATTICE_OPT = fixture('mesh_v2_binary.msh.opt');

/** The canvas in `test/pages/scene.html`, and the centre of a `1x1` pane in it. */
const PANE = 768;
const CX = PANE / 2;
const CY = PANE / 2;

/** `testdata/manifest.json` → `sidecars['mesh_v2_binary.msh.opt'].expected.tagColor`. */
const TAG1 = [230, 230, 210, 255] as const;
const TAG2 = [129, 129, 129, 255] as const;
/** `scene/defaults.ts`'s `background`, as bytes. */
const BG = [10, 13, 18, 255] as const;

async function openScene(page: Page, query = ''): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/test/pages/scene.html${query}`);
  await page.waitForFunction(() => window.__tvxEngine !== undefined);
  return errors;
}

/**
 * A coronal pane through the lattice, at 0.05 mm/px with the cursor at `y = 2.5`.
 *
 * `y = 2.5` on purpose: the node grid sits at `y ∈ {−10, 0, 10}`, and a cut plane *through* a node
 * plane is the degenerate case (zero-area polygons, faces counted twice). Every real cut avoids it
 * by accident; a test must avoid it on purpose.
 *
 * The coronal basis is `normal = −Y`, `up = +Z`, `right = cross(up, normal) = +X` (§3), so screen-up
 * is `+Z`: tag 2's half is the **top** of the pane and tag 1's the bottom.
 */
async function coronalLattice(page: Page, mmPerPx = 0.05): Promise<{ layerId: string }> {
  return await page.evaluate(
    async ([url, opt, scale]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({
        kind: 'path',
        path: url as string,
        sidecars: { opt: opt as string },
      });
      const layer = engine.addLayer({ datasetId: ds.id, kind: 'mesh' });
      engine.setLayout({ kind: '1x1', cells: ['coronal'] });
      engine.setCursor([0, 2.5, 0]);
      engine.setView('coronal', { camera: { center: [0, 0], mmPerPx: scale as number } });
      engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });
      await engine.whenSettled();
      return { layerId: layer.id };
    },
    [LATTICE, LATTICE_OPT, mmPerPx] as const
  );
}

// -------------------------------------------------------------------------------------------
// `fillIn2D` — R4's per-element cut polygons, coloured by tissue tag
// -------------------------------------------------------------------------------------------

test('fillIn2D paints each cut polygon its exact tag colour, and a hidden tag paints nothing', async ({
  page,
}) => {
  const errors = await openScene(page);
  const { layerId } = await coronalLattice(page);

  // 100 px above centre is `z = +5` (tag 2); 100 px below is `z = −5` (tag 1). Both are 100 px left
  // of centre so neither sits on the crosshair's axis even when the chrome is on.
  const inTag2: [number, number] = [CX - 100, CY - 100];
  const inTag1: [number, number] = [CX - 100, CY + 100];

  // **R4's analytic assertion**: the pixel is the wire `[u8;4]` of `MeshMeta.tags[].color`, which
  // §4.1 requires to round-trip exactly through the engine's 0..1 form.
  await expectPixel(page, inTag2[0], inTag2[1], TAG2);
  // **R5's negative half**, for free: `.msh.opt` says `tagVisible[1] = false`, so tag 1's half of
  // the same cut is background — not a dimmed colour, not a blended one, *absent*.
  await expectPixel(page, inTag1[0], inTag1[1], BG);

  // Now show it. Only tag 1's pixels change.
  await page.evaluate(async (id) => {
    const engine = window.__tvxEngine!;
    engine.updateLayer(id as string, { tagStyle: { 1: { visible: true, opacity: 1 } } });
    await engine.whenSettled();
  }, layerId);
  await expectPixel(page, inTag1[0], inTag1[1], TAG1);
  await expectPixel(page, inTag2[0], inTag2[1], TAG2);

  expect(errors).toEqual([]);
});

test('fillIn2D follows the cursor: an axial sweep crosses the tag boundary at z = 0', async ({
  page,
}) => {
  const errors = await openScene(page);
  await page.evaluate(
    async ([url, opt]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({
        kind: 'path',
        path: url as string,
        sidecars: { opt: opt as string },
      });
      const layer = engine.addLayer({ datasetId: ds.id, kind: 'mesh' });
      // Both tags visible, so the sweep shows a colour change rather than an appearance.
      engine.updateLayer(layer.id, {
        tagStyle: { 1: { visible: true, opacity: 1 }, 2: { visible: true, opacity: 1 } },
      });
      engine.setLayout({ kind: '1x1', cells: ['axial'] });
      engine.setView('axial', { camera: { center: [0, 0], mmPerPx: 0.05 } });
      engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });
      await engine.whenSettled();
    },
    [LATTICE, LATTICE_OPT] as const
  );

  // The lattice's own rule: a tet's tag is 1 below `z = 0` and 2 above it. An axial plane is
  // therefore uniformly one tag, and which one is decided by the cursor alone.
  const sampleAt = async (z: number): Promise<readonly number[]> => {
    await page.evaluate(async (zz) => {
      const engine = window.__tvxEngine!;
      engine.setCursor([0, 0.5, zz as number]);
      await engine.whenSettled();
    }, z);
    const [px] = await readCanvasPixels(page, [[CX - 100, CY - 100]]);
    return px!;
  };

  expect(await sampleAt(-5)).toEqual([...TAG1]);
  expect(await sampleAt(5)).toEqual([...TAG2]);
  // …and back, so the sweep is not one-way: latest-wins must land the *current* plane's cut.
  expect(await sampleAt(-5)).toEqual([...TAG1]);
  expect(errors).toEqual([]);
});

// -------------------------------------------------------------------------------------------
// `contoursIn2D` — the instanced screen-space quad expansion
// -------------------------------------------------------------------------------------------

/**
 * §11: *a contour segment's screen-space width at two zooms is `contourWidthPx` ± 0.5 px — this is
 * what proves the quad expansion, since `lineWidth` would silently give 1 px at both.*
 *
 * The measurement is on the lattice's own outline: with the fill off, a vertical scan through the
 * cut's top edge crosses exactly one contour band, and its run length is the width.
 */
async function contourBandHeight(page: Page, widthPx: number, mmPerPx: number): Promise<number> {
  await page.evaluate(async (w) => {
    const engine = window.__tvxEngine!;
    const layer = engine.scene.layers[0]!;
    engine.updateLayer(layer.id, {
      fillIn2D: false,
      contoursIn2D: true,
      contourWidthPx: w as number,
      edgeColor: [1, 1, 1, 1],
    });
    await engine.whenSettled();
  }, widthPx);
  // Scan a 1-px-wide column through the cut's upper edge (`z = +10`). The column is off the
  // crosshair axis and **5 mm** inside the 20 mm cube in x — a *world* offset, not a fixed pixel
  // one: at 0.5 mm/px a fixed `CX − 100` is 50 mm off centre, outside the cube entirely, and the
  // scan then finds nothing and reports a width of 0 for a contour that is drawn correctly.
  const column = await readCanvasRect(page, CX - Math.round(5 / mmPerPx), 0, 1, PANE);
  let best = 0;
  let run = 0;
  for (let y = 0; y < PANE; y += 1) {
    const o = y * 4;
    const lit = (column[o] ?? 0) > 128 && (column[o + 1] ?? 0) > 128 && (column[o + 2] ?? 0) > 128;
    run = lit ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

test('a contour keeps its pixel width at two zooms — the quad expansion, not lineWidth', async ({
  page,
}) => {
  const errors = await openScene(page);
  await coronalLattice(page, 0.05);
  const wide05 = await contourBandHeight(page, 3, 0.05);
  expect(wide05, 'contourWidthPx 3 at 0.05 mm/px').toBeGreaterThanOrEqual(2.5);
  expect(wide05).toBeLessThanOrEqual(3.5);

  // Ten times coarser: a `LINES` implementation is 1 px here as well, and a *world*-space expansion
  // would collapse to a tenth of the band.
  await page.evaluate(async () => {
    const engine = window.__tvxEngine!;
    engine.setView('coronal', { camera: { center: [0, 0], mmPerPx: 0.5 } });
    await engine.whenSettled();
  });
  const wide5 = await contourBandHeight(page, 3, 0.5);
  expect(wide5, 'contourWidthPx 3 at 0.5 mm/px').toBeGreaterThanOrEqual(2.5);
  expect(wide5).toBeLessThanOrEqual(3.5);

  // And the knob is a knob: 1 px is one pixel.
  const thin = await contourBandHeight(page, 1, 0.5);
  expect(thin).toBeGreaterThanOrEqual(1);
  expect(thin).toBeLessThanOrEqual(1.5);
  expect(errors).toEqual([]);
});

// -------------------------------------------------------------------------------------------
// Points
// -------------------------------------------------------------------------------------------

test('a points layer lands on the pixel the projection names, and only on its own slice', async ({
  page,
}) => {
  const errors = await openScene(page);
  await coronalLattice(page);
  await page.evaluate(async () => {
    const engine = window.__tvxEngine!;
    const ds = [...engine.scene.datasets.values()][0]!;
    engine.addLayer({
      datasetId: ds.id,
      kind: 'points',
      // Two points: one on the pane's plane (`y = 2.5`, the cursor's), one 10 mm off it. Both have
      // a 4 mm radius, so the second's sphere does not reach the plane at all.
      points: [
        { position: [-5, 2.5, 5], name: 'on' },
        { position: [5, 12.5, 5], name: 'off' },
      ],
      color: [1, 0, 0, 1],
      radiusMm: 4,
    });
    await engine.whenSettled();
  });

  // Coronal: right = +X, up = +Z, 0.05 mm/px. World (−5, ·, +5) is 100 px left and 100 px up.
  await expectPixel(page, CX - 100, CY - 100, [255, 0, 0, 255]);
  // The off-plane point draws nothing: that pixel still shows tag 2's fill.
  await expectPixel(page, CX + 100, CY - 100, TAG2);
  // …and 3 mm out from the on-plane point's centre is still inside its 4 mm disc.
  await expectPixel(page, CX - 100 + 60, CY - 100, [255, 0, 0, 255]);
  // 5 mm out is not.
  await expectPixel(page, CX - 100 + 100, CY - 100, TAG2);
  expect(errors).toEqual([]);
});

// -------------------------------------------------------------------------------------------
// Isosurface
// -------------------------------------------------------------------------------------------

/**
 * §11: *an isosurface of an analytic sphere at a known radius — the rendered silhouette's extent
 * matches `2r` in screen mm within one pixel.*
 *
 * The volume is written in the page as a NIfTI-1 whose voxel value is the distance from the centre,
 * so the isosurface at `iso = r` **is** the sphere of radius `r` mm exactly, with no fitting and no
 * reference image. The camera is orthographic so the silhouette's extent is `2r / mmPerPx` with no
 * perspective term.
 */
test('an isosurface of an analytic sphere has the silhouette its radius implies', async ({
  page,
}) => {
  const errors = await openScene(page);
  const info = await page.evaluate(async () => {
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
    const layer = engine.addLayer({ datasetId: ds.id, kind: 'iso', iso: R, color: [1, 1, 1, 1] });
    engine.setLayout({ kind: '3d-only', cells: ['view3d'] });
    engine.resetView('view3d');
    engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });
    // Orthographic: the silhouette of a sphere is then exactly `2r / mmPerPx` wide, with no
    // perspective enlargement to model.
    const cam = engine.scene.view3d.camera;
    engine.setView('view3d', { camera: { ...cam, orthographic: true } });
    await engine.whenSettled();
    const after = engine.scene.view3d.camera;
    const halfH = Math.tan(((after.fovYDeg * Math.PI) / 180) * 0.5) * after.distance;
    return {
      kind: layer.kind,
      iso: R,
      // `2r` in pixels: the pane is `2·halfH` mm tall over 768 px.
      expectedPx: (2 * R * 768) / (2 * halfH),
      ops: window.__tvxOps ?? [],
      errors: window.__tvxErrors ?? [],
    };
  });

  expect(errors).toEqual([]);
  expect(info.errors).toEqual([]);
  expect(info.kind, 'addLayer({kind:"iso"}) must produce an iso layer').toBe('iso');
  expect(info.ops).toContain('marchingCubes');

  // Measure the silhouette across the pane's middle row.
  const row = await readCanvasRect(page, 0, PANE / 2, PANE, 1);
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
  const measured = last - first + 1;
  expect(first, 'the isosurface must be on screen at all').toBeGreaterThan(0);
  // The marching-cubes surface is a lattice approximation of the sphere, so the tolerance is one
  // voxel of screen extent rather than one pixel of an exact primitive.
  const voxelPx = info.expectedPx / (2 * info.iso);
  expect(Math.abs(measured - info.expectedPx)).toBeLessThanOrEqual(voxelPx + 1);
});

// -------------------------------------------------------------------------------------------
// Glyphs
// -------------------------------------------------------------------------------------------

test('vector glyphs draw from the field, and `subsample` is the knob that says how many', async ({
  page,
}) => {
  const errors = await openScene(page);
  const counts = await page.evaluate(
    async ([url, opt]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({
        kind: 'path',
        path: url as string,
        sidecars: { opt: opt as string },
      });
      const layer = engine.addLayer({ datasetId: ds.id, kind: 'mesh' });
      engine.setLayout({ kind: '3d-only', cells: ['view3d'] });
      engine.resetView('view3d');
      engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });
      // The shell stays visible throughout — `mesh_v2_binary.msh.opt` paints it (230,230,210) and
      // (129,129,129), and neither is magenta, so the count separates the arrows from it without
      // hiding anything. Hiding it is not an option: a glyph's origin comes from that tag's own
      // triangles, so an invisible tag has no arrows (asserted at the end of this test).
      engine.updateLayer(layer.id, { visible: false });
      await engine.whenSettled();

      const canvas = document.querySelector('canvas')!;
      const gl = canvas.getContext('webgl2')!;
      const countMagenta = (): number => {
        engine.renderNow();
        const px = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let n = 0;
        for (let i = 0; i < px.length; i += 4) {
          if ((px[i] ?? 0) > 120 && (px[i + 1] ?? 0) < 60 && (px[i + 2] ?? 0) > 120) n += 1;
        }
        return n;
      };

      const off = countMagenta();

      const glyphs = {
        field: { source: 'elm' as const, name: 'E' },
        shape: 'arrow' as const,
        subsample: { everyNth: 8 },
        scale: 'fixed' as const,
        lengthMm: 4,
        colorBy: 'solid' as const,
        color: [1, 0, 1, 1] as [number, number, number, number],
        clipToCutPlane: false,
      };
      engine.updateLayer(layer.id, { visible: true, glyphs });
      await engine.whenSettled();
      const sparse = countMagenta();

      engine.updateLayer(layer.id, { glyphs: { ...glyphs, subsample: { everyNth: 1 } } });
      await engine.whenSettled();
      const dense = countMagenta();

      // §7.4 / the Phase-2 ownership map: "origins restricted to **visible tags**". Every tag off is
      // therefore every glyph gone — the arrows belong to the tissue they stand on, not to the pane.
      // This is the same alpha channel of the same tag LUT that R5's hide uses, so the two cannot
      // drift apart.
      engine.updateLayer(layer.id, {
        tagStyle: Object.fromEntries(
          ('tags' in ds ? ds.tags : []).map((t) => [t.id, { visible: false, opacity: 1 }])
        ),
      });
      await engine.whenSettled();
      const allTagsHidden = countMagenta();

      return { off, sparse, dense, allTagsHidden, errors: window.__tvxErrors ?? [] };
    },
    [LATTICE, LATTICE_OPT] as const
  );

  expect(errors).toEqual([]);
  expect(counts.errors).toEqual([]);
  // Nothing of that colour is in the scene until the glyphs are.
  expect(counts.off).toBe(0);
  expect(counts.sparse, 'one arrow per eighth triangle must be visible').toBeGreaterThan(0);
  // Eight times as many origins is strictly more ink; `subsample` is the knob §4.4 says it is.
  expect(counts.dense).toBeGreaterThan(counts.sparse);
  // Origins are restricted to visible tags (§7.4), so hiding every tag is back to no arrows.
  expect(counts.allTagsHidden, 'every tag hidden must leave no glyph').toBe(0);
});

/**
 * `GlyphSpec.origins: 'volume'` — §6.5.2's `meshCentroids` as the origin table (§7.4).
 *
 * The two paths are separated by **one tagStyle state**: the lattice's surface is its stored
 * triangles (tags 1001 / 1002) and its interior is its tets (tags 1 / 2), so hiding the tri tags and
 * leaving the tet tags visible is a mesh whose *surface* no glyph belongs on. That state must give
 * the surface path **nothing** — every instance's `faceTag` is hidden in the tag LUT — and the
 * volume path **everything**, which is the whole reason the field over all 5,900,498 elements of
 * `ernie_TDCS_1_scalar.msh` needed a second origin source at all. Hiding the surface is also what
 * makes the interior arrows *visible*: an opaque 20 mm cube occludes every origin inside it.
 *
 * The rest asserts that the tag restriction really rides the **request** on this path (it cannot
 * ride the shader — the op filtered before it strided, so nothing per-origin is left to test): one
 * tet tag off is strictly less ink, and *every* tet tag off is a draw the engine does not make
 * rather than a `tags`-less request, which `tet_centroids` would read as "no filter" and light the
 * whole mesh up.
 */
test('`origins: "volume"` reads meshCentroids, and its tag filter rides the request', async ({
  page,
}) => {
  const errors = await openScene(page);
  const counts = await page.evaluate(
    async ([url, opt]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({
        kind: 'path',
        path: url as string,
        sidecars: { opt: opt as string },
      });
      const layer = engine.addLayer({ datasetId: ds.id, kind: 'mesh' });
      engine.setLayout({ kind: '3d-only', cells: ['view3d'] });
      engine.resetView('view3d');
      engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });

      const tags = 'tags' in ds ? ds.tags : [];
      /** Every tag explicitly, so nothing depends on `.msh.opt`'s seeded visibility. */
      const style = (
        visible: readonly number[]
      ): Record<number, { visible: boolean; opacity: number }> =>
        Object.fromEntries(
          tags.map((t) => [t.id, { visible: visible.includes(t.id), opacity: 1 }])
        );

      const canvas = document.querySelector('canvas')!;
      const gl = canvas.getContext('webgl2')!;
      const countMagenta = (): number => {
        engine.renderNow();
        const px = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let n = 0;
        for (let i = 0; i < px.length; i += 4) {
          if ((px[i] ?? 0) > 120 && (px[i + 1] ?? 0) < 60 && (px[i + 2] ?? 0) > 120) n += 1;
        }
        return n;
      };

      const glyphs = {
        field: { source: 'elm' as const, name: 'E' },
        shape: 'arrow' as const,
        subsample: { everyNth: 1 },
        scale: 'fixed' as const,
        lengthMm: 3,
        colorBy: 'solid' as const,
        color: [1, 0, 1, 1] as [number, number, number, number],
        clipToCutPlane: false,
      };
      const show = async (
        origins: 'surface' | 'volume',
        visible: readonly number[]
      ): Promise<number> => {
        engine.updateLayer(layer.id, {
          visible: true,
          tagStyle: style(visible),
          glyphs: { ...glyphs, origins },
        });
        await engine.whenSettled();
        return countMagenta();
      };

      // The tri tags are the surface, the tet tags the interior — `MeshTag.kind` says which.
      const tri = tags.filter((t) => t.kind === 'tri').map((t) => t.id);
      const tet = tags.filter((t) => t.kind === 'tet').map((t) => t.id);

      return {
        tri,
        tet,
        // The surface is visible: the surface path has origins, and they stick out of the box.
        surfaceOnSurface: await show('surface', [...tri, ...tet]),
        // The surface is hidden: the surface path has none, and the box no longer occludes.
        surfaceHidden: await show('surface', tet),
        volumeBoth: await show('volume', tet),
        volumeOneTag: await show('volume', [tet[1]!]),
        volumeNoTets: await show('volume', []),
        errors: window.__tvxErrors ?? [],
      };
    },
    [LATTICE, LATTICE_OPT] as const
  );

  expect(errors).toEqual([]);
  expect(counts.errors).toEqual([]);
  // The fixture is what the assertions below assume it is (`testdata/manifest.json`).
  expect(counts.tri).toEqual([1001, 1002]);
  expect(counts.tet).toEqual([1, 2]);

  // The surface path works, and is bounded by the surface: hiding every tri tag removes every
  // origin it has, because its filter is per-instance against `faceTag`.
  expect(counts.surfaceOnSurface, 'surface origins draw arrows').toBeGreaterThan(0);
  expect(counts.surfaceHidden, 'no visible surface tag ⇒ no surface origin').toBe(0);

  // Same tagStyle, other table: the interior tets have origins the surface never had. This is the
  // one assertion the feature exists for.
  expect(
    counts.volumeBoth,
    'volume origins draw where the surface path drew nothing'
  ).toBeGreaterThan(0);

  // The filter rides the request: half the tets is strictly less ink, none of them is no draw at
  // all — not a `tags`-less request, which the op reads as "every tet".
  expect(counts.volumeOneTag).toBeGreaterThan(0);
  expect(counts.volumeOneTag).toBeLessThan(counts.volumeBoth);
  expect(counts.volumeNoTets, 'every tet tag hidden must leave no glyph').toBe(0);
});

// -------------------------------------------------------------------------------------------
// Goldens (§11 (2)) — regression only, with the §8 chrome present
// -------------------------------------------------------------------------------------------

test('golden: derived-fill2d', async ({ page }) => {
  const errors = await openScene(page);
  await page.evaluate(
    async ([url, opt]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({
        kind: 'path',
        path: url as string,
        sidecars: { opt: opt as string },
      });
      const layer = engine.addLayer({ datasetId: ds.id, kind: 'mesh' });
      engine.updateLayer(layer.id, {
        tagStyle: { 1: { visible: true, opacity: 1 }, 2: { visible: true, opacity: 1 } },
      });
      engine.setLayout({
        kind: '2x2',
        cells: ['axial', 'coronal', 'sagittal', 'view3d'],
      });
      engine.setCursor([0, 2.5, 1.25]);
      for (const id of ['axial', 'coronal', 'sagittal']) {
        engine.setView(id, { camera: { center: [0, 0], mmPerPx: 0.08 } });
      }
      engine.resetView('view3d');
      await engine.whenSettled();
    },
    [LATTICE, LATTICE_OPT] as const
  );
  expect(errors).toEqual([]);
  await expectGolden(page, 'derived-fill2d');
});

test('golden: derived-points-and-iso', async ({ page }) => {
  const errors = await openScene(page);
  await page.evaluate(
    async ([url, opt]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({
        kind: 'path',
        path: url as string,
        sidecars: { opt: opt as string },
      });
      const layer = engine.addLayer({ datasetId: ds.id, kind: 'mesh' });
      engine.updateLayer(layer.id, {
        opacity: 0.35,
        tagStyle: { 1: { visible: true, opacity: 1 }, 2: { visible: true, opacity: 1 } },
      });
      engine.addLayer({
        datasetId: ds.id,
        kind: 'points',
        points: [
          { position: [-8, -8, -8], name: 'a' },
          { position: [8, 8, 8], name: 'b' },
          { position: [0, 0, 6], name: 'c', color: [0.2, 0.9, 1, 1] },
        ],
        radiusMm: 2,
      });
      engine.setLayout({ kind: '2x2', cells: ['axial', 'coronal', 'sagittal', 'view3d'] });
      engine.setCursor([0, 2.5, 1.25]);
      for (const id of ['axial', 'coronal', 'sagittal']) {
        engine.setView(id, { camera: { center: [0, 0], mmPerPx: 0.08 } });
      }
      engine.resetView('view3d');
      await engine.whenSettled();
    },
    [LATTICE, LATTICE_OPT] as const
  );
  expect(errors).toEqual([]);
  await expectGolden(page, 'derived-points-and-iso');
});

/**
 * The §11 golden the ownership map names `derived-glyphs-e-field`, on both origin tables at once.
 *
 * The 3D pane carries `origins: 'volume'` with the surface hidden — arrows on interior tet centroids
 * that no `SurfacePayload` could have produced — and the three 2D panes carry the `fillIn2D` cut, so
 * one image pins the whole `GlyphSpec` path against the cross-section it shares a dataset with.
 * Colour is `colorBy: 'magnitude'` over the lattice's `E` (`magnitudeStats` 2.66 … 28.47 in
 * `testdata/manifest.json`), so the ramp itself is in the picture: a solid colour would hide a
 * broken field lookup, which is exactly what the un-permutation fix in §6.5.2 was about.
 */
test('golden: derived-glyphs-e-field', async ({ page }) => {
  const errors = await openScene(page);
  await page.evaluate(
    async ([url, opt]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({
        kind: 'path',
        path: url as string,
        sidecars: { opt: opt as string },
      });
      const layer = engine.addLayer({ datasetId: ds.id, kind: 'mesh' });
      engine.updateLayer(layer.id, {
        // The tets visible (they colour the 2D cut and gate the origins), the surface hidden (it
        // would occlude every interior arrow in the 3D pane).
        tagStyle: {
          1: { visible: true, opacity: 1 },
          2: { visible: true, opacity: 1 },
          1001: { visible: false, opacity: 1 },
          1002: { visible: false, opacity: 1 },
        },
        scale: { kind: 'linear', lo: 2.65, hi: 28.47 },
        colormap: 'viridis',
        glyphs: {
          field: { source: 'elm', name: 'E' },
          shape: 'arrow',
          subsample: { everyNth: 1 },
          scale: 'byMagnitude',
          lengthMm: 4,
          colorBy: 'magnitude',
          color: [1, 0, 1, 1],
          clipToCutPlane: false,
          origins: 'volume',
        },
      });
      engine.setLayout({ kind: '2x2', cells: ['axial', 'coronal', 'sagittal', 'view3d'] });
      engine.setCursor([0, 2.5, 1.25]);
      for (const id of ['axial', 'coronal', 'sagittal']) {
        engine.setView(id, { camera: { center: [0, 0], mmPerPx: 0.08 } });
      }
      engine.resetView('view3d');
      await engine.whenSettled();
    },
    [LATTICE, LATTICE_OPT] as const
  );
  expect(errors).toEqual([]);
  await expectGolden(page, 'derived-glyphs-e-field');
});
