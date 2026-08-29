# Visual refresh — 2026-08-29

Every screenshot in `docs/` and on the website predates the current interface (toolbar rail,
Settings, tabbed key map, per-tissue paint, publication export) and nearly all of them show one
subject's brain with a TI field. This plan replaces them with one coherent capture set, adds short
motion clips, widens the examples to CT/MRI of the spine, chest and abdomen, and rewrites the prose so
that **brain is the first citizen, not the only one**, and **TI is one tES paradigm, not the product**.

## 1. What we are looking for (the visual brief)

The reference is the user's own capture (`~/Desktop/example/tetravox-2026-08-29T08-00-10-513Z.png`):
a 2×2 grid, panels off, black canvas, `final_tissues` label map in **filled** mode at full opacity,
thin crosshair, orientation letters and corner info on, `NEU` badge, and the 3D pane showing the scalp
surface. It reads as a *picture of data*, not a picture of an app. Rules derived from it:

* **Engine captures, not window captures**, except for the handful of UI shots. Black (`scene`)
  background; white only for the publication-figure example.
* **Fill the pane.** Set `mmPerPx` explicitly (about `0.32` for a 700 px pane on a head, tuned per
  dataset) rather than `reset`, which fits one axis and leaves black margins on the other.
* **Show zoom as a feature.** For each modality one *overview* pane and one *zoomed detail* pane
  (`mmPerPx` ≈ 0.12–0.18, `center` on the structure) — the pair is what tells a reader they can zoom.
* **Crosshair on** in the multi-pane overviews (it is the "one cursor drives every pane" claim), **off**
  in single-pane detail shots and in every publication example.
* **Colour bars only when a field is on screen.** Annotations otherwise: orientation letters, corner
  info, badge. Scale bar on for the zoomed details.
* **Dark theme** throughout; exactly one light-theme UI shot.
* Stills at **1400 px** wide for a full grid, **900 px** for a single pane; GIFs at **560 px**, 24–36
  frames, ≤ 4 MB; MP4 alongside every GIF (the website embeds the MP4, the README the GIF).
* Every image is opened and checked before it is referenced: superior up, anterior up in axial, `NEU`
  badge present, nothing clipped.

## 2. The capture set — `docs/screenshots/2026-08-29/`

One directory replaces both `directed-2026-08-28/` and `gallery-2026-08-28/`. Jobs live in `jobs/`
with `${TETRAVOX_TESTDATA}`/`${TETRAVOX_DATA}` paths, never absolute ones. `manifest.json` lists every
file with `title`, `what_it_shows`, `dataset`, `group`; `README.md` is generated from it. The website's
`gallery.mjs` reads this manifest instead of the 18-plate scenarios report.

Data: `TETRAVOX_DATA=$PWD/data/ernie` (fetched, contains T1, `labeling`, `final_tissues`, `ernie.msh`,
the Thalamus TI mesh + `TI_max` nifti, the L_Insula tDCS vector mesh, `lh.pial.gii`, the EEG `.geo`),
`TETRAVOX_TESTDATA=~/datasets/000/derivatives/SimNIBS/sub-ernie` (adds `ernie_seeg.msh`, `toMNI/`,
`surfaces/`), and `data/public/` (AMOS22 CT+MRI abdomen, CTSpine1K, TotalSegmentator CT,
TotalSegmentator-MR spine/pelvis/whole-body, niivue chest CT) — see
`docs/screenshots/gallery-2026-08-28/DATASETS.md`, which moves to the new directory unchanged.

### 2.1 Filenames (the contract between the capture agents and the docs agent)

**hero/** — the pictures the home page, README and showcase lead with
| file | content |
|---|---|
| `hero-tissues-2x2.png` | The reference shot recreated: `final_tissues` filled over nothing (labels only), 2×2, scalp in 3D, crosshair on |
| `hero-t1-atlas-2x2.png` | T1 with `labeling` atlas as outline+fill at 0.35, 2×2, cortex isosurface in 3D |
| `hero-abdomen-ct-2x2.png` | AMOS22 CT soft-tissue window with organ labels filled, 2×2, organ isosurfaces in 3D |
| `hero-spine-ct-2x2.png` | CTSpine1K chest CT bone window, vertebra labels, 2×2, vertebra isosurfaces in 3D |
| `hero-field-on-mesh.png` | Thalamus TI mesh: grey-matter surface coloured by `TI_max`, `1+3` layout, T1 in the 2D panes with the field overlay, colour bar |

**modalities/** — "not only brain"; each dataset gets an overview + a zoomed detail
| file | content |
|---|---|
| `mod-brain-t1-axial.png` / `mod-brain-t1-axial-zoom.png` | T1, single axial pane; zoom on the hippocampus with scale bar |
| `mod-brain-t2-coronal.png` | `T2_reg.nii.gz` coronal (the second contrast) |
| `mod-head-ct-axial.png` / `mod-head-ct-bone-3d.png` | niivue `CT_Philips` head CT: brain window axial; bone window as 3D planes |
| `mod-chest-ct-lung-2x2.png` / `mod-chest-ct-lung-zoom.png` | niivue `CT_Abdo` lung window; zoom on the lung bases |
| `mod-abdomen-ct-soft-axial.png` / `mod-abdomen-ct-labels-axial.png` / `mod-abdomen-ct-labels-3d.png` | AMOS22 CT `0004`: soft window; organ labels outlined; organ isosurfaces from `A` |
| `mod-abdomen-mri-t1-coronal.png` / `mod-abdomen-mri-labels-2x2.png` | AMOS22 MRI `0555`: T1w coronal; labels filled 2×2 |
| `mod-spine-ct-sagittal.png` / `mod-spine-ct-labels-sagittal.png` / `mod-spine-ct-labels-3d.png` | CTSpine1K `A-0377`: bone window; per-vertebra labels; vertebra isosurfaces from `L` |
| `mod-spine-mri-sagittal.png` / `mod-spine-mri-labels-sagittal.png` | TotalSegmentator-MR `s0375` lumbar MRI, plain and with discs/vertebrae/cord labels |
| `mod-pelvis-mri-labels-3d.png` | TotalSegmentator-MR `s0132` pelvis structures as isosurfaces |
| `mod-wholebody-mri-coronal.png` | TotalSegmentator-MR `s0175` whole-body GRE coronal with labels |

**features/** — one or two per guide section, brain data unless stated
| file | guide section |
|---|---|
| `feat-layouts-1x1.png` `-1x3.png` `-2x2.png` `-1plus3.png` `-3dplus1.png` | The panes (T1 + atlas outline) |
| `feat-zoom-overview.png` / `feat-zoom-detail.png` | The panes — the same axial slice at `mmPerPx` 0.32 and 0.12 |
| `feat-convention-neu.png` / `feat-convention-rad.png` | The panes |
| `feat-window-minmax.png` / `feat-window-p2-98.png` / `feat-colormap-hot.png` / `feat-colormap-viridis.png` | Volume layers |
| `feat-threshold-field-on-t1.png` | Volume layers — `TI_max` on T1 at p90 with colour bar |
| `feat-4d-frame.png` | Volume layers — only if a 4D nifti is available; otherwise omit and say so |
| `feat-labels-fill.png` / `feat-labels-outline.png` / `feat-labels-both.png` / `feat-labels-solo-thalamus.png` | Atlases & regions |
| `feat-labels-iso-brainstem.png` | Atlases & regions / Isosurfaces |
| `feat-mesh-tissues-3d.png` / `feat-mesh-translucent.png` / `feat-mesh-clip-caps.png` / `feat-mesh-isolate-brain.png` / `feat-mesh-cut-2d.png` / `feat-mesh-per-tissue-paint.png` | Meshes — the last is the new per-tissue paint (one tag on the field, another fixed) |
| `feat-mesh-field-tdcs-3d.png` | Meshes — `ernie_TDCS_1_scalar.msh` `E` magnitude on grey matter with colour bar |
| `feat-surface-pial-3d.png` / `feat-surface-contours-2x2.png` | Surfaces & annotations |
| `feat-isosurface-organs-abdomen.png` | Isosurfaces — non-brain example |
| `feat-glyphs-arrows.png` / `feat-glyphs-lines.png` | Vector fields |
| `feat-points-eeg-3d.png` / `feat-seeg-contacts-axial.png` / `feat-seeg-mesh-3d.png` | Points & electrodes |
| `feat-figure-export-2x2.png` | Screenshots & video — a `view: "figure"` export on white with A/B/C/D, 300 dpi |
| `feat-measure.png` | Measurements — Playwright (window capture) |
| `feat-coordinates.png` | Coordinates — window capture of the coordinate bar + cursor block, MNI populated |

**motion/** — GIF + MP4 pairs, `<name>.gif` and `<name>.mp4`
| name | content |
|---|---|
| `orbit-head-translucent` | 36-frame Z orbit of `ernie.msh`, scalp 0.3, skull 0.5, brain opaque |
| `orbit-spine-vertebrae` | 36-frame Z orbit of the CTSpine1K vertebra isosurfaces over the CT's sagittal plane |
| `orbit-abdomen-organs` | 36-frame orbit of AMOS organ isosurfaces |
| `sweep-axial-t1-atlas` | 32-frame axial sweep, T1 + atlas outline, inferior → superior |
| `sweep-coronal-abdomen-ct` | 32-frame coronal sweep of the abdomen CT with organ labels |
| `clip-head-sagittal` | tween: a sagittal clip plane driven through the head mesh with caps, 48 frames |
| `zoom-axial-detail` | tween: axial pane zooming from overview into the hippocampus, 36 frames |
| `field-threshold-rise` | tween: the TI-field threshold rising from p50 to p97 on T1 + 3D grey surface, 36 frames |

**ui/** — Playwright window captures of the *current* interface, 1600×1000
| file | content |
|---|---|
| `ui-window-dark.png` / `ui-window-light.png` | The whole window, `1+3`, T1 + atlas + mesh loaded, panels open |
| `ui-layer-panel.png` / `ui-region-panel.png` / `ui-info-panel.png` / `ui-settings.png` / `ui-keymap-tabs.png` / `ui-screenshot-dialog.png` / `ui-measure-panel.png` | Panels and dialogs, cropped |

### 2.2 Who builds what

* **Agent A — brain / ernie stills + UI** (`hero-tissues`, `hero-t1-atlas`, `hero-field-on-mesh`, all
  `feat-*`, all `mod-brain-*`, `mod-head-ct-*`, all `ui-*`, `feat-measure`, `feat-coordinates`).
* **Agent B — non-brain modalities + all motion** (`hero-abdomen`, `hero-spine`, every other `mod-*`,
  `feat-isosurface-organs-abdomen`, every `motion/*`).

Both write jobs into `docs/screenshots/2026-08-29/jobs/`, each with its own builder script
(`build_brain.py`, `build_modalities.py`, `build_motion.py`) modelled on
`docs/screenshots/gallery-2026-08-28/jobs/build_*.py`, and append to `manifest.json` (a JSON array;
merge on completion, do not clobber). The Playwright spec `packages/app/e2e/ui-tour-gallery.spec.ts`
is updated for the new rail/settings/tabbed key map, not rewritten.

## 3. Prose — where high-level, where detail

| Surface | Altitude | Change |
|---|---|---|
| `README.md` | **High.** One tagline, one hero, six feature bullets, "who it is for", three links | Tagline "A fast desktop viewer for brain volumes and meshes" → "A fast desktop viewer for medical volumes and meshes — MRI, CT, segmentations, simulation meshes." Hero = `hero-t1-atlas-2x2.png`; a 2-wide strip of `hero-abdomen-ct` + `hero-spine-ct` under "Not only brain". Drop the showcase MP4 from the README body; link it. |
| `website/index.md` (Home) | **High.** The pitch, a hero, three motion clips, the modality strip, features in six bullets, "who it is for" | Rewrite the second and third paragraphs: neuroimaging **and** general medical imaging; tES/TMS (TI, tDCS, tACS, TMS E-fields) rather than "TI-field simulation". Embed `orbit-head-translucent.mp4`, `sweep-coronal-abdomen-ct.mp4`, `clip-head-sagittal.mp4` in a 3-up row. "Getting started" shrinks to install + open + link; keyboard basics move to the guide. |
| `website/get-started.md` | **Mid.** Install, first open, first scene, a link per next step | Update screenshots to `ui-window-dark.png`; mention Settings and the key-map dialog. |
| `website/showcase.md` | **High → visual.** The film plus the modality gallery | Keep the film; add a "Beyond the head" section that lays out the `mod-*` pairs with one line each. |
| `docs/USER_GUIDE.md` → `/guide/*` | **Detail.** Every control, every shortcut, one screenshot per section and a zoomed detail where zoom matters | Swap every `directed-2026-08-28` reference for the `feat-*` file listed above; add "works the same on a CT" sentences where a feature is modality-independent (window/level, labels, isosurfaces); rename the preset description "the TI field" → "a simulated field (`TI_max`, `E` magnitude, …)". |
| `docs/AUTOMATION.md` → `/automation` | **Detail.** Unchanged depth | Swap the five images; the preset table keeps `ti-field-on-t1` as the id (code) but describes it as the field-over-anatomy preset and notes it accepts any `*_max` / field-bearing mesh. |
| `website/src/gallery.md` (generated) | **Exhaustive.** Every plate | `gallery.mjs` reads `docs/screenshots/2026-08-29/manifest.json`, grouped by `group` (hero, modalities, features, motion, ui). |
| `docs/media/SHOWCASE.md` + film | untouched this round | The film is regenerated by `showcase.py`; out of scope today, but its captions say "TI" twice — flagged for the next film. |

Wording rules for the docs agent:
* "brain" stays wherever the sentence is about brain data; where it stands in for *the domain*
  ("brain volumes and meshes", "built for brain data"), it becomes "medical volumes and meshes" or
  "neuroimaging and medical imaging".
* "TI" is never the generic word for a field. The generic phrase is "a simulated field — tES (TI,
  tDCS, tACS) or TMS". File names like `TI_max` and the preset id are kept verbatim.
* SimNIBS stays named; it is the head-model source and the reason `.msh.opt` matters.

## 4. Verification before anything is referenced

1. `pnpm --filter @tetravox/website build` passes with `ignoreDeadLinks: false`.
2. Every `<img>`/`![]()` in `README.md`, `docs/*.md`, `website/*.md` resolves to a file that exists.
3. Each new PNG opened and checked against §1; each GIF ≤ 4 MB and looping cleanly.
4. `rg -n -i '\bbrain\b|\bTI\b' README.md website/*.md docs/USER_GUIDE.md docs/AUTOMATION.md` reviewed
   line by line — every hit is either about brain data specifically or a file/preset name.
5. `docs/screenshots/directed-2026-08-28/` and `gallery-2026-08-28/` deleted; `website/public/{shots,gallery}` regenerated by the sync/gallery scripts; the stray `docs/media/walkthrough.*` deletion committed.

## 5. Out of scope / follow-ups

* Regenerating `showcase.mp4` with non-brain acts and neutral captions.
* Renaming the `ti-field-on-t1` preset id (a code change with test impact) — proposed as
  `field-on-anatomy` with the old id kept as an alias.
* A knee/joint MRI sample (none login-free in NIfTI; see DATASETS.md).
