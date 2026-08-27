/**
 * Which op serves `contoursIn2D`, for a mesh **with** stored triangles and for one **without**.
 *
 * §6.5.2 has two producers of 2D contour lines and they are not interchangeable:
 *
 * * `contours` intersects the mesh's **stored triangles** with the plane (§6.3 `surface_contours`).
 *   On a tri-less tet mesh it is legitimately empty — `grey_Thalamus_TI.msh` has 1,340,029 tets and
 *   **0 triangles** (AGENTS.md), so a consumer that only calls `contours` draws nothing at all.
 * * `cut` returns `boundarySegments` per plane: the **tag-boundary** contours of the tet cut, built
 *   locally over the cut tets. That is what R4's `contoursIn2D` needs for a tet mesh, and it comes
 *   from the same call as `fillIn2D`'s polygons, on the same latest-wins key.
 *
 * Neither is a gap; the trap is the silence, so it is asserted here rather than left to be
 * discovered as an empty pane.
 */

import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import type { ArraySummary } from './fixtures';
import { GEOM_SKIP, REAL_DATA, fixtureUrl, fsUrl, geomAvailable, must, open } from './fixtures';

const PLANE = { normal: [0, 0, 1] as [number, number, number], offset: -5 };

async function load(page: Page, url: string): Promise<{ handle: number; nTris: number }> {
  await open(page);
  const out = await must(page, 'loadMesh', { source: { kind: 'url', url }, format: 'auto' });
  return out.result?.meta as unknown as { handle: number; nTris: number };
}

async function contourSegments(page: Page, handle: number): Promise<number> {
  const out = await must(page, 'contours', { handle, plane: PLANE });
  const s = out.result?.segments as ArraySummary;
  expect(s.length % 6).toBe(0);
  return s.length / 6;
}

async function cutBoundarySegments(page: Page, handle: number): Promise<number> {
  const out = await must(page, 'cut', { handle, planes: [PLANE] });
  const cuts = (out.result as { cuts: Array<Record<string, unknown>> }).cuts;
  const s = cuts[0]?.boundarySegments as ArraySummary;
  expect(s.length % 6).toBe(0);
  return s.length / 6;
}

test('a mesh with stored triangles gets its contours from `contours`', async ({ page }) => {
  test.skip(!(await geomAvailable(page)), GEOM_SKIP);
  const mesh = await load(page, fixtureUrl('mesh_v2_binary.msh'));
  expect(mesh.nTris).toBe(56);
  expect(await contourSegments(page, mesh.handle)).toBeGreaterThan(0);
  // …and the tet cut's tag boundary is there too, so a consumer may use either.
  expect(await cutBoundarySegments(page, mesh.handle)).toBeGreaterThan(0);
});

test('a tri-less tet mesh gets them from `cut`.boundarySegments, and `contours` is empty', async ({
  page,
}) => {
  test.skip(!(await geomAvailable(page)), GEOM_SKIP);
  const mesh = await load(page, fixtureUrl('mesh_tetonly.msh'));
  expect(mesh.nTris).toBe(0);
  // Not an error and not a fallback: `contours` is defined over stored triangles, and there are
  // none. This is the assertion that stops "the pane is blank" from being a mystery.
  expect(await contourSegments(page, mesh.handle)).toBe(0);
  expect(await cutBoundarySegments(page, mesh.handle)).toBeGreaterThan(0);
});

test.describe('real data', () => {
  test.skip(REAL_DATA === null, 'TETRAVOX_TESTDATA is unset');
  const root = REAL_DATA ?? '';

  test('grey_Thalamus_TI.msh — R4’s 0-triangle mesh — still has 2D contours', async ({ page }) => {
    test.skip(!(await geomAvailable(page)), GEOM_SKIP);
    const mesh = await load(
      page,
      fsUrl(`${root}/Simulations/Thalamus/TI/mesh/grey_Thalamus_TI.msh`)
    );
    expect(mesh.nTris).toBe(0);
    // A mid-axial plane through the grey-matter block (its z runs −50.7 … 82.5, AGENTS.md).
    const plane = { normal: [0, 0, 1] as [number, number, number], offset: -15 };
    const contours = await must(page, 'contours', { handle: mesh.handle, plane });
    expect((contours.result?.segments as ArraySummary).length).toBe(0);

    const cut = await must(page, 'cut', { handle: mesh.handle, planes: [plane] });
    const first = (cut.result as { cuts: Array<Record<string, unknown>> }).cuts[0];
    expect((first?.positions as ArraySummary).length).toBeGreaterThan(0);
    expect((first?.boundarySegments as ArraySummary).length % 6).toBe(0);
    // One tet tag (2), so the tag boundary is the outline of the cut itself.
    expect((first?.tag as ArraySummary).min).toBe(2);
    expect((first?.tag as ArraySummary).max).toBe(2);
  });
});
