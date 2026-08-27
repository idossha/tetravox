/**
 * **The Phase-1 gate**, items 2–7 of `docs/ROADMAP.md`, on the reference dataset.
 *
 * Skips, never fails, when `TETRAVOX_TESTDATA` is unset (AGENTS rule 2).
 *
 * Item 1 (progress and cancel on the 492 MB `ernie_seeg.msh`) is a Playwright-**Electron** test and
 * lives in `packages/app/e2e/phase1-gate.spec.ts`, because it is the *app's* load card being timed.
 *
 * Every golden here is captured under headless Chromium/SwiftShader at a fixed canvas size, DPR 1,
 * `aa: 'off'` (§11). Note what §7.1 says about the golden authority: SwiftShader has **no**
 * `EXT_texture_norm16`, so `T1.nii.gz` is `R32F` in every golden and `R16` in the shipping renderer.
 * That is exactly why item 6 is an *analytic* pair through `EngineOptions.forceCaps` rather than two
 * goldens — a golden can only ever pin the branch the authority takes.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectGolden, readCanvasPixels } from '../helpers/pixels';
import { readBadge, readCornerInfo, readEdgeLetters } from '../helpers/chrome';

const ROOT = process.env.TETRAVOX_TESTDATA ?? '';
const fsUrl = (rel: string): string => `/@fs${ROOT}/${rel}`;

const T1 = 'm2m_ernie/T1.nii.gz';
const THALAMUS_TI = 'Simulations/Thalamus/TI/niftis/Thalamus_TI_subject_TI_max.nii.gz';
const ERNIE = 'm2m_ernie/ernie.msh';
const ERNIE_OPT = 'm2m_ernie/ernie.msh.opt';

const PANE = 768;

test.skip(ROOT === '', 'TETRAVOX_TESTDATA is unset');

/** Open the scene page with the given query string and wait for the engine. */
async function openScene(page: Page, query = ''): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/test/pages/scene.html${query}`);
  await page.waitForFunction(() => window.__tvxEngine !== undefined);
  (page as unknown as { __errors: string[] }).__errors = errors;
}

function pageErrors(page: Page): string[] {
  return (page as unknown as { __errors?: string[] }).__errors ?? [];
}

// -------------------------------------------------------------------------------------------
// Gate 2 — ernie.msh tag surfaces orbiting, with no build_topology on that path
// -------------------------------------------------------------------------------------------

test('gate 2: ernie.msh tag surfaces orbit in 3D, and no buildTopology is issued', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openScene(page);

  const info = await page.evaluate(
    async ([url, opt]) => {
      const engine = window.__tvxEngine!;
      const t0 = performance.now();
      const ds = await engine.addDataset({
        kind: 'path',
        path: url as string,
        sidecars: { opt: opt as string },
      });
      engine.addLayer({ datasetId: ds.id, kind: 'mesh' });
      engine.setLayout({ kind: '3d-only', cells: ['view3d'] });
      engine.resetView('view3d');
      await engine.whenSettled();
      const loadToFirstFrameMs = performance.now() - t0;

      // Orbit: sweep the camera through a full turn, timing each settled frame. This is both the
      // gate's "orbiting" and the benchmark's orbit frame time.
      const frames: number[] = [];
      const cam = engine.scene.view3d.camera;
      for (let i = 0; i < 24; i += 1) {
        const a = (i / 24) * Math.PI * 2;
        // Rotate about the world up axis.
        const q: [number, number, number, number] = [0, 0, Math.sin(a / 2), Math.cos(a / 2)];
        engine.setView('view3d', { camera: { ...cam, rotation: q } });
        const f0 = performance.now();
        engine.renderNow();
        frames.push(performance.now() - f0);
      }
      frames.sort((x, y) => x - y);

      return {
        nTris: 'nTris' in ds ? ds.nTris : 0,
        nTets: 'nTets' in ds ? ds.nTets : 0,
        nNodes: 'nNodes' in ds ? ds.nNodes : 0,
        tags: 'tags' in ds ? ds.tags.filter((t) => t.kind === 'tri').map((t) => t.id) : [],
        orient: 'orient' in ds ? ds.orient : null,
        ops: window.__tvxOps ?? [],
        errors: window.__tvxErrors ?? [],
        loadToFirstFrameMs,
        orbitMedianMs: frames[Math.floor(frames.length / 2)] ?? 0,
        orbitP95Ms: frames[Math.floor(frames.length * 0.95)] ?? 0,
      };
    },
    [fsUrl(ERNIE), fsUrl(ERNIE_OPT)] as const
  );

  expect(pageErrors(page)).toEqual([]);
  expect(info.errors).toEqual([]);
  // AGENTS.md's mesh table.
  expect(info.nNodes).toBe(847_165);
  expect(info.nTris).toBe(1_177_213);
  expect(info.nTets).toBe(4_722_625);
  // §6.3's tag census: ten tissue tags, and tag 4 does not exist.
  expect(info.tags).toEqual([1001, 1002, 1003, 1005, 1006, 1007, 1008, 1009, 1010, 1099]);
  expect(info.tags).not.toContain(1004);
  // §7.4: orient_surface flips four of ten tags and marks all ten open.
  expect(info.orient?.flippedComponents).toBe(41);
  expect(info.orient?.openComponents).toBeGreaterThan(0);

  // **The gate item**: the tag-surface path issues `surface`, never `buildTopology` (§6.3).
  expect(info.ops).toEqual(['loadMesh', 'surface']);
  expect(info.ops).not.toContain('buildTopology');
  expect(info.ops).not.toContain('boundary');

  // The pane is genuinely covered by the head, not by the background.
  const pts: [number, number][] = [];
  for (let y = 60; y < PANE - 60; y += 29)
    for (let x = 60; x < PANE - 60; x += 29) pts.push([x, y]);
  const px = await readCanvasPixels(page, pts);
  const lit = px.filter((p) => p[0] > 30 || p[1] > 30 || p[2] > 35).length;
  expect(lit / pts.length).toBeGreaterThan(0.25);

  test.info().annotations.push({
    type: 'bench',
    description: JSON.stringify({ mesh: 'ernie.msh', ...info, ops: undefined }),
  });
  console.log(
    `[bench] ernie.msh load-to-first-frame ${info.loadToFirstFrameMs.toFixed(1)} ms; ` +
      `orbit median ${info.orbitMedianMs.toFixed(2)} ms, p95 ${info.orbitP95Ms.toFixed(2)} ms (DPR 1)`
  );

  await expectGolden(page, 'gate2-ernie-tag-surfaces');
});

// -------------------------------------------------------------------------------------------
// Gate 3 — T1 in the three canonical views + 3D, with letters, corner info and the badge
// -------------------------------------------------------------------------------------------

test('gate 3: T1.nii.gz in axial, coronal, sagittal and 3D, with the full 2D chrome', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openScene(page);

  const info = await page.evaluate(async (url) => {
    const engine = window.__tvxEngine!;
    const t0 = performance.now();
    const ds = await engine.addDataset({ kind: 'path', path: url });
    engine.addLayer({ datasetId: ds.id, kind: 'volume' });
    engine.setLayout({
      kind: '2x2',
      cells: ['axial', 'coronal', 'sagittal', 'view3d'],
    });
    await engine.whenSettled();
    const loadToFirstFrameMs = performance.now() - t0;
    return {
      dims: 'dims' in ds ? ds.dims : null,
      dtype: 'dtype' in ds ? ds.dtype : null,
      format: 'gpu' in ds ? ds.gpu.format : null,
      statsMax: 'stats' in ds ? ds.stats.max : null,
      radiological: engine.scene.radiological,
      annotations: engine.scene.annotations,
      loadToFirstFrameMs,
      errors: window.__tvxErrors ?? [],
      heapBytes: engine.heapBytes(ds.id),
    };
  }, fsUrl(T1));

  expect(pageErrors(page)).toEqual([]);
  expect(info.errors).toEqual([]);
  expect(info.dims).toEqual([256, 256, 208]);
  // AGENTS.md's two traps: T1 is float32, and its max is exactly 65535.
  expect(info.dtype).toBe('f32');
  expect(info.statsMax).toBe(65535);
  // The golden authority has no EXT_texture_norm16, so §6.1 row 8 falls through to row 9.
  expect(info.format).toBe('R32F');
  // §8: the badge is not optional.
  expect(info.annotations.conventionBadge).toBe(true);
  expect(info.annotations.orientationLabels).toBe(true);
  expect(info.annotations.cornerInfo).toBe(true);

  console.log(
    `[bench] T1.nii.gz load-to-first-frame ${info.loadToFirstFrameMs.toFixed(1)} ms (DPR 1)`
  );

  await expectGolden(page, 'gate3-t1-2x2-chrome');

  // ---------------------------------------------------------------------------------------
  // …and now read the chrome back out of the framebuffer, because the golden cannot police it:
  // the corner block is ~300 px of a 589,824 px pane, so a wrong slice number is 0.05 % of the
  // image and sails through `maxDiffPixelRatio: 0.002`. Phase 1 shipped exactly that.
  //
  // The crosshair is turned off first: it is drawn *through* the vertically centred edge letters,
  // and one overwritten row out of seven is enough to make a template match ambiguous. Nothing
  // else about the chrome changes.
  await page.evaluate(async () => {
    const engine = window.__tvxEngine!;
    engine.setAnnotations({ crosshair: false });
    await engine.whenSettled();
  });

  // `PANE` is the whole canvas; a 2x2 pane is half of it in each axis.
  const CANVAS = PANE;
  const HALF = PANE / 2;
  // §7.5's 2x2: cells in order top-left, top-right, bottom-left, bottom-right, bottom-left origin.
  const panes = {
    axial: { x: 0, y: HALF, width: HALF, height: HALF },
    coronal: { x: HALF, y: HALF, width: HALF, height: HALF },
    sagittal: { x: 0, y: 0, width: HALF, height: HALF },
    view3d: { x: HALF, y: 0, width: HALF, height: HALF },
  } as const;

  // The cursor is the scene bbox centre, and `T1.nii.gz`'s affine (AGENTS.md) is
  // world x <- k - 99.737457, y <- -i + 154.1875, z <- j - 143.642273 over 256x256x208 voxels — so
  // the centre is world (3.76, 26.69, -16.14) = voxel (127.5, 127.5, 103.5). The slice index of a
  // pane is the cursor's index along the voxel axis THAT PLANE STEPS ALONG: `j` for axial, `i` for
  // coronal, `k` for sagittal. Phase 1 hardcoded voxel[2]/voxel[1]/voxel[0] and reported 104/128/128.
  const RAS = 'RAS 3.8 26.7 -16.1';
  const expected = {
    axial: { name: 'AXIAL', slice: 128, letters: { left: 'L', right: 'R', top: 'A', bottom: 'P' } },
    coronal: {
      name: 'CORONAL',
      slice: 128,
      letters: { left: 'L', right: 'R', top: 'S', bottom: 'I' },
    },
    sagittal: {
      name: 'SAGITTAL',
      slice: 104,
      letters: { left: 'A', right: 'P', top: 'S', bottom: 'I' },
    },
  } as const;

  for (const [id, want] of Object.entries(expected)) {
    const pane = panes[id as keyof typeof expected];
    const opts = { canvasHeight: CANVAS, pane };
    const lines = await readCornerInfo(page, {
      ...opts,
      lineCount: 3,
      length: Math.max(want.name.length, RAS.length, `SLICE ${want.slice}`.length),
    });
    expect(lines[0]?.trim(), `${id}: corner line 1 is the view name`).toBe(want.name);
    expect(lines[1]?.trim(), `${id}: corner line 2 is the world RAS of the plane`).toBe(RAS);
    expect(lines[2]?.trim(), `${id}: corner line 3 is the slice index of the active volume`).toBe(
      `SLICE ${want.slice}`
    );
    expect(await readEdgeLetters(page, opts), `${id}: edge letters`).toEqual(want.letters);
    expect(await readBadge(page, opts), `${id}: the convention badge`).toBe('NEU');
  }
  // The 3D pane carries chrome too (§8): a name, letters from the camera basis, and the badge.
  expect(await readBadge(page, { canvasHeight: CANVAS, pane: panes.view3d })).toBe('NEU');
});

test('gate 3: the RAD/NEU badge and the edge letters follow the radiological flag', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openScene(page);
  await page.evaluate(async (url) => {
    const engine = window.__tvxEngine!;
    const ds = await engine.addDataset({ kind: 'path', path: url });
    engine.addLayer({ datasetId: ds.id, kind: 'volume' });
    engine.setLayout({ kind: '1x1', cells: ['axial'] });
    engine.setRadiological(true);
    await engine.whenSettled();
  }, fsUrl(T1));
  expect(pageErrors(page)).toEqual([]);
  await expectGolden(page, 'gate3-t1-axial-radiological');
});

// -------------------------------------------------------------------------------------------
// Gate 4 — the Phase-1 oblique golden
// -------------------------------------------------------------------------------------------

test('gate 4: the oblique golden — normal = normalize([1,1,1]), T1 alone', async ({ page }) => {
  test.setTimeout(120_000);
  await openScene(page);
  const n = 1 / Math.sqrt(3);
  await page.evaluate(
    async ([url, k]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({ kind: 'path', path: url as string });
      engine.addLayer({ datasetId: ds.id, kind: 'volume' });
      // §4.5: the plane is DERIVED from the cursor and the view basis, never stored — so making a
      // view oblique is exactly setting its normal.
      engine.setView('axial', {
        mode: 'oblique',
        normal: [k as number, k as number, k as number],
        up: [0, 0, 1],
      });
      engine.setLayout({ kind: '1x1', cells: ['axial'] });
      await engine.whenSettled();
    },
    [fsUrl(T1), n] as const
  );
  expect(pageErrors(page)).toEqual([]);

  const mode = await page.evaluate(() => window.__tvxEngine!.scene.slices[0]?.mode);
  expect(mode).toBe('oblique');
  await expectGolden(page, 'gate4-t1-oblique');
});

// -------------------------------------------------------------------------------------------
// Gate 5 — the pick golden and the Phase-1 overlay-compositing golden
// -------------------------------------------------------------------------------------------

test('gate 5: two volume layers composite on an oblique 2D view at an exact-100% footprint', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openScene(page);
  const n = 1 / Math.sqrt(3);

  // §11 names `Thalamus_TI_subject_TI_max.nii.gz` over `T1.nii.gz`. It is a **continuous scalar**
  // field (0 … 3.152 `[DATA]`), so it takes the colormap-and-blend path of §7.3 — which is the path
  // this row is about. Phase 1 substituted `segmentation/labeling.nii.gz`, an R8UI + palette label
  // volume: a different branch, and one whose opacity is decided per label rather than per layer.
  //
  // "Exactly 100 %" is asserted as **independence**, over every pixel of the pane rather than a
  // sample grid: at opacity 1 the composited image must not change when the layer underneath it
  // changes. Two independent perturbations of the base — hiding it outright, and re-windowing it —
  // must both leave the composite byte-identical, while each visibly changes the base on its own.
  // One blended pixel anywhere breaks that, and no tolerance can hide it.
  const r = await page.evaluate(
    async ([t1, ti, k, pane]) => {
      const engine = window.__tvxEngine!;
      const canvas = document.querySelector('canvas')!;
      const gl = canvas.getContext('webgl2')!;
      const P = pane as number;
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

      const base = await engine.addDataset({ kind: 'path', path: t1 as string });
      const baseLayer = engine.addLayer({ datasetId: base.id, kind: 'volume' });
      engine.setView('axial', {
        mode: 'oblique',
        normal: [k as number, k as number, k as number],
        up: [0, 0, 1],
      });
      engine.setLayout({ kind: '1x1', cells: ['axial'] });
      engine.setAnnotations({
        crosshair: false,
        orientationLabels: false,
        cornerInfo: false,
      });
      await engine.whenSettled();
      const baseOnly = grab();

      // Control 1: a different window on the base visibly changes the base.
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

      // The overlay, at opacity 1.
      const over = await engine.addDataset({ kind: 'path', path: ti as string });
      const overLayer = engine.addLayer({ datasetId: over.id, kind: 'volume' });
      engine.updateLayer(overLayer.id, { opacity: 1 });
      await engine.whenSettled();
      const composited = grab();

      engine.updateLayer(baseLayer.id, { scale: scale1 });
      await engine.whenSettled();
      const compositedRewindowed = grab();
      engine.updateLayer(baseLayer.id, { scale: scale0, visible: false });
      await engine.whenSettled();
      const compositedNoBase = grab();
      engine.updateLayer(baseLayer.id, { visible: true });
      await engine.whenSettled();

      // The overlay's footprint: pixels the composite paints over the scene background.
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
        layers: engine.scene.layers.length,
        overIsLabel: 'isLabel' in over ? over.isLabel : null,
        overFormat: 'gpu' in over ? over.gpu.format : null,
        overMax: 'stats' in over ? over.stats.max : null,
        overDims: 'dims' in over ? over.dims : null,
        baseDims: 'dims' in base ? base.dims : null,
        errors: window.__tvxErrors ?? [],
      };
    },
    [fsUrl(T1), fsUrl(THALAMUS_TI), n, PANE] as const
  );

  expect(pageErrors(page)).toEqual([]);
  expect(r.errors).toEqual([]);
  expect(r.layers).toBe(2);
  // A continuous scalar, not a label volume: the colormap path, and AGENTS.md's max for this file.
  expect(r.overIsLabel).toBe(false);
  expect(r.overFormat).toBe('R32F');
  expect(r.overMax).toBeCloseTo(3.152071, 5);
  // §11 calls these "genuinely different extents"; they are not — every volume in this dataset
  // shares the grid and the affine (see docs/DECISIONS.md, and §11's amended row).
  expect(r.overDims).toEqual(r.baseDims);

  // The controls: both perturbations really do change what is on screen…
  expect(r.controlRewindow, 're-windowing the base must visibly change it').toBeGreaterThan(
    r.pixels * 0.1
  );
  // Only ~15 %: the TI field is zero over most of the head and maps to the same near-black as the
  // T1 does there, so "changed" understates "covered". The footprint below is the coverage claim.
  expect(r.controlOverlayCovers, 'the overlay must change a real part of the view').toBeGreaterThan(
    r.pixels * 0.1
  );
  // The overlay's own footprint — the oblique plane's hexagonal section of its box, 27.6 % of the
  // pane at the engine's auto-fit zoom `[SwS]`. Every one of those pixels is covered by the
  // assertions below, which is what "within its own footprint" means here.
  expect(r.footprint, 'the oblique plane meets the volume box in a hexagon').toBeGreaterThan(
    r.pixels * 0.2
  );

  // …and yet the composite does not move by a single pixel. That is the exact-100 % footprint.
  expect(r.leakRewindow, 'a base re-window must not reach through an opaque overlay').toBe(0);
  expect(r.leakHidden, 'nor must hiding the base entirely').toBe(0);

  await expectGolden(page, 'gate5-overlay-composite-oblique');
});

test("gate 5: the pick golden — §11's four clauses on ernie.msh", async ({ page }) => {
  test.setTimeout(240_000);
  await openScene(page);

  // §11's Pick row asks for four things, and Phase 1 asserted only the last:
  //   1. the returned `world` within 1 mm of a reference point,
  //   2. cross-checked by `locate` returning a tet with tag 5 (Scalp),
  //   3. all three 2D slice indices changed as expected,
  //   4. a background click returns `null`.
  //
  // (1) has no reference point written down anywhere, so one is *constructed*: the default 3D
  // camera has identity rotation, so it sits on +Z and looks straight down −Z, and the pick at the
  // pane centre therefore lands on the top of the scalp with the outward normal along +Z. 1 mm
  // outward of a correct hit is outside the mesh (`locate` → null) and 1 mm inward is inside the
  // scalp (`locate` → tag 5). That brackets `world` to ±1 mm along the ray, which is exactly what
  // the row asks for, and it uses a second, independent code path (§6.3's `locate_point` in the
  // worker) to say so.
  const info = await page.evaluate(
    async ([mesh, opt, t1]) => {
      const engine = window.__tvxEngine!;
      const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

      const ds = await engine.addDataset({
        kind: 'path',
        path: mesh as string,
        sidecars: { opt: opt as string },
      });
      const meshLayer = engine.addLayer({ datasetId: ds.id, kind: 'mesh' });
      engine.setLayout({ kind: '3d-only', cells: ['view3d'] });
      engine.resetView('view3d');
      await engine.whenSettled();
      // The de-indexed pick geometry is built lazily in the worker on first pick (§7.4).
      engine.pick('view3d', 384, 384);
      await engine.whenSettled();

      // A volume, so the panes have a slice index at all (§8: "of the active volume layer"). It is
      // the SECOND dataset, so it does not re-fit the 3D camera the golden below was framed with.
      const vol = await engine.addDataset({ kind: 'path', path: t1 as string });
      engine.addLayer({ datasetId: vol.id, kind: 'volume' });
      await engine.whenSettled();
      const cursorBefore = [...engine.scene.cursor] as [number, number, number];

      const t0 = performance.now();
      const hit = engine.pick('view3d', 384, 384);
      const pickMs = performance.now() - t0;
      const miss = engine.pick('view3d', 4, 4);

      const moved = engine.setCursorFromPick('view3d', 384, 384);
      const cursorAfter = [...engine.scene.cursor] as [number, number, number];
      await engine.whenSettled();

      // §6.3's `locate_point`, through the async mesh-probe path §4.7's synchronous `probe` feeds
      // from: move the cursor there and wait for that layer's row to carry a tag.
      const locate = async (
        w: [number, number, number]
      ): Promise<{ tag: number; tagName?: string; elementId?: number } | null> => {
        engine.setCursor(w);
        for (let i = 0; i < 200; i += 1) {
          await sleep(5);
          const row = engine.probe(w).rows.find((r) => r.layerId === meshLayer.id);
          if (row?.tag !== undefined) {
            return { tag: row.tag, tagName: row.tagName, elementId: row.elementId };
          }
        }
        return null;
      };

      const at =
        hit === null
          ? null
          : ([hit.world[0], hit.world[1], hit.world[2]] as [number, number, number]);
      const outward = at === null ? null : ([at[0], at[1], at[2] + 1] as [number, number, number]);
      const inward = at === null ? null : ([at[0], at[1], at[2] - 1] as [number, number, number]);
      const onSurface = at === null ? null : await locate(at);
      const above = outward === null ? null : await locate(outward);
      const below = inward === null ? null : await locate(inward);

      // Back to the picked point; the layout stays `3d-only` so the golden below is the same frame
      // Phase 1 captured.
      if (at !== null) engine.setCursor(at);
      await engine.whenSettled();

      return {
        hit,
        miss,
        moved,
        cursorBefore,
        cursorAfter,
        onSurface,
        above,
        below,
        pickMs,
        nTris: 'nTris' in ds ? ds.nTris : 0,
        tags: 'tags' in ds ? ds.tags.map((t) => ({ id: t.id, name: t.name, kind: t.kind })) : [],
        ops: window.__tvxOps ?? [],
        errors: window.__tvxErrors ?? [],
      };
    },
    [fsUrl(ERNIE), fsUrl(ERNIE_OPT), fsUrl(T1)] as const
  );

  expect(pageErrors(page)).toEqual([]);
  expect(info.errors).toEqual([]);

  // (4) and the shape of the hit.
  expect(info.hit, 'the centre of a fitted head view must hit the mesh').not.toBeNull();
  expect(info.hit!.elementKind).toBe('tri');
  // §7.2.3: the payload's element field is a **Gmsh element number**, and Gmsh numbers a mesh's
  // tris and tets in one sequence — so a triangle's number is within the tri block.
  expect(info.hit!.elementId).toBeGreaterThanOrEqual(1);
  expect(info.hit!.elementId).toBeLessThanOrEqual(info.nTris);
  expect(info.hit!.datasetId).toBeTruthy();
  // A corner of the pane is background: 0 means miss, hence the zero clear.
  expect(info.miss).toBeNull();

  // (2) `locate` agrees, and says the tissue under the cursor is scalp — tag 5 in AGENTS.md's
  // census, named from `ernie.msh.opt` because the file has no $PhysicalNames. The cross-check is
  // made 1 mm *inside* the surface rather than on it: `locate_point` looks for a tet that contains
  // the point, and a point exactly on a boundary face is a coin toss in floating point. That is
  // also what makes it half of the ±1 mm bracket below rather than a separate assertion.
  expect(info.below, '1 mm inward of the scalp must be inside the mesh').not.toBeNull();
  expect(info.below!.tag, 'the top of a fitted head is scalp').toBe(5);
  expect(info.below!.tagName).toBe('Scalp');
  expect(info.tags.find((t) => t.id === 5 && t.kind === 'tet')?.name).toBe('Scalp');

  // (1) …and the hit is on that surface to within 1 mm along the view ray: 1 mm outward is outside
  // the mesh entirely. `onSurface` is reported for the record, not asserted, for the reason above.
  expect(info.above, '1 mm outward of the scalp is outside the mesh').toBeNull();
  console.log(
    `[pick] world ${info.hit!.world.map((v) => v.toFixed(3)).join(' ')}; ` +
      `locate on the surface ${info.onSurface === null ? 'null' : `tag ${info.onSurface.tag}`}, ` +
      `1 mm in tag ${info.below!.tag}, 1 mm out ${info.above === null ? 'null' : 'a tet'}`
  );

  // `setCursorFromPick` is the API §8 binds to a double-click, and it must land on the same point.
  expect(info.moved).toBe(true);
  expect(info.cursorAfter).toEqual([info.hit!.world[0], info.hit!.world[1], info.hit!.world[2]]);
  expect(info.cursorAfter, 'the pick must actually move the cursor').not.toEqual(info.cursorBefore);

  // The pick needs the de-indexed variant, which is a *second* surface op (§7.4), and still no
  // topology build.
  expect(info.ops).toContain('surface');
  expect(info.ops).not.toContain('buildTopology');

  // (3) All three slice indices, read off the panes themselves and checked against `T1.nii.gz`'s
  // affine (AGENTS.md): world x = k − 99.737457, y = −i + 154.1875, z = j − 143.642273, so the
  // stepping voxel index is `j` for axial, `i` for coronal and `k` for sagittal.
  const w = info.hit!.world;
  const wanted = {
    axial: Math.round(w[2] + 143.642273),
    coronal: Math.round(154.1875 - w[1]),
    sagittal: Math.round(w[0] + 99.737457),
  };
  const before = {
    axial: Math.round(info.cursorBefore[2] + 143.642273),
    coronal: Math.round(154.1875 - info.cursorBefore[1]),
    sagittal: Math.round(info.cursorBefore[0] + 99.737457),
  };
  // The golden is the 3D pane alone, framed by the mesh-only fit — the same capture as Phase 1's.
  console.log(`[bench] ernie.msh 3D pick round trip ${info.pickMs.toFixed(3)} ms`);
  await expectGolden(page, 'gate5-ernie-pick');

  // Now the 2x2, to read the slice indices off the panes themselves.
  await page.evaluate(async () => {
    const engine = window.__tvxEngine!;
    engine.setLayout({ kind: '2x2', cells: ['axial', 'coronal', 'sagittal', 'view3d'] });
    await engine.whenSettled();
  });
  const HALF = PANE / 2;
  const panes = {
    axial: { x: 0, y: HALF, width: HALF, height: HALF },
    coronal: { x: HALF, y: HALF, width: HALF, height: HALF },
    sagittal: { x: 0, y: 0, width: HALF, height: HALF },
  } as const;
  const shown: Record<string, string> = {};
  for (const [id, pane] of Object.entries(panes)) {
    const want = wanted[id as keyof typeof wanted];
    // Exactly as many cells as the string: the corner block here sits over bright anatomy, and a
    // blank cell decoded over a bright voxel is a glyph-shaped coin toss.
    const lines = await readCornerInfo(page, {
      canvasHeight: PANE,
      pane,
      lineCount: 3,
      length: `SLICE ${want}`.length,
    });
    shown[id] = lines[2]?.trim() ?? '';
  }
  // "Changed as expected", read literally: every pane shows the index the picked world point
  // implies, and the three together are not what they were. They cannot each have changed — the
  // pick is on the camera axis, which runs down −Z through the bbox centre, so the axial index is
  // the only one the ray can move; asserting three individual changes would be asserting a
  // geometry this pick does not have.
  expect(shown).toEqual({
    axial: `SLICE ${wanted.axial}`,
    coronal: `SLICE ${wanted.coronal}`,
    sagittal: `SLICE ${wanted.sagittal}`,
  });
  expect(wanted, 'the pick must move the slices').not.toEqual(before);
  expect(wanted.axial, 'and the axial one is the one the ray moves').not.toBe(before.axial);
});

// -------------------------------------------------------------------------------------------
// Gate 6 — both §6.1 ladder branches, via forceCaps, as analytic pixel tests
// -------------------------------------------------------------------------------------------

/**
 * The two branches are compared against the **CPU** value at the same world point.
 *
 * `VolumeDataset.data` is the raw on-disk array, kept on the UI thread for probes and never re-sent
 * (§4.3). It shares nothing with the GPU path but the parsed samples: the ladder's encoding, the
 * texture format, the shader's `uValueScale` and the §7.6 LUT bake are all on the GPU side only. So
 * "the pixel equals the colour the CPU value implies" is a genuine cross-check of the whole §6.1 →
 * §7.3 chain, and it is what makes the R16 branch testable on a machine whose goldens can only ever
 * be R32F.
 */
async function ladderBranch(page: Page, query: string, expectedFormat: string): Promise<void> {
  await openScene(page, query);
  const probe = await page.evaluate(
    async ([url, pane]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({ kind: 'path', path: url as string });
      const layer = engine.addLayer({ datasetId: ds.id, kind: 'volume' });
      // NEAREST on both sides: the CPU probe is nearest-voxel, so linear filtering would compare a
      // GPU interpolation against a CPU point sample and disagree by design.
      engine.updateLayer(layer.id, { interpolation: 'nearest' });
      engine.setLayout({ kind: '1x1', cells: ['axial'] });
      const b = 'bounds' in ds ? ds.bounds : { min: [0, 0, 0] as const, max: [0, 0, 0] as const };
      const mid = (k: 0 | 1 | 2): number => ((b.min[k] ?? 0) + (b.max[k] ?? 0)) / 2;
      const cursor: [number, number, number] = [mid(0), mid(1), mid(2)];
      engine.setCursor(cursor);
      const mmPerPx = 0.5;
      engine.setView('axial', { camera: { center: [0, 0], mmPerPx } });
      engine.setAnnotations({
        crosshair: false,
        orientationLabels: false,
        cornerInfo: false,
      });
      await engine.whenSettled();

      const scale =
        engine.scene.layers[0]!.kind === 'volume'
          ? (engine.scene.layers[0] as { scale: { kind: string; lo: number; hi: number } }).scale
          : null;
      const P = pane as number;
      const samples: { x: number; y: number; value: number }[] = [];
      for (const [x, y] of [
        [200, 200],
        [300, 260],
        [384, 300],
        [440, 400],
        [500, 500],
        [280, 520],
      ] as [number, number][]) {
        const glY = P - 1 - y;
        const world: [number, number, number] = [
          cursor[0] + (x + 0.5 - P / 2) * mmPerPx,
          cursor[1] + (glY + 0.5 - P / 2) * mmPerPx,
          cursor[2],
        ];
        const row = engine.probe(world).rows[0];
        samples.push({ x, y, value: typeof row?.value === 'number' ? row.value : Number.NaN });
      }
      return {
        format: 'gpu' in ds ? ds.gpu.format : null,
        caps: { norm16: engine.caps.norm16, floatLinear: engine.caps.floatLinear },
        scale,
        samples,
        errors: window.__tvxErrors ?? [],
      };
    },
    [fsUrl(T1), PANE] as const
  );

  expect(pageErrors(page)).toEqual([]);
  expect(probe.errors).toEqual([]);
  expect(probe.format).toBe(expectedFormat);
  expect(probe.scale).not.toBeNull();

  const px = await readCanvasPixels(
    page,
    probe.samples.map((s) => [s.x, s.y] as const)
  );
  const { lo, hi } = probe.scale as { lo: number; hi: number };

  probe.samples.forEach((s, i) => {
    // The §7.6 bake: `gray` is LUT[i] = (i, i, i), and a 256-wide NEAREST LUT selects
    // floor(clamp(t, 0, 1) * 256), capped at 255.
    const t = Math.min(1, Math.max(0, (s.value - lo) / (hi - lo)));
    const want = Math.min(255, Math.floor(t * 256));
    const got = px[i]![0];
    expect(
      Math.abs(got - want),
      `${expectedFormat} at pixel (${s.x},${s.y}): CPU value ${s.value.toFixed(3)} implies grey ${want}, got ${got}`
    ).toBeLessThanOrEqual(3);
  });
}

test('@angle gate 6: the R32F branch of the §6.1 ladder (forceCaps norm16:false)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await ladderBranch(page, '?norm16=0', 'R32F');
});

test('@angle gate 6: the R16 branch of the §6.1 ladder, when the renderer has EXT_texture_norm16', async ({
  page,
}) => {
  test.setTimeout(120_000);
  // On the golden authority (SwiftShader) `norm16` is false, so this branch is unreachable and the
  // test says so rather than silently asserting the other one. On ANGLE/Metal it is the real path.
  await openScene(page);
  const norm16 = await page.evaluate(() => window.__tvxEngine!.caps.norm16);
  test.skip(
    !norm16,
    'this renderer has no EXT_texture_norm16 (§7.1 [SwS]) — R16 is unreachable here'
  );
  await ladderBranch(page, '', 'R16');
});
