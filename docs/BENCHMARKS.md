# Benchmarks

The numbers §9 of `docs/ARCHITECTURE.md` is measured against. Two renderer classes appear throughout:

| | Renderer | Where |
|---|---|---|
| `[Metal]` | `ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max)` | the Electron app — what a user gets |
| `[SwS]` | `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device …))` | headless Chromium — the golden authority |

Everything below was measured on an M2 Max with
`TETRAVOX_TESTDATA=…/derivatives/SimNIBS/sub-ernie`. Reproduce with `cargo bench -p <crate>`,
`node scripts/bench-wasm-cut.mjs`, `cargo run -p tvx-geom --example measure`, and the real-data
Playwright specs (`mesh-real`, `derived-r4`, `phase1-gate`), which also write their own current
figures into `docs/benchmarks/` on every run.

## Load to first frame

| File | Bytes | Renderer | Load → first frame |
|---|---|---|---|
| `m2m_ernie/T1.nii.gz` | 13,143,463 | `[Metal]`, app | **404 – 524 ms** (typ. 415) |
| `m2m_ernie/T1.nii.gz` | 13,143,463 | `[SwS]`, engine harness | 318 ms |
| `m2m_ernie/ernie.msh` | 184,207,351 | `[Metal]`, app | **1,221 – 1,353 ms** (typ. 1,240) |
| `m2m_ernie/ernie.msh` | 184,207,351 | `[SwS]`, engine harness | 1,240 ms |

Where `T1.nii.gz`'s 400 ms goes (criterion medians, native):

| Stage | ms |
|---|---|
| `read_nifti` | 101.1 |
| `stats(0)` | 46.1 |
| `gpu_payload` → R16 | 43.2 |
| the three together | **191.5** |
| `loadVolume` end to end in the worker, incl. fetch + transfer | 373 (`[SwS]`) |
| … then GL upload + first draw + shell | ~45 |

## Mesh pipeline, native, `ernie.msh`

| Step | ms | Note |
|---|---|---|
| `read_msh` | 77 | §6.2's bar is < 1.5 s native |
| `orient_surface` (1,177,213 tris) | 100 | |
| `morton_reorder` (4,722,625 tets) | 93 | §9.1 row 8's 250 ms bar is WASM |
| `build_tet_blocks` (73,792 blocks) | 62 | §9.1 row 9's 500 ms bar is WASM |
| `build_point_locator` | 188 | |
| `tag_surfaces` → 1,177,213 tris / 582,126 verts / 10 tags | 36 | |
| `locate_point` (bbox centre) | 2.1 | §8 budgets the hover round trip at ≤ 50 ms |
| `extract_boundary` (`topo = None`) | 624 | |

## `plane_cut` — §9.1 row 10

| Plane | The op (`mesh_cut`, wasm) | Worker round trip (Chromium) | Native | Bar |
|---|---|---|---|---|
| mid-axial, 62,966 cap tris | **12.9 ms** | 16.9 ms | 10.4 ms | < 15 ms ✔ |
| oblique `[1,1,1]`, 76,217 cap tris | **16.6 ms** | 21.2 ms | 13.7 ms | < 30 ms ✔ |

Without the Morton block index the same planes are 24.3 / 27.2 ms native, so the index is worth
~2.1×. The cost tracks the **cap triangle** count, not the tet count:

| Mesh | Tets | Cap tris | `[Metal]` | `[SwS]` |
|---|---|---|---|---|
| `testdata/mesh_v2_binary.msh` | 48 | 32 | 4.5 ms | 8.6 ms |
| `grey_Thalamus_TI.msh` | 1,340,029 | 30,058 | 9.6 ms | 66 ms |
| `ernie.msh` | 4,722,625 | 70,757 | 18.7 ms | 151 ms |

The ~8× column gap is the two Chromium builds' WebAssembly tiers on identical wasm, not this feature.

## Slice sweep with a mesh cross-section — R4's bar

`ernie.msh` alone, `fillIn2D` + `contoursIn2D` on, 20 × 1 mm, 768×768, DPR 1, `[Metal]`:

| Sweep | Per step (median) | Worst step | End-to-end | Bar |
|---|---|---|---|---|
| `1x1` axial | 23.6 ms | 26.3 ms | **42.1 fps** | ≥ 30 |
| `2x2` (3 panes + 3D) | 24.4 ms | 26.6 ms | **41.9 fps** | ≥ 30 |

The `2x2` sweep moves only the axial plane; the other two panes re-request an identical plane and
the cut source drops the repeat, which is what keeps three panes from costing three cuts.

## Render

| Buffer | Pixels | CPU median | CPU p95 | GPU median |
|---|---|---|---|---|
| 1200 × 800 (1×) | 0.96 MP | 0.10–0.20 ms | 0.20–0.60 ms | **1.65 – 2.16 ms** |
| 2400 × 1600 (2×) | 3.84 MP | 0.10 ms | 0.20–0.50 ms | **2.48 – 3.92 ms** |

Orbiting ernie's tag surfaces: plain 1.18 M-tri pass 2.32 ms, with the wireframe 2.24 ms.
Six clip planes: `discard` 2.89 ms vs `gl_ClipDistance` 2.07 ms.

## Responsiveness — §9.1 row 6

| | Measured | Budget |
|---|---|---|
| Open → load card on screen | 0.8 ms | — |
| Open → **moving progress bar** | 13 – 28 ms | < 200 ms |
| Cancel click → card reads `cancelled` | 4 – 6 ms | < 500 ms |

## Memory — §9.2

`wasm_heap_bytes()` after `loadMesh` (resident, not live):

| File | Bytes | Heap | × file | Bar |
|---|---|---|---|---|
| `m2m_ernie/ernie.msh` | 184,207,351 | 341.8 MB | 1.95 × | ≤ 380 MB ✔ |
| `m2m_ernie/ernie_seeg.msh` | 492,090,201 | **912.4 MB** | 1.94 × | ≤ 1.0 GB ✔ |
| `m2m_ernie/T1.nii.gz` | 13,143,463 | 105.3 MB | — | — |

After `buildTopology` the same two reach **846.1 MB** and **1,893.1 MB** resident — 21 % and 47 %
of wasm32's 4,032 MiB usable ceiling. Linear memory grows and never shrinks, so the observable
peak is the load path's resident total *plus* the topology arena, not the larger of the two.
