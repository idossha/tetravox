/**
 * P2-07 — `serialize()` → JSON → `load()`, through a real engine and real files.
 *
 * `src/scene/serialize.test.ts` proves the pure half (relative paths, the id remap, the JSON-safe
 * layer shape). What only a live engine can prove is the part the audit said was impossible before
 * the remap existed: that the **layers** come back, on datasets whose ids are different this time,
 * with the edits R5 asks to persist — and that a scene written for one directory opens from another
 * through the relocate hook.
 *
 * The real-data test is E-SCENE's gate item, verbatim: *"A scene saved with `ernie.msh` +
 * `T1.nii.gz`, reopened from a moved directory, resolving through the relocate dialog (A-SHELL's
 * half) and reproducing the same three slice indices."* The three slice indices are **decoded out of
 * the framebuffer** (`helpers/chrome.ts`), not read from scene state — §11's rule that the chrome is
 * asserted on the pixels a user sees, and the only way "the same three slice indices" is a claim
 * about the viewer rather than about a JSON blob.
 *
 * Tagged `@angle` so both projects run it: nothing here is renderer-specific.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readCornerInfo } from '../helpers/chrome';
import type { DatasetRef, ViewSpec } from '../../src/scene/types';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const fixture = (name: string): string => `/@fs${REPO}testdata/${name}`;

const TESTDATA = process.env.TETRAVOX_TESTDATA ?? '';
const hasRealData =
  TESTDATA !== '' &&
  existsSync(`${TESTDATA}/m2m_ernie/T1.nii.gz`) &&
  existsSync(`${TESTDATA}/m2m_ernie/ernie.msh`);

const CANVAS = 768;
const HALF = CANVAS / 2;
/** `gl.viewport`'s bottom-left origin, for `readCornerInfo`. */
const GL_PANES = {
  axial: { x: 0, y: HALF, width: HALF, height: HALF },
  coronal: { x: HALF, y: HALF, width: HALF, height: HALF },
  sagittal: { x: 0, y: 0, width: HALF, height: HALF },
} as const;

async function openScene(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/test/pages/scene.html');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);
  return errors;
}

/** `SLICE n` from one pane's corner block, decoded out of the framebuffer. */
/**
 * The pane's `SLICE n` line, **found rather than indexed**.
 *
 * §8's corner block is not a fixed height: it is `[MODE, RAS …]`, plus `SLICE n` only when there is
 * a top volume layer, plus R2's `ZOOM n×` only when the pane is off its fit. Reading a fixed slot
 * from the bottom therefore returns a different line depending on what the scene holds — and
 * silently, because every line is text: a run of this file once read `"RAS 0.0 0"` where it wanted
 * `SLICE …`, which is the two-line block truncated to nine characters. Searching for the line whose
 * shape is the one being asserted cannot be confused that way, and it is also the only reading that
 * makes "the same three slice indices" a claim about slice indices.
 */
async function sliceReadout(page: Page, pane: keyof typeof GL_PANES): Promise<string> {
  const lines = await readCornerInfo(page, {
    canvasHeight: CANVAS,
    pane: GL_PANES[pane],
    lineCount: 4,
    length: 'SLICE 000'.length,
  });
  return lines.map((l) => l.trim()).find((l) => /^SLICE \d+$/.test(l)) ?? lines.join(' | ');
}

/**
 * The relocate hook, resolved **in Node** — which is where the app resolves it too (§8: the main
 * process owns the filesystem; §5 rule 3 keeps the renderer away from it).
 *
 * `candidatePaths` is the engine's own "scene-relative first, absolute fallback" order; this picks
 * the first candidate that exists, exactly as A-SHELL's dialog will before it asks the user.
 */
function resolveRefs(spec: ViewSpec, sceneDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const ref of spec.datasets) {
    for (const candidate of candidates(ref, sceneDir)) {
      if (existsSync(candidate.replace(/^\/@fs/, ''))) {
        out[ref.id] = candidate;
        break;
      }
    }
  }
  return out;
}

/** `candidatePaths` re-derived in the spec — asserting a transcription would prove nothing. */
function candidates(ref: DatasetRef, sceneDir: string): string[] {
  const join = (dir: string, rel: string): string => {
    const parts = [...dir.split('/'), ...rel.split('/')].filter((s) => s !== '' && s !== '.');
    const out: string[] = [];
    for (const p of parts) {
      if (p === '..') out.pop();
      else out.push(p);
    }
    return `/${out.join('/')}`;
  };
  const list = [ref.path.startsWith('/') ? ref.path : join(sceneDir, ref.path)];
  if (ref.absPath !== undefined && !list.includes(ref.absPath)) list.push(ref.absPath);
  return list;
}

/** Load one dataset and its layer. */
async function add(page: Page, url: string, kind: 'volume' | 'mesh'): Promise<void> {
  await page.evaluate(
    async ([u, k]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({ kind: 'path', path: u as string });
      engine.addLayer({ datasetId: ds.id, kind: k as 'volume' | 'mesh' });
      await engine.whenSettled();
    },
    [url, kind] as const
  );
}

/** Everything the round trip has to reproduce, read out of the live scene. */
interface SceneShape {
  datasetIds: string[];
  layers: { name: string; kind: string; datasetId: string; opacity: number }[];
  activeLayerName: string | null;
  cursor: [number, number, number];
  layout: string;
  radiological: boolean;
  tagStyle: Record<string, { visible: boolean; opacity: number; color?: number[] }> | null;
  hiddenInAxial: string[];
}

async function shapeOf(page: Page): Promise<SceneShape> {
  return await page.evaluate(() => {
    const engine = window.__tvxEngine!;
    const scene = engine.scene;
    const mesh = scene.layers.find((l) => l.kind === 'mesh') as
      | { tagStyle: Record<string, { visible: boolean; opacity: number; color?: number[] }> }
      | undefined;
    const axial = scene.slices.find((s) => s.id === 'axial');
    const byId = new Map(scene.layers.map((l) => [l.id, l.name]));
    return {
      datasetIds: [...scene.datasets.keys()],
      layers: scene.layers.map((l) => ({
        name: l.name,
        kind: l.kind,
        datasetId: l.datasetId,
        opacity: l.opacity,
      })),
      activeLayerName:
        scene.activeLayerId !== null ? (byId.get(scene.activeLayerId) ?? null) : null,
      cursor: [...scene.cursor] as [number, number, number],
      layout: scene.layout.kind,
      radiological: scene.radiological,
      tagStyle: mesh?.tagStyle ?? null,
      hiddenInAxial: Object.entries(axial?.layerVisibility ?? {})
        .filter(([, visible]) => !visible)
        .map(([id]) => byId.get(id) ?? id),
    };
  });
}

/**
 * Edit the scene the way a user would before saving: move the cursor, recolour and hide a mesh tag
 * (R5), drop a layer's opacity, hide a layer in one pane, and pick an active layer.
 */
async function editScene(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const engine = window.__tvxEngine!;
    const mesh = engine.scene.layers.find((l) => l.kind === 'mesh')!;
    const volume = engine.scene.layers.find((l) => l.kind === 'volume');
    const tagStyle = { ...(mesh as unknown as { tagStyle: Record<number, unknown> }).tagStyle };
    const tags = Object.keys(tagStyle)
      .map(Number)
      .sort((a, b) => a - b);
    // R5: hide one region, recolour another. Both are `tagStyle` edits and both must round-trip.
    tagStyle[tags[0]!] = { visible: false, opacity: 1 };
    tagStyle[tags[1] ?? tags[0]!] = { visible: true, opacity: 0.4, color: [0.1, 0.7, 0.3, 1] };
    engine.updateLayer(mesh.id, { tagStyle } as never);
    engine.updateLayer(mesh.id, { opacity: 0.75 });
    if (volume !== undefined) {
      engine.setView('axial', { layerVisibility: { [volume.id]: false } });
    }
    engine.setActiveLayer(mesh.id);
    engine.setRadiological(true);
    engine.setLayout({ kind: '2x2', cells: ['axial', 'coronal', 'sagittal', 'view3d'] });
    engine.setCursor([-12.5, 8.25, 4]);
    await engine.whenSettled();
  });
}

/** Serialize with a scene directory the data does **not** live in, so paths must climb out. */
async function serializeFrom(page: Page, sceneDir: string): Promise<ViewSpec> {
  return await page.evaluate((dir) => {
    const engine = window.__tvxEngine!;
    (engine as unknown as { setSceneDir(d: string | null): void }).setSceneDir(dir);
    // The persisted form is a file: assert on what survives JSON, not on the live object.
    return JSON.parse(JSON.stringify(engine.serialize())) as ViewSpec;
  }, sceneDir);
}

/** Close every dataset, then load the spec through the relocate hook. */
async function reopen(page: Page, spec: ViewSpec, resolved: Record<string, string>): Promise<void> {
  await page.evaluate(
    async ([s, map]) => {
      const engine = window.__tvxEngine!;
      for (const ds of [...engine.scene.datasets.values()]) engine.removeDataset(ds.id);
      await engine.whenSettled();
      const paths = map as Record<string, string>;
      await engine.load(s as ViewSpec, (ref) => paths[ref.id] ?? null);
      await engine.whenSettled();
    },
    [spec, resolved] as const
  );
}

// ===========================================================================================
// Synthetic — the mechanism, on fixtures, so CI covers it with TETRAVOX_TESTDATA unset
// ===========================================================================================

test('@angle P2-07: a two-dataset scene round-trips through JSON, with fresh dataset ids on the way back', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = await openScene(page);
  await add(page, fixture('vol_f32.nii.gz'), 'volume');
  await add(page, fixture('mesh_v2_binary.msh'), 'mesh');
  await editScene(page);

  const before = await shapeOf(page);
  const spec = await serializeFrom(page, `/@fs${REPO}testdata/scenes`);

  // §4.6: relative to the scene file, with an absolute fallback. The fixtures are one level up.
  expect(spec.version).toBe(2); // ViewSpec v2 since the scene-ux work (2026-08-28)
  expect(spec.datasets.map((d) => d.path)).toEqual(['../vol_f32.nii.gz', '../mesh_v2_binary.msh']);
  for (const ref of spec.datasets) expect(ref.absPath).toBe(`/@fs${REPO}testdata/${ref.name}`);
  expect(spec.layers).toHaveLength(2);
  expect(spec.activeLayerId).not.toBeNull();

  await reopen(page, spec, resolveRefs(spec, `/@fs${REPO}testdata/scenes`));
  const after = await shapeOf(page);

  // The ids really are new — otherwise the remap is untested and this whole test is vacuous.
  expect(after.datasetIds).not.toEqual(before.datasetIds);
  expect(after.layers.map((l) => l.datasetId)).toEqual(after.datasetIds);

  expect(after.layers.map((l) => [l.name, l.kind, l.opacity])).toEqual(
    before.layers.map((l) => [l.name, l.kind, l.opacity])
  );
  expect(after.activeLayerName).toBe(before.activeLayerName);
  expect(after.cursor).toEqual(before.cursor);
  expect(after.layout).toBe(before.layout);
  expect(after.radiological).toBe(true);
  // R5: the region edits — one tag hidden, one recoloured and made translucent.
  expect(after.tagStyle).toEqual(before.tagStyle);
  // `SliceView.layerVisibility` is keyed by LayerId, so it needed the same remap one level up.
  expect(after.hiddenInAxial).toEqual(before.hiddenInAxial);
  expect(errors).toEqual([]);
});

/**
 * §4.6's sidecars — the half of R5's "persists through scene save/load" that was missing.
 *
 * The edits round-tripped; the **table they are edits against** did not. `DatasetRef` recorded
 * `{id, kind, name, path, fingerprint, absPath}` and nothing else, so reopening a scene reloaded the
 * mesh with no `.msh.opt`: every tissue name became `tag <id>`, every tag colour became §7.6's
 * deterministic fallback, and a label volume's cursor readout lost its region name. §7.6 makes the
 * sidecar a load-time input — `ernie.msh` has no `$PhysicalNames` at all, so the sidecar is the only
 * source of "WM"/"GM"/"CSF" — and nothing in `Layer` can stand in for it.
 */
test('@angle P2-07: a scene remembers its `.msh.opt`, so the tissue names and colours come back', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = await openScene(page);
  const OPT = fixture('mesh_v2_binary.msh.opt');
  await page.evaluate(
    async ([url, opt]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({
        kind: 'path',
        path: url as string,
        sidecars: { opt: opt as string },
      });
      engine.addLayer({ datasetId: ds.id, kind: 'mesh' });
      await engine.whenSettled();
    },
    [fixture('mesh_v2_binary.msh'), OPT] as const
  );

  const tagsOf = async (): Promise<{ id: number; name: string | null; color: number[] }[]> =>
    page.evaluate(() => {
      const ds = [...window.__tvxEngine!.scene.datasets.values()].find((d) => d.kind === 'mesh');
      if (ds === undefined || ds.kind !== 'mesh') return [];
      return ds.tags.map((t) => ({
        id: t.id,
        name: t.name ?? null,
        color: [...t.color].map((c) => Math.round(c * 255)),
      }));
    });

  const before = await tagsOf();
  // `Mesh.Color.One` / `.Two` from the sidecar, as `testdata/manifest.json`'s
  // `mshOptParsedByGmsh` records them — Gmsh's own reading of the same file, not ours.
  expect(before.find((t) => t.id === 1)?.color).toEqual([230, 230, 210, 255]);
  expect(before.find((t) => t.id === 2)?.color).toEqual([129, 129, 129, 255]);
  expect(before.find((t) => t.id === 1)?.name).toBe('Tissue_A');

  // …and the same mesh **without** the sidecar, so "it came back" is a claim with content: if the
  // two agreed, the assertion after the round trip would pass whether or not the spec carried the
  // sidecar at all. This is the state the reopened scene used to be in.
  const bare = await page.evaluate(async (url) => {
    const engine = window.__tvxEngine!;
    const ds = await engine.addDataset({ kind: 'path', path: url });
    const tags =
      ds.kind === 'mesh'
        ? ds.tags.map((t) => ({
            id: t.id,
            name: t.name ?? null,
            color: [...t.color].map((c) => Math.round(c * 255)),
          }))
        : [];
    engine.removeDataset(ds.id);
    await engine.whenSettled();
    return tags;
  }, fixture('mesh_v2_binary.msh'));
  expect(bare.find((t) => t.id === 1)?.color, 'no sidecar means the fallback palette').not.toEqual(
    before.find((t) => t.id === 1)?.color
  );

  const sceneDir = `/@fs${REPO}testdata/scenes`;
  const spec = await serializeFrom(page, sceneDir);
  // The sidecar is recorded relative to the **dataset**, not to the scene file — one level of
  // indirection that is the whole reason a relocated dataset brings it along.
  expect(spec.datasets[0]?.sidecars?.opt?.path).toBe('mesh_v2_binary.msh.opt');
  expect(spec.datasets[0]?.sidecars?.opt?.absPath).toBe(OPT);
  // And it survives JSON, which is what a `*.tetravox.json` on disk is.
  expect(JSON.parse(JSON.stringify(spec)).datasets[0].sidecars.opt.path).toBe(
    'mesh_v2_binary.msh.opt'
  );

  await reopen(page, spec, resolveRefs(spec, sceneDir));
  expect(await tagsOf(), 'the names and the .msh.opt colours came back').toEqual(before);
  expect(errors).toEqual([]);
});

test('@angle P2-07: a dataset the hook cannot place takes its layers with it, and the rest still opens', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = await openScene(page);
  await add(page, fixture('vol_f32.nii.gz'), 'volume');
  await add(page, fixture('mesh_v2_binary.msh'), 'mesh');

  const spec = await serializeFrom(page, `/@fs${REPO}testdata`);
  const meshRef = spec.datasets.find((d) => d.kind === 'mesh')!;
  const resolved = resolveRefs(spec, `/@fs${REPO}testdata`);
  delete resolved[meshRef.id];

  await reopen(page, spec, resolved);
  const after = await shapeOf(page);
  expect(after.datasetIds).toHaveLength(1);
  // A layer whose dataset never came back is dropped, not left pointing at a stranger.
  expect(after.layers.map((l) => l.kind)).toEqual(['volume']);
  expect(after.layers[0]?.datasetId).toBe(after.datasetIds[0]);
  expect(errors).toEqual([]);
});

// ===========================================================================================
// Real data — E-SCENE's gate item
// ===========================================================================================

test('@angle P2-07 (real data): ernie.msh + T1.nii.gz, saved, moved, and reopened to the same three slice indices', async ({
  page,
}) => {
  test.skip(!hasRealData, 'needs TETRAVOX_TESTDATA');
  test.setTimeout(300_000);
  const errors = await openScene(page);
  await add(page, `/@fs${TESTDATA}/m2m_ernie/T1.nii.gz`, 'volume');
  await add(page, `/@fs${TESTDATA}/m2m_ernie/ernie.msh`, 'mesh');
  await editScene(page);

  const before = {
    shape: await shapeOf(page),
    axial: await sliceReadout(page, 'axial'),
    coronal: await sliceReadout(page, 'coronal'),
    sagittal: await sliceReadout(page, 'sagittal'),
  };
  // The readouts have to say something, or "the same three" is satisfied by three blanks.
  for (const [pane, text] of Object.entries(before)) {
    if (pane === 'shape') continue;
    expect(text, pane).toMatch(/^SLICE \d+$/);
  }

  // Saved into a `scenes/` directory beside the data...
  const savedIn = `/@fs${TESTDATA}/scenes`;
  const spec = await serializeFrom(page, savedIn);
  expect(spec.datasets.map((d) => d.path)).toEqual([
    '../m2m_ernie/T1.nii.gz',
    '../m2m_ernie/ernie.msh',
  ]);

  // ...and reopened from somewhere else entirely. The scene-relative path now misses, and the
  // absolute fallback is what the hook resolves — §4.6's two candidates, in order.
  const movedTo = `/@fs${TESTDATA}/moved/deeper/scenes`;
  const resolved = resolveRefs(spec, movedTo);
  expect(Object.keys(resolved)).toHaveLength(2);
  for (const ref of spec.datasets) expect(resolved[ref.id]).toBe(ref.absPath);

  await reopen(page, spec, resolved);
  const after = await shapeOf(page);

  expect(after.datasetIds).not.toEqual(before.shape.datasetIds);
  expect(await sliceReadout(page, 'axial')).toBe(before.axial);
  expect(await sliceReadout(page, 'coronal')).toBe(before.coronal);
  expect(await sliceReadout(page, 'sagittal')).toBe(before.sagittal);
  expect(after.cursor).toEqual(before.shape.cursor);
  expect(after.activeLayerName).toBe(before.shape.activeLayerName);
  // R5 again, on ernie's ten tissue tags: the hidden one and the recoloured one both came back.
  expect(after.tagStyle).toEqual(before.shape.tagStyle);
  expect(errors).toEqual([]);
});

// ===========================================================================================
// P2-10 — toTemplate / ProbeResult.mni
// ===========================================================================================

test('@angle P2-10: `ProbeResult.mni` appears only for a volume whose used affine is MNI152', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = await openScene(page);

  // A scanner-anat volume (`sform_code = 2`, like every m2m_ernie file `[DATA]`) claims no template.
  await add(page, fixture('vol_f32.nii.gz'), 'volume');
  const scanner = await page.evaluate(() => {
    const engine = window.__tvxEngine!;
    return engine.probe(engine.scene.cursor).mni ?? null;
  });
  expect(scanner).toBeNull();

  // The same volume with `sform_code = 4` — built here, byte by byte, so the header is the test's
  // and not a fixture's. 2x2x2 uint8, identity sform, NIfTI-1 single file.
  const mni = await page.evaluate(async () => {
    const engine = window.__tvxEngine!;
    const bytes = new ArrayBuffer(352 + 8);
    const dv = new DataView(bytes);
    dv.setInt32(0, 348, true);
    dv.setInt16(40, 3, true); // dim[0] = 3
    for (let i = 0; i < 3; i += 1) dv.setInt16(42 + i * 2, 2, true); // dim[1..3] = 2
    dv.setInt16(70, 2, true); // datatype = DT_UINT8
    dv.setInt16(72, 8, true); // bitpix
    for (let i = 0; i < 4; i += 1) dv.setFloat32(76 + i * 4, 1, true); // pixdim[0..3]
    dv.setFloat32(108, 352, true); // vox_offset
    dv.setFloat32(112, 1, true); // scl_slope
    dv.setInt16(252, 0, true); // qform_code
    dv.setInt16(254, 4, true); // sform_code = NIFTI_XFORM_MNI_152
    // srow_x/y/z: the identity, so world RAS mm are MNI152 mm.
    for (let r = 0; r < 3; r += 1) dv.setFloat32(280 + r * 16 + r * 4, 1, true);
    for (let i = 0; i < 4; i += 1) dv.setUint8(344 + i, 'n+1\0'.charCodeAt(i)); // magic
    const voxels = new Uint8Array(bytes, 352, 8);
    voxels.set([0, 40, 80, 120, 160, 200, 240, 255]);

    for (const ds of [...engine.scene.datasets.values()]) engine.removeDataset(ds.id);
    const ds = await engine.addDataset({ kind: 'bytes', name: 'mni.nii', bytes });
    engine.addLayer({ datasetId: ds.id, kind: 'volume' });
    await engine.whenSettled();
    engine.setCursor([0.5, -1.25, 0.75]);
    const probe = engine.probe(engine.scene.cursor);
    return { mni: probe.mni ?? null, world: [...probe.world] };
  });
  // The transform is the identity for code 4, so MNI is the cursor — asserted as an equality, which
  // is the strongest form the claim has.
  expect(mni.mni).toEqual([0.5, -1.25, 0.75]);
  expect(mni.mni).toEqual(mni.world);
  expect(errors).toEqual([]);
});
