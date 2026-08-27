# Roadmap (v2)

Phases are sequential; work inside a phase is parallel (one agent per bullet, disjoint directories, git worktrees).
A phase is done when **every** gate item below passes, on real data where the item says so
(`TETRAVOX_TESTDATA`). Section references are to `docs/ARCHITECTURE.md` v2.

---

## Phase 0 — Walking skeleton and the frozen contract

**Gate (all of it, not a subset):**

1. `pnpm test && pnpm e2e` green on macOS **and** ubuntu-24.04.
2. The **host platform's packaged artefact** — not the dev server — shows a WebGL2 triangle whose colour came
   from a WASM call, with the renderer loaded via `win.loadURL('tetravox://app/index.html')`: a `.dmg` when
   Phase 0 is closed on macOS, an `.AppImage` when it is closed on Linux. `pnpm package` builds **this
   platform's artefacts only** (§12.1), and Linux artefacts are never built on macOS, so a Phase-0 gate cannot
   demand both. The cross-platform artefact matrix is a **Phase-3** gate item.
3. `tetravox://` is registered privileged (`standard, secure, supportFetchAPI, stream, corsEnabled`) and
   `protocol.handle` serves the bundle, `*_bg.wasm` as `application/wasm`, and
   `tetravox://file/<percent-encoded path>` as a streaming response. A module Worker under that origin
   `fetch`es a file and hands the bytes to WASM. (§5, directive A2 — this is a Phase-0 gate item.)
4. A clean clone with an **empty pnpm store** reaches `pnpm e2e` green (§12.2).
5. `cargo check --workspace` green with every §6 signature present as `unimplemented!()`.
6. The five frozen interfaces of §12.3 exist and compile, `MockEngine` included.
7. Both lockfiles committed with the full §12.3 dependency list; `pnpm exec electron --version` warm-up step in CI.
8. E2E: drop a `.nii.gz` **and** a `.msh` onto the window — both load, exercising `webUtils.getPathForFile` and
   the `File`-bytes fallback.
9. `expectPixel` helper working, plus the e2e that asserts and logs `Capabilities`.

**Gate passed — 2026-08-27**, on macOS 15.7 arm64 (M2 Max), at `ba55310` (merge of `p0/fixtures`,
`p0/app`, `p0/harness` plus the integration fix). Every command below was run from a clean tree and is
reproducible; the numbers are what it printed.

| # | Gate item | Command that proved it | Result |
|---|---|---|---|
| 1 | `pnpm test && pnpm e2e` green | `pnpm test` · `pnpm e2e` | ✔ **macOS**: cargo 27 passed / 0 failed / 50 `#[ignore]`d for Phase 1; vitest 16 passed over 3 projects; Playwright 6 (engine, SwiftShader) + 20 (app, `dev` **and** `packaged`). ☐ **ubuntu-24.04 is NOT yet proven** — `.github/workflows/ci.yml` has never executed. See "Outstanding" below. |
| 2 | The **packaged** artefact draws a WASM-coloured triangle from `tetravox://app/index.html` | `pnpm package` then `pnpm --filter @tetravox/app run e2e:packaged` | ✔ `packages/app/release/Tetravox-0.1.0-arm64.dmg` (127,560,283 B, unsigned) + `release/mac-arm64/Tetravox.app`; 10/10 green against the `.app`, incl. `location.protocol === 'tetravox:'` and `centerPixel === [229,214,52,255]` = `tvx_ping(0x54565830) >> {16,8,0}`. **Also a committed CI leg** — the macOS `test` job runs this exact command after its `.dmg` step, with `TETRAVOX_REQUIRE_PACKAGED=1` so a self-skip is a failure; `pnpm e2e` alone always skips the `packaged` project and never covered this gate. |
| 3 | Privileged `tetravox://`, `application/wasm`, streaming `tetravox://file/`, a module Worker handing bytes to WASM | `pnpm e2e` → `e2e/phase0.spec.ts` | ✔ `content-type: application/wasm` **and** `instantiateStreaming` observed to have run (the glue falls back silently otherwise); worker origin `tetravox://app`; 256 B fetched over `tetravox://file/…` digesting to `0xFEC415B3`; `/etc/hosts` → 403 |
| 4 | Clean clone, **empty pnpm store**, reaches `pnpm e2e` | `git clone … p0-clone && pnpm install --store-dir …/p0-store && pnpm wasm && pnpm build && pnpm test && pnpm e2e && pnpm package` | ✔ install 6.9 s; then `cargo fmt/clippy/check/test`, `pnpm typecheck/lint/test` and both Playwright suites green, and `pnpm package` produced a `.dmg` whose `e2e:packaged` is 10/10 |
| 5 | `cargo check --workspace` green with every §6 signature present as `unimplemented!()` | `cargo check --workspace` | ✔ Finished; also `cargo clippy --workspace --all-targets -- -D warnings` and `cargo fmt --all -- --check` clean |
| 6 | The five frozen §12.3 interfaces exist and compile, `MockEngine` included | `pnpm typecheck` | ✔ 4 packages Done. `packages/{protocol/src/index.ts, engine/src/scene/types.ts, engine/src/api.ts, wasm/src/index.ts}` + the committed `packages/wasm/pkg/tvx_wasm.d.ts`; `MockEngine` is a `class … implements Engine`, so the facade is provably implementable |
| 7 | Both lockfiles committed with the §12.3 dependency list; `pnpm exec electron --version` warm-up in CI | `git ls-files Cargo.lock pnpm-lock.yaml` · `.github/workflows/ci.yml` step "Warm up the electron binary" | ✔ both tracked; the warm-up is its own step, so a failed ~100 MB download is red on its own line rather than a mysterious e2e failure |
| 8 | Drop a `.nii.gz` **and** a `.msh`, exercising `webUtils.getPathForFile` **and** the `File`-bytes fallback | `pnpm e2e` → `e2e/phase0.spec.ts` "drag and drop (§8)" | ✔ `testdata/vol_u8.nii.gz` (183 B) and `testdata/mesh_v2_ascii.msh` (6,577 B), each down **both** branches, each digesting to the same value either way — the path branch via an allow-listed `tetravox://file/…` fetched in the worker, the fallback via the `File` structured-cloned to the worker. Green in `dev` and `packaged`. |
| 9 | `expectPixel` working, plus an e2e that asserts and logs `Capabilities` | `pnpm --filter @tetravox/engine run e2e` | ✔ `packages/engine/test/helpers/pixels.ts::expectPixel`; `caps.spec.ts` asserts a complete `Capabilities` and attaches it. Recorded renderers: `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device …))` for the goldens, `ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max)` for the app |

**Outstanding at the gate** (tracked, not blocking Phase 1's start):

* **ubuntu-24.04 has never run.** `.github/workflows/ci.yml` is committed and complete, but no CI run
  exists, so gate 1's Linux half and the golden authority's own output are unverified. The committed
  golden `packages/engine/test/golden/swiftshader/triangle.png` was captured on macOS arm64; if the
  first ubuntu run disagrees, regenerate it **there** — ubuntu-24.04 is the authority (§11).
* `pnpm package` is macOS-only here, as §12.1 requires. `.AppImage` / `.deb` are Phase 3's gate.
* 50 `#[ignore = "phase-1: …"]` Rust tests are written against `testdata/manifest.json` and waiting for
  the Phase-1 parsers. Deleting the ignore line, not the assertion, is the intended move.
* Benches exist with real setup and no-op bodies (`// PHASE 1:`), because calling an `unimplemented!()`
  under `cargo test --benches` would be red today.

**Work:**
- cargo + pnpm workspaces, all crate/package stubs, `rust-toolchain.toml` (stable 1.93.0),
  `scripts/build-wasm.sh` (pinned wasm-pack, `--target web`), electron-vite app, electron-builder config
  (exact patch pin, unsigned macOS).
- `packages/protocol` (§6.5), `packages/engine/src/scene/types.ts` (§4.1–4.6),
  `packages/engine/src/api.ts` + `MockEngine` (§4.7), `packages/wasm/src/index.ts` + committed
  `pkg/tvx_wasm.d.ts` stub.
- vitest; Playwright Chromium with the §11 launch args and `expectPixel`; Playwright-Electron E2E; the §12.1 CI
  **test** legs. The workflow file carries the `package` legs from day one, but they are **Phase 3's** to make
  green — Phase 0 only proves the local `pnpm package` on its own platform.
- `scripts/gen-fixtures.py` → `testdata/` + `testdata/manifest.json`: tiny NIfTI in every accepted dtype incl.
  `.gz`, **one with `sform_code = 0, qform_code = 1, pixdim[0] = −1`** (the only case that catches a missing
  qfac) and **one with `scl_slope = NaN`**; tiny msh v2 ascii/binary + v4.1 with node and element data, one with
  non-contiguous element ids and a gap; tiny GIfTI in all three supported encodings; FreeSurfer surface + curv +
  annot; stl/ply/obj incl. an n-gon that exercises `tri_edge_mask`; a mesh with ≥ 2²¹ nodes for the face-key test.

---

## Phase 1 — Core I/O + engine foundation

**Gate:**
1. Real ernie data loads through the worker with progress and cancel: opening `m2m_ernie/ernie_seeg.msh`
   (492 MB) shows a moving progress bar within 200 ms and cancels within 500 ms of the click. Cancel is
   `worker.terminate()` (§5 rule 6) — there is no abort flag to poll, because the app is not cross-origin
   isolated and `SharedArrayBuffer` does not exist (§1).
2. `ernie.msh` **tag surfaces** orbiting (no `build_topology` on this path — §6.3).
3. Screenshots of `T1.nii.gz` slices in the three canonical views + 3D, with orientation letters, corner info and
   the RAD/NEU badge present in every golden.
4. The **Phase-1 oblique golden** (§11): `mode:'oblique'`, `normal = normalize([1,1,1])`, `T1.nii.gz` alone.
   The mesh-contour variant is a Phase-2 gate item — `contoursIn2D` and the instanced contour renderer ship
   there.
5. The pick golden and the **Phase-1 overlay-compositing golden** (§11): two volume layers on an oblique **2D**
   view, exact-100 % footprint. The `showIn3D` variant of that test is a Phase-2 gate item.
6. The two format branches of the §6.1 ladder both covered by analytic pixel tests via `EngineOptions.forceCaps`
   (§7.1, §11) — the goldens can only ever exercise the R32F one.
7. `wasm_heap_bytes()` stays under the §9.2 **load-path** bar for `ernie_seeg.msh` (≤ 1.0 GB). The
   `buildTopology` bar is Phase 2's, since nothing in Phase 1 clips or isolates.

**Gate passed — 2026-08-27**, on macOS 15.7.3 arm64 (Apple M2 Max), against
`TETRAVOX_TESTDATA=/Users/idohaber/datasets/000/derivatives/SimNIBS/sub-ernie`. Every command below
was run from a clean tree; the numbers are what it printed. Screenshots of each rendered item are
committed under `docs/screenshots/phase1/`, and the measurements are in `docs/benchmarks/phase1.md`.

| # | Gate item | Command that proved it | Result |
|---|---|---|---|
| 1 | `ernie_seeg.msh` (492 MB): moving progress bar < 200 ms, cancel < 500 ms | `pnpm --filter @tetravox/app exec playwright test phase1-gate --project=dev` → `e2e/phase1-gate.spec.ts` | ✔ card on screen **0.8 ms**, first progress **13–28 ms** (phase `read`), cancel → `cancelled` **4–6 ms**. Timed **inside the page** around the exact call the Open dialog makes, so no Playwright IPC is charged to the budget. Cancel is `worker.terminate()`; afterwards `datasets` and `layers` are both 0. Real engine, real worker, ANGLE/Metal. |
| 2 | `ernie.msh` tag surfaces orbiting, **no `build_topology`** on that path | `pnpm --filter @tetravox/engine run e2e -- phase1-gate` → `gate 2` | ✔ 847,165 nodes / 1,177,213 tris / 4,722,625 tets; the ten tissue tags, tag 4 absent; `orient_surface` flips 41 components. **The worker op log is exactly `['loadMesh', 'surface']`** — no `buildTopology`, no `boundary` — captured by wrapping `Worker.prototype.postMessage`. 24-step orbit, > 25 % of the pane covered. Golden `gate2-ernie-tag-surfaces`. |
| 3 | `T1.nii.gz` in the three canonical views + 3D, with letters, corner info and the badge | same run → `gate 3` (two tests) | ✔ 256×256×208 `f32`, max exactly 65535, `R32F` on the golden authority. Goldens `gate3-t1-2x2-chrome` (2×2: axial, coronal, sagittal, 3D — every pane carries edge letters, corner info and the `NEU` badge) and `gate3-t1-axial-radiological` (the same slice with `RAD`, `R` and `L` swapped — §3's "radiological negates `right` only"). Letters are derived from the view basis, never hardcoded per pane (§8). |
| 4 | The Phase-1 oblique golden | same run → `gate 4` | ✔ `mode: 'oblique'`, `normal = normalize([1,1,1])`, `T1.nii.gz` alone. Golden `gate4-t1-oblique`; the hexagonal footprint is the plane ∩ the volume's box, which is the §7.3 texcoord discard doing its job. |
| 5 | The pick golden **and** the Phase-1 overlay-compositing golden | same run → `gate 5` (two tests) | ✔ **Compositing**: `T1.nii.gz` + `segmentation/labeling.nii.gz` (a **float32** label volume, 57 ids → `R8UI`) on an oblique 2D view. Captured twice — base alone, then composited — and asserted pixel by pixel: every changed pixel is *exactly* one of the atlas's LUT colours (no blend ⇒ a true 100 % footprint) and every unchanged pixel is byte-identical to the base. Golden `gate5-overlay-composite-oblique`. **Pick**: a 3D pick on `ernie.msh` returns `elementKind: 'tri'` with a Gmsh element number inside the tri block, a pane corner returns `null` (0 = miss), and still no `buildTopology`. Golden `gate5-ernie-pick`. |
| 6 | Both §6.1 ladder branches, via `forceCaps`, as analytic pixel tests | same run → `gate 6` (two tests) | ✔ `?norm16=0` ⇒ **R32F**; the unforced run ⇒ **R16** where the renderer has `EXT_texture_norm16`, and **skips with a reason** on the golden authority, which does not (§7.1 `[SwS]`) — rather than silently asserting the other branch twice. Each branch compares the rendered grey against the value `Engine.probe` reads from the **CPU** array at the same world point, through the §7.6 bake: two paths that share only the parsed samples. |
| 7 | `wasm_heap_bytes()` ≤ 1.0 GB for `ernie_seeg.msh` | `pnpm --filter @tetravox/wasm run e2e -- realdata` | ✔ **956,694,528 B = 912.4 MB** (1.94 × file), **with `tvx-geom` built in**. Unchanged from the pre-`geom` measurement: the Morton reorder, block index and point locator all run after the parse has freed its transients, so the high-water mark is still the parse's. `ernie.msh` 341.8 MB against its ≤ 380 MB bar. |

**Whole chain, same tree:** `pnpm wasm && pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm e2e`
green, plus `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings` and
`cargo test --workspace` (177 passed / 0 failed / 1 ignored) with `TETRAVOX_TESTDATA` set **and** unset.

**Outstanding at the gate** (tracked, not blocking Phase 2's start):

* **`p1/geom` and `p1/engine` were never created.** `crates/tvx-geom` and `packages/engine` reached
  the integrator as Phase-0 `unimplemented!()` / `throw new Error('phase 1')` stubs, and both were
  implemented during integration rather than by their own agent. They therefore had one pass of
  review, not two, and `docs/DECISIONS.md` carries the judgement calls.
* **ubuntu-24.04 has still never run** — the Phase-0 carry-over. Every golden here was captured on
  SwiftShader **on macOS arm64**, and `ubuntu-24.04` is the golden authority (§11). If the first CI
  run disagrees, regenerate the goldens **there**.
* **§9.1 row 1 is missed on this machine**: 418 ms to first frame for `T1.nii.gz` against a < 400 ms
  budget, dominated by the worker round trip rather than by rendering. The row stays `[TARGET]`;
  Phase 3's performance pass owns it. `docs/benchmarks/phase1.md` has the breakdown.
* **Two Phase-0 fixture assertions were corrected, not implemented** — `extract_boundary`'s face
  count and `orient_surface`'s non-manifold-edge count. Both are argued from §6.3 and confirmed on
  real data; see `docs/DECISIONS.md`.
* `showIn3D` volume planes are Phase 2's (§7.3's Phase-1 scope says so explicitly), so the 3D pane of
  the gate-3 golden carries chrome but no volume.

**Work (one agent per bullet):**
- `tvx-nifti` (§6.1) — reader, exact stats, `gpu_payload` ladder, `label_index`. Synthetic + real-data tests
  (qfac, NaN slope, float32 label volume) and criterion benches.
- `tvx-mesh-io` (§6.2) — Gmsh v2 ascii/binary + v4.1, `read_msh_opt`, GIfTI, FreeSurfer, STL/PLY/OBJ.
- `tvx-geom` (§6.3) — **the whole crate, once**: `tag_surfaces`, `extract_boundary`, `orient_surface`,
  `vertex_normals`, `face_normals`, `morton_reorder`, `build_tet_blocks`, `build_point_locator`, `plane_cut`,
  `isolate`, `locate_point`, `surface_contours`, `label_centroids`, **`elm_to_node`, `node_to_elm`,
  `marching_cubes`, `marching_tets`**. `build_topology` lands here but is **off the first-frame path**.
  The last four have frozen signatures, wasm exports and protocol ops (`elmToNode`, `marchingCubes`,
  `marchingTets`) from Phase 0, and AGENTS rule 3 gives this crate one owner — so they are implemented here,
  now, not by a Phase-2 feature agent reaching into someone else's crate. Phase 2 consumes them from the engine
  and the UI.
- `tvx-wasm` + `packages/wasm` worker/client (§6.4, §6.5) — latest-wins keyed on `key`, progress, cancel,
  transferables, `CutOut` pooling, `heapBytes` on every `Res`.
- `packages/engine` foundation (§7.0–7.2, §7.5): GL kit + `probeCapabilities` + `forceCaps`, the rAF frame pump
  with `interacting` / `whenSettled()`, cameras/controls, scene/layer store with `activeLayerId`, `SliceView`
  model incl. oblique, view layouts, cursor/crosshair, pick pass, screenshot, colormaps + LUT parsers (§7.6).
- `packages/engine` **minimum shaders** — same owner as the bullet above, because gates 2–5 cannot pass without
  them and no other Phase-1 agent may write into `packages/engine/src`:
  * **§7.3 minimum slice shader**: one scalar layer per plane, `Scale {kind:'linear'}`, the shared plane
    geometry and `invariant gl_Position`, 2D depth-off blending, per-layer AABB discard. **No** labels, **no**
    threshold, **no** heat scale, **no** `showIn3D` planes.
  * **§7.4 minimum mesh shader**: indexed tag surfaces with the tag colour as a uniform, headlight Blinn-Phong,
    `faceMode`. **No** clip planes, **no** caps, **no** edges, **no** field colouring, **no** glyphs.
  Phase 2's `§7.3 complete` / `§7.4 complete` bullets extend these same files, owned by the same agent.
- `packages/app` shell: window + privileged scheme wiring, open dialog / drag-drop / CLI args, layer list with
  load cards, **info panel with `Cursor` and `Mouse` blocks**, coordinate bar (RAS/voxel), orientation letters,
  corner info, RAD/NEU badge, status bar.

---

## Phase 2 — Feature layers

**Gate:** every feature below has a golden **and** an analytic pixel test on ernie; UX walk-through recorded as a
GIF; `grey_Thalamus_TI.msh` (0 tris) renders via `extract_boundary` in < 1.5 s; plus the two §11 goldens Phase 1
deferred because they need Phase-2 rendering — **oblique slice + mesh contours** and **overlay compositing in
3D** (`showIn3D`).

- Volume slice layer **complete** (§7.3) — extending Phase 1's minimum slice shader, same owner: `Scale` incl.
  `heat` with min/mid/max and the negative branch, threshold with `softEdge`, label fill/outline/both via the
  dense index remap, `visibleLabels` / `labelOpacity`, interpolation, `showIn3D` planes, 4D index spinner over
  the `volumeFrame` op (§6.5.2).
- Mesh layer **complete** (§7.4) — extending Phase 1's minimum mesh shader, same owner: `tagStyle` (per-tag
  visible/opacity/colour) driving a tissue table, node/elm field colouring, `colorMode:'label'` for `.annot` /
  `.label.gii`, flat/smooth, masked-barycentric edges (surface and caps), 6 clip planes with exact caps +
  gizmo, element isolation (tags / field / sphere / box / label volume), 2D contours + `fillIn2D`, vector
  glyphs. Engine and UI work only — the `tvx-geom` functions behind these all landed in Phase 1.
- Isosurface layer (the engine/UI half of marching cubes / tets — the `tvx-geom` half is Phase 1); points layer
  (electrodes, ROI spheres from JSON/CSV, and SimNIBS `eeg_positions/*.csv`).
- Colour bars (one per visible scalar layer, ticks, units, threshold notch) — **required in screenshots**.
- Histogram widget with draggable window/threshold handles and presets.
- Region panel: search, solo, jump-to-centroid, wired into `isolate.labelVolume`.
- `.msh.opt` seeding with the "defaults from X.msh.opt" chip and Reset.
- Coordinate bar MNI column via `toTemplate`.
- Probing: cursor and hover values for every layer, element info, header panel.
- Scene save/load (`ViewSpec` with `version`, relative paths, fingerprints, relocate dialog), screenshot spec
  (`{target, width, height, scale, dpi, background, include, autoTrim}` with pHYs DPI), keyboard map,
  radiological toggle.
- Oblique **affordances**: gizmo, rotate handles, plane-from-3-points (the model and shader path already shipped
  in Phase 1).

---

## Phase 3 — High-end + packaging

**Gate:** signed-off benchmarks in `docs/BENCHMARKS.md` on both reference machines (§9) — every `[TARGET]` row
of §9.1 replaced by a measured number; the §12.1 `package` CI legs green; `.dmg` (arm64 + x64), `.AppImage` and
`.deb` each open `ernie.msh` and pass the artefact smoke test.

- Transparency upgrade: **dual depth peeling preferred over WBOIT** — measured depth complexity is 4–6 median /
  8–10 p90, so 6 peels covers p90 exactly, WebGL2 has core occlusion queries (`ANY_SAMPLES_PASSED`) for adaptive
  early-out, and 6 × 413 k tris (translucent GM + scalp) ≈ 2.5 M tris/frame is inside the 8 ms budget on
  M-series. `Framebuffer` needs `RGBA16F` + `EXT_color_buffer_half_float` + `EXT_float_blend`. If WBOIT is kept
  as the > 8-layer fallback, its depth weight must be re-parameterised against scene bounds (head ~250 mm,
  camera ~400 mm) rather than copied from the paper, and layer alpha clamped to [0.2, 0.9].
- Progressive refinement: 8–16 jittered frames accumulated into RGBA16F while the camera is still (§7.0.7),
  shared by the screenshot path.
- **Label minification AA.** Nearest-sampled label volumes drop thin structure when a screen pixel covers more
  than one voxel — measured on `labeling.nii.gz`, 3 of 28 labels present in the view are never sampled at
  1 mm/px and 6 of 27 at 10 mm/px. This affects `fill` and `outline` identically (the outline faithfully outlines
  the wrong fill), so it is a **sampler** item, not an outline-formula item. Integer 3D textures cannot be
  mipmapped or linearly filtered (`generateMipmap` on an integer internal format raises `INVALID_OPERATION`), so
  the options are (a) a 2×2 rotated-grid supersample of the centre label sample when `pxInVoxels > 1`, or (b) a
  worker-precomputed R8 boundary/coverage volume that can be filtered. **Prefer (a) first and measure**; the
  slice-composite budget has room (§9 row 14).
- Volume raycasting (MIP + composite with a transfer function) for 3D voxel rendering.
- Orientation cube, scale bar, measurement tool, `mosaic` layout (`{plane, startMm, stepMm, rows, cols}`).
- CLI headless render: `tetravox --scene s.tetravox.json --screenshot out.png --width 2400 --background white`.
- Performance pass against §9: typed-array pooling, oct-encoded normals, instanced points, index de-dup.
  **No `rayon`, no wasm threads** — parallelism is worker-per-dataset (§1).
- electron-builder artefacts on the §12.1 matrix, file associations, artefact smoke tests,
  `USER_GUIDE.md` with screenshots and the unsigned-macOS `xattr -dr com.apple.quarantine` walkthrough.
