# Screenshot gallery — 2026-08-28

Every feature of the app, as pictures, on the SimNIBS `ernie` subject
(`TETRAVOX_TESTDATA=…/derivatives/SimNIBS/sub-ernie`), MNE's `fsaverage`, and four public non-head
CTs ([DATASETS.md](DATASETS.md)). Two producers:

* **Jobs** — `--job` documents under [`jobs/`](jobs/), written and run by the four Python builders
  there (`jobs/build_all.sh` runs them in order). Every engine picture comes from one of these;
  `Tetravox --job jobs/<name>.json --out .` reruns any single one.
* **Playwright** — [`packages/app/e2e/ui-tour-gallery.spec.ts`](../../../packages/app/e2e/ui-tour-gallery.spec.ts)
  drives the real app offscreen for the states a job cannot reach (dialogs, panels, the measurement
  gesture, both themes) and writes the `ui-*.png` files here.

```sh
export TETRAVOX_TESTDATA=/path/to/derivatives/SimNIBS/sub-ernie
export TETRAVOX_APP="$PWD/node_modules/.bin/electron"
export TETRAVOX_APP_ARGS="$PWD/packages/app"
pnpm wasm && pnpm --filter @tetravox/app build
scripts/fetch-public-samples.sh
docs/screenshots/gallery-2026-08-28/jobs/build_all.sh
pnpm --filter @tetravox/app exec playwright test e2e/ui-tour-gallery.spec.ts --project=dev
```

Every image was opened and checked: 2D panes are world RAS with superior up (anterior left in a
sagittal pane), 3D panes use the A/P/L/R/S/I camera presets, every PNG is under 1.5 MB. Nothing here
puts a window on screen.

## T1 volume — `jobs/t1-views-layouts.json`, `jobs/t1-window-colormap-convention.json`

| File | What it shows |
|---|---|
| `t1-axial-1x1-zoom.png` / `t1-coronal-1x1-zoom.png` / `t1-sagittal-1x1-zoom.png` | Single panes at `mmPerPx: 0.35` |
| `t1-3d-anterior.png` / `t1-3d-superior.png` | The volume's three slice planes in the 3D pane (`showIn3D`) from A and S |
| `t1-layout-2x2.png` / `-1plus3.png` / `-3dplus1.png` / `-1x3.png` / `-1x3-horizontal.png` | All five `layout` kinds |
| `t1-window-min-max.png` / `t1-window-p2-98.png` / `t1-window-p50-p999.png` | Window/level as `scale` |
| `t1-colormap-viridis.png` / `-hot.png` / `-bone.png` | Colormaps |
| `t1-interp-nearest.png` / `t1-interp-linear.png` | Interpolation |
| `t1-convention-radiological.png` / `t1-convention-neurological.png` | RAD vs NEU (the badge is never optional) |
| `t1-crosshair-off.png` / `t1-cursor-readout.png` / `t1-scale-bar.png` / `t1-orientation-cube.png` | Chrome toggles |

## Label volume — `jobs/labels-lut-modes.json`

| File | What it shows |
|---|---|
| `labels-fill-axial.png` / `labels-outline-axial.png` / `labels-fill-outline-axial.png` | `labelMode: fill / outline / both`, LUT colours from `labeling_LUT.txt` |
| `labels-coronal.png` | Fill, coronal |
| `labels-isolate-single-tissue.png` | `visibleLabels: [2]` |
| `labels-show-in-3d-iso.png` | `showIn3D` + `iso3d` — per-label 3D surfaces (voxel-faceted at native resolution) |

## Head mesh — `jobs/mesh-tissues.json`

| File | What it shows |
|---|---|
| `mesh-tissues-translucent-anterior.png` / `-left.png` / `-superior.png` | `mesh-tissues-translucent` preset, tissue colours from `ernie.msh.opt` |
| `mesh-per-tissue-visibility-scalp-off.png` | `tagStyle` hides the scalp |
| `mesh-clip-plane-sagittal.png` | A clip plane with caps |
| `mesh-cross-section-2d-axial.png` | The mesh's contour in a 2D pane |
| `mesh-isolate-brain-only.png` | `isolate.tags` |

## Fields on meshes

**TI** — `jobs/ti-field.json`

| File | What it shows |
|---|---|
| `ti-field-on-t1-axial.png` / `-coronal.png` | `ti-field-on-t1` preset: `hot` over grey, thresholded at p90, colour bar with p90/p97/p99.9 ticks |
| `ti-field-colormap-turbo.png` | Same, `turbo` |

`grey_Thalamus_TI.msh` has 0 triangles (AGENTS.md), so it has no 3D picture; its 2D captures are
the real ones.

**TDCS E-field** — `jobs/tdcs-vector-field.json` (`jobs/build_tdcs_glyphs.py`)

| File | What it shows |
|---|---|
| `tdcs-field-surface-3d-left.png` / `-superior.png` | `colorMode: 'field'`, `|E|` on the cortical surface, `hot` |
| `tdcs-field-surface-colormap-viridis.png` | Same, `viridis` |
| `tdcs-vector-glyphs-arrows.png` / `-lines.png` / `-anterior.png` | Vector glyphs, `everyNth: 400`, length by magnitude |

**Resolved: the "field mode renders black" note from the first pass was not a renderer bug.** The
`ti-field-on-t1` preset thresholds the field at its whole-mesh p90 — 0.598 V/m on this mesh, where
`|E|` peaks at 13 V/m in the electrodes and gel — while the cortical surface's `|E|` tops out at
0.285 V/m, so every surface triangle was below threshold. With `plain` and `colorMode: 'field'` set by
hand (no threshold) the surface renders correctly. It is a preset limitation on a whole-head tDCS
mesh, not something to fix in the engine; no app source was changed. The glyph fuzz at any density is
also expected — 5.9 M elements — and is kept as the honest picture.

## Surfaces and points

| File | Job | What it shows |
|---|---|---|
| `surfaces-pial-3d-left.png` / `-anterior.png` | `surfaces-pial.json` | GIfTI `lh/rh.pial.gii` in 3D |
| `surfaces-pial-contours-axial.png` / `-coronal.png` / `surfaces-pial-overview-2x2.png` | | The same surfaces as 2D contours |
| `freesurfer-binary-pial-3d.png` | `freesurfer-pial.json` | A FreeSurfer **binary** surface (`fsaverage/surf/lh.pial`) |
| `eeg-electrodes-3d-superior.png` / `-anterior.png` | `eeg-points.json` | `GSN-HydroCel-185.geo` — 185 labelled points |
| `seeg-leads-mesh-3d-right.png` | `seeg-leads.json` | `m2m_ernie-seeg/ernie-seeg.msh` (electrode tags, >2²¹ nodes) + `ernie_seeg_views.pos` contacts |
| `seeg-leads-contacts-axial.png` | | The lead tracks through the axial slice |

`.annot` / `.curv` — **not openable.** `crates/tvx-mesh-io` has `read_fs_annot` / curv readers, but
`crates/tvx-wasm/src/mesh.rs` only routes `msh / gii / fs(surface) / stl / ply / obj / geo`, so opening
`fsaverage/label/lh.aparc.annot` fails with `unrecognised mesh format` and `surf/lh.curv` with
`unexpected end of file` (it is parsed as a surface). `.label.gii` is routed, but no such file exists
in the dataset. Not captured.

## Overviews and automation

| File | Job |
|---|---|
| `overview-ti-field-2x2.png` / `overview-ti-field-1plus3.png` | `overview-ti-field.json` |
| `axial-sweep-0000…0015.png`, `axial-sweep.gif` | `automation-sweep.json` |
| `head-orbit-0000…0023.png`, `head-orbit.gif` | `automation-orbit.json` |

## Public non-head data — `jobs/build_public.py` ([DATASETS.md](DATASETS.md))

Windows are Hounsfield: soft tissue W400/L40 (`-160…240`), bone W1500/L300 (`-450…1050`), lung
W1500/L-600 (`-1350…150`).

| Prefix | Files | What it shows |
|---|---|---|
| `public-totalseg-` | `ct-soft-{axial,coronal,sagittal,3d,2x2}`, `ct-bone-{coronal,sagittal}`, `labels-fill-{coronal,axial}`, `labels-outline-axial`, `labels-3d-iso` | TotalSegmentator example CT + its multi-organ label map |
| `public-ct-abdo-` | `soft-{axial,coronal,sagittal,3d,2x2}`, `bone-{coronal,axial}` | niivue-images `CT_Abdo` |
| `public-ct-chest-` | `lung-{axial,coronal,sagittal,3d,2x2}`, `soft-axial`, `bone-sagittal` | niivue-images `CT_Philips` — a **head** CT despite the prefix (see DATASETS.md) |
| `public-spine-` | `ct-bone-{axial,coronal,sagittal,3d,2x2}`, `ct-soft-sagittal`, `vertebra-labels-{sagittal,coronal}`, `vertebra-labels-outline-axial`, `vertebra-labels-3d-iso`, `vertebra-labels-3d-iso-left` | CTSpine1K chest CT with per-vertebra labels — the column is vertical, superior up |

Knee MRI: not found as a small login-free NIfTI — DATASETS.md lists what was tried.

## Interface — `packages/app/e2e/ui-tour-gallery.spec.ts` (T1 + labeling, 1600×1000)

| File | What it shows |
|---|---|
| `ui-window-dark.png` / `ui-window-light.png` | The whole window, both sidebars open, 2×2, in each theme |
| `ui-window-light-layout-1plus3.png` / `ui-window-light-layout-3d-only.png` | Light theme, other layouts |
| `ui-measure-length-and-angle.png` | Measure mode: an angle (three clicks, axial) and a length (two clicks, coronal) drawn on the slices and echoed in the 3D pane |
| `ui-measure-panel.png` | The measurements panel (M1 67.0 °, M2 96.8 mm, jump-to, delete) |
| `ui-histogram-panel.png` | The T1 layer's editor: colormap, scale, histogram with log-y, window presets, threshold, interpolation, 3D surface |
| `ui-region-panel.png` | The label volume's region list — names, ids, voxel counts, per-label eye/opacity |
| `ui-layer-panel.png` / `ui-layer-panel-light.png` | The left panel |
| `ui-info-panel.png` / `ui-info-panel-light.png` | The right panel: coordinate bar, cursor and mouse probes, header |
| `ui-header-panel.png` / `ui-coordinate-bar.png` | NIfTI header viewer with search and raw toggle; the coordinate bar with space picker, copy and paste |
| `ui-keyboard-help.png` / `ui-keyboard-help-light.png` | The keyboard sheet (generated from the key map) |
| `ui-settings-dialog.png` | Settings, Appearance tab (System / Light / Dark, config path) |
| `ui-screenshot-dialog.png` | The screenshot dialog: target, size, scale, DPI, background, auto-trim, include flags, preview |
| `ui-app-menu-open.png` | The Tetravox menu (Open, New, Open scene, Save, Save as) |
| `ui-sidebars-collapsed.png` | Both sidebars collapsed — the grid takes the window |
| `ui-tour-window-panels.png` | The `window.panels: true` job capture (`jobs/ui-tour.json`), for comparison |

Themes only repaint the panel chrome: the rendered panes are the same in both, by design (the pane
chrome is drawn by the engine and keyed off the pane, not the theme — `theme.spec.ts` asserts it).

## Remaining gaps

* `.annot` / `.curv` overlays (not wired into the wasm loader — above).
* A knee MRI (no small open NIfTI found — DATASETS.md).
* A real chest CT from a non-head source other than CTSpine1K's; `CT_Philips` turned out to be a head.
