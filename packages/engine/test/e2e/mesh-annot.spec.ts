/**
 * §4.7's `attachSurfaceData` (2026-09-06): per-vertex data from a **second file** onto a surface
 * that is already open, and `colorMode:'label'` painting what arrived.
 *
 * Two fixtures, one surface. `testdata/lh.fixture.surf` is `surface_patch()` with no transform
 * (`scripts/gen-fixtures.py`) — the same 16 vertices and 18 triangles as `surf_labelled.surf.gii`,
 * untranslated. Onto it:
 *
 * * `surf_regions.label.gii` — data-only, keys 0/3/7/11, and the vertex labels chosen so that
 *   four triangles are monochrome (the `mesh-label-colormode` test explains why monochrome is the
 *   precondition for a closed-form pixel; `surf.label.gii` cycles its keys and has none).
 *   Attaching it by content to a **FreeSurfer** surface is the point: the two files share nothing
 *   but a vertex count.
 * * `lh.fixture.annot` — packed-RGB ids remapped to dense 0..3, one label per vertex column, so no
 *   triangle is monochrome and its assertion is the table and the field, not a pixel; the golden
 *   covers its picture.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { expectGolden, readCanvasPixels } from '../helpers/pixels';
import { PANE, isBackground, solveShading } from './mesh-support';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const fixture = (name: string): string => `/@fs${REPO}testdata/${name}`;

const SURFACE = fixture('lh.fixture.surf');
const LABEL_GII = fixture('surf_regions.label.gii');
const ANNOT = fixture('lh.fixture.annot');

/** `testdata/manifest.json`'s `gifti['surf_regions.label.gii'].labelTable`, transcribed. */
const GIFTI_LABEL_COLORS: Record<number, readonly [number, number, number]> = {
  3: [255, 0, 0], // Alpha
  7: [0, 128, 0], // Beta
  11: [0, 0, 255], // Gamma
};

/** `surface_patch()`'s own construction rule, transcribed from `scripts/gen-fixtures.py`. */
function patchTriangles(): [number, number, number][] {
  const n = 4;
  const out: [number, number, number][] = [];
  for (let j = 0; j < n - 1; j += 1) {
    for (let i = 0; i < n - 1; i += 1) {
      const a = j * n + i;
      out.push([a, a + 1, a + n + 1]);
      out.push([a, a + n + 1, a + n]);
    }
  }
  return out;
}

/** The `.label.gii` fixture's vertex → key, from the same source. */
function patchVertexKeys(): number[] {
  const keys = new Array<number>(16).fill(3);
  for (const v of [0, 1, 5]) keys[v] = 7;
  for (const v of [10, 14, 15]) keys[v] = 11;
  return keys;
}

/**
 * `mesh-label-colormode`'s camera, less the `.surf.gii` fixture's translation (2.5, −4, 7.25): the
 * FreeSurfer file carries the untransformed patch.
 */
const TOP_DOWN_CAMERA = {
  target: [0, 0, 0.866] as [number, number, number],
  distance: 120,
  rotation: [0, 0, 0, 1] as [number, number, number, number],
  fovYDeg: 30,
  orthographic: true,
  near: 1,
  far: 400,
};

async function openSurface(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/test/pages/scene.html');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);
  await page.evaluate(
    async ([url, camera]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({ kind: 'path', path: url as string });
      const layer = engine.addLayer({ datasetId: ds.id, kind: 'mesh' });
      window.__tvxGateLayer = layer.id;
      engine.setLayout({ kind: '3d-only', cells: ['view3d'] });
      engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });
      engine.setView('view3d', { camera: camera as never });
      await engine.whenSettled();
    },
    [SURFACE, TOP_DOWN_CAMERA] as const
  );
  return errors;
}

async function attach(page: Page, url: string): Promise<{ fields: string[]; tables: string[] }> {
  return page.evaluate(async (u) => {
    const engine = window.__tvxEngine!;
    const ds = [...engine.scene.datasets.values()][0]!;
    const updated = await engine.attachSurfaceData(ds.id, { kind: 'path', path: u });
    return {
      fields: updated.fields.map((f) => `${f.source}:${f.name}`),
      tables: Object.keys(updated.labelTables ?? {}),
    };
  }, url);
}

async function patchAndSettle(page: Page, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (p) => {
    const engine = window.__tvxEngine!;
    engine.updateLayer(window.__tvxGateLayer!, p as never);
    for (let i = 0; i < 40; i += 1) {
      await engine.whenSettled();
      await new Promise((r) => setTimeout(r, 25));
    }
    await engine.whenSettled();
  }, patch);
}

test('a data-only .label.gii attaches to a FreeSurfer surface and paints it by label', async ({
  page,
}) => {
  const errors = await openSurface(page);

  // 1. Before: a bare surface — no field, no table — and the layer opened in `'tag'`.
  const before = await page.evaluate(() => {
    const engine = window.__tvxEngine!;
    const ds = [...engine.scene.datasets.values()][0]!;
    return {
      nNodes: ds.kind === 'mesh' ? ds.nNodes : 0,
      fields: ds.kind === 'mesh' ? ds.fields.length : -1,
      tables: ds.kind === 'mesh' ? Object.keys(ds.labelTables ?? {}) : null,
      colorMode: (engine.scene.layers[0] as { colorMode: string }).colorMode,
    };
  });
  expect(before).toEqual({ nNodes: 16, fields: 0, tables: [], colorMode: 'tag' });

  // 2. The attach: the dataset grows in place — a field named after the file, a table keyed to it —
  //    and the layer is left exactly as it was (the host recolours, not the engine).
  const added = await attach(page, LABEL_GII);
  expect(added).toEqual({
    fields: ['node:surf_regions.label.gii'],
    tables: ['surf_regions.label.gii'],
  });
  const after = await page.evaluate(() => {
    const engine = window.__tvxEngine!;
    const ds = [...engine.scene.datasets.values()][0]!;
    const table = ds.kind === 'mesh' ? ds.labelTables?.['surf_regions.label.gii'] : undefined;
    return {
      sameObject: engine.scene.layers[0]!.datasetId === ds.id,
      colorMode: (engine.scene.layers[0] as { colorMode: string }).colorMode,
      label: (engine.scene.layers[0] as { label?: unknown }).label ?? null,
      entries: (table?.entries ?? []).map((e) => ({ id: e.id, name: e.name })),
    };
  });
  expect(after.colorMode).toBe('tag');
  expect(after.label).toBeNull();
  expect(after.entries).toEqual([
    { id: 0, name: 'Unknown' },
    { id: 3, name: 'Alpha' },
    { id: 7, name: 'Beta' },
    { id: 11, name: 'Gamma' },
  ]);

  // 3. The pixels, after the host's own recolouring: the same monochrome-triangle argument as
  //    `mesh-label-colormode`, on a surface that came from a different file format.
  await page.evaluate(() => {
    const engine = window.__tvxEngine!;
    const ds = [...engine.scene.datasets.values()][0]!;
    const table = ds.kind === 'mesh' ? ds.labelTables!['surf_regions.label.gii']! : null;
    engine.updateLayer(window.__tvxGateLayer!, {
      colorMode: 'label',
      label: { name: 'surf_regions.label.gii', table, mode: 'fill', outlineWidthPx: 1 },
    } as never);
  });
  await patchAndSettle(page, {});
  const tris = patchTriangles();
  const keys = patchVertexKeys();
  const step = 24;
  const probes: [number, number][] = [];
  for (let y = step; y < PANE; y += step)
    for (let x = step; x < PANE; x += step) probes.push([x, y]);
  const picked = await page.evaluate(async (ps) => {
    const engine = window.__tvxEngine!;
    let ready = null as ReturnType<typeof engine.pick>;
    for (let i = 0; i < 60 && ready === null; i += 1) {
      ready = engine.pick('view3d', 384, 384);
      if (ready === null) {
        await engine.whenSettled();
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    const at = (x: number, y: number): number | null => {
      const hit = engine.pick('view3d', x, y);
      return hit === null || hit.elementKind !== 'tri' ? null : hit.elementId;
    };
    return (ps as [number, number][]).map((p) => {
      const id = at(p[0], p[1]);
      if (id === null) return null;
      for (const [dx, dy] of [
        [-6, 0],
        [6, 0],
        [0, -6],
        [0, 6],
      ]) {
        if (at(p[0] + dx!, p[1] + dy!) !== id) return null;
      }
      return id;
    });
  }, probes);
  const pixels = await readCanvasPixels(page, probes);
  const seen = new Set<number>();
  let asserted = 0;
  for (const [i, id] of picked.entries()) {
    if (id === null) continue;
    if (isBackground(pixels[i]!)) continue;
    const tri = tris[id - 1];
    if (tri === undefined) continue;
    const [a, b, c] = tri;
    if (keys[a] !== keys[b] || keys[b] !== keys[c]) continue;
    const key = keys[a]!;
    const want = GIFTI_LABEL_COLORS[key]!;
    const px = pixels[i]!;
    expect(
      solveShading(want, px).feasible,
      `pixel ${probes[i]!.join(',')} on triangle ${id} is label ${key}: ${want.join(',')} lit — got ${px.slice(0, 3).join(',')}`
    ).toBe(true);
    for (const [other, color] of Object.entries(GIFTI_LABEL_COLORS)) {
      if (Number(other) === key) continue;
      expect(solveShading(color, px).feasible, `…and not label ${other}`).toBe(false);
    }
    seen.add(key);
    asserted += 1;
  }
  expect([...seen].sort((x, y) => x - y)).toEqual([3, 7, 11]);
  expect(asserted).toBeGreaterThan(20);
  expect(errors).toEqual([]);
});

test('a .annot attaches with its colortable; a second file coexists; a mismatch is refused', async ({
  page,
}) => {
  const errors = await openSurface(page);
  const first = await attach(page, ANNOT);
  expect(first).toEqual({ fields: ['node:lh.fixture.annot'], tables: ['lh.fixture.annot'] });
  const entries = await page.evaluate(() => {
    const ds = [...window.__tvxEngine!.scene.datasets.values()][0]!;
    const t = ds.kind === 'mesh' ? ds.labelTables!['lh.fixture.annot']! : null;
    return t!.entries.map((e) => [e.id, e.name]);
  });
  // `testdata/manifest.json` `freesurfer['lh.fixture.annot'].colortable`: packed ids, file order.
  expect(entries).toEqual([
    [1_639_705, 'Unknown'],
    [255, 'Alpha'],
    [32_768, 'Beta'],
    [16_711_680, 'Gamma'],
  ]);

  // Two overlays on one surface: both fields, both tables, nothing replaced.
  const second = await attach(page, LABEL_GII);
  expect(second.fields).toEqual(['node:lh.fixture.annot', 'node:surf_regions.label.gii']);
  expect(second.tables.sort()).toEqual(['lh.fixture.annot', 'surf_regions.label.gii']);

  // A file whose count is not the mesh's: rejected with both counts, and the mesh unchanged. The
  // 27-node lattice is the only fixture with a count other than 16.
  const refused = await page.evaluate(
    async ([lattice, annot]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({ kind: 'path', path: lattice as string });
      const fieldsBefore = ds.kind === 'mesh' ? ds.fields.length : -1;
      try {
        await engine.attachSurfaceData(ds.id, { kind: 'path', path: annot as string });
        return null;
      } catch (e) {
        return {
          message: (e as Error).message,
          nNodes: ds.kind === 'mesh' ? ds.nNodes : -1,
          unchanged: ds.kind === 'mesh' ? ds.fields.length === fieldsBefore : false,
          tables: ds.kind === 'mesh' ? Object.keys(ds.labelTables ?? {}) : null,
        };
      }
    },
    [fixture('mesh_v2_binary.msh'), ANNOT] as const
  );
  expect(refused?.nNodes).toBe(27);
  expect(refused?.unchanged).toBe(true);
  expect(refused?.tables).toEqual([]);
  expect(refused?.message).toContain('16 vertices');
  expect(refused?.message).toContain('27');
  expect(errors).toEqual([]);
});

test('an attached annotation survives serialize() and load(): the table is found by name', async ({
  page,
}) => {
  const errors = await openSurface(page);
  await attach(page, ANNOT);
  await attach(page, LABEL_GII);
  const restored = await page.evaluate(async () => {
    const engine = window.__tvxEngine!;
    const ds = [...engine.scene.datasets.values()][0]!;
    // The layer names the SECOND table, so a restore that seeded "the first table" would be
    // wrong in a way that only two attachments can show.
    const table = ds.kind === 'mesh' ? ds.labelTables!['surf_regions.label.gii']! : null;
    engine.updateLayer(window.__tvxGateLayer!, {
      colorMode: 'label',
      label: { name: 'surf_regions.label.gii', table, mode: 'outline', outlineWidthPx: 2 },
    } as never);
    const spec = engine.serialize();
    const ref = spec.datasets[0]!;
    const fields = (ref.sidecars?.fields ?? []).map((f) => f.absPath ?? f.path);
    // §4.6: relocation resolves to the path that exists; here the absolute one the test page used.
    await engine.load(spec, (r) => r.absPath ?? null);
    await engine.whenSettled();
    const again = [...engine.scene.datasets.values()][0]!;
    const layer = engine.scene.layers[0] as {
      colorMode: string;
      label?: {
        name: string;
        mode: string;
        outlineWidthPx: number;
        table?: { entries: unknown[] };
      };
    };
    return {
      fields,
      newFields: again.kind === 'mesh' ? again.fields.map((f) => f.name) : null,
      newTables: again.kind === 'mesh' ? Object.keys(again.labelTables ?? {}).sort() : null,
      colorMode: layer.colorMode,
      label:
        layer.label === undefined
          ? null
          : {
              name: layer.label.name,
              mode: layer.label.mode,
              outlineWidthPx: layer.label.outlineWidthPx,
              entries: layer.label.table?.entries.length ?? 0,
            },
    };
  });
  expect(restored.fields.map((f) => f.split('/').pop())).toEqual([
    'lh.fixture.annot',
    'surf_regions.label.gii',
  ]);
  expect(restored.newFields).toEqual(['lh.fixture.annot', 'surf_regions.label.gii']);
  expect(restored.newTables).toEqual(['lh.fixture.annot', 'surf_regions.label.gii']);
  expect(restored.colorMode).toBe('label');
  expect(restored.label).toEqual({
    name: 'surf_regions.label.gii',
    mode: 'outline',
    outlineWidthPx: 2,
    entries: 4,
  });
  expect(errors).toEqual([]);
});

test('golden: mesh-annot-attached', async ({ page }) => {
  const errors = await openSurface(page);
  await attach(page, ANNOT);
  await page.evaluate(() => {
    const engine = window.__tvxEngine!;
    const ds = [...engine.scene.datasets.values()][0]!;
    const table = ds.kind === 'mesh' ? ds.labelTables!['lh.fixture.annot']! : null;
    engine.updateLayer(window.__tvxGateLayer!, {
      colorMode: 'label',
      label: { name: 'lh.fixture.annot', table, mode: 'fill', outlineWidthPx: 1 },
    } as never);
  });
  await patchAndSettle(page, {});
  expect(errors).toEqual([]);
  await expectGolden(page, 'mesh-annot-attached');
});
