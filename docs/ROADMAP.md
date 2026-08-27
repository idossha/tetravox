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
- `scripts/gen-fixtures.py` → `testdata/` + `testdata/expected.json`: tiny NIfTI in every accepted dtype incl.
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
