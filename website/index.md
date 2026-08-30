---
title: Tetravox
---

# Tetravox

A fast desktop viewer for medical volumes and meshes — MRI, CT, segmentations, simulation meshes.

Tetravox reads all the major voxel and mesh formats and renders them with its own Rust-and-WebGL2 engine, so
large tetrahedral meshes and 4D volumes open instantly. It was built for neuroimaging first — segmented head
models, atlases, and simulated tES or TMS fields checked against the anatomy they were computed on — but
nothing in it is head-specific: a chest CT with organ labels opens exactly the same way.

## Key features

- **One crosshair, every pane** — a 3D view beside sagittal, axial and coronal slices; move the crosshair
  anywhere and every pane follows.
- **Volumes** — colour maps, window/level, thresholds, 4D frames and isosurfaces, per layer.
- **Label maps** — atlases and segmentations as fill or outline, with a searchable region panel to hide,
  solo and recolour.
- **Meshes** — tissue surfaces from tags, field colouring, clip planes with exact caps, element isolation,
  and a true cross-section in the 2D panes.
- **Fields** — simulated tES/TMS fields on a volume or a mesh, thresholded over the anatomy, plus vector
  glyphs.
- **Coordinates & measurements** — world RAS, voxel, tkr-RAS, MNI and surface vertices read out together;
  distances and angles in millimetres.
- **Scenes & automation** — save the whole view as a JSON scene, reproduce it from the command line or
  Python.

## Get started

Download the build for your platform from the
[releases page](https://github.com/idossha/tetravox/releases/latest) — see [Install](/install) — then drag
files onto the window, press **⌘O / Ctrl+O**, or name them on the command line (`Tetravox T1.nii.gz
ernie.msh`). [Get started](/get-started) walks through the window; the supported formats and every control
are in the [Guide](/guide/opening-data).

Tetravox is MIT licensed. Contributions are welcome — start with
[Contributing](/developers/contributing).
