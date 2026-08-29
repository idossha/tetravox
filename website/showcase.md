---
title: Showcase
---

# Showcase

A 108.7-second tour of the interface and the rendering engine, over the real `sub-ernie` SimNIBS
dataset. Neither the video nor the GIF is hand-edited: [`examples/capture/showcase.py`](https://github.com/idossha/tetravox/blob/main/examples/capture/showcase.py)
writes six job documents, the app renders every frame offscreen through the same `Engine` calls a
user makes with the mouse (see [Automation & Python](/automation)), and ffmpeg joins them and burns
the captions. The full storyboard — shot list, timings and the reasoning behind each — is in
[`docs/media/SHOWCASE.md`](https://github.com/idossha/tetravox/blob/main/docs/media/SHOWCASE.md).

<video controls preload="metadata" poster="/shots/hero/hero-t1-atlas-2x2.png">
  <source src="/media/showcase.mp4" type="video/mp4">
  Your browser does not support the video tag — see the GIF below instead.
</video>

## GIF

For anywhere a `<video>` tag doesn't reach:

![Tetravox showcase — a tour of the interface and rendering features](/media/showcase-preview.gif)

## Beyond the head

The film is a head model because that is what Tetravox was built for first. Nothing in the viewer is
head-specific: below is the same build, the same controls and the same job runner on public CT and MRI of
the chest, abdomen, spine and pelvis. Each row is an overview and the detail you get by zooming into it —
zoom is per pane, in millimetres per pixel, so a detail view is the same data, not a resampled thumbnail.
The datasets and their licences are listed in
[`docs/screenshots/2026-08-29/DATASETS.md`](https://github.com/idossha/tetravox/blob/main/docs/screenshots/2026-08-29/DATASETS.md).

### Brain MRI

<div class="shot-pair">
  <figure>
    <img src="/shots/modalities/mod-brain-t1-axial.png" alt="A T1 in a single axial pane" loading="lazy">
    <figcaption>A T1 filling one axial pane — the starting point for everything else.</figcaption>
  </figure>
  <figure>
    <img src="/shots/modalities/mod-brain-t1-axial-zoom.png" alt="The same axial slice zoomed onto the hippocampus with a scale bar" loading="lazy">
    <figcaption>The same slice at 0.12 mm/px on the hippocampus, scale bar on.</figcaption>
  </figure>
</div>

![A T2 coronal slice — the subject's second contrast](/shots/modalities/mod-brain-t2-coronal.png)

### Head CT

<div class="shot-pair">
  <figure>
    <img src="/shots/modalities/mod-head-ct-axial.png" alt="A head CT in a brain window" loading="lazy">
    <figcaption>Brain window: the window/level presets are the same control an MRI uses.</figcaption>
  </figure>
  <figure>
    <img src="/shots/modalities/mod-head-ct-bone-3d.png" alt="A head CT in a bone window drawn as 3D planes" loading="lazy">
    <figcaption>Bone window, the three planes drawn in the 3D pane.</figcaption>
  </figure>
</div>

### Chest CT

<div class="shot-pair">
  <figure>
    <img src="/shots/modalities/mod-chest-ct-lung-2x2.png" alt="A chest CT in a lung window, 2x2 layout" loading="lazy">
    <figcaption>Lung window across all four panes.</figcaption>
  </figure>
  <figure>
    <img src="/shots/modalities/mod-chest-ct-lung-zoom.png" alt="The lung bases, zoomed" loading="lazy">
    <figcaption>Zoomed on the lung bases.</figcaption>
  </figure>
</div>

### Abdominal CT and MRI

<div class="shot-pair">
  <figure>
    <img src="/shots/modalities/mod-abdomen-ct-soft-axial.png" alt="An abdominal CT in a soft-tissue window" loading="lazy">
    <figcaption>AMOS22 CT, soft-tissue window.</figcaption>
  </figure>
  <figure>
    <img src="/shots/modalities/mod-abdomen-ct-labels-axial.png" alt="The same slice with organ labels outlined" loading="lazy">
    <figcaption>The organ segmentation drawn as outlines over it.</figcaption>
  </figure>
  <figure>
    <img src="/shots/modalities/mod-abdomen-ct-labels-3d.png" alt="Organ labels as isosurfaces in the 3D pane" loading="lazy">
    <figcaption>The same labels as isosurfaces, one per region, in each region's colour.</figcaption>
  </figure>
  <figure>
    <img src="/shots/modalities/mod-abdomen-mri-t1-coronal.png" alt="An abdominal T1-weighted MRI, coronal" loading="lazy">
    <figcaption>AMOS22 MRI, T1-weighted coronal.</figcaption>
  </figure>
  <figure>
    <img src="/shots/modalities/mod-abdomen-mri-labels-2x2.png" alt="The abdominal MRI with its labels filled, 2x2" loading="lazy">
    <figcaption>Its labels filled, across the four panes.</figcaption>
  </figure>
</div>

### Spine, CT and MRI

<div class="shot-pair">
  <figure>
    <img src="/shots/modalities/mod-spine-ct-sagittal.png" alt="A spine CT in a bone window, sagittal" loading="lazy">
    <figcaption>CTSpine1K, bone window.</figcaption>
  </figure>
  <figure>
    <img src="/shots/modalities/mod-spine-ct-labels-sagittal.png" alt="The same sagittal slice with per-vertebra labels" loading="lazy">
    <figcaption>Per-vertebra labels — each one its own row in the region panel.</figcaption>
  </figure>
  <figure>
    <img src="/shots/modalities/mod-spine-ct-labels-3d.png" alt="Vertebra labels as isosurfaces" loading="lazy">
    <figcaption>The vertebrae as isosurfaces, viewed from the left.</figcaption>
  </figure>
  <figure>
    <img src="/shots/modalities/mod-spine-mri-sagittal.png" alt="A lumbar MRI, sagittal" loading="lazy">
    <figcaption>TotalSegmentator-MR lumbar spine.</figcaption>
  </figure>
  <figure>
    <img src="/shots/modalities/mod-spine-mri-labels-sagittal.png" alt="The lumbar MRI with disc, vertebra and cord labels" loading="lazy">
    <figcaption>Discs, vertebrae and cord, labelled.</figcaption>
  </figure>
  <figure>
    <img src="/shots/modalities/mod-pelvis-mri-labels-3d.png" alt="Pelvis structures as isosurfaces" loading="lazy">
    <figcaption>Pelvic structures as isosurfaces.</figcaption>
  </figure>
</div>

### Whole body

![A whole-body GRE MRI in a coronal pane with labels](/shots/modalities/mod-wholebody-mri-coronal.png)

## In motion

<div class="motion-row">
  <figure>
    <video src="/shots/motion/orbit-spine-vertebrae.mp4" autoplay loop muted playsinline></video>
    <figcaption>Vertebra isosurfaces orbiting over the CT's sagittal plane.</figcaption>
  </figure>
  <figure>
    <video src="/shots/motion/orbit-abdomen-organs.mp4" autoplay loop muted playsinline></video>
    <figcaption>Abdominal organ isosurfaces.</figcaption>
  </figure>
  <figure>
    <video src="/shots/motion/sweep-axial-t1-atlas.mp4" autoplay loop muted playsinline></video>
    <figcaption>An axial sweep, inferior to superior, with the atlas outlined.</figcaption>
  </figure>
  <figure>
    <video src="/shots/motion/zoom-axial-detail.mp4" autoplay loop muted playsinline></video>
    <figcaption>Zooming one axial pane from overview into detail.</figcaption>
  </figure>
  <figure>
    <video src="/shots/motion/field-threshold-rise.mp4" autoplay loop muted playsinline></video>
    <figcaption>A simulated field's threshold rising from p50 to p97 over the anatomy.</figcaption>
  </figure>
  <figure>
    <video src="/shots/motion/clip-head-sagittal.mp4" autoplay loop muted playsinline></video>
    <figcaption>A sagittal clip plane through a tetrahedral mesh, capped per element.</figcaption>
  </figure>
</div>

Every plate, with what it shows and which dataset it came from, is in the [Gallery](/gallery).
