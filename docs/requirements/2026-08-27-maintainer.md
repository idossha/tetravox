# Maintainer requirements — 2026-08-27 (Phase-2 gate items R1–R5)

These are **hard gate items for Phase 2**, each proven by an E2E test (engine Playwright and/or app
Playwright-Electron) with pixel or state assertions, on the real ernie data where stated. They refine
§7.5 / §7.3 / §7.4 / §8 of `docs/ARCHITECTURE.md`; where they conflict with the contract, they win and the
contract is amended in the same commit.

## R1 — Mouse manipulation, not only arrow keys
* 2D panes: **left-click sets the cursor** (crosshair) to the clicked world point; **left-drag keeps moving it**
  continuously (all other panes and the 3D crosshair follow live). Arrow keys / PgUp / PgDn remain as they are.
* 3D pane: left-drag orbits, right-drag pans, wheel dollies, double-click picks (sets the cursor to the hit point).
* Gate test: synthetic `pointerdown/pointermove/pointerup` in the axial pane moves the cursor to the world point
  implied by the pane camera (asserted through `Engine.probe`/scene state, ±½ voxel), the coronal and sagittal
  corner `SLICE` readouts change accordingly, and the 3D crosshair moves.

## R2 — Zooming in/out of panes
* Per-pane zoom: `⌘/Ctrl + wheel` (and trackpad pinch) zooms **about the pointer position**; `+` / `-` zoom about
  the pane centre; `r` (or double-click on the pane background with a modifier) resets to fit. Zoom is per pane
  (`SliceView.camera.mmPerPx`), persists in the ViewSpec, and is clamped to [0.05, 20] mm/px.
* Gate test: after one zoom-in step at pointer P, `mmPerPx` shrank by the configured factor and the world point
  under P is unchanged (±0.1 mm); `r` restores the fit.

## R3 — Move the crosshair, not the scan
* Left-drag **never pans** the image. Panning is an explicit gesture only: middle-drag, `space + left-drag`, or
  two-finger drag on trackpad. Right-drag remains window/level on the active layer.
* Gate test: a left-drag from A to B moves the cursor by the world delta A→B while `camera.center` is unchanged;
  a middle-drag moves `camera.center` while the cursor is unchanged; the pixel colour at a fixed screen point away
  from the crosshair is byte-identical before/after the left-drag (the scan did not move).

## R4 — Cross-section views of meshes in axial / sagittal / coronal panes, sweepable like NIfTI
* With a mesh loaded — **with or without any NIfTI** — every 2D pane shows that mesh's cut at the pane's plane:
  `fillIn2D` = filled per-element polygons coloured by tissue tag (or by the selected node/element field through
  the layer's colormap/scale), `contoursIn2D` = tissue-boundary contour lines; both follow the cursor and honour
  `tagStyle` visibility/opacity and any isolation mask. Default when a mesh is opened: fill **and** contours on.
* Slice stepping (wheel, PgUp/PgDn, arrows) sweeps through the mesh; the step is the active volume's voxel size
  when a volume is loaded, else 1 mm (configurable). The 2D cut is served by the shared cut-manager (latest-wins),
  so sweeping never queues.
* Gate tests (real data): `ernie.msh` alone → three panes show tissue cross-sections with the `.msh.opt` colours,
  scalp/skull/CSF/GM/WM pixels at known RAS points equal their tag colours; `Thalamus_TI.msh` with `TI_max`
  element colouring on the cut (a pixel at the thalamus target maps to the colormap value of that element's
  `TI_max`, cross-checked through `locate`); a 20-step sweep of the axial pane completes at ≥ 30 fps end-to-end
  (cut round trip + upload + render), measured; golden of the 2×2 layout with mesh-only and with T1 + mesh.

## R5 — Region highlight / mute like Freeview: select, deselect, recolour
* One **Region panel** for every labelled thing: label volumes (atlases/tissue maps), mesh tissue tags
  (`tagStyle`), surface annotations (`.annot` / `.label.gii` via `colorMode:'label'`). Rows: eye (show/hide),
  colour swatch (colour picker; edits persist in the scene and can be saved as a LUT file), opacity, name, id,
  count. Search-as-you-type; click = select/highlight (outline emphasis in the panes); ⇧/⌘-click multi-select;
  Alt-click = **solo** (mute all others); "Show all / Hide all / Invert"; double-click = jump the cursor to the
  region centroid. Clicking a labelled voxel / tissue in a pane selects that row (Freeview behaviour).
* Gate tests: hiding a label removes its colour from the pane pixels while others are unchanged; recolouring a
  label changes exactly those pixels to the new colour (analytic); solo leaves only the chosen label; the same
  three assertions on a mesh tissue tag in the 3D pane and in a 2D cut; selection persists through scene
  save/load.
