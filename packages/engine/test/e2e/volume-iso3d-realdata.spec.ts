/**
 * §4.4's `VolumeLayer.iso3d` **on ernie** (directed task 2, 2026-08-28) — AGENTS rule 2's real-data
 * half. Skips, never fails, when `TETRAVOX_TESTDATA` is unset.
 *
 * The two files, and what each proves:
 *
 * * `m2m_ernie/T1.nii.gz` — the default level is the volume's **p95**, measured here as
 *   **15991.17** against a max of exactly 65535.0 and a *median of −0.78* `[DATA]`, because a head
 *   volume is mostly background: p95 is a percentile of the whole 256×256×208 grid, so it lands well
 *   up the tissue histogram rather than on the scalp rind. What that produces is a large, centred,
 *   head-shaped shell inside the volume's own bounding box, and that is what is asserted — a
 *   number, not a look. **The brief called this level "scalp-like"; on this volume it is not, and
 *   the honest test says what the level actually gives** rather than asserting a shape the data does
 *   not have. p95 stays the default because the directive fixes it and because it is the level that
 *   reliably finds *something* on an arbitrary scalar volume; a scalp preset would need the
 *   histogram's first tissue mode, which is its own change.
 * * `m2m_ernie/final_tissues.nii.gz` — 0 … 10, 10 unique `[DATA]`, with `final_tissues_LUT.txt`
 *   beside it. Each visible region becomes its own surface at `label − 0.5` **in its LUT colour**,
 *   so isolating compact bone (tag 7 in the SimNIBS tissue numbering `[DATA]`) must paint the pane
 *   in that region's own LUT colour and nothing else's.
 *
 * **Deviation, stated rather than hidden.** The brief asked for the bone surfaces "with a clip
 * plane". §4.4's `IsosurfaceLayer` has no `clip` field and §7.2's iso draw explicitly disables clip
 * distances (`render/passes/derived.ts`), so clipping an isosurface is a new shader path plus a
 * second frozen-type change, neither of which task 2 sanctioned. Isolating the region through the
 * volume layer's own `visibleLabels` shows the same thing the clip plane was wanted for — the
 * interior tissue, alone, in 3D — through the ownership this task actually built. A clip plane for
 * isosurfaces is worth its own change.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectGolden, readCanvasRect } from '../helpers/pixels';

const ROOT = process.env.TETRAVOX_TESTDATA ?? '';
const fsUrl = (rel: string): string => `/@fs${ROOT}/${rel}`;

const T1 = 'm2m_ernie/T1.nii.gz';
const TISSUES = 'm2m_ernie/final_tissues.nii.gz';
const TISSUES_LUT = 'm2m_ernie/final_tissues_LUT.txt';

const PANE = 768;

/** SimNIBS tissue numbering `[DATA]`: 7 is compact bone. Tag 4 does not exist. */
const COMPACT_BONE = 7;

test.skip(ROOT === '', 'TETRAVOX_TESTDATA is unset');

async function openScene(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/test/pages/scene.html');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);
  return errors;
}

/** The lit span of one scanline: `[first, last]`, and whether it has an unlit gap inside it. */
function scan(row: Uint8Array): { first: number; last: number; gaps: number } {
  let first = -1;
  let last = -1;
  let gaps = 0;
  let wasLit = false;
  for (let x = 0; x < PANE; x += 1) {
    const o = x * 4;
    const lit = (row[o + 3] ?? 0) > 0 && ((row[o] ?? 0) > 25 || (row[o + 1] ?? 0) > 25);
    if (lit) {
      if (first < 0) first = x;
      last = x;
    } else if (wasLit && first >= 0) {
      gaps += 1;
    }
    wasLit = lit;
  }
  return { first, last, gaps };
}

test('T1 at its default level (p95) is a head-shaped shell in the 3D pane', async ({ page }) => {
  const errors = await openScene(page);
  const info = await page.evaluate(async (url) => {
    const engine = window.__tvxEngine!;
    const ds = await engine.addDataset({ kind: 'path', path: url });
    if (ds.kind !== 'volume') throw new Error('not a volume');
    const layer = engine.addLayer({ datasetId: ds.id, kind: 'volume' });
    // The switch's own default — `defaultIso3d(ds)` — not a level typed into this test. That is the
    // claim: opening the switch on a T1 gives you the head.
    const { defaultIso3d } = window.__tvxEngineModule!;
    const iso3d = defaultIso3d(ds);
    engine.updateLayer(layer.id, { showIn3D: false, visible: true, iso3d });
    engine.setLayout({ kind: '3d-only', cells: ['view3d'] });
    engine.resetView('view3d');
    engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });
    const cam = engine.scene.view3d.camera;
    engine.setView('view3d', { camera: { ...cam, orthographic: true } });
    await engine.whenSettled();
    engine.renderNow();
    return {
      iso: iso3d.iso,
      p95: ds.stats.percentiles['95'],
      max: ds.stats.max,
      status: engine.iso3dStatus(layer.id),
      errors: window.__tvxErrors ?? [],
    };
  }, fsUrl(T1));

  expect(errors).toEqual([]);
  expect(info.errors).toEqual([]);
  // The p95 default, and the trap it avoids: `T1.nii.gz`'s max is exactly 65535.0 `[DATA]`, so a
  // midpoint default would be 32767.5 — an empty surface.
  expect(info.iso).toBe(info.p95);
  expect(info.max).toBeCloseTo(65535, 0);
  expect(info.iso).toBeLessThan(info.max / 4);
  expect(info.status).toEqual({ pending: 0, total: 1 });

  // A head-sized object, centred in a pane that `resetView` fitted to the **volume's** bounds. The
  // head is smaller than the 256 × 256 × 208 mm grid it sits in, so the surface fills a large but
  // strictly sub-full fraction of the pane: a surface that covered the pane would be the level set
  // of the background, and one that covered a tenth of it would be noise.
  const mid = await readCanvasRect(page, 0, PANE / 2, PANE, 1);
  const span = scan(mid);
  expect(span.first, 'the surface is on screen').toBeGreaterThanOrEqual(0);
  const width = span.last - span.first + 1;
  expect(width).toBeGreaterThan(PANE * 0.2);
  expect(width, 'and does not fill the fitted volume bounds').toBeLessThan(PANE * 0.85);
  expect(Math.abs((span.first + span.last) / 2 - PANE / 2)).toBeLessThan(PANE * 0.15);

  // Head-shaped, not box-shaped: a scanline near the top of the object is strictly narrower than the
  // widest one. A solid level set of the whole grid — the failure mode of a badly chosen level — is
  // as wide at the top as in the middle.
  // 0.35 of the pane height, not 0.2: `resetView` fits the **volume's** 256 mm bounds, so the head's
  // crown starts about a quarter of the way down and a scanline at 0.2 is above it entirely.
  const top = await readCanvasRect(page, 0, Math.round(PANE * 0.35), PANE, 1);
  const topSpan = scan(top);
  expect(topSpan.first, 'the crown of the head is still surface').toBeGreaterThanOrEqual(0);
  expect(topSpan.last - topSpan.first + 1, 'and narrower than the widest section').toBeLessThan(
    width
  );
});

// Nine regions, nine `marching_cubes` passes over 256 × 256 × 208 under SwiftShader — the default
// 30 s is not enough for the first, all-regions build plus the isolated rebuild.
test.setTimeout(180_000);

test('final_tissues gives one surface per visible region, in its LUT colour', async ({ page }) => {
  const errors = await openScene(page);
  const info = await page.evaluate(
    async ([url, lut, bone]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({
        kind: 'path',
        path: url as string,
        sidecars: { lut: lut as string },
      });
      if (ds.kind !== 'volume') throw new Error('not a volume');
      const layer = engine.addLayer({ datasetId: ds.id, kind: 'volume' });
      const { defaultIso3d } = window.__tvxEngineModule!;
      engine.updateLayer(layer.id, { showIn3D: false, iso3d: defaultIso3d(ds) });
      engine.setLayout({ kind: '3d-only', cells: ['view3d'] });
      engine.resetView('view3d');
      engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });
      await engine.whenSettled();
      const all = engine.iso3dStatus(layer.id);

      // Isolate compact bone through the volume layer's own region visibility — the surfaces follow
      // it, which is the ownership this task is about.
      engine.updateLayer(layer.id, { visibleLabels: Uint32Array.from([bone as number]) });
      await engine.whenSettled();
      engine.renderNow();
      const entry = ds.labelTable?.byId.get(bone as number);
      return {
        isLabel: ds.isLabel,
        labelIds: [...(ds.labelIds ?? [])],
        allTotal: all.total,
        boneStatus: engine.iso3dStatus(layer.id),
        // The **wire** colour, as §4.1 requires an expected pixel to be quoted: round(engine·255).
        boneColorBytes: (entry?.color ?? [0, 0, 0, 1]).map((c: number) => Math.round(c * 255)),
        boneName: entry?.name ?? null,
        errors: window.__tvxErrors ?? [],
      };
    },
    [fsUrl(TISSUES), fsUrl(TISSUES_LUT), COMPACT_BONE] as const
  );

  expect(errors).toEqual([]);
  expect(info.errors).toEqual([]);
  // `final_tissues.nii.gz` is 0 … 10 with 10 unique values `[DATA]`; background 0 never gets one.
  expect(info.isLabel).toBe(true);
  expect(info.labelIds.length).toBe(10);
  expect(info.allTotal).toBe(info.labelIds.filter((id) => id !== 0).length);
  expect(info.boneStatus).toEqual({ pending: 0, total: 1 });
  expect(info.boneName).not.toBeNull();

  // Every lit pixel is compact bone's own LUT colour, shaded: §7.4's headlight scales the base
  // colour by one scalar per pixel and adds a grey specular, so the channel **order** of the LUT
  // colour survives in every one of them. A surface that took the wrong region's colour — or the
  // fallback palette, because the LUT never loaded — fails this.
  const [br, bg, bb] = info.boneColorBytes as [number, number, number];
  const px = await readCanvasRect(page, 0, 0, PANE, PANE);
  let lit = 0;
  let inOrder = 0;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i] ?? 0;
    const g = px[i + 1] ?? 0;
    const b = px[i + 2] ?? 0;
    if (r < 30 && g < 30 && b < 30) continue;
    lit += 1;
    const ok =
      (br >= bg ? r >= g - 2 : r <= g + 2) &&
      (bg >= bb ? g >= b - 2 : g <= b + 2) &&
      (br >= bb ? r >= b - 2 : r <= b + 2);
    if (ok) inOrder += 1;
  }
  expect(lit, 'the bone surface is on screen').toBeGreaterThan(PANE * 20);
  expect(inOrder / lit).toBeGreaterThan(0.99);
});

test('golden: iso3d-t1-realdata', async ({ page }) => {
  const errors = await openScene(page);
  await page.evaluate(async (url) => {
    const engine = window.__tvxEngine!;
    const ds = await engine.addDataset({ kind: 'path', path: url });
    if (ds.kind !== 'volume') throw new Error('not a volume');
    const layer = engine.addLayer({ datasetId: ds.id, kind: 'volume' });
    const { defaultIso3d } = window.__tvxEngineModule!;
    engine.updateLayer(layer.id, { showIn3D: false, iso3d: defaultIso3d(ds) });
    engine.setLayout({ kind: '3d-only', cells: ['view3d'] });
    engine.resetView('view3d');
    engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });
    await engine.whenSettled();
  }, fsUrl(T1));
  expect(errors).toEqual([]);
  await expectGolden(page, 'iso3d-t1-realdata');
});
