# Phase 2 — ownership map

**Written 2026-08-27, at `phase-2-prep`.** Every ROADMAP Phase-2 bullet and every larger gap from
`docs/review/2026-08-27-phase1-audit.md` is assigned to **exactly one** of seven owners. AGENTS rule
3 is disjoint ownership; Phase 1 tested it with two agents in one package and Phase 2 has five to
seven, so the seams have to be written down before the branches are cut.

Read first: `docs/ARCHITECTURE.md` (the contract), `docs/ROADMAP.md` (Phase 2's list and gate),
`docs/review/2026-08-27-phase1-audit.md` (what exists, clause by clause, with its `P2-xx` items).

---

## Owners at a glance

| Owner | One sentence | Primary directories |
|---|---|---|
| **E-SLICE** | §7.3 complete: the volume slice shader and everything that feeds it | `engine/src/layers/volume.ts`, `render/passes/slice.ts`, `shaders/slice.ts`, `shaders/chunks/{ladder,lut}.ts`, `overlay/colorbar.ts`, `color/` |
| **E-MESH** | §7.4 complete: the mesh shader, clip planes, exact caps, isolation | `engine/src/layers/mesh.ts`, `render/passes/mesh.ts`, `shaders/mesh.ts`, `compute/cut-manager.ts`, `compute/isolate-manager.ts` |
| **E-DERIVED** | Everything derived from a mesh that is *not* the mesh surface: 2D contours, `fillIn2D`, glyphs, isosurfaces, points | `engine/src/layers/{iso,points}.ts`, `render/passes/overlay.ts` (contour items), `shaders/` (new programs), `overlay/` (new items) |
| **E-SCENE** | Interaction, probing, persistence, screenshots, oblique affordances | `engine/src/input/` (new), `scene/`, `view/`, `overlay/` **except** `colorbar.ts` (chrome, crosshair, gizmo), `render/screenshot.ts`, `datasets/`, `app/.../keyboard/keymap.ts` |
| **A-PROPS** | The §8 property editors, region panel and histogram | `app/src/renderer/src/panels/{layers,regions,histogram}/` |
| **A-SHELL** | Toolbar, dialogs, coordinate bar, probing panels, keyboard help | `app/src/renderer/src/{toolbar,dialogs,ui,lib,open,engine}/`, `keyboard/KeyboardHelp.tsx`, `panels/{info,coordinate}/` |
| **W-WASM** | The two protocol/wasm gaps this map found — and nothing else | `crates/`, `packages/protocol`, `packages/wasm`, and the §12.3 frozen files (one named exception below) |

**This table is a summary; where it and an owner's own section disagree, the section wins.** Two
directories are split down the middle and the glance row cannot show it: `app/.../panels/` is
A-PROPS's except `panels/{info,coordinate}/`, which are A-SHELL's, and `app/.../keyboard/` is
A-SHELL's except `keymap.ts`, which is E-SCENE's (§7.5's bindings are engine semantics; the help
sheet that renders them is shell).

**Nothing in the two packages is unowned.** What the rows above do not claim falls into three
buckets: the **shared** files in the next section (`engine.ts`, `render/gpu.ts`, `layers/registry.ts`,
`layers/runtime.ts`, `render/passes/{pass,pick,overlay}.ts`, `renderer.ts`, `gl/state.ts`,
`scene/{store,defaults}.ts`, the two barrels, `shaders/chunks/caps.ts`, and the app's
`properties.tsx` / `store/*` / `engine/mockEngine.ts`); the **frozen** files (`api.ts`,
`scene/types.ts`, and the protocol/wasm surface); and the **integrator's** — `engine/src/gl/` apart
from `state.ts`, `engine/src/render/font.ts`, `engine/src/worker/`, `engine/src/index.ts`,
`scripts/`, `docs/` and the root configs. On the app side there is no remainder at all: A-SHELL's
section closes over everything under `app/src/` that this map does not name. Ask before editing an
integrator file; never edit one as a side effect of a feature.

---

## Shared-file rules

**A shared file is one that more than one owner must append to. There are eighteen, and they are all
additive-only.** Append a registration, a branch or a method at the **end** of its section; never
reorder, never repurpose, never reformat an existing entry. A rebase conflict inside a shared file
means someone broke this rule.

| File | Why it is shared | What "additive" means here |
|---|---|---|
| `engine/src/engine.ts` | the §4.7 facade | new facade methods appended; existing ones untouched |
| `engine/src/render/renderer.ts` | §7.2's pass **order** | append a pass to the sequence in `renderView`; **never reorder** — the order is the contract |
| `engine/src/scene/store.ts` | the `Scene` | append query helpers and mutations |
| `engine/src/layers/registry.ts` | kind → runtime | append a registration |
| `engine/src/render/passes/pass.ts` | `DrawInput` / `PassContext` | append fields; never change a field's meaning |
| `engine/src/render/passes/pick.ts` | §7.2.3 must reproduce **every** discard | append one branch per item kind; the *decision* lives in your `layers/*.ts` |
| `engine/src/render/passes/overlay.ts` | one buffer, one draw | append one item; the *geometry* lives in your `overlay/*.ts` |
| `engine/src/render/gpu.ts` | GPU resources keyed by dataset | append an upload/drop path and its key builder |
| `engine/src/gl/state.ts` | §7.2's per-pass GL state, and §7.4's clip-distance set | append a **complete** block to `GL_STATE` — every field named; never change what an existing block means |
| `engine/src/layers/runtime.ts` | `LayerRuntime`, `DrawItem`, `PickItem` — the §4.4 layer seam | append a `DrawItem` / `PickItem` variant or a runtime member; never narrow an existing one |
| `engine/src/scene/defaults.ts` | the per-kind defaults `fromMeta` seeds from | append a layer kind's defaults; **never change an existing default** — it moves every golden that layer appears in |
| `engine/src/shaders/index.ts` | the program barrel | append an export |
| `engine/src/overlay/index.ts` | the pass-3 item barrel | append an export |
| `engine/src/shaders/chunks/caps.ts` | what all four programs `#include` | append a chunk; never edit one another program interpolates |
| `app/.../engine/mockEngine.ts` | `NoGlEngine implements Engine` | append the member your `Engine` change added, or the app stops compiling |
| `app/.../panels/layers/properties.tsx` | kind → editor | append a registration |
| `app/.../store/controller.ts` | the only place the app calls `Engine` | append methods; never change an existing one's signature |
| `app/.../store/store.ts` | the UI store | append fields; never rename |

**Frozen interfaces (§12.3) are not shared — they are closed.** `packages/protocol/src/index.ts`,
`packages/engine/src/scene/types.ts`, `packages/engine/src/api.ts`, `packages/wasm/src/index.ts` and
every §6 Rust signature may be changed **only by W-WASM**, and only with a `docs/ARCHITECTURE.md`
edit and a `docs/DECISIONS.md` line **in the same commit**. If your feature needs a frozen field,
file it with W-WASM; do not add it yourself and do not work around it with a cast.

**One named exception, and only one.** **E-SCENE may make exactly one edit to
`packages/engine/src/api.ts`: the in-plane cursor nudge P2-09 needs** (working name
`nudgeCursor(viewId, dx, dy)`, or an extended `stepCursor` signature — E-SCENE picks the shape). It
is carved out rather than handed to W-WASM because the interface change and its only implementation
are the same three lines in the same feature, and splitting them across two branches that merge two
stages apart would leave `Engine` with a member nothing implements. The carve-out does **not** relax
the rule around it: that commit carries the `docs/ARCHITECTURE.md` §4.7/§7.5 edit and the
`docs/DECISIONS.md` line, appends the member to `MockEngine` in the same file and to `NoGlEngine` in
`app/.../engine/mockEngine.ts`, and touches nothing else in `api.ts`. Any *other* frozen change,
including a second one E-SCENE turns out to want, goes to W-WASM.

**Lockfiles stay frozen** (AGENTS rule 5). No owner adds a dependency without the integrator.

**Tests live under your own directories.** `engine/src/<yours>/*.test.ts`,
`app/src/renderer/src/<yours>/*.test.tsx`, and Playwright specs in
`packages/engine/test/e2e/<feature>.spec.ts` named for *your* feature — never appended to
`phase1-gate.spec.ts`, which is a closed record of a passed gate. Goldens go under
`packages/engine/test/golden/swiftshader/` with a filename prefixed by your owner tag
(`slice-…`, `mesh-…`, `derived-…`, `scene-…`), so two owners never regenerate one file.

**Regenerating a golden requires a commit body stating what changed visually** (§11). A golden that
moves without such a body is a bug report, not a change.

---

## Integration order

Merge into `main` in this order. Each stage rebases on the previous one; stages 3 and 5 run in
parallel inside themselves.

1. **W-WASM.** It is the only owner allowed to touch a frozen interface, and everything downstream
   would otherwise rebase across it. Ships first even though it is the smallest.
2. **E-SCENE's pointer layer (P2-01).** Every other owner's feature is judged by dragging it, and
   `interacting` / `hover` / the `Mouse` block all hang off it. It is also the change with the most
   `engine.ts` surface, so it lands before four other branches start appending there.
3. **E-SLICE and E-MESH, in parallel.** Fully disjoint: `layers/volume.ts` + `passes/slice.ts` +
   `shaders/slice.ts` against `layers/mesh.ts` + `passes/mesh.ts` + `shaders/mesh.ts` +
   `compute/*`. Their only shared files are `renderer.ts` (neither adds a pass), `pick.ts` (one
   branch each) and `gpu.ts`.
4. **E-DERIVED.** Contours and `fillIn2D` are *consumers* of `compute/cut-manager.ts`, whose GPU side
   E-MESH lands in stage 3. Isosurfaces, points and glyphs have no such dependency and can be built
   in parallel with stage 3 on the same branch.
5. **A-PROPS and A-SHELL, in parallel.** Both drive the engine through §4.7 alone (§8: "everything
   the UI can do must be reachable from the `Engine` API alone. No logic in React."), so they can
   start against today's facade and rebase as the engine methods land.

E-SCENE's remaining items (persistence, screenshot spec, oblique affordances) run through stages 3–5
alongside the others; only its pointer layer is a blocker.

---

## E-SLICE — the volume slice layer, complete (§7.3)

**Owns:** `engine/src/layers/volume.ts` · `render/passes/slice.ts` · `shaders/slice.ts` ·
`shaders/chunks/{ladder,lut}.ts` · `color/colormaps.ts` · `overlay/colorbar.ts`
**Appends to:** `render/passes/pick.ts` (the slice branch's threshold/label discards) ·
`render/gpu.ts` (the 4D texture path) · `layers/registry.ts` (nothing new) ·
`scene/defaults.ts` (new layer defaults, appended — never edit an existing one) ·
`shaders/chunks/caps.ts` and `shaders/index.ts` and `overlay/index.ts` (shared: append only) ·
`gl/state.ts` (the `showIn3D` planes draw in `opaque3d`, which exists — append only if you need a
block that does not)
**Not yours, though it sits in your directory:** `shaders/chunks/caps.ts` — all four programs
interpolate it (`shaders/{slice,mesh,pick,overlay}.ts`), which is what its own header means by
"what both of them read and neither of them owns alone".
**Contract:** §7.3 in full · §7.6 (colormaps, LUTs, `negative`) · §4.2 (`Scale`, `Threshold`) ·
§7.0.5 (analytic AA for label outlines and threshold edges) · §8's colour bars

### Items

| Item | Source |
|---|---|
| `Scale` incl. `heat` with min/mid/max, `truncate`, `inverse`, and the negative branch (`separate` 512×1 signed LUT with a dead band, `mirror`, `hide`) | ROADMAP P2 · §7.6 |
| Threshold with `softEdge` — §4.2's definition **verbatim**: *width of the alpha ramp as a fraction of `hi - lo`; 0 = hard discard*. Not bins, not a fraction of one bin. Symmetric thresholds compare `\|v\|` | ROADMAP P2 · §7.0.5 · §7.3 |
| Label fill / outline / both over the dense index remap, with §7.3's **normative 4-tap outline formula** — screen-relative, `0.5 · outlineWidthPx · duv`, clamped to `[0,1]³`. Do **not** re-derive the step from voxel size | ROADMAP P2 · §7.3 |
| `visibleLabels` / `labelOpacity` | ROADMAP P2 |
| `interpolation` — and §7.2's forbidden-fallback rule: it is a *reading*, never a quality knob | ROADMAP P2 |
| `showIn3D` planes: `DEPTH_TEST` on, `depthFunc(LEQUAL)`, `depthMask(true)`, shared geometry ⇒ bit-identical depth. **No separate full-plane depth prepass** | ROADMAP P2 · §7.3 |
| 4D index over the `volumeFrame` op (§6.5.2) — new texture per `volumeKey`, new `Stats` for the colour bar and the histogram. **Audit P2-05: `,`/`.` is bound today and the engine has no texture for index > 0, so a 4D volume's layer silently stops drawing** | ROADMAP P2 · audit P2-05 |
| The **volume** colour bar: build a `ColorbarSpec` and land the generic renderer in `overlay/colorbar.ts` | ROADMAP P2 · §8 |
| Chunked upload for textures over ~64 MB (`texStorage3D` + per-z-slab `texSubImage3D`, slabs ≤ 32 MB) — already in `gl/texture.ts`; keep the main-thread budget rule (§7.2) when 4D re-uploads join it | §7.3 |

### §11 obligations

**Analytic pixel tests** (`expectPixel`, expected RGBA from first principles on a synthetic fixture):

* `heat` at min / mid / max and on the negative branch, against the CPU bake — the bake and the
  shader must agree to ±1.
* `softEdge`: at `softEdge = 0` a fragment just below `lo` is *absent*; at `softEdge = 0.5` its alpha
  is the smoothstep value, computed by hand.
* Label palette: the dense-index remap paints `ids[k]`'s colour at `palette[k]` — an off-by-one here
  "paints every region with its neighbour's colour, which looks plausible and is wrong".
* `showIn3D` compositing: the §11 named test **Overlay compositing in 3D** — the same pair as
  Phase 1's (`Thalamus_TI_subject_TI_max.nii.gz` over `T1.nii.gz`) on an oblique plane in the **3D**
  view, exact-100 % footprint under `depthFunc(LEQUAL)`, asserted as *independence over every pixel*.
* The R16 / R32F pair through `forceCaps` for any new value path (§11: goldens can only pin R32F).

**Goldens:** `slice-heat-scale`, `slice-threshold-softedge`, `slice-label-outline`,
`slice-showin3d-composite`, `slice-colorbar`.

**Named §11 tests that do not exist yet and are yours:**

* **Label outline zoom** — `labeling.nii.gz` in `outline` mode at 0.05, 1.0 and 5.0 mm/px: measured
  thickness in **[0.8, 2.9] px** and ≥ 99 % coverage of the fill boundary at each. A voxel-space
  regression blows the upper bound immediately (12.87 px at 0.05 mm/px).
* **Overlay compositing in 3D** — above.

### Real-data gate items

* Every feature above has a golden **and** an analytic pixel test **on ernie**.
* `Thalamus_TI_subject_TI_max.nii.gz` over `T1.nii.gz` in 3D, exact-100 %.
* `labeling.nii.gz` — a **float32 label volume with 57 integral unique values**; an `is_label`
  heuristic that requires an integer dtype misclassifies the atlas the app is meant to browse.
* Colour bars present in every screenshot from now on (§11).

---

## E-MESH — the mesh layer, complete (§7.4)

**Owns:** `engine/src/layers/mesh.ts` · `render/passes/mesh.ts` · `shaders/mesh.ts` ·
`compute/cut-manager.ts` · `compute/isolate-manager.ts`
**Appends to:** `render/passes/pick.ts` (clip planes, isolation mask, face culling) ·
`render/gpu.ts` (de-indexed variant, node-field texture, the cap VBO set) · `gl/program.ts` (nothing:
the variant cache already keys on the clip-plane count) · `scene/defaults.ts` (appended, never
edited) · `shaders/chunks/caps.ts` and `shaders/index.ts` (shared: append only) ·
`gl/state.ts` (§7.4's cap rule is `GlState.clipDistances(count, except)` — **use it, do not issue a
raw `gl.enable(CLIP_DISTANCE0_WEBGL + i)`**; gate the first non-empty set on `caps.clipDistance`)
**Contract:** §7.4 in full · §7.2's two-phase transparency · §7.6's tag palette · §6.3's `plane_cut`,
`isolate`, `build_topology`

### Items

| Item | Source |
|---|---|
| `tagStyle` — per-tag visible / opacity / colour, driving §8's tissue table. Per-tag sub-draws mean per-tag opacity sorts naturally (§7.2) | ROADMAP P2 |
| The **two-phase transparency split** made real per tag: 2a back faces, 2b front faces, each sorted back-to-front by the sheet that phase draws; `faceMode:'both'` excluded from the split and drawn last in 2b | §7.2 |
| Node / elm field colouring, **including the de-indexed variant** — built in the worker on first use of `field.source === 'elm'`, `edges.surface`, or `colorMode:'label'`. §8 consequence: these are **async loads with a progress state, not instant checkboxes**, and free thereafter | ROADMAP P2 · §7.4 |
| `colorMode: 'label'` for `.annot` / `.label.gii` | ROADMAP P2 |
| Flat / smooth shading (the `flatShading` program variant) | ROADMAP P2 |
| **Masked barycentric edges**, one mechanism for surfaces and caps alike, no extra draw call: 3-bit `edgeMask`, `d = bary / fwidth(bary)`, `d[i] = 1e9` for cleared bits. When a whole draw is unmasked, **disable the attribute array** and supply a constant vertex attribute | ROADMAP P2 · §7.4 |
| **6 clip planes**, both paths: hardware `gl_ClipDistance` via `WEBGL_clip_cull_distance` **and** the `vec4`-uniform + `discard` fallback, compile-time selected, **pixel-identical under the same goldens**. `Program` emits N ∈ 0..6 variants; `#extension … : require`, never `enable`. **Never `gl_CullDistance`** — the lint forbids the identifier | ROADMAP P2 · §7.4 · §7.1 |
| **Exact caps** from `plane_cut` through `compute/cut-manager.ts`, with §7.4's **cap rule**: when drawing the cap generated by plane *i*, **disable `CLIP_DISTANCE(i)` for that draw** while leaving the others enabled. Measured: `gl_ClipDistance == 0.0` keeps the primitive, `−1e-7` deletes it entirely `[M2Max]` | ROADMAP P2 · §7.4 |
| The cap VBO set: pre-sized, double-buffered, `bufferSubData` after an orphaning `bufferData(null)`, grown by doubling, **never shrunk during a drag**. ~6 MB per buffer set for ernie (62,966 cap triangles at the mid-axial plane) | §7.4 |
| Element isolation through `compute/isolate-manager.ts` — tags / field / sphere / box / label volume — plus the **boundary re-upload** for the isolated sub-mesh and the invalidation of both geometry variants | ROADMAP P2 |
| `orient_surface` / `faceMode` already ship; keep the rule that `faceMode:'both'` is forced when `orient.openComponents > 0` | §7.4 |

`compute/cut-manager.ts` and `compute/isolate-manager.ts` are **yours**, including their tests.
E-DERIVED *consumes* `CutManager.edgeSegments()` / `capPolygons()` and may not edit the file; a change
it needs goes through you.

### §11 obligations

**Analytic pixel tests:**

* A 4-tet mesh with tag colours from a fixture LUT ⇒ the cap pixel is **exactly** the tag colour —
  the 0..255 wire value from `MeshMeta.tags[].color`, which §4.1 requires to round-trip exactly.
* Edge shading: a fragment at a known barycentric distance has the `1 − smoothstep(w−0.5, w+0.5, d)`
  value, computed by hand; a cleared `edgeMask` bit contributes **nothing** to the `min`.
* Clip sign convention: a fragment at `dot(n, p) + offset = +ε` survives and `−ε` does not, on both
  paths.

**Goldens:** `mesh-tagstyle-tissue`, `mesh-field-elm`, `mesh-field-node`, `mesh-label-colormode`,
`mesh-edges-masked`, `mesh-clip-caps`, `mesh-isolate-tags`, `mesh-transparency-twophase`.

**Named §11 tests that do not exist yet and are yours:**

* **Clip-path equivalence** — every clip golden runs **twice**, `gl_ClipDistance` and
  `TETRAVOX_FORCE_DISCARD_CLIP=1`, asserting identical pixels. `EngineOptions.forceDiscardClip`
  exists and is unused today.
* **Cap diagonal** — axial cut of ernie through the centroid: a pixel assertion in a region
  containing a known 2-2-split tet shows **no diagonal**, plus a whole-image edge-pixel count against
  a golden. The 17,983 quad caps in that cut make a dropped `edge_mask` trivially visible.
* **Transparency (i)** — scalp tag 1005 at opacity 0.35 over opaque GM tag 1002 coloured by
  `TI_max`: **no dark rim** from double-blended back faces.
* **Transparency (ii)** — GM tag 1002 at opacity 0.5 with an opaque 10 mm sphere at the thalamus
  target, diffed against a CPU per-fragment-sorted reference render, reporting max per-pixel delta.
  *This is what decides whether `twoPhase` is enough for v1 or depth peeling moves out of Phase 3* —
  report the number even if it passes.

### Real-data gate items

* **`grey_Thalamus_TI.msh` (0 tris, 1,340,029 tets) renders via `extract_boundary` in < 1.5 s.**
* §9.2's **`buildTopology` memory bar**, which Phase 1 explicitly deferred ("nothing in Phase 1 clips
  or isolates"). Measure `wasm_heap_bytes()` for `ernie_seeg.msh` after `buildTopology` against §9.2.
* `ernie_TDCS_1_scalar.msh` for the electrode/gel tag palette (§7.6): tri tags 1101/1102/1501/1502/
  2101/2102 and tet 101/102/501/502 on top of the ten tissue tags. *A viewer colouring only 1–10 /
  1001–1010 renders every electrode and gel layer as untagged grey.* **Tag 4 does not exist** —
  code that assumes `1..10` is wrong.
* `ernie.msh`'s per-tag signed volumes and the four tags `orient_surface` flips (§7.4's reference
  expectation) stay reproduced.

---

## E-DERIVED — contours, fills, glyphs, isosurfaces, points

**Owns:** `engine/src/layers/iso.ts` · `engine/src/layers/points.ts` · new `shaders/{contour,glyph,points}.ts` ·
new `overlay/contours.ts` · the mesh colour bar's `ColorbarSpec` producer
**Appends to:** `render/passes/overlay.ts` (the contour item) · `render/passes/mesh.ts` (nothing —
isosurfaces are `SurfacePayload`s and draw through the existing mesh path; coordinate with E-MESH if
that changes) · `layers/registry.ts` (nothing: `iso` and `points` are already registered) ·
`render/gpu.ts` (instance buffers) · `shaders/index.ts` and `overlay/index.ts` (shared barrels: your
new `{contour,glyph,points}.ts` programs and your `contours.ts` item are appended exports) ·
`layers/runtime.ts` (shared: a new `DrawItem` variant if a glyph draw is not a `mesh` item) ·
`renderer.ts` (a fifth pass, appended to the sequence — it enters a `gl/state.ts` block like every
other pass and inherits nothing from pass 4)
**Consumes, does not own:** `compute/cut-manager.ts` (E-MESH)
**Contract:** §7.4's last bullets · §7.0.6 · §7.2 pass 1 and pass 3

### Items

| Item | Source |
|---|---|
| **2D contours** (`contoursIn2D`): `Cut.edge_segments` drawn in the **overlay** pass as instanced screen-space quads. §7.4: `edge_segments` "is **not** used in the 3D passes — it exists for the 2D overlay". `contourWidthPx` is quad expansion, never `LINES` + `lineWidth` (`ALIASED_LINE_WIDTH_RANGE` is `[1,1]`) | ROADMAP P2 · §7.4 · §7.0.6 |
| **`fillIn2D`**: tet cut polygons drawn in the **opaque** pass with tag/field colour. Same cap rule as §7.4's — the plane's own clip distance is disabled for that draw, or CPU f32 interpolation straddling zero drops polygons wholesale | ROADMAP P2 · §7.4 |
| **Vector glyphs** (`GlyphSpec`): one instanced draw of a shared cone+shaft VAO with per-instance origin / direction / magnitude, in the opaque pass. **No new geometry from WASM.** Origins restricted to visible tags and, when a cut plane is active and `clipToCutPlane`, to elements the plane intersects | ROADMAP P2 · §7.4 |
| **Isosurface layer**: the engine/UI half of `marchingCubes` / `marchingTets` (the `tvx-geom` half landed in Phase 1, with an analytic-sphere test). The result is a `SurfacePayload`, so it uploads and draws through the existing mesh path | ROADMAP P2 |
| **Points layer**: electrodes, ROI spheres from JSON/CSV, SimNIBS `eeg_positions/*.csv`. Not backed by a dataset worker — the points arrive with the layer | ROADMAP P2 |
| The **mesh** colour bar: produce a `ColorbarSpec` from `MeshFieldInfo` (name, `units`, `Scale`, threshold notch) and hand it to E-SLICE's `overlay/colorbar.ts` | ROADMAP P2 · §8 |

**A decision to make early, and record in DECISIONS:** glyph origins. Surface glyphs need nothing new
— `SurfacePayload.positions` + `ownerElm` + a field texture is enough, computed on the GPU — and
neither does the `clipToCutPlane` case, which reads `CutPayload.positions` + `ownerTet`. Only
*unrestricted interior* tets have no origin source in §6.5.2 (see W-WASM item 2). Decide whether v1
needs them at all before writing the shader; "surface and cut-plane only" closes W-WASM gap 2.

### §11 obligations

**Analytic pixel tests:**

* A contour segment's screen-space width at two zooms is `contourWidthPx` ± 0.5 px — this is what
  proves the quad expansion, since `lineWidth` would silently give 1 px at both.
* A `fillIn2D` polygon's pixel is exactly its tag colour (same 0..255 round-trip as the cap test).
* An isosurface of an analytic sphere at a known radius: the rendered silhouette's extent matches
  `2r` in screen mm within one pixel.
* A points layer's sphere at a known world position lands on the pixel the projection names.

**Goldens:** `derived-contours-oblique`, `derived-fill2d`, `derived-glyphs-e-field`,
`derived-iso-sphere`, `derived-points-electrodes`, `derived-mesh-colorbar`.

**Named §11 test that does not exist yet and is yours:**

* **Oblique slice + mesh contours (Phase 2)** — Phase 1's `gate4-t1-oblique` view with a `MeshLayer`
  at `contoursIn2D: true` over it. Needs the overlay-pass instanced contour renderer.

### Real-data gate items

* Contours and `fillIn2D` on `ernie.msh` over `T1.nii.gz`, oblique.
* Glyphs on **`Simulations/*/high_Frequency/mesh/ernie_TDCS_1_scalar.msh`** — the **only** reference
  file carrying a vector field (`E`, ncomp 3, magnitude 8.56e-13 … 57.79), and therefore the test file
  for `GlyphSpec` and for `MeshLayer.field.component: 0 | 1 | 2`.
* An isosurface of `final_tissues.nii.gz` at 0.5 that encloses the labelled voxels (the `tvx-geom`
  test measured ratio 1.018; the rendered one must agree).

---

## E-SCENE — interaction, probing, persistence, screenshots, oblique

**Owns:** new `engine/src/input/` · `engine/src/scene/{store,serialize,fromMeta,defaults}.ts` ·
`engine/src/view/` · `engine/src/overlay/{gizmo,crosshair,chrome,builder,letters,corner,badge}.ts`
(the whole pass-3 chrome except `colorbar.ts`, which is E-SLICE's) ·
`engine/src/render/screenshot.ts` · `engine/src/datasets/` · `app/.../keyboard/keymap.ts`
**Appends to:** `engine.ts` (the frame pump, `interacting`, the `hover` emission) ·
`render/passes/overlay.ts` (the gizmo item) · `overlay/index.ts` (shared barrel) ·
`scene/defaults.ts` (appended, never edited) · `gl/state.ts` (only if a gizmo item needs a block
`blend2d` does not give it)
**One frozen-file carve-out, and its terms:** see [Shared-file rules](#shared-file-rules) — the
single `api.ts` edit P2-09 needs, with the ARCHITECTURE and DECISIONS lines in the same commit.
**Contract:** §7.5 in full · §7.2's frame pump · §4.6 · §4.7's `screenshot` / `serialize` / `load` ·
§8's info panel and coordinate bar

### Items

| Item | Source |
|---|---|
| **P2-01 — §7.5's pointer interaction, all of it.** 2D: left-click/drag sets the cursor; wheel = slice ±1; ⌘/Ctrl+wheel = zoom; right-drag = window/level on the **active** layer, falling back to the topmost non-label volume; middle/space-drag = pan; `Shift+drag` = the active layer's opacity. 3D: left orbit (arcball), right pan, wheel dolly, double-click = `setCursorFromPick`. **This is the one Phase-1-scope hole** (audit §4) | audit P2-01 · §7.5 |
| **P2-02 — `interacting`**: entered on pointerdown / wheel / key-repeat / gizmo drag, left `settleMs` (default 120 ms) after the last input; the `interacting` `QualityLevel` (`dprScale 1`, `msaa 0`, `edges false`, `capDecimation`); leaving it triggers **exactly one** full-quality re-render. **Forbidden in the fallback set: any knob that changes displayed *values*** — `interpolation` is a reading. Plus the adaptive hook that reads `#frameTimes` and emits `quality`; **never degrade silently** | audit P2-02 · §7.2 |
| **P2-03 — per-view dirty bits** in the frame pump | audit P2-03 |
| **P2-04 — the `hover` event**, hover probe rows, and the **element-info *source*** — the `ProbeRow` / `PickResult` fields an element panel reads. **A-SHELL renders it; you produce it, and neither of you does the other half.** §8's targets are **volume hover ≤ 16 ms, mesh hover ≤ 50 ms**, the latter via latest-wins on the layer's own key so a hover never queues behind a cut | ROADMAP P2 · audit P2-04 · §8 |
| **P2-06 — the screenshot spec**: `target: 'view'` crop, `width` / `height` / `scale`, `dpi` written into the PNG **pHYs** chunk, the `include` toggles, `autoTrim`. §7.0.4: `blitFramebuffer` cannot resolve **and** rescale in one call, so resolve and SSAA downsample are two steps | ROADMAP P2 · audit P2-06 |
| **P2-07 — scene save/load**: `ViewSpec` with `version`, **paths relative to the scene file with an absolute fallback**, fingerprints, the dataset-**id remap** on load (without it `spec.layers` cannot be restored), and `activeLayerId`. `scene/serialize.ts` names all four gaps | ROADMAP P2 · audit P2-07 |
| **P2-09 — arrows nudge the cursor in-plane**, distinct from PgUp/PgDn's slice step. §7.5 lists them separately; today both step along the normal. The app may not compute the basis (§8 forbids logic in React), so this needs an engine-side in-plane nudge — and the frozen `Engine` has only `stepCursor(viewId, steps)`, "±1 voxel along the view normal". **This is the one `api.ts` edit that is not W-WASM's**: it is E-SCENE's under the named carve-out in [Shared-file rules](#shared-file-rules), and it ships with the §4.7/§7.5 ARCHITECTURE edit, the DECISIONS line, and the new member appended to `MockEngine` and `NoGlEngine`, in one commit | audit P2-09 |
| **P2-10 — `toTemplate`** and `ProbeResult.mni`. **No protocol change is needed**: `VolumeMeta.headerJson` carries the full NIfTI header, and `sform_code`/`qform_code` = 4 is MNI152. Derive it in `scene/fromMeta.ts` | ROADMAP P2 · audit P2-10 |
| **Keyboard map completion** — every §7.5 binding reachable and listed, including the pointer gestures above | ROADMAP P2 |
| **Radiological toggle** — already shipped; keep §11's three orientation tests green as the pointer layer starts moving cameras | ROADMAP P2 |
| **Oblique affordances**: the cut-plane **gizmo** (`overlay/gizmo.ts`, drawn in the overlay pass with **all clip distances disabled**, or it is clipped by the plane it manipulates), rotate handles, and **plane-from-3-points**. The model and shader path already shipped in Phase 1 | ROADMAP P2 · §7.5 |
| **`.msh.opt` seeding in `fromMeta`** — tag colours/visibility, field range, colormap and colorbar, from `MeshMeta.opt` (which already carries all of it). A-SHELL owns the "defaults from X.msh.opt" chip and Reset | ROADMAP P2 · §7.6 |

### §11 obligations

**Analytic pixel tests:**

* A synthetic drag of N device pixels moves the cursor by exactly `N · mmPerPx` along the pane's
  `right`, in **both** conventions — the radiological mirror must move the cursor the same physical
  way, and this is the laterality-safety test of the pointer layer.
* Wheel-by-one moves the cursor by `step_mm` and **snaps to the nearest voxel plane** — 100 steps
  forward and 100 back return to the starting voxel exactly (the anti-drift rule).
* `whenSettled()` after a synthetic drag resolves only after `interacting` clears; the frame drawn
  then is full quality (assert a pixel that the `interacting` level would have changed).
* The screenshot's pHYs chunk carries the requested DPI — parse the chunk, do not eyeball the image.
* `serialize()` → `load()` round trip restores every field including layers, on a two-dataset scene.

**Goldens:** `scene-gizmo-oblique`, `scene-plane-from-3-points`, `scene-crosshair-after-drag`.

### Real-data gate items

* The §8 `Mouse` block filling on ernie within the ≤ 16 ms / ≤ 50 ms targets, measured in the app e2e
  the way Phase-1 gate item 1 measured progress and cancel — **timed inside the page**.
* A scene saved with `ernie.msh` + `T1.nii.gz`, reopened from a **moved** directory, resolving through
  the relocate dialog (A-SHELL's half) and reproducing the same three slice indices.
* The UX walk-through GIF is A-SHELL's, but the gestures in it are yours.

---

## A-PROPS — the §8 property editors, region panel and histogram

**Owns:** `app/src/renderer/src/panels/layers/`, `panels/regions/`, `panels/histogram/`.
**Not** `panels/{info,coordinate}/`, which are A-SHELL's — `panels/` is the one directory two owners
share, and it is split by subdirectory, not by file.
**Appends to:** `panels/layers/properties.tsx` (registrations) · `store/controller.ts` (methods) ·
`store/store.ts` (fields) · `app/.../engine/mockEngine.ts` (shared: only if an `Engine` member you
drive did not exist — and then only after its owner has landed it)
**Contract:** §8's left panel, tissue table, histogram and region panel · §4.4's layer fields

### Items

| Item | Source |
|---|---|
| **Volume editor**: scale controls (linear + heat's min/mid/max, `truncate`, `inverse`, negative branch), threshold with `softEdge`, label mode fill/outline/both with `outlineWidthPx`, `visibleLabels` / `labelOpacity`, interpolation, `showIn3D`, **4D spinner** | ROADMAP P2 · §8 |
| **Histogram widget** in the volume *and* mesh-field editors: log-y toggle, draggable window and threshold handles, the current colormap painted along the x axis, presets `min–max`, `2–98 %`, `p50–p99.9`, `symmetric ±p99`. The bins come from `Stats.histogram` (256 bins over `[histogramLo, histogramHi]`) — **never** from the sample array, which is what keeps this off the probe budget | ROADMAP P2 · §8 |
| **Region panel**: search-as-you-type over the `LabelTable`, per-row eye + colour swatch + voxel count, `Alt+click` to solo, double-click to jump to the label's centroid via `labelCentroids`. **The same selection wires into `MeshLayer.isolate.labelVolume.labels`** | ROADMAP P2 · §8 |
| **Mesh editor**: the **tissue table** — name from `$PhysicalNames`, colour swatch, eye, opacity slider, backed by `tagStyle` — **not a list of checkboxes**. Plus the field selector (source / name / component), the clip-plane panel (normal preset + free normal + offset sliders), the isolation panel, and the glyph controls | ROADMAP P2 · §8 |
| **The `floatLinear`-absent flag** (audit P2-08): §7.1's named fallback is "force `interpolation:'nearest'` on R32F layers **and flag it in the layer panel**". Forced today, unflagged | audit P2-08 · §7.1 |
| **Iso and points panels** | ROADMAP P2 |
| A progress state on the three §7.4 switches that are **async loads, not instant checkboxes**: the first `edges.surface`, the first element field, the first `colorMode:'label'` on a given mask | §7.4 |

### Test obligations

No goldens — this is DOM, and §11's rule 0 ("an agent cannot judge a PNG; it can judge a number")
cuts the other way here: assert **state**, not pixels.

* Every control is one §4.7 call. Assert against a `MockEngine`/`NoGlEngine` that the control emits
  exactly that call with exactly those arguments — §8: "everything the UI can do must be reachable
  from the `Engine` API alone. No logic in React."
* `properties.test.tsx` stays exhaustive over §4.4's four kinds as each editor lands.
* The histogram's four presets compute their window from `Stats.percentiles` — a pure function, tested
  without a DOM against the exact percentile values.
* The region panel's solo/jump produce `updateLayer` and `setCursor` calls, not local state.
* App e2e: the tissue table drives the engine (a tag toggled off in the table is a tag the scene
  reports hidden), on ernie.

### Real-data gate items

* The tissue table on `ernie.msh` shows all ten tissue names from `ernie.msh.opt` (the file has **no**
  `$PhysicalNames`; the sidecar is the only source) and, on `ernie_TDCS_1_scalar.msh`, the electrode
  and gel tags too.
* The region panel on `final_tissues.nii.gz` (10 unique labels) and `labeling.nii.gz` (57).

---

## A-SHELL — toolbar, dialogs, coordinate bar, probing panels, keyboard help

**Owns:** `app/src/renderer/src/{toolbar,dialogs,ui,lib,open,engine}/` ·
`keyboard/KeyboardHelp.tsx` (**not** `keyboard/keymap.ts`, which is E-SCENE's) ·
`panels/{info,coordinate}/` · everything else under `app/src/` the map does not name
(`App.tsx`, `main.tsx`, `bridge.ts`, `src/main/`, `src/preload/`)
**Appends to:** `store/controller.ts` · `store/store.ts` · `app/.../engine/mockEngine.ts` (shared)
`lib/png.ts` is yours, and it is where the screenshot dialog's **pHYs** parse/assert lives.
**Contract:** §8's toolbar, info panel, coordinate bar, status bar, scene save/load

### Items

| Item | Source |
|---|---|
| **Toolbar**: the scene save/load controls, currently "absent rather than present-and-dead" | ROADMAP P2 · §8 |
| **Screenshot dialog** (`dialogs/ScreenshotDialog.tsx`): the whole `ScreenshotOptions` — target, size, scale, dpi, background, the five `include` toggles, `autoTrim` | ROADMAP P2 · audit P2-06 |
| **Scene save/load + relocate dialog** (`dialogs/RelocateDialog.tsx`): `Engine.load(spec, resolve)` calls `resolve(ref)` per `DatasetRef`; this dialog turns a `null` into a path the user picked, and shows whether the `fingerprint` matches | ROADMAP P2 · §8 |
| **Coordinate bar MNI column** — appears when the dataset has `toTemplate` (E-SCENE populates it) | ROADMAP P2 · audit P2-10 |
| **The "defaults from X.msh.opt" chip and one-click Reset** — E-SCENE seeds from `MeshMeta.opt`; the chip and Reset are yours | ROADMAP P2 · §7.6 |
| **Probing panels**: the `Mouse` block filled from the `hover` event (E-SCENE emits it), the element-info panel **rendered from the rows E-SCENE's P2-04 supplies** (you do not compute them), and the **header panel** (`VolumeMeta.headerJson` verbatim) | ROADMAP P2 · §8 |
| **Keyboard help** (`keyboard/KeyboardHelp.tsx`) — rows generated from `keymap.ts`, so a sheet can never list a binding the resolver does not implement | ROADMAP P2 |
| **Status bar**: surface the `QualityLevel` when it drops below full — §7.2's "never degrade silently" is only true if the bar says so | §7.2 · §8 |
| **The UX walk-through GIF** — a Phase-2 gate item in its own right | ROADMAP P2 gate |

### Test obligations

* App e2e (`packages/app/e2e/`): save a scene, move the file, reopen it, relocate, and assert the
  three decoded slice indices match — this is the whole persistence path end to end.
* The screenshot dialog produces a PNG whose pHYs DPI is the one requested (parse the chunk).
* The `Mouse` block is blank when the pointer leaves a view (§8), asserted on the DOM.
* No goldens; the 2D chrome inside the canvas stays E-SCENE's and E-SLICE's.

### Real-data gate items

* The GIF walks ernie: open, orbit, cut, isolate, probe, screenshot.
* Header panel on `m2m_ernie/T1.nii.gz` shows the on-disk `scl_slope = 1.0` — **not** nibabel's NaN,
  which is an artefact of `Nifti1Image.from_file_map`, and the reason §6.1 reads the raw 348-byte
  header.

---

## W-WASM — the two protocol/wasm gaps, and nothing else

**Not "none".** The audit and this map found exactly two **protocol/wasm** gaps. Both change a
**frozen interface** (§12.3), so each ships with a `docs/ARCHITECTURE.md` edit and a
`docs/DECISIONS.md` line **in the same commit**, and W-WASM merges **first** so nobody rebases
across it twice.

**"Two" counts the gaps that need Rust.** Phase 2 needs a third frozen-interface change and it is
deliberately **not** W-WASM's: P2-09's in-plane cursor nudge is a new `Engine` member in
`packages/engine/src/api.ts` with no protocol, WASM or Rust side at all, and it is E-SCENE's under
the one named carve-out in [Shared-file rules](#shared-file-rules). Nothing else in this map touches
a frozen file. If a fourth turns up, it is W-WASM's by default.

### Gap 1 — `DatasetRef.fingerprint` has no producer

* §4.6 requires a fingerprint per dataset, and §8 keys the relocate dialog on it.
* §5 rule 3 forbids the UI thread from ever seeing the file bytes, so it **cannot** be computed
  there. `engine/src/scene/serialize.ts` writes `''` today and says so.
* Neither `VolumeMeta` nor `MeshMeta` carries the field.
* **Change:** add `fingerprint: string` to `VolumeMeta` and `MeshMeta` in
  `packages/protocol/src/index.ts`; compute it in the loader, over the **input bytes**, before §5
  rule 5 drops them ("input bytes are copied into WASM once and the input buffer is dropped before
  the parser returns"); surface it through the §6.4 exports. A cheap non-cryptographic digest is
  enough — this identifies a file, it does not authenticate one — and it must be stable across
  platforms, so specify the algorithm rather than reaching for a hasher's default.
* **Touches:** `packages/protocol/src/index.ts` (frozen), `crates/tvx-nifti`, `crates/tvx-mesh-io`,
  `crates/tvx-wasm`, `docs/ARCHITECTURE.md` §6.1/§6.2/§6.5.1.
* **Test:** the same file loaded twice gives the same fingerprint; one byte changed gives a different
  one; asserted on a synthetic fixture **and** on `m2m_ernie/T1.nii.gz`.

### Gap 2 — glyph origins for a **volumetric** `GlyphSpec`

* §7.4 puts glyphs in the opaque pass as "one instanced draw … with per-instance origin/direction/
  magnitude. **No new geometry from WASM.**" Origins still have to come from somewhere.
* **Surface** glyphs need nothing new: `SurfacePayload.positions` + `ownerElm` + a field texture
  already give a per-triangle origin and value.
* **Cut-plane-restricted** glyphs need nothing new either: E-DERIVED's own `clipToCutPlane` case is
  served by `CutPayload.positions` + `ownerTet` (`packages/protocol/src/index.ts`), which already
  give a per-cut-polygon origin and the tet it came from.
* What has **no** origin source is the unrestricted case: glyphs on **interior tets** with no cut
  plane active — which is what `ernie_TDCS_1_scalar.msh`'s `E` field over all 5,900,498 elements
  invites. No §6.5.2 op returns element centroids or bulk node positions.
* **Decision required before E-DERIVED writes the shader.** If surface-only, close this as "none" and
  record it in DECISIONS. If volumetric, it is a `field`-result extension or a new op, hence a
  §6.3 + §6.4 + §6.5.2 change and an ARCHITECTURE edit.
* **Touches (if taken):** `crates/tvx-geom`, `crates/tvx-wasm`, `packages/protocol/src/index.ts`,
  `docs/ARCHITECTURE.md` §6.3/§6.5.2.

### Explicitly **not** gaps (checked, so nobody re-files them)

| Phase-2 need | Already in the protocol |
|---|---|
| 4D stepping | `volumeFrame` op + `VolumeFrameT` with per-index `gpuBytes`, `gpu`, `stats`, `labelIds`, `denseIndexOf` |
| Colour-bar units | `VolumeMeta.units`, `MeshFieldMeta.units` |
| Histogram bins | `StatsT.histogram` (256 bins) + `histogramLo` / `histogramHi` |
| `.msh.opt` seeding | `MeshMeta.opt` with `tagColor`, `tagVisible` and the view block |
| Isolation + its mask lifecycle | `isolate` / `freeMask`, `maskId` accepted by `surface` / `boundary` / `cut` / `contours` |
| Exact caps and 2D contour segments | `cut` → `CutPayload` with `edgeSegments` and `boundarySegments`; `contours` op |
| Isosurfaces | `marchingCubes` / `marchingTets` → `SurfacePayload` |
| Region-panel centroids | `labelCentroids` |
| `toTemplate` / MNI | derivable from `VolumeMeta.headerJson` (`sform_code`/`qform_code` = 4); **no protocol change** |
| Mesh probing / element info | `locate` → `ProbeHitT` with every node and element field |

---

## The audit's `P2-xx` items, all eleven, by id

`docs/review/2026-08-27-phase1-audit.md` closes with `P2-01`…`P2-11`. Every one is claimed below, so
an owner can check the audit's list against this map by id rather than by prose. Three items have
two owners because the audit gave them two — an engine half and a shell half — and in each the split
is *produce* against *render*, never a shared implementation.

| Id | Owner(s) | Where it is claimed |
|---|---|---|
| P2-01 | E-SCENE | first item, "§7.5's pointer interaction, all of it" |
| P2-02 | E-SCENE | `interacting` + `settleMs` + the `QualityLevel` + the adaptive hook |
| P2-03 | E-SCENE | per-view dirty bits |
| P2-04 | E-SCENE **produces**, A-SHELL **renders** | `hover` + probe rows + the element-info source; A-SHELL's probing-panels item draws them |
| P2-05 | E-SLICE | the 4D index over `volumeFrame` |
| P2-06 | E-SCENE (engine) + A-SHELL (dialog) | the screenshot spec; `ScreenshotDialog.tsx` |
| P2-07 | E-SCENE (engine) + A-SHELL (dialog) | `serialize`/`load`; `RelocateDialog.tsx` |
| P2-08 | A-PROPS | the `floatLinear`-absent flag |
| P2-09 | E-SCENE | the in-plane nudge — **and the one `api.ts` carve-out** |
| P2-10 | E-SCENE (`toTemplate`) + A-SHELL (the MNI column) | derived in `scene/fromMeta.ts`; rendered in the coordinate bar |
| **P2-11** | split, by content | it is not one feature but §10's whole "missing (Phase 2)" column, so it is the only id this map does not name in an owner's section. Its six contents: **property editors** → A-PROPS · **colour bars** → E-SLICE (the renderer and the volume spec) + E-DERIVED (the mesh spec) · **histogram** → A-PROPS · **region panel** → A-PROPS · **tissue table** → A-PROPS (the panel), E-MESH (`tagStyle`, which backs it) · **`.msh.opt` chip + Reset** → A-SHELL (the chip), E-SCENE (the seeding in `fromMeta`) |

---

## Phase-2 gate, mapped to owners

ROADMAP's gate, item by item, so no one is surprised at the end:

| Gate item | Owner(s) |
|---|---|
| Every feature has a golden **and** an analytic pixel test on ernie | all five engine/app owners, for their own features |
| UX walk-through recorded as a GIF | A-SHELL |
| `grey_Thalamus_TI.msh` (0 tris) renders via `extract_boundary` in < 1.5 s | E-MESH |
| §11 golden: **oblique slice + mesh contours** | E-DERIVED |
| §11 golden: **overlay compositing in 3D** (`showIn3D`) | E-SLICE |
| §11 **Label outline zoom** | E-SLICE |
| §11 **Clip-path equivalence**, **Cap diagonal**, **Transparency (i)** and **(ii)** | E-MESH |
| §9.2's `buildTopology` memory bar (deferred from Phase 1) | E-MESH |
| Colour bars present in every screenshot | E-SLICE (renderer + volume) · E-DERIVED (mesh) |

Two carry-overs from Phase 1 that are **nobody's feature and everybody's risk**, tracked by the
integrator: **ubuntu-24.04 has still never run** — every golden was captured on SwiftShader on macOS
arm64, and ubuntu-24.04 is the golden authority (§11), so the first CI run may require regenerating
goldens **there** — and §9.1 row 1's 418 ms first frame against a < 400 ms budget, which Phase 3 owns.
