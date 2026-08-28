---
layout: home
title: Home
permalink: /
nav_order: 1
---

<section class="hero">
  <h1 class="hero__title">Tetravox</h1>
  <p class="hero__tagline">
    A desktop viewer for voxel volumes (NIfTI) and finite-element / surface meshes (Gmsh <code>.msh</code>,
    GIfTI, FreeSurfer, STL/PLY/OBJ) — one linked 3D view beside sagittal, axial and coronal slices, a
    custom WebGL2 engine, and Rust/WASM parsing that never blocks the UI thread.
  </p>
  <a class="hero__cta" href="{{ site.baseurl }}/install.html">Install &amp; run →</a>
</section>

<div class="hero__media">
  <img src="{{ site.baseurl }}/screenshots/directed-2026-08-28/layout-1plus3.png"
       alt="A head mesh in 3D beside three linked slices, in the 1+3 layout">
  <p class="hero__caption">The 1+3 layout: a head mesh in 3D beside three linked slices, on the real
    <code>sub-ernie</code> SimNIBS dataset.</p>
</div>

<div class="hero__media">
  <img src="{{ site.baseurl }}/media/showcase-preview.gif" alt="Tetravox showcase — a tour of the interface and rendering features">
  <p class="hero__caption">The showcase film, rendered offscreen by the app itself
    (<a href="{{ site.baseurl }}/AUTOMATION.html">see how</a>).</p>
</div>

<div class="feature-grid">
  <div class="feature-card">
    <h3>Volumes and meshes, one engine</h3>
    <p>N composited volume layers per plane with linear/heat scales and thresholds, plus tissue surfaces,
      node/element field colouring, up to six exact clip planes, and vector glyphs — all in the same
      WebGL2 context.</p>
  </div>
  <div class="feature-card">
    <h3>Coordinates that all agree</h3>
    <p>World RAS, per-volume voxel and FreeSurfer tkr-RAS, MNI through a SimNIBS <code>toMNI/</code> folder,
      surface vertex index, and fsaverage — read out together, everywhere you click.</p>
  </div>
  <div class="feature-card">
    <h3>Scriptable, not just clickable</h3>
    <p>The same engine renders offscreen with no window and no stolen focus, driven by a small Python
      client or a job file — screenshots, slice sweeps and turntables, at any resolution and DPI.</p>
  </div>
</div>

<div class="home-links">
  <a href="{{ site.baseurl }}/install.html">Install &amp; Run</a>
  <a href="{{ site.baseurl }}/USER_GUIDE.html">User Guide</a>
  <a href="{{ site.baseurl }}/AUTOMATION.html">Automation &amp; Python</a>
  <a href="{{ site.baseurl }}/gallery.html">Gallery</a>
  <a href="{{ site.baseurl }}/TESTING.html">Testing</a>
  <a href="{{ site.baseurl }}/ARCHITECTURE.html">Architecture</a>
  <a href="{{ site.baseurl }}/DECISIONS.html">Decisions</a>
  <a href="{{ site.baseurl }}/ROADMAP.html">Roadmap</a>
  <a href="{{ site.baseurl }}/BENCHMARKS.html">Benchmarks</a>
</div>
