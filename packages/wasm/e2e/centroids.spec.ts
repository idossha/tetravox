/**
 * §6.5.2 `meshCentroids` — the volumetric `GlyphSpec` origins (§7.4), through the real worker.
 *
 * Surface glyphs read `SurfacePayload.positions` + `ownerElm`; cut-plane-restricted glyphs read
 * `CutPayload.positions` + `ownerTet`; **interior** glyphs with no cut plane had no origin source at
 * all until this op. It returns points, never geometry — which is what keeps §7.4's "no new geometry
 * from WASM" true for the unrestricted case.
 *
 * The load-bearing assertion in this file is the **`locate` cross-check**: a tet's centroid is
 * strictly inside that tet, so `locate` at the returned position must answer with the returned
 * `ownerTet`. That pins the coordinates and §6.2's Gmsh numbering to each other with no recorded
 * value on either side (§11 rule 0).
 */

import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import type { ArraySummary } from './fixtures';
import {
  GEOM_SKIP,
  REAL_DATA,
  call,
  fixtureUrl,
  fsUrl,
  geomAvailable,
  must,
  open,
  sample,
} from './fixtures';

/** `mesh_v2_binary.msh`: 8 cells × 6 tets under two physical tags, 24 each; 56 stored tris. */
const LATTICE_TETS = 48;
const LATTICE_TRIS = 56;

async function loadLattice(page: Page, name = 'mesh_v2_binary.msh'): Promise<number> {
  await open(page);
  const out = await must(page, 'loadMesh', {
    source: { kind: 'url', url: fixtureUrl(name) },
    format: 'auto',
  });
  return (out.result?.meta as { handle: number }).handle;
}

/** Every element of a summarised array, read back one index at a time. */
async function readAll(page: Page, path: string, length: number): Promise<number[]> {
  return sample(
    page,
    path,
    Array.from({ length }, (_, i) => i)
  );
}

/**
 * §6.3's rule, restated where the spec can use it: filtering happens first, so the count is
 * `ceil(surviving / stride)`.
 */
function expectedCount(surviving: number, stride: number): number {
  return Math.ceil(surviving / stride);
}

test('`meshCentroids` returns one origin per tet, with its Gmsh element number', async ({
  page,
}) => {
  test.skip(!(await geomAvailable(page)), GEOM_SKIP);
  const handle = await loadLattice(page);

  const out = await must(page, 'meshCentroids', { handle, stride: 1 });
  const positions = out.result?.positions as ArraySummary;
  const ownerTet = out.result?.ownerTet as ArraySummary;
  expect(ownerTet.length).toBe(LATTICE_TETS);
  expect(positions.length).toBe(3 * LATTICE_TETS);

  // A centroid is a convex combination of four nodes, so it is strictly inside the lattice's
  // −10…10 extent — never on the boundary, which a mis-scaled mean would put it on.
  expect(positions.min).toBeGreaterThan(-10);
  expect(positions.max).toBeLessThan(10);

  // §6.2: tris are numbered first, so every tet's element number is above the tri count, and the
  // 48 of them are distinct.
  expect(ownerTet.min).toBeGreaterThan(LATTICE_TRIS);
  expect(ownerTet.max).toBeLessThanOrEqual(LATTICE_TRIS + LATTICE_TETS);
  const owners = await readAll(page, 'ownerTet', LATTICE_TETS);
  expect(new Set(owners).size).toBe(LATTICE_TETS);

  // No geometry came back: this is the whole point of the op (§7.4).
  expect(out.result?.indices).toBeUndefined();
  expect(out.result?.normals).toBeUndefined();
  expect(out.result?.faceTag).toBeUndefined();
});

test('every origin is inside the tet it names — `locate` says so', async ({ page }) => {
  test.skip(!(await geomAvailable(page)), GEOM_SKIP);
  const handle = await loadLattice(page);

  await must(page, 'meshCentroids', { handle, stride: 1 });
  const owners = await readAll(page, 'ownerTet', LATTICE_TETS);
  const coords = await readAll(page, 'positions', 3 * LATTICE_TETS);

  // All 48, not a sample: the fixture is small enough that "every one of them" is affordable, and
  // an off-by-one in the Morton permutation would hide behind a spot check.
  for (let i = 0; i < LATTICE_TETS; i += 1) {
    const world: [number, number, number] = [
      coords[i * 3] as number,
      coords[i * 3 + 1] as number,
      coords[i * 3 + 2] as number,
    ];
    const hit = await must(page, 'locate', { handle, world });
    const found = hit.result?.hit as { elementId: number } | null;
    expect(found, `no tet contains centroid ${i} at ${world.join(', ')}`).not.toBeNull();
    expect(found?.elementId, `centroid ${i}`).toBe(owners[i]);
  }
});

test('`stride` keeps every nth surviving tet, and 0 is a parse error', async ({ page }) => {
  test.skip(!(await geomAvailable(page)), GEOM_SKIP);
  const handle = await loadLattice(page);

  for (const stride of [1, 2, 5, 47, 48, 96]) {
    const out = await must(page, 'meshCentroids', { handle, stride });
    const ownerTet = out.result?.ownerTet as ArraySummary;
    expect(ownerTet.length, `stride ${stride}`).toBe(expectedCount(LATTICE_TETS, stride));
    expect((out.result?.positions as ArraySummary).length, `stride ${stride}`).toBe(
      3 * expectedCount(LATTICE_TETS, stride)
    );
  }

  const zero = await call(page, 'meshCentroids', { handle, stride: 0 });
  expect(zero.ok).toBe(false);
  expect(zero.error?.code).toBe('parse');
  expect(zero.error?.message).toMatch(/stride/);
});

test('`tags` filters before `stride`, so a small tag still gets origins', async ({ page }) => {
  test.skip(!(await geomAvailable(page)), GEOM_SKIP);
  const handle = await loadLattice(page);

  // The manifest's `tetTagCounts`: 24 tets each under physical tags 1 and 2.
  for (const tag of [1, 2]) {
    const out = await must(page, 'meshCentroids', { handle, stride: 1, tags: [tag] });
    expect((out.result?.ownerTet as ArraySummary).length, `tag ${tag}`).toBe(24);
  }
  const both = await must(page, 'meshCentroids', { handle, stride: 1, tags: [1, 2] });
  expect((both.result?.ownerTet as ArraySummary).length).toBe(LATTICE_TETS);

  // Filtering *after* striding would leave a 1-in-8 sample of a half-mesh tag with 3 origins by
  // luck rather than 3 by rule; filtering first makes the count exactly ceil(24 / 8).
  const strided = await must(page, 'meshCentroids', { handle, stride: 8, tags: [2] });
  expect((strided.result?.ownerTet as ArraySummary).length).toBe(expectedCount(24, 8));

  // A tag no tet carries is empty, not an error: hiding every tissue is a legitimate `tagStyle`.
  const nothing = await must(page, 'meshCentroids', { handle, stride: 1, tags: [4242] });
  expect((nothing.result?.ownerTet as ArraySummary).length).toBe(0);
  expect((nothing.result?.positions as ArraySummary).length).toBe(0);
});

test('an isolation mask filters the origins, and a stale one is refused', async ({ page }) => {
  test.skip(!(await geomAvailable(page)), GEOM_SKIP);
  const handle = await loadLattice(page);

  const iso = await must(page, 'isolate', { handle, criteria: { tags: [2], combine: 'all' } });
  const maskId = iso.result?.maskId as number;
  expect(iso.result?.visibleTets).toBe(24);

  const masked = await must(page, 'meshCentroids', { handle, maskId, stride: 1 });
  expect((masked.result?.ownerTet as ArraySummary).length).toBe(24);
  // The mask and the tag list name the same 24 tets, so they must name the same 24 elements.
  const byTag = await must(page, 'meshCentroids', { handle, stride: 1, tags: [2] });
  const a = await readAll(page, 'ownerTet', 24);
  const maskedAgain = await must(page, 'meshCentroids', { handle, maskId, stride: 1 });
  expect((maskedAgain.result?.ownerTet as ArraySummary).sum).toBe(
    (byTag.result?.ownerTet as ArraySummary).sum
  );
  const b = await readAll(page, 'ownerTet', 24);
  expect(b).toEqual(a);

  // §6.5's mask lifecycle applies here like everywhere else: re-isolating ages the old mask.
  await must(page, 'isolate', { handle, criteria: { tags: [1], combine: 'all' } });
  const stale = await call(page, 'meshCentroids', { handle, maskId, stride: 1 });
  expect(stale.ok).toBe(false);
  expect(stale.error?.code).toBe('parse');
  expect(stale.error?.message).toMatch(/generation/);
});

test('a mesh with no tets answers with nothing, rather than failing', async ({ page }) => {
  test.skip(!(await geomAvailable(page)), GEOM_SKIP);
  // A surface-only GIfTI: its glyphs are the surface case, which needs no origins from here.
  const handle = await loadLattice(page, 'surf_gzipb64.surf.gii');
  const out = await must(page, 'meshCentroids', { handle, stride: 1 });
  expect((out.result?.ownerTet as ArraySummary).length).toBe(0);
  expect((out.result?.positions as ArraySummary).length).toBe(0);
});

test.describe('real data', () => {
  test.skip(REAL_DATA === null, 'TETRAVOX_TESTDATA is unset');
  const root = REAL_DATA ?? '';

  test('ernie.msh: counts follow the AGENTS.md census and the stride rule', async ({ page }) => {
    test.skip(!(await geomAvailable(page)), GEOM_SKIP);
    await open(page);
    const load = await must(page, 'loadMesh', {
      source: { kind: 'url', url: fsUrl(`${root}/m2m_ernie/ernie.msh`) },
      format: 'auto',
    });
    const meta = load.result?.meta as { handle: number; nTets: number; nTris: number };
    expect(meta.nTets).toBe(4_722_625);
    expect(meta.nTris).toBe(1_177_213);

    // Every tet, 1 in 64: the density knob a 4.7 M-element glyph layer actually uses.
    const strided = await must(page, 'meshCentroids', { handle: meta.handle, stride: 64 });
    const owners = strided.result?.ownerTet as ArraySummary;
    expect(owners.length).toBe(expectedCount(meta.nTets, 64));
    // §6.2's identity rule on this file: tets are elements 1,177,214 … 5,899,838.
    expect(owners.min).toBeGreaterThanOrEqual(meta.nTris + 1);
    expect(owners.max).toBeLessThanOrEqual(5_899_838);

    // Centroids are convex combinations of nodes, so they sit inside AGENTS.md's node bbox.
    const positions = strided.result?.positions as ArraySummary;
    expect(positions.length).toBe(3 * owners.length);
    expect(positions.min).toBeGreaterThan(-128.860_524);
    expect(positions.max).toBeLessThan(136.157_041);
    expect(positions.nonFinite).toBe(0);

    // AGENTS.md's per-tag census: tag 2 (GM) has 1,340,029 tets, and `tags` filters before
    // `stride`, so a 1-in-64 sample of GM is ceil(1,340,029 / 64) origins — not 1/64 of the whole
    // mesh intersected with GM, which would be ~20,900 by luck and 0 for a rare tag.
    const gm = await must(page, 'meshCentroids', {
      handle: meta.handle,
      stride: 64,
      tags: [2],
    });
    expect((gm.result?.ownerTet as ArraySummary).length).toBe(expectedCount(1_340_029, 64));

    // Muscle is 4,400 tets — 0.09 % of the mesh — and still gets 69 origins at stride 64.
    const muscle = await must(page, 'meshCentroids', {
      handle: meta.handle,
      stride: 64,
      tags: [10],
    });
    expect((muscle.result?.ownerTet as ArraySummary).length).toBe(expectedCount(4_400, 64));
  });

  test('ernie.msh: `locate` finds each sampled origin in the tet it names', async ({ page }) => {
    test.skip(!(await geomAvailable(page)), GEOM_SKIP);
    await open(page);
    const load = await must(page, 'loadMesh', {
      source: { kind: 'url', url: fsUrl(`${root}/m2m_ernie/ernie.msh`) },
      format: 'auto',
    });
    const handle = (load.result?.meta as { handle: number }).handle;

    // A wide stride so the sample crosses the whole Morton curve — head, middle and tail of the
    // volume rather than one corner of it.
    const out = await must(page, 'meshCentroids', { handle, stride: 100_003 });
    const n = (out.result?.ownerTet as ArraySummary).length;
    expect(n).toBeGreaterThan(40);
    const owners = await readAll(page, 'ownerTet', n);
    const coords = await readAll(page, 'positions', 3 * n);

    for (let i = 0; i < n; i += 1) {
      const world: [number, number, number] = [
        coords[i * 3] as number,
        coords[i * 3 + 1] as number,
        coords[i * 3 + 2] as number,
      ];
      const hit = await must(page, 'locate', { handle, world });
      const found = hit.result?.hit as { elementId: number } | null;
      expect(found, `no tet contains centroid ${i}`).not.toBeNull();
      expect(found?.elementId, `centroid ${i} at ${world.join(', ')}`).toBe(owners[i]);
    }
  });

  test('ernie_TDCS_1_scalar.msh: origins and its E field line up element for element', async ({
    page,
  }) => {
    test.skip(!(await geomAvailable(page)), GEOM_SKIP);
    // The only reference file with a vector field, and therefore the `GlyphSpec` file (AGENTS.md).
    await open(page);
    const load = await must(page, 'loadMesh', {
      source: {
        kind: 'url',
        url: fsUrl(`${root}/Simulations/L_Insula/high_Frequency/mesh/ernie_TDCS_1_scalar.msh`),
      },
      format: 'auto',
    });
    const meta = load.result?.meta as {
      handle: number;
      nTets: number;
      nTris: number;
      fields: Array<{ name: string; source: string; ncomp: number; n: number }>;
    };
    expect(meta.nTets).toBe(4_723_120);
    const e = meta.fields.find((f) => f.name === 'E');
    expect(e).toMatchObject({ source: 'elm', ncomp: 3 });
    // n = 5,900,498 = every element, tris and tets together — which is exactly why a glyph needs
    // `ownerTet` (a Gmsh element number) rather than a tet index to find its vector.
    expect(e?.n).toBe(meta.nTris + meta.nTets);

    const out = await must(page, 'meshCentroids', { handle: meta.handle, stride: 1024 });
    const owners = out.result?.ownerTet as ArraySummary;
    expect(owners.length).toBe(expectedCount(meta.nTets, 1024));
    // Every origin indexes a real row of that 5,900,498-long field: the tet block starts right
    // after the tris and ends at the last element.
    expect(owners.min).toBeGreaterThanOrEqual(meta.nTris + 1);
    expect(owners.max).toBeLessThanOrEqual(meta.nTris + meta.nTets);
  });
});
