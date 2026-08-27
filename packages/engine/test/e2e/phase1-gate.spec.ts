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

const ROOT = process.env.TETRAVOX_TESTDATA ?? '';
const fsUrl = (rel: string): string => `/@fs${ROOT}/${rel}`;

const T1 = 'm2m_ernie/T1.nii.gz';
const LABELING = 'm2m_ernie/segmentation/labeling.nii.gz';
const LABELING_LUT = 'm2m_ernie/segmentation/labeling_LUT.txt';
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
      (engine as unknown as { resetView(v: string): void }).resetView('view3d');
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
        (engine as unknown as { renderNow(): void }).renderNow();
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
      heapBytes: (engine as unknown as { heapBytes(id: string): number | undefined }).heapBytes(
        ds.id
      ),
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

  // The sample grid is fixed so the two captures below compare the same pixels.
  const pts: [number, number][] = [];
  for (let y = 40; y < PANE; y += 19) for (let x = 40; x < PANE; x += 19) pts.push([x, y]);

  // Capture 1: the base layer alone.
  await page.evaluate(
    async ([t1, k]) => {
      const engine = window.__tvxEngine!;
      const base = await engine.addDataset({ kind: 'path', path: t1 as string });
      engine.addLayer({ datasetId: base.id, kind: 'volume' });
      engine.setView('axial', {
        mode: 'oblique',
        normal: [k as number, k as number, k as number],
        up: [0, 0, 1],
      });
      engine.setLayout({ kind: '1x1', cells: ['axial'] });
      (engine as unknown as { setAnnotations(p: object): void }).setAnnotations({
        crosshair: false,
        orientationLabels: false,
        cornerInfo: false,
      });
      await engine.whenSettled();
    },
    [fsUrl(T1), n] as const
  );
  const baseOnly = await readCanvasPixels(page, pts);

  // Capture 2: the atlas composited on top at opacity 1.
  const info = await page.evaluate(
    async ([atlas, lut]) => {
      const engine = window.__tvxEngine!;
      const over = await engine.addDataset({
        kind: 'path',
        path: atlas as string,
        sidecars: { lut: lut as string },
      });
      const overLayer = engine.addLayer({ datasetId: over.id, kind: 'volume' });
      engine.updateLayer(overLayer.id, { opacity: 1 });
      await engine.whenSettled();
      return {
        layers: engine.scene.layers.length,
        overIsLabel: 'isLabel' in over ? over.isLabel : null,
        overFormat: 'gpu' in over ? over.gpu.format : null,
        table: 'labelTable' in over ? (over.labelTable?.entries.length ?? 0) : 0,
        colors:
          'labelTable' in over && over.labelTable !== undefined
            ? over.labelTable.entries.map((e) => ({
                id: e.id,
                rgb: [
                  Math.round(e.color[0] * 255),
                  Math.round(e.color[1] * 255),
                  Math.round(e.color[2] * 255),
                ],
                a: Math.round(e.color[3] * 255),
              }))
            : [],
        errors: window.__tvxErrors ?? [],
      };
    },
    [fsUrl(LABELING), fsUrl(LABELING_LUT)] as const
  );
  const composited = await readCanvasPixels(page, pts);

  expect(pageErrors(page)).toEqual([]);
  expect(info.errors).toEqual([]);
  expect(info.layers).toBe(2);
  // AGENTS.md's third trap: labeling.nii.gz is a **float32** label volume with 57 integral values.
  // An is_label heuristic that requires an integer dtype misclassifies the atlas the app browses.
  expect(info.overIsLabel).toBe(true);
  expect(info.overFormat).toBe('R8UI');
  expect(info.table).toBeGreaterThan(0);

  // **Exact-100% footprint.** At opacity 1 the top layer wins outright: every pixel it covers must
  // be *exactly* one of its LUT colours, with none of the base blended in. Every pixel it does not
  // cover must be byte-identical to the base-only capture — which is what proves the composite adds
  // nothing where the overlay is transparent, rather than dimming the base.
  const opaque = new Map(
    info.colors.filter((c) => c.a > 0).map((c) => [`${c.rgb[0]},${c.rgb[1]},${c.rgb[2]}`, c.id])
  );
  let covered = 0;
  let untouched = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const before = baseOnly[i]!;
    const after = composited[i]!;
    const key = `${after[0]},${after[1]},${after[2]}`;
    const same = before[0] === after[0] && before[1] === after[1] && before[2] === after[2];
    if (same) {
      untouched += 1;
      continue;
    }
    covered += 1;
    expect(
      opaque.has(key),
      `pixel ${JSON.stringify(pts[i])} changed to ${key}, which is not one of the atlas LUT colours ` +
        '(a blended value would mean the overlay is not at a 100% footprint)'
    ).toBe(true);
  }
  expect(covered, 'the overlay must actually cover a large part of the view').toBeGreaterThan(
    pts.length * 0.2
  );
  expect(untouched, 'and must leave the rest of the base untouched').toBeGreaterThan(0);

  await expectGolden(page, 'gate5-overlay-composite-oblique');
});

test('gate 5: the pick golden — a 3D pick on ernie.msh returns a real Gmsh element', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openScene(page);

  const info = await page.evaluate(
    async ([url, opt]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({
        kind: 'path',
        path: url as string,
        sidecars: { opt: opt as string },
      });
      engine.addLayer({ datasetId: ds.id, kind: 'mesh' });
      engine.setLayout({ kind: '3d-only', cells: ['view3d'] });
      (engine as unknown as { resetView(v: string): void }).resetView('view3d');
      await engine.whenSettled();
      // The de-indexed pick geometry is built lazily in the worker on first pick (§7.4), so the
      // first call primes it and the second is the measurement.
      engine.pick('view3d', 384, 384);
      await engine.whenSettled();
      const t0 = performance.now();
      const hit = engine.pick('view3d', 384, 384);
      const pickMs = performance.now() - t0;
      const miss = engine.pick('view3d', 4, 4);
      await engine.whenSettled();
      return {
        hit,
        miss,
        pickMs,
        nTris: 'nTris' in ds ? ds.nTris : 0,
        nTets: 'nTets' in ds ? ds.nTets : 0,
        ops: window.__tvxOps ?? [],
        errors: window.__tvxErrors ?? [],
      };
    },
    [fsUrl(ERNIE), fsUrl(ERNIE_OPT)] as const
  );

  expect(pageErrors(page)).toEqual([]);
  expect(info.errors).toEqual([]);
  expect(info.hit, 'the centre of a fitted head view must hit the mesh').not.toBeNull();
  expect(info.hit!.elementKind).toBe('tri');
  // §7.2.3: the payload's element field is a **Gmsh element number**, and Gmsh numbers a mesh's
  // tris and tets in one sequence — so a triangle's number is within the tri block.
  expect(info.hit!.elementId).toBeGreaterThanOrEqual(1);
  expect(info.hit!.elementId).toBeLessThanOrEqual(info.nTris);
  expect(info.hit!.datasetId).toBeTruthy();
  // A corner of the pane is background: 0 means miss, hence the zero clear.
  expect(info.miss).toBeNull();
  // The pick needs the de-indexed variant, which is a *second* surface op (§7.4), and still no
  // topology build.
  expect(info.ops).toContain('surface');
  expect(info.ops).not.toContain('buildTopology');

  console.log(`[bench] ernie.msh 3D pick round trip ${info.pickMs.toFixed(3)} ms`);
  await expectGolden(page, 'gate5-ernie-pick');
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
      (engine as unknown as { setAnnotations(p: object): void }).setAnnotations({
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

test('gate 6: the R32F branch of the §6.1 ladder (forceCaps norm16:false)', async ({ page }) => {
  test.setTimeout(120_000);
  await ladderBranch(page, '?norm16=0', 'R32F');
});

test('gate 6: the R16 branch of the §6.1 ladder, when the renderer has EXT_texture_norm16', async ({
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
