/**
 * **R4 — mesh cross-sections in the 2D panes, sweepable like a NIfTI** — on the reference dataset.
 *
 * `docs/requirements/2026-08-27-maintainer.md`, verbatim, is what this file asserts:
 *
 * > `ernie.msh` alone → three panes show tissue cross-sections with the `.msh.opt` colours,
 * > scalp/skull/CSF/GM/WM pixels at known RAS points equal their tag colours; `Thalamus_TI.msh` with
 * > `TI_max` element colouring on the cut (a pixel at the thalamus target maps to the colormap value
 * > of that element's `TI_max`, cross-checked through `locate`); a 20-step sweep of the axial pane
 * > completes at ≥ 30 fps end-to-end (cut round trip + upload + render), measured; golden of the 2×2
 * > layout with mesh-only and with T1 + mesh.
 *
 * Skips, never fails, when `TETRAVOX_TESTDATA` is unset (AGENTS rule 2).
 *
 * **Every expected colour is derived twice, from two code paths that share only the parsed mesh.**
 * The tissue under a RAS point comes from §6.3's `locate_point` in the worker — the same
 * cross-check Phase 1's pick gate used — and the colour that tag should paint comes from
 * `MeshMeta.tags[].color`, the `.msh.opt` carousel value §4.1 requires to round-trip exactly. The
 * rendered pixel is then compared against the two together. Neither half is a previous run.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expectGolden, readCanvasPixels } from '../helpers/pixels';

const ROOT = process.env.TETRAVOX_TESTDATA ?? '';
const fsUrl = (rel: string): string => `/@fs${ROOT}/${rel}`;

const ERNIE = 'm2m_ernie/ernie.msh';
const ERNIE_OPT = 'm2m_ernie/ernie.msh.opt';
const THALAMUS = 'Simulations/Thalamus/TI/mesh/Thalamus_TI.msh';
const THALAMUS_OPT = 'Simulations/Thalamus/TI/mesh/Thalamus_TI.msh.opt';
const T1 = 'm2m_ernie/T1.nii.gz';

/** `test/pages/scene.html`'s canvas. */
const CANVAS = 768;

/**
 * The pane pixel whose **centre** sees a world offset of `dx` mm right / `dy` mm up from the anchor.
 *
 * A fragment samples at the pixel *centre*, so pixel `i` covers the world interval
 * `[anchor + (i − N/2)·mm, anchor + (i + 1 − N/2)·mm]` and shows the value at its midpoint
 * `anchor + (i + 0.5 − N/2)·mm`. Inverting that gives `i = N/2 + d/mm − 0.5`; dropping the −0.5
 * asks about a point half a pixel — 0.25 mm at this zoom — away from the one the pixel actually
 * shows, which is enough to land in a neighbouring tet at a tissue boundary. Measured on
 * `Thalamus_TI.msh`'s `TI_max` cut at ten targets: without the −0.5 the grey deltas are
 * 2, 2, 0, 0, 0, 4, 1, 6, 3, 0 — three of them outside this file's own ±2 window, and the assertion
 * below passing with zero margin — and with it all ten are 0.
 */
function paneCentrePixel(dx: number, dy: number, mmPerPx: number): [number, number] {
  return [Math.round(CANVAS / 2 + dx / mmPerPx - 0.5), Math.round(CANVAS / 2 - dy / mmPerPx - 0.5)];
}

test.skip(ROOT === '', 'TETRAVOX_TESTDATA is unset');
test.describe.configure({ mode: 'serial' });

async function openScene(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/test/pages/scene.html');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);
  return errors;
}

// -------------------------------------------------------------------------------------------
// R4 (1) — `ernie.msh` ALONE: three panes of tissue cross-sections, at the `.msh.opt` colours
// -------------------------------------------------------------------------------------------

test('R4: ernie.msh with no volume shows tissue cross-sections in all three panes', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const errors = await openScene(page);

  const info = await page.evaluate(
    async ([mesh, opt]) => {
      const engine = window.__tvxEngine!;
      const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
      const ds = await engine.addDataset({
        kind: 'path',
        path: mesh as string,
        sidecars: { opt: opt as string },
      });
      const layer = engine.addLayer({ datasetId: ds.id, kind: 'mesh' });
      // **No volume.** R4's headline: "With a mesh loaded — with or without any NIfTI — every 2D
      // pane shows that mesh's cut at the pane's plane."
      engine.setLayout({ kind: '1x1', cells: ['axial'] });
      // An axial plane 20 mm above the AC-ish origin passes through scalp, skull, CSF, GM and WM.
      engine.setCursor([0, 0, 20]);
      engine.setView('axial', { camera: { center: [0, 0], mmPerPx: 0.5 } });
      engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });
      await engine.whenSettled();

      /** §6.3's `locate_point`, through the async mesh-probe path, exactly as gate 5 uses it. */
      const locate = async (w: [number, number, number]): Promise<number | null> => {
        engine.setCursor([0, 0, 20]);
        engine.probe(w);
        for (let i = 0; i < 200; i += 1) {
          await sleep(5);
          const row = engine.probe(w).rows.find((r) => r.layerId === layer.id);
          if (row?.tag !== undefined) return row.tag;
        }
        return null;
      };
      // `refreshProbe` fires from `setCursor`, so the probe point has to be the cursor.
      const locateAt = async (w: [number, number, number]): Promise<number | null> => {
        engine.setCursor(w);
        for (let i = 0; i < 200; i += 1) {
          await sleep(5);
          const row = engine.probe(w).rows.find((r) => r.layerId === layer.id);
          if (row?.tag !== undefined) return row.tag;
        }
        return null;
      };
      void locate;

      // Five RAS points on the `z = 20` plane, from the midline outwards along +Y, chosen so the
      // sample crosses all five tissues R4 names — GM, WM, CSF, compact bone, scalp — rather than
      // sitting inside one. The tissue at each is *not* assumed: it is read back from `locate`, and
      // the assertion below is that the **rendered pixel** agrees with it. The outward ladder that
      // picked these is in the commit that added them; y ≤ 88 never leaves the brain and its shells,
      // which is why the first draft of this list saw no scalp at all.
      const samples: [number, number, number][] = [
        [0, 8, 20],
        [0, 52, 20],
        [0, 80, 20],
        [0, 100, 20],
        [0, 112, 20],
      ];
      const tags: (number | null)[] = [];
      for (const s of samples) tags.push(await locateAt(s));

      // Back to the plane's own cursor, and settle the cut for it.
      engine.setCursor([0, 0, 20]);
      await engine.whenSettled();

      // R4's "default when a mesh is opened: fill **and** contours on", read off the layer before
      // anything patches it — the state assertion the pixel assertion below cannot make, because
      // this is where the two features are told apart.
      const created = engine.scene.layers.find((l) => l.id === layer.id) as unknown as {
        fillIn2D: boolean;
        contoursIn2D: boolean;
      };
      const defaults = { fillIn2D: created.fillIn2D, contoursIn2D: created.contoursIn2D };

      // **The fill is asserted with the contours off**, and that is the difference between a claim
      // about `fillIn2D` and a claim about whichever of the two happened to reach the pixel. A
      // contour is drawn *over* the fill at a tissue boundary (§7.2 pass order), so a probe inside a
      // thin shell can be a legitimately black contour pixel: RAS (0, 80, 20) is CSF, and the pixel
      // whose centre sees it is on the CSF/bone line. Reading it as a failure of the fill would be
      // reading the wrong feature; asserting the fill on a frame that has no contours reads the
      // right one. The goldens below keep both on, which is what pins them together.
      engine.updateLayer(layer.id, { contoursIn2D: false });
      await engine.whenSettled();

      return {
        samples,
        tags,
        defaults,
        tagColors:
          'tags' in ds ? ds.tags.map((t) => ({ id: t.id, kind: t.kind, color: t.color })) : [],
        tagNames: 'tags' in ds ? ds.tags.map((t) => ({ id: t.id, name: t.name })) : [],
        nTets: 'nTets' in ds ? ds.nTets : 0,
        ops: window.__tvxOps ?? [],
        engineErrors: window.__tvxErrors ?? [],
        mmPerPx: 0.5,
        cursor: [0, 0, 20] as [number, number, number],
        // §4.5 / R3: a 2D pane's in-plane origin is the **scene bounds centre**, not the cursor's
        // projection. ernie's bbox is not centred on the origin (y spans −92.4 … 136.2), so a
        // pixel computed from the cursor is ~44 px out at 0.5 mm/px — enough to read CSF where the
        // probe says GM. Read the bounds rather than assume either.
        bounds: ds.bounds,
      };
    },
    [fsUrl(ERNIE), fsUrl(ERNIE_OPT)] as const
  );

  expect(errors).toEqual([]);
  expect(info.engineErrors).toEqual([]);
  expect(info.nTets).toBe(4_722_625);
  // The 2D cut is served by the `cut` op — no topology build, as in every other ernie path (§6.3).
  expect(info.ops).toContain('cut');
  expect(info.ops).not.toContain('buildTopology');
  // R4: "Default when a mesh is opened: fill **and** contours on."
  expect(info.defaults).toEqual({ fillIn2D: true, contoursIn2D: true });

  // Axial basis (§3): normal +Z, up +Y, right = cross(up, normal) = +X. §4.5's anchor — the scene
  // bounds centre — projects to the pane centre at `camera.center = [0, 0]`, so a world point on
  // the plane is at (cx + Δx/mm, cy − Δy/mm) measured **from the anchor**.
  const anchor = [
    (info.bounds.min[0]! + info.bounds.max[0]!) / 2,
    (info.bounds.min[1]! + info.bounds.max[1]!) / 2,
  ];
  const toPixel = (w: readonly number[]): [number, number] =>
    paneCentrePixel(w[0]! - anchor[0]!, w[1]! - anchor[1]!, info.mmPerPx);
  const colorOf = (tag: number): [number, number, number, number] => {
    const t = info.tagColors.find((c) => c.id === tag && c.kind === 'tet');
    if (t === undefined) throw new Error(`no tet tag ${tag} in the mesh`);
    return [
      Math.round(t.color[0] * 255),
      Math.round(t.color[1] * 255),
      Math.round(t.color[2] * 255),
      Math.round(t.color[3] * 255),
    ];
  };

  const named = new Map(info.tagNames.map((t) => [t.id, t.name]));
  const seen = new Set<number>();
  for (const [i, s] of info.samples.entries()) {
    const tag = info.tags[i];
    expect(tag, `locate must find a tet at RAS ${s.join(' ')}`).not.toBeNull();
    seen.add(tag!);
    const [x, y] = toPixel(s);
    const [px] = await readCanvasPixels(page, [[x, y]]);
    expect(
      px,
      `RAS ${s.join(' ')} is tag ${tag} (${named.get(tag!) ?? '?'}), so the pixel is its colour`
    ).toEqual(colorOf(tag!));
  }

  // "Tissue cross-sections", not one blob: the five points must land in at least three tissues, and
  // scalp (tag 5) must be one of them — the outermost shell is what makes a cut read as a head.
  expect(seen.size, `tags seen: ${[...seen].join(', ')}`).toBeGreaterThanOrEqual(3);
  expect([...seen], 'the outermost sample is scalp').toContain(5);
  console.log(
    `[R4] ernie.msh alone, axial z=20: ${info.samples
      .map((s, i) => `${s.join(',')} -> tag ${info.tags[i]} ${named.get(info.tags[i]!) ?? ''}`)
      .join(' | ')}`
  );
});

// -------------------------------------------------------------------------------------------
// R4 (2) — `Thalamus_TI.msh` with `TI_max` on the cut, cross-checked through `locate`
// -------------------------------------------------------------------------------------------

test('R4: TI_max colours the cut, and the pixel is the colormap value `locate` implies', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const errors = await openScene(page);

  const info = await page.evaluate(
    async ([mesh, opt]) => {
      const engine = window.__tvxEngine!;
      const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
      const ds = await engine.addDataset({
        kind: 'path',
        path: mesh as string,
        sidecars: { opt: opt as string },
      });
      const layer = engine.addLayer({ datasetId: ds.id, kind: 'mesh' });
      // A **grey** colormap on a linear scale, so the expected colour is arithmetic rather than a
      // table lookup: `bakeScale('gray')` writes texel `i` = `(i, i, i)`, and the shader samples it
      // NEAREST at `t`, giving `clamp(floor(t · 256), 0, 255)` in all three channels.
      const lo = 0;
      const hi = 0.6;
      engine.updateLayer(layer.id, {
        colorMode: 'field',
        field: { source: 'elm', name: 'TI_max', component: 'mag' },
        colormap: 'gray',
        scale: { kind: 'linear', lo, hi },
        // Contours off: the assertion is about the fill, and a boundary line through the sample
        // point would be a different colour for a correct reason.
        contoursIn2D: false,
      });
      engine.setLayout({ kind: '1x1', cells: ['axial'] });
      engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });

      // The thalamus target: the simulation this mesh comes from is `Simulations/Thalamus`, and the
      // point below is inside the left thalamus in this subject's space. What matters for the
      // assertion is only that `locate` finds a tet there and reports its `TI_max`.
      const nominal: [number, number, number] = [-11, -19, 9];
      const mmPerPx = 0.5;
      const ax = (ds.bounds.min[0]! + ds.bounds.max[0]!) / 2;
      const ay = (ds.bounds.min[1]! + ds.bounds.max[1]!) / 2;
      // **`locate` is asked about the point the pixel actually shows, not about the point the pixel
      // was chosen for.** Rounding to a pixel index leaves up to half a pixel — 0.25 mm here — of
      // in-plane offset, and ernie's tets are 1–2 mm, so the residual is enough to straddle a tet
      // face: with the nominal target the drawn grey was 38 against a `locate` answer of 40, which
      // is this assertion's whole ±2 window spent on an avoidable disagreement about *which
      // element* rather than on the f32 rounding it was written for. Snapping the query to the
      // pixel's own centre makes the two speak about the same tet by construction. The `z` is
      // untouched, so the cut plane is still the one `nominal` names.
      const tx = Math.round(768 / 2 + (nominal[0] - ax) / mmPerPx - 0.5);
      const ty = Math.round(768 / 2 - (nominal[1] - ay) / mmPerPx - 0.5);
      const target: [number, number, number] = [
        ax + (tx + 0.5 - 768 / 2) * mmPerPx,
        ay + (768 / 2 - ty - 0.5) * mmPerPx,
        nominal[2],
      ];
      engine.setCursor(target);
      engine.setView('axial', { camera: { center: [0, 0], mmPerPx } });
      await engine.whenSettled();

      let hit: { tag?: number; elementId?: number; tiMax?: number } | null = null;
      for (let i = 0; i < 400; i += 1) {
        await sleep(5);
        const row = engine.probe(target).rows.find((r) => r.layerId === layer.id);
        if (row?.tag !== undefined) {
          const f = row.fields?.find((x) => x.name === 'TI_max');
          hit = {
            tag: row.tag,
            elementId: row.elementId,
            tiMax: typeof f?.value === 'number' ? f.value : undefined,
          };
          break;
        }
      }
      await engine.whenSettled();
      return {
        nominal,
        pixel: [tx, ty] as [number, number],
        target,
        hit,
        lo,
        hi,
        fields: 'fields' in ds ? ds.fields.map((f) => ({ name: f.name, source: f.source })) : [],
        engineErrors: window.__tvxErrors ?? [],
        mmPerPx: 0.5,
        // §4.5 / R3 again: the pane's in-plane origin is the bounds centre, not the cursor.
        bounds: ds.bounds,
      };
    },
    [fsUrl(THALAMUS), fsUrl(THALAMUS_OPT)] as const
  );

  expect(errors).toEqual([]);
  expect(info.engineErrors).toEqual([]);
  // AGENTS.md: `Thalamus_TI.msh` carries exactly one `$ElementData` field, `TI_max`.
  expect(info.fields).toEqual([{ name: 'TI_max', source: 'elm' }]);
  expect(info.hit, 'locate must find a tet at the thalamus target').not.toBeNull();
  expect(info.hit?.tiMax, '`locate` returns the element field at the containing tet').toBeDefined();

  const t = Math.min(1, Math.max(0, (info.hit!.tiMax! - info.lo) / (info.hi - info.lo)));
  const grey = Math.min(255, Math.max(0, Math.floor(t * 256)));
  // The target is on the plane but **not** at the pane centre: §4.5's anchor is the scene bounds
  // centre, so the target's own pixel has to be computed rather than assumed — at the pixel's own
  // centre, which is what `paneCentrePixel` is for. It is recomputed here from the *nominal* target
  // and the bounds, against the index the page derived, so the convention is asserted rather than
  // trusted: if the two ever disagreed, the probe and the pixel would be about different points.
  const [tx, ty] = paneCentrePixel(
    info.nominal[0] - (info.bounds.min[0]! + info.bounds.max[0]!) / 2,
    info.nominal[1] - (info.bounds.min[1]! + info.bounds.max[1]!) / 2,
    info.mmPerPx
  );
  expect([tx, ty], 'the page and the spec agree on the pixel-centre convention').toEqual(
    info.pixel
  );
  const [px] = await readCanvasPixels(page, [[tx, ty]]);
  console.log(
    `[R4] Thalamus_TI.msh: element ${info.hit!.elementId} tag ${info.hit!.tag} ` +
      `TI_max ${info.hit!.tiMax!.toFixed(6)} -> t ${t.toFixed(4)} -> grey ${grey}; ` +
      `pixel (${tx},${ty}) ${px!.join(',')} at world ` +
      `(${info.target.map((v) => v.toFixed(3)).join(', ')})`
  );
  // ±1 is 8-bit rounding and the f32 evaluation of `t` in the shader against the exact double here;
  // nothing else can move it, because `locate` and the pixel now speak about the same world point —
  // the pixel's own centre — and a grey ramp has no interpolation between texels under NEAREST.
  for (let c = 0; c < 3; c += 1) expect(Math.abs((px![c] ?? 0) - grey)).toBeLessThanOrEqual(1);
  expect(px![3]).toBe(255);
});

// -------------------------------------------------------------------------------------------
// R4 (3) — a 20-step axial sweep at ≥ 30 fps, end to end
// -------------------------------------------------------------------------------------------

/**
 * **Tagged `@angle`, so it runs on both Playwright projects — and only the GPU leg gates on fps.**
 *
 * R4's "≥ 30 fps end to end" is a *rendering throughput* claim, and `chromium-swiftshader` is a
 * software rasteriser: measured here, one 768² pane of ernie's cut is ~326 ms and the 2×2 is ~1250 ms
 * — four panes, four times the cost — which is the rasteriser, not the cut (§9.1 row 10 puts
 * `plane_cut` on ernie at 12.9 ms in wasm and 16.9 ms round trip). Gating on SwiftShader would be
 * asserting that software rendering is fast. Same reasoning, same shape, as E-MESH's clip-plane
 * drag in `mesh-real.spec.ts`: both numbers are reported and written to
 * `docs/BENCHMARKS.md`, one section per renderer, and the bar applies to the GPU.
 */
test('@angle R4: a 20-step axial sweep of ernie.msh runs at ≥ 30 fps end to end', async ({
  page,
}, info) => {
  test.setTimeout(300_000);
  const errors = await openScene(page);

  const bench = await page.evaluate(
    async ([mesh, opt]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({
        kind: 'path',
        path: mesh as string,
        sidecars: { opt: opt as string },
      });
      engine.addLayer({ datasetId: ds.id, kind: 'mesh' });
      engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });

      /**
       * One sweep of 20 one-millimetre steps, timed **inside the page** around the whole round trip
       * — `setCursor` → `cut` in the worker → transfer → table/VBO upload → render — the way Phase-1
       * gate item 1 timed progress and cancel. `whenSettled()` is what makes each step end to end:
       * it resolves only after the pending worker request has landed and a full-quality frame has
       * been drawn (§7.2).
       */
      const sweep = async (steps: number): Promise<number[]> => {
        const per: number[] = [];
        for (let i = 0; i < steps; i += 1) {
          const t0 = performance.now();
          engine.setCursor([0, 0, 10 + i]);
          await engine.whenSettled();
          per.push(performance.now() - t0);
        }
        return per;
      };

      // One pane first — R4's own wording, "a 20-step sweep of the axial pane".
      engine.setLayout({ kind: '1x1', cells: ['axial'] });
      engine.setView('axial', { camera: { center: [0, 0], mmPerPx: 0.5 } });
      engine.setCursor([0, 0, 9]);
      await engine.whenSettled();
      await sweep(3); // warm the buffers; §7.4's tables grow by doubling and never shrink
      const one = await sweep(20);

      // Then the 2x2 the user actually sits in front of: three panes, three keys, latest-wins each.
      engine.setLayout({ kind: '2x2', cells: ['axial', 'coronal', 'sagittal', 'view3d'] });
      for (const id of ['axial', 'coronal', 'sagittal']) {
        engine.setView(id, { camera: { center: [0, 0], mmPerPx: 0.5 } });
      }
      engine.resetView('view3d');
      engine.setCursor([0, 0, 9]);
      await engine.whenSettled();
      await sweep(3);
      const quad = await sweep(20);

      const sum = (a: number[]): number => a.reduce((x, y) => x + y, 0);
      const median = (a: number[]): number =>
        [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
      return {
        one: { total: sum(one), median: median(one), max: Math.max(...one) },
        quad: { total: sum(quad), median: median(quad), max: Math.max(...quad) },
        engineErrors: window.__tvxErrors ?? [],
      };
    },
    [fsUrl(ERNIE), fsUrl(ERNIE_OPT)] as const
  );

  expect(errors).toEqual([]);
  expect(bench.engineErrors).toEqual([]);
  const fps = (total: number): number => 20_000 / total;
  const oneFps = fps(bench.one.total);
  const quadFps = fps(bench.quad.total);
  console.log(
    `[R4][bench] 1x1 axial sweep: ${bench.one.total.toFixed(1)} ms / 20 steps = ` +
      `${oneFps.toFixed(1)} fps (median ${bench.one.median.toFixed(1)} ms, max ${bench.one.max.toFixed(1)} ms)`
  );
  console.log(
    `[R4][bench] 2x2 sweep: ${bench.quad.total.toFixed(1)} ms / 20 steps = ` +
      `${quadFps.toFixed(1)} fps (median ${bench.quad.median.toFixed(1)} ms, max ${bench.quad.max.toFixed(1)} ms)`
  );

  const gpuLeg = info.project.name === 'chromium-angle';
  const dir = fileURLToPath(new URL('../../../../docs/benchmarks/', import.meta.url));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    `${dir}phase2-derived-${info.project.name}.md`,
    [
      `# Phase 2 — E-DERIVED benchmarks — \`${info.project.name}\``,
      '',
      '**Measured inside the page** (`packages/engine/test/e2e/derived-r4.spec.ts`), around the whole',
      'round trip a sweep pays for: `setCursor` → the `cut` op in the dataset worker → transfer →',
      'table and VBO upload → render, with `whenSettled()` closing each step (§7.2). Not a shader',
      'timing and not a worker timing — the number R4 asks for.',
      '',
      `Machine: ${process.platform} ${process.arch}, \`${info.project.name}\`, DPR 1, 768×768.`,
      'Data: `m2m_ernie/ernie.msh` (847,165 nodes / 1,177,213 tris / 4,722,625 tets), no volume,',
      '`fillIn2D` and `contoursIn2D` both on (the R4 default), 0.5 mm/px.',
      '',
      '| Sweep | Steps | Total | Per step (median) | Worst step | End-to-end fps | Bar |',
      '|---|---|---|---|---|---|---|',
      `| \`1x1\` axial | 20 × 1 mm | ${bench.one.total.toFixed(1)} ms | ${bench.one.median.toFixed(1)} ms | ${bench.one.max.toFixed(1)} ms | **${oneFps.toFixed(1)} fps** | ≥ 30 |`,
      `| \`2x2\` (3 panes + 3D) | 20 × 1 mm | ${bench.quad.total.toFixed(1)} ms | ${bench.quad.median.toFixed(1)} ms | ${bench.quad.max.toFixed(1)} ms | **${quadFps.toFixed(1)} fps** | ≥ 30 |`,
      '',
      'Context from §9.1 row 10: `plane_cut` on ernie is **12.9 ms axial / 16.6 ms oblique in WASM**',
      'and the worker round trip for the same planes is 16.9 / 21.2 ms. A one-pane step is that round',
      'trip plus the upload and the draw, which is why the 1×1 figure sits where it does.',
      '',
      "The `2x2` row sweeps along the axial normal, so only the axial pane's plane moves: the coronal",
      'and sagittal keys re-request the identical plane and the cut source drops the repeat, which is',
      'what keeps three panes from costing three cuts per step.',
      '',
      'Row 15 of §9.1 (`T1 + Thalamus_TI.msh` `fillIn2D` + contours, 30 fps, cut latency < 25 ms)',
      'stays `[TARGET]`: this measures `ernie.msh`, which is the file R4 names.',
      '',
      gpuLeg
        ? "This is the leg R4's bar applies to."
        : 'SwiftShader is a software rasteriser; this row is recorded, not gated. See the spec header.',
      '',
    ].join('\n')
  );

  // Only the GPU leg gates. On SwiftShader the number is recorded above and the run stays green.
  test.skip(!gpuLeg, 'the ≥ 30 fps bar is a GPU claim; SwiftShader records the number instead');
  expect(oneFps, '§9.1 row 15 / R4: ≥ 30 fps end to end').toBeGreaterThanOrEqual(30);
  expect(
    quadFps,
    'the 2x2 layout sweeps at the same rate: only one plane moves'
  ).toBeGreaterThanOrEqual(30);
});

// -------------------------------------------------------------------------------------------
// R4 (4) — the two goldens, and §11's named "oblique slice + mesh contours"
// -------------------------------------------------------------------------------------------

test('R4 golden: the 2x2 layout with ernie.msh alone', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = await openScene(page);
  await page.evaluate(
    async ([mesh, opt]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({
        kind: 'path',
        path: mesh as string,
        sidecars: { opt: opt as string },
      });
      engine.addLayer({ datasetId: ds.id, kind: 'mesh' });
      engine.setLayout({ kind: '2x2', cells: ['axial', 'coronal', 'sagittal', 'view3d'] });
      engine.setCursor([0, 0, 20]);
      for (const id of ['axial', 'coronal', 'sagittal']) {
        engine.setView(id, { camera: { center: [0, 0], mmPerPx: 0.75 } });
      }
      engine.resetView('view3d');
      await engine.whenSettled();
    },
    [fsUrl(ERNIE), fsUrl(ERNIE_OPT)] as const
  );
  expect(errors).toEqual([]);
  await expectGolden(page, 'derived-r4-mesh-only');
});

test('R4 golden: the 2x2 layout with T1.nii.gz under ernie.msh', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = await openScene(page);
  await page.evaluate(
    async ([mesh, opt, t1]) => {
      const engine = window.__tvxEngine!;
      const vol = await engine.addDataset({ kind: 'path', path: t1 as string });
      engine.addLayer({ datasetId: vol.id, kind: 'volume' });
      const ds = await engine.addDataset({
        kind: 'path',
        path: mesh as string,
        sidecars: { opt: opt as string },
      });
      const layer = engine.addLayer({ datasetId: ds.id, kind: 'mesh' });
      // Half-opacity fill so the T1 underneath is visible through it — R4's "over the base volume".
      engine.updateLayer(layer.id, { opacity: 0.5 });
      engine.setLayout({ kind: '2x2', cells: ['axial', 'coronal', 'sagittal', 'view3d'] });
      engine.setCursor([0, 0, 20]);
      for (const id of ['axial', 'coronal', 'sagittal']) {
        engine.setView(id, { camera: { center: [0, 0], mmPerPx: 0.75 } });
      }
      engine.resetView('view3d');
      await engine.whenSettled();
    },
    [fsUrl(ERNIE), fsUrl(ERNIE_OPT), fsUrl(T1)] as const
  );
  expect(errors).toEqual([]);
  await expectGolden(page, 'derived-r4-t1-mesh');
});

/**
 * §11's named Phase-2 test: **Oblique slice + mesh contours** — "Phase 1's `gate4-t1-oblique` view
 * with a `MeshLayer` at `contoursIn2D: true` over it. Needs the overlay-pass instanced contour
 * renderer."
 *
 * Same view as gate 4 — `mode: 'oblique'`, `normal = normalize([1,1,1])`, `T1.nii.gz` — with the
 * mesh's contours over it and its fill off, so what the golden pins is the contour renderer and
 * nothing else.
 */
test('§11 golden: oblique slice + mesh contours', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = await openScene(page);
  await page.evaluate(
    async ([mesh, opt, t1]) => {
      const engine = window.__tvxEngine!;
      const vol = await engine.addDataset({ kind: 'path', path: t1 as string });
      engine.addLayer({ datasetId: vol.id, kind: 'volume' });
      const ds = await engine.addDataset({
        kind: 'path',
        path: mesh as string,
        sidecars: { opt: opt as string },
      });
      const layer = engine.addLayer({ datasetId: ds.id, kind: 'mesh' });
      engine.updateLayer(layer.id, {
        fillIn2D: false,
        contoursIn2D: true,
        contourWidthPx: 2,
        edgeColor: [1, 0.85, 0.2, 1],
      });
      const n = 1 / Math.sqrt(3);
      engine.setLayout({ kind: '1x1', cells: ['axial'] });
      engine.setView('axial', {
        mode: 'oblique',
        normal: [n, n, n],
        up: [0, 0, 1],
        camera: { center: [0, 0], mmPerPx: 0.35 },
      });
      engine.setCursor([0, 10, 10]);
      await engine.whenSettled();
    },
    [fsUrl(ERNIE), fsUrl(ERNIE_OPT), fsUrl(T1)] as const
  );
  expect(errors).toEqual([]);
  await expectGolden(page, 'derived-contours-oblique');
});
