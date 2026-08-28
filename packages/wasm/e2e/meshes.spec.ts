/**
 * Every committed fixture mesh and surface through the real worker, asserted against
 * `testdata/manifest.json` — whose mesh numbers came from `simnibs.mesh_io` and the Gmsh 4.14 Python
 * API reading the fixtures back (§11).
 *
 * The load path (`read_msh` / `read_gifti` / FreeSurfer / STL / PLY / OBJ, the sidecars, the §6.2 tag
 * ladder and the §6.5.1 `MeshMeta`) does not depend on `tvx-geom`, so all of it runs today. The ops
 * that do — `surface`, `boundary`, `cut`, … — are `geometry.spec.ts`'s.
 */

import { expect, test } from '@playwright/test';

import { MANIFEST, call, fixtureUrl, meshEntry, must, open } from './fixtures';

interface TagEntry {
  id: number;
  name?: string;
  color: [number, number, number, number];
  kind: 'tri' | 'tet';
  count: number;
}

function tagsOf(meta: Record<string, unknown>, kind: 'tri' | 'tet'): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of meta.tags as TagEntry[]) {
    if (t.kind === kind) out[String(t.id)] = t.count;
  }
  return out;
}

test.beforeEach(async ({ page }) => {
  await open(page);
});

test('every .msh dialect lands on the same MeshMeta', async ({ page }) => {
  // v2 ascii, v2 binary in both committed dialects, and v4.1 ascii + binary all describe the same
  // 27-node lattice; the manifest's `gmsh` block is the Gmsh Python API's own reading of each file.
  const names = [
    'mesh_v2_ascii.msh',
    'mesh_v2_binary.msh',
    'mesh_v41_ascii.msh',
    'mesh_v41_binary.msh',
  ];
  for (const name of names) {
    const want = meshEntry('msh', name);
    // v2 entries nest the reader's own reading under `gmsh`; the v4.1 entries, which SimNIBS
    // refuses to read at all, carry the Gmsh API's numbers at the top level.
    const gmsh = (want.gmsh ?? want) as Record<string, unknown>;
    const out = await must(page, 'loadMesh', {
      source: { kind: 'url', url: fixtureUrl(name) },
      format: 'auto',
    });
    const meta = out.result?.meta as Record<string, unknown>;

    expect(meta.name, name).toBe(name);
    expect(meta.nNodes, name).toBe(want.nodes);
    expect(meta.nTris, name).toBe((gmsh.elementsByGmshType as Record<string, number>)['2']);
    expect(meta.nTets, name).toBe((gmsh.elementsByGmshType as Record<string, number>)['4']);
    expect(meta.hasTris, name).toBe(true);
    expect(tagsOf(meta, 'tri'), name).toEqual(gmsh.physicalTagCountsDim2);
    expect(tagsOf(meta, 'tet'), name).toEqual(gmsh.physicalTagCountsDim3);

    const bounds = meta.bounds as { min: number[]; max: number[] };
    const bbox = gmsh.bbox as { min: number[]; max: number[] };
    expect(bounds.min, name).toEqual(bbox.min.map((v) => expect.closeTo(v, 4)));
    expect(bounds.max, name).toEqual(bbox.max.map((v) => expect.closeTo(v, 4)));

    // §6.5.2: `loadMesh`'s result is `{ meta }` and nothing else — no bulk arrays cross to the UI
    // thread (§4.3, AGENTS rule 7).
    expect(Object.keys(out.result ?? {}), name).toEqual(['meta']);
  }
});

test('the tri-less mesh reports 0 tris and `hasTris: false` (§6.3)', async ({ page }) => {
  const want = meshEntry('msh', 'mesh_tetonly.msh');
  const out = await must(page, 'loadMesh', {
    source: { kind: 'url', url: fixtureUrl('mesh_tetonly.msh') },
    format: 'auto',
  });
  const meta = out.result?.meta as Record<string, unknown>;
  expect(meta.nTris).toBe(0);
  expect(meta.nTets).toBe(want.tets);
  expect(meta.hasTris).toBe(false);
  // The `$PhysicalNames` rung of §6.2's ladder, with no sidecars in sight.
  const names = (meta.tags as TagEntry[]).map((t) => t.name);
  expect(names).toEqual(['Tissue_A', 'Tissue_B']);
});

test('$NodeData / $ElementData reach MeshMeta.fields with the manifest stats', async ({ page }) => {
  const name = 'mesh_v2_binary.msh';
  const want = meshEntry('msh', name);
  const out = await must(page, 'loadMesh', {
    source: { kind: 'url', url: fixtureUrl(name) },
    format: 'auto',
  });
  const meta = out.result?.meta as Record<string, unknown>;
  const fields = meta.fields as Array<Record<string, unknown>>;
  const wanted = want.fields as Array<Record<string, unknown>>;
  expect(fields.map((f) => f.name).sort()).toEqual(wanted.map((f) => f.name).sort());

  for (const w of wanted) {
    const got = fields.find((f) => f.name === w.name);
    expect(got, String(w.name)).toBeDefined();
    expect(got?.source, String(w.name)).toBe(w.source);
    expect(got?.ncomp, String(w.name)).toBe(w.ncomp);
    expect(got?.n, String(w.name)).toBe(w.n);
    expect(got?.partial, String(w.name)).toBe(false);
    // §6.0: `stats` is of the MAGNITUDE when `ncomp > 1`, of the values themselves otherwise.
    const stats = (w.magnitudeStats ?? w.stats) as Record<string, number>;
    const s = got?.stats as Record<string, number>;
    expect(s.min, String(w.name)).toBeCloseTo(stats.min!, 4);
    expect(s.max, String(w.name)).toBeCloseTo(stats.max!, 4);
  }
});

test('a gap in $ElementData is NaN plus `partial: true` (§6.2)', async ({ page }) => {
  const want = meshEntry('msh', 'mesh_noncontig.msh');
  const out = await must(page, 'loadMesh', {
    source: { kind: 'url', url: fixtureUrl('mesh_noncontig.msh') },
    format: 'auto',
  });
  const meta = out.result?.meta as Record<string, unknown>;
  const fields = meta.fields as Array<Record<string, unknown>>;
  const wanted = want.fields as Array<Record<string, unknown>>;

  const gap = fields.find((f) => f.name === 'elm_gap');
  const gapWanted = wanted.find((f) => f.name === 'elm_gap');
  expect(gap?.partial, 'elm_gap covers 52 of 104 elements').toBe(true);
  expect((gap?.stats as Record<string, number>).min).toBeCloseTo(
    (gapWanted?.stats as Record<string, number>).min!,
    4
  );

  const full = fields.find((f) => f.name === 'elm_scalar');
  expect(full?.partial, 'elm_scalar covers every element').toBe(false);

  // The `field` op reads the gap back: 104 elements, half of them NaN.
  const values = await must(page, 'field', {
    handle: meta.handle as number,
    source: 'elm',
    name: 'elm_gap',
    component: 'mag',
  });
  const v = values.result?.values as { length: number; nonFinite: number };
  expect(v.length).toBe(104);
  expect(v.nonFinite).toBe(104 - (gapWanted?.n as number));
  expect(values.result?.partial).toBe(true);
});

test('the §6.2 tag ladder: $PhysicalNames, then _LUT.txt, then .msh.opt', async ({ page }) => {
  const lut = MANIFEST.sidecars?.['mesh_v2_binary_LUT.txt'] as Record<string, unknown>;
  const lutEntries = lut.expected as Array<Record<string, unknown>>;

  // 1. No sidecars: `$PhysicalNames` names the tags and the palette colours them.
  await open(page);
  const bare = await must(page, 'loadMesh', {
    source: { kind: 'url', url: fixtureUrl('mesh_v2_binary.msh') },
    format: 'auto',
  });
  const bareTags = (bare.result?.meta as Record<string, unknown>).tags as TagEntry[];
  expect(bareTags.map((t) => `${t.id}:${t.name ?? ''}`)).toEqual([
    '1:Tissue_A',
    '2:Tissue_B',
    '1001:Tissue_A_surface',
    '1002:Tissue_B_surface',
  ]);

  // 2. With the LUT: its colours win, id for id.
  await open(page);
  const withLut = await must(page, 'loadMesh', {
    source: {
      kind: 'url',
      url: fixtureUrl('mesh_v2_binary.msh'),
      sidecars: { lut: fixtureUrl('mesh_v2_binary_LUT.txt') },
    },
    format: 'auto',
  });
  const lutTags = (withLut.result?.meta as Record<string, unknown>).tags as TagEntry[];
  for (const e of lutEntries) {
    const got = lutTags.find((t) => t.id === e.id);
    expect(got?.color, `tag ${String(e.id)}`).toEqual(e.rgba255);
  }

  // 3. With the .msh.opt only: `MeshMeta.opt` carries it verbatim, and its `Mesh.Color.<Ordinal>`
  //    colours the tags — including §6.2's `1xxx` → `1xxx − 1000` inheritance.
  await open(page);
  const withOpt = await must(page, 'loadMesh', {
    source: {
      kind: 'url',
      url: fixtureUrl('mesh_v2_binary.msh'),
      sidecars: { opt: fixtureUrl('mesh_v2_binary.msh.opt') },
    },
    format: 'auto',
  });
  const optMeta = withOpt.result?.meta as Record<string, unknown>;
  const expectedOpt = (MANIFEST.sidecars?.['mesh_v2_binary.msh.opt'] as Record<string, unknown>)
    .expected as Record<string, unknown>;
  const opt = optMeta.opt as Record<string, unknown>;
  expect(opt.tagColor).toEqual(expectedOpt.tagColor);
  expect(opt.tagVisible).toEqual(expectedOpt.tagVisible);
  expect(opt.views).toEqual(
    (expectedOpt.views as Array<Record<string, unknown>>).map((v) => {
      const { name: _name, ...rest } = v;
      return rest;
    })
  );

  const optTags = (optMeta.tags as TagEntry[]).map((t) => [t.id, t.color] as const);
  const wantColor = expectedOpt.tagColor as Record<string, number[]>;
  for (const [id, color] of optTags) {
    expect(color, `tag ${id} takes its colour from Mesh.Color.<Ordinal>`).toEqual(
      wantColor[String(id)]
    );
  }
});

test('every GIfTI encoding lands on the same surface (§6.2)', async ({ page }) => {
  for (const name of ['surf_ascii.surf.gii', 'surf_b64.surf.gii', 'surf_gzipb64.surf.gii']) {
    const want = meshEntry('gifti', name);
    const arrays = want.arrays as Array<Record<string, unknown>>;
    const points = arrays.find((a) => a.intent === 'pointset') as Record<string, unknown>;
    const tris = arrays.find((a) => a.intent === 'triangle') as Record<string, unknown>;

    const out = await must(page, 'loadMesh', {
      source: { kind: 'url', url: fixtureUrl(name) },
      format: 'auto',
    });
    const meta = out.result?.meta as Record<string, unknown>;
    expect(meta.nNodes, name).toBe((points.dims as number[])[0]);
    expect(meta.nTris, name).toBe((tris.dims as number[])[0]);
    expect(meta.nTets, name).toBe(0);

    // §3/§6.2: the CoordinateSystemTransformMatrix is BAKED IN when the target space is
    // scanner-anatomical, so the delivered bounds are the *transformed* ones.
    const bounds = meta.bounds as { min: number[]; max: number[] };
    const bbox = points.bboxTransformed as { min: number[]; max: number[] };
    expect(bounds.min, name).toEqual(bbox.min.map((v) => expect.closeTo(v, 4)));
    expect(bounds.max, name).toEqual(bbox.max.map((v) => expect.closeTo(v, 4)));
  }
});

test('a .label.gii brings its <LabelTable> as MeshMeta.labelTables (§6.5.1)', async ({ page }) => {
  const want = meshEntry('gifti', 'surf.label.gii');
  const out = await must(page, 'loadMesh', {
    source: { kind: 'url', url: fixtureUrl('surf.label.gii') },
    format: 'gii',
  });
  const meta = out.result?.meta as Record<string, unknown>;
  const tables = meta.labelTables as Record<string, Array<Record<string, unknown>>>;
  const keys = Object.keys(tables);
  expect(keys).toHaveLength(1);

  const table = tables[keys[0]!]!;
  const expected = want.labelTable as Array<Record<string, unknown>>;
  expect(table).toHaveLength(expected.length);
  for (const [i, e] of expected.entries()) {
    expect(table[i]?.id, `entry ${i}`).toBe(e.key);
    expect(table[i]?.name, `entry ${i}`).toBe(e.name);
    expect(table[i]?.color, `entry ${i}`).toEqual(e.rgba255);
  }

  // The array itself is a node field, and `field` reads it back — **as dense indices**, not as the
  // file's own keys. §6.2's remap: the renderer's label palette is indexed by position in
  // `LabelTable.entries`, so a `.label.gii` is remapped at parse time exactly as a `.annot` is, and
  // the original key is kept in `LabelEntry.id` (asserted above). The fixture's keys are 0/3/7/11
  // cycling over 16 vertices, so the field runs 0..3 where the manifest's *array* stats — which
  // nibabel took off the raw file — say 0..11.
  const array = (want.arrays as Array<Record<string, unknown>>)[0]!;
  const stats = array.stats as Record<string, number>;
  expect(stats.max, 'the file itself holds the sparse key').toBe(11);
  const values = await must(page, 'field', {
    handle: meta.handle as number,
    source: 'node',
    name: keys[0]!,
    component: 'mag',
  });
  const v = values.result?.values as { length: number; min: number; max: number };
  expect(v.length).toBe((array.dims as number[])[0]);
  expect(v.min).toBe(0);
  expect(v.max, 'remapped to a dense 0..N-1 index').toBe(expected.length - 1);
});

test('a .func.gii is a node field, not a surface', async ({ page }) => {
  const want = meshEntry('gifti', 'surf.func.gii');
  const array = (want.arrays as Array<Record<string, unknown>>)[0]!;
  const out = await must(page, 'loadMesh', {
    source: { kind: 'url', url: fixtureUrl('surf.func.gii') },
    format: 'gii',
  });
  const meta = out.result?.meta as Record<string, unknown>;
  expect(meta.nNodes).toBe(0);
  expect(meta.nTris).toBe(0);
  const fields = meta.fields as Array<Record<string, unknown>>;
  expect(fields).toHaveLength(1);
  expect(fields[0]?.source).toBe('node');
  expect(fields[0]?.n).toBe((array.dims as number[])[0]);
  const stats = array.stats as Record<string, number>;
  expect((fields[0]?.stats as Record<string, number>).max).toBeCloseTo(stats.max!, 4);
});

test('FreeSurfer, STL, PLY and OBJ all reach MeshMeta (§6.2)', async ({ page }) => {
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ['lh.fixture.surf', 'fs', meshEntry('freesurfer', 'lh.fixture.surf')],
    ['patch_ascii.stl', 'auto', meshEntry('surfaces', 'patch_ascii.stl')],
    ['patch_binary.stl', 'auto', meshEntry('surfaces', 'patch_binary.stl')],
    ['patch_tri_ascii.ply', 'auto', meshEntry('surfaces', 'patch_tri_ascii.ply')],
    ['patch_tri_binary.ply', 'auto', meshEntry('surfaces', 'patch_tri_binary.ply')],
    ['patch_quad_ascii.ply', 'auto', meshEntry('surfaces', 'patch_quad_ascii.ply')],
    ['patch_tri.obj', 'auto', meshEntry('surfaces', 'patch_tri.obj')],
    ['patch_quad.obj', 'auto', meshEntry('surfaces', 'patch_quad.obj')],
  ];

  for (const [name, format, want] of cases) {
    await open(page);
    const out = await must(page, 'loadMesh', {
      source: { kind: 'url', url: fixtureUrl(name) },
      format: format as 'auto' | 'fs',
    });
    const meta = out.result?.meta as Record<string, unknown>;
    expect(meta.nTets, name).toBe(0);
    expect(meta.hasTris, name).toBe(true);

    const bbox = want.bbox as { min: number[]; max: number[] };
    const bounds = meta.bounds as { min: number[]; max: number[] };
    expect(bounds.min, name).toEqual(bbox.min.map((v) => expect.closeTo(v, 4)));
    expect(bounds.max, name).toEqual(bbox.max.map((v) => expect.closeTo(v, 4)));

    // An n-gon file triangulates: 9 quads become 18 triangles (§6.2). Gmsh's own PLY reader keeps
    // only one triangle per quad, so the manifest records the truth for `patch_quad_ascii.ply`
    // under `expectedFromEquivalentObj` — the identical geometry written as an OBJ.
    const truth = (want.expectedFromEquivalentObj ?? want) as Record<string, unknown>;
    const byType = (truth.elementsByGmshType ?? {}) as Record<string, number>;
    const expectedTris = (byType['2'] ?? 0) + (byType['3'] ?? 0) * 2;
    if (expectedTris > 0) expect(meta.nTris, name).toBe(expectedTris);
    else expect(meta.nTris, name).toBe(want.tris);
  }
});

test('an unreadable source is `io`, and a mesh that is not one is `parse` (§6.5)', async ({
  page,
}) => {
  const missing = await call(page, 'loadMesh', {
    source: { kind: 'url', url: fixtureUrl('there-is-no-such-file.msh') },
    format: 'auto',
  });
  expect(missing.ok).toBe(false);
  expect(missing.error?.code).toBe('io');

  const notAMesh = await call(page, 'loadMesh', {
    source: { kind: 'url', url: fixtureUrl('vol_u8.nii') },
    format: 'auto',
  });
  expect(notAMesh.ok).toBe(false);
  expect(['parse', 'unsupported']).toContain(notAMesh.error?.code);
});
