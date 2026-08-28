/**
 * The eleven §6.5.2 ops that run through `tvx-geom` (§6.3), over the fixture lattice.
 *
 * The lattice is a 3×3×3 node grid spanning −10…10, cut into 8 cells × 6 tets = 48 tets under two
 * physical tags (24 each) with 56 stored triangles (24 tagged 1001, 32 tagged 1002). Every
 * expectation below is derived from that geometry and from §6.3's own rules, not from a previous
 * run: the outer surface of a 2×2×2 stack of cells is 6 faces × 4 squares × 2 triangles = 48, the
 * tag interface is one 2×2 plane = 8, and 48 + 8 = 56 is exactly the stored triangle count — which
 * is §6.3's "the stored tris are exactly the exterior ∪ inter-tissue-interface face set", on a mesh
 * small enough to check by hand.
 *
 * **`tvx-geom` is still the Phase-0 `unimplemented!()` stub on `main`.** `tvx-wasm` therefore builds
 * its §6.3 call sites behind a default-off `geom` cargo feature, so a stub answers `unsupported`
 * instead of trapping the module (`crates/tvx-wasm/src/geom.rs`, `docs/DECISIONS.md`). These specs
 * ask the module itself which world it is in, so the day the feature is turned on they start
 * asserting with no edit here.
 */

import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import type { ArraySummary } from './fixtures';
import {
  CAPS_FULL,
  GEOM_SKIP,
  call,
  fixtureUrl,
  geomAvailable,
  must,
  open,
  sample,
  volume,
} from './fixtures';

/** 6 faces × 4 squares × 2 triangles: the exterior of the 2×2×2 cell lattice. */
const EXTERIOR_TRIS = 48;
/** One 2×2 plane of squares between the two physical tags. */
const INTERFACE_TRIS = 8;
/** 48 tets × 4 faces = 192 slots; 48 singletons + 72 shared pairs = 120 unique faces. */
const UNIQUE_FACES = 120;

async function loadLattice(page: Page, name = 'mesh_v2_binary.msh'): Promise<number> {
  await open(page);
  const out = await must(page, 'loadMesh', {
    source: { kind: 'url', url: fixtureUrl(name) },
    format: 'auto',
  });
  return (out.result?.meta as { handle: number }).handle;
}

test('while tvx-geom is a stub, every geometry op says so and the module survives', async ({
  page,
}) => {
  test.skip(await geomAvailable(page), 'tvx-geom is built in; the specs below assert its output');

  const handle = await loadLattice(page);
  const meshOps: Array<[string, () => Promise<{ ok: boolean; error?: { code: string } }>]> = [
    ['surface', () => call(page, 'surface', { handle, variant: 'indexed' })],
    ['boundary', () => call(page, 'boundary', { handle, variant: 'indexed' })],
    ['buildTopology', () => call(page, 'buildTopology', { handle })],
    ['cut', () => call(page, 'cut', { handle, planes: [{ normal: [0, 0, 1], offset: -5 }] })],
    ['isolate', () => call(page, 'isolate', { handle, criteria: { tags: [2], combine: 'all' } })],
    [
      'elmToNode',
      () => call(page, 'elmToNode', { handle, direction: 'elmToNode', name: 'elm_scalar' }),
    ],
    ['locate', () => call(page, 'locate', { handle, world: [0, 0, 0] })],
    [
      'marchingTets',
      () =>
        call(page, 'marchingTets', {
          handle,
          source: 'node',
          name: 'node_scalar',
          component: 'mag',
          iso: 0,
        }),
    ],
    [
      'contours',
      () => call(page, 'contours', { handle, plane: { normal: [0, 0, 1], offset: -5 } }),
    ],
    ['meshCentroids', () => call(page, 'meshCentroids', { handle, stride: 1 })],
  ];
  for (const [name, run] of meshOps) {
    const out = await run();
    expect(out.ok, name).toBe(false);
    expect(out.error?.code, name).toBe('unsupported');
  }

  // …and the worker is still alive afterwards, which is the whole point of the feature gate: a
  // trapped module would have poisoned it (§5 rule 8).
  const alive = await must(page, 'field', {
    handle,
    source: 'elm',
    name: 'elm_scalar',
    component: 'mag',
  });
  expect((alive.result?.values as ArraySummary).length).toBe(104);

  // The two volume-side geometry ops, on a volume handle so they get past the handle check.
  await open(page);
  const vol = await must(page, 'loadVolume', {
    source: { kind: 'url', url: fixtureUrl('labels_simnibs.nii.gz') },
    caps: CAPS_FULL,
    wantLinear: false,
  });
  const vh = (vol.result?.meta as { handle: number }).handle;
  for (const [name, out] of [
    [
      'marchingCubes',
      await call(page, 'marchingCubes', { handle: vh, volumeIndex: 0, iso: 1, smooth: false }),
    ],
    ['labelCentroids', await call(page, 'labelCentroids', { handle: vh, volumeIndex: 0 })],
  ] as const) {
    expect(out.ok, name).toBe(false);
    expect(out.error?.code, name).toBe('unsupported');
  }
});

test.describe('with tvx-geom built in', () => {
  test('`surface` returns the mesh’s own tagged triangles (§6.3)', async ({ page }) => {
    test.skip(!(await geomAvailable(page)), GEOM_SKIP);
    const handle = await loadLattice(page);

    const indexed = await must(page, 'surface', { handle, variant: 'indexed' });
    const s = indexed.result as Record<string, unknown>;
    expect(s.variant).toBe('indexed');
    expect((s.indices as ArraySummary).length).toBe(3 * (EXTERIOR_TRIS + INTERFACE_TRIS));
    expect((s.ownerElm as ArraySummary).length).toBe(EXTERIOR_TRIS + INTERFACE_TRIS);
    expect((s.faceTag as ArraySummary).length).toBe(EXTERIOR_TRIS + INTERFACE_TRIS);
    expect((s.positions as ArraySummary).length % 3).toBe(0);
    expect((s.normals as ArraySummary).length).toBe((s.positions as ArraySummary).length);
    expect(s.nodeIndex, 'indexed carries nodeIndex (§6.5.1)').toBeDefined();
    expect(s.corner, 'indexed carries no corner ordinal').toBeUndefined();

    // Per-tag ranges cover every triangle exactly once, and the tags are the file's own.
    const perTag = s.perTag as Array<{ tag: number; first: number; count: number }>;
    expect(perTag.map((r) => r.tag).sort((a, b) => a - b)).toEqual([1001, 1002]);
    expect(perTag.reduce((n, r) => n + r.count, 0)).toBe(3 * (EXTERIOR_TRIS + INTERFACE_TRIS));

    // §6.2: every `ownerElm` is a Gmsh element number, and this file numbers 1..104 tris-first.
    const owners = s.ownerElm as ArraySummary;
    expect(owners.min).toBeGreaterThanOrEqual(1);
    expect(owners.max).toBeLessThanOrEqual(56);

    const deindexed = await must(page, 'surface', { handle, variant: 'deindexed' });
    const d = deindexed.result as Record<string, unknown>;
    expect(d.variant).toBe('deindexed');
    expect((d.positions as ArraySummary).length).toBe(3 * 3 * (EXTERIOR_TRIS + INTERFACE_TRIS));
    expect((d.corner as ArraySummary).length).toBe(3 * (EXTERIOR_TRIS + INTERFACE_TRIS));
    expect((d.corner as ArraySummary).max).toBe(2);
    expect(d.indices).toBeUndefined();
  });

  test('a tri-less mesh renders through `extract_boundary` (§6.3)', async ({ page }) => {
    test.skip(!(await geomAvailable(page)), GEOM_SKIP);
    const handle = await loadLattice(page, 'mesh_tetonly.msh');

    // `surface` falls back to the boundary when `hasTris` is false — without it the 3D view is
    // empty, which is the `grey_Thalamus_TI.msh` case §6.3 names.
    const out = await must(page, 'surface', { handle, variant: 'indexed' });
    const faceTag = out.result?.faceTag as ArraySummary;
    expect(faceTag.length).toBe(EXTERIOR_TRIS + INTERFACE_TRIS);
    expect(faceTag.min).toBeGreaterThanOrEqual(1);
    expect(faceTag.max).toBeLessThanOrEqual(2);

    // `boundary` is the same thing asked for by name.
    const explicit = await must(page, 'boundary', { handle, variant: 'indexed' });
    expect((explicit.result?.faceTag as ArraySummary).length).toBe(faceTag.length);
  });

  test('`buildTopology` counts the lattice’s faces exactly', async ({ page }) => {
    test.skip(!(await geomAvailable(page)), GEOM_SKIP);
    const handle = await loadLattice(page, 'mesh_tetonly.msh');
    const out = await must(page, 'buildTopology', { handle });
    expect(out.result?.faces).toBe(UNIQUE_FACES);
    expect(out.result?.boundaryFaces).toBe(EXTERIOR_TRIS);
  });

  test('`isolate` selects by tag, and its mask ages with the generation (§6.5)', async ({
    page,
  }) => {
    test.skip(!(await geomAvailable(page)), GEOM_SKIP);
    const handle = await loadLattice(page);

    const one = await must(page, 'isolate', { handle, criteria: { tags: [2], combine: 'all' } });
    expect(one.result?.visibleTets, 'tetTagCounts["2"] from the manifest').toBe(24);
    expect(one.result?.generation).toBe(1);
    const maskId = one.result?.maskId as number;

    const both = await must(page, 'isolate', {
      handle,
      criteria: { tags: [1, 2], combine: 'any' },
    });
    expect(both.result?.visibleTets).toBe(48);
    expect(both.result?.generation).toBe(2);

    // The first mask is from generation 1 and the handle is at 2: `Error::Parse`, never a silent
    // stale draw (§6.5).
    const stale = await call(page, 'boundary', { handle, maskId, variant: 'indexed' });
    expect(stale.ok).toBe(false);
    expect(stale.error?.code).toBe('parse');
    expect(stale.error?.message).toMatch(/generation/);

    // A sphere outside the lattice selects nothing at all.
    const none = await must(page, 'isolate', {
      handle,
      criteria: { sphere: { center: [1000, 1000, 1000], radius: 1 }, combine: 'all' },
    });
    expect(none.result?.visibleTets).toBe(0);

    // The surviving tets still have a boundary, and it is smaller than the whole mesh's.
    const fresh = await must(page, 'isolate', { handle, criteria: { tags: [2], combine: 'all' } });
    const masked = await must(page, 'boundary', {
      handle,
      maskId: fresh.result?.maskId as number,
      variant: 'indexed',
    });
    const tags = masked.result?.faceTag as ArraySummary;
    expect(tags.length).toBeGreaterThan(0);
    expect(tags.length).toBeLessThan(EXTERIOR_TRIS + INTERFACE_TRIS);
    expect(tags.min).toBe(2);
    expect(tags.max).toBe(2);

    await must(page, 'freeMask', { handle, maskId: fresh.result?.maskId as number });
  });

  test('`cut` puts every vertex on the plane, and the two §6.4 paths agree', async ({ page }) => {
    test.skip(!(await geomAvailable(page)), GEOM_SKIP);
    const handle = await loadLattice(page);
    // z = 5: strictly between the node planes at 0 and 10, so no vertex is degenerate.
    const planes = [{ normal: [0, 0, 1] as [number, number, number], offset: -5 }];

    const buffers = await must(page, 'cut', { handle, planes });
    const result = buffers.result as { mode: string; cuts: Array<Record<string, unknown>> };
    expect(result.mode).toBe('buffers');
    expect(result.cuts).toHaveLength(1);
    const cut = result.cuts[0]!;
    const positions = cut.positions as ArraySummary;
    expect(positions.length).toBeGreaterThan(0);
    expect(positions.length % 3).toBe(0);

    // Every cut vertex lies on the plane, to the last float.
    const zs = await sample(
      page,
      'cuts.0.positions',
      Array.from({ length: positions.length / 3 }, (_, i) => i * 3 + 2)
    );
    for (const z of zs) expect(z).toBeCloseTo(5, 4);

    // §6.3's edge-mask rule: a 1-3 split emits 0b111, a 2-2 split emits 0b101 then 0b011.
    const edgeMask = cut.edgeMask as ArraySummary;
    const masks = await sample(
      page,
      'cuts.0.edgeMask',
      Array.from({ length: edgeMask.length }, (_, i) => i)
    );
    for (const m of masks) expect([0b111, 0b101, 0b011]).toContain(m);

    const tag = cut.tag as ArraySummary;
    expect(tag.min).toBeGreaterThanOrEqual(1);
    expect(tag.max).toBeLessThanOrEqual(2);
    expect((cut.ownerTet as ArraySummary).length).toBe(tag.length);
    expect((cut.interpT as ArraySummary).length).toBe(positions.length / 3);
    expect((cut.interpNodes as ArraySummary).length).toBe((positions.length / 3) * 2);

    // The recycled path is the same geometry into the worker's own pool: same counts, no transfer.
    const recycled = await must(page, 'cut', { handle, planes, recycle: true });
    const r = recycled.result as {
      mode: string;
      truncated: boolean;
      counts: Array<Record<string, number>>;
    };
    expect(r.mode).toBe('recycled');
    expect(r.truncated, 'the worker grows the pool and re-calls until it fits (§6.4)').toBe(false);
    expect(r.counts).toHaveLength(1);
    expect(r.counts[0]?.vertices).toBe(positions.length / 3);
    expect(r.counts[0]?.triangles).toBe(tag.length);
    expect(await page.evaluate(() => window.__tvx.transfers())).toBe(0);
  });

  test('`cut` refuses a plane list the contract does not allow', async ({ page }) => {
    test.skip(!(await geomAvailable(page)), GEOM_SKIP);
    const handle = await loadLattice(page);
    const seven = Array.from({ length: 7 }, (_, i) => ({
      normal: [0, 0, 1] as [number, number, number],
      offset: -i,
    }));
    const out = await call(page, 'cut', { handle, planes: seven });
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('parse');
    expect(out.error?.message).toMatch(/6/);
  });

  test('`locate` answers with a Gmsh element number, or with nothing', async ({ page }) => {
    test.skip(!(await geomAvailable(page)), GEOM_SKIP);
    const handle = await loadLattice(page);

    const inside = await must(page, 'locate', { handle, world: [-5, -5, -5] });
    const hit = inside.result?.hit as Record<string, unknown> | null;
    expect(hit).not.toBeNull();
    expect(hit?.elementId).toBeGreaterThan(56);
    expect(hit?.elementId).toBeLessThanOrEqual(104);
    expect([1, 2]).toContain(hit?.tag);
    // §6.3: one round trip gathers every node and element field at the point.
    expect(Object.keys(hit?.nodeValues as object).sort()).toEqual(['node_scalar', 'node_vector']);
    expect(Object.keys(hit?.elmValues as object).sort()).toEqual(['E', 'elm_scalar']);

    const outside = await must(page, 'locate', { handle, world: [1000, 1000, 1000] });
    expect(outside.result?.hit).toBeNull();
  });

  test('`contours` returns whole segments', async ({ page }) => {
    test.skip(!(await geomAvailable(page)), GEOM_SKIP);
    const handle = await loadLattice(page);
    const out = await must(page, 'contours', {
      handle,
      plane: { normal: [0, 0, 1], offset: -5 },
    });
    const segments = out.result?.segments as ArraySummary;
    expect(segments.length % 6).toBe(0);
    expect(segments.length).toBeGreaterThan(0);
  });

  test('`elmToNode` goes both ways (§6.3)', async ({ page }) => {
    test.skip(!(await geomAvailable(page)), GEOM_SKIP);
    const handle = await loadLattice(page);

    const toNode = await must(page, 'elmToNode', {
      handle,
      direction: 'elmToNode',
      name: 'elm_scalar',
    });
    expect(toNode.result?.name).toBe('elm_scalar');
    expect((toNode.result?.values as ArraySummary).length).toBe(27);

    const toElm = await must(page, 'elmToNode', {
      handle,
      direction: 'nodeToElm',
      name: 'node_scalar',
    });
    expect((toElm.result?.values as ArraySummary).length).toBe(104);

    const nowhere = await call(page, 'elmToNode', {
      handle,
      direction: 'elmToNode',
      name: 'not-a-field',
    });
    expect(nowhere.ok).toBe(false);
    expect(nowhere.error?.code).toBe('parse');
  });

  test('`marchingTets` builds an isosurface from a field', async ({ page }) => {
    test.skip(!(await geomAvailable(page)), GEOM_SKIP);
    const handle = await loadLattice(page);
    // `node_scalar` runs −1.11 … 1.11 over the lattice, so iso 0 crosses it.
    const out = await must(page, 'marchingTets', {
      handle,
      source: 'node',
      name: 'node_scalar',
      component: 'mag',
      iso: 0,
    });
    const positions = out.result?.positions as ArraySummary;
    expect(positions.length).toBeGreaterThan(0);
    expect(positions.length % 3).toBe(0);
    expect((out.result?.normals as ArraySummary).length).toBe(positions.length);
  });

  test('`marchingCubes` and `labelCentroids` work on a volume handle', async ({ page }) => {
    test.skip(!(await geomAvailable(page)), GEOM_SKIP);

    await open(page);
    const ramp = await must(page, 'loadVolume', {
      source: { kind: 'url', url: fixtureUrl('vol_ramp4.nii') },
      caps: CAPS_FULL,
      wantLinear: true,
    });
    const rampMeta = ramp.result?.meta as { handle: number; stats: { min: number; max: number } };
    const mid = (rampMeta.stats.min + rampMeta.stats.max) / 2;
    const mc = await must(page, 'marchingCubes', {
      handle: rampMeta.handle,
      volumeIndex: 0,
      iso: mid,
      smooth: true,
    });
    expect((mc.result?.positions as ArraySummary).length).toBeGreaterThan(0);

    await open(page);
    const labels = await must(page, 'loadVolume', {
      source: { kind: 'url', url: fixtureUrl('labels_simnibs.nii.gz') },
      caps: CAPS_FULL,
      wantLinear: false,
    });
    const want = volume('labels_simnibs.nii.gz');
    const centroids = await must(page, 'labelCentroids', {
      handle: (labels.result?.meta as { handle: number }).handle,
      volumeIndex: 0,
    });
    const list = centroids.result?.centroids as Array<{ id: number; count: number }>;
    expect(list.map((c) => c.id).sort((a, b) => a - b)).toEqual(want.uniqueValues);
    expect(list.reduce((n, c) => n + c.count, 0)).toBe((want.stats as Record<string, number>).n);
  });
});
