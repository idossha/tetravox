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
| `m2m_ernie/T1.nii.gz` | 13,143,463 | `[Metal]`, app | **404 – 524 ms** (typ. 415; 461 ms re-measured 2026-08-27) |
| `m2m_ernie/T1.nii.gz` | 13,143,463 | `[SwS]`, engine harness | 318 ms |
| `m2m_ernie/ernie.msh` | 184,207,351 | `[Metal]`, app | **1,221 – 1,353 ms** (typ. 1,240) |
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

**§9.1 row 1 budgets < 400 ms to first frame on machine A (M1 Pro).** ~415 ms on an M2 Max is *over*
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
| 1200 × 800 (1×) | 0.96 MP | 0.10–0.20 ms | 0.20–0.60 ms | **1.65 – 2.16 ms** |
| 2400 × 1600 (2×) | 3.84 MP | 0.10 ms | 0.20–0.50 ms | **2.48 – 3.92 ms** |

`[Metal]`, Electron, `aa` on. Ranges, not single figures: these are the spread over four runs of the
same command on an otherwise-idle machine. A GPU median quoted to three digits from one run would
imply a precision this measurement does not have — the timer query is real, but the machine is
shared with a compositor.

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
| Open → **moving progress bar** | **13 – 28 ms** | < 200 ms |
| Cancel click → card reads `cancelled` | **4 – 6 ms** | < 500 ms |

(Five runs. The margin is an order of magnitude on the first and two on the second, so the spread
does not come near either budget.)

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

**Every row below is printed by that command.** Three of them were not, in the first version of this
table: `examples/measure.rs` stopped after `locate_point`, so the `extract_boundary` and `plane_cut`
figures were attributed to a command that could not produce them. The example runs them now.

**Native numbers, native comparisons.** The first version of this table also put `< 250 ms WASM` and
`< 500 ms WASM` in a Budget column beside native measurements. Those budgets are in the WASM table
below; a native figure has never been evidence for one, and the substitution is exactly what hid
§9.1 row 10's miss.

| Step | `ernie.msh` | Note |
|---|---|---|
| `read_msh` | 77 ms | §6.2's budget is < 1.5 s **native** — this one is like for like |
| `orient_surface` (1,177,213 tris) | 100 ms | |
| `morton_reorder` (4,722,625 tets) | 93 ms | the budget (< 250 ms) is WASM; see below |
| `build_tet_blocks` (73,792 blocks) | 62 ms | the budget (< 500 ms) is WASM |
| `build_point_locator` | 188 ms | |
| `tag_surfaces` → 1,177,213 tris / 582,126 verts / 10 tags | 36 ms | |
| `locate_point` (bbox centre) | 2.1 ms | §8 budgets the *hover round trip* at ≤ 50 ms |
| `extract_boundary` (topo = None) | 624 ms | §9.1 row 19's 1.5 s bar is WASM, and is for `grey_Thalamus_TI.msh` |
| `plane_cut` axial through the bbox centre | **10.4 ms** indexed / 24.3 ms degenerate | 62,966 cap triangles |
| `plane_cut` oblique through the bbox centre | **13.7 ms** indexed / 27.2 ms degenerate | 76,217 cap triangles |

The block index is worth ~2.1× on these planes — not the ~10× §9.1 row 10's old evidence cell
implied — and its output is bit-identical either way (§6.3, asserted in
`crates/tvx-geom/tests/real_data.rs`).

## `plane_cut` in WASM — §9.1 row 10, in the environment the row is written for

```sh
node scripts/bench-wasm-cut.mjs                                   # the op, on V8
pnpm --filter @tetravox/wasm run e2e -- realdata -g "row 10"      # the worker round trip, Chromium
```

| Plane | The op (`mesh_cut`, wasm/V8) | Worker round trip (Chromium) | Native | §9.1 row 10 |
|---|---|---|---|---|
| mid-axial, 62,966 cap tris | **12.9 ms** | 16.9 ms | 10.4 ms | < 15 ms ✔ |
| oblique `[1,1,1]`, 76,217 cap tris | **16.6 ms** | 21.2 ms | 13.7 ms | < 30 ms ✔ |

The three columns measure three different things and none of them substitutes for another: the op is
the §6.3 function plus building the JS result arrays; the round trip adds a `postMessage` and the
transfer of ~5 MB of typed arrays, and is what §9.1 row 11's cut-plane drag will have to fit inside;
native is the same Rust with the system allocator instead of dlmalloc.

**Row 10's recorded evidence (2.7 / 3.1 ms `[M2Max]`) is a prototype's and this implementation does
not reproduce it** — 4.8× off. The budget is met; the evidence cell was not. Two changes closed most
of the gap between the first Phase-1 implementation and these numbers, both in `plane_cut`: the cut
polygon is a fixed-size stack buffer rather than a `Vec` per cut tet (~63,000 allocate/free pairs
per plane under dlmalloc), and the tag-boundary pass sorts 24-byte keys with an index into
`edge_segments` instead of 48-byte tuples carrying the endpoints. 16.1 → 12.9 ms on the op.

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
* **Anything, in CI.** `.github/workflows/ci.yml` asserts `TETRAVOX_TESTDATA` is *unset*, so every
  number on this page is reproducible only on a machine holding the reference dataset. See the
  paragraph under the Phase-1 gate table in `docs/ROADMAP.md`.
* **The packaged artefact.** These are `dev` numbers; `pnpm package` timings are Phase 3's gate.
* **Anything §9.1 lists as a `[TARGET]` row.** Phase 3 replaces those, on both machines, with
  sign-off. Nothing here should be quoted as a §9 result.
