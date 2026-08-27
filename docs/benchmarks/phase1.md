# Phase-1 benchmarks

**Machine A′ — Apple M2 Max, macOS 15.7.3 (arm64), 2026-08-27.**
rustc 1.93.0 · Node 25.4.0 · Playwright 1.62.1 (Chromium 151) · Electron 44.

This is **not** the §9 sign-off. §9.1's `[TARGET]` rows are replaced by measured numbers in **Phase 3**,
on both reference machines, in `docs/BENCHMARKS.md`. What follows is the Phase-1 gate's own evidence,
recorded so the Phase-3 pass has a baseline to compare against and so every number here can be traced
to the command that produced it.

Two renderers appear below and they are not interchangeable (§7.1, §11):

| | Renderer | Where |
|---|---|---|
| `[Metal]` | `ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max, Unspecified Version)` | the Electron app — what a user gets |
| `[SwS]` | `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device …))` | headless Chromium — the golden authority |

`[SwS]` has **no `EXT_texture_norm16`**, so `T1.nii.gz` is `R32F` there and `R16` in the app. Any
comparison across the two rows is comparing different texture formats as well as different renderers.

---

## Load to first frame

Wall clock from the open action to a settled, fully rendered frame — parse, stats, GPU-payload build,
transfer, texture/geometry upload and the first draw, all included.

| File | Bytes | Renderer | Load → first frame |
|---|---|---|---|
| `m2m_ernie/T1.nii.gz` | 13,143,463 | `[Metal]`, app | **418 ms** |
| `m2m_ernie/T1.nii.gz` | 13,143,463 | `[SwS]`, engine harness | 318 ms |
| `m2m_ernie/ernie.msh` | 184,207,351 | `[Metal]`, app | **1,236 ms** |
| `m2m_ernie/ernie.msh` | 184,207,351 | `[SwS]`, engine harness | 1,240 ms |

Commands:

```sh
export TETRAVOX_TESTDATA=/Users/idohaber/datasets/000/derivatives/SimNIBS/sub-ernie
pnpm --filter @tetravox/app exec playwright test phase1-gate --project=dev   # [Metal]
pnpm --filter @tetravox/engine run e2e -- phase1-gate                        # [SwS]
```

The app row is the larger of the two for `T1.nii.gz` because it includes the shell: the load card, the
store update, the React re-render and the layer row. That is the number a user experiences, so it is
the one in bold.

**§9.1 row 1 budgets < 400 ms to first frame on machine A (M1 Pro).** 418 ms on an M2 Max is *over*
that budget, and the row stays `[TARGET]`. The breakdown says where it goes — the parse is not the
problem:

| Stage | `T1.nii.gz` | Source |
|---|---|---|
| `read_nifti` | 101.1 ms | `cargo bench -p tvx-nifti`, criterion median, re-run 2026-08-27 |
| `stats(0)` | 46.1 ms | same |
| `gpu_payload` → R16 | 43.2 ms | same |
| the three together (`first_frame/real/T1`) | **191.5 ms** | same |
| `loadVolume` end to end in the worker, incl. fetch + transfer | 373 ms | `[SwS]`, wasm e2e |
| … then GL upload + first draw + shell | ~45 ms | the app row minus the worker |

The dominant term is the worker round trip, not the renderer. Phase 3's performance pass (§9, typed-array
pooling, index de-dup) is where this is addressed; nothing here is a rendering problem.

## Orbit frame time

`ernie.msh` tag surfaces (1,177,213 triangles, ten nested tissue shells), one full turn in 60 steps,
`3d-only` layout. Frame cost is the engine's own `frame` event: `cpuMs` is the pump's own work and
`gpuMs` comes from `EXT_disjoint_timer_query_webgl2` (§7.1).

| Buffer | Pixels | CPU median | CPU p95 | **GPU median** |
|---|---|---|---|---|
| 1200 × 800 (1×) | 0.96 MP | 0.20 ms | 0.60 ms | **1.65 ms** |
| 2400 × 1600 (2×) | 3.84 MP | 0.10 ms | 0.50 ms | **2.48 ms** |

`[Metal]`, Electron, `aa` on.

Two things worth recording:

* **4× the pixels costs 1.5× the time**, so this scene is vertex- and draw-bound rather than
  fill-bound at these sizes — which is what ten per-tag draw calls over 1.18 M triangles should look
  like.
* §7.2 budgets **≤ 8 ms at 60 Hz, ≤ 5 ms at 120 Hz**. 2.48 ms at 2× is inside the 120 Hz budget with
  room to spare, before any of Phase 3's transparency or progressive-refinement work lands.

**A wall-clock measurement here is worthless and the first version of this benchmark proved it.**
Timing `renderNow()` plus an `await requestAnimationFrame` reported 8.20 ms median at *both* 1× and 2× —
the ProMotion display's 8.33 ms vsync period, not the scene's cost. The numbers above come from the
engine Timer for that reason.

## Progress and cancel — Phase-1 gate item 1

`m2m_ernie/ernie_seeg.msh`, 492,090,201 B, through the app's real load path (`[Metal]`, Electron):

| | Measured | Budget |
|---|---|---|
| Open → load card on screen | 0.8 ms | — |
| Open → **moving progress bar** | **13–28 ms** | < 200 ms |
| Cancel click → card reads `cancelled` | **4–6 ms** | < 500 ms |

Cancel is `worker.terminate()` (§5 rule 6), which is why it is a handful of milliseconds and not a
function of how much of the 492 MB had been read. Nothing reaches the scene: `datasets` and `layers`
are both 0 afterwards.

## Memory — §9.2 load path

`wasm_heap_bytes()` per dataset worker, measured in the browser because linear memory only exists
there. **With `tvx-geom` built in** (`default = ["geom"]`), so Morton reorder, the tet block index and
the point locator are all included.

| File | Bytes | `wasm_heap_bytes` | × file | §9.2 bar |
|---|---|---|---|---|
| `m2m_ernie/ernie.msh` | 184,207,351 | 358,350,848 = 341.8 MB | 1.95 × | ≤ 380 MB ✔ |
| `m2m_ernie/ernie_seeg.msh` | 492,090,201 | 956,694,528 = **912.4 MB** | 1.94 × | ≤ **1.0 GB** ✔ |
| `m2m_ernie/T1.nii.gz` | 13,143,463 | 105.3 MB | — | — |

**Turning `tvx-geom` on did not move the high-water mark at all** — 912.4 MB before and after. The
geometry work happens after the parse has freed its transients, and dlmalloc reuses that space: the
peak is still set by the parse. `morton_reorder`'s own 208 MB gather buffer on this file fits inside
it with room over.

```sh
pnpm --filter @tetravox/wasm run e2e -- realdata
```

## `tvx-geom` load-time work (native, release)

`cargo run --release -p tvx-geom --example measure -- $TETRAVOX_TESTDATA/m2m_ernie/ernie.msh`

| Step | `ernie.msh` | Budget (§6.3) |
|---|---|---|
| `read_msh` | 80 ms | < 1.5 s native |
| `orient_surface` (1,177,213 tris) | 113 ms | — |
| `morton_reorder` (4,722,625 tets) | **109 ms** | < 250 ms **WASM** |
| `build_tet_blocks` (73,792 blocks) | 63 ms | < 500 ms WASM |
| `build_point_locator` | 179 ms | — |
| `tag_surfaces` → 1,177,213 tris / 582,126 verts / 10 tags | 37 ms | — |
| `locate_point` (bbox centre) | 2.1 ms | ≤ 50 ms (§8 hover) |
| `extract_boundary` (topo = None) | 678 ms | — |
| `plane_cut`, axial through the bbox centre | 15.1 ms **with** the block index | — |
| `plane_cut`, same plane, degenerate index | 29.6 ms | — |

The block index is worth ~2× on this plane, and its output is bit-identical either way (§6.3, asserted
in `crates/tvx-geom/tests/real_data.rs`).

`morton_reorder` was **478 ms** in its first form — sorting an index array and looking up
`codes[i]` on each of three radix passes. Moving the code into the sort key so every pass reads
sequentially took it to 109 ms; `docs/DECISIONS.md` records why.

## Pick

`ernie.msh`, 3D view, `[SwS]`: **241 ms** for the first pick round trip after the de-indexed pick
geometry has been built, and the build itself is a second `surface` op in the worker (§7.4). §7.2.3's
0.031 ms figure is the `readPixels` alone; the number here is the whole pass — clearing, re-drawing
1.18 M triangles into the R32UI target, and two 9×9 readbacks — under a software rasteriser. It is not
comparable to `[Metal]` and Phase 2, which owns the pick UX, should re-measure it there.

## What is not measured here

* **Machine B.** §9 names two reference machines; only this one exists for Phase 1.
* **ubuntu-24.04.** The golden authority has still never run (a Phase-0 carry-over — see
  `docs/ROADMAP.md`). Every `[SwS]` number above is SwiftShader **on macOS arm64**.
* **The packaged artefact.** These are `dev` numbers; `pnpm package` timings are Phase 3's gate.
* **Anything §9.1 lists as a `[TARGET]` row.** Phase 3 replaces those, on both machines, with
  sign-off. Nothing here should be quoted as a §9 result.
