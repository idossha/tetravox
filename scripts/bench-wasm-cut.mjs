/**
 * §9.1 row 10 — `plane_cut` on ernie, indexed, mid-axial and oblique, **in wasm**.
 *
 *   TETRAVOX_TESTDATA=… node scripts/bench-wasm-cut.mjs [mesh.msh]
 *
 * The row's target is a WASM one. Phase 1 measured it *natively* and printed the result under a
 * heading carrying the WASM budget, which is two different numbers with one label — so this driver
 * exists to produce the number the row actually asks for, with a command anyone can re-run.
 *
 * It calls `mesh_cut` directly on the module `pnpm wasm` builds, on V8 — the same engine Chromium
 * runs the dataset worker on, and the same yardstick the Phase-1 verification used. The **worker
 * round trip** (this, plus posting the result arrays across a thread boundary) is measured in
 * `packages/wasm/e2e/realdata.spec.ts`, in a browser; the two numbers are different on purpose and
 * `docs/benchmarks/phase1.md` records both.
 *
 * Requires `pnpm wasm` first.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import init, * as tvx from '../packages/wasm/pkg/tvx_wasm.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const root = process.env.TETRAVOX_TESTDATA;
const mesh = process.argv[2] ?? (root ? `${root}/m2m_ernie/ernie.msh` : null);
if (mesh === null) {
  console.error('skipping: TETRAVOX_TESTDATA is unset and no mesh was given');
  process.exit(0);
}

await init({ module_or_path: readFileSync(`${REPO}packages/wasm/pkg/tvx_wasm_bg.wasm`) });

const t0 = performance.now();
const out = tvx.load_mesh(
  new Uint8Array(readFileSync(mesh)),
  'auto',
  undefined,
  undefined,
  () => {}
);
const loadMs = performance.now() - t0;
const { handle, bounds, nTets } = out.meta;
console.log(`${mesh}: ${nTets} tets, load_mesh ${loadMs.toFixed(0)} ms (wasm, V8)`);

const c = [0, 1, 2].map((k) => (bounds.min[k] + bounds.max[k]) / 2);
const k = 1 / Math.sqrt(3);
const planes = {
  axial: new Float32Array([0, 0, 1, -c[2]]),
  oblique: new Float32Array([k, k, k, -(c[0] * k + c[1] * k + c[2] * k)]),
};

for (const [name, plane] of Object.entries(planes)) {
  let best = Infinity;
  let tris = 0;
  // Best of 9: the first call pays for a cold arena, and one sample measures the machine's mood.
  for (let i = 0; i < 9; i += 1) {
    const t = performance.now();
    const r = tvx.mesh_cut(handle, plane, undefined, undefined);
    best = Math.min(best, performance.now() - t);
    tris = r.cuts[0].tag.length;
  }
  console.log(
    `  mesh_cut ${name} through the bbox centre: best of 9 = ${best.toFixed(2)} ms, ${tris} cap triangles`
  );
}
console.log(`  wasm_heap_bytes ${tvx.wasm_heap_bytes()}`);
