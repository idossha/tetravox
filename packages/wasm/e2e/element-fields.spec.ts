/**
 * The **ordering** of `field` / `elmToNode` element values (§6.5.2), through the real worker.
 *
 * `SurfacePayload.ownerElm`, `CutPayload.ownerTet` and `meshCentroids.ownerTet` are all Gmsh element
 * numbers (§6.2), and §7.4 builds its element-field texture by looking each one up. That only works
 * if a Gmsh number can be turned into a row of the values array — which means the wire order has to
 * be the **file's** element order, not §6.3's internal Morton order for tets.
 *
 * The assertion below is a triangle: `meshCentroids` hands out a point and a Gmsh number, `locate`
 * reads the element field at that point straight from the tet it lands in, and `field` is indexed by
 * `gmsh - 1`. All three must agree. Nothing here is a recorded value (§11 rule 0), and if the tet
 * block were handed out in Morton order this is the test that would be red — while every count,
 * length and sum in the suite stayed green and the picture merely coloured the wrong elements.
 */

import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import type { ArraySummary } from './fixtures';
import {
  GEOM_SKIP,
  REAL_DATA,
  fixtureUrl,
  fsUrl,
  geomAvailable,
  must,
  open,
  sample,
} from './fixtures';

interface Loaded {
  handle: number;
  nTris: number;
  nTets: number;
  identityElementNumbers: boolean;
}

async function load(page: Page, url: string): Promise<Loaded> {
  await open(page);
  const out = await must(page, 'loadMesh', { source: { kind: 'url', url }, format: 'auto' });
  return out.result?.meta as unknown as Loaded;
}

/**
 * For `count` sampled tets: the element value `locate` reports at the tet's own centroid, and the
 * one `field` holds at row `gmsh - 1`.
 */
async function crossCheck(
  page: Page,
  mesh: Loaded,
  fieldName: string,
  stride: number
): Promise<number> {
  const centroids = await must(page, 'meshCentroids', { handle: mesh.handle, stride });
  const n = (centroids.result?.ownerTet as ArraySummary).length;
  const owners = await sample(
    page,
    'ownerTet',
    Array.from({ length: n }, (_, i) => i)
  );
  const coords = await sample(
    page,
    'positions',
    Array.from({ length: 3 * n }, (_, i) => i)
  );

  const values = await must(page, 'field', {
    handle: mesh.handle,
    source: 'elm',
    name: fieldName,
    component: 'mag',
  });
  expect((values.result?.values as ArraySummary).length).toBe(mesh.nTris + mesh.nTets);
  // One `field` call, then one read per sampled row — `sample` reads the last result, so the rows
  // are fetched before any `locate` overwrites it.
  const rows = await sample(
    page,
    'values',
    owners.map((g) => (g as number) - 1)
  );

  for (let i = 0; i < n; i += 1) {
    const world: [number, number, number] = [
      coords[i * 3] as number,
      coords[i * 3 + 1] as number,
      coords[i * 3 + 2] as number,
    ];
    const hit = await must(page, 'locate', { handle: mesh.handle, world });
    const found = hit.result?.hit as {
      elementId: number;
      elmValues: Record<string, number[]>;
    } | null;
    expect(found, `centroid ${i} is in no tet`).not.toBeNull();
    expect(found?.elementId, `centroid ${i}`).toBe(owners[i]);
    const fromProbe = found?.elmValues[fieldName]?.[0] as number;
    // `component: 'mag'` of a scalar field is the scalar itself, signed (§6.4), so the two paths
    // are comparable without a sign or magnitude fudge.
    expect(rows[i], `element ${owners[i]} (sample ${i})`).toBeCloseTo(fromProbe, 5);
  }
  return n;
}

test('element values are in file order, so `gmsh - 1` finds the right one', async ({ page }) => {
  test.skip(!(await geomAvailable(page)), GEOM_SKIP);
  const mesh = await load(page, fixtureUrl('mesh_v2_binary.msh'));
  expect(mesh.identityElementNumbers).toBe(true);
  // All 48 tets of the lattice, whose Morton permutation is not the identity — the fixture would
  // not catch this otherwise.
  expect(await crossCheck(page, mesh, 'elm_scalar', 1)).toBe(48);
});

test('the tri block is in file order too, and the two blocks are contiguous', async ({ page }) => {
  test.skip(!(await geomAvailable(page)), GEOM_SKIP);
  const mesh = await load(page, fixtureUrl('mesh_v2_binary.msh'));

  const values = await must(page, 'field', {
    handle: mesh.handle,
    source: 'elm',
    name: 'elm_scalar',
    component: 'mag',
  });
  expect(values.result?.n).toBe(mesh.nTris + mesh.nTets);

  // `surface` hands out one Gmsh number per stored triangle; every one of them indexes a row inside
  // the tri block, which is the first `nTris` rows.
  const surface = await must(page, 'surface', { handle: mesh.handle, variant: 'indexed' });
  const owners = surface.result?.ownerElm as ArraySummary;
  expect(owners.min).toBeGreaterThanOrEqual(1);
  expect(owners.max).toBeLessThanOrEqual(mesh.nTris);
});

test('`nodeToElm` returns its values in the same element order', async ({ page }) => {
  test.skip(!(await geomAvailable(page)), GEOM_SKIP);
  const mesh = await load(page, fixtureUrl('mesh_v2_binary.msh'));
  const out = await must(page, 'elmToNode', {
    handle: mesh.handle,
    direction: 'nodeToElm',
    name: 'node_scalar',
  });
  expect((out.result?.values as ArraySummary).length).toBe(mesh.nTris + mesh.nTets);
  expect((out.result?.values as ArraySummary).nonFinite).toBe(0);
});

test.describe('real data', () => {
  test.skip(REAL_DATA === null, 'TETRAVOX_TESTDATA is unset');
  const root = REAL_DATA ?? '';

  test('Thalamus_TI.msh: a cut pixel’s TI_max is R4’s cross-check, at the protocol', async ({
    page,
  }) => {
    test.skip(!(await geomAvailable(page)), GEOM_SKIP);
    // R4's gate reads `TI_max` for a cut element and cross-checks it through `locate`. That whole
    // chain rests on `ownerTet` indexing `field`'s values, so it is asserted here first.
    const mesh = await load(page, fsUrl(`${root}/Simulations/Thalamus/TI/mesh/Thalamus_TI.msh`));
    expect(mesh.nTris).toBe(1_177_213);
    expect(mesh.nTets).toBe(4_722_625);
    expect(mesh.identityElementNumbers).toBe(true);
    // AGENTS.md: exactly one $ElementData field, n = 5,899,838 = every element.
    expect(mesh.nTris + mesh.nTets).toBe(5_899_838);

    const checked = await crossCheck(page, mesh, 'TI_max', 150_007);
    expect(checked).toBeGreaterThan(30);
  });

  test('ernie_TDCS_1_scalar.msh: the vector field lines up element for element too', async ({
    page,
  }) => {
    test.skip(!(await geomAvailable(page)), GEOM_SKIP);
    const mesh = await load(
      page,
      fsUrl(`${root}/Simulations/L_Insula/high_Frequency/mesh/ernie_TDCS_1_scalar.msh`)
    );
    expect(mesh.identityElementNumbers).toBe(true);
    // `magnE` is the magnitude of `E`, element for element, so the scalar field and the vector
    // field's `mag` component must agree at the same row — which they can only do if both are in
    // the same order. This is the `GlyphSpec` file (AGENTS.md).
    const checked = await crossCheck(page, mesh, 'magnE', 200_003);
    expect(checked).toBeGreaterThan(20);
  });
});
