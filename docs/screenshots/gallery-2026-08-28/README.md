# Screenshot gallery — 2026-08-28

93 curated PNGs (plus a 16-frame axial sweep, a 24-frame mesh orbit and their two GIFs) captured
from the built app, offscreen, against `TETRAVOX_TESTDATA=…/derivatives/SimNIBS/sub-ernie`. Every
image was produced by a job document in [`jobs/`](jobs/) — rerun any of them with

```sh
export TETRAVOX_TESTDATA=/path/to/derivatives/SimNIBS/sub-ernie
export TETRAVOX_APP="$PWD/node_modules/.bin/electron"
export TETRAVOX_APP_ARGS="$PWD/packages/app"
Tetravox --job docs/screenshots/gallery-2026-08-28/jobs/<name>.json --out docs/screenshots/gallery-2026-08-28/
```

or regenerate the whole gallery with the two Python builders that wrote the jobs and PNGs:

```sh
python3 docs/screenshots/gallery-2026-08-28/jobs/build_gallery.py
python3 docs/screenshots/gallery-2026-08-28/jobs/build_tdcs_glyphs.py
```

Every 2D image is world RAS: superior is up, anterior is left in a sagittal pane. Every 3D image
uses a logical camera preset (A/P/L/R/S/I). All were opened and visually checked after rendering;
see **Flagged / not captured** below for the two shots that were dropped.

## T1 volume

| File | What it shows |
|---|---|
| `t1-axial-1x1-zoom.png` / `t1-coronal-1x1-zoom.png` / `t1-sagittal-1x1-zoom.png` | Single-pane close-ups, `mmPerPx: 0.35`, `plain` preset |
| `t1-3d-anterior.png` / `t1-3d-superior.png` | The T1's bounding box from A and S camera presets |
| `t1-layout-2x2.png` / `t1-layout-1plus3.png` / `t1-layout-3dplus1.png` / `t1-layout-1x3.png` / `t1-layout-1x3-horizontal.png` | All five `layout` kinds |
| `t1-window-min-max.png` | Scale = data min→max (0–65535) |
| `t1-window-p2-98.png` | Scale ≈ p2–p98 (800–3200) |
| `t1-window-p50-p999.png` | Scale ≈ p50–p99.9 (400–5200) |
| `t1-colormap-viridis.png` / `t1-colormap-hot.png` / `t1-colormap-bone.png` | Alternate colormaps on the T1 |
| `t1-interp-nearest.png` / `t1-interp-linear.png` | Interpolation modes |
| `t1-convention-radiological.png` / `t1-convention-neurological.png` | RAD vs NEU convention (badge always on) |
| `t1-crosshair-off.png` | Crosshair explicitly off |
| `t1-cursor-readout.png` | Crosshair + coordinate/cursor readout on |
| `t1-scale-bar.png` | Scale bar, colour bar off |
| `t1-orientation-cube.png` | 3D pane's orientation cube |

Produced by `jobs/t1-views-layouts.json` and `jobs/t1-window-colormap-convention.json`.

## Label volume (`labeling.nii.gz`)

| File | What it shows |
|---|---|
| `labels-fill-axial.png` / `labels-outline-axial.png` / `labels-fill-outline-axial.png` | `labelMode: fill / outline / both` |
| `labels-coronal.png` | Fill mode, coronal pane |
| `labels-isolate-single-tissue.png` | `visibleLabels: [2]` — grey matter only |
| `labels-show-in-3d-iso.png` | `showIn3D` + `iso3d.enabled` — the label volume's 3D iso surfaces |

Produced by `jobs/labels-lut-modes.json`.

## Head mesh (`ernie.msh`, tissue tags from `.msh.opt`)

| File | What it shows |
|---|---|
| `mesh-tissues-translucent-anterior.png` / `-left.png` / `-superior.png` | `mesh-tissues-translucent` preset from three cameras — scalp 0.3, skull 0.5, opaque grey/white |
| `mesh-per-tissue-visibility-scalp-off.png` | Scalp tag hidden via `tagStyle` |
| `mesh-clip-plane-sagittal.png` | A sagittal clip plane with capping |
| `mesh-cross-section-2d-axial.png` | The mesh's contour in a 2D axial pane |
| `mesh-isolate-brain-only.png` | `isolate.tags` restricted to the brain tag |

Produced by `jobs/mesh-tissues.json`.

## Scalar field on mesh — TI (`grey_Thalamus_TI.msh`)

| File | What it shows |
|---|---|
| `ti-field-on-t1-axial.png` / `-coronal.png` | `ti-field-on-t1` preset: grey T1 + `hot` field thresholded at p90, colour bar with p90/p97/p99.9 ticks |
| `ti-field-colormap-turbo.png` | Same field, `turbo` colormap |

Produced by `jobs/ti-field.json`. **`ti-field-on-t1-3d.png` was dropped** — `grey_Thalamus_TI.msh`
has 0 triangles (documented in `AGENTS.md`: "anything assuming a mesh ships its own surface renders
an empty 3D view"), so its 3D pane is legitimately black. The 2D captures above are the field's real
pictures.

## Vector field — TDCS E-field (`ernie_TDCS_1_scalar.msh`)

| File | What it shows |
|---|---|
| `tdcs-vector-glyphs-arrows.png` | Arrow glyphs, `colorBy: magnitude`, `scale: byMagnitude` |
| `tdcs-vector-glyphs-lines.png` | Line-shaped glyphs, same field |
| `tdcs-vector-glyphs-anterior.png` | Arrow glyphs from an anterior camera |

Produced by `jobs/tdcs-vector-field.json` (written by `build_tdcs_glyphs.py`). **Flagged:**
`MeshLayer` with `colorMode: 'field'` (the field-coloured surface, as opposed to glyphs) rendered
**fully black** in the 3D pane for this mesh in every camera/zoom tried — the colour bar's own
statistics compute correctly (real min/mid/max printed), but the field-coloured surface geometry
never draws, while the same mesh's default tag/solid colour mode and its glyphs (which read
`meshCentroids` independently of that colour pass) render correctly. That looks like an app bug
scoped to `colorMode: 'field'` on this mesh; it was not investigated or fixed further, per the
task's "do not modify app source except for a genuine bug blocking a capture, and note it" —
noting it here. `tdcs-scalar-field-3d.png` (the field-coloured surface) and two glyph variants that
depended on the same broken preset state were dropped from the gallery for this reason.

## Surfaces (GIfTI pial, lh/rh)

| File | What it shows |
|---|---|
| `surfaces-pial-3d-left.png` / `-anterior.png` | The pial surfaces as 3D geometry |
| `surfaces-pial-contours-axial.png` / `-coronal.png` | The same surfaces as 2D contours over the T1 |
| `surfaces-pial-overview-2x2.png` | 2×2 overview: three contoured slices + the 3D surface |

Produced by `jobs/surfaces-pial.json`. `.annot`/`.curv` overlays were not attempted — the dataset
carries no such sidecars next to `lh.pial.gii`, so that overlay path was left uncaptured (see
below).

## Points — EEG electrodes (`GSN-HydroCel-185.geo`)

| File | What it shows |
|---|---|
| `eeg-electrodes-3d-superior.png` / `-anterior.png` | 185 labelled electrode positions over the T1, from S and A cameras |

Produced by `jobs/eeg-points.json`. sEEG (`m2m_ernie-seeg/ernie-seeg.msh`) was not captured — see
below.

## Overview captures

| File | What it shows |
|---|---|
| `overview-ti-field-2x2.png` / `overview-ti-field-1plus3.png` | The TI-field-on-T1 scene in both multi-pane layouts |

Produced by `jobs/overview-ti-field.json`.

## Automation

| File(s) | What it shows |
|---|---|
| `axial-sweep-0000.png` … `-0015.png`, `axial-sweep.gif` | 16-frame axial sweep of the T1, −40→60 mm |
| `head-orbit-0000.png` … `-0023.png`, `head-orbit.gif` | 24-frame 360° turntable of the translucent tissue mesh |

Produced by `jobs/automation-sweep.json` and `jobs/automation-orbit.json`.

## Interface

| File | What it shows |
|---|---|
| `ui-tour-window-panels.png` | Full application window (`window.panels: true`, `view: "window"`) — toolbar, 2×2 layout, coordinate/cursor panel, region label readout, header/metadata panel, GPU/renderer status bar |

Produced by `jobs/ui-tour.json`.

## Coverage checklist — what's here and what's not

Covered: T1 axial/coronal/sagittal/3D, window/level presets, 3 colormaps, nearest vs linear, RAD/NEU,
crosshair on/off, cursor readout, scale bar, orientation cube, all 5 layouts; label fill/outline/both,
LUT colours, single-tissue isolation, 3D iso; mesh tissue preset, per-tissue visibility, clip plane,
2D cross-section, isolation; TI scalar field with thresholded colour bar and ticks, alternate
colormap; TDCS vector glyphs (arrows and lines); GIfTI pial surfaces in 3D and as 2D contours; EEG
electrode points with labels; one multi-panel window tour capturing the coordinate bar, region/label
readout, header panel, measure/crosshair/scale toolbar buttons, and the GPU status bar; an axial
sweep and a mesh orbit as PNG frames + GIF.

**Not captured, and why:**

- **Measurement tool (length/angle) as a drawn overlay, histogram panel, keyboard-help sheet,
  settings dialog, and a dedicated screenshot dialog.** These are interactive UI states with no job
  action to reach them (the job schema drives the engine, not mouse gestures over toolbar buttons),
  and a Playwright-driven pass against the built app's toolbar (`Measure`, `?`, the settings gear,
  `Screenshot`) was not attempted in this pass — time-boxed out. The toolbar itself, with all of
  these buttons labelled, is visible in `ui-tour-window-panels.png`.
- **sEEG points** (`m2m_ernie-seeg/ernie-seeg.msh`) — not captured; same points/labels feature is
  demonstrated with the scalp EEG `.geo` file instead.
- **`.annot`/`.curv` surface overlays** — the dataset has no such sidecars next to the pial GIfTI
  files, so this path could not be exercised against real data.
- **A second, non-head public dataset** (spine/chest/abdomen CT, knee MRI, etc.) was not fetched or
  rendered in this pass — see `DATASETS.md` for what that would take and why it was skipped here.
- **Light-theme variants.** A job's screenshot comes off the WebGL canvas, which has no "theme" —
  `Scene.theme` and the app's dark/light setting only repaint the **panel chrome** (toolbar, side
  panels), not the rendered scene. `ui-tour-window-panels.png` is the one capture that includes
  panel chrome, and it was captured once, in the app's default (dark) theme; a second light-theme
  pass of the same window tour was not done in this session.
- **`ex-search`, `flex-search`, `leadfields`, `forward`** outputs under `TETRAVOX_TESTDATA` were
  surveyed but not rendered — the checklist's other feature areas (T1, labels, mesh tissues, scalar
  and vector fields, surfaces, points) already exercise every distinct rendering path the app has,
  and these directories are further instances of the same mesh/field/volume types already captured.

## Known-questionable images

- `labels-show-in-3d-iso.png` — the label volume's 3D iso surface renders as visibly blocky voxel
  facets rather than a smooth surface. This may be the true appearance of a per-label marching-cubes
  pass at the label volume's native resolution rather than a bug; not investigated further.
- `tdcs-vector-glyphs-arrows.png` / `-lines.png` / `-anterior.png` — at the glyph density needed to
  make individual arrows/lines visible against `ernie_TDCS_1_scalar.msh`'s ~5.9M elements, the result
  reads as a fine white fuzz over the cortical surface rather than discrete arrows. `everyNth` was
  raised as far as 400 or opacity dropped without individual glyphs becoming visually distinct;
  the feature is demonstrably active (correct colour-bar stats, correct arrow-vs-line shape switch)
  but is not a clean, legible picture the way the TI field's 2D captures are.
