/**
 * §6.5.2 `attachField` (2026-09-06) — per-vertex data from a second file onto a loaded surface,
 * through the real worker.
 *
 * The load-bearing assertion is the **cross-check against `field`**: what `attachField` reports
 * in its `fields` summary must be exactly what the worker then serves for that name, and the dense
 * indices must be the manifest's (`nib.freesurfer.read_annot` read the fixture back). The refusal
 * path is asserted on a mesh whose node count is not the annotation's, and on the mesh being
 * untouched afterwards.
 */

import { expect, test } from '@playwright/test';

import { call, fixtureUrl, meshEntry, must, open, sample } from './fixtures';

test.beforeEach(async ({ page }) => {
  await open(page);
});

async function loadSurface(page: Parameters<typeof must>[0]): Promise<number> {
  const out = await must(page, 'loadMesh', {
    source: { kind: 'url', url: fixtureUrl('lh.fixture.surf') },
    format: 'fs',
  });
  return (out.result?.meta as { handle: number }).handle;
}

test('a .annot attaches as a node field named after the file, with its colortable', async ({
  page,
}) => {
  const handle = await loadSurface(page);
  const out = await must(page, 'attachField', {
    handle,
    source: { kind: 'url', url: fixtureUrl('lh.fixture.annot') },
  });
  const result = out.result as {
    fields: { name: string; source: string; ncomp: number; n: number }[];
    labelTables?: Record<string, { id: number; name: string; color: number[] }[]>;
  };
  const rec = meshEntry('freesurfer', 'lh.fixture.annot') as {
    n: number;
    denseLabels: number[];
    colortable: { denseIndex: number; name: string; packedId: number; rgba255: number[] }[];
  };
  expect(result.fields).toEqual([
    expect.objectContaining({ name: 'lh.fixture.annot', source: 'node', ncomp: 1, n: rec.n }),
  ]);
  const table = result.labelTables?.['lh.fixture.annot'];
  expect(table, 'the table is keyed by the field that holds its dense indices').toBeDefined();
  expect(table!.map((e) => [e.id, e.name])).toEqual(
    rec.colortable.map((e) => [e.packedId, e.name])
  );

  // The field is now the worker's to serve, and it is the manifest's dense remap.
  const field = await must(page, 'field', {
    handle,
    source: 'node',
    name: 'lh.fixture.annot',
    component: 'mag',
  });
  expect((field.result as { n: number }).n).toBe(rec.n);
  const values = await sample(
    page,
    'values',
    Array.from({ length: rec.n }, (_, i) => i)
  );
  expect(values).toEqual(rec.denseLabels);

  // Attaching the same file again replaces, never duplicates: one field, one table.
  const again = await must(page, 'attachField', {
    handle,
    source: { kind: 'url', url: fixtureUrl('lh.fixture.annot') },
  });
  expect((again.result as { fields: unknown[] }).fields).toHaveLength(1);
});

test('a morph file attaches as a scalar with no table; a data-only GIfTI by content', async ({
  page,
}) => {
  const handle = await loadSurface(page);
  const curv = await must(page, 'attachField', {
    handle,
    source: { kind: 'url', url: fixtureUrl('lh.fixture.curv') },
  });
  const crec = meshEntry('freesurfer', 'lh.fixture.curv') as {
    n: number;
    stats: { min: number; max: number };
  };
  const cres = curv.result as {
    fields: { name: string; n: number; stats: { min: number; max: number } }[];
    labelTables?: unknown;
  };
  expect(cres.fields[0]).toEqual(expect.objectContaining({ name: 'lh.fixture.curv', n: crec.n }));
  expect(cres.fields[0]!.stats.min).toBeCloseTo(crec.stats.min, 5);
  expect(cres.fields[0]!.stats.max).toBeCloseTo(crec.stats.max, 5);
  expect(cres.labelTables).toBeUndefined();

  const label = await must(page, 'attachField', {
    handle,
    source: { kind: 'url', url: fixtureUrl('surf.label.gii') },
  });
  const lres = label.result as { labelTables?: Record<string, { id: number }[]> };
  expect(lres.labelTables?.['surf.label.gii']?.map((e) => e.id)).toEqual([0, 3, 7, 11]);
});

test('a vertex-count mismatch is a parse error naming both counts, and keeps the mesh', async ({
  page,
}) => {
  const loaded = await must(page, 'loadMesh', {
    source: { kind: 'url', url: fixtureUrl('mesh_v2_binary.msh') },
    format: 'auto',
  });
  const meta = loaded.result?.meta as { handle: number; nNodes: number; fields: unknown[] };
  expect(meta.nNodes).not.toBe(16);
  const out = await call(page, 'attachField', {
    handle: meta.handle,
    source: { kind: 'url', url: fixtureUrl('lh.fixture.annot') },
  });
  expect(out.error?.code).toBe('parse');
  expect(out.error?.message).toContain('16 vertices');
  expect(out.error?.message).toContain(`${meta.nNodes}`);
  // Untouched: the field the annotation would have added is not there to serve.
  const field = await call(page, 'field', {
    handle: meta.handle,
    source: 'node',
    name: 'lh.fixture.annot',
    component: 'mag',
  });
  expect(field.error).toBeDefined();
});
