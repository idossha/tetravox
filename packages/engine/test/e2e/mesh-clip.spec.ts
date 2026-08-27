/**
 * §7.4's clip planes and their exact caps, on the committed 3×3×3 lattice.
 *
 * The four §11 obligations this file carries:
 *
 * * **Clip sign convention** — "a fragment at `dot(n, p) + offset = +ε` survives and `−ε` does not,
 *   on both paths". Asserted as a *transition row*: the last surviving scanline of the front face is
 *   the one the plane's own arithmetic names, to the pixel.
 * * **Cap = the tag colour of the tet under it** — §11's second named analytic example, on the
 *   **0..255 wire value**, for two tags at once: one straight from the fixture LUT and one edited
 *   through `tagStyle` (R5), so the same exactness is proved for both sources.
 * * **Cap diagonal** — a 2-2-split quad is found by its `Cut.edge_mask` (`0b101` / `0b011`), its
 *   suppressed diagonal is projected to a pane pixel, and that pixel is **not** the edge colour
 *   while the quad's real edge **is**.
 * * **Clip-path equivalence** — the whole canvas, `gl_ClipDistance` against
 *   `TETRAVOX_FORCE_DISCARD_CLIP`, pixel for pixel.
 *
 * Every expected value is computed here from the fixture's geometry and the §7.6 LUT; the shading
 * term is *solved out* with `solveShading` rather than modelled, so no ambient or specular constant
 * from the shader appears in any expectation.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { expectGolden, readCanvasPixels } from '../helpers/pixels';
import {
  BACKGROUND,
  CAP_PLANE,
  capPointAtPaneY,
  FRONT_FACE_CAMERA,
  isBackground,
  PANE,
  pointSegmentDistance,
  solveShading,
  worldToFacePixel,
} from './mesh-support';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const fixture = (name: string): string => `/@fs${REPO}testdata/${name}`;

/** The fixture LUT's tet colours, as the exact 0..255 triples §4.1 requires to round-trip. */
const TAG1_LUT = [230, 230, 210, 255] as const;
/** Tet tag 2's LUT colour is a pure grey, which no linear fit can distinguish from a grey pixel —
 *  so the cap test recolours it through `tagStyle`, which is R5's path anyway. */
const TAG2_EDITED = [68, 136, 204, 255] as const;

/** The fixture's two **tri** tags, which are the surface behind every cap. */
const SURFACE_TAGS = [1001, 1002] as const;

interface ClipOptions {
  caps?: boolean;
  edges?: boolean;
  forceDiscardClip?: boolean;
  planes?: { normal: [number, number, number]; offset: number }[];
  /**
   * Hide the surface's tri tags, leaving the cap alone in the pane.
   *
   * Needed wherever "the cap is gone" has to mean *background*: clipping removes the near half of the
   * mesh, so what a missing cap reveals is the **far** half's interior surface, not the background.
   * Hiding tri tags 1001 / 1002 is `tagStyle`'s own mechanism (R5) and touches nothing about caps.
   */
  capsOnly?: boolean;
}

declare global {
  interface Window {
    __tvxClipLayer?: string;
  }
}

/**
 * Load the lattice, point the camera at it, and clip it with {@link CAP_PLANE}.
 *
 * Only the LUT sidecar is loaded, never the `.msh.opt`: the fixture's sidecar carries `Hide "*"`,
 * and this spec is about clipping, not about `.msh.opt` seeding.
 */
async function openClipped(page: Page, opts: ClipOptions = {}): Promise<void> {
  const url =
    opts.forceDiscardClip === true
      ? '/test/pages/scene.html?forceDiscardClip=1'
      : '/test/pages/scene.html';
  await page.goto(url);
  await page.waitForFunction(() => window.__tvxEngine !== undefined);
  await page.evaluate(
    async ([mesh, lut, camera, o, plane, tag2, surfaceTags]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({
        kind: 'path',
        path: mesh as string,
        sidecars: { lut: lut as string },
      });
      const layer = engine.addLayer({ datasetId: ds.id, kind: 'mesh' });
      window.__tvxClipLayer = layer.id;
      engine.setLayout({ kind: '3d-only', cells: ['view3d'] });
      engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });
      engine.setView('view3d', { camera: camera as never });
      const options = o as ClipOptions;
      const c = tag2 as readonly number[];
      // R5 through the cap: tet tag 2 is recoloured, tet tag 1 keeps its LUT colour.
      const tagStyle: Record<number, { visible: boolean; opacity: number; color?: number[] }> = {
        1: { visible: true, opacity: 1 },
        2: {
          visible: true,
          opacity: 1,
          color: [c[0]! / 255, c[1]! / 255, c[2]! / 255, 1],
        },
      };
      if (options.capsOnly === true) {
        for (const t of surfaceTags as readonly number[]) {
          tagStyle[t] = { visible: false, opacity: 1 };
        }
      }
      engine.updateLayer(layer.id, {
        tagStyle,
        edges: { surface: false, caps: options.edges === true },
        edgeColor: [0, 0, 0, 1],
        edgeWidthPx: 1.5,
        clip: {
          planes: (options.planes ?? [plane as { normal: number[]; offset: number }]).map((p) => ({
            plane: p,
            enabled: true,
          })),
          caps: options.caps !== false,
          capColorMode: 'inherit',
        },
      } as never);
      await engine.whenSettled();
    },
    [
      fixture('mesh_v2_binary.msh'),
      fixture('mesh_v2_binary_LUT.txt'),
      FRONT_FACE_CAMERA,
      opts,
      CAP_PLANE,
      TAG2_EDITED,
      SURFACE_TAGS,
    ] as const
  );
}

/** The whole drawing buffer as base64, so a full-canvas comparison is one string per page load. */
async function canvasBytes(page: Page): Promise<Uint8Array> {
  const b64 = await page.locator('#gl').evaluate((el): string => {
    if (!(el instanceof HTMLCanvasElement)) throw new Error('not a canvas');
    const gl = el.getContext('webgl2');
    if (gl === null) throw new Error('no webgl2');
    window.__tvxRender?.();
    const px = new Uint8Array(el.width * el.height * 4);
    gl.readPixels(0, 0, el.width, el.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let s = '';
    for (let i = 0; i < px.length; i += 1) s += String.fromCharCode(px[i]!);
    return btoa(s);
  });
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

test('§11 clip sign convention: +ε survives, −ε does not, and the transition is where the plane is', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // An axial plane (normal +Z, offset 0) with **no cap**, so what is asserted is the clip alone.
  await openClipped(page, {
    caps: false,
    planes: [{ normal: [0, 0, 1], offset: 0 }],
  });
  expect(errors).toEqual([]);

  // The front face is `x = −10`; `worldToFacePixel` says where its `z = ±ε` rows land.
  const above = worldToFacePixel([-10, 0, 0.6]);
  const below = worldToFacePixel([-10, 0, -0.6]);
  const [keep, cut] = await readCanvasPixels(page, [
    [Math.round(above[0]), Math.round(above[1])],
    [Math.round(below[0]), Math.round(below[1])],
  ]);
  expect(
    isBackground(keep!),
    `dot(n,p)+offset = +0.6 must survive, got rgb(${keep!.join(',')})`
  ).toBe(false);
  expect(
    isBackground(cut!),
    `dot(n,p)+offset = −0.6 must be clipped, got rgb(${cut!.join(',')})`
  ).toBe(true);

  // …and the boundary itself: scan the centre column and find the last surviving row. The plane's
  // own arithmetic puts it at the pixel `worldToFacePixel([-10, 0, 0])` names.
  const column: [number, number][] = [];
  for (let y = 0; y < PANE; y += 1) column.push([PANE / 2, y]);
  const px = await readCanvasPixels(page, column);
  let last = -1;
  for (let y = 0; y < PANE; y += 1) if (!isBackground(px[y]!)) last = y;
  const expected = worldToFacePixel([-10, 0, 0])[1];
  console.log(`[clip] last surviving row ${last}, plane at ${expected.toFixed(2)}`);
  expect(Math.abs(last - expected)).toBeLessThanOrEqual(1);
});

test('§11 cap pixel: exactly the tag colour of the tet under it, LUT and tagStyle alike', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openClipped(page);
  expect(errors).toEqual([]);

  // Above the pane's centre line the cap cuts tag-2 tets (centroid z > 0), below it tag-1 tets.
  const upper = worldToFacePixel(capPointAtPaneY(PANE / 2 - 60));
  const lower = worldToFacePixel(capPointAtPaneY(PANE / 2 + 60));
  const [above, below] = await readCanvasPixels(page, [
    [Math.round(upper[0]), Math.round(upper[1])],
    [Math.round(lower[0]), Math.round(lower[1])],
  ]);

  // `solveShading`, not `fitShading`: tag 1's LUT colour is (230, 230, 210), whose 20-byte channel
  // spread makes a least-squares slope useless against 8-bit quantisation. See `mesh-support.ts`.
  const solvedUpper = solveShading(TAG2_EDITED, above!);
  const solvedLower = solveShading(TAG1_LUT, below!);
  console.log(
    `[cap] tag2 pixel rgb(${above!.slice(0, 3).join(',')}) is ${TAG2_EDITED.slice(0, 3).join(',')} ` +
      `at s=${solvedUpper.s.toFixed(3)} t=${solvedUpper.t.toFixed(1)}; ` +
      `tag1 pixel rgb(${below!.slice(0, 3).join(',')}) is ${TAG1_LUT.slice(0, 3).join(',')} ` +
      `at s=${solvedLower.s.toFixed(3)} t=${solvedLower.t.toFixed(1)}`
  );
  expect(solvedUpper.feasible, 'the cap over a tag-2 tet is exactly tag 2’s colour, lit').toBe(
    true
  );
  expect(solvedLower.feasible, 'the cap over a tag-1 tet is exactly tag 1’s colour, lit').toBe(
    true
  );

  // Each colour fails on the other's pixel, so "it fits" is a statement about this tag and not
  // about any colour at all.
  expect(solveShading(TAG1_LUT, above!).feasible).toBe(false);
  expect(solveShading(TAG2_EDITED, below!).feasible).toBe(false);
});

test('§7.4 cap rule: a cap is not clipped by its own plane, so the cut has no holes', async ({
  page,
}) => {
  // The failure this pins is the one §7.4 calls "the one that breaks the product": with plane i's
  // clip distance left enabled for plane i's own cap, CPU f32 interpolation straddles zero per
  // vertex and cap triangles vanish **wholesale** — `gl_ClipDistance == −1e-7` deletes the
  // primitive entirely `[M2Max]`. A hole rate, not a single pixel, is what sees that.
  await openClipped(page);
  const points: [number, number][] = [];
  for (let dy = -80; dy <= 80; dy += 8) {
    for (let dx = -60; dx <= 60; dx += 8) points.push([PANE / 2 + dx, PANE / 2 + dy]);
  }
  const px = await readCanvasPixels(page, points);
  const holes = px.filter((p) => isBackground(p)).length;
  console.log(`[cap] ${points.length - holes}/${points.length} cap samples covered`);
  expect(holes, `${holes} of ${points.length} cap samples fell through to the background`).toBe(0);
});

test('§11 cap diagonal: the suppressed 2-2 diagonal draws no edge, the real edge does', async ({
  page,
}) => {
  await openClipped(page, { edges: true });

  const cut = await page.evaluate(() => {
    const engine = window.__tvxEngine as unknown as {
      meshCut(id: string): {
        triangleCount: number;
        positions: Float32Array;
        edgeMask: Uint8Array;
        ownerTet: Uint32Array;
      } | null;
    };
    const c = engine.meshCut(window.__tvxClipLayer!);
    if (c === null) return null;
    return {
      triangleCount: c.triangleCount,
      positions: Array.from(c.positions),
      edgeMask: Array.from(c.edgeMask),
      ownerTet: Array.from(c.ownerTet),
    };
  });
  expect(cut, 'the layer has a cut').not.toBeNull();
  const { positions, edgeMask, ownerTet, triangleCount } = cut!;

  const vertex = (t: number, k: number): [number, number, number] => [
    positions[(t * 3 + k) * 3]!,
    positions[(t * 3 + k) * 3 + 1]!,
    positions[(t * 3 + k) * 3 + 2]!,
  ];
  const mid = (
    a: readonly [number, number, number],
    b: readonly [number, number, number]
  ): [number, number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

  // §6.3's normative emission rule: a 2-2 split emits quad (a,b,c,d) as (a,b,c) and (a,c,d); the
  // diagonal a–c is opposite b (index 1) in the first ⇒ mask 0b101, and opposite d (index 2) in the
  // second ⇒ mask 0b011. Finding the pair by its masks is what makes this a test of the mask.
  let best: { diagonal: [number, number]; real: [number, number]; clearance: number } | null = null;
  for (let t = 0; t + 1 < triangleCount; t += 1) {
    if (edgeMask[t] !== 0b101 || edgeMask[t + 1] !== 0b011) continue;
    if (ownerTet[t] !== ownerTet[t + 1]) continue;
    const a = vertex(t, 0);
    const b = vertex(t, 1);
    const c = vertex(t, 2);
    const d = vertex(t + 1, 2);
    const diagonalPx = worldToFacePixel(mid(a, c));
    // The four real edges of the quad, in pane space.
    const edges: [[number, number], [number, number]][] = [
      [worldToFacePixel(a), worldToFacePixel(b)],
      [worldToFacePixel(b), worldToFacePixel(c)],
      [worldToFacePixel(c), worldToFacePixel(d)],
      [worldToFacePixel(d), worldToFacePixel(a)],
    ];
    const clearance = Math.min(...edges.map(([p, q]) => pointSegmentDistance(diagonalPx, p, q)));
    const inside = (p: readonly [number, number]): boolean =>
      p[0] > 8 && p[1] > 8 && p[0] < PANE - 8 && p[1] < PANE - 8;
    const realPx = worldToFacePixel(mid(b, c));
    if (!inside(diagonalPx) || !inside(realPx)) continue;
    if (best === null || clearance > best.clearance) {
      best = { diagonal: diagonalPx, real: realPx, clearance };
    }
  }
  expect(best, 'the cut contains a 2-2 split quad whose diagonal is visible').not.toBeNull();
  // The clearance has to beat the 1.5 px edge width plus the smoothstep's ±0.5 px ramp, or "not the
  // edge colour" would be a statement about the ramp instead of about the mask.
  expect(best!.clearance).toBeGreaterThan(3);

  const [onDiagonal, onRealEdge] = await readCanvasPixels(page, [
    [Math.round(best!.diagonal[0]), Math.round(best!.diagonal[1])],
    [Math.round(best!.real[0]), Math.round(best!.real[1])],
  ]);
  const luma = (p: readonly number[]): number => (p[0]! + p[1]! + p[2]!) / 3;
  console.log(
    `[cap] diagonal pixel rgb(${onDiagonal!.slice(0, 3).join(',')}) at ${best!.clearance.toFixed(1)} px ` +
      `clearance; real edge rgb(${onRealEdge!.slice(0, 3).join(',')})`
  );
  // The edge colour is opaque black, so the real edge is dark and the interior is the lit cap.
  expect(luma(onRealEdge!), 'a real cut edge is drawn in the edge colour').toBeLessThan(40);
  expect(
    luma(onDiagonal!),
    'the suppressed 2-2 diagonal draws nothing: the pixel is still the cap'
  ).toBeGreaterThan(80);
});

test('§11 clip-path equivalence: gl_ClipDistance and the discard fallback are pixel-identical', async ({
  page,
}) => {
  await openClipped(page, { edges: true });
  const hardware = await canvasBytes(page);
  const hardwarePath = await page.evaluate(() => window.__tvxEngine!.caps.clipDistance);

  await openClipped(page, { edges: true, forceDiscardClip: true });
  const fallback = await canvasBytes(page);

  expect(hardware.length).toBe(fallback.length);
  let differing = 0;
  let worst = 0;
  for (let i = 0; i < hardware.length; i += 4) {
    let delta = 0;
    for (let c = 0; c < 4; c += 1)
      delta = Math.max(delta, Math.abs(hardware[i + c]! - fallback[i + c]!));
    if (delta > 0) differing += 1;
    worst = Math.max(worst, delta);
  }
  const total = hardware.length / 4;
  console.log(
    `[clip] hardware path available: ${String(hardwarePath)}; ` +
      `${differing}/${total} pixels differ, worst channel delta ${worst}`
  );
  // Not a tolerance: the fallback recomputes `dot(n, worldPos) + offset` from the same interpolated
  // world position the hardware path interpolates the clip distance from, and `dot` is affine, so
  // the two are the same number and the two images are the same image.
  expect(differing, `${differing} pixels differ between the two clip paths`).toBe(0);
  expect(hardwarePath, 'the first run really did take the hardware path').toBe(true);
});

test('§7.4 composition: a cap is clipped by every plane except its own', async ({ page }) => {
  // Two planes are enough to prove composition — the corner between them exists only if each cap
  // keeps every clip distance but its own. The *sixth* variant is a compile question, not a
  // geometry one, and the test below it asks that separately.
  await openClipped(page, {
    planes: [
      { normal: [Math.SQRT1_2, Math.SQRT1_2, 0], offset: 1 },
      { normal: [0, 0, 1], offset: 0 },
    ],
  });
  const belowBoth = worldToFacePixel([-Math.SQRT2, 0, -4]);
  const [cut] = await readCanvasPixels(page, [
    [Math.round(belowBoth[0]), Math.round(belowBoth[1])],
  ]);
  expect(
    isBackground(cut!),
    `the second plane must still clip the first plane’s cap, got rgb(${cut!.join(',')})`
  ).toBe(true);

  // …and the kept corner is covered by the first plane's cap.
  const aboveBoth = worldToFacePixel([-Math.SQRT2, 0, 4]);
  const [kept] = await readCanvasPixels(page, [
    [Math.round(aboveBoth[0]), Math.round(aboveBoth[1])],
  ]);
  expect(isBackground(kept!)).toBe(false);
});

test('§7.4 all six planes compile and draw, on both paths', async ({ page }) => {
  // N is a **variant key**, so N = 6 is a program nothing else in this file compiles: six unrolled
  // `gl_ClipDistance` assignments against `out highp float gl_ClipDistance[6]`, or six iterations of
  // the fallback's loop. A link failure here would be silent in every other test.
  //
  // Six planes at ±5 mm on the three axes leave the cube's central 10 mm box, so the surviving
  // solid is bounded by six caps and nothing else — every one of them clipped by the other five.
  const box = 5;
  const planes: { normal: [number, number, number]; offset: number }[] = [
    { normal: [1, 0, 0], offset: box },
    { normal: [-1, 0, 0], offset: box },
    { normal: [0, 1, 0], offset: box },
    { normal: [0, -1, 0], offset: box },
    { normal: [0, 0, 1], offset: box },
    { normal: [0, 0, -1], offset: box },
  ];
  for (const forceDiscardClip of [false, true]) {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openClipped(page, { planes, capsOnly: true, forceDiscardClip });
    expect(
      errors,
      `N = 6 must compile on ${forceDiscardClip ? 'the fallback' : 'hardware'}`
    ).toEqual([]);

    // The −X cap faces the camera and fills the middle of the pane; outside the box is background.
    const inside = worldToFacePixel([-box, 2, 2]);
    const outside = worldToFacePixel([-box, box + 3, 0]);
    const [middle, beyond] = await readCanvasPixels(page, [
      [Math.round(inside[0]), Math.round(inside[1])],
      [Math.round(outside[0]), Math.round(outside[1])],
    ]);
    expect(isBackground(middle!), `the six-plane box is drawn, got rgb(${middle!.join(',')})`).toBe(
      false
    );
    expect(
      isBackground(beyond!),
      `and nothing survives outside it, got rgb(${beyond!.join(',')})`
    ).toBe(true);
  }
});

test('tagStyle.visible hides a cap’s tissue without re-cutting (R5)', async ({ page }) => {
  // `capsOnly`, so "the cap is gone" can mean *background*. With the surface drawn, hiding a cap's
  // tissue reveals the far half's interior rather than nothing, and the assertion would be about
  // whatever happens to stand behind the cut instead of about the cap.
  await openClipped(page, { capsOnly: true });
  const upperAt = worldToFacePixel(capPointAtPaneY(PANE / 2 - 60));
  const lowerAt = worldToFacePixel(capPointAtPaneY(PANE / 2 + 60));
  // Off the pane's centre column: world y = 0 is a lattice plane of the fixture, so the column
  // itself sits on real element edges shared by two tets.
  const upper: [number, number] = [Math.round(upperAt[0]) + 12, Math.round(upperAt[1])];
  const lower: [number, number] = [Math.round(lowerAt[0]) + 12, Math.round(lowerAt[1])];
  const [beforeLower, beforeUpper] = await readCanvasPixels(page, [lower, upper]);
  expect(isBackground(beforeLower!)).toBe(false);
  expect(isBackground(beforeUpper!)).toBe(false);

  const generation = await page.evaluate(
    ([surfaceTags, tag2]) => {
      const engine = window.__tvxEngine as unknown as {
        meshCut(id: string): { generation: number } | null;
        updateLayer(id: string, patch: unknown): void;
      };
      const before = engine.meshCut(window.__tvxClipLayer!)?.generation ?? -1;
      // `tagStyle` is replaced wholesale by a patch, so tag 2's edited colour is repeated here —
      // dropping it would recolour tag 2 back to its LUT grey and the "untouched" assertion would
      // be measuring that instead.
      const tagStyle: Record<number, { visible: boolean; opacity: number; color?: number[] }> = {
        1: { visible: false, opacity: 1 },
        2: {
          visible: true,
          opacity: 1,
          color: [tag2[0]! / 255, tag2[1]! / 255, tag2[2]! / 255, 1],
        },
      };
      for (const t of surfaceTags) tagStyle[t] = { visible: false, opacity: 1 };
      engine.updateLayer(window.__tvxClipLayer!, { tagStyle });
      return { before, after: engine.meshCut(window.__tvxClipLayer!)?.generation ?? -1 };
    },
    [SURFACE_TAGS, TAG2_EDITED] as const
  );
  const [afterLower, afterUpper] = await readCanvasPixels(page, [lower, upper]);
  expect(
    isBackground(afterLower!),
    `hiding tet tag 1 clears its cap, got rgb(${afterLower!.join(',')})`
  ).toBe(true);
  // …and only its cap: tag 2's half of the same cut is byte-identical.
  expect([...afterUpper!], 'tag 2’s cap is untouched').toEqual([...beforeUpper!]);
  // §7.4's palette route: visibility is alpha in an 8N-byte texture, so no cut is re-issued.
  expect(generation.after, 'hiding a tag does not re-cut').toBe(generation.before);
});

test('golden: mesh-clip-caps', async ({ page }) => {
  await openClipped(page, { edges: true });
  await expectGolden(page, 'mesh-clip-caps');
});

test('the background is what `isBackground` says it is', () => {
  // The one constant this file compares against, pinned to `Scene.background` so a defaults change
  // fails here rather than turning every "is clipped" assertion into a tautology.
  expect([...BACKGROUND]).toEqual([10, 13, 18, 255]);
});
