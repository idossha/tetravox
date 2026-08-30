---
layout: page
title: Roadmap
permalink: /ROADMAP.html
nav_order: 9
---

# Roadmap

What Tetravox does today, and what is still open. The contract is `docs/ARCHITECTURE.md`; every decision
behind a line here is in `docs/DECISIONS.md`.

## What exists

**Formats.** NIfTI-1/2 (`.nii`, `.nii.gz`, 4D, every dtype but complex and 64-bit ints), Gmsh `.msh` v2.2 and
v4.1 with `$NodeData`/`$ElementData` fields and `.msh.opt` sidecars, Gmsh parsed views (`.geo`/`.pos`, e.g.
SimNIBS electrode nets), GIfTI, FreeSurfer surfaces / `curv` / `annot`, STL, PLY, OBJ. LUT sidecars in
FreeSurfer, SimNIBS, ITK-SNAP and generic formats.

**Volumes.** Slice compositing with N layers per plane, the full `Scale` model (linear and heat with
min/mid/max, negative branch, `truncate`, `inverse`), thresholds with a soft edge, 15 colormaps plus
user-defined ones, label fill/outline/both over a dense-index palette, per-region show/hide/opacity/recolour,
4D frame stepping, and `showIn3D` slice planes in the 3D pane. A volume layer carries its own 3D isosurfaces,
one per visible region for a label volume.

**Meshes.** Tagged tissue surfaces, boundary extraction for tri-less tet meshes, node and element field
colouring with component selection, up to six clip planes with exact per-element caps and a drag gizmo,
element isolation (tags / field range / sphere / box / label volume), masked-barycentric element edges,
vector glyphs with four scaling modes, two-phase transparency, and mesh cross-sections in the 2D panes —
filled polygons and tissue-boundary contours that sweep with the slice, with or without a volume loaded.
Surfaces draw their intersection with each 2D plane as a Freeview-style contour by default.

**Views.** Linked 3D + sagittal/axial/coronal panes in four layouts, all containing the 3D pane; oblique
planes throughout; per-pane zoom about the pointer; Freeview-style mouse handling (left-click sets the
crosshair, never pans); ID picking; orientation letters, corner info, RAD/NEU badge, scale bar, orientation
cube, colour bars and crosshair as toggleable chrome; light and dark themes.

**Coordinates.** World RAS, per-volume voxel and FreeSurfer tkr-RAS, MNI through a SimNIBS `toMNI/` folder
(affine and nonlinear reported separately), surface vertex index, and an fsaverage vertex + coordinate when a
`sphere.reg` and an fsaverage subject are both on disk. Typed entry converts back in any of them.

**Tools.** A measurement tool (distance and angle in world mm, drawn in every pane that contains its points,
saved in the scene), a region panel for label volumes / mesh tags / annots, a histogram widget with draggable
window and threshold handles, and a screenshot dialog writing DPI into the PNG.

**Modules.** A first-party extension surface (§13): a docked panel slot in the right column with one active
module at a time, a toolbar switcher, a status cell, a key pool that resolves after the §7.5 map, a confirm
dialog, per-module scene blocks carried through save and load — including for modules a build does not have —
and an import wall that keeps a module to `ModuleHost`. The fixture module `tetravox.hello` (`?modules=hello`)
is the worked example; the sEEG contact editor is the first real one.

**Scenes.** `*.tetravox.json` — every layer setting, region edit, measurement, camera, layout and the theme.
⌘S / Save As / Open Recent, drop-to-open, file association, relative paths with a fingerprint-keyed relocate
dialog, and an optional reopen-on-launch.

**Automation.** `Tetravox --job job.json --out DIR` runs the app offscreen and executes `set` / `screenshot` /
`sweep` / `orbit` / `tween` actions into PNGs, GIFs and MP4s. A stdlib-only Python client wraps it.
See `docs/AUTOMATION.md`.

**Verification.** 235 Rust tests, 1,128 vitest tests, 66 Playwright specs and 40 goldens; analytic pixel
assertions on synthetic fixtures plus a pure-Python reference renderer for pane-scale slice diffs; real-data
tests against `sub-ernie` gated on `TETRAVOX_TESTDATA`. CI on `ubuntu-24.04` (the golden authority) and
macOS, with the packaging matrix carried in the workflow.

## What is next

**Correctness and coverage**
- §11's **Transparency (ii)** — a CPU per-fragment-sorted reference render of a mesh scene. The Python
  reference renderer covers volume slices only; §5 keeps a mesh's triangles out of a spec's reach, so this
  needs its own vehicle rather than a weaker test wearing the name.
- §9.1 rows 15, 16 and 17b have no measurement yet.

**Rendering**
- Transparency upgrade: **dual depth peeling preferred over WBOIT** — measured depth complexity is 4–6 median
  / 8–10 p90, so 6 peels covers p90, WebGL2 has core occlusion queries for adaptive early-out, and 6 × 413 k
  tris is inside the 8 ms budget. If WBOIT is kept as the > 8-layer fallback, its depth weight must be
  re-parameterised against scene bounds rather than copied from the paper.
- Progressive refinement: 8–16 jittered frames accumulated into RGBA16F while the camera is still (§7.0.7),
  shared by the screenshot path. This is also what unblocks the `msaa` quality knob.
- **Label minification AA.** Nearest-sampled label volumes drop thin structure when a screen pixel covers more
  than one voxel — 3 of 28 labels present in a view are never sampled at 1 mm/px. It affects `fill` and
  `outline` identically, so it is a **sampler** item, not an outline-formula one. Integer 3D textures cannot
  be mipmapped, so the options are (a) a 2×2 rotated-grid supersample of the centre label sample when
  `pxInVoxels > 1`, or (b) a worker-precomputed filterable coverage volume. **Prefer (a) first and measure.**
- Volume raycasting (MIP + composite with a transfer function) for 3D voxel rendering.
- Clip planes on isosurfaces — §7.2's iso draw disables clip distances today.
- `capDecimation` as a live quality knob: `plane_cut` must be able to emit fewer cap triangles.
- `mosaic` layout (`{plane, startMm, stepMm, rows, cols}`).

**Performance**
- `OpArgs['cut']` has no `wantEdges` / `wantBoundary`, so the worker builds and ships the 2D overlay's edge
  and boundary segments even on the 3D clip path, which discards both. Frozen interface — an additive change.
- Typed-array pooling, oct-encoded normals (85 → 57 MB for ernie's de-indexed variant), instanced points.

**Modules** (§13)
- The **sEEG contact editor**: BIDS `electrodes.tsv` in and out, intensity-weighted snap, shaft re-fit,
  renumbering, an editlog beside the table and a `.bak` of what it replaced.
- The engine substrate every later point-set tool inherits: per-point identity, ghosted off-plane discs, a
  selection ring, and a 2D point tool with place/select/drag.
- Main-process module IO: a read-text channel, a Save sheet that admits the manifest's same-directory
  siblings, a backup and a temp+rename write, and the first `BrowserWindow 'close'` guard.
- Job-file operations (`{"type":"module", …}`) and their Python wrappers, so every panel action is reachable
  headlessly.
- A **resizable right aside**. The column is 320 px and the slot lives in it; there is no splitter primitive
  in the shell, and a module with a long list wants one. A `wide` manifest hint was considered and dropped —
  widening the aside shrinks the toolbar's centre column below what its controls need, which wraps the row.
- **Stage 2, the runtime-loaded tier** (§13.8): a module Worker, a JSON-only host bridge, permissions with
  reasons, a Restricted Mode, a single-file library build and a security review. 8–9 days and a different
  threat model; the import wall exists so that day is a port, not a rewrite.
- An **engine command stack**, so undo is the engine's rather than each module keeping snapshots.
- A **Compute panel**: a module that shells out to an external tool with a streamed log. It needs the first
  async subprocess in main, argv validated token by token, a scrubbed environment and a notarisation check.

**Packaging**
- The §12.1 `package` legs green end to end: `.dmg` arm64 + x64, `.AppImage`, `.deb`, each opening
  `ernie.msh` and passing the artefact smoke test.
- macOS signing is a documented switch, not a plan; auto-update stays out of scope while unsigned.
