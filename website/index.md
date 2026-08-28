---
title: Tetravox
---

# Tetravox

Tetravox is a desktop viewer for voxel volumes and meshes. It opens NIfTI volumes (`.nii`, `.nii.gz`,
including 4D series), Gmsh finite-element meshes (`.msh` v2.2 and v4.1) and parsed Gmsh views (`.geo` /
`.pos` — SimNIBS electrode nets), GIfTI surfaces (`.gii`, `.func.gii`, `.shape.gii`, `.label.gii`),
FreeSurfer surfaces with their `curv` data and `.annot` labels, and STL/PLY/OBJ meshes — all in one linked
scene, not one file type at a time.

Everything on screen shares a single crosshair. A 3D view sits beside sagittal, axial and coronal slices,
and moving the crosshair in any pane moves it everywhere: volume layers with independent colour maps,
thresholds and window/level; mesh tissue surfaces with field colouring, clip planes and element isolation;
atlas and tissue regions you can search, solo and recolour; vector-field glyphs; electrode and point sets;
and distance/angle measurements. World RAS, per-volume voxel indices, FreeSurfer tkr-RAS, MNI (through a
SimNIBS `toMNI/` folder) and fsaverage vertex indices are all read out together, at whatever point you click.
A rendering worker per dataset, written in Rust and compiled to WASM, keeps parsing and geometry off the UI
thread, so nothing heavy ever touches the interface.

Tetravox is built for people working with real head models and neuroimaging data — SimNIBS users checking a
TI-field simulation, researchers comparing an atlas against a subject's own segmentation, anyone who needs to
look at a NIfTI volume next to a tetrahedral mesh and trust that the two agree on where things are. It is not
a general-purpose 3D modelling tool, and it doesn't process or analyse data — it shows you exactly what's on
disk, precisely and quickly.

![The 1+3 layout: a T1 volume in three orthogonal slices plus 3D, in the 2x2 grid](/shots/overview-1x2x2.png)

## Getting started

**Download.** Grab the artefact for your platform from the
[releases page](https://github.com/idossha/tetravox/releases) — a `.dmg` on macOS, an `.AppImage` or `.deb`
on Linux — or build one yourself with `pnpm package`. There is no Windows build.

**macOS — the app is unsigned.** Gatekeeper will refuse to open it, with "Tetravox is damaged and can't be
opened." It isn't damaged; that's the message macOS gives any unsigned app downloaded from the internet.
Clear the quarantine attribute once, from a terminal:

```sh
xattr -dr com.apple.quarantine /Applications/Tetravox.app
```

**Linux.** The AppImage needs a correctly-owned `chrome-sandbox`, or run it with `--no-sandbox`. If the
status bar reports a software renderer, the GPU was blocklisted — Tetravox still runs, just slowly, and says
so rather than pretending otherwise.

**Opening files.** Drag files onto the window, press **⌘O / Ctrl+O**, use File ▸ Open…, or name them on the
command line (`Tetravox T1.nii.gz ernie.msh`). Opening data **adds** it to what's already on screen; opening
a saved scene (`*.tetravox.json`) **replaces** the scene.

**A first look.** The window is three areas: the view grid in the centre (2D panes plus a 3D pane, in a
layout you cycle with `x`), a left panel listing your layers (volumes, meshes, points, isosurfaces) each with
its own editor, and a right panel for regions and measurements. A coordinate bar and an info panel along the
top report exactly what's under the crosshair and the pointer, in every coordinate space available for that
data.

**Keyboard basics.** `r` resets the active view, `1`–`6` snap the 3D camera to a face, `x` cycles the pane
layout, `[` / `]` cycle the active layer and `v` toggles its visibility, `m` starts a measurement. The
toolbar's **?** button lists every binding, and the full table lives in
[Keyboard shortcuts](/guide/keyboard-shortcuts).

Full install and dev-build details are on the [Get started](/get-started) page; the rest of the interface is
covered in the [Guide](/guide/opening-data).
