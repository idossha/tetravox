# Roadmap

Phases are sequential; work inside a phase is parallel (one agent per bullet, disjoint directories, git worktrees).
A phase is done when its verification gate passes on real data (`TETRAVOX_TESTDATA`).

## Phase 0 — Walking skeleton  (gate: `pnpm test && pnpm e2e` green on macOS; Electron window shows a WebGL2 triangle whose colour came from a WASM call)
- cargo + pnpm workspaces, all crate/package stubs, `scripts/build-wasm.sh` (wasm-pack, `--target web`), electron-vite app, electron-builder config
- vitest, Playwright Chromium (headless, swiftshader ok) with pixel assertion helper, Playwright-Electron E2E, GitHub Actions (macOS + Ubuntu)
- `scripts/gen-fixtures.py` → `testdata/` (tiny NIfTI in every dtype incl. gz, tiny msh v2 ascii/bin + v4.1 with node+element data, tiny gifti, fs surface, stl/ply/obj)

## Phase 1 — Core I/O + engine foundation  (gate: real ernie data loads through the worker; screenshots of T1 slices in 3 views + 3D; tissue surfaces of ernie.msh orbiting)
- `tvx-nifti` (§6.1) · `tvx-mesh-io` (§6.2) · `tvx-geom` (§6.3) — each with synthetic + real-data tests and criterion benches
- `tvx-wasm` + `packages/wasm` worker/client (§6.4) — latest-wins request scheduling, transferables
- `packages/engine` foundation (§7.1, §7.2, §7.5): GL kit, cameras/controls, scene/layer store, view layouts, cursor/crosshair, render-on-demand, pick pass, screenshot, colormaps + LUT parsers (§7.6)
- `packages/app` shell: window, open dialog/drag-drop/CLI args, native gunzip IPC, layer list, info panel, status bar

## Phase 2 — Feature layers  (gate: every feature has a screenshot test on ernie; UX walk-through recorded as GIF)
- Volume slice layer complete (§7.3): window/threshold/symmetric, label fill/outline, interpolation, showIn3D planes, 4D index
- Mesh layer complete (§7.4): tag surfaces, node/elm field colouring, flat/smooth, edges, 6 clip planes with exact caps + gizmo, element isolation (tags/field/sphere/box/label volume), 2D contours + fill
- Isosurface layer (marching cubes / tets), points layer (electrodes, ROI spheres from JSON/CSV)
- Probing: cursor values for every layer, element info, header panel
- Scene save/load (ViewSpec), screenshot 1×/2×/4×, keyboard map, radiological toggle

## Phase 3 — High-end + packaging  (gate: signed-off benchmarks in `docs/BENCHMARKS.md`; `.dmg` + `.AppImage` + `.deb` open ernie)
- Weighted-blended OIT for transparent layers; volume raycasting (MIP + composite with transfer function) for 3D voxel rendering
- Oblique slice view, orientation cube, scale bar, colour bars, measurement tool
- Performance pass against §9 (typed-array pooling, index de-dup, instanced points, rayon in WASM if needed)
- electron-builder artefacts, file associations, first-run smoke test in CI, USER_GUIDE.md with screenshots
