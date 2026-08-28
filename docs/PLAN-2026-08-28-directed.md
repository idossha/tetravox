# Directed tasks — 2026-08-28

Maintainer's asks, verbatim: (1) collapse/expand layers; (2) render isosurfaces of NIfTI in the 3D viewer;
(3) the 3D viewer is always on — the only option is whether to render the isosurface; (4) expose a thin API
surface: load + auto-configure visualization, load + capture screenshots, create videos / sweeps through slices.

| # | Owner branch | Design |
|---|---|---|
| 1 | `feat/layer-collapse` | Disclosure per layer row (header stays: kind icon, name, eye, opacity, active accent); expand/collapse-all in the panel header; UI state only (never in `ViewSpec`); `←`/`→` on the active row. |
| 2 | `feat/volume-iso3d` | Volume layer editor gains a **3D surface** switch + iso value (histogram-ranged slider, default p95 for scalars; label volumes: surfaces of the selected/visible regions at label ± 0.5 in their LUT colours), colour, opacity, smooth. Implemented as a *linked* `IsosurfaceLayer` (existing `marchingCubes` op) owned by the volume layer: follows 4D frame + visibility, removed with the volume, persisted in the scene as the volume layer's `iso3d` field (additive frozen-type change with ARCHITECTURE + DECISIONS). |
| 3 | `feat/volume-iso3d` | Every layout includes the 3D pane: `1+3` (3D large + three slices), `2×2`, `3D+1`. Layouts without a 3D pane are removed from the UI and the key cycle; scenes that name one are migrated on load. |
| 4 | `feat/automation-api` | `Tetravox --job job.json --out DIR [--quiet]`: the app runs offscreen (same mode as the E2E), loads `scene` (a `ViewSpec` or a list of files + `preset`), executes `actions`: `screenshot {view|grid,width,height,dpi,background,include}`, `sweep {view, plane, from,to,step | count, format: png|gif|mp4, fps}`, `orbit {view:'3d', degrees, frames, axis, format}`, `set {layer patches}`; writes files and a `job-result.json`; exits non-zero on any failure. Presets: `ti-field-on-t1`, `mesh-tissues-translucent`, `atlas-outline`, `plain`. MP4 via `ffmpeg` when on PATH, else GIF (pure JS) + PNG frames. Python client `python/tetravox/` (no deps beyond stdlib): `Job(...).add(...).screenshot(...).sweep(...).run(app=None)` locating the packaged app or `TETRAVOX_APP`; examples under `python/examples/`. Docs: `docs/AUTOMATION.md`. |

Gate for each: offscreen E2E green (`scripts/e2e-quiet-check.sh`), a real-data test on ernie, screenshot(s) under
`docs/screenshots/directed-2026-08-28/`, conventional commits, no Co-Authored-By. Integrator: merge in order 1 → 2/3 → 4,
run the chain, push, rebuild `tetravox-builds/`.
