/**
 * **The glyph verification directed task 7 asks for**, on `ernie_TDCS_1_scalar.msh` against numpy.
 *
 * `packages/engine/test/fixtures/glyph-ref-ernie.json` is written by
 * `scripts/reference/glyphs.py` — SimNIBS reads the mesh, numpy does the rest — and holds, for every
 * grey-matter tet whose centroid is within 0.05 mm of `z = 40`, its Gmsh element number, its
 * centroid, its `E` vector and |E|. 1,397 elements, and the whole field's magnitude statistics.
 *
 * The engine is then asked for exactly that set — `origins: 'volume'`, tet tag 2 alone visible,
 * `onCutPlaneOnly` about a `z = 40` clip plane at 0.05 mm half-thickness, stride 1 — and
 * `Engine.glyphInstances` reports what it would draw. The assertions:
 *
 * * **the same elements**, as a set. The origins come back in `meshCentroids`' Morton order and the
 *   reference is in element order, so this is set equality, not a zip — but it *is* equality, not
 *   containment: a stride that skipped, a tag filter that leaked or a slab off by a rounding would
 *   all change the set.
 * * **origin within 0.01 mm** of the centroid numpy computed as the mean of the four node positions.
 * * **direction within 1°** of `E`.
 * * **length equal to the scaling model's** `f(|E|)`, in all four modes, to 1e-4 mm.
 *
 * Skips, never fails, when `TETRAVOX_TESTDATA` is unset (AGENTS rule 2).
 */

import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { glyphLengthMm } from '../../src/derived/glyph-scale';
import type { GlyphScaling } from '../../src/scene/types';

const ROOT = process.env.TETRAVOX_TESTDATA ?? '';
const MESH = 'Simulations/L_Insula/high_Frequency/mesh/ernie_TDCS_1_scalar.msh';

interface Reference {
  plane: { axis: number; offset: number; half: number };
  tags: number[];
  count: number;
  elements: number[];
  centroids: [number, number, number][];
  vectors: [number, number, number][];
  magnitudes: number[];
  stats: { min: number; max: number; p99: number };
}

const REF: Reference = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/glyph-ref-ernie.json', import.meta.url)), 'utf8')
) as Reference;

test.skip(ROOT === '', 'TETRAVOX_TESTDATA is unset');
// The mesh is 420 MB and the op strides 1.34 M grey-matter tets; the default 30 s is not enough on
// the software leg.
test.setTimeout(600_000);

test('glyph origins, directions and lengths match numpy on ernie E', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/test/pages/scene.html');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);

  const result = await page.evaluate(
    async ([url, plane, tags]) => {
      const engine = window.__tvxEngine!;
      engine.retainGlyphSources(true);
      const ds = await engine.addDataset({ kind: 'path', path: url as string });
      if (ds.kind !== 'mesh') throw new Error('not a mesh dataset');
      const info = ds.fields.find((f) => f.name === 'E' && f.source === 'elm');
      if (info === undefined) throw new Error('no elm field E');

      const p = plane as { axis: number; offset: number; half: number };
      const normal: [number, number, number] = [0, 0, 0];
      normal[p.axis] = 1;
      const layer = engine.addLayer({ datasetId: ds.id, kind: 'mesh' });
      engine.setLayout({ kind: '3d-only', cells: ['view3d'] });
      engine.updateLayer(layer.id, {
        // Only the tags the reference kept; `visibleTetTags` is what the op's allow-list is built
        // from, so this is the same restriction on both sides.
        tagStyle: Object.fromEntries(
          ds.tags.map((t) => [t.id, { visible: (tags as number[]).includes(t.id), opacity: 1 }])
        ),
        // `dot(normal, x) + offset` is the plane's signed distance (§4), so the offset is −z.
        clip: {
          planes: [{ plane: { normal, offset: -p.offset }, enabled: true }],
          caps: false,
          capColorMode: 'inherit',
        },
        glyphs: {
          field: { source: 'elm', name: 'E' },
          shape: 'arrow',
          subsample: { everyNth: 1 },
          scale: { mode: 'fixed', lengthMm: 6, normalizeTo: 'p99', logFloor: 0.05 },
          lengthMm: 6,
          colorBy: 'magnitude',
          color: [1, 1, 1, 1],
          clipToCutPlane: false,
          onCutPlaneOnly: true,
          cutSlabMm: p.half,
          origins: 'volume',
        },
      });
      await engine.whenSettled();
      let inst = engine.glyphInstances(layer.id);
      for (let i = 0; i < 600 && (inst === null || inst.length === 0); i += 1) {
        engine.renderNow();
        await new Promise((r) => setTimeout(r, 100));
        inst = engine.glyphInstances(layer.id);
      }
      if (inst === null) throw new Error('glyph readback unavailable');
      return {
        layerId: layer.id,
        stats: { min: info.stats.min, max: info.stats.max, p99: info.stats.percentiles['99'] },
        instances: inst.map((g) => ({
          element: g.element,
          origin: g.origin,
          vector: g.vector,
          magnitude: g.magnitude,
          lengthMm: g.lengthMm,
        })),
      };
    },
    [`/@fs${ROOT}/${MESH}`, REF.plane, REF.tags] as const
  );
  expect(errors).toEqual([]);

  // The engine's own magnitude statistics against numpy's over the same 5,900,498 values. §6.0 says
  // `FieldStats` is of the **magnitude** for a vector field; the scaling model normalises to these,
  // so a mismatch here would make every length wrong by a constant nobody could see.
  expect(result.stats.max).toBeCloseTo(REF.stats.max, 4);
  expect(result.stats.min / REF.stats.min).toBeCloseTo(1, 3);
  expect(result.stats.p99).toBeCloseTo(REF.stats.p99, 2);

  const got = new Map(result.instances.map((g) => [g.element, g]));
  expect(got.size, 'the engine must sample every element numpy did, and no other').toBe(REF.count);
  expect([...got.keys()].sort((a, b) => a - b)).toEqual([...REF.elements].sort((a, b) => a - b));

  const scalings: GlyphScaling[] = [
    { mode: 'fixed', lengthMm: 6, normalizeTo: 'p99', logFloor: 0.05 },
    { mode: 'linear', lengthMm: 6, normalizeTo: 'p99', logFloor: 0.05 },
    { mode: 'sqrt', lengthMm: 6, normalizeTo: 'max', logFloor: 0.05 },
    { mode: 'log', lengthMm: 6, normalizeTo: 'p99', logFloor: 0.05 },
  ];

  let worstOrigin = 0;
  let worstAngleDeg = 0;
  for (let i = 0; i < REF.count; i += 1) {
    const element = REF.elements[i]!;
    const g = got.get(element);
    expect(g, `element ${element}`).toBeDefined();
    if (g === undefined) continue;

    const c = REF.centroids[i]!;
    const d = Math.hypot(g.origin[0] - c[0], g.origin[1] - c[1], g.origin[2] - c[2]);
    worstOrigin = Math.max(worstOrigin, d);

    // The `.msh` carries f64 and the engine's field tables are `R32F`, so the vector is compared by
    // **angle**, which is what a glyph shows, at f32's own resolution.
    const v = REF.vectors[i]!;
    const m = REF.magnitudes[i]!;
    const dot = g.vector[0] * v[0] + g.vector[1] * v[1] + g.vector[2] * v[2];
    const cos = Math.min(1, Math.max(-1, dot / (g.magnitude * m)));
    worstAngleDeg = Math.max(worstAngleDeg, (Math.acos(cos) * 180) / Math.PI);
    expect(Math.abs(g.magnitude / m - 1), `|E| at ${element}`).toBeLessThan(1e-5);

    // The length, in every mode, against the model evaluated on numpy's magnitude and the field's
    // own p99 / max — not against the engine's own answer for the same thing.
    for (const s of scalings) {
      const ref = s.normalizeTo === 'max' ? REF.stats.max : REF.stats.p99;
      const want = glyphLengthMm(s, m, ref);
      const have = glyphLengthMm(s, g.magnitude, ref);
      expect(Math.abs(have - want), `${s.mode} length at ${element}`).toBeLessThan(1e-4);
    }
  }

  expect(worstOrigin, 'every origin within 0.01 mm of the tet centroid').toBeLessThan(0.01);
  expect(worstAngleDeg, 'every direction within 1 degree of E').toBeLessThan(1);
  // eslint-disable-next-line no-console
  console.log(
    `glyphs vs numpy: ${REF.count} elements, worst origin ${worstOrigin.toExponential(2)} mm, ` +
      `worst angle ${worstAngleDeg.toExponential(2)} deg`
  );
});
