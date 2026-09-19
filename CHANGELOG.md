# Changelog

Notable changes to Tetravox. The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the versions are [semantic](https://semver.org/spec/v2.0.0.html).

`scripts/release.sh <version>` dates the section for a version and opens a fresh `[Unreleased]` one;
`docs/RELEASING.md` is the procedure around it.

## [Unreleased]

### Added

- **External applications can load and save scenes.** The native scene API opens a scene or exports
  the current edited view to a caller-selected path, with a completion reply and optional overwrite.
  Existing scene files and native **File ▸ Save / Save As…** behavior are unchanged.

### Fixed

- **Scene requests restore a missing viewer window.** A running app without a window waits for its
  new renderer before delivering the request.

## [0.5.2] - 2026-09-15

### Fixed

- **The toolbar keeps one row for longer in a narrow window.** The side columns now give way
  before the centre controls wrap, and the right-hand controls are never pushed out of view. At
  full width nothing moves.

### Changed

- **The Extensions button is always in the toolbar.** With nothing installed its menu holds
  **Manage extensions…**, so installing one no longer starts from **File ▸ Extensions…** alone.

## [0.5.1] - 2026-09-15

### Fixed

- **Toolbar controls no longer overlap at narrow window widths.** When the toolbar's centre cluster
  wrapped onto a second row, the right-hand controls (Extensions, `?`, `⚙`) floated to the middle of
  the taller row instead of staying pinned to the first — they now stay aligned to the top, so nothing
  overlaps.

- **The Extensions button stays one line tall.** Its label could wrap onto two lines under a shrinking
  toolbar, doubling its height compared to every other button. It now keeps to one line at any width.

- **A launch that finds a new version now opens Software Update itself.** Checking for updates on
  launch previously only posted a toast; the update dialog now opens automatically, with the same
  Update/Skip/Later choices the manual check has always had. It defers to a toast instead if another
  dialog is already open, so it never interrupts what you're doing.

### Added

- **Check for Updates… is in the Tetravox menu.** Previously only the native macOS app menu could
  open Software Update; the in-app "Tetravox" menu now has the same entry.

## [0.5.0] - 2026-09-15

### Fixed

- **Point layers keep their filenames.** Loading `.geo` or `.pos` files no longer replaces the layer
  name with an internal view title such as “view 1”.

- **Replace numeric bounds freely.** Contrast and threshold inputs allow clearing all characters;
  valid replacements commit on Enter or when leaving the input.

- **Surface colors follow scene order during concurrent loading.** A faster download no longer
  takes another surface’s default color. Explicit colors are retained.

### Changed

- **Windows portable ZIP.** Builds include an x64 ZIP for managed installations alongside the
  regular NSIS installer, avoiding replacement of a separately installed copy.

- **Native application integration.** The browser embed and its host protocol are removed. Open
  `.tetravox.json` files with the native application; batch rendering through `--job` is retained.
- **Managed installations keep their pinned version.** Launches with `TETRAVOX_MANAGED_BY` set leave
  updates to that installation manager and explain this in Updates.

- **Annotations color 2D surface outlines.** Axial, coronal and sagittal outlines follow the attached
  annotation's region colors and visibility, as well as layer opacity.
- Removed the Reverse cut button from clip-plane controls.

- **NIfTI thresholds are ready to edit.** Contrast and threshold rows sit beneath the histogram, with
  thresholds initially spanning min–max. Removed the enable checkbox and Use display range button;
  switching Values/Percentiles preserves the selected cutoffs.
- **Reverse mesh cuts directly.** Reverse cut keeps the opposite side without moving the plane.
  Filled caps inherit mesh colors automatically, replacing the cap and color-source controls.

- **Simpler mesh controls.** Field colors share the volume contrast, histogram and optional threshold
  editor. Controls follow the selected color source; vector components, tissue overrides and attached
  data remain available. Mesh edges use one switch, cross-sections use Fill/Outline, and single-tissue
  meshes omit search and bulk controls. Removed redundant advanced appearance controls.

- **Grab all four histogram bounds directly.** Contrast and threshold low/high handles have distinct,
  staggered grab markers that remain accessible at the plot edges. Removed threshold helper paragraphs.

- **Less clutter in 3D surface controls.** Use the iso slider; the redundant exact input is removed.
  Build progress disappears when the surface is ready. Surfaces use smooth, two-sided shading
  without extra toggles.

- **Choose threshold values or percentiles.** Switch units without changing visibility; intermediate
  percentiles are estimated. **3D slices** and **3D surface** now sit side by side with clearer tooltips.

- **Simpler volume contrast and thresholding.** In **Layers ▸ Volume properties**, display bounds,
  histogram and 1–99%, 50–99.9%, 95–99.9% presets share one panel. Enable thresholding to make values
  outside a separate range transparent. Label volumes focus on tissue controls. Advanced volume scale
  and threshold selectors are removed; editing contrast now uses a linear scale.

### Added

- **An embedded Tetravox tells a surface from a mesh.** The browser build speaks **protocol 3**, and
  a `ViewSpec` now has a third geometry layer kind: `"surface"`. A **mesh** is a tetrahedral FEM
  volume — a SimNIBS `.msh` with an interior, tissue tags, per-element fields and a clip plane that
  can be capped. A **surface** is a triangular sheet — FreeSurfer `lh.pial` / `rh.white` /
  `lh.central`, GIfTI, STL/PLY/OBJ — with none of that, and one colour source at a time: a solid
  colour, a per-vertex `overlay` (curvature, thickness, a `.func.gii`), or an `annotation` (a
  `.annot` or `.label.gii` atlas). It is the same distinction the desktop app gained in 0.4.0, said
  in the host protocol.

  A `.annot`, a morph file or a data-only GIfTI is attached by listing it in the dataset's
  `sidecars.fields` — resolved against the surface's own directory, so SimNIBS's
  `../segmentation/lh.ernie_DK40.annot` is written exactly like that. The geometry format is read
  from the file's bytes and never from its name, which is why the extensionless FreeSurfer surfaces
  work; there is deliberately no `format` field to get wrong.

  **A host written for protocol 2 needs no change**, and every volume/mesh/points scene it can write
  means what it always did. What it must not do is send a `surface` layer to a build whose
  `ready.version` is below 3: an older viewer silently drops a layer kind it does not know and still
  reports a successful load. From protocol 3 that failure is gone in the other direction too — an
  unknown layer kind is refused with an error naming the layer and the four kinds that exist, rather
  than opening a scene with a hole in it. `docs/EMBED.md` §4.0 and §5(c) are the contract.

- **An embedded panel can show only the visualization.** Add `presentation=viewport` beside `embed=1`
  to give the entire frame to the view grid while your application supplies the controls. Orientation
  annotations, 3D gestures and host messages remain available. The full viewer stays the default when
  the option is omitted; `docs/EMBED.md` §2 documents the URL and the inactive shell shortcuts.

- **The browser embed ships with a checksum and a manifest beside it.** Every release now carries
  `tetravox-embed-<version>.tgz.sha256` (in `sha256sum` format, so `sha256sum -c` works on it) and
  `tetravox-embed-<version>.manifest.json` — a copy of the manifest inside the tarball. An
  application that installs the viewer automatically can read which protocol a release implements
  before downloading it, and verify what it downloaded before unpacking it. The release workflow
  refuses to publish unless all three are attached and the digest matches the tarball.

- **Tetravox embeds in a web application.** A new release asset, `tetravox-embed-<version>.tgz`,
  contains a browser build of the viewer that a host serves from any route and mounts in an
  `<iframe>`, then drives over `postMessage` — load a scene, move the cursor, patch a layer, probe a
  point, take a screenshot, read the scene back. It is the same shell and the same WebGL2 engine the
  desktop window runs, not a cut-down second viewer, so every message ends in something a user could
  have done with the mouse. `docs/EMBED.md` is the contract: the URL, the message table, the headers
  and CSP a host must send, three complete `ViewSpec` examples, and a working example page. The
  protocol is versioned (`{ tvx: 1, … }`) and additive-only from here.
- **Datasets can be loaded from URLs.** A scene may point at `https://…` files, and the dataset
  worker streams them the way it has always streamed local ones. This was previously listed as a
  non-goal; it is now a supported, tested path, exercised on every CI run against real NIfTI and
  `.msh` data over HTTP. Remote _browsing_ is still out of scope — a host names files, and there is
  no catalogue or directory listing.

- **An embedded Tetravox can show electrodes, answer clicks, and remember where the camera was.**
  The browser build includes **protocol 2's point controls**, retained in protocol 3; all are optional. A host
  can put a **points layer** straight into the scene — the coordinates inline, its own ids, and each
  point marked `selected`, `disabled` or neither, so an application says _what an electrode is_
  rather than working out what selected should look like. It can arm the same point tool the sEEG
  contact editor uses, so a user places and drags points with the mouse and the host hears about it;
  it can ask to be told **what a click landed on** — the point, the region, the tissue tag and the
  world position, in one message; and it can read the 3-D camera and put it back. `docs/EMBED.md` §6
  is the contract.

  **A host written against protocol 1 needs no change at all.** The message envelope is still
  `tvx: 1`; only the feature level a host reads out of `ready.version` (and the tarball's
  `manifest.json`) identifies the supported protocol. The new events are off until asked for, so an older host receives
  exactly the messages it received before — which is a test, not a promise.

- **An embedded host can be told which point the pointer is on.** `setHoverEvents` turns on a
  `pointHover` message naming the point under the mouse, and naming nothing when it leaves one — so
  an application can light up the electrode you are about to click. It reports the same point a
  click would select, and it fires when the answer changes rather than on every mouse move.

### Fixed

- **Solid ROI meshes no longer close the viewer while a scene loads.** Saved scenes from hosts
  that represented an absent mesh field as `null` now open correctly, including when the mesh
  finishes before its anatomical volumes, and the host receives its completion reply.

- **Interrupted embed loads answer their callers.** Replacing a pending scene or resetting the
  viewer returns a cancellation error for the original request instead of leaving the host waiting.
- **Unnamed embed layers appear once.** Omitting a layer name keeps the engine's default name
  without adding a duplicate layer during scene restoration.

- **Scenes appear as their datasets finish loading.** A small surface or volume no longer waits
  behind another file before it can be viewed, and progress identifies files while they are being
  parsed. Failed files are reported while successful layers remain available. Layer ordering and
  saved camera settings are preserved.
- **Adding to an embedded selection keeps datasets already loaded.** Only missing URLs are read;
  removing a selection releases its resources. Use **Reload** to refresh a file changed at the same
  URL. Reset and interrupted loads cannot restore an obsolete scene afterward; the existing embed
  protocol remains compatible.

- **Dot-shaped points are dot-shaped in the 3D view too.** `shape: 'dot'` asks for a marker of a
  fixed size on screen, and it worked only in the slice views: a 3D view drew a millimetre sphere
  whatever the setting said, so an electrode net looked right when scrolling through slices and
  wrong the moment you rotated the head — and asking for a bigger or smaller dot changed nothing at
  all there. A 3D dot is now the size you asked for at any camera distance, flat rather than shaded
  so its colour reads as one value, still hidden behind the scalp when it is behind the scalp, and
  clickable across the whole marker.

- **An idle electrode can be given its own colour.** A points layer's `stateColors.idle` was
  accepted, documented and ignored — a host that asked for "grey when this electrode is in no
  channel" silently got the layer's colour instead and had to paint every idle point by hand. It is
  now applied, and a layer that does not set it behaves exactly as before.

- **An embedded viewer now answers when you tell it to change its points.** `setPointTool`,
  `setPointSelection` and `setPoints` did the work and said nothing back, so a host application that
  waited for confirmation — the ordinary "select this electrode, then redraw" shape — waited for
  ever. Each now replies once the change is in the scene. Sending them without asking for a reply
  works exactly as before.

- **`setLayout` could kill an embedded viewer.** Four of the pane arrangements `docs/EMBED.md` has
  documented since the first release — `3d`, `axial`, `coronal`, `sagittal` — were not arrangements
  the renderer had, and asking for one left the layout with no panes and stopped the viewer on the
  next frame, silently, with no way back but reloading the page. They now do what the documentation
  always said, and a name the viewer does not know is answered with an error instead of a blank
  window.

## [0.4.0] - 2026-09-07

### Added

- **Surfaces are their own layer kind** — a `.gii`, FreeSurfer, STL/PLY/OBJ shell opens as a `surface`
  layer with a simpler editor of its own: one colour source (solid, overlay, annotation) with **Attach
  file…**, the atlas's regions when one is shown, appearance, the 2D outline, and clip planes. No tissue
  table, isolation, glyphs or caps on a surface. The layer row says `surface` and leads with the
  hemisphere. Tet meshes are unchanged. Scenes saved before this that held a surface as a mesh layer
  still open, as a mesh layer.
- **Surface annotations and overlays** — open a FreeSurfer `.annot` (SimNIBS's
  `segmentation/lh.<subject>_DK40.annot`, `a2009s`, `HCP_MMP1`), a morph file (`curv`, `sulc`, `thickness`) or
  a data-only `.func`/`.shape`/`.label.gii` onto a surface that is already open: through Open / drag-and-drop,
  which picks the matching hemisphere, or the layer panel's **Attach file…**, which names the surface. An
  annotation colours the surface by its atlas and fills the Region panel; a scalar becomes a field with its own
  colour bar. Attached files are saved with the scene and re-attached on load.

## [0.3.11] - 2026-09-04

### Changed

- **Direct anatomical views** — Sagittal, Coronal and Axial buttons display a single slice. The 3D+1
  option is removed; older scenes using it open in 1+3 with their view settings preserved.

### Fixed

- **Layer controls stay inside the sidebar** — opacity sliders and mesh numeric fields shrink to
  fit, keeping adjacent buttons visible without horizontal scrolling.

- **Screenshot options fit the window** — size, background and annotations sit beside the preview,
  with figure controls grouped below it. All export options remain available without scrolling at
  the minimum supported window size.

## [0.3.10] - 2026-09-04

### Fixed

- **Changing surface opacity no longer exposes buried triangle seams.** Mesh and volume-derived
  surfaces retain smooth shading while you adjust transparency in the 3D viewer. Explicit boundary
  lines remain controlled by the surface-edge setting; fully opaque rendering is unchanged.

## [0.3.9] - 2026-09-04

### Added

- **An extension can read and restore the 3-D camera, and can hear what you clicked on.** Two
  additions to the extension API. `scene.camera()` / `scene.setCamera()` mean an extension that moves
  the 3-D view — a QC export taking the four anatomical shots, say — can put it back exactly where
  you had it, instead of leaving you on whichever preset it used last. And an extension can now
  subscribe to the probe itself, so a panel showing "what is under the crosshair" updates when the
  answer for a surface or a mesh actually arrives, rather than showing the previous point's reading.
  Both are additive: every existing extension keeps working unchanged, and none needs a new release.

## [0.3.8] - 2026-09-04

### Fixed

- **File ▸ Extensions… now always shows at least what your copy of Tetravox shipped with.** When the
  online catalogue was behind the application, it replaced the built-in one — so a machine with a
  network connection could be offered an _older_ extension than one with none, or not be offered an
  extension at all. The two lists are now merged: the online catalogue can only add newer versions
  and new extensions, never take one away. New extension releases still appear without updating
  Tetravox.

## [0.3.7] - 2026-09-04

### Added

- **The sEEG contact editor 0.2.2 is in the catalogue.** Its QC figures now look exactly like seegprep's, with
  each electrode's colour and the 3-D distance between contacts on the reslice and a glass-brain implant view.

### Fixed

- **macOS release builds failed on the macos-26 runner image.** electron-builder's temporary signing keychain
  rejected its own passphrase on Darwin 25.6; the release leg is pinned to macos-15.

## [0.3.6] - 2026-09-04

### Added

- **The sEEG contact editor 0.2.1 is in the catalogue.** Its QC figures are now PDFs, export failures say why,
  and the pop-out window opens sized for its contents. It needs this version of Tetravox or newer.
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
