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

Tetravox is an advanced high-performance medical viewer that can handle both voxelized volumes and finite-element meshes. It reads MRI and CT, label maps and atlases, cortical surfaces and tetrahedral meshes, and renders them with its own Rust-and-WebGL2 engine, so large meshes and 4D volumees renders instantenously.

It was built for neuroimaging first — segmented head models, atlases, and simulated tES or TMS fields
checked against the anatomy they were computed on — but nothing in it is head-specific. A chest CT with
organ labels or a lumbar MRI with per-vertebra segmentations opens exactly the same way.

**[idossha.github.io/tetravox](https://idossha.github.io/tetravox/)**.

Tetravox is MIT licensed. 

Contributions are welcome; start with [`CONTRIBUTING.md`](CONTRIBUTING.md).
