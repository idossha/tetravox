# Changelog

Notable changes to Tetravox. The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the versions are [semantic](https://semver.org/spec/v2.0.0.html).

`scripts/release.sh <version>` dates the section for a version and opens a fresh `[Unreleased]` one;
`docs/RELEASING.md` is the procedure around it.

## [Unreleased]

### Added

- **In-app updates** (ARCHITECTURE §12.4). A few seconds after launch the app asks the GitHub
  Releases feed whether a newer version exists — one small request, never a download — and says so
  with a notification and a status-bar pill. **File ▸ Check for Updates…** shows the release notes;
  updating is always the user's click: download with progress, then restart into the new version
  (or keep working — a downloaded update installs on the next quit). macOS, Windows and the Linux
  AppImage update in place; a `.deb`/`.tar.gz` install is offered the Releases page instead. The
  launch check has a Settings ▸ Startup toggle, any version can be skipped, and dev/unsigned builds
  and `--job` runs never check. Releases now carry `latest-mac.yml` / `latest-linux.yml` /
  `latest.yml` feed files beside the installers, and the release workflow's verify gate requires
  them.

## [0.3.0] - 2026-08-31

A first-party **extension surface** and its flagship, plus downloadable extensions.

### Added — extensions

- **Modules (ARCHITECTURE §13).** A first-party extension surface: data-only manifests, a frozen
  `ModuleHost` API behind an ESLint import wall (a module never touches `Engine`, the store or the
  preload bridge), a docked module panel with a toolbar switcher, module keys resolved after the core
  keymap, a promise-based confirm dialog, per-module scene-state carried through save/load, and a
  `docs-guard` CI job. A `tetravox.hello` fixture module ships behind `?modules=hello`.
- **Downloadable extensions.** A **File ▸ Extensions…** catalogue (Download → per-module consent
  sheet → Enable, with Update and Remove), a `tetravox://module` host that serves an installed module
  from an in-memory, sha256-verified map, an install store under `~/.tetravox/modules/`, a registry
  index (`idossha/tetravox-extensions`), a versioned `@tetravox/module-sdk` (types + an inlined
  runtime shim), and `modules.lock` so pinned modules ship inside the packaged app pre-consented. The
  toolbar dropdown stays the enabled-module load/unload switcher.
- **sEEG contact editor** (`tetravox.seeg`, a bundled extension in
  [idossha/tetravox-seeg](https://github.com/idossha/tetravox-seeg)). Localise and hand-correct
  stereo-EEG depth-electrode contacts on a registered CT and write a corrected BIDS `electrodes.tsv`
  back: a tolerant reader, one contacts layer (named dots, per-electrode colours, coloured shaft
  lines, off-plane ghosting), place / select / drag / snap-to-metal / re-fit / renumber / flip-tip,
  a wire toggle and a size control, undo/redo, and a save that writes the table plus a timestamped
  `.bak` and a seegprep-compatible `_electrodes_editlog.json`. Every panel action is also a job-file
  operation, with Python wrappers.

### Added — engine

- **A points editing substrate.** Per-point identity, grouping and ordinal on a points layer;
  off-plane ghosting (a contact stays visible as you scroll, and a ghosted point is clickable —
  clicking it selects it and jumps the slice); per-point / per-electrode label and line colours; a
  screen-pixel dot size; a `LayerBase.module` owner tag.
- **An engine-owned 2D point tool** — place, select and drag contacts, with one commit per drag, an
  `Esc` grammar, and mutual exclusivity with measure mode.
- **A voxel-neighbourhood read** (`sampleVoxelBox` / `peakCentroid`) for intensity-weighted
  snap-to-metal, matching 3D Slicer's window.

### Added — app

- **The first unsaved-changes guard.** New / Open / Open-Recent / drop / close-dataset and window
  close now prompt before discarding a module's unsaved edits; the module IPC admits a Save sheet's
  declared sibling files and writes a `.bak` atomically.
- **Module job actions** in the automation surface, validated from the manifests before a window
  exists, with an AUTOMATION reference generated from them.

### Fixed

- A volume's 3D isosurfaces follow the layer's opacity slider and each region's per-region opacity;
  a translucent isosurface blends instead of switching; an isosurface adds no empty probe row.
- `⌘S` on a scene opened from disk now saves it in place.

### Security

- The extension consent sheet states every capability a module's manifest grants (reads, writes and
  their declared siblings, keys, job operations, scene storage); a module cannot widen its writes past
  what its consent showed, cannot forge its own consent record, and loses its file-write and serving
  capability the moment it is disabled or removed.

## [0.2.0] - 2026-08-28

The first release with artefacts. 0.1.0 was the scaffold; this is the version you can download.

### Added — packaging and release

- **Cross-platform artefacts.** macOS `.dmg` and `.zip` for **arm64 and x64**, Linux `.AppImage`,
  `.deb` and `.tar.gz` for x64, and a Windows `.exe` NSIS installer for x64. One naming scheme
  everywhere: `Tetravox-<version>-<os>-<arch>.<ext>`.
- **File associations on all three platforms** for `.nii`, `.nii.gz`, `.msh`, `.gii`, `.geo`, `.pos`
  and `.tetravox.json`. `.geo` registers as `rank: Default`, not `Owner` — the extension is shared
  with Gmsh's geometry-script language, which Tetravox does not open.
- **`.github/workflows/release.yml`** — a `v*` tag builds the whole matrix on four runners, runs an
  artefact smoke test on each, and uploads to a **draft** GitHub Release with generated notes.
- **An artefact smoke test** (`scripts/smoke-artefact.mjs`), which is what ARCHITECTURE.md §12.1 asks
  of every `package` leg: launch the _packaged_ binary with `--job` on a committed synthetic fixture
  and assert `job-result.json` is `ok` with a real PNG on disk. macOS and Linux run it; Windows runs
  launch-and-exit.
- **`scripts/package-linux.sh`** — Linux artefacts from a macOS host, via Docker, with the AppImage
  smoke-tested under Xvfb in the container.
- **`scripts/release.sh`** — one command that bumps all five `package.json`s and
  `[workspace.package]` in `Cargo.toml`, dates the CHANGELOG, commits and tags. It never pushes.
- **`docs/RELEASING.md`** — cutting a release, the notarisation switch, what CI does, and how to
  smoke-test locally.
- `ci.yml`'s `package` legs are real builds now instead of `exit 1` placeholders (ROADMAP Phase 3).

### Capabilities in this release

Carried over from `docs/ROADMAP.md`; 0.2.0 is the first version in which they are downloadable.

- **Formats** — NIfTI-1/2 (`.nii`, `.nii.gz`, 4D, every dtype but complex and 64-bit ints), Gmsh
  `.msh` v2.2 and v4.1 with `$NodeData`/`$ElementData` and `.msh.opt` sidecars, Gmsh parsed views
  (`.geo`/`.pos`), GIfTI, FreeSurfer surfaces / `curv` / `annot`, STL, PLY, OBJ, and LUT sidecars in
  FreeSurfer, SimNIBS, ITK-SNAP and generic formats.
- **Volumes** — N-layer slice compositing, the full `Scale` model (linear and heat, negative branch,
  `truncate`, `inverse`), soft-edged thresholds, 15 colormaps plus user-defined ones, label
  fill/outline/both with per-region show/hide/opacity/recolour, 4D frame stepping, `showIn3D` slice
  planes, and per-region isosurfaces.
- **Meshes** — tagged tissue surfaces, boundary extraction for tri-less tet meshes, node and element
  field colouring with component selection, six clip planes with exact per-element caps and a drag
  gizmo, element isolation by tag / field range / sphere / box / label volume, masked-barycentric
  element edges, vector glyphs with four scaling modes, two-phase transparency, and mesh
  cross-sections in the 2D panes.
- **Views** — linked 3D + sagittal/axial/coronal panes in four layouts, oblique planes, per-pane zoom
  about the pointer, Freeview-style mouse handling, ID picking, orientation letters, corner info,
  RAD/NEU badge, scale bar, orientation cube, colour bars, and light and dark themes.
- **Coordinates** — world RAS, per-volume voxel and FreeSurfer tkr-RAS, MNI through a SimNIBS `toMNI/`
  folder (affine and nonlinear reported separately), surface vertex index, and an fsaverage vertex
  and coordinate when a `sphere.reg` and an fsaverage subject are both present.
- **Tools** — a distance/angle measurement tool saved in the scene, a region panel for label volumes,
  mesh tags and annots, a histogram widget with draggable window and threshold handles, and a
  screenshot dialog that writes DPI into the PNG.
- **Scenes** — `*.tetravox.json` carrying every layer setting, region edit, measurement, camera,
  layout and the theme, with ⌘S / Save As / Open Recent, drop-to-open, relative paths with a
  fingerprint-keyed relocate dialog, and an optional reopen-on-launch.
- **Automation** — `Tetravox --job job.json --out DIR` runs the app offscreen and executes
  `set` / `screenshot` / `sweep` / `orbit` / `tween` actions into PNGs, GIFs and MP4s, with a
  stdlib-only Python client. See `docs/AUTOMATION.md`.
- **Verification** — 235 Rust tests, 1,128 vitest tests, 66 Playwright specs and 40 goldens, with
  analytic pixel assertions on synthetic fixtures and a pure-Python reference renderer for pane-scale
  slice diffs.

### Known limitations

- **Every artefact is unsigned.** macOS Gatekeeper refuses the first launch until
  `xattr -dr com.apple.quarantine`; Windows SmartScreen warns. Signing and notarisation are a
  documented switch (`docs/RELEASING.md` §4), and auto-update is out of scope while unsigned.
- **Linux and Windows are x64 only.** Linux arm64 is a one-line matrix addition once a runner is
  worth the minutes; Windows arm64 is not planned.
- **The AppImage needs `--no-sandbox`** unless `chrome-sandbox` is made root-owned setuid.
- **On Linux, the compound extensions `.nii.gz` and `*.tetravox.json` get no MIME association.**
  electron-builder skips dotted extensions on that platform; the simple ones (`.nii`, `.msh`, `.gii`,
  `.geo`, `.pos`) register normally, and a compound one still opens from the command line and from
  _Open With_. macOS and Windows associate all seven. `docs/RELEASING.md` §1 has the fix.

## [0.1.0]

The scaffold: the engine, the parsers, the shell, the test suites and CI. Not released as artefacts.
