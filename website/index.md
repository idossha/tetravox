---
layout: home

hero:
  name: Tetravox
  text: A desktop viewer for voxel volumes and meshes
  tagline: One linked 3D view beside sagittal, axial and coronal slices — a custom WebGL2 engine, and Rust/WASM parsing that never blocks the UI thread.
  image:
    src: /shots/layout-1plus3.png
    alt: A head mesh in 3D beside three linked slices, in the 1+3 layout
  actions:
    - theme: brand
      text: Get started
      link: /get-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/idossha/tetravox

features:
  - icon: 🧊
    title: Volumes and meshes, one engine
    details: N composited volume layers per plane with linear/heat scales and thresholds, plus tissue surfaces, node/element field colouring, up to six exact clip planes, and vector glyphs — all in the same WebGL2 context.
  - icon: 📍
    title: Coordinates that all agree
    details: World RAS, per-volume voxel and FreeSurfer tkr-RAS, MNI through a SimNIBS toMNI/ folder, surface vertex index, and fsaverage — read out together, everywhere you click.
  - icon: 🐍
    title: Scriptable, not just clickable
    details: The same engine renders offscreen with no window and no stolen focus, driven by a small Python client or a job file — screenshots, slice sweeps and turntables, at any resolution and DPI.
  - icon: 🦀
    title: Rust + WASM, off the UI thread
    details: Parsing and geometry are pure Rust, compiled to WASM and run one worker per dataset, so nothing heavy ever touches the interface.
  - icon: 🗂️
    title: Scenes remember everything
    details: '*.tetravox.json captures every layer setting, region edit, measurement, camera and theme, with relative paths and a relocate dialog when the data has moved.'
  - icon: 🖥️
    title: macOS and Linux
    details: 235 Rust tests, 1,128 vitest tests and 66 Playwright specs with 40 goldens back a viewer built for real SimNIBS subjects, not toy data.
---
