/**
 * The four E-MESH §11 obligations that reached the Phase-2 gate with **no test and no golden**.
 *
 * `docs/PHASE2-OWNERSHIP.md` names eight E-MESH goldens. Four shipped (`mesh-clip-caps`,
 * `mesh-clip-caps-ernie`, `mesh-isolate-tags`, `mesh-isolate-field-ernie`); four did not —
 * `mesh-tagstyle-tissue`, `mesh-field-node`, `mesh-field-elm`, `mesh-edges-masked` — and
 * `mesh-transparency-twophase` had neither a golden nor the analytic assertion §7.2's two-phase
 * split is supposed to be pinned by. This file is the gate runner closing them, in one place, so a
 * later reader can see which assertions were written after the owner's branch merged.
 *
 * Everything is on `testdata/mesh_v2_binary.msh` — the committed 3×3×3 lattice `mesh-support.ts`
 * documents — and every expectation is arithmetic on that fixture's own construction rules:
 *
 * * `node_scalar = 0.1·x + 0.01·y + 0.001·z`, affine in world position, so its value at a fragment
 *   is a function of the world point `facePixelToWorld` names — no triangle needs identifying.
 * * `elm_scalar = 0.5·row − 3` over the 0-based element rows, tri block first, and the file's
 *   element numbers are contiguous `1..104` `[testdata/manifest.json]`, so the value at a fragment
 *   is `0.5·(pick.elementId − 1) − 3`.
 *
 * **How the headlight is kept out of the expectations.** §7.4 shades every fragment
 * `C·(ambient + (1 − ambient)·diff) + spec`, and `diff`/`spec` depend only on `dot(n, v)`. So the
 * field tests **measure** that scalar pair at the very pixel they assert on, by reading the same
 * fragment once in `colorMode:'tag'` — where the base colour is the fixture LUT's own 0..255 triple
 * — and fitting `(s, t)` with `mesh-support.ts`'s `fitShading`. Nothing below models an ambient or
 * a specular constant, and no expectation comes from a previous run.
 *
 * The grey ramp is the second half of that: `bakeScale('gray')` writes texel `i` as `(i, i, i)` and
 * the shader samples it `NEAREST` at `t = (v − lo)/(hi − lo)`, so the base colour of a field
 * fragment is `floor(t · 256)` in all three channels — the same model `derived-r4.spec.ts` uses for
 * `TI_max`, and the reason a *fit* would be worthless here: a grey has no channel spread to fit.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { expectGolden, readCanvasPixels } from '../helpers/pixels';
import type { Rgba } from '../helpers/pixels';
import {
  BACKGROUND,
  FACE_HALF_MM,
  facePixelToWorld,
  FRONT_FACE_CAMERA,
  fitShading,
  isPlausibleShading,
  nodeScalarAt,
  PANE,
} from './mesh-support';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const fixture = (name: string): string => `/@fs${REPO}testdata/${name}`;

const LATTICE = fixture('mesh_v2_binary.msh');
const LATTICE_LUT = fixture('mesh_v2_binary_LUT.txt');

/** `mesh_v2_binary_LUT.txt`'s tri-tag colours, as the exact 0..255 triples §4.1 round-trips. */
const LUT_1002 = [255, 239, 179, 255] as const;
const LUT_1001 = [104, 163, 255, 255] as const;

/** ±9 mm on the front face, in pane pixels — `mesh-tagstyle.spec.ts`'s own two probes. */
const DZ = Math.round((9 / FACE_HALF_MM) * (PANE / 2));
/** In tag 1002's half (z > 0). */
const TOP: readonly [number, number] = [PANE / 2, PANE / 2 - DZ];
/** In tag 1001's half (z < 0). */
const BOTTOM: readonly [number, number] = [PANE / 2, PANE / 2 + DZ];

declare global {
  interface Window {
    __tvxGateLayer?: string;
  }
}

interface OpenOptions {
  /** Sidecars: the LUT alone, never the `.msh.opt` — its `Hide "*"` is a different feature. */
  lut?: boolean;
  patch?: Record<string, unknown>;
}

async function openLattice(page: Page, opts: OpenOptions = {}): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/test/pages/scene.html');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);
  await page.evaluate(
    async ([url, lutUrl, camera, patch]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({
        kind: 'path',
        path: url as string,
        sidecars: { lut: lutUrl as string },
      });
      const layer = engine.addLayer({ datasetId: ds.id, kind: 'mesh' });
      window.__tvxGateLayer = layer.id;
      engine.setLayout({ kind: '3d-only', cells: ['view3d'] });
      engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });
      engine.setView('view3d', { camera: camera as never });
      if (patch !== null) engine.updateLayer(layer.id, patch as never);
      await engine.whenSettled();
    },
    [LATTICE, LATTICE_LUT, FRONT_FACE_CAMERA, opts.patch ?? null] as const
  );
  return errors;
}

/**
 * Apply a patch and wait for the layer to be *drawable* again.
 *
 * §7.4's three async switches — the first element field, the first `edges.surface`, the first
 * `colorMode:'label'` — are "loads with a progress state, not instant checkboxes", so a single
 * `whenSettled()` can resolve before the de-indexed variant has arrived. Settling repeatedly until
 * the pane stops changing is the honest wait: it neither sleeps a fixed time nor asserts on a frame
 * the geometry has not reached.
 */
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

/** The grey byte `bakeScale('gray')` puts under `v` on a linear `[lo, hi]` scale (§7.6). */
function greyFor(v: number, lo: number, hi: number): number {
  const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
  return Math.min(255, Math.max(0, Math.floor(t * 256)));
}

/** `SRC_ALPHA, ONE_MINUS_SRC_ALPHA` in 8-bit storage. */
function over(src: readonly number[], a: number, dst: readonly number[]): [number, number, number] {
  return [0, 1, 2].map((c) => Math.round((src[c] ?? 0) * a + (dst[c] ?? 0) * (1 - a))) as [
    number,
    number,
    number,
  ];
}

function expectChannels(px: Rgba, want: readonly number[], tol: number, label: string): void {
  for (let c = 0; c < 3; c += 1) {
    expect(
      Math.abs((px[c] ?? 0) - (want[c] ?? 0)),
      `${label}: channel ${c} expected ${want[c]} ±${tol}, got ${px[c]} (whole pixel ${px.join(',')})`
    ).toBeLessThanOrEqual(tol);
  }
}

// -------------------------------------------------------------------------------------------
// mesh-tagstyle-tissue — §8's tissue table, as pixels
// -------------------------------------------------------------------------------------------

/**
 * The golden for the state §8's tissue table produces: one tag recoloured, one at half opacity.
 *
 * The analytic half is `mesh-tagstyle.spec.ts`, which asserts the exact 0..255 round trip of a
 * recolour, that hiding removes exactly that tag's pixels, and that an opacity is a real blend.
 * This is the regression image those three assertions do not give.
 */
test('golden: mesh-tagstyle-tissue', async ({ page }) => {
  const errors = await openLattice(page);
  await patchAndSettle(page, {
    tagStyle: {
      1001: { visible: true, opacity: 0.5, color: [0.4, 0.8, 0.2, 1] },
      1002: { visible: true, opacity: 1, color: [0.8, 0.2, 0.6, 1] },
    },
  });
  expect(errors).toEqual([]);
  await expectGolden(page, 'mesh-tagstyle-tissue');
});

// -------------------------------------------------------------------------------------------
// mesh-field-node — §7.4's node-field colouring
// -------------------------------------------------------------------------------------------

const NODE_LO = -1.11;
const NODE_HI = 1.11;

test('a node field paints `bakeScale`’s grey for the value the fixture’s own formula gives', async ({
  page,
}) => {
  const errors = await openLattice(page);

  // 1. The shading term, measured at the two probes with the LUT colour the dataset carries.
  const [tagTop, tagBottom] = await readCanvasPixels(page, [TOP, BOTTOM]);
  const shadeTop = fitShading(LUT_1002, tagTop!);
  const shadeBottom = fitShading(LUT_1001, tagBottom!);
  expect(shadeTop.residual, 'the tag pixel is the LUT colour, lit').toBeLessThan(1.5);
  expect(shadeBottom.residual, 'the tag pixel is the LUT colour, lit').toBeLessThan(1.5);
  expect(isPlausibleShading(shadeTop)).toBe(true);
  expect(isPlausibleShading(shadeBottom)).toBe(true);

  // 2. The same fragments under `node_scalar`. The geometry, the camera and the normal are
  //    unchanged, so `(s, t)` is unchanged and only the base colour moved.
  await patchAndSettle(page, {
    colorMode: 'field',
    field: { source: 'node', name: 'node_scalar', component: 'mag' },
    colormap: 'gray',
    scale: { kind: 'linear', lo: NODE_LO, hi: NODE_HI },
  });
  const [fieldTop, fieldBottom] = await readCanvasPixels(page, [TOP, BOTTOM]);

  for (const [name, probe, shade, px] of [
    ['top', TOP, shadeTop, fieldTop!],
    ['bottom', BOTTOM, shadeBottom, fieldBottom!],
  ] as const) {
    const world = facePixelToWorld(probe[0], probe[1]);
    const value = nodeScalarAt(world);
    const g = greyFor(value, NODE_LO, NODE_HI);
    const want = [0, 1, 2].map(() => g * shade.s + shade.t);
    // eslint-disable-next-line no-console
    console.log(
      `[mesh-field-node] ${name} world (${world.map((v) => v.toFixed(3)).join(', ')}) ` +
        `node_scalar ${value.toFixed(4)} -> grey ${g}; shading s=${shade.s.toFixed(3)} ` +
        `t=${shade.t.toFixed(2)}; expected ${want.map((v) => v.toFixed(1)).join(',')} ` +
        `got ${px.slice(0, 3).join(',')}`
    );
    expectChannels(px, want, 4, `node field at ${name}`);
  }
  expect(errors).toEqual([]);
});

test('golden: mesh-field-node', async ({ page }) => {
  const errors = await openLattice(page);
  await patchAndSettle(page, {
    colorMode: 'field',
    field: { source: 'node', name: 'node_scalar', component: 'mag' },
    colormap: 'viridis',
    scale: { kind: 'linear', lo: NODE_LO, hi: NODE_HI },
  });
  expect(errors).toEqual([]);
  await expectGolden(page, 'mesh-field-node');
});

// -------------------------------------------------------------------------------------------
// mesh-field-elm — §7.4's element-field colouring, on the de-indexed variant
// -------------------------------------------------------------------------------------------

/** `elm_scalar` over all 104 elements: `0.5·row − 3`, so `[−3, 48.5]` [testdata/manifest.json]. */
const ELM_LO = -3;
const ELM_HI = 48.5;

/**
 * The reference frame for a **de-indexed** measurement: still `colorMode: 'tag'`, so the base colour
 * is the LUT's own 0..255 triple, but on the geometry variant an element field draws from.
 *
 * `layers/mesh.ts`'s `variantFor` picks `deindexed` for `field.source === 'elm'` **and** for
 * `edges.surface`, so turning edges on with a fully transparent edge colour moves the reference
 * frame onto the same variant while `mix(rgb, uEdgeColor.rgb, edge * uEdgeColor.a)` contributes
 * nothing. That is not a decoration: the two variants have **different normals** at the same
 * fragment — the indexed lattice averages its normals at the cube's own corners, so the front face
 * is a gradient there and flat under the de-indexed variant — and `(s, t)` measured on one does not
 * transfer to the other. Measured at `TOP`: the indexed frame fits `s ≈ 0.55`, the de-indexed frame
 * `s ≈ 0.94`, i.e. a 30-byte error on a grey of 67.
 */
const DEINDEXED_REFERENCE = {
  edges: { surface: true, caps: false },
  edgeColor: [1, 0, 0, 0],
  edgeWidthPx: 1,
} as const;

test('an element field paints the grey of the element `pick` names, on the de-indexed variant', async ({
  page,
}) => {
  const errors = await openLattice(page);
  await patchAndSettle(page, { ...DEINDEXED_REFERENCE });
  const [tagTop, tagBottom] = await readCanvasPixels(page, [TOP, BOTTOM]);
  const shadeTop = fitShading(LUT_1002, tagTop!);
  const shadeBottom = fitShading(LUT_1001, tagBottom!);
  expect(shadeTop.residual, 'the tag pixel is the LUT colour, lit').toBeLessThan(1.5);
  expect(shadeBottom.residual, 'the tag pixel is the LUT colour, lit').toBeLessThan(1.5);

  // Which element covers each probe is the pick pass's answer, not this file's guess.
  //
  // §7.2.3's pick geometry is the **de-indexed** variant, and `Engine.pick` requests it lazily —
  // "a no-op if it has not landed yet" — so the first call after a fresh load returns `null` by
  // design. Retrying until it lands is waiting for that request, not tolerating a flake.
  const picked = await page.evaluate(
    async (probes) => {
      const engine = window.__tvxEngine!;
      const out: ({ elementId: number; kind: string } | null)[] = [];
      for (const p of probes) {
        let hit = null as ReturnType<typeof engine.pick>;
        for (let i = 0; i < 60 && hit === null; i += 1) {
          hit = engine.pick('view3d', p[0], p[1]);
          if (hit === null) {
            await engine.whenSettled();
            await new Promise((r) => setTimeout(r, 25));
          }
        }
        out.push(hit === null ? null : { elementId: hit.elementId, kind: hit.elementKind });
      }
      return out;
    },
    [TOP, BOTTOM] as const
  );
  expect(picked[0], 'the pick pass finds a triangle at the top probe').not.toBeNull();
  expect(picked[1]).not.toBeNull();
  expect(picked[0]?.kind).toBe('tri');
  expect(picked[1]?.kind).toBe('tri');

  await patchAndSettle(page, {
    ...DEINDEXED_REFERENCE,
    colorMode: 'field',
    field: { source: 'elm', name: 'elm_scalar', component: 'mag' },
    colormap: 'gray',
    scale: { kind: 'linear', lo: ELM_LO, hi: ELM_HI },
  });
  const [fieldTop, fieldBottom] = await readCanvasPixels(page, [TOP, BOTTOM]);

  for (const [name, hit, shade, px] of [
    ['top', picked[0]!, shadeTop, fieldTop!],
    ['bottom', picked[1]!, shadeBottom, fieldBottom!],
  ] as const) {
    // `scripts/gen-fixtures.py`: `elm_scalar = arange(ne) * 0.5 - 3`, and the file's element numbers
    // are contiguous `1..104` with the tri block first, so row = number − 1.
    const value = 0.5 * (hit.elementId - 1) - 3;
    const g = greyFor(value, ELM_LO, ELM_HI);
    const want = [0, 1, 2].map(() => g * shade.s + shade.t);
    // eslint-disable-next-line no-console
    console.log(
      `[mesh-field-elm] ${name} element ${hit.elementId} -> elm_scalar ${value} -> grey ${g}; ` +
        `expected ${want.map((v) => v.toFixed(1)).join(',')} got ${px.slice(0, 3).join(',')}`
    );
    expectChannels(px, want, 4, `elm field at ${name}`);
  }
  expect(errors).toEqual([]);
});

test('golden: mesh-field-elm', async ({ page }) => {
  const errors = await openLattice(page);
  await patchAndSettle(page, {
    colorMode: 'field',
    field: { source: 'elm', name: 'elm_scalar', component: 'mag' },
    colormap: 'viridis',
    scale: { kind: 'linear', lo: ELM_LO, hi: ELM_HI },
  });
  expect(errors).toEqual([]);
  await expectGolden(page, 'mesh-field-elm');
});

// -------------------------------------------------------------------------------------------
// mesh-edges-masked — §7.4's barycentric edges, by the shader's own formula
// -------------------------------------------------------------------------------------------

/**
 * §11's edge obligation: *"a fragment at a known barycentric distance has the
 * `1 − smoothstep(w − 0.5, w + 0.5, d)` value, computed by hand"*.
 *
 * The distance is known because the front face is at a constant depth — every point of `x = −10`
 * projects with the same scale — so the pane distance from the `y = 0` grid line, which is a
 * triangle edge shared by the face's four quads, **is** `d` in pixels. `d = bary / fwidth(bary)` is
 * exactly the perpendicular pixel distance for an affine interpolant, which is what makes this a
 * closed-form expectation rather than a fit.
 *
 * `w = 4.25` is chosen so the ramp `(3.75, 4.75)` straddles a pixel *centre*: at `w = 4` the ramp
 * would fall exactly between two centres and every sample would read 0 or 1, which is the shape a
 * broken `smoothstep` also produces.
 *
 * The cleared-bit half of the obligation is `mesh-clip.spec.ts`'s **cap diagonal**, which finds a
 * 2-2-split quad by its `Cut.edge_mask` and shows the suppressed diagonal draws no edge while the
 * real edge does.
 */
const EDGE_WIDTH_PX = 4.25;
const EDGE_COLOR255 = [255, 0, 0] as const;

function edgeFactor(d: number, w: number): number {
  const e0 = w - 0.5;
  const e1 = w + 0.5;
  const t = Math.min(1, Math.max(0, (d - e0) / (e1 - e0)));
  return 1 - t * t * (3 - 2 * t);
}

test('a surface edge is `1 − smoothstep(w−0.5, w+0.5, d)` of the edge colour, at the distance the projection names', async ({
  page,
}) => {
  const errors = await openLattice(page);

  // 200 px below the pane's horizontal centre line: in tag 1001's half, 200 px from the `z = 0`
  // edge and ~130 px from the quad's diagonal, so `min(d.x, d.y, d.z)` is the `y = 0` line alone.
  const PY = PANE / 2 + 200;
  //         d = 0.5      d = 3.5    d = 4.5     d = 8.5 (outside the ramp entirely)
  const KS = [0, 3, 4, 8];
  const probes = KS.map((k) => [PANE / 2 + k, PY] as const);

  // The reference frame is drawn with edges **on** and the edge colour's alpha at zero, so
  // `mix(rgb, uEdgeColor.rgb, edge * uEdgeColor.a)` contributes nothing while everything else is
  // identical. Turning `edges.surface` off instead would swap the *geometry variant* — the indexed
  // lattice averages its normals at the cube's own corners, so a face that is flat under the
  // de-indexed variant is a gradient under the indexed one, and the "unlit-by-edge" reference would
  // be a different colour for a reason that has nothing to do with edges.
  //
  // **The tag is recoloured, and that is the assertion's precondition, not a preference.** The
  // expectation is `mix(base, edgeColor, e)` read off the *measured* base, so the measured base has
  // to be the real one: `uEdgeColor.a = 0` frames store `clamp(C·s + spec, 0, 1)`, and tag 1001's
  // LUT blue is already 255 before the headlight's `spec` term adds ~22 more. On a saturated channel
  // the frame reports 255 where the shader computed ~273, and mixing *down* from the clamped value
  // under-predicts the drawn pixel by exactly the clipped amount (measured: expected 215.2, drawn
  // 230, at `d = 4.5`). (0.40, 0.50, 0.60) leaves every channel of `C·s + spec` under 200, so the
  // reference frame is the unclamped base and the mix is the only thing being tested.
  const DIM_TAG = { 1001: { visible: true, opacity: 1, color: [0.4, 0.5, 0.6, 1] } };
  await patchAndSettle(page, {
    tagStyle: DIM_TAG,
    edges: { surface: true, caps: false },
    edgeColor: [1, 0, 0, 0],
    edgeWidthPx: EDGE_WIDTH_PX,
  });
  const lit = await readCanvasPixels(page, probes);
  for (const [i, k] of KS.entries()) {
    // A channel that reached the ceiling in the reference frame is not a measurement of the base.
    for (let c = 0; c < 3; c += 1) {
      expect(
        lit[i]![c],
        `probe ${k}: channel ${c} of the reference frame must not be clamped`
      ).toBeLessThan(250);
    }
  }
  await patchAndSettle(page, {
    tagStyle: DIM_TAG,
    edges: { surface: true, caps: false },
    edgeColor: [1, 0, 0, 1],
    edgeWidthPx: EDGE_WIDTH_PX,
  });
  const drawn = await readCanvasPixels(page, probes);

  for (const [i, k] of KS.entries()) {
    const d = k + 0.5; // the pixel's centre, in the continuous coordinate the shader works in
    const e = edgeFactor(d, EDGE_WIDTH_PX);
    const want = [0, 1, 2].map((c) => (lit[i]![c] ?? 0) * (1 - e) + (EDGE_COLOR255[c] ?? 0) * e);
    // eslint-disable-next-line no-console
    console.log(
      `[mesh-edges-masked] d=${d.toFixed(1)} px -> edge ${e.toFixed(4)}; ` +
        `unlit-by-edge ${lit[i]!.slice(0, 3).join(',')} expected ` +
        `${want.map((v) => v.toFixed(1)).join(',')} got ${drawn[i]!.slice(0, 3).join(',')}`
    );
    // ±4: `fwidth` is a 2×2-quad difference, so `d` is exact only to the derivative's own step.
    expectChannels(drawn[i]!, want, 4, `edge at d=${d.toFixed(1)}`);
  }
  // The furthest probe is outside the ramp, so it must be byte-identical to the un-edged frame:
  // an edge that leaks there is a `min` that never got the 1e9 sentinel.
  expect([...drawn[KS.length - 1]!], 'no edge 8.5 px away').toEqual([...lit[KS.length - 1]!]);
  expect(errors).toEqual([]);
});

test('golden: mesh-edges-masked', async ({ page }) => {
  const errors = await openLattice(page);
  await patchAndSettle(page, {
    edges: { surface: true, caps: false },
    edgeColor: [0.05, 0.05, 0.08, 1],
    edgeWidthPx: 1.5,
  });
  expect(errors).toEqual([]);
  await expectGolden(page, 'mesh-edges-masked');
});

// -------------------------------------------------------------------------------------------
// mesh-transparency-twophase — §7.2's 2a/2b split, counted
// -------------------------------------------------------------------------------------------

/**
 * §7.2 splits a translucent tag into **2a back faces** then **2b front faces**, each sorted
 * back-to-front. The claim a number can pin is *how many sheets reach the pixel*: along a ray that
 * enters the cube through the `x = −10` face and leaves through `x = +10`, exactly two triangles of
 * tag 1002 are crossed, so the composite is `over(front, over(back, background))` — one blend per
 * sheet, no more.
 *
 * The probe is 20 px above the pane centre rather than at `TOP`: the eye is at `(−31, 0, 0)`, so a
 * ray through `(−10, 0, 9)` leaves the cube through the **top** face at a different angle, while a
 * ray through `(−10, 0, 0.53)` leaves through the far face at `dot(n, v) = 0.99968` — the same
 * scalar, to five decimals, as the near one. Both sheets are therefore lit identically, which is
 * what lets one opaque measurement stand for both.
 *
 * What this does **not** pin is the *order* of the two sheets, because on this fixture they are the
 * same colour: no ray through the eye at `z = 0` can cross the `z = 0` tag interface, so a
 * two-coloured ray does not exist here. §11's named **Transparency (i)** and **(ii)** are the
 * ordering tests, on ernie; see the Phase-2 gate table for their state.
 */
const TWO_SHEET: readonly [number, number] = [PANE / 2, PANE / 2 - 20];
const TRANSPARENT_ALPHA = 0.35;

test('a translucent tag blends each of its two sheets exactly once (§7.2 two-phase)', async ({
  page,
}) => {
  const errors = await openLattice(page);
  // Tag 1001 hidden: the ray must cross tag 1002's two sheets and nothing else.
  await patchAndSettle(page, {
    tagStyle: {
      1001: { visible: false, opacity: 1 },
      1002: { visible: true, opacity: 1 },
    },
  });
  const [opaque] = await readCanvasPixels(page, [TWO_SHEET]);
  const litFit = fitShading(LUT_1002, opaque!);
  expect(litFit.residual, 'the opaque probe is the LUT colour, lit').toBeLessThan(1.5);

  await patchAndSettle(page, {
    tagStyle: {
      1001: { visible: false, opacity: 1 },
      1002: { visible: true, opacity: TRANSPARENT_ALPHA },
    },
  });
  const [blended] = await readCanvasPixels(page, [TWO_SHEET]);

  const oneSheet = over(opaque!, TRANSPARENT_ALPHA, BACKGROUND);
  const twoSheets = over(opaque!, TRANSPARENT_ALPHA, oneSheet);
  // eslint-disable-next-line no-console
  console.log(
    `[mesh-transparency] lit ${opaque!.slice(0, 3).join(',')}; one sheet would be ` +
      `${oneSheet.join(',')}, two sheets ${twoSheets.join(',')}; got ${blended!.slice(0, 3).join(',')}`
  );
  expectChannels(blended!, twoSheets, 3, 'two sheets, one blend each');
  // …and the one-sheet answer is far enough away to be a different measurement, not a rounding of
  // the same one: a culled back face would land there.
  const gap = Math.max(...[0, 1, 2].map((c) => Math.abs(twoSheets[c]! - oneSheet[c]!)));
  expect(gap, 'the one-sheet and two-sheet answers are distinguishable').toBeGreaterThan(10);
  expect(errors).toEqual([]);
});

test('golden: mesh-transparency-twophase', async ({ page }) => {
  const errors = await openLattice(page);
  await patchAndSettle(page, {
    tagStyle: {
      1001: { visible: true, opacity: 1 },
      1002: { visible: true, opacity: TRANSPARENT_ALPHA },
    },
  });
  expect(errors).toEqual([]);
  await expectGolden(page, 'mesh-transparency-twophase');
});
