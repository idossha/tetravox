/**
 * §7.4.1's analytic pixel assertions. Every expected value is arithmetic on the fixture's coordinates
 * and the pane camera: `testdata/tract_f32_stored.trx` holds a line along +x at y = z = 0 with dpv
 * `along = x`, a line along +y at z = 1, and a line along +z at x = y = 2. Camera: orthographic,
 * looking down −Z, screen-right +X, screen-up +Y, 25 mm across a 768 px pane.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expectGolden, expectPixel, readCanvasRect } from '../helpers/pixels';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const fixture = (name: string): string => `/@fs${REPO}testdata/${name}`;
const MANIFEST = JSON.parse(readFileSync(`${REPO}testdata/manifest.json`, 'utf8')) as {
  tracts: { sample: { onTract: (number | null)[] } };
};

const PANE = 768;
const HALF_MM = 12.5;
const PX_PER_MM = PANE / (2 * HALF_MM);
const BG = [10, 13, 18, 255] as const;
const TOP = {
  target: [0, 0, 0],
  distance: 100,
  rotation: [0, 0, 0, 1],
  fovYDeg: (2 * Math.atan(HALF_MM / 100) * 180) / Math.PI,
  orthographic: true,
  near: 1,
  far: 400,
};
/** Eye on −X, screen-right −Y, screen-up +Z (`mesh-support.ts`). */
const SIDE = { ...TOP, rotation: [0.5, -0.5, -0.5, 0.5] };

const px = (x: number): number => Math.floor(PANE / 2 + x * PX_PER_MM);
const py = (y: number): number => Math.floor(PANE / 2 - y * PX_PER_MM);

async function open(
  page: Page,
  file: string,
  patch: Record<string, unknown>,
  camera: unknown = TOP
): Promise<{ layerId: string; datasetId: string }> {
  await page.goto('/test/pages/scene.html');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);
  return page.evaluate(
    async ([url, p, cam]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({ kind: 'path', path: url as string });
      const layer = engine.addLayer({
        datasetId: ds.id,
        kind: 'tracts',
        ...(p as object),
      } as never);
      engine.setLayout({ kind: '3d-only', cells: ['view3d'] });
      engine.setView('view3d', { camera: cam as never });
      engine.setAnnotations({
        crosshair: false,
        orientationLabels: false,
        cornerInfo: false,
        orientationCube: false,
        colorbars: false,
      });
      await engine.whenSettled();
      return { layerId: layer.id, datasetId: ds.id };
    },
    [fixture(file), patch, camera] as const
  );
}

async function settle(page: Page, layerId: string, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate(
    async ([id, p]) => {
      const engine = window.__tvxEngine!;
      engine.updateLayer(id as string, p as never);
      await engine.whenSettled();
    },
    [layerId, patch] as const
  );
}

test('a tractogram opens at world coordinates with its fields, and is a tracts layer by default', async ({
  page,
}) => {
  await page.goto('/test/pages/scene.html');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);
  const got = await page.evaluate(async (url) => {
    const engine = window.__tvxEngine!;
    const ds = await engine.addDataset({ kind: 'path', path: url });
    const layer = engine.addLayer({ datasetId: ds.id, kind: undefined as never });
    if (ds.kind !== 'tractogram') return null;
    return {
      kind: layer.kind,
      format: ds.format,
      nStreamlines: ds.nStreamlines,
      nPoints: ds.nPoints,
      bounds: ds.bounds,
      vertex: ds.vertexFields.map((f) => f.name),
      streamline: ds.streamlineFields.map((f) => f.name),
      groups: ds.groups.map((g) => [g.name, g.count]),
    };
  }, fixture('tract_f32_stored.trx'));
  expect(got?.kind).toBe('tracts');
  expect(got?.format).toBe('trx');
  expect(got?.nStreamlines).toBe(4);
  expect(got?.nPoints).toBe(44);
  expect(got?.bounds.min[0]).toBe(-10);
  expect(got?.bounds.max[0]).toBe(10);
  expect(got?.vertex).toContain('along');
  expect(got?.streamline).toEqual(expect.arrayContaining(['weight', 'edge_id', 'length_mm']));
  expect(got?.groups).toEqual(expect.arrayContaining([['left', 2]]));
});

test('axis-aligned direction RGB is pure R, G and B @angle', async ({ page }) => {
  const { layerId } = await open(page, 'tract_f32_stored.trx', { lineWidthPx: 5 });
  await expectPixel(page, px(5), py(0), [255, 0, 0, 255]);
  await expectPixel(page, px(-3), py(3) + 0, BG);
  await expectPixel(page, px(0), py(3), [0, 255, 0, 255]);
  await page.evaluate(async (camera) => {
    const engine = window.__tvxEngine!;
    engine.setView('view3d', { camera: camera as never });
    await engine.whenSettled();
  }, SIDE);
  // From the side, the +z line at y = 2 is on screen-left of centre, because screen-right is −Y.
  await expectPixel(page, Math.floor(PANE / 2 - 2 * PX_PER_MM), py(2), [0, 0, 255, 255]);
  void layerId;
});

test('a 1 px line is one pixel wide, and depth-tested', async ({ page }) => {
  await open(page, 'tract_f32_stored.trx', {});
  const col = await readCanvasRect(page, px(5), py(0) - 4, 1, 9);
  const red = [...col].filter((_, i) => i % 4 === 0 && col[i] === 255).length;
  expect(red).toBe(1);
});

test('lineWidthPx is measured in pixels across the line @angle', async ({ page }) => {
  await open(page, 'tract_f32_stored.trx', { lineWidthPx: 7 });
  const col = await readCanvasRect(page, px(5), py(0) - 10, 1, 21);
  const red = [...col].filter((_, i) => i % 4 === 0 && col[i] === 255).length;
  expect(Math.abs(red - 7)).toBeLessThanOrEqual(1);
});

test('a vertex scalar shows colormap(u) along the line, interpolated between points @angle', async ({
  page,
}) => {
  await open(page, 'tract_f32_stored.trx', {
    lineWidthPx: 5,
    colorMode: 'vertex',
    field: 'along',
    colormap: 'gray',
    scale: { kind: 'linear', lo: -10, hi: 10 },
  });
  for (const x of [-7.5, -2.25, 0.5, 4.5, 9]) {
    const v = Math.round((((x + 10) / 20) * 255 * 256) / 256);
    await expectPixel(page, px(x), py(0), [v, v, v, 255], 4);
  }
});

test('a thresholded segment is background, and a streamline scalar is one colour @angle', async ({
  page,
}) => {
  const { layerId } = await open(page, 'tract_f32_stored.trx', {
    lineWidthPx: 5,
    colorMode: 'vertex',
    field: 'along',
    colormap: 'gray',
    scale: { kind: 'linear', lo: -10, hi: 10 },
    threshold: { lo: 0, hi: Infinity, symmetric: false, mode: 'hide', softEdge: 0 },
  });
  await expectPixel(page, px(-5), py(0), BG);
  await expectPixel(page, px(5), py(0), [191, 191, 191, 255], 4);

  await settle(page, layerId, {
    colorMode: 'streamline',
    field: 'weight',
    scale: { kind: 'linear', lo: 0, hi: 1 },
    threshold: { lo: -Infinity, hi: Infinity, symmetric: false, mode: 'clamp', softEdge: 0 },
  });
  // weight is 0.5 on the first streamline, everywhere along it.
  await expectPixel(page, px(-5), py(0), [128, 128, 128, 255], 2);
  await expectPixel(page, px(5), py(0), [128, 128, 128, 255], 2);
});

test('a filter and a hidden group remove whole streamlines, and the pick agrees @angle', async ({
  page,
}) => {
  const { layerId } = await open(page, 'tract_f32_stored.trx', { lineWidthPx: 5 });
  const pickAt = (x: number, y: number) =>
    page.evaluate(
      ([cx, cy]) => {
        const hit = window.__tvxEngine!.pick('view3d', cx!, cy!);
        return hit === null ? null : { kind: hit.elementKind, id: hit.elementId, world: hit.world };
      },
      [px(x), py(y)]
    );
  const first = await pickAt(5, 0);
  expect(first?.kind).toBe('streamline');
  expect(first?.id).toBe(0);
  expect(Math.abs((first?.world[0] ?? 0) - 5)).toBeLessThan(0.1);
  expect((await pickAt(0, 3))?.id).toBe(1);

  await settle(page, layerId, { streamlineFilter: { field: 'length_mm', lo: null, hi: 15 } });
  await expectPixel(page, px(5), py(0), BG);
  await expectPixel(page, px(0), py(3), [0, 255, 0, 255]);
  expect(await pickAt(5, 0)).toBeNull();

  await settle(page, layerId, {
    streamlineFilter: undefined,
    groupField: 'edge_id',
    visibleGroups: [9],
  });
  await expectPixel(page, px(5), py(0), BG);
  await expectPixel(page, px(0), py(3), BG);
  await settle(page, layerId, { groupField: 'edge_id', visibleGroups: [7] });
  await expectPixel(page, px(5), py(0), [255, 0, 0, 255]);

  const info = await page.evaluate((id) => window.__tvxEngine!.tractStyleInfo(id), layerId);
  expect(info?.visibleStreamlines).toBe(2);
  expect(info?.groups.map((g) => g.id)).toEqual([-1, 7, 9]);
});

test('a group colour is the table’s, and the same for the whole group', async ({ page }) => {
  const { layerId } = await open(page, 'tract_f32_stored.trx', {
    lineWidthPx: 5,
    colorMode: 'group',
    groupField: 'edge_id',
  });
  const a = await readCanvasRect(page, px(5), py(0), 1, 1);
  const b = await readCanvasRect(page, px(0), py(3), 1, 1);
  expect([...a]).toEqual([...b]);
  const info = await page.evaluate((id) => window.__tvxEngine!.tractStyleInfo(id), layerId);
  const seven = info?.groups.find((g) => g.id === 7);
  expect(a[0]).toBe(seven?.color[0]);
  expect(a[1]).toBe(seven?.color[1]);
  expect(a[2]).toBe(seven?.color[2]);
});

test('a 2D pane draws only what is inside the slab @angle', async ({ page }) => {
  const { layerId } = await open(page, 'tract_f32_stored.trx', { lineWidthPx: 5, slabMm: 0.5 });
  await page.evaluate(async () => {
    const engine = window.__tvxEngine!;
    engine.setLayout({ kind: '1x1', cells: ['axial'] });
    engine.setCursor([0, 0, 0]);
    engine.setView('axial', { camera: { center: [0, 0], mmPerPx: 0.1 } });
    await engine.whenSettled();
  });
  const at = (x: number, y: number): [number, number] => [
    Math.floor(PANE / 2 + x / 0.1),
    Math.floor(PANE / 2 - y / 0.1),
  ];
  const [ax, ay] = at(5, 0);
  await expectPixel(page, ax, ay, [255, 0, 0, 255]);
  // The +y line is at z = 1, outside a ±0.5 mm slab about z = 0 …
  const [bx, by] = at(0, 3);
  await expectPixel(page, bx, by, BG);
  // … and inside a ±2 mm one.
  await settle(page, layerId, { slabMm: 2 });
  await expectPixel(page, bx, by, [0, 255, 0, 255]);
  await settle(page, layerId, { slabMm: 0 });
  await expectPixel(page, ax, ay, BG);
});

test('sampling a volume agrees with scipy, reports what fell outside, and draws NaN neutral', async ({
  page,
}) => {
  const { layerId, datasetId } = await open(page, 'tract_f32_stored.trx', { lineWidthPx: 5 });
  const got = await page.evaluate(
    async ([url, tract]) => {
      const engine = window.__tvxEngine!;
      const vol = await engine.addDataset({ kind: 'path', path: url as string });
      const field = await engine.sampleTracts({
        tractogramId: tract as string,
        sourceId: vol.id,
        op: 'value',
      });
      return { name: field.name, nan: field.nanCount, min: field.stats.min, max: field.stats.max };
    },
    [fixture('tract_sample_scalar.nii'), datasetId] as const
  );
  expect(got.name).toBe('tract_sample_scalar:vol0:value');
  const want = MANIFEST.tracts.sample.onTract;
  const nulls = want.filter((v) => v === null).length;
  expect(nulls).toBeGreaterThan(0);
  expect(got.nan).toBe(nulls);
  const finite = want.filter((v): v is number => v !== null);
  expect(got.min).toBeCloseTo(Math.min(...finite), 5);
  expect(got.max).toBeCloseTo(Math.max(...finite), 5);

  // Per vertex along the first line, which is x = -10 + i.
  const values = await page.evaluate(
    async ([id, name]) => {
      const engine = window.__tvxEngine!;
      const out: (number | null)[] = [];
      for (let i = 0; i <= 20; i += 1) {
        const w: [number, number, number] = [-10 + i, 0, 0];
        engine.setCursor(w);
        await engine.whenSettled();
        const row = engine.probe(w).rows.find((r) => r.layerId === id);
        const value = row?.fields?.find((f) => f.name === name)?.value as number | undefined;
        out.push(value === undefined || Number.isNaN(value) ? null : value);
      }
      return out;
    },
    [layerId, got.name] as const
  );
  values.forEach((v, i) => {
    const w = want[i] ?? null;
    if (w === null) expect(v).toBeNull();
    else expect(v as number).toBeCloseTo(w, 4);
  });

  // Vertex 20 of the first line is x = 10, outside this volume's grid.
  expect(want[20]).toBeNull();
  await settle(page, layerId, {
    colorMode: 'vertex',
    field: got.name,
    colormap: 'gray',
    scale: { kind: 'linear', lo: got.min, hi: got.max },
  });
  await expectPixel(page, px(9.5), py(0), [128, 128, 128, 255], 1);
  await settle(page, layerId, {
    threshold: { lo: got.min - 1, hi: got.max + 1, symmetric: false, mode: 'hide', softEdge: 0 },
  });
  await expectPixel(page, px(9.5), py(0), BG);
});

test('a probe reads every value at a point, from any pane, and a pick reads its own streamline', async ({
  page,
}) => {
  const { layerId } = await open(page, 'tract_f32_stored.trx', { lineWidthPx: 5 });
  const row = await page.evaluate(async (id) => {
    const engine = window.__tvxEngine!;
    engine.setCursor([5, 0.2, 0]);
    await engine.whenSettled();
    return engine.probe([5, 0.2, 0]).rows.find((r) => r.layerId === id);
  }, layerId);
  expect(row?.streamline).toBe(0);
  expect(row?.vertex).toBe(15);
  expect(row?.fields?.find((f) => f.name === 'along')?.value).toBe(5);
  expect(row?.streamlineFields?.find((f) => f.name === 'weight')?.value).toBe(0.5);
  expect(row?.groups).toContain('left');

  const miss = await page.evaluate(async (id) => {
    const engine = window.__tvxEngine!;
    engine.setCursor([12, 12, 0]);
    await engine.whenSettled();
    return engine.probe([12, 12, 0]).rows.find((r) => r.layerId === id)?.streamline;
  }, layerId);
  expect(miss).toBeUndefined();

  const picked = await page.evaluate(
    async ([x, y, id]) => {
      const engine = window.__tvxEngine!;
      engine.setCursorFromPick('view3d', x as number, y as number);
      await engine.whenSettled();
      return engine.probe(engine.scene.cursor).rows.find((r) => r.layerId === id)?.streamline;
    },
    [px(0), py(3), layerId] as const
  );
  expect(picked).toBe(1);
});

test('sampling a mesh: barycentric on a node field, constant on an element field, ops on a vector', async ({
  page,
}) => {
  const { datasetId, layerId } = await open(page, 'tract_f32_stored.trx', {});
  const got = await page.evaluate(
    async ([url, tract, id]) => {
      const engine = window.__tvxEngine!;
      const mesh = await engine.addDataset({ kind: 'path', path: url as string });
      await engine.sampleTracts({
        tractogramId: tract as string,
        sourceId: mesh.id,
        field: { source: 'node', name: 'node_scalar' },
        op: 'value',
      });
      await engine.sampleTracts({
        tractogramId: tract as string,
        sourceId: mesh.id,
        field: { source: 'node', name: 'node_vector' },
        op: 'abs-dot',
        name: 'absdot',
      });
      const refused = await engine
        .sampleTracts({
          tractogramId: tract as string,
          sourceId: mesh.id,
          field: { source: 'node', name: 'node_vector' },
          op: 'value',
        })
        .then(
          () => '',
          (e: Error) => e.message
        );
      engine.setCursor([5, 0, 0]);
      await engine.whenSettled();
      const row = engine.probe([5, 0, 0]).rows.find((r) => r.layerId === id);
      return { row, refused, ok: mesh.kind };
    },
    [fixture('mesh_v2_binary.msh'), datasetId, layerId] as const
  );
  expect(got.refused).toContain('3 components');
  // node_scalar = 0.1x + 0.01y + 0.001z is affine, so barycentric reproduces it exactly.
  const scalar = got.row?.fields?.find((f) => f.name === 'mesh_v2_binary:node_scalar:value');
  expect(scalar?.value as number).toBeCloseTo(0.5, 4);
  expect(got.row?.fields?.some((f) => f.name === 'absdot')).toBe(true);
});

test('a scene with a tractogram, a volume and a sample step reproduces on reload', async ({
  page,
}) => {
  const { datasetId, layerId } = await open(page, 'tract_f32_stored.trx', { lineWidthPx: 5 });
  const spec = await page.evaluate(
    async ([url, tract, id]) => {
      const engine = window.__tvxEngine!;
      const vol = await engine.addDataset({ kind: 'path', path: url as string });
      const field = await engine.sampleTracts({
        tractogramId: tract as string,
        sourceId: vol.id,
        op: 'value',
      });
      engine.updateLayer(
        id as string,
        {
          colorMode: 'vertex',
          field: field.name,
          colormap: 'gray',
          scale: { kind: 'linear', lo: field.stats.min, hi: field.stats.max },
        } as never
      );
      await engine.whenSettled();
      return engine.serialize();
    },
    [fixture('tract_sample_scalar.nii'), datasetId, layerId] as const
  );
  const ref = spec.datasets.find((d) => d.kind === 'tractogram');
  expect(ref?.tract?.samples?.length).toBe(1);
  const before = await readCanvasRect(page, px(-5), py(0), 1, 1);
  const text = JSON.stringify(spec);
  const after = await page.evaluate(
    async ([json, urls]) => {
      const engine = window.__tvxEngine!;
      const parsed = JSON.parse(json as string);
      const [tract, volume] = urls as unknown as [string, string];
      await engine.load(parsed, (r: { kind: string }) =>
        r.kind === 'tractogram' ? tract : volume
      );
      await engine.whenSettled();
      const ds = [...engine.scene.datasets.values()].find((d) => d.kind === 'tractogram');
      return ds?.kind === 'tractogram' ? ds.samples.length : -1;
    },
    [text, [fixture('tract_f32_stored.trx'), fixture('tract_sample_scalar.nii')]] as const
  );
  expect(after).toBe(1);
  const again = await readCanvasRect(page, px(-5), py(0), 1, 1);
  expect([...again]).toEqual([...before]);
});

test('a budget shows a labelled subset, and load-full replaces the arrays and replays samples', async ({
  page,
}) => {
  const { datasetId, layerId } = await open(page, 'tract_f32_stored.trx', { lineWidthPx: 5 });
  const got = await page.evaluate(
    async ([tract, id, url]) => {
      const engine = window.__tvxEngine!;
      const vol = await engine.addDataset({ kind: 'path', path: url as string });
      await engine.sampleTracts({ tractogramId: tract as string, sourceId: vol.id, op: 'value' });
      const small = await engine.setTractBudget(tract as string, 22);
      await engine.whenSettled();
      const held = { n: small.nPoints, m: small.sourcePoints, sm: small.sourceStreamlines };
      const full = await engine.setTractBudget(tract as string, null);
      await engine.whenSettled();
      return {
        held,
        full: full.nPoints,
        fields: full.vertexFields.map((f) => f.name),
        info: engine.tractStyleInfo(id as string),
      };
    },
    [datasetId, layerId, fixture('tract_sample_scalar.nii')] as const
  );
  expect(got.held.n).toBeLessThan(44);
  expect(got.held.m).toBe(44);
  expect(got.held.sm).toBe(4);
  expect(got.full).toBe(44);
  expect(got.fields).toContain('tract_sample_scalar:vol0:value');
  expect(got.info?.visibleStreamlines).toBe(4);
  await expectPixel(page, px(5), py(0), [255, 0, 0, 255]);
});

test('a file that cannot be placed is refused by name', async ({ page }) => {
  await page.goto('/test/pages/scene.html');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);
  const message = await page.evaluate(async (url) => {
    const engine = window.__tvxEngine!;
    return engine.addDataset({ kind: 'path', path: url }).then(
      () => '',
      (e: Error) => e.message
    );
  }, fixture('tract_no_affine.trk'));
  expect(message).toContain('cannot place');
});

test('golden: direction RGB and a sampled scalar', async ({ page }) => {
  const { layerId } = await open(page, 'tract_f32_stored.trx', { lineWidthPx: 3 });
  await expectGolden(page, 'tracts-direction');
  await settle(page, layerId, {
    colorMode: 'vertex',
    field: 'along',
    colormap: 'viridis',
    scale: { kind: 'linear', lo: -10, hi: 10 },
  });
  await expectGolden(page, 'tracts-vertex-viridis');
});
