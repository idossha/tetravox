<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/logo-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/media/logo.png">
    <img src="docs/media/logo.png" alt="Tetravox" width="360">
  </picture>
</p>

<p align="center"><b>A fast desktop viewer for medical volumes and meshes — MRI, CT, segmentations, simulation meshes.</b></p>

<p align="center">
  <a href="https://github.com/idossha/tetravox/releases/latest"><img src="https://img.shields.io/github/v/release/idossha/tetravox?style=flat" alt="Latest release"></a>
  <a href="https://github.com/idossha/tetravox/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/idossha/tetravox/ci.yml?branch=main&label=CI&style=flat" alt="CI status"></a>
  <a href="https://idossha.github.io/tetravox/"><img src="https://img.shields.io/badge/docs-website-blue?style=flat" alt="Documentation"></a>
  <img src="https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-lightgrey?style=flat" alt="Platforms: macOS, Linux, Windows">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat" alt="License: MIT"></a>
</p>

---

Tetravox opens NIfTI volumes and Gmsh, GIfTI, FreeSurfer, STL, PLY and OBJ meshes side by side: a 3D view
linked to sagittal, axial and coronal slices, so a click in any pane moves the cursor everywhere else. It
reads MRI and CT, label maps and atlases, cortical surfaces and tetrahedral simulation meshes, and renders
them with its own Rust-and-WebGL2 engine, so large meshes and 4D volumes stay responsive. Everything heavy
happens off the interface thread, one worker per dataset, and opening a new file never freezes the window
you are already looking at.

![A T1 in the 2x2 layout with both pial surfaces: contours on the slices, the hemispheres in the 3D pane](docs/screenshots/2026-08-29/brain/brain-t1-pial-both.png)

It was built for neuroimaging first — segmented head models, atlases, and simulated tES or TMS fields
checked against the anatomy they were computed on — but nothing in it is head-specific. A chest CT with
organ labels or a lumbar MRI with per-vertebra segmentations opens exactly the same way, with the same
window and level, the same label fill and outline, the same isosurfaces, clip planes, measurements and
coordinate read-out.

<p align="center">
  <img src="docs/screenshots/2026-08-29/hero/hero-abdomen-ct-2x2.png" width="46%"
       alt="An abdominal CT with organ labels and organ isosurfaces">
  <img src="docs/screenshots/2026-08-29/hero/hero-spine-ct-2x2.png" width="46%"
       alt="A chest CT with per-vertebra labels and vertebra isosurfaces">
</p>

The same engine runs headlessly: a job file, or four lines of Python, renders screenshots, slice sweeps,
orbits and animated parameters exactly as the window would, which is how every picture on the website was
made.

![Per-vertebra isosurfaces from a labelled spine CT, orbiting](docs/screenshots/2026-08-29/motion/orbit-spine-vertebrae.gif)

Official builds for macOS (signed and notarised), Linux and Windows are on the
[releases page](https://github.com/idossha/tetravox/releases/latest). Everything else — installing, a
tour of the window, the guide to every control, the automation reference, the gallery, and the
architecture and release process for contributors — lives on the website at
**[idossha.github.io/tetravox](https://idossha.github.io/tetravox/)**.

Tetravox is MIT licensed. Contributions are welcome; start with [`CONTRIBUTING.md`](CONTRIBUTING.md).
