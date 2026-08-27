# Roadmap (v2)

Phases are sequential; work inside a phase is parallel (one agent per bullet, disjoint directories, git worktrees).
A phase is done when **every** gate item below passes, on real data where the item says so
(`TETRAVOX_TESTDATA`). Section references are to `docs/ARCHITECTURE.md` v2.

---

## Phase 0 — Walking skeleton and the frozen contract

**Gate (all of it, not a subset):**

1. `pnpm test && pnpm e2e` green on macOS **and** ubuntu-24.04.
2. The **packaged** `.dmg` and `.AppImage` — not the dev server — show a WebGL2 triangle whose colour came from a
   WASM call. The renderer is loaded with `win.loadURL('tetravox://app/index.html')`.
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
  matrix (test legs only — package legs land in Phase 3 but the workflow file carries them from day one).
- `scripts/gen-fixtures.py` → `testdata/` + `testdata/expected.json`: tiny NIfTI in every accepted dtype incl.
  `.gz`, **one with `sform_code = 0, qform_code = 1, pixdim[0] = −1`** (the only case that catches a missing
  qfac) and **one with `scl_slope = NaN`**; tiny msh v2 ascii/binary + v4.1 with node and element data, one with
  non-contiguous element ids and a gap; tiny GIfTI in all three supported encodings; FreeSurfer surface + curv +
  annot; stl/ply/obj incl. an n-gon that exercises `tri_edge_mask`; a mesh with ≥ 2²¹ nodes for the face-key test.

---

## Phase 1 — Core I/O + engine foundation

**Gate:**
1. Real ernie data loads through the worker with progress and cancel: opening `m2m_ernie/ernie_seeg.msh`
   (492 MB) shows a moving progress bar within 200 ms and cancels within 500 ms of the click.
2. `ernie.msh` **tag surfaces** orbiting (no `build_topology` on this path — §6.3).
3. Screenshots of `T1.nii.gz` slices in the three canonical views + 3D, with orientation letters, corner info and
   the RAD/NEU badge present in every golden.
4. The oblique golden: `mode:'oblique'`, `normal = normalize([1,1,1])`, T1 + a mesh contour layer.
5. The pick golden and the overlay-compositing golden (§11).
6. `wasm_heap_bytes()` stays under the §9.2 bar for `ernie_seeg.msh`.

**Work (one agent per bullet):**
- `tvx-nifti` (§6.1) — reader, exact stats, `gpu_payload` ladder, `label_index`. Synthetic + real-data tests
  (qfac, NaN slope, float32 label volume) and criterion benches.
- `tvx-mesh-io` (§6.2) — Gmsh v2 ascii/binary + v4.1, `read_msh_opt`, GIfTI, FreeSurfer, STL/PLY/OBJ.
- `tvx-geom` (§6.3) — `tag_surfaces`, `extract_boundary`, `orient_surface`, `morton_reorder`,
  `build_tet_blocks`, `build_point_locator`, `plane_cut`, `locate_point`, `surface_contours`,
  `label_centroids`. `build_topology` lands here but is **off the first-frame path**.
- `tvx-wasm` + `packages/wasm` worker/client (§6.4, §6.5) — latest-wins keyed on `key`, progress, cancel,
  transferables, `CutOut` pooling, `heapBytes` on every `Res`.
- `packages/engine` foundation (§7.0–7.2, §7.5): GL kit + `probeCapabilities`, the rAF frame pump with
  `interacting` / `whenSettled()`, cameras/controls, scene/layer store with `activeLayerId`, `SliceView` model
  incl. oblique, view layouts, cursor/crosshair, pick pass, screenshot, colormaps + LUT parsers (§7.6).
- `packages/app` shell: window + privileged scheme wiring, open dialog / drag-drop / CLI args, layer list with
  load cards, **info panel with `Cursor` and `Mouse` blocks**, coordinate bar (RAS/voxel), orientation letters,
  corner info, RAD/NEU badge, status bar.

---

## Phase 2 — Feature layers

**Gate:** every feature below has a golden **and** an analytic pixel test on ernie; UX walk-through recorded as a
GIF; `grey_Thalamus_TI.msh` (0 tris) renders via `extract_boundary` in < 1.5 s.

- Volume slice layer complete (§7.3): `Scale` incl. `heat` with min/mid/max and the negative branch, threshold
  with `softBins`, label fill/outline/both via the dense index remap, `visibleLabels` / `labelOpacity`,
  interpolation, `showIn3D` planes, 4D index spinner.
- Mesh layer complete (§7.4): tag surfaces, `tagStyle` (per-tag visible/opacity/colour) driving a tissue table,
  node/elm field colouring, `colorMode:'label'` for `.annot` / `.label.gii`, flat/smooth, masked-barycentric
  edges (surface and caps), 6 clip planes with exact caps + gizmo, element isolation (tags / field / sphere /
  box / label volume), 2D contours + `fillIn2D`, vector glyphs.
- Isosurface layer (marching cubes / tets); points layer (electrodes, ROI spheres from JSON/CSV, and SimNIBS
  `eeg_positions/*.csv`).
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

**Gate:** signed-off benchmarks in `docs/BENCHMARKS.md` on both reference machines (§9); `.dmg` (arm64 + x64),
`.AppImage` and `.deb` each open `ernie.msh` and pass the artefact smoke test.

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
