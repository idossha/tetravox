# Phase 2 — E-MESH benchmarks

The sections below are **written by `packages/engine/test/e2e/mesh-real.spec.ts` on every run**,
one per Playwright project, so each is always the number that machine measured. Regenerate with:

```
export TETRAVOX_TESTDATA=/Users/idohaber/datasets/000/derivatives/SimNIBS/sub-ernie
pnpm --filter @tetravox/engine exec playwright test --project=chromium-swiftshader mesh-real
pnpm --filter @tetravox/engine exec playwright test --project=chromium-angle mesh-real
```

## Why a clip-plane drag has two rates

§7.4: *"latest-wins is the only drag mechanism."* That gives a drag two rates, and conflating them
hides the interesting one:

* the **frame rate** — the pane redraws every animation frame, with the last cap that landed. This
  is what the hand on the gizmo feels, and it is the 30 fps gate.
* the **cross-section rate** — how often a *new* cut lands, i.e. one over the `cut` round trip:
  `updateLayer` → `CutManager.requestCut` → the worker's `cut` op → the de-indexing pack →
  `bufferSubData` into the cap VBO set.

The frame rate is renderer-bound and the cut is not: the cut is CPU work in the dataset worker. The
SwiftShader leg rasterises ernie's 1,177,213 triangles at a few frames a second whatever is
clipped, so a frame-rate gate is only meaningful on the leg with a GPU — which is why the drag runs
on both projects and only the GPU leg gates on frames. On the software leg the cut latency is also
sampled once per frame, so it is quantised by that leg's ~280 ms frame interval and reads as an
upper bound rather than a measurement; the renderer-independent number is the table below.

## Latest-wins, and the starvation it used to cause

`ComputeClient` keeps **one request in flight and at most one queued per key**, and a new request
replaces the queued one. The in-flight one is not cancelled — §5 rule 6: *"an in-flight request has
no abort flag"* — so it runs to completion and its result arrives.

`CutManager` therefore accepts a result if it is newer than the one already **applied**, not if it
is the newest one **issued**. The difference is the whole drag: at 60 fps against a ~17 ms cut, every
result is superseded before it lands, and dropping on "newest issued" delivered **zero**
cross-sections in a two-second drag — the cap frozen where the drag began. The guarantee that
matters is unchanged: a snapshot is never replaced by an older one, and `generation` stays
monotonic. `compute/cut-manager.test.ts` pins both halves.

## Where the cut round trip goes

One-off measurement, 2026-08-27, M2 Max, one axial plane through the middle of each mesh, timed from
`updateLayer` to the snapshot landing, with nothing superseding it:

| Mesh | Tets | Cap triangles | ANGLE/Metal | SwiftShader |
|---|---|---|---|---|
| `testdata/mesh_v2_binary.msh` | 48 | 32 | 4.5 ms | 8.6 ms |
| `grey_Thalamus_TI.msh` | 1,340,029 | 30,058 | 9.6 ms | 66 ms |
| `ernie.msh` | 4,722,625 | 70,757 | 18.7 ms | 151 ms |

Two things to read off it. First, after the fixed cost the time tracks the **cap triangle** count
(2.35× more triangles, 2.8× more time) and not the tet count (3.5×) — so the Morton block index
built by `build_tet_blocks` is doing its job and the cost is per *cut* tet. Second, the two columns
differ by ~8× on identical wasm in identical workers: the golden authority runs Chromium's headless
shell, and its WebAssembly tier is what that gap measures, not this feature.

### One thing that could be cheaper, and cannot be fixed here

`plane_cut` always builds `edge_segments`, always fills the `poly_edges` table and always sorts
it to produce `boundary_segments` — for ernie's mid-axial cut that is ~200,000 entries sorted per
cut — and the result is then copied across the worker boundary. §7.4 is explicit that the 3D path
wants none of it: *"`Cut.edge_segments` is not used in the 3D passes — it exists for the 2D
overlay"*, and the cap's own edges come from `Cut.edge_mask` through the barycentric shader.
`requestCut` already carries `wantEdges` / `wantBoundary` and passes `false` for both on the
`3d-clip` key, but `OpArgs['cut']` — a frozen interface — has no field to forward them on, so the
worker computes and ships them regardless.

**Filed with the integrator (owner: W-WASM):** add `wantEdges` / `wantBoundary` to
`OpArgs['cut']` and thread them into `plane_cut`, so the 3D clip path stops paying for two outputs
it discards. E-MESH cannot make that change — §12.3 freezes `packages/protocol/src/index.ts` and
every §6 Rust signature to W-WASM. It is an optimisation, not a blocker: the gate below passes
without it.

Independently, §7.2's `interacting` quality level names `capDecimation` as the lever for exactly
this cost during a drag. That is E-SCENE's P2-02 and does not exist yet.

<!-- begin boundary chromium-swiftshader -->
### `extract_boundary` on a mesh with no triangles — `chromium-swiftshader`

`grey_Thalamus_TI.msh`: 0 triangles, 1,340,029 tets, 63,926,663 bytes. The mesh that makes
"a mesh ships its own surface" false.

| Quantity | Value |
|---|---|
| Parse + boundary + upload + first frame | 580 ms |
| `extract_boundary` + upload alone (de-indexed variant) | **224 ms** |
| Gate | 1500 ms |
<!-- end boundary chromium-swiftshader -->

<!-- begin chromium-angle -->
### Clip-plane drag — `chromium-angle`

Measured 2026-08-28 on M2 Max / macOS 15.7.
`m2m_ernie/ernie.msh`, 4,722,625 tets, one axial plane swept ±20 mm about the
bounding box's mid-`z` for 2.0 s, moved on every frame.

| Quantity | Value |
|---|---|
| Drag frame rate | **120.9 fps** (243 frames) |
| Frame interval, median · p95 | 8.3 ms · 10.3 ms |
| Budget | 33.3 ms (30 fps) |
| New cross-section on screen, median · p95 | 15 ms · 19 ms |
| New cross-sections per second | 73.1 Hz (147 in the drag) |
| Cap triangles at the last plane | 62,287 |

This is the shipping renderer, so the frame rate here is the one §7.4 gates on. The cut latency is sampled once per frame, so it cannot read below one frame interval.
<!-- end chromium-angle -->

<!-- begin chromium-swiftshader -->
### Clip-plane drag — `chromium-swiftshader`

Measured 2026-08-28 on M2 Max / macOS 15.7.
`m2m_ernie/ernie.msh`, 4,722,625 tets, one axial plane swept ±20 mm about the
bounding box's mid-`z` for 2.1 s, moved on every frame.

| Quantity | Value |
|---|---|
| Drag frame rate | 3.9 fps (8 frames) |
| Frame interval, median · p95 | 264.1 ms · 478.1 ms |
| Budget | 33.3 ms (30 fps) — not gated on this leg |
| New cross-section on screen, median · p95 | 264 ms · 478 ms |
| New cross-sections per second | 3.4 Hz (7 in the drag) |
| Cap triangles at the last plane | 52,235 |

SwiftShader. The frame rate here is the software rasteriser, not this feature, and the cut latency is sampled once per frame — so on this leg it is quantised by the frame interval and reads as an upper bound. The renderer-independent number is the table above.
<!-- end chromium-swiftshader -->
