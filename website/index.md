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
label maps and atlases you can search, solo and recolour; vector-field glyphs; electrode and point sets;
and distance/angle measurements. World RAS, per-volume voxel indices, FreeSurfer tkr-RAS, MNI (through a
SimNIBS `toMNI/` folder) and fsaverage vertex indices are all read out together, at whatever point you click.
A rendering worker per dataset, written in Rust and compiled to WASM, keeps parsing and geometry off the UI
thread, so nothing heavy ever touches the interface.

It is built for people working with real imaging on disk: neuroimaging first — SimNIBS head models, a
simulated tES or TMS field checked against the anatomy it was computed on, an atlas compared with a
subject's own segmentation — and, with no change of tool, a CT of the chest or abdomen, a lumbar MRI, or the
organ and vertebra segmentations that come with them. It is not a general-purpose 3D modelling tool, and it
doesn't process or analyse data — it shows you exactly what's on disk, precisely and quickly.

![A T1 with an atlas overlay in the 2x2 layout, cortex isosurface in the 3D pane](/shots/hero/hero-t1-atlas-2x2.png)

<div class="motion-row">
  <figure>
    <video src="/shots/motion/orbit-head-translucent.mp4" autoplay loop muted playsinline></video>
    <figcaption>A head model orbiting, scalp and skull translucent over the brain.</figcaption>
  </figure>
  <figure>
    <video src="/shots/motion/sweep-coronal-abdomen-ct.mp4" autoplay loop muted playsinline></video>
    <figcaption>A coronal sweep through an abdominal CT with its organ labels.</figcaption>
  </figure>
  <figure>
    <video src="/shots/motion/clip-head-sagittal.mp4" autoplay loop muted playsinline></video>
    <figcaption>A sagittal clip plane driven through a tetrahedral mesh, capped per element.</figcaption>
  </figure>
</div>

## Not only heads

The viewer has no idea which part of the body it is showing. Window/level, label fill and outline,
isosurfaces, clip planes, measurements and the coordinate read-out behave identically on a brain MRI, a
chest CT and a lumbar spine.

<div class="modality-strip">
  <figure>
    <img src="/shots/modalities/mod-brain-t1-axial.png" alt="A brain T1 in a single axial pane" loading="lazy">
    <figcaption>Brain MRI — T1, single axial pane</figcaption>
  </figure>
  <figure>
    <img src="/shots/modalities/mod-head-ct-axial.png" alt="A head CT in a brain window" loading="lazy">
    <figcaption>Head CT — brain window</figcaption>
  </figure>
  <figure>
    <img src="/shots/modalities/mod-chest-ct-lung-2x2.png" alt="A chest CT in a lung window, 2x2 layout" loading="lazy">
    <figcaption>Chest CT — lung window</figcaption>
  </figure>
  <figure>
    <img src="/shots/modalities/mod-abdomen-ct-labels-axial.png" alt="An abdominal CT with organ labels outlined" loading="lazy">
    <figcaption>Abdominal CT — organ labels</figcaption>
  </figure>
  <figure>
    <img src="/shots/modalities/mod-spine-ct-labels-sagittal.png" alt="A spine CT with per-vertebra labels, sagittal" loading="lazy">
    <figcaption>Spine CT — per-vertebra labels</figcaption>
  </figure>
  <figure>
    <img src="/shots/modalities/mod-spine-mri-labels-sagittal.png" alt="A lumbar MRI with disc, vertebra and cord labels" loading="lazy">
    <figcaption>Spine MRI — discs, vertebrae, cord</figcaption>
  </figure>
</div>

Every one of these, with the dataset it came from, is in the [Gallery](/gallery); the pairs and their zoomed
details are laid out on the [Showcase](/showcase) page.

## What it does

- **One crosshair, every pane** — a 3D view beside sagittal/axial/coronal slices, in layouts from a single
  pane to 1-plus-3, all following one point in space.
- **Volumes** — independent colour maps, window/level, thresholds with a soft edge, histogram presets, 4D
  frames, and isosurfaces straight from a layer.
- **Label maps** — atlases, tissue segmentations and organ/vertebra labels as fill, outline or both, with a
  searchable region panel that hides, solos and recolours, saved with the scene.
- **Meshes** — tissue surfaces from tags, node/element field colouring, up to six clip planes with exact
  per-element caps, element isolation, and a real cross-section in the 2D panes.
- **Fields** — a simulated field — tES (TI, tDCS, tACS) or TMS — on a volume or a mesh, thresholded over the
  anatomy, plus vector glyphs with labelled length scaling.
- **Coordinates & measurements** — world RAS, voxel, tkr-RAS, MNI (affine and nonlinear), surface and
  fsaverage vertices, and distances/angles in world millimetres.

## Who it is for

Anyone who has a volume and a mesh that are supposed to agree about where things are, and needs to see
whether they do: SimNIBS and neurostimulation users, imaging researchers checking a segmentation against
the scan it came from, and anyone who would rather look at a NIfTI next to a tetrahedral mesh than at two
windows.

## Getting started

Download the artefact for your platform from the
[releases page](https://github.com/idossha/tetravox/releases) — a `.dmg` on macOS, an `.AppImage` or `.deb`
on Linux. macOS needs the quarantine attribute cleared once, because the app is unsigned:

```sh
xattr -dr com.apple.quarantine /Applications/Tetravox.app
```

Then drag files onto the window, press **⌘O / Ctrl+O**, or name them on the command line
(`Tetravox T1.nii.gz ernie.msh`). Opening data **adds** it to what's already on screen; opening a saved
scene (`*.tetravox.json`) **replaces** the scene.

Install details, the Linux `chrome-sandbox` note and the dev build are on the [Get started](/get-started)
page; the interface, the keyboard map and every control are in the [Guide](/guide/opening-data).
