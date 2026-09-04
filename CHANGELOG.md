# Changelog

Notable changes to Tetravox. The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the versions are [semantic](https://semver.org/spec/v2.0.0.html).

`scripts/release.sh <version>` dates the section for a version and opens a fresh `[Unreleased]` one;
`docs/RELEASING.md` is the procedure around it.

## [Unreleased]

### Added

- **Extensions can write PDF figures.** An extension's figure channel accepted `.png` only, so a QC report
  that is naturally several pages — one electrode per page, say — had nowhere to go but a single tall
  raster. `.pdf` is now accepted alongside `.png`, under the same 32 MiB cap and the same rule about
  _where_ an extension may write: only paths its own Save sheet admitted. Nothing changes for an extension
  that writes PNGs.

## [0.3.5] - 2026-09-03

### Added

- **Extensions can export QC figures and BIDS derivatives.** An extension can now sample a volume along
  arbitrary paths (an oblique reslice, an intensity profile down a shaft), point the 3-D view at any anatomical
  preset (superior, left, anterior, …), take a PNG of a pane or of the whole view grid, write `.png` and `.svg`
  files, and declare where its output belongs with a `{derivatives}` target
  — so a report lands in `derivatives/<pipeline>/sub-<id>/…` beside the data it describes, with the folders
  created for it, rather than in whatever directory the Save sheet happened to open in. Nothing changes for an
  extension that does not use them, and the extensions you already have keep behaving exactly as they did.

- **The sEEG contact editor 0.2.0 is in the catalogue.** File ▸ Extensions… now offers tetravox-seeg 0.2.0: snapping
  that keeps every contact on the electrode's shaft, an electrode-model section with per-gap residuals, and QC figure
  exports (spacing histogram, per-electrode reslice, 3-D implant) written to `derivatives/tetravox/`. It needs this
  version of Tetravox or newer.

### Fixed

- **An extension could write a file with an extension you never agreed to.** Writing text went to a path a Save
  sheet had admitted, but nothing checked the _suffix_, so an extension holding a companion-file permission
  could put an executable next to the table you actually named. Text writes are now limited to
  `.tsv .csv .json .txt .fcsv .svg .html`, and pictures to `.png`.
- **The developer stand-in renderer pointed the camera the wrong way.** Windows launched with `?engine=mock`
  used a stale table for the six camera presets, so "superior" showed the view from the front. It now uses the
  same rotations the real renderer does. No shipped window was affected.

## [0.3.4] - 2026-09-02

### Changed

- **The 2-D panes zoom five times deeper.** R2's floor was 0.05 mm/px — about 25 mm across a 512 px
  pane, too coarse to work at the scale of a single object. It is now 0.01 mm/px, roughly 5 mm across
  the same pane, which is past the scale of one sEEG contact without letting a single CT voxel fill
  the view. The 20 mm/px ceiling is unchanged, and so is the **fit**: `r` still frames a volume at
  0.05 mm/px rather than filling the pane with a small one, because how a volume is framed by default
  is a separate question from how far it can then be zoomed into.

### Added

- **The sEEG extension offers 0.1.4 and 0.1.5.** 0.1.5 draws a guide while a contact is dragged — the
  electrode's fitted shaft axis as one unbroken line, with the 3-D centre-to-centre distance to each
  immediate neighbour beside it, so a contact can be aimed back onto the line it left. Its contact
  list now shows true 3-D neighbour spacing in place of the old plane-relative offset. 0.1.4 fits the
  pop-out window to the panel.

## [0.3.3] - 2026-08-31

### Added

- **Extension updates no longer wait for a Tetravox release.** The catalogue is refreshed from the
  curated index at launch and whenever **File ▸ Extensions…** opens, so a new version of an extension
  appears as **Update to X** on its own. Offline is unchanged: a failed refresh leaves the previous
  catalogue standing, and the copy the app ships is still the floor. A fetched index is validated
  strictly — every hash checked, and every download URL required to be HTTPS on a GitHub host.
- **Extensions pop out into their own windows, and several can be live at once.** The docked slot
  still holds one extension — it is one section of a 320 px column — but an extension whose manifest
  allows it can be moved into a window of its own, and the ones that are out stay live alongside it.
  Moving is never destructive: popping out, re-docking and closing the window all keep the instance,
  its history, its layers and its block, and docking a second extension pops the first out rather
  than closing it. Main's window-open handler is now a whitelist, and every popup is denied outright
  outside `'normal'` window mode, so a `--job` run can never raise a window on an unattended machine.
- **The sEEG extension offers 0.1.3**, whose panel pops out into its own window and reflows to two
  columns when it has the room.

## [0.3.2] - 2026-08-31

### Added

- **The extension slot folds.** A ▾ arrow beside the slot's ✕ hides the panel body and gives the
  column back to the Info panel, while the extension stays active — its layers, its table and its
  history are all still there, and the arrow puts the panel back.

### Changed

- **Nothing ships bundled any more — every extension is a download.** The sEEG contact editor is no
  longer packed inside the application and pre-consented at first launch; like every extension it is
  fetched once from **File ▸ Extensions…**, and nothing runs until the permission sheet is answered.
  The bundled tier is gone whole: `modules.lock`, the build-time fetch, the pre-consent seeding, the
  un-removable "Bundled" card. Consents you have already granted are unaffected; a job that names
  sEEG now needs it downloaded and enabled first.
- **One word: extension.** The product no longer says "module" anywhere a user or a document reads —
  the switcher, the keyboard sheet, the dialogs, every error message, the guide and the website all
  say _extension_. Machine surfaces keep their historical names (the job-file action
  `"type": "module"`, the manifest keys, `tetravox://module`, `~/.tetravox/modules/`,
  `@tetravox/module-sdk`, Python's `Job.module()`): they are wire and disk formats frozen against
  published extensions, saved scenes and existing job scripts.
- The catalogue offers **`tetravox.seeg` 0.1.2**, which marks the selected contact in its list and in
  its shaft sketch. It is a download like every other extension — the pin that used to bundle it went
  with the tier.

### Fixed

- The updater hardening reviewed after v0.3.1 was cut actually ships now (it had been committed but
  not pushed before the release): the notify-mode feed timeout covers the whole response, a launch
  check can no longer stomp an in-flight download, "skip this version" cannot dead-end the dialog,
  unsaved extension edits are asked about _before_ the installer runs on Windows/AppImage, and an
  oversized skip value can no longer reset `settings.json`.

## [0.3.1] - 2026-08-31

### Added

- **In-app updates** (ARCHITECTURE §12.4). A few seconds after launch the app asks the GitHub
  Releases feed whether a newer version exists — one small request, never a download — and says so
  with a notification and a status-bar pill. **File ▸ Check for Updates…** shows the release notes;
  updating is always the user's click: download with progress, then restart into the new version
  (or keep working — a downloaded update installs on the next quit). macOS, Windows and the Linux
  AppImage update in place; a `.deb`/`.tar.gz` install is offered the Releases page instead. The
  launch check has a Settings ▸ Startup toggle, any version can be skipped, and dev builds and
  `--job` runs never check. Releases now carry `latest-mac.yml` / `latest-linux.yml` / `latest.yml`
  feed files beside the installers, and the release workflow's verify gate requires the mac and
  linux ones.

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
