---
layout: page
title: Decisions
permalink: /DECISIONS.html
nav_order: 8
---

# Decision log

**How to read this.** Append-only and chronological: entries are `YYYY-MM-DD — decision — why —
alternatives rejected`, newest at the bottom. It records *why*, not what is true now —
`docs/ARCHITECTURE.md` is the only statement of the latter, and where the two disagree the contract wins
and this file is the history of how it got there. A later entry may supersede an earlier one, and says so
when it does. Every deviation from the contract, and every new dependency, lands here in the same commit as
the change.

- 2026-08-27 — Electron over Tauri — Chromium guarantees WebGL2 parity on macOS/Linux; WebKitGTK WebGL2 is inconsistent and lacks WebGPU — Tauri (smaller binary) rejected for GPU risk.
- 2026-08-27 — Custom WebGL2 engine, no three.js/NiiVue — need one context + depth buffer for slices *and* tet meshes, integer 3D textures, exact caps; NiiVue cannot host tets and its clip planes ignore meshes (verified spike 2026-08-27); three.js API churn and abstraction fights — rejected.
- 2026-08-27 — Rust→WASM in a worker for all parsing/geometry — UI thread must never block; pure-Rust crates keep a native/CLI path open — JS parsers rejected (5 M-element face hashing too slow / GC-heavy).
- 2026-08-27 — Sort-based unique-face extraction instead of HashMap — deterministic output for golden tests and ~3× faster in WASM.
- 2026-08-27 — Exact cut caps from `plane_cut` (CPU) + GPU `discard` for clipped surfaces — Gmsh-quality per-element caps; pure-GPU tet rendering (16 M+ triangles) rejected for integrated GPUs.
- 2026-08-27 — Latest-wins compute scheduling — dragging a plane must never queue stale work.

## 2026-08-27 — contract v2 (design review + planner directives A1–G2)

Measurement provenance: `[M2Max]` = Apple M2 Max / ANGLE Metal / Chromium WebGL2 @ 2880×1620; `[SwS]` = headless
Chromium/SwiftShader; `[N25]` = Node 25.4.0 / rustc 1.93.0; `[DATA]` = `scripts/refvalues/*.py` on the reference
dataset.

### Process, memory, loading
- 2026-08-27 — Worker-per-dataset, one wasm instance each, `worker.terminate()` on close — `WebAssembly.Memory`
  exposes only `constructor/grow/buffer`; there is no shrink, and Rust's wasm dlmalloc keeps freed pages, so a
  worker's high-water mark is permanent `[N25]`. Terminating is the only way to give linear memory back.
  A single long-lived compute worker — rejected.
- 2026-08-27 — Single-threaded WASM, permanently; no `rayon`, no wasm threads, no nightly — threads need
  `SharedArrayBuffer` ⇒ `crossOriginIsolated` ⇒ COOP/COEP, plus `-Zbuild-std` on nightly for
  `+atomics,+bulk-memory`. Parallelism comes free from worker-per-dataset. Phase-3 "rayon if needed" — deleted.
- 2026-08-27 — wasm64 out of scope for v1 — `wasm64-unknown-unknown` is Tier 3 and absent from
  `rustup target list` on rustc 1.93.0; Memory64 also forfeits guard-page bounds-check elision. The 4 GiB cap
  (4032 MiB usable: `maximum: 65537` rejected, `grow(1024)` fails at 64,512 pages `[N25]`) is a design constraint,
  not a bug to route around.
- 2026-08-27 — Privileged `tetravox://` scheme + `protocol.handle`, `loadURL` never `loadFile` — wasm-pack
  `--target web` init calls `fetch()`, which Chromium refuses on `file://`, and module Workers do not load from
  `file://` either. The scheme also serves `application/wasm` for `instantiateStreaming` and streams user files.
  Phase-0 gate item. Blob-URL classic workers + `initSync({module})` — rejected as a workaround.
- 2026-08-27 — Bulk bytes never traverse IPC; the dataset worker `fetch`es `tetravox://file/…` itself and
  inflates `.gz` with `DecompressionStream('gzip')` — Electron IPC serialises with structured clone over Mojo and
  *copies* ArrayBuffers (only `MessagePort` transfers across processes), so the drawn "(transfer)" path cost three
  full copies of a 492 MB file. Rust readers keep the `1f 8b` sniff + `flate2` inflate for native/CLI/browser.
- 2026-08-27 — No utility worker in v1 — directive A1 permits one; the only cross-dataset op (`isolate` with a
  `labelVolume` criterion) is cheaper evaluated in the mesh worker from a **structured-cloned** copy of the label
  volume (27 MB `[DATA]`) than by shipping 4.7 M tet centroids (56 MB) the other way. **Cloned, never
  transferred** — `VolumeDataset.data` is the array the UI thread probes from, and a transfer detaches it, so no
  `Req.args` buffer is ever put in a transfer list. A second cross-dataset op gets the utility worker, as an
  ARCHITECTURE.md edit.
- 2026-08-27 — Results are owned `Vec<T>` or `copy_from` into caller-owned `js_sys` arrays; never `view()` —
  `memory.grow` detaches every outstanding view. `&mut [MaybeUninit<T>]` outputs — rejected (two copies).
- 2026-08-27 — `progress`/`cancel` are protocol members, not an add-on; latest-wins drops *queued* requests only,
  and an in-flight wasm call runs to completion (wasm is not preemptible). **Cancelling an in-flight call is
  `worker.terminate()`, never a polled abort flag** — the app is not cross-origin isolated, so
  `SharedArrayBuffer` is `undefined` in the workers (verified in a module Worker on Chromium 151, headless and
  headed: `self.crossOriginIsolated === false`) and a plain `Uint8Array` handed to wasm is a private copy that
  nothing else can write; a synchronous wasm call also blocks the worker's own event loop, so it could not
  receive the `Cancel` message either. Terminating is already the architecture's memory-reclaim primitive
  (worker-per-dataset), needs no COOP/COEP, and makes the 500 ms cancel bar trivially true. Consequence:
  `loadVolume`/`loadMesh` are cancellable and nothing else is — `buildTopology` (< 1.5 s) and marching
  cubes/tets (< 1 s) run to completion rather than throwing away a parsed 492 MB mesh. `abort: &js_sys::Uint8Array`
  is dropped from every §6.4 signature; `ProgressSink::aborted()` stays for the native/CLI build.
  Serving `tetravox://` with COOP/COEP to obtain a SAB-backed abort array — rejected: it re-introduces
  cross-origin isolation (and CORP on every subresource) purely to cancel two ops that do not need cancelling.

### Geometry
- 2026-08-27 — Default 3D representation of a mesh with surface elements is its own tagged triangles;
  `tag_surfaces(mesh)` takes no topology — SimNIBS's stored tris are exactly the exterior ∪ inter-tissue face set
  (0 missing / 0 extra: 128,614 + 1,048,599 = 1,177,213 on ernie; 202,318 + 2,427,261 = 2,629,579 on ernie-seeg
  `[DATA]`). Deriving them from tets yields 2,225,812 faces — 1.89× the geometry for the same picture — and puts
  the riskiest part of `tvx-geom` on the path to first pixels. Encoded as a real-data test.
- 2026-08-27 — `extract_boundary(mesh, topo?, mask, variant)` for tri-less meshes and post-isolation boundaries —
  `grey_Thalamus_TI.msh` has 1,340,029 tets and 0 tris `[DATA]` and renders empty otherwise.
- 2026-08-27 — Unique faces by counting sort on the minimum vertex, then `(v1,v2)` within buckets; no packed key —
  a 3×21-bit u64 key aliases distinct faces above 2²¹ nodes, and both SEEG meshes exceed it (2,301,899 and
  2,323,873 nodes `[DATA]`). Aliasing merges faces as interior and silently deletes real boundary. Transient also
  drops ~453 MB → ~227 MB on ernie. `TetTopology` drops `tet_faces` (nothing consumes it, 75.6 MB).
- 2026-08-27 — `build_topology` is explicit, awaitable and progress-reporting, called eagerly *after* the first
  frame and only when isolation/clipping needs it — lazily triggering a ~1.5 s build from inside a drag is a
  freeze latest-wins cannot prevent.
- 2026-08-27 — Morton element order at load + per-64-tet block AABBs for plane cuts — SimNIBS `.msh` element order
  is grouped by tissue tag, so a spatial index over file order rejects nothing (4,722,624 of 4,722,625 tets
  visited `[M2Max]`). Morton order + block AABBs take the cut **29.0 ms → 2.7 ms** axial and 28.7 → 3.1 ms
  oblique, both WASM `[M2Max]` (the reorder alone, with no index, already gives 19.8 ms via cache locality); the
  "290.7 ms" in the original review was a deoptimized JS proxy — a correct JS version of the same scan is
  86.6 ms and the real WASM baseline is 29.0 ms, so the index is a ~10.7× win, not ~108×. `morton_reorder` 144 ms, `build_tet_blocks`
  39 ms / 1.77 MB `[M2Max]`. Reusing the `PointLocator` centroid grid — rejected (indirection per tet, different
  optimal cell size). The UI reports Gmsh element numbers, never internal indices.
- 2026-08-27 — `plane_cut` stays **exact, always**; no coarse-while-held / exact-on-release split — at 2.7 ms the
  proxy would add a visible pop on release and a second code path to the feature the product is judged on.
  Directive B3's interaction/settle split for cuts is therefore not implemented; the `interacting` quality split
  still applies to DPR/MSAA/edges (§7.2).
- 2026-08-27 — `plane_cut(mesh, blocks, planes: &[Plane], mask) -> Vec<Cut>` — up to 6 planes, one `Cut` each,
  every `Cut` clipped by the others. The single-plane signature could not produce the caps §7.4 promises.
- 2026-08-27 — De-indexing, normals, edge masks and element-id attributes are geometry: worker-side, delivered as
  transferables, two cached variants per mesh layer (indexed default, de-indexed lazy). No per-vertex `tag`
  attribute — 1,048,599 of ernie's 1,177,213 interface faces are shared between two tags, so a per-vertex tag is
  ill-defined. Provoking-vertex duplication (ES flat shading is last-vertex, no `glProvokingVertex`, ANGLE bugs)
  and a separate `GL_LINES` wireframe (line width clamped to 1 px) — both rejected.

### Rendering
- 2026-08-27 — Capability probe at context creation; `getExtension` must be *called* — a LINEAR filter on a
  non-filterable format yields an incomplete texture that samples 0 **with no GL error** `[M2Max]`.
  Binding an integer texture to `sampler3D` is `INVALID_OPERATION`, so the slice shader has two variants keyed on
  `isLabel`, not a uniform switch.
- 2026-08-27 — Scalar GPU format ladder ends at R16-normalized (via `EXT_texture_norm16`), not R16F — `T1.nii.gz`'s
  **because half-float has an 11-bit mantissa**: even with the same `GpuPayload{scale, offset}` normalisation
  into [0,1] that directive C1's R16F proposal carried, it yields ~2048 distinct levels in the top binade against
  R16's 65536 uniform ones. (Unscaled R16F would additionally overflow — `T1.nii.gz`'s max is exactly 65535.0
  `[DATA]` against half's 65504 ceiling — but nobody proposed unscaled R16F, so overflow alone does not settle
  it.) Measured T1 upload R32F 55 MB / 9.2 ms vs R16 27 MB / 3.3 ms `[M2Max]`. Labels are a
  dense-index remap in R8UI/R16UI + an `N×1 RGBA8` palette; a 256×1 LUT cannot address FreeSurfer/`.annot` ids.
  R16UI for a non-label 16-bit layer — rejected (the silent black-slice case).
- 2026-08-27 — `scl_slope`/`scl_inter` are never folded into samples; carried in `GpuPayload{scale, offset}` and
  applied in the shader and probe path — folding doubled wasm, JS-heap and VRAM cost and contradicted the payload
  the same section already returned. *Correction to the review*: these files do **not** have NaN slopes on disk
  (T1 1.0/0.0; `T1_upsampled` 1.0041254758834839/32903.18359375 `[DATA]`); the NaN report was an artefact of
  reading nibabel's in-memory header. The NaN guard stays, exercised by a synthetic fixture.
- 2026-08-27 — `is_label` must not require an integer dtype — `segmentation/labeling.nii.gz` is float32 with 57
  integral unique values 0…530 `[DATA]` and is a genuine atlas.
- 2026-08-29 — **A programmatic `setView` camera is the `ZOOM` readout's reference** — the fit
  `#onFirstDataset` records comes from `#lastRects`, which exist only once a frame has rendered,
  so it was the real pane size on a slow machine and the 512 px fallback on a fast one. The
  `slice-scale` goldens happened to pass only because the fallback fit equals their explicit
  `mmPerPx`; CI, a few ms slower after the wasm rebuild, printed `ZOOM 2.50X` under the same
  scene. `setView` with a `camera.mmPerPx` now records that value as the pane's fit: the readout
  is for a gesture off a place the caller chose, `r` still returns to it, and a restored scene does
  not open claiming to be zoomed. Four `derived-*` 2×2 goldens had that race baked in as a
  `ZOOM 0.70X` line under panes whose camera the spec had set; they are re-blessed without it,
  from the authority's own renders.
- 2026-08-29 — **2D panes composite in layer order across kinds** — `renderer.ts` ran the slice pass
  (every volume) and then the derived pass (every mesh fill), so a mesh cut always painted over a
  volume above it in the panel. The 2D path now interleaves `SlicePass.draw2D` and
  `DerivedPass.drawFill2D` in `scene.layers` order; contours and points still draw last
  (`finish2D`). No golden moves: none photographs a volume *above* a filled mesh.
- 2026-08-29 — **Publication export is PNG-only** — asked for vector (SVG/PDF) output, the decision
  was to stay raster: the panes are raster by nature and a hybrid "raster image + vector overlay"
  file was judged not worth its own writer yet. What figure assembly needs from a PNG shipped instead
  (`lib/figure.ts`): presets (Web 144 · Print 300 · Print 600 · Transparent 300), a width typed in
  **mm** with the 85/114/174 mm journal-column chips, and a **Figure** target that captures each pane
  as its own `Engine.screenshot` and assembles them with A/B/C labels, a mm gutter and `pHYs` DPI —
  in the dialog and as `view: "figure"` in a job. §4.7's `ScreenshotOptions` is untouched: the
  figure is an app-level wrapper around ordinary single-view screenshots.
- 2026-08-29 — **The toolbar centres its controls over the view grid, not the window** — a
  three-column grid whose outer columns are the sidebars' widths (18 rem / 20 rem, 1.5 rem when
  collapsed), read from the store, so the cluster sits over the panes and follows a collapse.
- 2026-08-29 — **`is_label` needs a piecewise-constancy clause above 255 distinct values** — a
  non-negative 16-bit MRI satisfies "integral ∧ min ≥ 0 ∧ ≤ 4096 unique" verbatim: AMOS22
  `amos_0584_mri.nii.gz` (int16, 1014 grey levels in 0…1027) loaded as a 1014-label atlas and was
  painted with a label palette. Above 255 distinct values the rule now also asks that ≥ 50 % of
  adjacent same-row sample pairs (excluding background–background) be equal — 0.11 for that MRI,
  > 0.9 for every atlas in `data/`. Below 256 the old rule stands untouched, so `vol_u8.nii`'s
  frozen `is_label` and `gpu_payload` expectations do not move, and `labeling.nii.gz` (57 values)
  never reaches the new clause.
- 2026-08-27 — Hardware `gl_ClipDistance` (`WEBGL_clip_cull_distance`) primary, `discard` shader as a *tested*
  fallback — 6-plane discard 2.89 ms vs `gl_ClipDistance` 2.07 ms `[M2Max]`; discard defeats early-Z on TBDR and
  the cost compounds across the transparent and pick passes. Programs are specialised per active plane count:
  each clip distance costs a **full varying vector** on ANGLE Metal (`MAX_VARYING_VECTORS = 30`; user varyings
  linkable alongside clip 0/1/2/4/6/8 = 30/29/28/26/24/22 `[M2Max]`), so a blanket `[6]` burns 20 % of the budget
  forever. `gl_CullDistance` is **forbidden** and lint-checked: `MAX_CULL_DISTANCES_WEBGL` is 0 on ANGLE Metal
  `[M2Max]` but 8 on headless SwiftShader `[SwS]`, so CI would not catch misuse.
- 2026-08-27 — When drawing plane *i*'s caps, disable `CLIP_DISTANCE(i)` for that draw — cap vertices lie exactly
  on the plane, and `gl_ClipDistance == 0.0` keeps the primitive (16384/16384 px) while `−1e-7` deletes it
  entirely (0/16384 px) `[M2Max]`; CPU f32 interpolation vs vertex-shader recomputation straddles zero per vertex.
- 2026-08-27 — One draw call per (volume layer, slice plane), all layers of a plane sharing the **plane's** quad
  geometry and vertex shader — ESSL 3.00 forbids indexing a sampler array with anything but a constant expression
  ("`'[' : array index for samplers must be constant integral expressions`" for a loop counter, a uniform int, and
  a loop over `sampler3D u[8]` `[M2Max]`); layers need heterogeneous sampler types and per-layer filtering;
  `MAX_TEXTURE_IMAGE_UNITS = 16` caps single-pass at ~14 layers; perf is a wash (1.10 ms single-pass vs 1.04 ms
  three draws). Shared plane geometry is also what makes overlay depth bit-identical — per-volume-extent quads
  dropped 1.6 %–11.8 % of overlay pixels under LEQUAL `[M2Max]`. Single-pass N-layer shader and per-volume quads —
  rejected.
- 2026-08-27 — No reverse-Z, no `EXT_clip_control`; standard −1..1 depth with `near` tied to scene radius —
  reverse-Z + `ZERO_TO_ONE` turns the coplanar slice-layer case from 4.4 % dropout into 98.9 % `[M2Max]`, and
  buys nothing at mm scale (100 % resolution at 0.02 mm standard). `EXT_clip_control` is present on macOS/ANGLE
  but must not be assumed on Linux/Mesa. Reverse-Z — rejected.
- 2026-08-27 — **Label-outline sampling stays screen-relative** (`texcoord ± 0.5·outlineWidthPx·(inverseAffine·
  dFdx(world))/dims`, 4 taps) — the review's "outlines break at both zoom extremes" was **refuted** by simulation
  on `labeling.nii.gz` and `tissue_labeling_upsampled.nii.gz`: at 0.05 mm/px the outline is 1.00 px thick with
  100 % boundary coverage, and across 0.05 → 10 mm/px **0 of 12,663 / 38,744 / 46,602 / 19,332 / 7,099 / 1,706 /
  554** fill-boundary pixels were uncovered. The proposed voxel-space step gives a 12.87 px band over 42.3 % of
  the viewport at 0.05 mm/px — a 13× regression — and cannot recover a distance from 4 binary taps. Screen-relative
  taps also keep the width constant on `showIn3D` planes under perspective. 8 taps buy nothing (2.00/2.69 px vs
  2.00/2.76 px) at +12 % composite cost. The genuine issue — nearest label sampling losing thin structure under
  minification (3 of 28 labels never sampled at 1 mm/px; 6 of 27 at 10 mm/px) — is a **sampler** item in Phase 3,
  affecting `fill` and `outline` identically. Locked by a three-zoom golden asserting thickness ∈ [0.8, 2.9] px.
- 2026-08-27 — Pick target is single-sample `R32UI` + `DEPTH_COMPONENT24` at the colour target's device-pixel
  size, id = `(layerIndex+1)<<25 | kindBit<<24 | gmshElementNumber`, 0 = miss, depth in a **second** `R32UI`
  attachment as `floatBitsToUint(gl_FragCoord.z)` — WebGL2 cannot `readPixels` a depth attachment, and there is
  no `gl_PrimitiveID`, so element ids come from a per-vertex attribute. Two R32UI attachments over one RGBA32UI:
  **37.3 MB vs 74.6 MB** at 2880×1620 (the design uses *two*, so the honest comparison is 2 × 18.66, not 19),
  0.031 ms vs 0.043 ms 1×1 readback `[M2Max]`. `RED_INTEGER`/`UNSIGNED_INT` is the implementation-defined read
  format on ANGLE/Metal **and** SwiftShader, with `RGBA_INTEGER` spec-guaranteed as the fallback (verified to
  work on an R32UI target, returning `(value,0,0,1)`). `kindBit` sources `PickResult.elementKind`, which
  otherwise had no producer. The 24-bit element field is budgeted against the **combined** tri+tet Gmsh sequence
  — `ernie-seeg.msh` reaches 15,787,627 `[DATA]`, 94 % of the cap — so the per-tag fallback triggers on
  `maxGmshElementNumber > 0x00FFFFFF`, never on a tet count. An `RGBA32F` world-position MRT — rejected (a full-size
  float attachment and an extension dependency for no accuracy gain: window-z reconstructs to ~0.008 mm).
  2D views pick on the CPU (ray ∩ plane), never on the GPU.
- 2026-08-27 — Transparency v1 is a scene-wide two-phase split (2a back faces sorted by far extent, 2b front faces
  sorted by near extent), not a per-object two-pass — per-object ordering renders outer-back, outer-front,
  inner-back, inner-front, still wrong for nested shells. Exact for scalp/skull/CSF/blood (median 2 crossings),
  partial for GM/WM (4–6 median, 8–10 p90) `[M2Max]`. `backfaceCull: boolean` → `faceMode: 'cull' | 'both'`;
  ordering is global, so no per-layer `'twoPassSorted'`. Caps follow their owning layer's pass and opacity.
- 2026-08-27 — Phase-3 transparency upgrade is **dual depth peeling**, not WBOIT — 6 peels covers the measured p90
  depth complexity exactly, WebGL2 has core occlusion queries for adaptive early-out, and 6 × 413 k tris ≈ 2.5 M
  tris/frame fits the 8 ms budget. WBOIT is depth-weighted and washes out exactly the high-contrast layered case
  this app shows; if kept as a >8-layer fallback its weight must be re-parameterised to scene bounds.
- 2026-08-27 — Masked barycentric wireframe is the single edge mechanism for surfaces **and** caps; a 3-bit
  `edgeMask` per triangle suppresses the artificial diagonal of every 2-2 tet cut (17,983 quad caps in ernie's
  mid-axial cut) — the exact artefact Gmsh does not have. `Cut.edge_segments` is re-scoped to the 2D overlay.
  Unmasked draws disable the attribute and supply a constant, so the common case costs zero memory.
- 2026-08-27 — `gl.lineWidth()` is a no-op (`ALIASED_LINE_WIDTH_RANGE = [1,1]` `[M2Max]`): every line-geometry
  `*WidthPx` knob is instanced screen-space quad expansion.
- 2026-08-27 — AA: canvas `antialias:true` in v1 (yields `SAMPLES = 4` with no FBO chain), 2D views single-sample,
  `Framebuffer.samples` carried from day one. `MAX_SAMPLES = 4`; integer formats support **zero** sample counts;
  `blitFramebuffer` cannot resolve and rescale in one call `[M2Max]`. MSAA is coverage-only — GLSL ES 3.00 has no
  per-sample shading (`sample in` is a reserved word, `gl_SampleID` undeclared `[M2Max]`) — so wireframe,
  outlines and threshold edges each need analytic `fwidth`-based AA, and Phase-3 jittered accumulation is the
  only fix for shading aliasing.
- 2026-08-27 — Frame pump: `requestRender()` sets dirty bits, one rAF drains them, ≤ 1 render per view per frame;
  budget ≤ 8 ms at 60 Hz / ≤ 5 ms at 120 Hz; `interacting` quality split with automatic degradation surfaced in
  the status bar; `whenSettled()` is a required test hook. **Sampled-value knobs (nearest vs linear) are
  forbidden in the fallback set** — degrade resolution, never the numbers a clinician reads.
- 2026-08-27 — `SliceView { id, mode, normal, up, camera, layerVisibility }` with the plane **derived** from the
  cursor (`offset = −dot(normal, cursor)`), never stored; `Scene.slices` independent of `layout`; oblique is in
  the model from Phase 1 — §3 claimed oblique support that `ViewLayout` could not express, and Phase 2's own
  `cut`/`contours` ops need a per-view `Plane` crossing the wasm boundary anyway. No separate 2D camera roll
  (in-plane rotation is `up` about `normal`; a roll would be a second source of truth). Slice stepping is defined
  once along the normal with a snap to the nearest voxel plane.
- 2026-08-27 — "Ships Chromium ⇒ identical WebGL2" corrected to "identical *semantics*, not identical GPU
  availability" — Chromium M137 removed the automatic SwiftShader WebGL fallback, so a blocklisted driver returns
  a null WebGL2 context. Electron floor pinned at **≥ 42**: Electron supports only the latest three majors
  (42/43/44 as of 2026-08-25), so 38.2 would start the project on an unsupported branch with no security
  backports. Wayland-native-by-default and the removal of `ELECTRON_OZONE_PLATFORM_HINT` landed in 38 and are
  inherited — they are not what sets the floor. Main process appends `enable-unsafe-swiftshader` so a driverless Linux box degrades to
  slow-but-working, and `enable-webgl-developer-extensions` so `EXT_disjoint_timer_query_webgl2` is a live path;
  the JIT-in-GPU-process trade is accepted. `getContext('webgl2') === null` gets a real error screen.

### UX
- 2026-08-27 — Orientation letters, corner info and a persistent RAD/NEU badge are Phase 1 and appear in every
  golden — a global radiological toggle with no on-screen indication is the one viewer bug class that produces
  wrong-hemisphere conclusions. Handedness is pinned: `right = cross(up, normal)`, and `radiological` negates
  `right` only.
- 2026-08-27 — `activeLayerId` in `Scene`; window/level binds to the active layer (falling back to the topmost
  non-label volume), with `[`/`]`, `v`, `Shift+drag`, `Ctrl+↑/↓`. "The top volume layer" was unaddressable.
- 2026-08-27 — Shared `Scale` model (`linear | heat{min,mid,max,truncate,inverse,negative}`) across volume, mesh
  and iso layers, baked into the LUT on the CPU so the shader is unchanged; `tagStyle` replaces `tagVisibility`;
  `colorMode:'label'` for `.annot`/`.label.gii`; colour bars and the histogram widget move to Phase 2 — every
  screenshot taken before colour bars exist is scientifically unusable.
- 2026-08-27 — `Scene` (runtime, holds TypedArrays/GL/worker handles) is separated from `ViewSpec` (persisted,
  `version: 1`, datasets by relative path + fingerprint) — §4 claimed JSON-serialisability for a graph containing
  a `WebGLTexture`. GL objects move to an engine-private `GpuResources` map keyed by `DatasetId`.
- 2026-08-27 — Drag-and-drop uses `webUtils.getPathForFile` via the preload, with a `File`-bytes fallback —
  `File.path` no longer exists in modern Electron. Both paths are exercised by a Phase-0 E2E.

### Delivery
- 2026-08-27 — `quick-xml` + `base64` + `flate2` (`rust_backend`) for GIfTI — `GZipBase64Binary` is a **zlib**
  stream (`ZlibDecoder`, not `GzDecoder`); `ExternalFileBinary` is `Unsupported` in v1 because the byte-slice
  signature has no sibling-file access.
- 2026-08-27 — Two-file `ni1` (`.hdr`/`.img`) NIfTI is `Unsupported` in v1, by explicit message; int64/uint64
  (1024/1280) and complex are rejected by name, not by falling through.
- 2026-08-27 — Determinism is scoped: geometry outputs are byte-identical native-vs-wasm because they use only
  `+ − × ÷ sqrt` and integer ops; transcendentals diverge (wasm gets `libm`/compiler-builtins) and any function
  using one is marked non-portable and excluded from cross-build goldens. Sampled histograms — rejected;
  percentiles come from an exact 65536-bin pass.
- 2026-08-27 — `packages/wasm` is a hand-written package wrapping the git-ignored `pkg/`; wasm-pack names
  `pkg/package.json` after the crate and drops a `*` `.gitignore` into it, so `pkg` cannot be the workspace
  package. `wasm-bindgen` pinned `=0.2.127`, wasm-pack pinned in `scripts/build-wasm.sh`, a `pkg/tvx_wasm.d.ts`
  stub committed so `tsc` works before the first wasm build.
- 2026-08-27 — Verification is analytic-first: an `expectPixel` assertion computed from first principles **plus**
  a golden, goldens captured only on headless SwiftShader with `aa:'off'` at DPR 1 and compared with
  `maxDiffPixelRatio ≤ 0.002` / `threshold 0.15`, `ubuntu-24.04` authoritative. Playwright's headless Chromium on
  macOS uses ANGLE/Metal regardless of args, so macOS goldens are hardware goldens and cannot be the authority;
  a GPU-less ubuntu runner needs `--enable-unsafe-swiftshader` post-M137. "swiftshader ok" — deleted.
- 2026-08-27 — CI/packaging matrix is explicit: `test` on ubuntu-24.04 (golden authority) + macos-latest;
  `package` on macos-latest (arm64 `.dmg`), macos-26-intel (x64 `.dmg`), ubuntu-24.04 (`.AppImage` + `.deb`).
  **Superseded 2026-08-28**: the macos-26-intel leg is gone. It has no Metal device and macOS offers no software
  fallback (ANGLE allows only `metal`/`swiftshader` there, and SwiftShader's Vulkan backend does not initialise),
  so it built the x64 slice and then failed its smoke test. macos-latest already builds both slices and now
  smoke-tests both (`--all`, x64 under Rosetta); the Linux leg renders with `--software-gl`.
  **Linux artefacts are never built on macOS.** Every package job ends with an artefact smoke test.
- 2026-08-27 — macOS builds are **unsigned for v1** — Sequoia removed the Control-click Gatekeeper bypass, so a
  downloaded unsigned `.dmg` shows a hard "cannot be opened" dialog and the user must use System Settings →
  Privacy & Security → Open Anyway; `USER_GUIDE.md` carries that walkthrough plus
  `xattr -dr com.apple.quarantine /Applications/Tetravox.app`. Auto-update is therefore out of scope. Developer ID
  + notarisation is a documented switch (`APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` +
  `notarize: true`). Ad-hoc signing (`identity: "-"`) — rejected: it only runs on the build machine and has
  known electron-builder regressions. `electron-builder` is pinned to an exact patch.
  **Amended 2026-08-28**: the switch is now built and conditional rather than documented-only.
  `electron-builder.yml` describes the signed build (hardened runtime, entitlements, `notarize: true`, no
  `identity` key so `CSC_LINK` is discovered) and `scripts/electron-builder.sh` — the single entry point for
  `pnpm package` and both workflows — falls back to an unsigned build when `CSC_LINK` is empty
  (`CSC_IDENTITY_AUTO_DISCOVERY=false` plus `--config.mac.hardenedRuntime=false --config.mac.notarize=false`),
  because electron-builder ad-hoc-signs arm64 regardless and ad-hoc + hardened runtime is killed at launch.
  Releases stay unsigned until the four secrets exist (docs/RELEASING.md §4).
- 2026-08-27 — Dependency freeze at the end of Phase 0 with both lockfiles committed; `pnpm-lock.yaml` and
  `Cargo.lock` are never merged (take `main`, regenerate). pnpm 10 ignores dependency build scripts, so the root
  carries `"pnpm": {"onlyBuiltDependencies": ["esbuild","electron"]}`. Electron **38–41** fetch the ~100 MB
  binary from a `postinstall` — which is exactly what that setting un-skips; from **42**, the pinned floor,
  there is no `postinstall` and the binary is fetched on first launch instead (`npm view electron@<v> scripts`,
  checked 2026-08-27). CI warms it explicitly either way. Gate: a clean clone with an empty store reaches `pnpm e2e` green.
- 2026-08-27 — Gmsh 4.1 support has no local reference implementation (SimNIBS refuses v4) and no sample file;
  its fixtures are generated with `~/Applications/SimNIBS-4.6/bin/gmsh`. SimNIBS's own `mesh_io.py` element-block
  skip arithmetic is wrong (hard-codes 2 tags into a 3) and must not be copied.

## 2026-08-27 — contract v2 consistency pass (two independent contract reviews)

Two reviewers checked v2 for internal consistency and buildability. Every finding was verified against the docs
and, where it named a number, against the reference dataset. The entries above were **corrected in place** where
they carried a wrong number (the 290.7 ms cut baseline, the R32UI pick cost, the R16F rationale, the Electron
floor and its `postinstall`, "transferred copy") because those were transcription errors, not reversed decisions.
The decisions below are new.

- 2026-08-27 — **Cancellation is `worker.terminate()`; no wasm export takes an abort argument.** Recorded in full
  under "Process, memory, loading" above. This is the one finding that made a frozen signature unbuildable rather
  than merely ambiguous.
- 2026-08-27 — **New op `volumeFrame` (17 ops, not 16), export `volume_frame`.** `loadVolume` returned one
  `gpuBytes` blob and one `stats` with no volume index, and `Volume::{stats, label_index, gpu_payload}` had no
  export — so no 4D index but 0 could ever be displayed, while §1 puts 4D index picking in scope, §7.5 binds
  `,`/`.` to it and ROADMAP Phase 2 ships a spinner. `VolumeMeta.stats`/`gpu` are now explicitly volume 0's;
  everything per-index comes from `volumeFrame`.
- 2026-08-27 — **The isolation criteria have one wire format, pinned by serde attributes in §6.3 and a worked
  JSON example in §6.5.1.** Bulk arrays never go through `JSON.stringify` (a `Uint32Array` stringifies to
  `{"0":…}`): `labels` is a plain `number[]`, and the label volume's samples travel as `mesh_isolate`'s separate
  `label_volume: Option<Vec<u8>>` argument, described by `dtype`/`dims`/`worldToVoxel`/`volumeIndex` in the JSON.
  `#[serde(rename_all = "camelCase")]` + `#[serde(rename = "box")]` + lowercase enum tags make the Rust struct
  match §6.5.1's `IsolateCriteriaT` name for name.
- 2026-08-27 — **`CutOut` is one multi-plane arena with a `plane_offsets` table, carries `edge_segments` and
  `boundary_segments`, and has a `#[wasm_bindgen(constructor)]` with `pub` fields.** `OpResult['cut']` is a
  discriminated union `{mode:'buffers', cuts} | {mode:'recycled', truncated, counts}` with an explicit overflow
  protocol. The previous shape could not express what §6.4 said it returned (counts, against a `CutPayload[]`
  type), had no way to share one buffer set between up to 6 planes, silently dropped the 2D overlay arrays, and
  had no JS constructor for the worker to build one with.
- 2026-08-27 — **Sidecars are named by role, not ordered.** `LoadSource.sidecars: { lut?, opt? }` on all three
  variants; `load_volume` gains `lut_bytes`, `load_mesh` gains `lut_bytes` alongside `opt_bytes`. Without this
  `VolumeMeta.labelTable`, `MeshMeta.tags[].name/color` and `MeshMeta.labelTables` had no producer, and the
  worker could not tell a `_LUT.txt` from a `.msh.opt` in a positional `sidecarUrls: string[]`.
- 2026-08-27 — **`LoadSource` gains a `{kind:'file'; file: File}` variant** and §8's drop fallback names it.
  A `File` is structured-cloneable, so the renderer posts it for free; the previous text routed the fallback
  through `kind:'bytes'`, which forces `await file.arrayBuffer()` — a 492 MB allocation on the very thread §5
  rule 3 and AGENTS rule 7 forbid from seeing file bytes.
- 2026-08-27 — **Colours are 0..1 floats everywhere in §4, `[u8;4]`/0..255 everywhere in Rust and on the wire,
  with exactly one conversion point** (`packages/engine/src/scene/fromMeta.ts`). The range was stated once, on
  `LabelEntry`, and nowhere else; §11's "the cap pixel is exactly the tag colour" is only an assertion if both
  sides agree.
- 2026-08-27 — **`Threshold.softBins` renamed `softEdge`**, defined once as "width of the alpha ramp as a
  fraction of `hi - lo`; 0 = hard discard", quoted verbatim in §7.0.5 and §7.3. The old name and its three
  incompatible glosses (fraction of `[lo,hi]`, a count of bins, a fraction of one histogram bin) would have
  produced three different widths in a golden that measures exactly that edge.
- 2026-08-27 — **`gmsh_elm_numbers` is `None` exactly when the file numbers elements `1..N` tris-first**, and the
  Gmsh number is then reconstructed as `i+1` / `n_tris + tet_perm[j] + 1`. Verified on all five reference `.msh`
  files plus `ernie_TDCS_1_scalar.msh` `[DATA]`: every one is contiguous with the tri block first. This both
  defines what `owner_elm` holds for STL/PLY/OBJ/GIfTI (which have no element numbers at all) and saves 47.2 MB
  on ernie / 126.3 MB on `ernie-seeg`. Numbers above `u32::MAX` are `Error::Unsupported`, never truncated.
- 2026-08-27 — **`locate_point` returns a whole `ProbeHit`** (Gmsh number, internal tet index, tag, every node
  and element field value), not an `Option<u32>`. The `locate` op promised the fields and no function produced
  them; splitting the gather across two ops would double the ≤ 50 ms hover budget.
- 2026-08-27 — **`MeshDataset.transform` is a user-editable *additional* transform, always identity on load**;
  what the loader baked into the node coordinates is reported separately as `appliedTransform`, with
  `dataSpace`/`transformedSpace` alongside. Node coordinates handed to the engine are always world mm.
- 2026-08-27 — **`generation` is a per-handle counter incremented on every successful `isolate`**, stamped into
  `MeshGeometry.cacheKey`; a `maskId` from an older generation is `Error::Parse`. It appeared in the `isolate`
  result and the mask lifecycle rule with no definition, and the cache key did not include it.
- 2026-08-27 — **`mesh_surface`, `mesh_boundary` and `mesh_isolate` take `on_progress`** (their §6.3 functions
  always took a `ProgressSink`, §9.1 row 16 requires progress, and `isolate` now takes one too).
- 2026-08-27 — **`[TARGET]` provenance tag added**, and §9's heading no longer claims "measured, not asserted"
  for rows that were never timed. `scripts/refvalues/*.py` emit byte counts and field statistics, never a wall
  clock, so `[DATA]` on a latency row was misleading. Phase 3's gate is now "every `[TARGET]` replaced".
- 2026-08-27 — **§9.2 is budgeted per path, not by one multiple**: load path < 2 × file size (every reference
  mesh lands at 1.5–1.9 ×), `buildTopology` path < 3.2 × (1.6–3.2 ×). The flat "< 2 × file size" rule was
  violated by every row underneath it, and the SEEG "must stay < 1.5 GB" bar was breachable by clicking a clip
  plane — recomputed, topology on `ernie-seeg.msh` peaks at ≈ 1.56 GB, which is fine against the 4032 MiB
  ceiling but not against a flat 1.5 GB. Component sizes re-derived: retained `Mesh` for ernie is **149.1 MB**
  (the old 130.3 MB omitted `tet_perm`, which is unconditional).
- 2026-08-27 — **§9.1 row 17 split into the `isolate` predicate (< 100 ms) and the rebuild that follows it**
  (`extract_boundary` + de-index, budgeted consistently with row 19). Isolating ernie's GM leaves exactly
  1,340,029 tets `[DATA]` — precisely row 19's workload — so a 300 ms bar covering "re-extraction plus
  de-indexing" was 5× tighter than row 19 for strictly more work.
- 2026-08-27 — **`EngineOptions.forceCaps`** (a capability-removing test axis, like `forceDiscardClip`) and the
  §7.1 SwiftShader capability table. The golden authority has **no `EXT_texture_norm16`** `[SwS]`, so every
  golden pins the R32F branch of the §6.1 ladder while the shipping renderer uses R16 — the primary format path
  is untestable by golden and is covered by paired analytic pixel tests instead.
- 2026-08-27 — **`ernie_TDCS_1_scalar.msh` (420,249,153 B) added to AGENTS.md, `scripts/refvalues/`, §7.6 and
  §9.** It is the largest non-SEEG mesh in the dataset, the only reference file with a vector field, and hence
  the only test file for `GlyphSpec`, `component: 0|1|2` and the electrode/gel palette — and it was listed
  nowhere.
- 2026-08-27 — **Phase boundaries corrected in ROADMAP**: Phase 1 owns a minimum §7.3 slice shader and a minimum
  §7.4 mesh shader (its own gates need them, and no other agent may write into `packages/engine/src`); Phase 1
  owns the whole of `tvx-geom` including `elm_to_node`, `node_to_elm`, `marching_cubes` and `marching_tets`
  (AGENTS rule 3 is one agent per crate); the two §11 tests that need Phase-2 rendering (mesh contours on the
  oblique golden, `showIn3D` overlay compositing) are split into Phase-1 and Phase-2 variants; and Phase 0's
  packaging gate is narrowed to the host platform's artefact, with the cross-platform matrix moved to Phase 3,
  since `pnpm package` cannot build a Linux artefact on macOS.

## 2026-08-27 — Phase 0 stage 1 (the spine): scaffold deviations

- 2026-08-27 — **React 19, not React 18** (§1's UI row edited in the same commit) — 18 is off the current
  support line and every other pin here is current; the UI is chrome only (§1), so the version carries no
  rendering risk — staying on 18 rejected as starting the project on an old branch.
- 2026-08-27 — **TypeScript pinned `~5.9`, not 7** — TypeScript 7 is the new Go-based compiler and
  `typescript-eslint` 8.68.0 peers `typescript >=4.8.4 <6.1.0`, so `pnpm lint` cannot run against it today.
  Revisit when typescript-eslint widens; §12.3's `typescript` row records the constraint.
- 2026-08-27 — **vite `^7.3.6`, not 8** — `electron-vite` 5.0.0 peers `vite ^5 || ^6 || ^7`. `vitest` 4.1.11
  peers `^6 || ^7 || ^8` and `@vitejs/plugin-react` 5.2.0 peers `^4.2 || ^5 || ^6 || ^7 || ^8`, so vite 7 is
  the only version all three accept. Vite 8 waits on electron-vite.
- 2026-08-27 — **`@tailwindcss/vite` added to §12.3's `tailwindcss` row** — Tailwind 4 ships its own Vite
  plugin and no longer needs a PostCSS pipeline; `postcss`/`autoprefixer` stay declared as §12.3 lists them,
  so a Phase-1 agent that wants them does not have to touch the frozen lockfile.
- 2026-08-27 — **`electron` is declared at the repo root as well as in `packages/app`** — AGENTS and §12.2
  both spell the cold-machine warm-up as `pnpm exec electron --version`, and `pnpm exec` at the root only
  sees root `node_modules/.bin`. Same `^44.0.0` range on both sides, so pnpm resolves one copy.
  Verified on this machine: `pnpm install` does **not** fetch the binary (electron ≥ 42 has no
  `postinstall`, §12.2) and the first `pnpm exec electron --version` downloads it and prints `v44.0.0`.
- 2026-08-27 — **`tvx_core::Aabb` derives `serde::Deserialize`** (adding `serde` to `tvx-core`'s deps) —
  §6.3's `IsolateCriteria.box` is an `Option<Aabb>` deserialised straight from the §6.5.1 wire, which is
  impossible without it. Signature unchanged; §6.0 enumerates no derives.
- 2026-08-27 — **`packages/app` ships as a placeholder `package.json` with no `src/` and no `typecheck`
  script** — its dependency set is fixed now so the lockfile is frozen (§12.3), but stage 2 owns the
  electron-vite layout and adds the scripts with it. `pnpm -r --if-present` therefore skips it.
- 2026-08-27 — **The §7.1 `gl_CullDistance` prohibition is enforced as an ESLint `no-restricted-syntax`
  rule** over identifiers, string literals and template chunks in `packages/**` — the identifier appears in
  shader source strings, not just in TS code, and `MAX_CULL_DISTANCES_WEBGL` is 8 under the SwiftShader
  golden authority against 0 on ANGLE/Metal, so without the string cases CI would pass while every real Mac
  failed.
- 2026-08-27 — **`docs/`, `AGENTS.md` and `scripts/refvalues/` are in `.prettierignore`** — the contract and
  its measured reference values are hand-formatted, and a reflow would rewrite 1,446 lines of
  `ARCHITECTURE.md` and re-key the refvalue JSON for no gain.

## 2026-08-27 — Phase 0 stage 2 (fixtures): generation and ground-truth deviations

- 2026-08-27 — **`testdata/manifest.json`, not `testdata/expected.json`** (§2's tree and §11's "Fixture
  expectations" paragraph edited in the same commit, plus the matching lines in `docs/ROADMAP.md` and
  `AGENTS.md`) — the file carries provenance, reader-limitation notes and a `notGenerated` section
  alongside the expectations, so "manifest" is what it is. One name, changed once, before anything
  reads it.
- 2026-08-27 — **The manifest's ground truth comes from three independent readers, and the script says
  which produced each number.** nibabel reads the NIfTI / GIfTI / FreeSurfer fixtures;
  `simnibs.mesh_io.read_msh` reads the Gmsh v2.2 files; the Gmsh 4.14 Python API (shipped inside
  `simnibs_python`) reads the v4.1 files, the non-contiguous-numbering file and STL/PLY/OBJ. Where two
  readers can see the same file they both do and the manifest carries both, and each v4.1 file is
  additionally converted back to v2.2 by Gmsh and re-read by SimNIBS
  (`roundTripToV22ReadBySimnibs`). `scripts/gen-fixtures.py` therefore re-executes **itself** under
  `$TETRAVOX_SIMNIBS_PYTHON` (default `~/Applications/SimNIBS-4.6/bin/simnibs_python`) for the mesh
  half; the fixture-*writing* half still needs nothing but python3 + numpy + nibabel.
- 2026-08-27 — **Gmsh 4.1 fixtures are converted by Gmsh, as §6.2 already anticipated** — there is no
  other local v4.1 implementation and SimNIBS refuses v4. Regenerating them needs `simnibs_python`;
  the committed files do not.
- 2026-08-27 — **No `>= 2**21`-node mesh is committed** for §11's face-key-width test. 2,097,152 nodes
  is ~25 MB of coordinates and ~100 MB of tets against a 2 MB fixture budget (§2). Instead
  `crates/tvx-geom/tests/fixtures.rs::big_node_count_mesh()` builds one in memory at test time, and
  the real-data half of that test uses `m2m_ernie/ernie_seeg.msh` (2,301,899 nodes = 22 bits) as
  AGENTS.md already specifies. The manifest's `notGenerated` section records this, and a live test
  asserts the note is still there.
- 2026-08-27 — **`mesh_v2_binary.msh` follows SimNIBS's binary dialect, `mesh_v2_binary_gmsh.msh`
  follows Gmsh's, and both are committed.** SimNIBS's writer emits **no** newline before `$EndNodes`,
  `$EndElements`, `$EndNodeData` or `$EndElementData`; Gmsh's emits one, and SimNIBS's own reader
  rejects its data sections for exactly that reason. Every reference `.msh` in the dataset is the
  first dialect, so the reader must accept the second without being written against it. §6.2's
  normative layout is unchanged — this is whitespace either side of the section terminator.
- 2026-08-27 — **Gmsh's PLY reader truncates n-gons**, keeping only the first three indices of a quad,
  so it is not usable as ground truth for `patch_quad_ascii.ply`. That entry carries a `readerNote`
  and an `expectedFromEquivalentObj` block pointing at `patch_quad.obj`, which holds the same 16
  vertices and 9 quads and which Gmsh reads correctly (element type 3). The n-gon /
  `tri_edge_mask` expectation is therefore anchored on the OBJ.
- 2026-08-27 — **STL's node count is reader policy, and the manifest records both answers.** STL has
  no vertex table; Gmsh welds coincident vertices (`weldedNodes` = 16), a non-welding reader keeps 3
  per facet (`unweldedVertices` = 54). §6.2 does not choose, so the test accepts either and pins the
  triangle count and the bounding box instead.
- 2026-08-27 — **`.msh.opt` and the `_LUT.txt` sidecars are ground-truthed by authoring, not by a
  reader** (`"groundTruth": "authored"` in the manifest's `sidecars` section) — no third-party parser
  yields §6.2's `MshOptions` or §6.0's `LabelTable`. Gmsh is still used to prove the `.msh.opt`
  *parses* and to read back its option values (`mshOptParsedByGmsh`), and the file is written in
  SimNIBS's real syntax, `Physical Volume (" GM",2) = { 2 };` and `Hide "*"` / `Show {...}` included,
  copied from `m2m_ernie/ernie.msh.opt`.
- 2026-08-27 — **`serde_json` added as a dev-dependency of `tvx-core`, `tvx-nifti` and `tvx-mesh-io`**,
  and `[[bench]]` sections added to `tvx-nifti`, `tvx-mesh-io` and `tvx-geom`. `serde_json` is already
  in §12.3's frozen set and already in `Cargo.lock`, so neither lockfile moved; the integration tests
  need it to read `manifest.json` and the criterion targets need `harness = false`.
- 2026-08-27 — **Bench routine bodies are no-ops with a `// PHASE 1:` marker.** `cargo test --benches`
  runs every `harness = false` target once, so a real call into an `unimplemented!()` stub would turn
  the workspace red today. The setup around each routine (fixture loading, the `TETRAVOX_TESTDATA`
  skip, the ernie rows §6.2 and §6.3 state budgets for) is real.
- 2026-08-27 — **`testdata/` added to `.prettierignore`.** `manifest.json` is generated with a fixed
  1-space indent and sorted keys so regenerations diff cleanly; a Prettier reflow would make every
  rerun look like a content change.
## 2026-08-27 — Phase 0 stage 2: the Electron shell and the gate demo (`packages/app`)

- 2026-08-27 — **§6.4 gains three Phase-0 liveness exports: `tvx_version()`, `tvx_ping(x)`,
  `tvx_ping_bytes(bytes)`** (frozen surface changed, §6.4 edited in the same commit) — ROADMAP Phase-0 gate 2
  wants a packaged artefact whose triangle colour came out of a real WASM call, and every §6.4 export is an
  `unimplemented!()` stub until Phase 1, so there was nothing callable. `tvx_ping` is the murmur3 32-bit
  finalizer over `x ^ 0x9E3779B9`: pure, and cheap to transcribe into JS with `Math.imul`, so the e2e computes
  the expected pixel **from the algorithm** instead of from a previous run (§11 rule 0). `tvx_ping_bytes` folds
  it over a `Vec<u8>` so gate 3's "the worker hands the bytes to WASM" is a real call over the real bytes.
  Reference values, pinned by `cargo test -p tvx-wasm`: `tvx_ping(0x54565830) = 0x58E5D634` (⇒ `#e5d634`),
  `tvx_ping_bytes(0x00..=0xFF) = 0xFEC415B3`. Alternative rejected: giving one real export a Phase-0 body —
  that hands a Phase-1 crate owner a half-implemented function to unpick.
- 2026-08-27 — **§5 gains rule 9: `tetravox://file/` reads only user-named paths** (§5 edited in the same
  commit) — `supportFetchAPI` on a privileged scheme makes `tetravox://file/<path>` reachable from every module
  Worker under the origin, i.e. an arbitrary-file-read primitive for anything that gets script into the
  renderer. Main keeps a resolved, symlink-flattened allow-list fed only by the Open dialog, a drop,
  `open-file` and CLI argv, and answers 403 otherwise (asserted by an e2e that fetches `/etc/hosts`). The
  contract asked for "a streaming Response over the disk" without saying who may ask.
- 2026-08-27 — **The renderer is loaded from `tetravox://app/index.html` in the packaged app and in
  `electron .`; only `electron-vite dev` uses the dev-server URL** — HMR needs the http origin, and
  `TETRAVOX_FORCE_PROTOCOL=1` forces the scheme there too. Both e2e projects (`dev` = the electron-vite build
  run by the `electron` binary, `packaged` = the `.app`) therefore assert `location.protocol === 'tetravox:'`.
- 2026-08-27 — **`BrowserWindow` uses `sandbox: false`** with `contextIsolation: true` and
  `nodeIntegration: false` — the package is `"type": "module"`, so electron-vite emits an ESM preload
  (`out/preload/index.mjs`), and Electron refuses an ESM preload in a sandboxed renderer. Rejected: forcing the
  preload to CJS, which fights the module type for a bridge that exposes no filesystem and no bytes anyway
  (§5 rule 3).
- 2026-08-27 — **The wasm streaming path is *observed*, not assumed** — wasm-pack's `--target web` glue calls
  `WebAssembly.instantiateStreaming` and falls back to `arrayBuffer()` on a wrong MIME type **without
  failing**, so a broken `protocol.handle` would look identical. The Phase-0 worker wraps
  `instantiateStreaming` to record the `content-type` it saw and whether it ran, and the e2e asserts both
  (`application/wasm`, `streamed === true`).
- 2026-08-27 — **The e2e launches Electron with `--force-color-profile=srgb --force-device-scale-factor=1`** —
  in the spirit of §11's golden launch args. Measured on this M2 Max: without the colour-profile switch the
  compositor colour-manages into the display profile and a `#e5d634` triangle screenshots as `#e3d756`, a
  34-count error in blue that would need a tolerance wide enough to stop meaning anything. `readPixels` is
  unaffected either way; the switch is what lets the *screenshot* leg assert the same bytes exactly.
- 2026-08-27 — **The e2e decodes PNGs with ~40 lines of `node:zlib`, not an image dependency** — 8-bit
  non-interlaced RGB/RGBA is all `page.screenshot()` emits, and the lockfile is frozen (§12.3): adding
  `pngjs`/`pixelmatch` is a coordinated change, and Phase 1 does not need one.
- 2026-08-27 — **electron-builder: `files` excludes `node_modules/**`** — electron-vite bundles main, preload
  and renderer, so nothing is `require`d at runtime, and excluding them keeps electron-builder from walking
  pnpm's symlink farm into the asar. `identity: null` (unsigned v1, §12.2), `npmRebuild: false`, and the mac
  target is `dmg`/`arm64` only; the `linux` block declares `AppImage` + `deb` but is only ever built on Linux
  (§12.1). `gatekeeperAssert` is **not** a valid key in electron-builder 26.15.3 — it fails schema validation.
- 2026-08-27 — **`packages/app` typechecks in three projects, not one** — `tsconfig.node.json` (main, preload,
  build config: no `DOM`, so that half cannot even name a `Window`), `tsconfig.web.json` (renderer + its module
  workers: no `node`), `tsconfig.e2e.json` (Playwright: Node **and** `DOM`, because `page.evaluate` callbacks
  are typed against the page's globals). This supersedes the stage-1 note that `packages/app` is a
  scripts-free placeholder.
- 2026-08-27 — **`no-empty-pattern` is disabled in `e2e/phase0.spec.ts`** — Playwright parses the first
  parameter of a test/hook body to decide which fixtures to build and rejects anything that is not an object
  pattern ("First argument must use the object destructuring pattern"), so `async ({}, testInfo)` is mandatory,
  not stylistic.
## 2026-08-27 — Phase 0 stage 2 (the harness): §11 verification and §12 CI

- 2026-08-27 — **`docs/TESTING.md` added, and §2's `docs/` line edited in the same commit** — §11 and §12
  say what must be true; nothing said how to run it, how to regenerate a golden, or what the measured
  SwiftShader capabilities are. Keeping that in the contract would have doubled §11's length with operator
  detail, so it is its own file and §2 now lists it.
- 2026-08-27 — **The engine test-page server is `packages/app`'s Vite binary, launched as
  `pnpm --filter @tetravox/app exec vite --config packages/engine/test/vite.config.ts`** — the §11 pages
  need a dev server that transpiles TypeScript, and Vite is the obvious one, but it is a devDependency of
  `packages/app` only. Adding an importer edge in `packages/engine` would rewrite `pnpm-lock.yaml`, which
  is frozen (§12.3) and, by AGENTS rule 5, is *taken from `main` on conflict* — so a lockfile edge added
  on a worktree branch is exactly the thing that silently disappears on merge and turns the whole harness
  red. Rejected alternatives: adding `vite` to `packages/engine` (the lockfile problem above), and a
  bespoke `node:http` + `typescript.transpileModule` server (~90 lines reimplementing a bundler badly).
  `test/vite.config.ts` therefore imports **nothing from `vite`** — Vite bundles a config and resolves its
  bare imports from the config's own directory, where `vite` is not resolvable — and exports a plain
  object. When `packages/engine` gains its own `vite` devDependency this becomes
  `pnpm --filter @tetravox/engine exec vite` and the config can use `defineConfig`.
- 2026-08-27 — **The §7.1 probe is implemented in a new `packages/engine/src/gl/context.ts`
  (`createContext(canvas, attrs?) -> { gl, caps }`), while `probeCapabilities` in `gl/caps.ts` stays the
  frozen `unimplemented` stub** — `caps.ts` is frozen with `api.ts` (§12.3 item 3) and stage 2 does not own
  it. `createContext` is where §7.1's "runs **once**, at context creation, before any texture exists" is
  actually enforceable, so the probe lives there and `caps.ts` keeps the frozen signature. Phase 1 should
  make `probeCapabilities` delegate to `probeContextCapabilities`, not duplicate it.
- 2026-08-27 — **`GlLimits` / `probeGlLimits()` are separate from `Capabilities`** — the harness reports
  `MAX_TEXTURE_SIZE`, `MAX_ARRAY_TEXTURE_LAYERS` and `MAX_RENDERBUFFER_SIZE`, which §7.1's `Capabilities`
  does not carry. Adding fields to `Capabilities` would have been a frozen-interface change for test
  reporting; a sibling type costs nothing and keeps §12.3 item 3 untouched.
- 2026-08-27 — **`--enable-unsafe-swiftshader` is the flag, and the §1 claim reproduces exactly** —
  measured on Playwright 1.62.1 / Chromium 151, macOS 15.7 arm64, using `--disable-gpu` to simulate a
  GPU-less runner: with neither flag `getContext('webgl2')` is **`null`**; with
  `--enable-unsafe-swiftshader` it is SwiftShader. `--use-gl=angle --use-angle=swiftshader` also yields
  SwiftShader, with or without the unsafe flag — explicitly selecting a backend is its own consent — but
  it forces software **everywhere**, which would erase the ANGLE/Metal half of §11's two-renderer-class
  strategy, so it is rejected on those grounds rather than on failure. Playwright 1.62 already appends
  `--enable-unsafe-swiftshader` itself and its default `chromium` is the headless shell (no GPU at all);
  passing it explicitly is a harmless duplicate that keeps the requirement visible. Full table in
  `docs/TESTING.md` §2.
- 2026-08-27 — **The macOS golden ratio is 0.01 against the authority's 0.002** — §11 says the macOS job
  compares "with a looser ratio" without naming one. `goldenMaxDiffPixelRatio()` picks it from
  `process.platform`, so the number lives in one place. `ubuntu-24.04` remains the authority: a golden that
  passes on macOS and fails there must be regenerated there.
- 2026-08-27 — **`packages/engine/test/golden/swiftshader/triangle.png` was captured on macOS arm64, not on
  the ubuntu authority** — CI has not run yet, so there was nowhere else to capture it. It is a flat
  two-colour image, so a cross-architecture SwiftShader difference should be a handful of edge pixels
  against a 131-pixel budget; if the first ubuntu run disagrees, regenerate it there and say so in the
  commit body per §11.
- 2026-08-27 — **Golden regeneration is double-locked** — `playwright.config.ts` sets
  `updateSnapshots: 'none'` unless `TETRAVOX_UPDATE_GOLDENS` is set (so a *missing* golden fails instead of
  being captured silently), and `expectGolden()` additionally refuses any update mode without that env
  var, so a stray `playwright test -u` cannot re-bless a rendering change. §11's "commit body states what
  changed visually" stays a human obligation; nothing can enforce it.
- 2026-08-27 — **Vitest is one project per package** (`packages/{protocol,wasm,engine}/vitest.config.ts`,
  aggregated by the root config's `test.projects`) — the previous root-glob config worked, but §11's
  engine suite needs `test/e2e/**` excluded from vitest and included in Playwright, and that rule belongs
  next to the package. `pnpm exec vitest run --project engine` now works. `packages/app` has no project
  yet; stage 2's electron-vite layout adds one.
- 2026-08-27 — **Files touched outside stage 2's ownership, and why**: `vitest.config.ts` (root) for the
  projects change above; `packages/engine/tsconfig.json` to include `test/`, `playwright.config.ts` and
  `vitest.config.ts` in the typecheck — otherwise the harness is the only unchecked TypeScript in the repo;
  `packages/engine/package.json` for the `e2e` / `e2e:update-goldens` scripts that `pnpm e2e` recurses
  into; and `packages/wasm/src/index.test.ts`, which is the "one real unit test" for that package. None of
  the five frozen §12.3 interfaces changed.
- 2026-08-27 — **The §12.1 `package` matrix is present but `workflow_dispatch`-only and exits 1** — ROADMAP
  Phase 0 says the workflow "carries the `package` legs from day one, but they are **Phase 3's** to make
  green". Carrying them as always-on jobs would make every Phase-0 run red, so they are manual and fail
  loudly with a pointer to what Phase 3 must add (`pnpm package` plus the artefact smoke test). Phase 0's
  packaging proof is the macOS-only `.dmg` step inside the `test` job — no `continue-on-error`, and a
  documented no-op only while `packages/app` has no `package` script.

## 2026-08-27 — Phase 0 integration: merging the three stages and closing gate 8

- 2026-08-27 — **`packages/wasm/src/index.test.ts`'s orphan-export check now names the Phase-0 liveness
  trio explicitly.** The harness stage asserted that every §6.4 export is reachable from some §6.5.2 op;
  the app stage added `tvx_version` / `tvx_ping` / `tvx_ping_bytes`, which no op maps to *by design*
  (§6.4's trailing block says so). Neither branch was wrong on its own and the merge was textually
  clean — the failure only exists in the union, which is what integration is for. The three are listed
  one by one rather than skipped by a `tvx_ping*` prefix, so a *fourth* unwired export is still red.
- 2026-08-27 — **ROADMAP Phase-0 gate 8 (drag-and-drop) was implemented at integration time**, not by
  the app stage: the drop *handler* shipped there, but the fixtures it needs — a real `.nii.gz` and a
  real `.msh` — only exist once `p0/fixtures` is merged, so no single stage branch could have written
  the test. `testdata/vol_u8.nii.gz` and `testdata/mesh_v2_ascii.msh` are now dropped in both §8
  branches and both digest through WASM.
- 2026-08-27 — **The renderer's Phase-0 report gained `drops: DropRecord[]`, and the Phase-0 worker a
  second request kind (`digest`).** Gate 8 says the two files must "load", and Phase 0 has no loader, so
  the strongest true statement is *the bytes reached WASM* — the same claim gate 3 makes about the
  fixture. Each branch therefore ends in `tvx_ping_bytes` over the bytes the **worker** read, and the
  e2e asserts the same expected digest for the same file down both branches: one file, two routes, one
  answer. `phase0.ts` is not one of §12.3's five frozen interfaces, so this needs no contract edit.
  What deliberately did *not* change: the UI thread still never calls `file.arrayBuffer()`, and no
  `ArrayBuffer` crosses IPC (§5 rule 3).
- 2026-08-27 — **The e2e drops files it got from a hidden `<input type="file">`, moved into a
  `DataTransfer`.** A `File` only answers `webUtils.getPathForFile` when Chromium built it from the
  filesystem; Playwright's `setInputFiles` is CDP `DOM.setFileInputFiles` over real paths, and the
  binding survives `DataTransfer.items.add`, so the dispatched `drop` event carries path-backed `File`s
  — verified on this machine, both files, exact paths. A `new File([bytes], name)` built in the page has
  no binding and returns `''`, which is precisely the fallback branch. Rejected: driving a native OS
  drag, which Playwright cannot do into an Electron window.
- 2026-08-27 — **`packagedUnavailable()` replaces `packagedExecutable() === null` at the three
  `test.skip` sites, and also skips a *stale* artefact.** `pnpm e2e` rebuilds `out/` but never
  repackages, so a `release/` from an earlier commit launches happily and fails on assertions about code
  it does not contain — which is how gate 8 first presented, as `Cannot read properties of undefined`
  inside a page evaluation. Staleness is measured against **sources** — `packages/app/src` and
  `crates/` — and never against a build output: `pnpm e2e` re-stamps `packages/app/out` on every run
  and `pnpm test` re-stamps `packages/wasm/pkg` on every run, so either one marks a *freshly* packaged
  artefact stale (observed both ways before settling on sources). The mtime read on the artefact side
  is `app.asar`'s, because the Electron binary is copied out of a downloaded zip and can carry the
  zip's timestamps.

## 2026-08-27 — Phase-0 verification follow-up: two contract contradictions and two coverage holes

- 2026-08-27 — **§6.3 `LabelVolumeCriteria.world_to_voxel` is `[f64; 16]`, not `[[f64; 4]; 4]`** — the wire type
  is §6.5.1's `Mat4x4` (flat, length 16, column-major) and §6.5's normative worked example writes it flat
  (`"worldToVoxel": [0,-1,0,0, 0,0,1,0, …]`), but serde reads `[[f64; 4]; 4]` only from a nested
  array-of-arrays. Feeding that exact payload to the shipped struct failed with
  `invalid type: integer 0, expected an array of length 4`. Flattening the Rust field was chosen over nesting
  `Mat4x4`, because `packages/protocol/src/index.ts` is frozen, `Mat4x4` is flat in a dozen other places, and
  `IsolateCriteria` is the only struct serde reads straight off the wire. §6.3 and §6.5's closing paragraph
  edited in the same commit. The pinning test
  `isolate_criteria_parses_the_contract_wire_example` had silently **re-grouped** the contract's flat example
  into nested form, which is why CI was green on a contradiction; it now copies §6.5 character for character
  and asserts the 16 values and the 12–14 translation slots, and a new test
  `world_to_voxel_rejects_a_nested_matrix` keeps a "tidy-up" back to the nested spelling red.
- 2026-08-27 — **§3 now states the matrix layout once, for the whole contract** — a Rust `[[f64; 4]; 4]` is
  row-major `m[row][col]` (nibabel's layout, and `testdata/manifest.json`'s `conventions.affine`); a wire
  `Mat4x4` is flat column-major; `w[col * 4 + row] = m[row][col]`. `tvx_nifti::Volume.affine`'s doc comment
  said "Column-major rows as written: `affine[row][col]`", which contradicts itself, while the identically
  typed `tvx_geom` field claimed column-major — two `[[f64; 4]; 4]` fields citing the contract for opposite
  conventions, with an unguarded transpose (`Volume.affine` → `VolumeMeta.affine`) between them. Both doc
  comments now point at the one §3 rule. No code behaviour changed; the Phase-1 transpose is the thing this
  protects.
- 2026-08-27 — **`testdata/manifest.json`'s `vol_scl.nii` ground truth was scaled twice; the generator was at
  fault, not the reader** — `scripts/gen-fixtures.py` took `raw_arr = np.asanyarray(img.dataobj)`, which has
  **already** applied `scl_slope`/`scl_inter`, then computed `phys = raw_arr * slope + inter` on top. The one
  fixture whose whole purpose is §6.1's "scaling is never folded" rule therefore recorded `raw: -29350`,
  `physical: -73475` where the disk holds −11700 and physics is −29350, and its `stats` block was wrong the
  same way (−73475 / 72775 / −350 against −29350 / 29150 / −100). `crates/tvx-nifti/tests/fixtures.rs`
  asserts against both, so a **correct** §6.1 reader would have gone red the moment the `#[ignore]` came off,
  and the tempting fix would have been to make the reader wrong. Fixed with `img.dataobj.get_unscaled()`
  (correct for every dtype including the structured RGB24/RGBA32 ones) plus a regeneration; `numpyDtype` now
  reports the unscaled dtype for the same reason (`int16`, not `float64`). Only `vol_scl.nii` changed —
  every other fixture has slope 1 / inter 0, and `vol_scl_nan.nii`'s NaN slope makes nibabel skip scaling.
  Fixture *bytes* are unchanged, and `lh.fixture.surf` was restored because its only diff is the generation
  timestamp in the FreeSurfer comment.
- 2026-08-27 — **CI now runs the packaged E2E, and a skip there is a failure** — ROADMAP Phase-0 gate 2 is
  proved by the `packaged` Playwright project and by nothing else, but no committed leg invoked it: the macOS
  `test` job ended at `pnpm package`, and `pnpm e2e` self-skips `packaged` (10 skipped on a clean clone).
  Gate 2 was green only when a human typed the extra command. A `Packaged E2E` step now follows the `.dmg`
  step, and `packagedUnavailable()` honours `TETRAVOX_REQUIRE_PACKAGED=1` by throwing instead of returning a
  skip reason — otherwise a broken package step would leave the new leg silently green at "10 skipped".
- 2026-08-27 — **§6.5's preamble admits `OP_NAMES` and `OP_TO_EXPORT`** — the frozen protocol file shipped two
  runtime tables that "zero runtime code beyond type guards" did not cover, with no ARCHITECTURE edit and no
  decision line, which made it the precedent a Phase-1 agent could cite for editing a frozen file without the
  paperwork. They are worth keeping — op→export is the one seam TypeScript cannot check, and
  `packages/wasm/src/index.test.ts` uses it to catch a renamed wasm export — so the sentence was widened
  rather than the tables moved, and both are named as declarations mirroring §6.5/§6.5.2, frozen with the
  rest of the file.
- 2026-08-27 — **`scripts/refvalues/mesh_refvalues.json` regenerated** — it carried five meshes and no
  `ernie_TDCS_1_scalar.msh` row, while `mesh_refvalues.py` collects six and AGENTS.md publishes that file's
  byte count, its six extra tri/tet tag counts and both field ranges under "re-run those scripts to
  reproduce". The one instruction AGENTS.md gives for checking those numbers could not reproduce them. The
  regenerated JSON is a strict superset — every previously committed value is byte-identical — and the new
  row reproduces AGENTS.md lines 45–72 exactly.

## 2026-08-27 — Phase 1, `tvx-nifti` (§6.1)

No frozen signature changed; every item below resolves something §6.1 left implicit, or records a
measurement. `crates/tvx-nifti/src/lib.rs`'s module docs carry the first two.

- 2026-08-27 — **`want_linear` gates ladder rows 1–2** — rows 1–2 are §6.1's `NEAREST` rows, and the
  same section says `want_linear` is false exactly when the layer is a label or
  `interpolation === 'nearest'`, so the rows are read as `is_label && !want_linear`. Read literally
  as `is_label` alone they would also claim `vol_u8.nii`, whose 60 integral values in 0…234 satisfy
  the `is_label` rule verbatim, and `crates/tvx-nifti/tests/fixtures.rs`'s frozen
  `gpu_payload_follows_the_selection_ladder` expects `R8` for it. The alternative — narrowing
  `is_label` so a small-integer scalar volume fails it — was rejected because §6.1 fixes that rule
  explicitly and names the float32 atlas it must keep catching.
- 2026-08-27 — **The normalised rows map a stored integer code to physical units, not GL's `[0,1]`
  read** — §6.1 row 4 fixes `scale = (max−min)/65535`, `offset = min`, which is dimensionally
  consistent only if the shader multiplies the code `0..=65535`. Rows 3/6/7/8 follow the same shape
  with their own full scale (255 for `R8`); `R32F` and the two label rows carry `scale = 1,
  offset = 0`. A degenerate `max == min` yields `scale = 1, offset = min` and an all-zero texture,
  so a constant volume decodes back to its value instead of dividing by zero. The engine's §7.3
  shader has to agree; this is the crate's half of that contract, and the exactness claim it implies
  is tested (`the_r16_row_round_trips_a_16_bit_input_exactly`).
- 2026-08-27 — **The exact-percentile path is bounded by the value span, not by the dtype** — §6.1
  promises percentiles "exact for integer dtypes", which 65536 bins cannot deliver for an integer
  volume wider than 65536 distinct values. The fine histogram is one bin per integer when every
  physical value is integral **and** `max − min ≤ 65535` (every label volume, every 8/16-bit scalar,
  and `vol_scl.nii`'s ±29,350 physical range); otherwise the bins are uniform and a percentile is
  its bin's lower edge, below the true value by less than `(max − min)/65536` — the accuracy §6.1
  states for float. `testdata/vol_u32.nii` spans 234,000 and is the case that separates the two.
  Percentiles are nearest-rank (numpy's `method='inverted_cdf'`).
- 2026-08-27 — **`is_label`'s first pass exits early** — an anatomical scan fails "integral,
  finite, non-negative" within a chunk, so `T1.nii.gz` does not pay for a full extra 13.6 M-sample
  walk at load: `read_nifti` on it drops from 114.5 ms to 100.1 ms `[M2Max]`, and the whole CPU
  share of §9.1 row 1 (read + stats + `gpu_payload`) from 201.7 ms to 188.4 ms.
- 2026-08-27 — **§9.1 row 1, CPU share, measured** `[M2Max]` (Apple M2 Max, macOS 15.7, rustc
  1.93.0, `cargo bench -p tvx-nifti`, criterion medians): `m2m_ernie/T1.nii.gz` read 100.1 ms,
  `stats` 46.7 ms, `gpu_payload` → R16 43.3 ms, **the three together 188.4 ms** against the row's
  400 ms-to-first-frame budget on machine A, leaving the GL upload and first draw the rest. Also
  `final_tissues.nii.gz` read 57.1 ms, `labeling.nii.gz` `label_index` 37.2 ms and → R8UI 52.5 ms.
  The row stays `[TARGET]` until Phase 3 measures a whole frame; this is the parser's share of it.
- 2026-08-27 — **`serde_json` promoted from `tvx-nifti`'s dev-dependencies to its dependencies, and
  `flate2` added to its dev-dependencies** — `header_json` is "every raw header field" (§6.1)
  including a NaN `scl_slope`, which needs the manifest's `"NaN"`/`"Infinity"` string encoding
  rather than hand-rolled escaping; the real-data qform test decompresses `T1.nii.gz` to patch
  `sform_code`, and a `[dependencies]` entry is not visible to integration tests. Both crates are
  already in the frozen §12.3 set and already appear under `tvx-nifti` in `Cargo.lock`, so the
  lockfile is byte-identical — this adds no dependency to the workspace.
- 2026-08-27 — **Ladder fallbacks §6.1's table leaves blank** — u32/i32 without `norm16` takes
  `R32F` when `float_linear`, else `R8`; a float volume carrying NaN/Inf without `float_linear`
  takes `R16` when `norm16` (non-finite samples land in code 0), else `R8`. In no branch does a
  non-label layer get `R16UI` — that is the silent black-slice case §6.1 names — and `R16F` is never
  selected, which `every_ladder_row_is_reachable_and_none_of_them_is_r16f` asserts over every
  fixture × 3 capability sets × both `want_linear` values.
- 2026-08-27 — **Out-of-range and non-index inputs** — `Volume::stats` has no `Result` in its frozen
  signature, so `vol >= nvols` returns an all-zero `FieldStats` rather than panicking; `label_index`
  and `gpu_payload` return `Error::Parse` for the same input. `label_index` refuses a volume whose
  physical samples are not integral and non-negative, refuses the two colour dtypes, and refuses ids
  whose span exceeds 2^24 or whose count exceeds 65536 — its `dense_of` is as long as the largest
  id (531 entries for `labeling.nii.gz`), and ids absent from the volume map to dense 0.

## 2026-08-27 — Phase 1, `tvx-mesh-io` (§6.2)

- 2026-08-27 — **`Mesh.gmsh_elm_numbers` needs the element *kind* during parsing, and it rides in bit 63 of
  the transient id array.** §6.2 defines the array in (tris then tets) order while a file may write the
  blocks in any order, so the reader has to remember which kind each file-order id belonged to. A parallel
  `Vec<bool>` would cost 15.8 MB on `ernie-seeg.msh` (15,787,627 elements `[DATA]`) for a fact that is
  discarded seconds later. Element numbers are `<= u32::MAX` by §6.2's own rule — checked at parse time, and
  the check is what makes the trick sound — so bit 63 is free. The flag is stripped in
  `finish_elements`, which also runs §6.2's identity test and drops the whole array when it passes, which is
  the case for every reference `.msh` `[DATA]`.
- 2026-08-27 — **`Mesh.Color.<Ordinal>` is indexed by *tag number*, not by declaration order.**
  §6.2 names the syntax but not the mapping, and the two readings disagree on real data:
  `m2m_ernie/ernie.msh.opt` declares 9 volumes (tags 1,2,3,5,6,7,8,9,10 — no 4) and 10 surfaces, so
  declaration order would give Scalp (tag 5) `Mesh.Color.Four`. `simnibs/mesh_tools/gmsh_view.py`'s `Color`
  defaults settle it: `Four = [255,239,179]` (bone cream, tag 4 = the old skull label) and
  `Five = [255,166,133]` (skin, tag 5 = Scalp), i.e. ordinal *N* is Gmsh's colour-carousel slot *N* and
  SimNIBS writes tissue *N*'s colour there. `testdata/manifest.json`'s authored expectation agrees
  independently: its `Mesh.Color.Three` colours nothing, because no physical entity 3 is declared. A colour
  is therefore emitted only for a tag the file actually declares, and §6.2's `1xxx → 1xxx − 1000`
  inheritance is applied on top — which is what makes `1001` take `Mesh.Color.One` rather than
  `Mesh.Color.Three`.
- 2026-08-27 — **FreeSurfer colortables store *transparency*; `LabelEntry.color[3]` is `255 − t`.** §4.1's
  wire form is RGBA, and every `.annot` in the dataset writes `t = 0` `[DATA]`, so reading `t` as alpha
  would make every region invisible. `testdata/manifest.json` records the raw quadruple as `rgba255`
  (`[25,5,25,0]` for `unknown`) and the committed fixture test asserts only the RGB triple, so nothing
  pins the wrong reading.
- 2026-08-27 — **`read_stl` welds coincident vertices by exact bit pattern.** §6.2 leaves the policy open
  and `testdata/manifest.json` accepts either 16 welded nodes or 54 unwelded ones for `patch_*.stl`.
  Welding is what gives an STL shared vertex normals in §6.3's `Indexed` variant, and an exact-bits key
  never merges two points the writer meant to keep apart. `tri_edge_mask` stays `None`, as §6.2 requires.
- 2026-08-27 — **`$NodeData`/`$ElementData` percentiles are bin-centre reconstructions.** §6.1 specifies the
  65536-bin histogram and its error bound for volumes; `FieldStats` is shared, so mesh fields use the same
  code. `min` and `max` are exact, the histogram is exact, and an interior percentile is the centre of its
  bin — within `(max−min)/131072` of the true value. Nothing in `testdata/manifest.json` or AGENTS.md
  asserts a mesh-field percentile, so this is a note, not a claim.

## 2026-08-27 — Phase 1, `tvx-wasm` + `packages/wasm` (§6.4, §6.5)

No frozen interface changed. `packages/protocol/src/index.ts`, `packages/wasm/src/index.ts` and every
§6.4 signature are byte-identical to Phase 0; `packages/wasm/pkg/tvx_wasm.d.ts` changed only because
wasm-pack regenerates it from the crate's doc comments.

- 2026-08-27 — **`tvx-geom`'s call sites are behind a default-off `geom` cargo feature, and the
  integrator flips `default = ["geom"]` when a real `tvx-geom` lands.** `p1/geom` does not exist:
  `tvx-geom` and `tvx-core` are still the Phase-0 signature stubs, and every function in them is
  `unimplemented!()`. Calling one from wasm is not a recoverable error — `unimplemented!()` panics,
  a panic on `wasm32-unknown-unknown` aborts, and the trap poisons the module for the life of the
  worker (§5 rule 8). Eleven of the seventeen §6.5.2 ops route through §6.3, and so does
  `load_mesh`'s load-time work, so an ungated call would take down the *whole* mesh half of the
  protocol — including `loadMesh`, `field` and `free`, which need nothing but the parsed `Mesh`.
  So `crates/tvx-wasm/src/geom.rs` holds every §6.3 call site written exactly as it will run, with
  two arms: with the feature, each wrapper is `tvx_geom::<same name>` one-to-one; without it, each
  returns `Error::Unsupported` naming the function and the flag, which reaches the client as a clean
  `{ code: 'unsupported' }` and leaves the module alive. `cargo clippy --workspace --all-targets
  --features geom` keeps the enabled arm compiling and is part of this branch's verification.
  Turning the feature on also needs a real `tvx-core`: `BitMask::count_ones` backs `isolate`'s
  `visibleTets`.
- 2026-08-27 — **With the feature off, `load_mesh` keeps `read_msh`'s identity `tet_perm` rather
  than Morton-ordering.** §6.4 runs `morton_reorder` / `build_tet_blocks` / `build_point_locator`
  inside `load_mesh`. `read_msh` already emits `tet_perm = 0..n` (§6.2), and §6.2's reconstruction
  `gmsh number of tet j = n_tris + tet_perm[j] + 1` is then exactly the file's own numbering — so
  the numbers the UI reports stay correct; what is lost is spatial locality and the block index,
  and the only two consumers of those (`plane_cut`, `locate_point`) are themselves gated. The trio
  is also skipped for a mesh with **no tets** even with the feature on: there is nothing to order,
  block or locate, and every surface-only format (GIfTI, FreeSurfer, STL/PLY/OBJ) is that case.
- 2026-08-27 — **The sidecar LUT parse lives in `tvx_wasm::lut`, not in `tvx_core::LabelTable`.**
  §6.4's table says the text is parsed "in the worker as part of `load_volume` / `load_mesh`, from
  their `lut_bytes` argument", and `LabelTable::parse_freesurfer` / `parse_simnibs` /
  `parse_itksnap` / `parse_generic` are Phase-0 stubs in a crate this agent does not own (AGENTS
  rule 3). One tolerant parser covers all three shapes, because the op table gives the worker no
  format hint — `lut` is a role, not a type (§6.5.1) — and it is told apart by shape: three integers
  straight after the id is §6.0's colour-first `parse_generic`, a trailing quoted string is
  ITK-SNAP, anything else is the name-first FreeSurfer/SimNIBS column order. **The integrator should
  delete `crates/tvx-wasm/src/lut.rs` and call `LabelTable::parse_*` once `tvx-core` lands.**
- 2026-08-27 — **`ComputeClient` owns the queue and posts one `Req` at a time.** §6.5 says
  latest-wins "drops *queued* requests" and that an in-flight call runs to completion, and that
  distinction is only implementable if something knows which is which. The worker cannot: a `Req`
  it has received is, as far as it is concerned, next. So the client holds the queue, and the
  worker holds a second one only so a `Cancel` that races a `postMessage` still lands. A dropped or
  cancelled request **rejects** with a `ComputeError` carrying `{ code: 'cancelled' }` rather than
  hanging: a promise that never settles is a leak in every `await` that holds it.
- 2026-08-27 — **`ComputeError` is not re-exported from the frozen `packages/wasm/src/index.ts`.**
  Callers narrow on the rejected value's `code` structurally. Adding an export would be a
  frozen-file change and it is not necessary; the integrator may widen `index.ts` later with the
  ARCHITECTURE edit that requires.
- 2026-08-27 — **The recycled `mesh_cut` path returns counts only; its pool never crosses to the UI
  thread, and that is a contract gap.** §6.4 says "the worker keeps the pool; the UI thread transfers
  the buffers **back** after upload", but §6.5.1's `CutResult` `'recycled'` variant carries
  `{ mode, truncated, counts }` and no arrays, and `ToWorker = Req | Cancel` has no message a client
  could hand buffers back with. Both halves are implemented in wasm exactly as §6.4 specifies —
  plane-major packing, `plane_offsets`, and the "nothing is written on truncation" overflow protocol
  — and the worker grows the pool by doubling and re-calls; only the hand-off is missing. **The
  integrator needs either a `pool` field on the recycled variant or a third `ToWorker` kind before
  the Phase-2 cut-plane drag can use it.** The buffers path, which §6.4 calls the correctness
  reference and the only path a golden uses, is complete.
- 2026-08-27 — **`.gz` is decided by name, then confirmed by the magic bytes.** §5 rule 4 pipes a
  `.gz` read through `DecompressionStream('gzip')`. Measured on this repo's own dev server: vite's
  static middleware answers a request for `vol_f32.nii.gz` with `Content-Encoding: gzip`, so `fetch`
  inflates it before the worker sees a byte, and piping that into the gunzip a second time fails on
  perfectly good data. The worker therefore peeks the first chunk, re-emits it, and only pipes when
  the bytes really start with `1f 8b` — still streaming, still `.gz`-by-name. The same measurement
  is why `Content-Length` is dropped as the progress denominator the moment `done` passes it: it is
  the length **on the wire**, and a progress bar past 100 % is worse than one with no total.
  `packages/wasm/e2e/protocol.spec.ts` asserts both halves.
- 2026-08-27 — **`GpuFormatInfo.chunked` is `bytes > 16 MiB`.** §4.3 defines it as "uploaded as
  z-slabs (§7.3)" and neither section fixes a threshold. §7.2's main-thread budget rule — "no single
  main-thread call may exceed `frameBudget / 2`" — is 4 ms of an 8 ms frame, and §7.2's own measured
  `texImage3D` figures (256×256×208 at 3.6–5.5 ms for R16UI's 27.3 MB, 11.1 ms for R32F's 54.5 MB)
  put the achieved rate near 5 GB/s, so 4 ms buys ~20 MB. 16 MiB is the round number under that.
- 2026-08-27 — **`MeshMeta.appliedTransform` is always identity, and `dataSpace` /
  `transformedSpace` are absent.** `tvx-mesh-io` *applies* GIfTI's
  `CoordinateSystemTransformMatrix` when the target space is scanner-anatomical — the e2e asserts
  the transformed bounding box, so it demonstrably does — but its frozen `Mesh` has no field to
  report *which* matrix, and the same gap swallows the two `CoordinateSystem` strings (recorded on
  `p1/mesh-io`, 2026-08-27). This layer will not invent a matrix it was not told, so it reports the
  honest identity. Filling those in is the same `Mesh`-shaped ARCHITECTURE edit the mesh-io agent
  already flagged.
- 2026-08-27 — **`MeshMeta.labelTables` is keyed by the node field named `label`.** §6.5.1 keys it
  "by node-field name"; `tvx-mesh-io` names a GIfTI array from its `Name` metadata, falling back to
  the short intent, which is `label` for a `.label.gii`. When no field matches and there is exactly
  one node field, that one takes the table. `.annot` and `curv` produce no entry at all — no §6.5.2
  op loads a field file onto an existing mesh, so `read_fs_annot` and `read_fs_curv` are currently
  unreachable from the protocol; that is a Phase-2 op, not an omission here.
- 2026-08-27 — **The §6.2 tag ladder is resolved once, at load, and names and colours can land on
  different rungs.** `$PhysicalNames` → sibling `_LUT.txt` → sibling `.msh.opt` → a deterministic
  20-entry glasbey-like palette. `$PhysicalNames` carries no colour and the palette carries no name,
  so the two walk the same ladder independently; §6.2's `1xxx` → `1xxx − 1000` inheritance is applied
  at every rung, including the palette, so a surface and the volume it bounds always share a colour.
  The palette is indexed by the folded tag, never by declaration order, so it is stable under a file
  that declares its tags in a different sequence.
- 2026-08-27 — **`mesh_field` reuses the crate's own `stats` whenever the selection is the one
  §6.0 already describes** — `component: 'mag'` for any `ncomp`, and component 0 of a scalar. Only
  `component: 0 | 1 | 2` of a vector produces an array nothing has seen, and `tvx_wasm::stats`
  computes it by §6.1's method (one pass for min/max/mean, one 65536-bin histogram, nearest-rank
  percentiles, the 256-bin display histogram summed down from it). `'mag'` of a **scalar** field is
  the value itself, signed — taking `|v|` there would silently rectify a signed field.
- 2026-08-27 — **`mesh_convert_field` does not register its output on the mesh.** §6.5.2 types the
  `elmToNode` result as `{ name, values, stats }` and says nothing about the converted field being
  addressable afterwards, so it is a pure conversion; `marchingTets` with `source: 'elm'` runs the
  same conversion internally (reducing to a scalar `ElmField` first, since §6.3's `marching_tets`
  takes one value per node).
- 2026-08-27 — **Measured `[M2Max]`** (Apple M2 Max, macOS 15.7, Chromium 151 via Playwright
  1.62.1, release wasm, `packages/wasm/e2e/realdata.spec.ts`), against §9's bars:

  | File | `wasm_heap_bytes` after load | × file | §9.2 load-path bar | op time | first `Progress` |
  |---|---|---|---|---|---|
  | `m2m_ernie/ernie.msh` (184,207,351 B) | 358,350,848 = **341.8 MB** | 1.95 × | ≤ 380 MB ✔ | `loadMesh` 491 ms | 12 ms |
  | `m2m_ernie/ernie_seeg.msh` (492,090,201 B) | 956,694,528 = **912.4 MB** | 1.94 × | ≤ 1.0 GB ✔ | `loadMesh` 1,477 ms | 11 ms |
  | `m2m_ernie/T1.nii.gz` (13.1 MB gz) | 105.3 MB | — | — | `loadVolume` 366–370 ms | 12 ms |
  | `Simulations/Thalamus/TI/mesh/Thalamus_TI.msh` (255.0 MB) | — | — | ≤ 480 MB | `loadMesh` 750 ms | — |

  ROADMAP Phase-1 gate 7 (`wasm_heap_bytes()` under the §9.2 load-path bar for `ernie_seeg.msh`) is
  **met**: 912.4 MB against 1.0 GB. Both meshes come in ~0.14 × above §9.2's `[MODEL]` (1.81 ×),
  which is dlmalloc's page granularity and the transient the reader frees before returning, not a
  retained structure. §9.1 row 6's "progress visible within 200 ms" is met by an order of magnitude
  — 11 ms — because the worker reports the `read` phase from the first fetch chunk, before any wasm
  call; its cancel bar is met trivially, since cancel is `worker.terminate()` and takes 0 ms.
  §9.1 row 1's 400 ms is a whole-frame budget on machine A and stays `[TARGET]`; the 366–370 ms above is
  fetch + inflate + parse + stats + `gpu_payload` + the transfer to the UI thread on an M2 Max, with
  the GL upload and first draw still to come.
## 2026-08-27 — Phase 1: the app shell (`packages/app`)

- 2026-08-27 — **The shell is developed against an app-local `NoGlEngine`, not `packages/engine`'s
  `MockEngine`.** §4.7 says `MockEngine` "implements it with no GL so the app agent can build the entire
  UI in Phase 1", but at the end of Phase 0 every member of it throws `'phase 1'`, and it lives inside
  `packages/engine/src/api.ts` — one of §12.3's five frozen files, owned by the engine agent for the whole
  of Phase 1. Filling in those bodies from the app's worktree would be editing a frozen file *and*
  writing into another agent's package (AGENTS rule 3). `packages/app/src/renderer/src/engine/mockEngine.ts`
  implements the same frozen `Engine` **interface**, imported from `@tetravox/engine`, so the compiler
  still proves the shell only ever uses contract members; `engine/factory.ts` chooses between it and the
  real `create()` on one constant, `ENGINE_IMPL`, with `?engine=real|mock` as a per-window override.
  **The integration step is flipping that constant.** Rejected: unfreezing `api.ts` to fill `MockEngine`
  in (needs an ARCHITECTURE edit for something no contract reader would call a contract change), and
  waiting for the real engine (which is the coupling Phase 1's split exists to avoid).
- 2026-08-27 — **Loads run one at a time.** `Engine.addDataset` resolves with a `Dataset` only at the end
  of a load, while `EngineEvents.progress` carries the `datasetId` from the first phase — so a load card
  exists before it knows its own id, and §8's Cancel can be pressed in that window. Sequencing makes
  "this progress event belongs to the one unbound card" unambiguous, and it is also the right memory
  answer: with worker-per-dataset (§5 rule 1) two 492 MB meshes in flight is two wasm heaps at once
  (§9.2). A cancel pressed before the id exists is recorded on the card and issued as `cancelDataset` the
  moment the first progress event reveals the id; a cancel on a *queued* card never starts a worker at
  all. Rejected: correlating parallel loads by request order (a guess the moment two loads interleave),
  and having the card wait for `addDataset` to resolve before showing anything (which would forfeit
  ROADMAP Phase-1 gate 1's "progress visible within 200 ms").
- 2026-08-27 — **The §8 shell is the default UI and the Phase-0 walking skeleton moved behind
  `?ui=phase0`, reached from a new `--tvx-search=<querystring>` launch switch.** ROADMAP gate items 2, 3
  and 8 are proved by that component and by nothing else, and CI runs its packaged E2E with
  `TETRAVOX_REQUIRE_PACKAGED=1` where a skip is a failure — so it had to stay reachable, unchanged, in
  the **packaged** artefact. The window is loaded with `loadURL('tetravox://app/index.html')` (§5) and an
  IPC round trip lands a commit too late for a first render, so the query string is the only place a
  launch option can travel; it is re-serialised through `URLSearchParams` so a malformed value cannot
  smuggle a second `?` or a `#`, and `collectCliPaths` already drops `-`-prefixed argv so it never looks
  like a file. The same switch carries the stand-in's knobs (`engine=`, `mockStepMs=`, `mockParseFail=`,
  `forceWebgl2Null=`). Rejected: `webPreferences.additionalArguments` (readable only from the preload,
  which would then need a synchronous bridge member for something that is not app state).
- 2026-08-27 — **Main sets a save path for downloads, and the window has a `minWidth`.** The §8
  screenshot button hands its `Blob` to an `<a download>`; Electron's default for a download with no
  `savePath` is a **Save As dialog**, so the button would open a modal nobody asked for and would hang
  the E2E outright. `will-download` now writes to `app.getPath('downloads')`, redirectable with
  `TETRAVOX_DOWNLOAD_DIR` — which is what lets the E2E decode a real PNG off disk instead of asserting a
  MIME type. Separately, `minWidth: 960` exists because a tiling window manager on the development
  machine snapped the window to 588 px the moment it was shown, and the two side panels (18 rem + 20 rem)
  left the view grid at exactly zero width; `setBounds` from main did not survive the tiler, so the app
  defends its own floor and the E2E waits for a non-zero grid box rather than for a window size.

## 2026-08-27 — Phase 1 integration, `tvx-core` (§6.0)

- 2026-08-27 — **`BitMask.bits` is `Vec<u8>`, not §6.0's `Vec<u64>`.** `as_bytes(&self) -> &[u8]` is
  frozen and returns a *borrow*. Producing one from a `Vec<u64>` needs a reinterpreting cast, and
  `tvx-core` is `#![forbid(unsafe_code)]`; the alternatives were allocating a fresh `Vec<u8>` on every
  call (so `as_bytes` could not return a reference at all — a signature change) or dropping the forbid.
  The field is **private**, so §12.3's frozen public surface is untouched, but §6.0's snippet spelled the
  storage out, so the snippet is corrected in the same commit. `count_ones` still folds eight bytes at a
  time through `u64::from_le_bytes`, so nothing is lost but the type name. `new_all(len, true)` and
  `from_bytes` both mask the tail bits past `len` to zero — otherwise `count_ones` over-reports by up to
  seven on any length that is not a multiple of 8.
- 2026-08-27 — **A LUT line that does not parse is skipped, not fatal; a file that yields *no* entries
  is `Error::Parse`.** Real `FreeSurferColorLUT.txt` and SimNIBS LUTs carry trailing prose and ragged
  columns (`final_tissues_LUT.txt` writes `2 \t  Gray-Matter`, an id followed by space *and* tab), so a
  strict line parser rejects working files. Rejecting the whole file only when it produced nothing keeps
  a genuinely wrong format loud.
- 2026-08-27 — **`parse_freesurfer` takes the alpha column verbatim.** `LabelEntry::color` is RGBA and
  FreeSurfer's fourth column is documented as transparency, but the committed
  `labels_freesurfer_LUT.txt` fixture's authored expectation in `testdata/manifest.json` is
  `[255, 0, 0, 0]` — the column as written. Inverting it here would contradict the fixture. This is the
  opposite of `tvx-mesh-io`'s `.annot` reader, which *does* invert, because a FreeSurfer **colortable**
  is a different container with a documented transparency field; the two are not the same format and
  the divergence is deliberate.

## 2026-08-27 — Phase 1 integration, `tvx-geom` (§6.3)

`p1/geom` was never created — the branch does not exist and `crates/tvx-geom` reached the
integrator as the Phase-0 `unimplemented!()` stub. The crate is implemented here, by the
integrator, so that Phase-1 gate items 2 and 7 have something behind them.

- 2026-08-27 — **`extract_boundary` keeps tag-differing pairs, so the tri-less fixture yields 56
  faces, not 48.** `crates/tvx-geom/tests/fixtures.rs::extract_boundary_rescues_a_tri_less_mesh`
  was authored in Phase 0 expecting 48 (the exterior alone). §6.3 (ARCHITECTURE.md line 1081) says
  the function "keeps singletons **and** tag-differing pairs", and `mesh_tetonly.msh` has two tet
  tags (24 + 24) with 8 tag-differing interior faces. Implementing the test would have made a
  tri-less mesh render a *different* surface from an identical mesh that happens to store its
  triangles — the exact opposite of what the function exists for. The assertion was corrected, not
  the implementation, and the reading is confirmed on real data: `extract_boundary` on
  `m2m_ernie/ernie.msh` returns **1,177,213** faces, byte-for-byte the count of triangles the file
  stores, and an independent derivation splits them 128,614 exterior + 1,048,599 tag-differing —
  §6.3's published `[DATA]` numbers, reproduced exactly.
- 2026-08-27 — **`orient_surface` reports 8 non-manifold edges on the lattice fixture, not 0.** Same
  test file, same cause: a tagged tissue surface is a *complex*, not a manifold. The fixture's 8
  interface triangles meet the exterior wall along the equator, giving 8 edges with three incident
  triangles. Real data agrees and is now asserted: `ernie.msh` reports components 696 /
  open 510 / non-manifold 10,311 / flipped 41. A report of 0 would mean the function was not
  looking. Relatedly, a non-manifold edge contributes **no** adjacency, so the fixture surface is
  3 components rather than 1 — walking through an ambiguous edge would propagate one arbitrary
  winding choice across the seam and silently mis-orient whichever side lost the coin toss.
- 2026-08-27 — **`tag_surfaces` reports `OrientReport::default()`.** §6.3 says it "does no geometry
  work beyond grouping and normals", and orienting is a topology pass. Nothing is lost: §6.4's
  `load_time` runs `orient_surface` on `Mesh::tris` once at load and carries the real report in
  `MeshMeta`. `extract_boundary` *does* orient, because it is constructing a surface from scratch
  and the per-tet outward winding it starts from is only locally consistent.
- 2026-08-27 — **`morton_reorder` sorts `(code << 32) | index` keys, not indices.** The obvious
  spelling — sort an index array, look up `codes[i]` each pass — gathers randomly across a 19 MB
  array three times and measured **478 ms** on ernie, against §6.3's "< 250 ms WASM" budget. Moving
  the code into the key so every radix pass reads sequentially took it to **109 ms** `[M2Max]`.
  The permutation is applied by gathering into a fresh buffer rather than by following cycles in
  place: the in-place walk is random on both the read and the write, needs a `visited` array, and
  measured slower. Its 208 MB transient on `ernie_seeg.msh` is taken well after the parse, whose
  own peak is far higher, so it does not move the §9.2 high-water mark.
- 2026-08-27 — **`PointLocator` buckets by centroid and sizes its cell to the largest tet extent.**
  That is what makes a 3x3x3 neighbourhood search exhaustive with no "grow the radius" loop: if the
  cell is at least as large as any tet on each axis, the centroid of a tet containing `p` is at
  most one cell from `p`. Bucketing by AABB overlap instead would be correct too but multiplies
  `items` by the average number of cells a tet touches, against the 1.0 GB bar.
- 2026-08-27 — **`marching_cubes` decomposes each cell into six tets rather than carrying a
  256-entry case table.** Both marching functions then share one simplex kernel. The Freudenthal
  decomposition about the `0-7` diagonal is agreed on by every neighbouring cell, so the surface is
  watertight; it emits more triangles than a tuned table would. §6.3 asks for a correct surface and
  the isosurface *layer* is Phase 2's, so correctness-per-line-of-code won. A wrong row in a
  hand-transcribed 256-entry table is a silent hole, and there is no fixture that would catch it.
- 2026-08-27 — **A cap vertex introduced by a *second* clip plane carries a degenerate
  `CutInterp` (`n0 == n1`, `t = 0`).** With more than one plane, §6.3 requires each `Cut` to be
  clipped by the others; a vertex created by that clip lies on the clip plane, not on a mesh edge,
  and `CutInterp` can only name a mesh edge. There is no exact representation in the frozen struct.
  Single-plane cuts — everything Phase 1 exercises — are unaffected and exact. **Phase 2's clip-plane
  work should revisit this**, either by widening `CutInterp` or by having the engine fall back to a
  barycentric sample for vertices flagged this way.
- 2026-08-27 — **§6.3's oblique cut count could not be reproduced, because §6.3 does not say which
  oblique plane.** The axial number *does* reproduce exactly — 62,966 cap triangles for the plane
  through the bounding-box centre, which is what pins "the axial plane" to that one and is now
  asserted. For the oblique, `normalize([1,1,1])` through the world origin gives 76,024 and through
  the bbox centre 76,217; §6.3 publishes 67,189. The normative property — output bit-identical with
  and without the block index — is asserted on both planes and holds.
- 2026-08-27 — **`tvx-mesh-io` re-exports `field_stats` / `field_stats_parts`.** Additive, like that
  crate's own `read_gifti_labels` / `read_msh_opt_names`: §6.2 does not name them, but `elm_to_node`
  and `node_to_elm` must build a `Field` / `ElmField` and every such struct carries `stats`.
  Duplicating the 65536-bin accumulator in a second crate would be two implementations of one
  normative rule.
- 2026-08-27 — **`tvx-wasm`'s `geom` feature is now `default = ["geom"]`.** The switch is kept
  rather than deleted so `--no-default-features` still builds the module whose geometry ops answer
  `Error::Unsupported`, which is what `packages/wasm/e2e/geometry.spec.ts` probes at runtime.

## 2026-08-27 — Phase 1 integration, `packages/engine` (§7) and the wiring

`p1/engine` was never created either. The engine foundation is implemented here, by the integrator.

- 2026-08-27 — **`api.ts` gained a third import, and §4.7 was amended in the same commit.** §4.7 said
  the frozen facade "imports exactly two things … and nothing else", but `create()` has to return a
  *working* engine **synchronously**, and the working engine is another module. The alternatives were
  inlining the whole WebGL2 renderer into the frozen file, or leaving `create()` throwing while
  `index.ts` quietly exported a different one — a second `create` that behaves differently from the
  documented one is worse than an honest contract edit. `./engine` imports back from `./api` with
  `import type` only, so there is no runtime cycle.
- 2026-08-27 — **The engine does not resize the canvas; the embedder owns the drawing buffer.** §8's
  view grid already keeps it the size of its host in device pixels with a `ResizeObserver`. The
  engine's first version *also* resized it, from `clientWidth * devicePixelRatio` — which is stable
  only at DPR 1 and doubles the buffer every frame at DPR 2, because a canvas with no CSS size
  reports its backing-store width as its layout width. The engine now reads `canvas.width/height` as
  an input and derives the DPR from `canvas.width / canvas.clientWidth`.
- 2026-08-27 — **The 2D chrome is drawn with a 5×7 bitmap font defined in the repository.** §8 calls
  the orientation letters a laterality-safety requirement and §11 requires the chrome in every
  golden, compared at `maxDiffPixelRatio ≤ 0.002` across macOS and ubuntu-24.04. Any `fillText`
  rasterises differently on the two, which would make the letters the least reproducible pixels on
  the page. The glyphs are bytes in `render/font.ts` and a unit test asserts every one is 35 bits.
- 2026-08-27 — **`loadVolume` asks for `wantLinear: false`.** §6.1 says `want_linear` is false when
  the layer is a label or `interpolation === 'nearest'`, but no layer exists yet at load time. It
  gates ladder **rows 1–2 only**, which are the label rows, so `false` is correct for both cases: a
  label volume takes the `R8UI`/`R16UI` dense-index path §7.3 needs, and a scalar volume is
  unaffected. Asking for `true` silently turned every label volume into a filterable `R8` grey ramp —
  found by the analytic label test, not by reading the code.
- 2026-08-27 — **The label palette is indexed by dense index with no offset, and background is
  decided by alpha.** `labelIds` is the remap in dense order, so `palette[k]` is the colour of
  `ids[k]`; the first implementation shifted by one and painted every region with its neighbour's
  colour, which looks entirely plausible on screen. Background is *not* "dense index 0": SimNIBS and
  FreeSurfer LUTs give id 0 (`Unknown`) `A = 0` and the shader discards a zero-alpha palette entry,
  which also does the right thing for an atlas whose lowest id is not zero.
- 2026-08-27 — **`interpolation` is applied per draw, not baked at upload.** §4.4 makes it a property
  of the *layer* and §7.2 forbids ever degrading it as a quality knob, because it is a reading rather
  than a rendering setting. §7.1's invariant still overrules the layer: LINEAR on a non-filterable or
  integer format makes the texture incomplete and it samples **0 with no GL error**.
- 2026-08-27 — **`probe()` is synchronous, so mesh rows are one round trip stale.** §4.7 freezes
  `probe(world): ProbeResult` as a synchronous call, but a mesh probe is §6.3's `locate_point` in a
  worker. Volume rows are computed here from `VolumeDataset.data`, which §4.3 keeps on the UI thread
  for exactly this; a mesh row comes from the most recent `locate` for that point, refreshed
  asynchronously on every cursor move, and is absent until the first result lands. Phase 2's info
  panel should either accept that or §4.7 should grow an async probe.
- 2026-08-27 — **The `frame` event, not wall clock, is the frame-time benchmark.** Timing
  `renderNow()` plus `await requestAnimationFrame` reported 8.20 ms median at both 1× and 2× DPR —
  the ProMotion display's 8.33 ms vsync period, measured twice. `EngineEvents.frame` carries `cpuMs`
  and, where `EXT_disjoint_timer_query_webgl2` is present, `gpuMs`; those are the numbers in
  `docs/benchmarks/phase1.md`.
- 2026-08-27 — **§3's `right = cross(up, normal)` makes the coronal preset disagree with the axial
  one about laterality, and the letters tell the truth about it.** With §3's preset normals (axial
  `+Z`, coronal `+Y`, sagittal `+X`) and screen-up (`+Y`, `+Z`, `+Z`), the formula gives `right = +X`
  for axial (subject right on screen right — neurological) but `right = −X` for coronal (subject
  left on screen right). Both are physically real cameras — the coronal one is "looking at the face"
  — but the two panes mirror each other. The formula and the presets are both normative, so both are
  implemented verbatim and `edgeLetters` is derived from the resulting basis, so no pane can ever lie
  about which side is which. **This is worth a contract decision in Phase 2**: either the coronal
  preset's normal becomes `−Y`, or §3 says explicitly that presets are cameras and not conventions.

## 2026-08-27 — Phase-1 verification follow-up: two independent verifiers against the `phase-1` tag

Two verifiers re-ran the gate from a clean clone of the tag. Everything numerical reproduced; what
did not survive was concentrated in §8's 2D chrome — "a laterality-safety requirement, not
decoration" — and in the §11 rows whose *named* test had been reinterpreted rather than written.
Each entry below names the problem, the fix, and the evidence.

- 2026-08-27 — **§3's canonical preset normals become `(+Z, −Y, −X)`, and the coronal pane stops
  contradicting its own badge.** The entry above (Phase-1 integration, `packages/engine`) called the
  formula and the presets "both normative" and deferred the disagreement to Phase 2. That framing
  does not survive contact with the rest of the contract. §3's handedness bullet is
  `right = cross(up, normal)` in **neurological** *(subject left on screen left, the default)*: the
  parenthetical is the definition, the formula is the mechanism, and where a preset makes them
  disagree it is the preset that is wrong — a `NEU` badge over a pane whose subject-left is on
  screen-right is a false statement about laterality no matter how honestly the edge letters are
  derived. Independently, §11's three mandatory orientation tests demand the left-anterior-superior
  cube on screen-**left** in neurological in **each** of the three 2D views, and `(+Z, −Y, −X)` is
  the *only* preset triple that satisfies all three at once (axial `right = +X`, coronal `+X`,
  sagittal `−Y`). Nothing about the displayed slice changes: a plane and its opposite normal are the
  same plane, so the sign picks only which side the camera sits on — coronal is now viewed from
  behind rather than from the face, and sagittal from the subject's left, which is also what puts
  anterior on screen-left. §3 was edited in the same commit (§12.3's rule), and the goldens
  `gate3-t1-2x2-chrome` (coronal and sagittal panes) were regenerated with the visual change stated
  in the commit body. **Evidence:** with coronal `+Y` the new coronal orientation test fails — the
  bright pixel lands on screen-right — which is exactly the test §11 named and Phase 1 did not write.
- 2026-08-27 — **§11's three mandatory orientation tests now exist, in
  `packages/engine/test/e2e/orientation.spec.ts`.** They were the one §11 row with a fixture built for
  it and nothing else (`testdata/vol_asym.nii`, Phase 0). The spec measures the bright octant's
  centroid out of the dataset's own samples and maps it through `testdata/manifest.json`'s affine, so
  it proves the fixture is left-anterior-superior rather than assuming it; the expected pixel is
  computed from §3's basis rules written out as literals, never imported from `view/geometry.ts`; and
  the mirror half asserts a whole scanline, not just one pixel, because §3 defines `radiological` as
  a mirror about the vertical screen axis. The fixture is a 2-value integral volume, so §6.1's
  `is_label` sends it down the `R8UI` + palette path where a non-cube pixel inside the volume is
  *exactly* the scene background — which is what makes both halves of the assertion an exact RGBA.
- 2026-08-27 — **§8's corner "slice index" is derived from the affine, like the letters, and the
  chrome is now read back out of the framebuffer.** `sliceIndex()` hardcoded a voxel axis per view
  mode (`sagittal → voxel[0]`, `coronal → voxel[1]`, else `voxel[2]`), which is wrong for every
  SimNIBS `m2m` volume: `T1.nii.gz` maps world `x ← k`, `y ← −i`, `z ← j` `[DATA]`, so its axial
  planes step along voxel `j` and its sagittal planes along voxel `k`, and the shipped goldens read
  `AXIAL … SLICE 104` / `SAGITTAL … SLICE 128` where 128 / 104 belong. The rule is now
  `argmax_a |dot(normal, A[:,a])|` — `voxelAxisAlong()`, the same expression §7.5's slice step
  already used, so there is one definition and oblique is not a special case.
  **The golden could not have caught this**: the corner block is ~300 px of a 589,824 px pane, so a
  wrong number is 0.05 % of the image against a `maxDiffPixelRatio` of 0.002. So
  `test/helpers/chrome.ts` decodes the chrome instead — the font is a 5×7 bitmap in the repository,
  which makes an exact template match possible — and gate 3 now asserts all three corner lines, the
  four edge letters and the badge, per pane, on the pixels a user sees. Reverting either this fix or
  the preset fix fails it.
- 2026-08-27 — **The edge letters were half a pixel off, and dropped their top row.** `buildChrome`
  placed them at `heightPx / 2 − (GLYPH_H · s) / 2`, which is a half-pixel for an odd glyph height;
  a glyph quad straddling pixel centres samples the NEAREST atlas one texel row late, so every
  vertically-centred letter in every golden rendered without its first row — enough to make a
  template match call an `R` an `X`. It is rounded to the pixel grid now. Every other string the
  chrome draws was already integral. Six goldens move by 14–121 px each as a result.
- 2026-08-27 — **`gate5-overlay-composite-oblique.png` was showing chrome its own test disables.**
  Regenerating it dropped a crosshair and a corner block, 2,802 px (0.475 %) — under the 1 % macOS
  ratio, which is why it had been passing, and *over* the 0.002 % the `ubuntu-24.04` authority uses.
  The golden now matches what the test actually renders. This is a second instance of the same
  lesson as the slice index: a tolerance wide enough to absorb a rasteriser is wide enough to absorb
  a whole annotation block, so anything that must be *right* rather than merely *stable* needs an
  assertion of its own.
- 2026-08-27 — **The auto-centre goes through `setCursor`, so it emits.** `#onFirstDataset` assigned
  `this.#scene.cursor = center` directly. Every pane's crosshair and corner annotation read
  `scene.cursor`, but §8's `Cursor` block and coordinate bar are driven by `EngineEvents.cursor`
  alone — `store/controller.ts` seeds the cursor once at `attach()`, before any dataset exists, and
  updates it only from that event. So after the first load the app described world (0,0,0) while
  every crosshair described the bounding-box centre: on `T1.nii.gz` the panes annotated
  `RAS 3.8 26.7 −16.1` and the readout said `0.0 0.0 0.0 / voxel 154 144 100 / value 23597`, which
  is a real intensity from ~33 mm away. Routing through `setCursor` also refreshes the mesh probes
  for the new point, which the assignment skipped as well.
- 2026-08-27 — **§11's "macOS/ANGLE leg" is now a Playwright project, `chromium-angle`.** Gate item 6
  was recorded as met, but its R16 half executed nowhere: the engine config declared a single
  `chromium-swiftshader` project, both CI runners ran that same `pnpm e2e`, SwiftShader has no
  `EXT_texture_norm16`, so `test.skip(!norm16, …)` fired unconditionally — on the format the shipping
  app actually gives `T1.nii.gz`. The new project runs the full Chromium headed with
  `--enable-unsafe-swiftshader` deliberately absent, filtered to `grep: /@angle/`. It captures no
  golden, because §11 keys goldens on the renderer class and `test/golden/angle-metal/` does not
  exist — a golden test there would demand a capture, not a comparison. On a GPU-less runner the leg
  falls back to software and the R16 test skips with its reason, which is an honestly empty leg
  rather than a missing one. **Evidence:** `[chromium-angle] @angle gate 6: the R16 branch … (614 ms)`
  on `ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max)`.
- 2026-08-27 — **The app's gate spec launches the project's own target.** `packages/app/e2e/phase1-gate.spec.ts`
  hardcoded `launchApp('dev')` in `beforeAll`, so under the `packaged` project it launched the dev
  build and never self-skipped: three tests reported green under `[packaged]` with no artefact in the
  tree, and the `[packaged]` benchmark lines were the dev target measured a second time.
  `e2e/fixtures.ts::packagedUnavailable()` exists precisely to prevent that and every other app spec
  already used it. The same spec now also asserts §8's readout on the DOM — the coordinate bar and
  the `Cursor` block against `scene.cursor` — which is the app-visible half of the auto-centre bug.
- 2026-08-27 — **§4.7 names the five members the app was duck-typing, and the parallel interfaces are
  gone.** `resetView`, `cameraPreset`, `setAnnotations`, `heapBytes` and `renderNow` existed on the
  concrete engine only; `packages/app/src/renderer/src/engine/commands.ts` re-declared three of them
  as optional interfaces and probed with a runtime `hasAll(...)` guard, and the engine's own e2e
  reached them through `engine as unknown as { … }` casts — so `create()` returned an `Engine` that
  type-checked *none* of those calls. The earlier entry recorded the gap and said "leaving it
  duck-typed forever is not the third option"; this is the first of the two closures it named.
  §8's own rule decides it: *"Everything the UI can do must be reachable from the `Engine` API
  alone"*. ARCHITECTURE §4.7 was edited in the same commit (§12.3), `MockEngine` grew the five
  members, `NoGlEngine` grew `renderNow`, `commands.ts` is deleted and every cast in the specs with
  it. `MockEngine`'s docstring now says what it is — a **compile-time** proof that the facade is
  implementable with no GL, which is exactly what fails the build if `Engine` grows something
  unimplementable — and points at `NoGlEngine` for behaviour.
- 2026-08-27 — **§11's named tests now assert what §11 names.** Three of them had been
  reinterpreted, each defensibly on its own and collectively leaving the row's point uncovered:
  * *Overlay compositing* used `segmentation/labeling.nii.gz` instead of the named
    `Thalamus_TI_subject_TI_max.nii.gz`. That is not a smaller version of the same test: a label
    volume takes §7.3's `R8UI` + palette branch, where opacity is decided per label, so the
    **continuous-scalar colormap-and-blend path the row is about was covered nowhere**. The named
    file is used now, and "exactly 100 %" is asserted as *independence over every pixel of the pane*
    rather than over a 39×39 sample grid: at opacity 1 the composite must not change when the layer
    underneath it does, tested twice — by hiding the base and by re-windowing it — with both
    perturbations first shown to change the base on its own. §11's parenthetical "genuinely
    different extents" was also simply wrong: all three volumes share the 256×256×208 grid and the
    same affine to four decimals `[DATA]`. §11's row was corrected in the same commit.
  * *Pick* asserted one of four clauses. The missing `world`-within-1 mm clause had no reference
    point written down anywhere, so one is constructed instead: the default 3D camera has identity
    rotation, sits on +Z and looks down −Z, so the pane-centre pick lands on the top of the scalp
    with the outward normal along +Z — and `locate` 1 mm outward returns null while 1 mm inward
    returns tag 5. That brackets the hit to ±1 mm *and* is §11's `locate` cross-check, through a
    second code path (§6.3's `locate_point` in the worker). The cross-check is made 1 mm inside
    rather than on the surface because a point exactly on a boundary face is a floating-point coin
    toss for a containment test. The slice-index clause is read off the panes themselves with the
    glyph decoder. Note that "all three changed" cannot be literally true for this pick: it is on
    the camera axis through the bbox centre, so only the axial index can move; the test asserts the
    three shown indices are exactly what the picked point implies, and that the triple changed.
  * *A 4-tet mesh with tag colours from a fixture LUT* had no pixel assertion at all — the mesh
    renderer's colour path shipped with a coverage count. It has one now, and it needs no constant
    from the shader: §7.4's headlight gives `P = C·s + t` with `s` and `t` shared by all three
    channels of a pixel, so each sampled pixel is **fitted** against its own tag's colour and the
    residual is the test. Measured residuals are 0.09 and 0.11 of 255; fitting the *other* tag's
    colour to the same pixel needs a negative `s`.
- 2026-08-27 — **`Mesh.label_table` and `MshOptions.tag_name` exist; `read_gifti_labels` and
  `read_msh_opt_names` are gone.** The earlier `tvx-mesh-io` entry above argued for those two
  additive functions and then said what should happen next: *"The integrator should fold them into
  §6.2 — most naturally as `Mesh.label_table: Option<LabelTable>` and
  `MshOptions.tag_name: Vec<(i32, String)>` — and then delete them."* The tag did neither, so a
  frozen crate's real public surface was wider than the contract that freezes it, and the tissue
  names for `ernie.msh` — whose only source is the `.msh.opt` sidecar, the file having no
  `$PhysicalNames` — were reachable only through an undocumented door. Done as described, with §6.2
  edited in the same commit (§12.3). `field_stats` / `field_stats_parts` stay, and are now *named*
  in §6.2 rather than merely present: `tvx-geom` cannot build a `Field` without them and a second
  65536-bin accumulator would be two implementations of one normative rule. A side benefit:
  `load_mesh` no longer parses a `.label.gii` twice — the table rides on the mesh.
- 2026-08-27 — **AGENTS rule 2's missing halves, filled in for six `tvx-geom` functions.**
  `marching_cubes` had **no** test in any crate — a §6.3 export, a §6.4 wasm export and a §6.5.2 op,
  covered only by a `positions.length > 0` smoke check from TypeScript. It has an analytic one now:
  an implicit sphere at two resolutions, asserting area/4πr², enclosed volume by the divergence
  theorem, vertex radii within one voxel of the true surface, and outward winding — with the *change*
  between the two resolutions asserted too, which is what separates "correct" from "close at one
  grid". Measured: area 0.99741 → 0.99936, volume 0.97625 → 0.99371, outward 0.954 → 0.989. Plus a
  real-data test on `final_tissues.nii.gz`, where the isosurface at 0.5 must enclose the labelled
  voxels' own volume (ratio 1.018 — the contour sits half a voxel outside the last labelled centre,
  so slightly over 1 is the correct sign). `face_normals` likewise had none. `elm_to_node` /
  `node_to_elm` / `morton_reorder` / `label_centroids` gained the synthetic half they lacked, and
  `build_topology` / `isolate` / `vertex_normals` the real-data half.
  Two of the new tests are worth naming: §6.3's locality claim ("with file order a per-64-block AABB
  reject at the mid-axial plane visits 4,722,624 of 4,722,625 tets — zero speedup") had never been
  asserted anywhere, and now is — mean block half-extent 83.77 mm in file order against 3.46 mm in
  Morton order, and 73,791 of 73,792 blocks touched against 3,879. And the fixture's *own* locality
  is deliberately **not** asserted: on a 48-tet lattice whose file order already walks cube by cube,
  Morton is measurably *less* local (6.02 mm mean step against 4.91), so a synthetic version of that
  assertion would have been a false one.
- 2026-08-27 — **§11's Surface-invariant row is asserted on both meshes now, with its own split.**
  `ernie-seeg.msh` (2,323,873 nodes — past 2²¹, where a packed 3×21-bit face key aliases) appeared
  only in a doc comment. The new test derives the boundary from the 13.2 M tets and gets 2,629,579,
  then uses `build_topology` to assert the split §11 actually writes down: 202,318 exterior +
  2,427,261 tag-differing interior. Note the two censuses are **not** comparable key for key —
  `extract_boundary` labels a derived face with its *tet* tag while `tag_surfaces` uses the stored
  `1xxx` tri tag — so only the totals and the per-file electrode counts are cross-checked.
- 2026-08-27 — **§9.1 row 10 is met, measured in wasm, and its recorded evidence was wrong.** The
  row's target is a WASM one; Phase 1 measured `plane_cut` **natively** and printed the figure in
  `docs/benchmarks/phase1.md` under a heading carrying the WASM budget — two different numbers with
  one label, which is what kept the miss invisible. Measured properly, the first Phase-1
  implementation was 16.1 ms against a < 15 ms bar, and the row's own evidence cell (2.7 ms axial /
  3.1 ms oblique `[M2Max]`) is a v1 *prototype's* number this implementation does not reproduce —
  4.8× off, and the largest single discrepancy anywhere in §9.
  Two changes to `plane_cut` closed it, both about what the hot loop allocates and moves rather than
  about the maths: the cut polygon is a fixed-size stack buffer instead of a `Vec` per cut tet
  (~63,000 allocate/free pairs per plane on ernie, cheap under the system allocator and not under
  wasm's dlmalloc), and the tag-boundary pass sorts 24-byte keys carrying an index into
  `edge_segments` instead of 48-byte tuples carrying the endpoints. Output is bit-identical — the
  §11 cut-index-equivalence tests are what say so.
  **Now: 12.9 ms axial / 16.6 ms oblique in wasm** (`node scripts/bench-wasm-cut.mjs`), 10.4 / 13.7 ms
  native, and 16.9 / 21.2 ms for the *worker round trip* in Chromium
  (`packages/wasm/e2e/realdata.spec.ts`, which is the measurement Phase 1 shipped none of). Those
  three measure three different things and the benchmarks doc now says so in a table rather than
  letting one stand in for another. The e2e's own assertion is deliberately loose — §9.1 is Phase 3's
  to sign off, and a tight wall-clock bar in CI is a flake generator — so it catches a 4× regression
  and the printed line is the evidence.

## 2026-08-27 — Phase-1 audit and the seams for Phase 2

- 2026-08-27 — **A third pass over Phase 1, clause by clause, recorded in
  `docs/review/2026-08-27-phase1-audit.md`.** The two verification passes asked "does the gate
  reproduce" and got yes. This one asks "which contract clauses does the code satisfy", over 142 rows
  of ROADMAP's three Phase-1 engine/app bullets, §7.5's every binding, §7.2, §7.0, §7.1, §4.7, §5 and
  §8: **97 implemented, 18 partial, 27 missing**, of which 21 are Phase-2/3 features by ROADMAP. The
  one Phase-1-scope hole is **§7.5's pointer interaction — all of it**. `packages/engine/src` installs
  no pointer handler anywhere, so 2D click-to-cursor, wheel-slice, ⌘-wheel zoom, right-drag
  window/level, middle/space pan, `Shift+drag` opacity, 3D orbit/pan/dolly and double-click pick are
  absent, and with them the `interacting` state (§7.2), the `hover` event (§4.7) and §8's `Mouse`
  block, which is wired to an event nothing emits. The keyboard half of §7.5 is complete. Recorded
  rather than fixed: it is one coherent subsystem, it is P2-01 in the ownership map, and it is E-SCENE's.
- 2026-08-27 — **`cancelDataset` is a no-op when no load is in flight.** It used to fall through to
  `#teardown`, terminating a live worker while leaving the dataset in the scene — every subsequent
  `locate` probe on that mesh went unanswered and `heapBytes` went `undefined`, with all four panes
  still drawing it. §4.7 scopes the method to "an in-flight load" and gives `removeDataset` the job of
  closing a dataset; the terminate belonged to the second, not the first. Reachable only by calling
  `cancelDataset` on a finished dataset, which the app never does — so no test changed, which is also
  why it survived two verification passes.
- 2026-08-27 — **One slice-quad half-extent formula, in the renderer.** `TetravoxEngine.#quadHalfFor`
  and `Renderer.#quadHalf` computed the same quantity differently: the engine's, used **only** by the
  pick pass, omitted the pan term. §7.2.3 requires the pick pass to reproduce the main pass exactly,
  so a panned 2D pane could be picked against a quad narrower than the one on screen and a click near
  the edge would return `null` over a visible slice. The engine's copy is deleted and
  `Renderer.quadHalfFor` is the single definition. No golden moves: the quad is planar and coplanar
  with the cursor, so its size changes neither a rendered pixel (the fragment shader discards outside
  the volume) nor an unprojected `world`.
- 2026-08-27 — **`screenshot({background:'transparent'})` clears to zero alpha.** It previously read
  back a frame already cleared to `scene.background`, whose alpha is 1, and returned an opaque PNG for
  a documented §4.7 option. The clear colour is swapped for that one render and restored in a
  `finally`. Punching the background colour out of the returned pixels — rejected: it cannot tell a
  background pixel from a fragment that happens to match it.
- 2026-08-27 — Two smaller ones in the same commit: `removeDataset` re-points a dangling
  `activeLayerId` the way `removeLayer` already did (otherwise `[`/`]` and `v` were no-ops until the
  user clicked another row), and `destroy()` clears `#lastViewProj` / `#lastRects` and the mesh probe
  cache. (That last one was `#locateCache` on `engine.ts` when this was written; the layer split moved
  it to `MeshLayerRuntime.#located`, cleared in `dispose()`, which `destroy()` calls. Same behaviour,
  different home.)
- 2026-08-27 — **`#renderFrame`'s `frame.cpuMs` is cumulative, and is deliberately NOT fixed here.**
  `t0` is taken before the first pane and the event is emitted inside the per-view loop, so in a 2×2
  layout the fourth pane reports the whole frame. Correcting it changes every number in
  `docs/benchmarks/phase1.md`, and re-baselining a published benchmark is not a refactor's business.
  §9's performance pass (Phase 3) owns it; it is in the audit's code-quality section so it is not
  later mistaken for a regression.

## 2026-08-27 — the Phase-2 seams, and who owns what

- 2026-08-27 — **`packages/engine/src` is one file per layer kind, per pass and per program, and
  `packages/app/src/renderer/src` is one directory per panel.** Phase 2 puts four to seven agents
  into two packages that Phase 1 shipped as a 1,057-line `engine.ts` and a 530-line `renderer.ts`,
  and AGENTS rule 3 is disjoint ownership. The seams chosen are the ones the contract already
  describes, so nothing was invented: §4.4's four layer kinds became `src/layers/*` behind a
  `Record<Layer['kind'], …>` registry (the six scattered `if (layer.kind === …)` branches were not
  exhaustive — a fifth kind compiled and drew nothing); §7.2's pass list became `src/render/passes/*`
  behind a `Pass` interface, leaving `renderer.ts` at 134 lines of order, viewports and framebuffers;
  §7.1's "`#include`-style chunks" became `src/shaders/*` with `chunks/{caps,ladder,lut}.ts`; §7.2's
  pass-3 items became `src/overlay/*`. **Behaviour is identical and every golden is byte-identical**,
  which was checked twice over rather than asserted: throwaway tests compared all ten assembled
  shader sources and three composed chrome vertex buffers against the pre-split implementations
  before the old files were deleted, and then the whole e2e suite ran on both Playwright projects.
  A single "god object with a comment saying which agent owns which region" — rejected: a comment is
  not a merge boundary.
- 2026-08-27 — **`CutManager` and `IsolateManager` exist before their GPU sides do.** `plane_cut`'s
  output feeds two unrelated consumers — §7.4's 3D caps and the 2D overlay's `contoursIn2D` /
  `fillIn2D`, where §7.4 says `Cut.edge_segments` "is **not** used in the 3D passes" — and two
  callers would issue two cuts for one plane set, doubling 12.9 ms per drag frame in wasm and letting
  the two disagree about which cut is current. `IsolateManager` exists for §6.5.2's "the client owns
  `maskId` and must `freeMask`": it frees the previous mask **after** the new one lands, frees a
  superseded isolation's mask, and frees on dispose because `removeLayer` leaves the worker alive.
  Both are unit-tested against a fake client that resolves calls by hand, so the ordering a race
  depends on is the test's to choose. Writing them when the first consumer needs them — rejected:
  the second consumer would then have written its own.
- 2026-08-27 — **`docs/PHASE2-OWNERSHIP.md`: seven owners, eleven additive-only shared files, one
  integration order.** Every ROADMAP Phase-2 bullet and every `P2-xx` from the audit is assigned to
  exactly one owner, with its §11 analytic-pixel and golden obligations and its real-data gate items.
  The frozen §12.3 interfaces are **not** shared files — they are closed, and only W-WASM may edit
  them, with an ARCHITECTURE edit in the same commit.
- 2026-08-27 — **W-WASM is not "none": two protocol gaps.** (1) `DatasetRef.fingerprint` has no
  producer — §4.6 requires it, §5 rule 3 forbids computing it on the UI thread, and neither
  `VolumeMeta` nor `MeshMeta` carries the field, so it must be digested in the loader over the input
  bytes before §5 rule 5 drops them. (2) A **volumetric** `GlyphSpec` has no origin source: no §6.5.2
  op returns element centroids or bulk node positions. Surface glyphs need nothing new
  (`SurfacePayload.positions` + `ownerElm` + a field texture), so this one is a scope decision
  E-DERIVED must take before writing the shader. Nine other Phase-2 needs were checked against the
  protocol and are already covered; they are listed in the map so nobody re-files them.
- 2026-08-27 — **`gl/state.ts`: one state tracker, five complete named blocks, no raw depth/blend/cull
  call in a pass.** The audit's code-quality risk 2 survived the pass split: `passes/slice.ts` and
  `passes/overlay.ts` held the same three lines verbatim, `passes/mesh.ts` and `passes/pick.ts` each
  rolled their own set, nothing restored what it changed, and `passes/pass.ts` had codified "a pass
  owns its GL state" as the design. Combined with `renderer.ts`'s additive-only "append a pass to the
  sequence" rule that makes the *fifth* pass (E-DERIVED's contours) and the *sixth* (E-SCENE's gizmo
  items) inherit whatever the fourth left enabled — a merge boundary that only holds by luck. Each
  block now names **every** tracked field (`DEPTH_TEST`, `depthFunc`, `depthMask`, `BLEND`,
  `blendFunc`, `CULL_FACE`, `cullFace`), so a pass's entry state is independent of what ran before
  it, and the tracker issues only the calls that change, so completeness is free per frame. §7.4's
  cap rule — "disable `CLIP_DISTANCE0_WEBGL + i` for the draw of plane *i*'s cap" — is
  `clipDistances(count, except)` here rather than six copies in E-MESH's and E-DERIVED's files; it
  emits no call while the set is empty, which is what keeps it safe on a context with no
  `WEBGL_clip_cull_distance`. **`SCISSOR_TEST` is deliberately not tracked**: `renderer.ts` and
  `engine.ts` set it around panes and frames, and two owners of one piece of state is how a tracker
  goes stale. `Renderer.renderView` applies a block *before* `gl.clear`, because
  `clear(DEPTH_BUFFER_BIT)` is masked by `depthMask` and previously depended on `passes/mesh.ts`
  having restored it. Every golden is byte-identical and the e2e suite passes on both Playwright
  projects — state is state, and each draw sees the same state it saw before. Landing it after the
  Phase-2 branches, when six passes and four owners would have to be converted at once — rejected:
  four is the cheapest this ever gets.

- 2026-08-27 — **`docs/PHASE2-OWNERSHIP.md` amendments, before any Phase-2 branch was cut.** Three
  seams in the first draft would have become merge conflicts. (1) **P2-09 is a frozen-file change and
  it is E-SCENE's, by one named carve-out.** The in-plane cursor nudge needs a new `Engine` member —
  `stepCursor(viewId, steps)` is "±1 voxel along the view normal" and the app may not compute the
  basis (§8) — so the map both assigned P2-09 to E-SCENE and closed `api.ts` to everyone but W-WASM.
  Carving it out beats moving the item to W-WASM: the interface change and its only implementation
  are the same feature, and splitting them across branches that merge two stages apart leaves
  `Engine` with a member nothing implements. The carve-out keeps every other term of the frozen rule,
  including the ARCHITECTURE and DECISIONS lines in the same commit. (2) **The shared-file list was
  short by seven.** By the doc's own definition — a file more than one owner appends to —
  `scene/defaults.ts`, `layers/runtime.ts`, `shaders/index.ts`, `overlay/index.ts`,
  `shaders/chunks/caps.ts`, `app/.../engine/mockEngine.ts` and the new `gl/state.ts` all qualified
  and none was listed; each now carries the in-file banner the other eleven already had.
  `shaders/chunks/caps.ts` in particular sat inside E-SLICE's directory while all four programs read
  it, which its own header had already said was nobody's file. (3) **The "Owners at a glance" table
  contradicted the detail sections** on `panels/`, `keyboard/` and `shaders/chunks/`, and agents read
  the glance table first; it now says which directories are split and where the split falls, and a
  closing clause makes the map total rather than leaving `overlay/*`, `app/.../lib/` and
  `layers/runtime.ts` unclaimed. Also recorded: audit id **P2-11** now appears by name (it is §10's
  whole "missing (Phase 2)" column, not one feature, so its six contents are mapped in a table), and
  "element info" is split *produce* (E-SCENE) from *render* (A-SHELL) instead of appearing twice.

- 2026-08-27 — **The macOS `test` leg runs on push-to-`main` and `workflow_dispatch`, never on
  `pull_request`; ubuntu-24.04 runs on everything.** GitHub bills macOS runner minutes at **10x** the
  Linux rate on a private repo, and the first CI runs showed a full `test` leg is minutes, not seconds,
  so every PR iteration was costing ten Linux runs' worth of budget for a second opinion on a matrix
  whose *authority* is the other leg: §11 makes `ubuntu-24.04` the golden authority, and §11's own rule
  is that a golden passing on macOS and failing on ubuntu must be regenerated on ubuntu. Implemented in
  the **matrix**, {% raw %}`os: ${{ github.event_name == 'pull_request' && fromJSON('["ubuntu-24.04"]') ||
  fromJSON('["ubuntu-24.04", "macos-latest"]') }}`{% endraw %}, so the job list, the steps, every cache and the
  packaged-`.dmg` e2e stay exactly as they were on the events that do run macOS. A job-level
  `if: matrix.os != 'macos-latest' || …` was tried first and is **not a valid workflow**: the `matrix`
  context does not exist in `jobs.<id>.if` (only `github`, `needs`, `vars`, `inputs` do), and the run
  dies in 0 s with "This run likely failed because of a workflow file issue" and zero jobs — measured,
  run 33122604659. `matrix` is evaluated early enough to read `github.event_name`, so dropping the leg
  from the matrix is the mechanism that actually exists. The consequence is accepted and named: a PR green on ubuntu can still turn
  `main` red on a macOS-only failure — the `.dmg` package step and the packaged E2E (ROADMAP Phase-0
  gate 2) exist on no other leg — so macOS is a pre-merge gate on `main` rather than a per-PR one, and
  the fix for such a break is a follow-up PR whose merge to `main` re-runs it. Deleting the macOS leg
  outright — rejected: it is the only place the `.dmg` and its packaged e2e are built, and §12.1
  requires them. Making it `workflow_dispatch`-only — rejected: nothing would then run it by default
  and it would rot. Keeping it on `pull_request` and relying on `paths-ignore` — rejected: this
  repository's PRs touch engine and app code, which is exactly what the leg tests, so it would almost
  never skip.

- 2026-08-27 — **The `chromium-angle` Playwright project is not registered on Linux.** §11's second
  renderer class exists to reach a *platform GPU* — it is the only place `EXT_texture_norm16`, and so
  the R16 branch of the §6.1 ladder, can execute. A GitHub `ubuntu-24.04` runner has no GPU, so the
  project's own fallback assumption ("it still falls back to software and the R16 test skips — the leg
  is then honestly empty") does not hold there: headed Chromium under Xvfb with no GPU intermittently
  hands the page a WebGL2 context that is already gone, and the first shader compile in a fresh page
  fails with an **empty** info log (`vertex shader failed to compile: (no log)`, from
  `src/gl/program.ts`) — the signature of a lost context, never of a GLSL error. Measured on two
  consecutive runs of the same commit (run 33122955835, attempts 1 and 2): attempt 1 failed the first
  `@angle` test, attempt 2 the first two, and the later ones passed in both. Not a product defect and
  not a shader defect: `chromium-swiftshader`, headless, compiles the identical shader and passes every
  one of those same tests on the same runner in the same run, goldens included. So on Linux the leg
  adds no assertion that is not already made — every `@angle` test also runs on the SwiftShader project
  — and adds a flake; `ANGLE_LEG` in `packages/engine/playwright.config.ts` drops it, and
  `TETRAVOX_ANGLE_LEG=1` restores it for a Linux workstation with a real GPU. macOS, where §11 puts the
  leg and where it actually reaches ANGLE/Metal, is untouched. Retrying the flaky tests — rejected:
  `retries: 0` is deliberate in a pixel harness, and a retry would hide a real context loss as easily
  as this one. Forcing the leg to SwiftShader with `--use-gl=angle --use-angle=swiftshader` — rejected:
  it would make the project a duplicate of `chromium-swiftshader` by construction, which is exactly the
  thing §11 says the second renderer class must not be.

- 2026-08-27 — **The app E2E launches Electron with `--disable-gpu` on Linux, alongside the
  `--no-sandbox` §12.2 already required.** On a GPU-less `ubuntu-24.04` runner under Xvfb, WebGL is
  *not* the problem — the renderer string is `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device
  (Subzero)))`, `tvx_ping` round-trips through wasm, and `readPixels` returns `#e5d634` exactly, so
  `phase0.spec.ts`'s drawing-buffer assertions pass. The *display compositor* is: `page.screenshot()`
  comes back with the whole 800×600 canvas box painted **white**, with Chromium's broken-image glyph
  in its corner, while every other pixel of the app — header, footer, the capability table — renders
  correctly (measured on run 33125161134; the artefact is `phase0-dev.png`, and the macOS
  `phase0-packaged.png` in the same run is the correct picture). `--disable-gpu` puts compositing in
  software, where SwiftShader already is, so the frame the test reads back is the frame the page drew;
  WebGL2 survives because `src/main/index.ts` appends `--enable-unsafe-swiftshader` unconditionally,
  and that pair is the combination already measured in `packages/engine/playwright.config.ts`. It is a
  **test-harness** launch arg, in `packages/app/e2e/fixtures.ts`, not a shipped one: a Linux desktop
  with a working GPU composites the canvas normally, and the app already reports `caps.isSoftware` in
  its status bar for the machine that has none. Asserting the canvas only through `readPixels` and
  dropping the screenshot leg — rejected: §11's whole point is that the screenshot and the drawing
  buffer must agree, and on macOS they do.

- 2026-08-27 — **The `test` job is capped at `timeout-minutes: 45`.** A green leg is ~8 min on ubuntu
  and ~5 min on macOS (run `33125834965`), so the cap cannot fire on a working build. It exists for the
  failure mode this suite actually has, which is not a hang: when the engine page never publishes
  `window.__tvxEngine`, every Playwright test still *starts*, waits out its own 30 s timeout and fails,
  ~120 of them per project — the job stays "in progress", billing, for hours while producing the same
  one-line diagnosis over and over. Run `33116778462` spent **3 h 14 m of macOS runner time, at the 10x
  private-repo rate**, on a defect that was fully visible in its first minute, and run `33126921336`
  was heading the same way on ubuntu when it was cancelled by hand. 45 min is five times a green run.
  Lowering Playwright's per-test timeout instead — rejected: 30 s is a *test* budget tuned to the
  slowest legitimate golden, and shrinking it to bound the *job* would trade real coverage for a
  billing property. A shorter step-level cap on `pnpm e2e` alone — rejected as strictly weaker: the
  cache, install and packaging steps can wedge too, and one job-level cap covers all of them.
- 2026-08-28 — macOS CI leg is **workflow_dispatch only** (was: push-to-main + dispatch) — the first push's macOS run took
  3 h 14 m at the private-repo 10× rate and exhausted the account's Actions spending limit; the maintainer's Mac runs the
  full macOS suite locally on every phase, so automatic macOS CI buys nothing; ubuntu-24.04 (the golden authority) stays
  automatic on push and PR. Alternatives rejected: keeping macOS on push (cost), dropping macOS entirely (still useful for
  a manual pre-release check).

- 2026-08-27 — **`DatasetRef.fingerprint` has a producer: `tvxfp1`, in `tvx-core`, called by both loaders
  before the bytes are freed** (W-WASM Phase-2 gap 1). §4.6 required the field, §8 keys the relocate dialog
  on it, and nothing computed it: `VolumeMeta` and `MeshMeta` had no such member and `scene/serialize.ts`
  wrote `''`. §5 rule 3 puts the file bytes out of the UI thread's reach and §5 rule 5 has the parser free
  them before it returns, so there is exactly one line where the digest can be taken — above the
  `read_nifti` / `read_msh` call in `tvx_wasm::{volume,mesh}::load` — and that is where it is taken.
  The algorithm is **FNV-1a-64 over `len` (u64 LE) followed by sampled chunks, finished with `fmix64`**,
  printed as `tvxfp1-<len:16hex>-<hash:16hex>`; the chunks are the whole file up to 8 MiB and three
  non-overlapping 1 MiB windows (head, middle, tail) above it. §4.6's original `"<size>-<sha256 of first
  1 MiB>-<sha256 of last 1 MiB>"` is amended to it in the same commit: **SHA-256 would be a new workspace
  dependency and the dependency set is frozen** (§12.3), and this string identifies a file rather than
  authenticating one. It is written out normatively instead of being delegated to a hasher's default because
  it is persisted in a `*.tetravox.json` and must mean the same thing on every platform and in every future
  build — `^`, `*` and shifts on u64 only, so wasm32 and native agree by construction, and the e2e asserts
  the Rust output against an independent TypeScript implementation of the same spec over the same fixture
  bytes. Two consequences are deliberate and tested: a `.nii` and a `.nii.gz` of one volume share a
  fingerprint (the digest is of the **inflated** bytes, because §5 rule 4 inflates in the worker), and a
  mesh's `.msh.opt` / `_LUT.txt` sidecars are outside it, so recolouring a tissue does not make the file
  look like a different one. An edit to a file over 8 MiB that misses all three windows is not detected —
  the accepted price of not reading 180 MB twice for a dialog that asks "is this the file you moved?".
  Hashing every byte of every file, and hashing on the UI thread — both rejected, the first on the load
  budget (§9.1) and the second by §5 rule 3.

- 2026-08-27 — **Volumetric glyph origins are a new op, `meshCentroids` → `mesh_centroids` →
  `tvx_geom::tet_centroids`** (W-WASM Phase-2 gap 2; §6.5.2 now has **18** ops). §7.4 draws glyphs as
  "one instanced draw … with per-instance origin/direction/magnitude. **No new geometry from WASM**",
  and two of the three cases already had origins — a *surface* glyph reads `SurfacePayload.positions`
  + `ownerElm`, a *cut-plane-restricted* one reads `CutPayload.positions` + `ownerTet`. The
  unrestricted case (interior tets, no cut plane — what `ernie_TDCS_1_scalar.msh`'s `E` over
  5,900,498 elements invites) had none, and the map left the scope call open. **Taken, not closed as
  "surface only"**: the op returns *points*, one per tet, so §7.4's rule stays true — no triangles, no
  normals, no vertex-buffer expansion — and E-DERIVED can bind `positions` as an instance attribute
  and `ownerTet` as the key into the field texture it already builds. `stride` is the density knob a
  4.7 M-element layer needs; `maskId` and `tags` filter **first** so a rare tissue still gets glyphs
  (Muscle is 4,400 tets, 0.09 % of ernie, and gets 69 origins at stride 64), and the count is exactly
  `ceil(surviving / stride)`. Output is in **Morton order**, which is what makes striding a density
  control rather than a spatial bias — measured on ernie's GM, the mean of a 1-in-64 sample is
  **0.0156 mm** from the mean of all 1,340,029 `[M2Max]` — and that number also settles a second
  question: R5's "double-click → region centroid" works for a **mesh tissue tag** through this op, so
  no `meshTagCentroids` is needed. Returning bulk node positions instead — rejected: 847,165 nodes is
  the wrong cardinality for a per-element field and 10 MB to move. A `field`-result extension —
  rejected: it would put geometry in an op whose contract is values.
- 2026-08-27 — **`locate_point` gates candidates on their AABB before the barycentric test.** Found
  while writing `meshCentroids`' cross-check ("a tet's centroid must locate into that tet"): 2 of 48
  sampled ernie centroids located into a **scalp sliver** at (49.3, 16.2, −71.9), ~60 mm away, with
  6·V ≈ 2.5e-7 mm³. The locator's cells must be at least as large as the largest tet — that is what
  makes its 3×3×3 scan exhaustive — so distant candidates are normal, and an f32 barycentric test on a
  sliver at that distance is pure cancellation: it returned `[1019.5, 601.5, 5476.4, 2885.1]`, four
  positive weights, i.e. "inside". The AABB test is exact (a point inside a tet is inside its AABB),
  so it can only remove wrong answers; it is also cheaper than four signed volumes. This matters
  beyond glyphs: `locate` is what R4's gate cross-checks a cut pixel's `TI_max` through, and what
  P2-04's probe rows read. A regression test pins it with the sliver's real coordinates, because the
  failure is a property of those f32 values. Tightening the barycentric `EPS` instead — rejected: the
  weights are not near zero, they are meaningless.

- 2026-08-27 — **`field`'s element values are the file's element order, and `MeshMeta` says whether
  `gmsh - 1` may index them.** Found in the W-WASM re-check of Phase-2 protocol coverage. §7.4 builds
  its element-field texture with `texelFetch(elmFieldTex, …)` per triangle, keyed by
  `SurfacePayload.ownerElm` / `CutPayload.ownerTet` / `meshCentroids.ownerTet` — all **Gmsh element
  numbers** (§6.2). The `field` op handed the tet block out in §6.3's **Morton** order, and
  `tet_perm` never crosses the wire, so no consumer could turn a Gmsh number into a row: R4's gate
  ("`Thalamus_TI.msh` with `TI_max` element colouring on the cut, cross-checked through `locate`")
  was unimplementable, and the failure mode is a cut coloured with *other elements'* values — a
  picture that looks entirely plausible and is wrong, which is the case §11 exists for. `elm_values`
  now un-permutes the tet block, so row `i` is the file's `i`-th element for tris and tets alike, and
  §6.5.2 states the ordering of both `source` kinds as part of the contract. `MeshMeta` gains
  `identityElementNumbers` (true iff §6.2's identity rule holds, i.e. `gmsh_elm_numbers` is `None`,
  which is every reference file and every format without element numbering): it is what licenses
  `gmsh - 1`, so a consumer can detect the exotic case and colour by tag instead of silently painting
  the wrong elements. Shipping `tet_perm` in `MeshMeta` instead — rejected: 19 MB on the wire for
  ernie, to undo a permutation the worker can undo in one pass at query time. Leaving the ordering
  undocumented and letting E-MESH discover it — rejected: no engine code consumes `field` yet, which
  is exactly why W-WASM merges first.
- 2026-08-27 — **`contours` is stored-triangles-only, and that is documented rather than patched.**
  Same re-check: `grey_Thalamus_TI.msh` has 1,340,029 tets and **0 triangles**, so the `contours` op
  answers with zero segments on the very mesh R4 names for mesh-only cross-sections. It is not a gap
  — a tet mesh's `contoursIn2D` tissue boundaries are `cut` → `boundarySegments`, which arrive with
  `fillIn2D`'s polygons on the same latest-wins key, so the consumer makes one call, not two. The
  trap was the silence, so §6.5.2, `surface_contours`' own doc comment and
  `packages/wasm/e2e/contours.spec.ts` now say which producer serves which mesh, on the fixture and
  on `grey_Thalamus_TI.msh` itself. Making `contours` fall back to the tet path — rejected: it would
  need `TetBlocks` in a §6.3 signature that has none, and it would hide the distinction the 2D
  overlay has to make anyway.
- 2026-08-27 — **A 2D pane's in-plane origin is the scene bounding-box centre, not the cursor**
  (E-SCENE, R3). §4.5 defined `SliceView.camera.center` as "relative to the cursor's projection", and
  `sliceViewProj` implemented it literally: the pane's world-to-screen map was a function of
  `scene.cursor`. That is the defect R3 names — *move the crosshair, not the scan*. Under it, setting
  the cursor slides the image and leaves the crosshair pinned to the pane, so a left-click-to-set-cursor
  gesture is not merely wrong but unwritable: the point the user clicked moves away from the pointer as
  the click lands, and R3's gate ("the pixel colour at a fixed screen point away from the crosshair is
  byte-identical before/after the left-drag") cannot be satisfied by any implementation of it. The
  anchor is derived, never stored — the discipline §4.5 already applies to the slice plane — and it is
  the bounds centre because that is the one point in the scene no gesture moves and because it
  **coincides with the cursor at load** (§4.7 auto-centres there), which is why the change moved no
  Phase-1 golden: every one of them is captured with `center = [0,0]` and the cursor on the bbox centre.
  The compensation is applied in one place, `view/geometry.ts`'s `effectiveSliceView`, which
  re-expresses `center` in the cursor-relative frame the renderer already speaks. That was chosen over
  teaching the anchor to `sliceViewProj`, `SlicePass.quadHalfFor`, `SlicePass.#writeQuad` and
  `OverlayPass`'s crosshair placement — four call sites in three files, two of them owned by E-SLICE
  and by the shared pass layer — and it makes `quadHalfFor`'s `paneHalf + |center|` *correct* rather
  than merely unchanged, since that expression always meant "quad centre to pane corner". **One
  follow-up is owed to W-WASM**: the inline comment on `SliceView.camera.center` in the frozen
  `scene/types.ts` still says "relative to the cursor's projection". It is a comment, not a type, so
  nothing compiles differently; §4.5 now carries the normative paragraph and names the reword as
  W-WASM's.

- 2026-08-27 — **A mesh-only scene steps 1 mm per slice, not `bboxDiagonal / 256`** (E-SCENE, R4).
  §7.5's fallback made a wheel notch mean a different distance per file — 1.32 mm on `ernie.msh`,
  0.53 mm on `lh.central.gii`, 0.13 mm on a single electrode — for the one gesture whose value is that
  it sweeps at a rate the user can predict and count. `stepMm` takes the step as an optional argument
  (R4's "(configurable)") and defaults it to `MESH_ONLY_STEP_MM = 1`. The existing §7.5 unit test is
  unchanged and still passes: its bounds have a 256 mm diagonal, where the two rules agree.

- 2026-08-27 — **The 3D pane draws a crosshair marker, and it is a short cross rather than the 2D
  pane's full-span rules** (E-SCENE, R1). R1's gate ends "and the 3D crosshair moves", and Phase 1
  drew no crosshair in a `View3D` at all — `passes/overlay.ts` computed one only for a `SliceView`, so
  the 3D pane had no way to show where the cursor was. The cursor is projected through the pane's own
  view-projection (`worldToPane3D`) and drawn as a ±14 px cross, dropped when it is behind the eye.
  Full-span rules were rejected: in a perspective view they read as two lines floating in space with no
  relation to the geometry, and they cross the orientation letters on all four edges. The marker is
  ~50 px of a 589,824 px pane, three orders below §11's `maxDiffPixelRatio: 0.002`, so **no Phase-1
  golden was regenerated** — `gate3-t1-2x2-chrome` and `gate5-ernie-pick` both still pass against the
  committed PNGs, which is the honest way to add an item to a pane a closed gate photographs.

- 2026-08-27 — **The pointer layer's operations are public methods on `TetravoxEngine`, not private
  event handlers** (E-SCENE, P2-01). Every gesture §7.5 binds — `setCursorFromScreen`, `panView`,
  `zoomViewAt`, `zoomView`, `stepSlice`, `windowLevelDrag`, `opacityDrag`, `orbitView`, `pan3DView`,
  `dollyView`, `pickToCursor`, `hoverAtScreen`, `noteInput` — is a method the class exposes, and
  `PointerLayer` is the only caller of them inside the engine (`TetravoxEngine implements PointerHost`
  is what keeps that honest). §8 requires that "everything the UI can do must be reachable from the
  `Engine` API alone", and a gesture implemented inside a DOM handler is reachable from nothing: not
  from the app, not from a script, not from a test that does not synthesise events. They are appended
  to the concrete engine rather than to the frozen §4.7 `Engine`, because the ownership map gives
  E-SCENE exactly **one** `api.ts` carve-out and it is P2-09's; promoting this set to the facade is a
  W-WASM item whenever the app wants to reach it through the interface rather than the class.

- 2026-08-27 — **`Engine.probe` remembers the last non-empty row per layer at the cursor** (E-SCENE,
  P2-04). A mesh probe is a `locate` round trip, latest-wins on **one key per layer** (§6.3), and P2-04
  points that key at the hover position so §8's `Mouse` block can fill inside its 50 ms budget. That
  alone would blank §8's `Cursor` block — "last click, **persistent**" — every time the mouse moved,
  because `probeRow` serves whatever the last `locate` answered and its world point no longer matches
  the cursor. The memo is engine-side, keyed by layer, filled only for a probe **at** the cursor, and
  cleared by `setCursor`, so it can never describe a point the cursor has left. Two `locate` keys per
  layer was the alternative and was rejected: the key belongs to `layers/mesh.ts`, which is E-MESH's,
  and doubling the in-flight requests to keep a UI panel populated is the wrong end of the problem.

- 2026-08-27 — **§7.5's slice-step snap is along the normal only** (E-SCENE, found by the R1/R3 gate).
  §7.5 says "snap **the cursor's along-normal component** to the nearest voxel plane"; Phase 1 rounded
  all three voxel indices and rebuilt the world point from them, which also dragged the cursor
  sideways to the nearest voxel *centre*. On `vol_asym.nii` one wheel notch after a click moved the
  cursor 1 mm along the normal **and 0.5 mm across the plane**, so §7.5's "moves the cursor by
  `step_mm`" was false and a click-then-scroll walked the crosshair off the anatomy the user had
  picked. The snap now solves for the distance along the normal that puts the stepping voxel index
  (`voxelAxisAlong`, the same derivation §8's corner index uses) on an integer: exact for canonical
  planes, correct for oblique, and it cannot touch the in-plane position. It surfaced only once a
  pointer could put the cursor at an arbitrary in-plane point — before P2-01 every cursor came from
  `setCursor`, a pick, or a step, and the last two are already on the grid.

- 2026-08-27 — **Harness note: two worktrees cannot share the Playwright test-server port.**
  `playwright.config.ts` sets `reuseExistingServer: !CI` on a fixed 5199, so a second worktree running
  `pnpm e2e` silently drives the *first* worktree's Vite — which serves that worktree's source and
  whose `fs.allow` rejects this one's `testdata/`, producing `403 Forbidden` on every fixture and a
  stack trace naming a directory the run has nothing to do with. `TETRAVOX_TEST_PORT` already exists
  for this; Phase-2's parallel branches need to use it (`TETRAVOX_TEST_PORT=59xx pnpm --filter
  @tetravox/engine exec playwright test`). Recorded rather than fixed: the port default is
  `docs/TESTING.md`'s and the integrator's, not E-SCENE's.

- 2026-08-27 — **`background: 'transparent'` is a two-render matte, not an alpha clear** (E-SCENE,
  P2-06). The engine's context is created with `alpha: false` (`gl/context.ts`) — the right default for
  a viewer, since an alpha canvas composites against the page every frame — so the default framebuffer
  has **no alpha channel to read back**: clearing to `[0,0,0,0]` yields an opaque black PNG, which is
  what the Phase-1 audit's fix F4 actually shipped. `screenshot()` now draws the frame twice, over
  opaque black and over opaque white, and solves `α = 1 − (R_white − R_black)`, `C = R_black / α` per
  pixel — exact for the `src·α + dst·(1−α)` blend every pass uses, and it costs a second render only on
  the one `background` mode that needs it. `'white'` stopped being a post-composite at the same time
  (compositing an already-opaque background over white is a no-op, so it returned the dark scene
  colour) and is now simply a clear to white. Flipping the context to `alpha: true` was rejected: it is
  `gl/context.ts`, the integrator's, and it would change how **every** frame composites to fix a
  screenshot mode.

- 2026-08-27 — **A screenshot at a size is a render at that size, and `include` is an `Annotations`
  override** (E-SCENE, P2-06). §7.0.4 measured that `blitFramebuffer` cannot resolve **and** rescale in
  one call, so `width`/`height`/`scale` cannot be a blit; the drawing buffer is resized to what
  `screenshotPlan` computes, the frame is drawn, and the canvas is restored — all inside one task, so
  the compositor never sees the intermediate size. For `target: 'view'` the plan sizes the **whole
  canvas** so that the pane lands at the requested pixels (a 1200 px pane of a 2×2 layout needs a
  2400 px canvas), which is what makes it a render rather than an upscale of 384 px. The `include`
  flags map onto §4.5's `Annotations` for the duration of that render, because the chrome is drawn
  *into* the framebuffer (§8, §11) and a post-process cannot tell a letter from the anatomy under it.
  `conventionBadge` stays `true` throughout: §8 says it is not optional and `include` has no flag for
  it, so a screenshot can never leave the application without its RAD/NEU badge.

- 2026-08-27 — **The R2 zoom gate had to lift itself off the `mmPerPx` clamp** (E-SCENE, found by
  running the suite the way CI runs it). `pointer.spec.ts`'s R2 test falls back to `vol_asym.nii` when
  `TETRAVOX_TESTDATA` is unset — which is exactly what CI does, by design — and that fixture's 8 mm
  extent fits to `max(0.05, …)`, i.e. the **0.05 floor** of R2's [0.05, 20] clamp. One notch in from
  there is a no-op, so "one notch divides `mmPerPx` by 1.2" was asserting the clamp. The test now zooms
  three notches out (about the pane centre, so `camera.center` stays `[0,0]`) before measuring, and the
  "`r` restores the fit" leg zooms **out** rather than in for the same reason. It passed locally
  because the local run has the real data; it would have failed on the first CI run.

- 2026-08-27 — **`serialize()` is told where the scene file will live; it does not guess twice**
  (E-SCENE, P2-07). §4.6 wants `DatasetRef.path` relative to the scene file and §4.7's `serialize()`
  is frozen with no argument, so the one fact the engine cannot derive — the directory the host is
  about to write to — is set on the concrete engine (`TetravoxEngine.setSceneDir`, outside the frozen
  facade, like the rest of P2-01's surface). Unset, it measures from the datasets' own **common
  directory**, which is exactly right for a scene saved beside its data and never worse than the
  absolute path it also always writes. Resolution is the caller's (`load(spec, resolve)` is the
  relocate hook), so the "scene-relative first, absolute fallback" order ships as one exported
  function, `candidatePaths` — one implementation rather than one per host. A Vite `/@fs/<abs>` alias
  is deliberately **not** treated as opaque: it is structurally a path, and treating it as one is what
  lets the §11 harness exercise the relative-path code instead of skipping past it.

- 2026-08-27 — **Restoring a scene is datasets, then layers, then views — in that order** (E-SCENE,
  P2-07). `addDataset` mints a fresh `DatasetId`, so the spec's ids are stale from the first load:
  layers can only be recreated once the old→new map exists, and `activeLayerId` /
  `SliceView.layerVisibility` / `View3D.layerVisibility` only once the layers have theirs. Phase 1
  restored neither and, as `scene/serialize.ts` said at the time, could not have. `remapLayer` also
  rewrites the **second** dataset two layer kinds name — `MeshLayer.isolate.labelVolume` and
  `IsosurfaceLayer.source` — and drops an isolation whose label volume did not come back rather than
  leaving it pointed at whichever dataset now holds that id. A dataset the hook cannot place takes its
  layers with it, so a partly relocated scene opens as the part that resolved.

- 2026-08-27 — **`DatasetRef.fingerprint` is read from the meta, not asserted onto it** (E-SCENE,
  P2-07 / W-WASM gap 1). The fingerprint has to be computed over the input bytes inside the dataset's
  worker (§5 rule 3), and `VolumeMeta` / `MeshMeta` do not carry the field yet — it is W-WASM's, in a
  frozen file E-SCENE may not touch. `fingerprintFromMeta` therefore reads whatever is on the meta,
  accepts only a string and yields `''` otherwise. A cast that *declared* the field would have been a
  lie about the wire; `''` is what §4.6's consumer, the relocate dialog, already reads as "cannot
  verify", and the field lights up the day W-WASM lands with no change on this side.

- 2026-08-27 — **`toTemplate` is derived from `sform_code`/`qform_code`, and only from the form the
  reader actually used** (E-SCENE, P2-10). NIfTI-1 code 4 is `NIFTI_XFORM_MNI_152`, so a volume with
  it is *already* in MNI152 mm and the transform is the identity — which is why the field is still a
  matrix: `MNI305`, or a real registration, slots into the same shape. `headerJson` carries the codes
  **and** the derived `affineSource`, so the check is against the form `affine_of` chose: a volume with
  `sform_code = 2` and a stale `qform_code = 4` is in scanner space, and reporting MNI for it would put
  a coordinate in a paper that is wrong by centimetres. Code 5 (`TEMPLATE_OTHER`) names no template
  and claims nothing. No protocol change, exactly as the ownership map's "explicitly not gaps" table
  predicted.

- 2026-08-27 — **`Engine.nudgeCursor(viewId, dx, dy)` — the one `api.ts` change E-SCENE owns**
  (P2-09, under the single named carve-out in `docs/PHASE2-OWNERSHIP.md`; ARCHITECTURE §4.7 and §7.5
  amended in this commit, as §12.3 requires). §7.5 lists "arrows nudge the cursor" and "PgUp/PgDn
  slice" as two bindings; the frozen facade had only `stepCursor`, "±1 voxel along the view normal",
  so Phase 1's keymap gave all six keys to it and pressing → in the axial pane changed the axial
  **slice**. The in-plane nudge cannot live in the app: the step is along
  `sliceBasis(view, radiological).right` / `.up`, engine geometry that §8 forbids React from
  computing. Shape chosen over an extended `stepCursor(viewId, steps, axis?)`: two independent
  components let one call move diagonally and keep `stepCursor`'s signature — and therefore every
  existing caller and test — untouched. `MockEngine` and `NoGlEngine` both grew the member in the
  same commit, which is what the carve-out's terms require.

- 2026-08-27 — **The voxel-grid snap is one function, applied along whichever direction is being
  stepped** (E-SCENE, P2-09). `stepCursor` and `nudgeCursor` are the same operation in different
  directions, so `view/geometry.ts`'s `snapAlong(ds, world, dir)` is now the single implementation:
  it solves for the distance along `dir` that puts the voxel index `voxelAxisAlong(dir, affine)`
  names on an integer. Applying it per axis is what makes 100 nudges out and 100 back return to the
  starting voxel exactly, in-plane as well as along the normal, and it keeps the property the
  along-normal snap was fixed for earlier today: a step never moves the cursor in a direction the
  user did not ask for.

- 2026-08-27 — **The cut-plane gizmo lives in the 3D pane and manipulates a 2D pane's plane**
  (E-SCENE, §7.5's oblique affordances). A gizmo drawn inside the pane whose plane it rotates would be
  looking at that plane edge-on — at a line — so `showGizmo(viewId)` names the *slice* view whose
  plane is being manipulated and the geometry is drawn in the `View3D`. §7.2's "all clip distances
  disabled" in pass 3 is what keeps it from being clipped by the plane it manipulates, and it is
  drawn **after** the letters and corner block so nothing but the active-pane border covers the thing
  the user is dragging. Its state — which plane, which handle is hot, how many plane-from-3-points
  clicks are outstanding — is engine-private and is deliberately **not** in `Scene`: §4.5 is frozen,
  and a saved `ViewSpec` must not carry "the user was mid-drag on a rotate handle".

- 2026-08-27 — **A rotate handle rotates `normal` and `up` together, through Rodrigues** (E-SCENE).
  Rotating the normal alone leaves `up` pointing out of the new plane, and `sliceBasis` then
  re-orthogonalises it to whatever falls out — so a rotate handle would also *roll* the pane by an
  amount nobody asked for, differently depending on which axis the orthogonalisation branched on.
  `view/geometry.ts`'s `rotatePlane` carries both vectors rigidly and re-normalises, and the e2e
  asserts the property directly: after a 90 px drag on the `rotateU` handle the normal has moved and
  `up` is **unchanged**.

- 2026-08-27 — **The gizmo's hit test and its drawing read the same `handlePoints`** (E-SCENE). Two
  copies of "where is the rotate handle" is how a control becomes a picture of a control: the drawing
  drifts by a few pixels, the grab radius no longer covers it, and the user's cursor sits on a handle
  that does not respond. `overlay/gizmo.ts` exports the three world points once; `drawGizmo` puts
  knobs there and `gizmoHandleAt` measures distance to them, both through the pane's own `viewProj`.
  The e2e finds the handle by **scanning pane pixels with the engine's own hit test** rather than
  through a test-only accessor, which is the same claim from the outside: a handle a user can see is
  a handle a user can reach.

- 2026-08-27 — **`OverlayBuilder` gained `quad()`, and the test page publishes `TetravoxEngine`**
  (E-SCENE, two small consequences of the gizmo). Every Phase-1 overlay item was axis-aligned, so
  `rect()` sufficed; §7.0.6's screen-space quad expansion is not axis-aligned, and the gizmo's ring
  and arcs are rotated segments. And `test/pages/scene.ts` published its engine as the frozen §4.7
  `Engine` while constructing a `TetravoxEngine`, so every spec driving a Phase-2 gesture cast it
  straight back up, once per call; it now publishes the concrete type. Widening only — every `Engine`
  member is still there and no existing spec changed.

- 2026-08-27 — **`.msh.opt` seeding is partial about colormaps, on purpose** (E-SCENE, §7.6). The
  sidecar seeds tag colours and visibility, the field range (`RangeType = 2` and only then, since
  `CustomMin`/`CustomMax` are otherwise whatever the last Gmsh save left behind), the colour bar
  (`ShowScale`), and the colormap — but the colormap table covers only `ColormapNumber = 2`, which is
  what SimNIBS writes in every `.msh.opt` it produces `[DATA]` and is Gmsh's rainbow/jet, plus the
  four numbers whose Gmsh names are a §7.6 `ColormapName` exactly. Every other number leaves the
  layer's own default alone. Guessing at the rest of Gmsh's colour-table numbering would paint a
  field in the wrong colours **silently**, which is the one failure a viewer may not have; a viewer
  that disagrees with Gmsh about a colormap is visible and correctable. Seeding fires only for a
  dataset the host gave a sidecar for (`app/.../lib/sidecars.ts` derives the candidates), so no
  Phase-1 golden — none of which passes one — moved.

- 2026-08-27 — **R2's corner `×zoom` readout appears only off the fit, and measures against the fit
  the user last asked for** (E-SCENE). Two decisions, each forced by a failing test rather than by
  taste. A line that is always present shifts the other three up a row in every pane of every
  picture, i.e. six regenerated Phase-1 goldens — two of them a closed gate's — to print `ZOOM 1.00X`
  under an image nobody zoomed; so at the fit it prints nothing. And measuring against a fit
  **recomputed for the pane's current size** made every pane claim to be zoomed the moment the layout
  changed, which is how it broke gate 5's slice-index decode: that test picks in a 1×1 pane and then
  reads the corner block in a 2×2. `DrawInput.viewFit` remembers what each pane was fitted at
  (`resetView`, and the auto-fit on the first dataset), so "zoom" means what a user means by it and
  `r` always returns the readout to nothing.

- 2026-08-27 — **`page.mouse.wheel` resolves before the page has handled the wheel** (E-SCENE, found
  by running both Playwright projects together). It resolves once the event is *dispatched* to the
  renderer, so a `whenSettled()` immediately after it sees an engine with nothing pending and returns
  at once — and the next `cursorOf` reads the cursor from before the notch. The SwiftShader project
  happened to win that race on every run; the headed **ANGLE** one does not, and §7.5's anti-drift
  test read a one-voxel step as `2.5` — two notches, one reading. `pointer.spec.ts`'s `wheelNotch`
  now waits for the cursor to actually move before settling. Worth recording because it is a property
  of `page.mouse.wheel`, not of this test: any spec that wheels and then reads state needs the same
  wait, and the failure is invisible on the golden-authority project.
- 2026-08-27 — **`heat`'s `truncate` and `inverse`, defined (E-SLICE, §7.3 completion).** §4.2 gives
  `Scale.heat` three knobs beyond the min/mid/max ramp — `negative`, `inverse`, `truncate` — and
  FreeSurfer's own meanings for the last two ("hide the negative tail", "flip the data's sign") both
  collapse into `negative: 'hide' | 'mirror'`, which would leave two frozen fields with no job and
  `color/colormaps.ts` shipping `t = scale.truncate ? 1 : 1`. Each is therefore given the one job
  `negative` does not cover. **`inverse` reverses the colour ramp** (`t → 1 − t`), a property of the
  colours and not of the data, so it applies to both branches and to the negative colormap.
  **`truncate` clips instead of saturating**: `|v| > max` is not drawn, where the default `false`
  keeps the `max` colour. That is exactly the pair Gmsh spells `View.SaturateValues` (1 saturates to
  the custom range, 0 clips outside it), which §4.3's `MshOptions.views[].saturateValues` already
  parses, so the sidecar and the display model agree on one meaning. The clip cannot live in the
  bake — a LUT is defined only over its own range and a sampler clamps rather than dropping — so it
  travels beside the LUT as `BakedLut.clipMax` and the shader discards on it, in the same chunk as
  `Threshold` and therefore reproduced by the pick pass for free. Rejected: leaving both flags inert
  (a frozen field that does nothing is a bug with a schedule), and reading them the FreeSurfer way
  (two spellings of `negative`, and a silent change to `inverse`'s already-shipped behaviour).

- 2026-08-27 — **The colormap LUT is baked at texel centres, `(i + 0.5) / width`, not at endpoints.**
  The shader samples `NEAREST` at `clamp(t, 0, 1)`, which selects texel `floor(t · width)` — whose
  represented value is the centre of that texel, not `i / (width − 1)`. Phase 1 baked at endpoints,
  offsetting every texel by up to half a texel: invisible in a picture, and enough to make §11's
  analytic assertions argue with the driver's rounding instead of with the rendering. The largest
  displayed change is one 8-bit level, well under §11's `threshold: 0.15`; every Phase-1 golden
  passes unchanged. Rejected: choosing analytic test values that land in texel interiors — that
  hides a real off-by-half rather than fixing it, and it does not survive the next person picking a
  round number.

- 2026-08-27 — **`GL_STATE.slice3d` — `showIn3D` planes blend, unlike the rest of pass 1.**
  `docs/PHASE2-OWNERSHIP.md` expected §7.3's planes to draw in the existing `opaque3d` block. §7.3
  fixes three of the five fields ("`DEPTH_TEST` on, `depthFunc(LEQUAL)`, `depthMask(true)`") and says
  nothing about blending, but `opaque3d` has `BLEND` off — and two volume layers on one plane must
  composite in a 3D pane exactly as they do in a 2D one, or `Thalamus_TI_subject_TI_max.nii.gz` over
  `T1.nii.gz` reads differently in the 2×2 grid than in the 3D pane and `VolumeLayer.opacity`
  silently stops working in 3D. The new block is `opaque3d` plus `blend: 'srcAlpha'`. §11's
  exact-100 % assertion is unaffected: at opacity 1 over an alpha-1 fragment,
  `SRC_ALPHA, ONE_MINUS_SRC_ALPHA` reproduces the source exactly, which is what "independence over
  every pixel" measures. Rejected: reusing `opaque3d` (correct for the golden, wrong for the user),
  and per-draw blend calls (`gl/state.ts` exists so no pass issues a raw blend call).

- 2026-08-27 — **The slice pick program is compiled from the frame's own fragment body.**
  §7.2.3 requires pass 4 to reproduce *every* discard of pass 1. With Phase 2's threshold, `truncate`
  clip, per-label palette alpha and 4-tap outline test, a second hand-written pick shader is a
  standing invitation to divergence — the exact failure §7.2.3 names ("double-click lands on
  geometry the user cannot see"). `shaders/slice.ts` now emits `SLICE_FS` and `SLICE_PICK_GATED_FS`
  from one shared head and one shared body, both bound through one exported
  `bindSliceSampling(...)`, so the two programs cannot drift without a compile error. Phase 1's
  `SLICE_PICK_FS` stays in `shaders/pick.ts`, unused by the slice branch and untouched, because it is
  not E-SLICE's file. Rejected: extending `SLICE_PICK_FS` in place (someone else's file), and
  reproducing only the threshold (the outline discard is the one that removes most of the plane).

- 2026-08-27 — **`visibleLabels`, `labelOpacity` and R5's recolour are baked into the palette, not
  branched on in the shader.** The `N × 1 RGBA8` dense-index palette (§7.3) already decides
  background by alpha, so hiding a label is `A = 0`, per-label opacity is a multiply on `A`, and a
  recolour is a new `RGB`. Nothing in the fragment shader learns about any of them. That is what
  makes R5's gate assertion — "hiding a label removes its colour from the pane pixels while others
  are unchanged" — true by construction: exactly four bytes of one texture change, so every other
  pixel is byte-identical without anyone being careful. The palette is keyed **per layer**
  (`labelStyleKey`) because `visibleLabels` and `labelOpacity` are `VolumeLayer` fields, while label
  **colour** is patched into the dataset's `LabelTable`, which is what a `*_LUT.txt` holds and what
  §8's "Save LUT…" exports. R5's selection needs a second `N × 1` table (`R = 255` when selected)
  rather than more rows of the first, because `gl/texture.ts`'s `createLut` builds `N × 1` and that
  file belongs to the integrator. Rejected: a `visibleLabels` uniform array (ESSL 3.00 cannot index
  one dynamically at the 65535-label cap — the same reason the palette is a texture at all).

- 2026-08-27 — **R5's recolour and selection need two `VolumeLayer` fields that do not exist; filed
  with the integrator rather than added (E-SLICE).** `docs/PHASE2-OWNERSHIP.md` closes its R5 row
  with "No frozen-type change is needed: recolouring edits the layer's own `LabelTable`
  (`VolumeLayer.labelLut`, `MeshLayer.label.table`)". **`VolumeLayer` has no `labelLut`** — §4.4 and
  `packages/engine/src/scene/types.ts` carry `visibleLabels`, `labelOpacity`, `labelMode` and
  `outlineWidthPx` and nothing else — and it has no home for a selection either, so the map's claim
  is true of `MeshLayer` and false of `VolumeLayer`. §12.3 closes that file to everyone but W-WASM,
  so the two fields are **filed**, not added:
  * `VolumeLayer.labelLut?: LabelTable` — a per-layer colour override, plus a serialisable form in
    `SerializableLayer` (a `LabelTable` holds a `Map`), so a recolour survives save/load as R5's
    gate requires.
  * `VolumeLayer.selectedLabels?: Uint32Array` — the region panel's selection, plus
    `selectedLabels?: number[]` in `SerializableLayer`, exactly as `visibleLabels` is handled today.

  Until they land, the engine carries both **outside** the frozen surface: label colour is patched
  into the **dataset's** `LabelTable` (which is what a `*_LUT.txt` holds, what §8's "Save LUT…"
  exports, and what every layer on that atlas reads) through `TetravoxEngine.setLabelColor`, and the
  selection lives on the layer's runtime through `TetravoxEngine.setSelectedLabels`. Both are
  appended `TetravoxEngine` methods, not §4.7 `Engine` members, so **A-PROPS cannot reach them from
  React** — §8 requires everything the UI does to go through §4.7 alone. That is the part of R5 this
  owner cannot close, and it is one W-WASM commit away. The palette pipeline behind it is complete
  and tested: `buildLabelPalette(ds, ids, { visibleLabels, labelOpacity })` and `buildLabelAttrs`
  already take the styling as parameters, so the two fields become two arguments at one call site.

- 2026-08-27 — **`Annotations.colorbars` stays `false` by default, even though §11 now requires
  colour bars in every screenshot.** `scene/defaults.ts` is a shared file whose rule is "never change
  an existing default — it moves every golden that layer appears in", and flipping this one moves
  `gate3-t1-2x2-chrome`, `gate3-t1-axial-radiological`, `gate4-t1-oblique`, `gate5-ernie-pick` and
  `gate5-overlay-composite-oblique` — five goldens belonging to `phase1-gate.spec.ts`, "a closed
  record of a passed gate" that this owner may not regenerate. Every Phase-2 golden turns the bars on
  explicitly, so the requirement is met where it is testable. **The default flip is the integrator's
  to make**, in the commit that regenerates the Phase-1 goldens — most naturally the same commit that
  regenerates them on `ubuntu-24.04`, which §11 makes the authority and which has still never run.

- 2026-08-27 — **The label outline is a binary 4-tap test, not §7.0.5's `fwidth`-scaled ramp.**
  §7.0.5 asks for label outlines to "derive a distance-to-boundary from the neighbour-label test and
  `fwidth`-scale the smoothstep, not a binary 'different label ⇒ outline colour'". §7.3's **normative**
  formula, added later and in more detail, is four binary taps at `± 0.5 · outlineWidthPx · duv`, and
  says in the same paragraph that four binary taps "cannot recover a distance … anyway". The two
  cannot both be implemented; §7.3 is the specific, normative, measured one ("2.00 px axis-aligned /
  2.69 px at 45°", "8 taps buy nothing … at 12 % more slice-composite cost"), so it wins and §7.0.5's
  clause is read as an aspiration that its own successor retired. Measured here on
  `labeling.nii.gz` at `outlineWidthPx: 2`: **2.00 px at 0.05 mm/px, 2.01 px at 1.0, 2.01 px at 5.0,
  with 100.0 % of the fill boundary covered at all three** — §11's Label-outline-zoom row wants
  [0.8, 2.9] px and ≥ 99 %. A ramp would need a distance, and the only honest source of one is
  Phase 3's label-minification work (§ROADMAP Phase 3), which owns the sampler this sits on.
- 2026-08-27 — **§7.4's masked barycentric edges select with `mix(vec3, vec3, bvec3)`, never the
  float `mix` and a 1e9 sentinel.** §7.4 states the edge mechanism as `d = bary / fwidth(bary)` with
  `d[i] = 1e9` for a cleared `edgeMask` bit. Written the obvious way —
  `mix(vec3(1e9), bary / fwidth(bary), edgeOn)` — it is wrong, and wrong in a way that looks like a
  geometry bug: the float overload is specified as `x + a*(y - x)`, so a *kept* edge evaluates
  `1e9 + 1.0*(d - 1e9)`, and in f32 `d - 1e9` rounds to exactly `-1e9` for every `d` a barycentric
  distance can produce. The sum is 0, every fragment reports distance zero, and the whole primitive
  is painted in the edge colour — measured on the fixture cap, where the entire cross-section came
  back solid black `[SwS]`. The `bvec3` overload is a genuine per-component select and does no
  arithmetic at all. The bug reached both the surface and the cap path because §7.4 asks for **one**
  edge mechanism for both, so one line fixed both; `test/e2e/mesh-clip.spec.ts`'s cap-diagonal test
  is what catches it, by asserting that a suppressed 2-2 diagonal is *not* the edge colour while the
  quad's real edge is. Keeping the float `mix` with a smaller sentinel — rejected: any sentinel large
  enough to lose the `min` is large enough to annihilate `d`.

- 2026-08-27 — **`CutManager` applies a result that is the newest one *seen*, not the newest one
  *issued*.** §5 rule 6's latest-wins is implemented in `ComputeClient`: one request in flight and at
  most one queued per key, a new request replacing the queued one, and *"an in-flight request has no
  abort flag"* — it runs to completion and its result arrives. The manager's own guard compared the
  returning ticket against the newest ticket *issued*, which is a different thing: during a gizmo
  drag the plane moves every frame, so every result is superseded before it lands and **not one
  cross-section is ever delivered**. Measured on `ernie.msh` at 120 fps against a ~17 ms cut: zero
  cuts applied in a two-second drag, the cap frozen where the drag began; with the fix, 113. The
  guarantee that motivated the guard is kept by comparing against the newest ticket *applied*: a
  snapshot is still never replaced by an older one, `generation` is still monotonic, and removing the
  last plane still burns a ticket so an in-flight cut cannot resurrect the caps. Queueing inside the
  manager instead — rejected: `ComputeClient` already coalesces per key, and a second queue would
  only add a second place for the newest request to be lost.
- 2026-08-27 — **A-PROPS half 1 (volume editor, histogram, Region panel): four choices, and three
  things the frozen model cannot express yet.** (1) **`symmetric ±p99` is read literally** as
  `[-|p99|, +|p99|]`, not as `±max(|p1|, |p99|)`. §8 names one percentile; the preset exists so a
  diverging colormap is centred on zero (§7.6 centres `bwr`/`coolwarm` at 0 when
  `threshold.symmetric`), and folding in `p1` would let a one-sided tail silently widen the window
  the user asked for. (2) **Switching a `Scale` between `linear` and `heat` carries the window
  across** — `[lo, hi]` becomes `[min, max]` with `mid` at the midpoint — rather than re-seeding from
  `Stats`. Re-seeding makes the picture jump every time a user looks at the other kind and discards
  numbers they had just dialled in. (3) **The histogram's x axis is the `Stats` range, never the
  window**, so dragging a window handle cannot move the axis under its own pointer; and handle ties
  go to the **threshold** pair, which sits inside the window by construction. (4) **Probe-driven row
  selection fires on a change of the probed label, not on every probe**: `updateLayer` re-probes the
  cursor, so an unguarded effect undid the selection the user had just made with the very patch that
  made it.
  Three gaps are marked in the DOM rather than faked, and are filed with the integrator: a **label
  volume's colour swatch is read-only** (`data-recolorable="false"`) because its palette is built
  from `VolumeDataset.labelTable`, which is dataset state — no `Partial<VolumeLayer>` can carry an
  edited colour, while a mesh tag's (`tagStyle[t].color`) and an annot's (`MeshLayer.label.table`)
  both can; **every region's count and centroid is `—`** because the `labelCentroids` op (§6.5.2) has
  no producer on the §4.7 facade, and §4.3 keeps `VolumeDataset.data` on the UI thread "for probes
  only", which a count over 256×256×208 is not; and the **histogram's colormap strip is prop-driven**
  and renders a named neutral rail, because `color/colormaps.ts` is not exported from the engine's
  barrel and a copy of the tables in the app would be a second source of truth for every pixel the
  strip is compared against.

- 2026-08-27 — **The app E2E launches with its own `--user-data-dir`.** `src/main/index.ts` takes
  `app.requestSingleInstanceLock()`, and that lock is scoped to the Chromium user data directory,
  which every Tetravox worktree on a machine shares. A second agent running the app E2E in a sibling
  worktree therefore makes this run's Electron **quit with exit code 0** and forward its argv to the
  other agent's window; Playwright reports it as "Target page, context or browser has been closed" at
  the launch site, with no hint of the cause, and every spec in the run fails. Observed between
  `p2/props-volume` and `p2/props-mesh` on 2026-08-27. The two A-PROPS specs pass
  `--user-data-dir=<mkdtemp>` in `LaunchOptions.args` (`collectCliPaths` drops it because it starts
  with `-`, so the §8 argv path is unchanged) and remove it afterwards. Doing it in
  `packages/app/e2e/fixtures.ts` for every spec would be better and is filed with the integrator —
  that file is not A-PROPS's.
- 2026-08-27 — **A-PROPS (mesh / iso / points editors): four decisions, and one frozen-interface
  request left with the integrator.** (1) **The colour picker converts 8-bit hex to §4.1's 0..1
  floats, in `panels/layers/mesh/state.ts`.** §4.1 names `scene/fromMeta.ts` as the only place that
  divides by 255, and that rule is about **wire** colours — `MeshTag.color`, `MshOptions.tagColor`;
  a colour the user just picked in an `<input type="color">` never came off a wire, and R5 requires
  a picker whose edits land in `tagStyle.color`. The round trip is exact because every hex value is
  `k / 255` (§11's "make the colours exact 8-bit values"), so a swatch shown for a tag colour and
  saved back unedited is byte-identical, and `expectPixel`'s "the pixel is exactly the tag colour"
  still holds after a recolour. (2) **A clip plane's 'follow cursor' is app state, and the frozen
  `ClipPlane` should gain a `followCursor` flag.** §7.5 asks for a cut plane that sweeps, and the
  offset that puts a plane through the cursor is `−dot(n, cursor)` — one line, but there is nowhere
  in §4.4 to record *that the plane follows*. It therefore lives in `UiState.clipFollowsCursor` and
  is re-applied from the `cursor` event by the controller, with the arithmetic in a pure, tested
  function rather than in React. **Consequence, filed for W-WASM/the integrator rather than worked
  around: the flag does not survive `serialize()` / `load()`** (§4.6 serialises layers, not app
  state), so a saved scene reopens with the plane where it was but no longer following. The fix is
  `ClipPlane.followCursor?: boolean` in `packages/engine/src/scene/types.ts`, which A-PROPS may not
  edit. (3) **Every editor checks `layer.kind` before it touches a hook.** `LayerProperties`
  dispatches on the kind and a layer's kind never changes, so the hook order is stable per mounted
  instance — and it is what lets `properties.test.tsx` assert the registry at all, since the app's
  vitest project runs under `node` with no DOM. (4) **The three §7.4 async switches get their
  progress state from `whenSettled()`.** The first `edges.surface`, the first element field and the
  first `colorMode:'label'` build the de-indexed variant in the worker; there is no per-layer
  progress event in §4.7, and inventing one would be a frozen-interface change for a spinner. Also
  recorded, because it cost a debugging session each: a `useUi` selector that returns a fresh `[]`
  fallback re-renders forever (React #185 — `useSyncExternalStore` compares snapshots by identity),
  and the tissue/point rows are `div`s with `role="listitem"` rather than `li`s, because
  A-SHELL's `shell.spec.ts` counts `[data-testid="layer-list"] li` and a nested list would break a
  spec this owner does not own.
- 2026-08-27 — **A-SHELL (`p2/shell`): three decisions the §8 shell had to take to reach the
  Phase-2 items, none of which touches a frozen interface.**
  1. **Scene IO is a second, narrower channel on the preload bridge, with its own write
     allow-list.** §8 needs the renderer to read and write `*.tetravox.json`, and §5's bridge
     deliberately has no `readFile`. `main/scene-io.ts` adds one: reads go through the existing
     `tetravox://file/…` allow-list (`paths.ts`), **writes go through a separate list that only the
     Save dialog fills** — being able to read `T1.nii.gz` must never imply being able to overwrite
     it — and both directions are capped at 8 MiB, three orders above a real `ViewSpec` and three
     below `ernie.msh`. That cap is the line between "small JSON" and "a byte channel" written in
     code rather than in a comment. Rejected: a general `readTextFile`/`writeTextFile` pair, which
     would have been an arbitrary-file primitive for anything that gets script into the renderer.
  2. **The shell reconciles layers after `Engine.load`, and the reconcile is designed to become a
     no-op.** Audit **P2-07** records that `applyViewSpec` "does not restore `layers` or
     `activeLayerId`, and cannot as written": the datasets a load re-adds get fresh ids. E-SCENE owns
     fixing that. Until then a saved scene reopens with datasets and no layers, which is not a
     restored scene — so `lib/scene.ts`'s `layersToRestore` asks the engine for the spec layers that
     have no live counterpart, matched by `(datasetId, kind, name)` against a dataset-id map built
     from the path each ref resolved to. When P2-07 lands, `liveLayers` covers the spec and it
     returns `[]`: the same code path, one branch colder. Rejected: waiting for E-SCENE, which would
     have left A-SHELL's persistence gate item untestable for two integration stages.
  3. **The `.msh.opt` chip lives in `app/.../ui/`, not in the mesh property editor.** §7.6 and the
     ownership map split that feature — E-SCENE seeds from `MeshMeta.opt` in `fromMeta`, A-SHELL owns
     the chip and Reset — but the natural home for the chip is A-PROPS's `panels/layers/mesh/`.
     `ui/MshOptChip.tsx` is therefore a self-contained component the shell mounts in the right-hand
     column, and it is exported so A-PROPS's tissue table can render the same one rather than build a
     second. One implementation, one owner, no shared-file edit.

  Also recorded, because both were found by running the real data rather than by reading the
  contract: **`DatasetRef.name` is `VolumeMeta.name`, which the loader derives from the source URL
  and which is the whole absolute path on ernie `[DATA]`** — the Save dialog was about to offer
  `_Users_idohaber_…_T1.tetravox.json` — so `defaultSceneName` and the relocate row take the
  basename; and **`e2e/fixtures.ts` now gives every launch a private `--user-data-dir`**, because
  `app.requestSingleInstanceLock()` is keyed by the userData directory, which for an unpackaged
  Electron app is shared by every checkout of this repo on the machine. While another one holds it a
  launched app quits **before creating a window**, and Playwright reports "Target page, context or
  browser has been closed" with `exitCode 0` — a failure that looks like a crash in the code under
  test and is not one. Reproduced against a second worktree's e2e run; the same shape appears in CI
  the moment two jobs share a runner.
- 2026-08-27 — **R5's per-region edits are `VolumeLayer` fields, not `VolumeDataset` mutations**
  (Phase-2 integrator, applying the identical need filed by E-SLICE, A-PROPS and E-SCENE). Three
  branches arrived saying the same thing in three shapes: `VolumeLayer.labelLut?: LabelTable`
  (E-SLICE), `VolumeLayer.labelColors?: Record<number, vec4>` (A-PROPS, E-SCENE), and "the colour
  edit does not round-trip" (all three). What all three are about is one clause of R5 — "edits
  persist in the scene" — colliding with one clause of §4.6: **a `LabelTable` is not serialised**,
  it is re-derived from the dataset and its LUT on load. E-SLICE's implementation wrote the new
  colour into `VolumeDataset.labelTable`, which is correct about where a *file's* colours live and
  therefore loses the user's edit on the next open. So the frozen `VolumeLayer` gains
  **`labelColors?: Record<number, vec4>`**, an override the palette builder prefers over the table,
  and **`selectedLabels?: number[]`**; `ClipPlane` gains **`followCursor?: boolean`** for A-PROPS's
  identical filing about a clip plane's follow flag. Consequences worth stating: the dataset's table
  is never mutated, so the file's own colours stay readable underneath and a **per-row Reset is
  deleting a key** rather than re-parsing a LUT (`setLabelColor(…, null)`); "Save LUT…" merges the
  override over the table; and `Engine.setLabelColor` / `setSelectedLabels` / the app's
  `setClipFollowsCursor` are now `updateLayer` underneath, which is what makes §8's "everything the
  UI can do must be reachable from the `Engine` API alone" true of R5 without promoting three
  convenience members to the frozen facade. Rejected: `labelLut?: LabelTable` — a `LabelTable` holds
  a `Map`, so it would need its own entry in `SerializableLayer` alongside `visibleLabels`, and it
  duplicates the whole table to record one changed colour. Rejected: keeping the flag in the host's
  UI store (A-PROPS's workaround) — a saved scene that reopens with the plane where it was but no
  longer following did not round-trip. `selectedLabels` is a plain `number[]` rather than a
  `Uint32Array` deliberately: a selection is a handful of ids edited click by click, not a filter
  over up to 65535, and JSON here keeps `SerializableLayer` a straight `Omit` of one field.
- 2026-08-27 — **`Engine.labelCentroids(layerId)` — §6.5.2's op finally has a producer** (Phase-2
  integrator, from A-PROPS's filing; §4.7, second and last Phase-2 addition to the frozen facade
  after E-SCENE's `nudgeCursor`). The op has existed since Phase 1 and returns exactly what R5's row
  asks for — `{ id, centroid, count }[]` — and nothing on the facade called it, so the region panel
  rendered `—` for every count and its double-click had nowhere to jump. The app cannot compute
  either itself: §4.3 keeps `VolumeDataset.data` on the UI thread "for probes only" and a scan of
  256×256×208 voxels is not a probe, while §8 forbids the logic living in React regardless. The
  engine converts the op's **voxel** centroid to world RAS on the way out (§4.1's one-conversion
  rule) and caches the answer per `(datasetId, volumeIndex)` — one pass over the volume per atlas per
  session, shared by every layer drawing it, dropped with the dataset. A layer that is not a label
  volume, or whose worker is gone, resolves to `[]` rather than rejecting, so the panel stops asking
  and keeps rendering `—`.
- 2026-08-27 — **`@tetravox/engine` re-exports `sampleColormap`, `isColormapName`, `scalePosition`
  and `fallbackLabelColor`** (Phase-2 integrator, from A-PROPS's filing). §8 puts "the current
  colormap painted along the x axis" under the histogram, and that widget is DOM in `packages/app`,
  which had no way to ask the engine what a colormap looks like. A copy of the tables in the app
  would be a second source of truth against the pane the user is comparing the strip to. These are
  pure functions over §4.1 values and touch no GL, so exporting them costs nothing and closes the
  gap; `packages/engine/src/index.ts` is the integrator's file, not a frozen one, so this needed no
  carve-out. Found on the way in, and worth writing down because the types do not say it:
  **`sampleColormap` returns RGB 0..255, not §4.1's 0..1** — the colour tables are stored the way
  §7.6's `.json` colormaps and every LUT file write them, and only `MeshTag.color` / `LabelEntry.color`
  are normalised at the wire. A second `× 255` in the app saturated every channel and painted the
  strip white, which is how it was caught.

## 2026-08-27 — Phase 2, E-DERIVED (contours, `fillIn2D`, glyphs, isosurfaces, points)

- 2026-08-27 — **Glyph origins are surface-and-cut-plane only; W-WASM gap 2 closes as "none".** The
  map asked E-DERIVED to decide this "before writing the shader". Decided: no new §6.3 function, no
  new §6.5.2 op, no protocol change. §7.4 already says "**No new geometry from WASM**", and both
  origin sources it leaves open are enough — a de-indexed `SurfacePayload` gives a per-triangle
  centroid and its `ownerElm`, and `CutPayload` gives the same for the `clipToCutPlane` case. The
  shader takes triangle `uFirst + gl_InstanceID · uStride` and averages its three vertices, reading
  them out of an `R32F` table that is the payload's own `positions` array uploaded unchanged, so the
  origin costs no CPU work and no extra memory beyond one texture. What is *not* served is the
  unrestricted interior case — glyphs on tets no surface and no plane touches — which is the case
  `ernie_TDCS_1_scalar.msh`'s `E` over 5,900,498 elements invites and which would need element
  centroids from `tvx-geom`. Rejected for v1 on two grounds: the picture it draws is a solid block of
  arrows nobody can read, and every reference workflow (a field on the GM surface, a field on a cut)
  is already covered. If Phase 3 wants it, it is a `field`-result extension and it is W-WASM's.
- 2026-08-27 — **The derived pass runs between `mesh` and `overlay`, not appended after it.**
  `renderer.ts`'s shared-file rule is "append a pass to the sequence in `renderView`; **never
  reorder**", and appending literally at the end would put `fillIn2D`, points and isosurfaces on top
  of the crosshair and the corner info. §7.2 is unambiguous about where they belong — points,
  isosurfaces and cut caps are **pass 1**, contours are **pass 3**, and R4 says the mesh fill draws
  over the base volume and under the crosshair — so the only placement the contract allows is before
  the overlay. No existing entry moves: `slice` → `mesh` → `overlay` keep their order and their
  relative order, and the new call is one line between two of them. The pass enters a complete
  `gl/state.ts` block and disables every clip distance, so it inherits nothing from pass 2 and leaks
  nothing into pass 3. Drawing contours in the overlay pass's own buffer instead — rejected: the
  overlay is "one buffer, one draw" of screen-space chrome geometry, and instancing 200,000 boundary
  segments through a CPU-built vertex list is exactly the per-element work §5 rule 7 forbids.
- 2026-08-27 — **`fillIn2D` and `contoursIn2D` default to `true` when a mesh is opened**, changing
  two Phase-1 defaults in `scene/defaults.ts` against that file's "never change an existing default"
  rule. R4 states it outright ("Default when a mesh is opened: fill **and** contours on"), and
  `docs/requirements/2026-08-27-maintainer.md` says a maintainer requirement wins over the contract
  where they conflict. The rule's stated reason — "it moves every golden that layer appears in" —
  does not apply: Phase 1 drew no mesh in any 2D pane, so no committed golden contains one, and
  `gate2` / `gate5`'s mesh scenes are `3d-only` where no cut is requested at all.
- 2026-08-27 — **A per-face value reaches the fill shader as a table texture, never as a per-vertex
  attribute.** The cut's `tag` and `ownerTet` are one texel per triangle in `R32UI`, fetched at
  `gl_VertexID / 3` — §7.4's own mechanism for a de-indexed draw — and the `tag` upload is a
  zero-copy `Uint32Array` view over the worker's `Int32Array`. Expanding either to three vertices on
  the UI thread would be 62,966 triangles of per-element work per sweep step (§5 rule 7, AGENTS rule
  7) and 12× the bytes. The tag *colour* is then a `tag → RGBA8` LUT indexed by the raw tag rather
  than by a dense remap: tags are not contiguous (tag 4 is absent from ernie) and reach 2102 on the
  SEEG meshes, so the direct table is 8.4 KB against a remap plus a search. Alpha in that LUT carries
  `tagStyle` visibility and opacity, which is what makes R5's "hiding a tag removes its colour while
  the others are unchanged" true by construction rather than by a second draw.
- 2026-08-27 — **`derived/cut-source.ts` ships the `CutSource` contract *and* a worker-backed
  implementation, rather than waiting for `compute/cut-manager.ts`.** The four methods
  (`requestCut` / `getCut` / `onCut` / `releaseCut`, latest-wins per `(datasetId, key)`, keys
  `pane:<viewId>` and `3d-clip`) are the shape agreed with E-MESH, and E-MESH owns the file that will
  implement them. But R4 is a **gate item on this branch**, with real-data pixel assertions and a
  measured sweep, and the integration order lands E-MESH one stage earlier — so a branch that only
  had a fake would ship an untested feature. `PaneCutSource` implements the interface over the `cut`
  op directly; swapping it for `CutManager` is one construction site in `engine.ts` and nothing else,
  because nothing else names the implementation. It requests `recycle: false` throughout: the
  recycled path hands geometry back through the worker's own `CutOut` pool, which only E-MESH's
  GPU-side cap uploader can read, and §6.4 calls the buffers path "the correctness reference".
- 2026-08-27 — **`defaultLayerFor` takes an optional `kind`.** `Engine.addLayer({ kind: 'iso' })`
  could not work before it: the facade built the layer from `defaultLayerFor(id, ds)` and then
  re-imposed `kind: base.kind`, so a caller-requested kind the function never produced was silently
  replaced by the dataset's. One optional parameter, defaulting to the dataset's own kind, leaves
  every Phase-1 call site unchanged and makes `layers/registry.ts`'s exhaustiveness over §4.4's four
  kinds reachable rather than theoretical.
- 2026-08-27 — **The `PaneCutSource` stand-in above is gone; `CutManager` is the implementation**
  (Phase-2 integrator, stage 4 of the merge). The entry above predicted the swap would be "one
  construction site in `engine.ts` and nothing else, because nothing else names the implementation",
  and that is what it was. `derived/cut-source.ts` is now the consumer's *view* of E-MESH's manager —
  its `CutSnapshot` / `CutRequestOptions` types re-exported, the four-method `CutSource` interface,
  and a type-level `CutManager extends CutSource` assertion that goes red in `pnpm typecheck` rather
  than in a Playwright run three stages later. `derived/cut-source.test.ts` was rewritten to assert
  the same four guarantees against the **real** manager through that interface, so the seam is
  pinned rather than claimed. What the stand-in's tests covered is covered there or in
  `compute/cut-manager.test.ts`, which is a superset.
- 2026-08-27 — **A `.msh.opt` tag colour is seeded into `tagStyle` only where the dataset's own tag
  does not already carry it** (Phase-2 integrator, found by A-PROPS's real-data tissue-table spec at
  the merge). E-SCENE's §7.6 seeding wrote `opt.tagColor[t]` into `MeshLayer.tagStyle[t].color` for
  every tag, reasoning that "an edit needs somewhere to live and a Reset something to put back".
  §6.2's ladder has already resolved that same colour onto `MeshTag.color` whenever the sidecar
  reached the loader — which is every real open — so the layer slot R5 reserves for the **user's**
  edit arrived pre-filled with the file's own colour. The consequence is not cosmetic: A-PROPS's
  per-row Reset and its `data-recoloured` marker exist to say whether a tag has been changed, and
  they could no longer tell a seed from an edit; nor could a `*.tetravox.json`, which would record
  an "override" nobody made. The Reset does not need the pre-fill either — it deletes the override
  and `tagColor()` falls through to `MeshTag.color`, the same value. So the seed now skips a colour
  that is byte-identical to the dataset's (§4.1's 0..1 quadruple round-trips exactly, so this is
  `===`, not a tolerance), and still seeds one where the tags were built without the sidecar, which
  is what E-SCENE's own unit fixture exercises. `tagStyle.visible` is seeded unconditionally: there
  is no `MeshTag.visible` for it to duplicate. This is the mesh half of the same rule the volume
  half now follows with `VolumeLayer.labelColors`: **the file's colours live on the dataset, the
  user's live on the layer, and a Reset is deleting a key.**
- 2026-08-27 — **`whenSettled()` draws once even when nothing is dirty, and waits for at most one
  vsync per call** (Phase-2 integrator, both found by running E-DERIVED's R4 specs on the merged
  tree). §7.2 makes this method mean "what you asked for is on screen", and it was not quite either
  thing. **(1)** With nothing dirty it returned without drawing, so a resource that only a *draw*
  discovers — the element-field table `fillIn2D` reads through `ownerTet`, the surface tables a
  glyph's origins come from — had not even been requested yet. Measured on `Thalamus_TI.msh` with
  `TI_max` on the cut: the frame after `whenSettled()` was the **tag** colouring and the frame after
  that was the colormap, so a pixel assertion or a golden taken at the documented moment
  photographed the wrong picture — the failure mode §11 exists to prevent. It now draws once, and
  the existing loop waits for whatever that registers. **(2)** Every repaint inside the loop waited
  a full `requestAnimationFrame`. The first one should: it lets the pump's own scheduled render
  happen instead of being duplicated. The ones after it are reached only because a worker result
  dirtied the frame again, and there is nothing left for a vsync to coalesce — while the wait costs
  a display frame each. R4's 20-step sweep paid two per step, which quantised a 12.9 ms cut plus its
  draw into **33.3 ms — two 60 Hz frames** — and put the measurement at 30.0–33.3 fps against R4's
  ≥ 30 bar, i.e. a gate that was measuring the display and flaking on it. One vsync per call: the
  same sweep is **44–47 fps over three runs** (median step 20–23 ms), which is the round trip R4
  actually names.
- 2026-08-27 — **A test that dispatches N inputs must wait for N to be handled, not for N to be
  sent** (Phase-2 integrator; E-SCENE recorded the same property for `page.mouse.wheel` and it is
  true of `page.keyboard.press` too). `pointer.spec.ts`'s R2 clamp test pressed `+` eighty times in
  a tight loop and asserted the 0.05 mm/px floor; on the headed ANGLE project one press occasionally
  outran the handler and the value landed at **0.06** — one 1.2× step short — while SwiftShader won
  the race every time. It now presses until the clamped value is observed, with a generous bound, so
  the assertion after it still fails if the clamp itself is wrong. Worth recording as a rule rather
  than a fix: on the golden-authority project this class of flake is invisible, so it will keep
  arriving through the GPU leg.

- 2026-08-27 — **E2E is windowless by default on macOS, and gives up no GPU coverage.** `pnpm e2e`
  launched ~20 visible windows, stealing the focus and re-tiling the developer's workspace each time.
  Both suites now run without one, gated on `TETRAVOX_E2E_OFFSCREEN=1` (set by `packages/app`'s
  `e2e/fixtures.ts` on darwin) with `TETRAVOX_E2E_HEADED=1` as the debugging opt-in; a user launch is
  unaffected. **Engine `chromium-angle`: `headless: false` → `headless: true`.** The leg was headed
  because that is how it reaches the platform GPU — but it is `channel: 'chromium'` (the full browser
  rather than Playwright's headless *shell*) that does that, not the window. Measured `[M2Max]`:
  headless full Chromium reports `ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max)`, `norm16` **true**,
  timer query true, `MAX_TEXTURE_SIZE` 16384, `MAX_DRAW_BUFFERS` 8, 36 extensions — identical to headed,
  against the headless shell's SwiftShader / false / 8192 / 6 / 29; the `@angle gate 6` R16 test runs and
  passes. `--use-angle=metal --enable-gpu --ignore-gpu-blocklist` and an explicit `--headless=new`
  changed nothing and are not passed. **App: a `BrowserWindow` that is never shown**, plus
  `app.dock.hide()` — same caps, 29/29 in both the `dev` and `packaged` projects, `page.screenshot()`,
  in-page `readPixels`, `setContentSize` and rAF all unaffected, gate timings 12.8 ms progress / 4.9 ms
  cancel against 200/500 ms budgets. Electron OSR (`webPreferences.offscreen`, with and without
  `useSharedTexture`) also passes 29/29 on ANGLE/Metal and was **rejected on cost**: it made the §12.1
  orbit benchmark read `gpuMs` 3.52/4.07 ms @1x/@2x against 2.02/3.32 for a never-shown window and
  doubled `cpuMs` median, so the mode that runs the benchmark would be the mode that inflates it; it
  also pins rAF to `setFrameRate` (61 Hz vs 122) and made `Page.captureScreenshot` disagree with
  `capturePage()` on the same frame (5,188 B vs 17,065 B). A shown window parked off-screen
  (`setBounds({ x: -10000 })`) — **rejected as measured-false**: macOS returned `x: -1240` and
  `CGWindowListCopyWindowInfo` listed the window on screen at `761,48,741x864`. `[M2Max]`
  `scripts/e2e-quiet-check.sh` is the standing proof (86 samples, frontmost unchanged, no window).


- 2026-08-27 — **The windowless-E2E proof had two holes: the focus check failed open, and the GPU leg
  could not fail.** Review of the entry above. (1) `scripts/e2e-quiet-check.sh` read the frontmost app
  with `osascript … 2>/dev/null` and used its stdout with no status check. Without Automation
  permission for "System Events" — a fresh machine or a CI runner, exactly who runs this script —
  `frontmost` returns the empty string, `BEFORE` and `AFTER` compare equal, the STOLEN/MOVED greps run
  over an empty file, and all three focus assertions pass **vacuously** while the script prints `PASS`:
  a window-only check wearing the badge of a focus check. Reproduced with a stub `osascript` that exits
  1 like a denied prompt — the old script printed `frontmost before = <unknown> … 0 samples … PASS`,
  exit 0. An empty reading (first, last, or any sample in between) is now **exit 2** with the
  permission instructions, as is a command that ends before the first 0.5 s tick; unreadable samples
  are recorded as `<unreadable>` rather than dropped, so "no samples" cannot masquerade as agreement.
  (2) `caps.spec.ts` was untagged, so `chromium-angle`'s `grep: /@angle/` excluded it: the `[caps]`
  block in that project's output was the *SwiftShader* leg's, and nothing on the ANGLE leg ever
  asserted the renderer. The only in-suite signal that the leg still reached the GPU was `@angle
  gate 6` **not skipping** — a silently skipping test, which is the failure mode §11 exists to prevent
  — and §2.1 had just removed the incidental cue of a window on screen. A third caps test, tagged
  `@angle` and skipped by project name elsewhere, now logs that leg's own capabilities
  (`capabilities-angle.json`) and asserts `isSoftware false`, `rendererClass 'angle-metal'` and
  `norm16 true`. `[M2Max]` it passes on `ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max, Unspecified
  Version)`; forcing that leg onto `--use-angle=swiftshader` turns it red with the renderer string in
  the message, and in that same run gate 6's R16 branch skipped itself — the empty-leg shape, now
  caught. `TETRAVOX_ALLOW_SOFTWARE_ANGLE=1` downgrades it to a skip for a runner with no GPU (the
  mirror of `TETRAVOX_REQUIRE_PACKAGED=1`, opposite default); `ci.yml` sets it on Linux only, so a
  hosted macOS runner that cannot reach Metal is a red leg naming the variable rather than a green
  empty one. Standing proof re-run after `pnpm package`, with `TETRAVOX_TESTDATA` exported and
  `TETRAVOX_REQUIRE_PACKAGED=1`: 87 samples, frontmost `ghostty` throughout, no window on screen,
  51 + 28 + 58 green. **`TETRAVOX_TESTDATA` is part of the recipe**, not decoration: without it the
  engine reports 19 passed / 11 skipped against 28 / 2 — the R16 gate among the skips — and the quiet
  check still prints `PASS`, because it proves what the run *showed*, never what the run *covered*.
  (The GPU assertion is the one part that does not depend on it: it passes in that run too, so a
  testdata-less suite can no longer hide a software leg either.)


- 2026-08-27 — **`GlyphSpec.origins: 'surface' | 'volume'` — the frozen field W-WASM's gap-2 op left
  unreachable.** W-WASM took gap 2 rather than closing it as "surface only": `meshCentroids` ships,
  and `docs/ARCHITECTURE.md` §6.5.2 already calls it "glyph origins for a **volumetric**
  `GlyphSpec`". Nothing named which spec asked for them, so the op had no consumer and
  `ernie_TDCS_1_scalar.msh`'s `E` over 5,900,498 elements could only be drawn on the surface — the
  one place §7.4's own rationale says the interesting arrows are not. `origins` is that name, in
  `packages/engine/src/scene/types.ts` (frozen, §12.3) with the §4.4 and §7.4 ARCHITECTURE edits in
  this commit. **Optional, defaulting to `'surface'`**: every existing scene, golden and
  `ViewSpec` on disk keeps its meaning, and `serialize()` needs no migration.
  Rejected: a *runtime* uniform selecting the table. The two tables are indexed differently — one
  origin per de-indexed triangle against one per tet — so the choice is constant for a draw and a
  uniform would pay a branch and a dead texture binding per instance to re-decide it. It is a
  `ProgramVariants` define (`TVX_GLYPH_VOLUME`), which is what §7.1 already does for `isLabel` and
  the clip-plane count. Also rejected: inferring `'volume'` from "the mesh has tets and no visible
  tri tags". A viewer must not guess which arrows the user meant.
  **The tag restriction moves from the shader to the request, and that is the substantive
  difference.** The surface path tests `faceTag` against the tag LUT's alpha per instance; the
  volume path cannot, because the op filtered before it strided and nothing per-origin is left to
  test. So `visibleTetTags(layer, ds)` builds the op's `tags` argument, hidden tissues cost nothing
  (their centroids are never computed, let alone shipped), and **every** tet tag hidden is a draw the
  engine skips rather than a request it makes — an absent `tags` means "no filter" to
  `tet_centroids`, so asking with an empty list would light the whole mesh up.
  Tri tags are excluded from that list. Not, as an earlier draft of the comment claimed, because
  including them "filters out every tet": `tet_centroids`'s `keep_tag` is
  `tags.is_none_or(|list| list.contains(&t))`, an allow-list, so an unmatched tri tag is simply
  inert. The real reason is narrower and worse — a mesh that numbers a tri tag the same as a tet tag
  would have the visible tri tag **re-admit the hidden tet tag**, silently undoing an R5 hide. The
  comment is corrected to say so.
  `subsample` keeps its §4.4 meaning in both paths but is applied in different places: the surface
  path strides in the shader (`uStride`), the volume path hands the same number to the op and then
  draws row *g* (`uStride = 1`), because striding an already-strided list would take one in
  `stride²`. `{ maxCount: n }` is an upper bound rather than a target on the volume path — the op
  strides over *surviving* tets, so a tag filter yields fewer than `n` — which is the same trade
  §6.3 already recorded for filtering before striding.


- 2026-08-27 — **The §8 status bar may never change height, because it resizes the drawing buffer.**
  Found by the first test that drives the app's canvas with a real mouse
  (`packages/app/e2e/pointer-realdata.spec.ts`), which is the seam between E-SCENE's P2-01 pointer
  layer and A-SHELL's `ViewGrid` and belonged to neither owner. `interacting` (§7.2, P2-02) is
  entered on `pointerdown`; A-SHELL's status bar reports it, because §7.2's "never degrade silently"
  is only true if the bar says so; the bar is `flex-wrap` and sits directly under the view grid,
  whose `ResizeObserver` owns `canvas.width/height`. So the two extra readouts wrapped the bar to a
  second line, it grew **24 px → 41 px**, the canvas shrank **837 → 820** device pixels, every pane
  re-fitted, and the world point under a *stationary* pointer moved **4.5 px ≈ 2.93 mm** `[M2Max]` —
  measured, not estimated: R1's gate asserts ±½ voxel and the drag landed 2.93 mm out, and R3's "the
  pixel colour at a fixed screen point is byte-identical before/after the left-drag (the scan did not
  move)" was false of every pixel, because the whole viewport had resized. On every gesture, in the
  shipping app, and in no test: `packages/engine/test/e2e/pointer.spec.ts` proves R1–R3 on
  `test/pages/scene.html`, where there is no status bar, and A-SHELL's own status-bar tests assert
  the readouts' *text*.
  The fix is a layout invariant, not a workaround in the pointer layer: `.tvx-strip` (a new
  `index.css` component) pins the bar to one non-wrapping 24 px row and scrolls horizontally instead
  of reflowing. Rejected: making `ViewGrid` ignore resizes while a gesture is live — that defers the
  jump to `pointerup` rather than removing it, and leaves the drawing buffer disagreeing with the
  pane rects in between, which `readPixel` reads as `0,0,0,0`. Also rejected: hiding the `interacting`
  readout — §7.2 requires it to be visible. The regression is asserted as what it is, a *layout*
  invariant: canvas size and `paneRect` are read with the button down and compared to their idle
  values, which is the only assertion in either suite that would catch the next chrome element that
  grows during a gesture.


- 2026-08-27 — **`sourceName` decoded after splitting, so every dataset opened by the app was named
  by its whole absolute path.** A-SHELL filed it as an observation ("`VolumeMeta.name` /
  `MeshMeta.name` is the whole absolute path on real data `[DATA]`") and worked around it in
  `defaultSceneName` and the relocate row; it is a loader defect, not a display choice, and it is
  fixed at the source. `datasets/source.ts`'s `fileUrl` builds `tetravox://file/${encodeURIComponent(path)}`
  (§5 directive A2), so **every separator in a real app URL is `%2F`** and the last *literal* `/` is
  the one after `file`: `path.slice(path.lastIndexOf('/') + 1)` returned the entire encoded path and
  `decodeURIComponent` then handed back `/Users/…/m2m_ernie/T1.nii.gz` as the file's *name*. That is
  what §8's layer panel, the info panel, a colour bar's title, a `ViewSpec`'s `DatasetRef.name` and
  the relocate dialog all read. It survived Phase 1 and Phase 2 because the §11 harness serves the
  reference dataset over Vite's `/@fs/<abs path>`, whose separators are **literal**, so every engine
  test took the basename correctly; and because the one app test that looked
  (`scene-realdata.spec.ts`) re-derived the basename itself, with a comment recording the bug as
  though it were the contract. Decode first, then take the last `/` **or** `\`. The test now asserts
  `'T1.nii.gz'` verbatim, which is the only form that can fail if this regresses.




- 2026-08-28 — **§9.2's `buildTopology` memory bar was never measured, and measuring it moved the
  number.** `docs/PHASE2-OWNERSHIP.md` lists it as a Phase-2 gate item explicitly deferred from
  Phase 1 ("nothing in Phase 1 clips or isolates"), owner E-MESH. The only `ernie_seeg.msh` heap
  assertion on `main` was on the **load** path (≤ 1024 MB) — a different arena, which is why §9.2 has
  two rows rather than one "< 2 ×" rule — so the 1.56 GB worst case shipped unmeasured.
  Measured `[M2Max]`, in `packages/wasm/e2e/realdata.spec.ts`: `ernie_seeg.msh` load 912.4 MB →
  after `buildTopology` **1,893.1 MB**; `ernie.msh` 341.8 → **846.1 MB**. The live-byte model is
  right (the growth over the load path is 981 MB against a 1,096 MB model of `TetTopology` +
  counting-sort transient), and the gap is §9.2's own rule read one step further: linear memory
  **grows and never shrinks**, so the load path's freed input block — 492 MB / 184 MB — is still
  mapped when the topology path allocates, and dlmalloc reuses only part of it. The observable peak
  is `load resident + topology arena`, never the larger of the two.
  §9.2 now carries both columns: the live-byte model, unchanged, and a **resident** bar per file,
  which is what `wasm_heap_bytes()` reports and therefore the only thing a test can assert. Bars are
  the measurement plus ~11–13 % (960 MB and 2,100 MB). Rejected: quoting the model as the assertion
  and letting the test fail — the model is not wrong, it is measuring live bytes, and a bar nothing
  can observe is the reason this was never measured in the first place. Also rejected: freeing the
  input earlier to close the gap — §5 rule 5 already drops it before `read_msh` returns; wasm cannot
  give the pages back. Shrinking the transient is §6.3's counting sort and belongs to Phase 3's
  performance pass, where it is worth ~597 MB on this file.
  The two tests cross-check the topology itself while they are there: `ernie.msh` yields exactly
  9,509,557 unique faces and 128,614 boundary faces, which are §9.2's component table and §11's
  Surface invariant respectively — a packed-key collision would flatter the memory number as well as
  losing faces.


- 2026-08-28 — **`MeshLayer.colorMode:'label'` was implemented at both ends and connected at
  neither, and the shader's index was wrong for `.label.gii`.** ROADMAP Phase 2 lists
  "`colorMode:'label'` for `.annot` / `.label.gii`" and R5 names surface annotations as one of the
  three things its Region panel must serve; `docs/PHASE2-OWNERSHIP.md` names the golden
  `mesh-label-colormode`. The golden did not exist, and the reason it did not is that the feature
  could not be reached: `MeshMeta.labelTables` carried the `<LabelTable>` on the wire (§6.5.1),
  `scene/fromMeta.ts` dropped it, `MeshDataset` had no field for it, and so `MeshLayer.label.table`
  — the `LabelTable` the mode needs — could only ever be set by a test that built one by hand.
  Three changes, in the order the data flows. `MeshDataset.labelTables` (frozen `scene/types.ts`,
  hence this line) receives it; `scene/defaults.ts` seeds `MeshLayer.label` from the first table a
  mesh carries, leaving `colorMode` at `'tag'` — seeding the *table* is what makes the mode
  selectable, and which colouring a surface opens in is the user's choice. And `read_gii` now
  applies §6.2's dense remap to a `NIFTI_INTENT_LABEL` array, which is the defect the wiring
  exposed: the shader indexes an `N × 2` palette by the node value and `.annot` was remapped at
  parse time while `.label.gii` was not, so `clamp(key, 0, N−1)` sent every key above the last dense
  index to the last entry. Measured on the new fixture: the whole patch painted Gamma, the last of
  four. It looks plausible, which is exactly §11's stated failure mode for an off-by-one in a label
  palette.
  A new fixture was needed because none could be rendered: `testdata/surf.label.gii` is
  deliberately data-only (a `.label.gii` that is not a surface), so
  `testdata/surf_labelled.surf.gii` is the same 4×4 patch **plus** a label array and the same
  `<LabelTable>`, with vertex labels chosen so four of its eighteen triangles are monochrome —
  `vLabelColor` is an interpolated varying, so only a monochrome triangle has a closed-form colour.
  `scripts/gen-fixtures.py` is deterministic, and the manifest diff is additive: one new `gifti`
  entry and the byte total.
  One test changed rather than being added: `packages/wasm/e2e/meshes.spec.ts` asserted the label
  field's raw max (11) against nibabel's reading of the file. It now asserts the dense max (3) and
  keeps the raw one as the manifest's, which is the distinction the remap is about.


- 2026-08-28 — **A saved scene did not record its `.msh.opt` or its label LUT, so reopening one lost
  every tissue name, every tissue colour and every label name.** §4.6 already said "`LabelTable`s
  are **not** serialised; they are re-derived from the dataset and its LUT on load" — and the spec
  did not record the LUT. `DatasetRef` was `{id, kind, name, path, fingerprint, absPath}`, so
  `Engine.load` re-opened each dataset with `{kind:'path', path}` and nothing else: the tissue table
  came back reading `tag 1`, `tag 2`, `tag 3`, `tag 5` … `tag 1099`, the head rendered in §7.6's
  deterministic fallback palette instead of the `.msh.opt` colours, the cursor block's
  `515 · Bone-Cortical` became `515 · —`, and the "defaults from ernie.msh.opt" chip was gone. R5's
  "selection persists through scene save/load" was met for the *edits* and not for the table they
  are edits against.
  `DatasetRef.sidecars` (frozen `scene/types.ts`, hence this line) records them. Anchored to the
  **dataset's** directory rather than to the scene file, because a sidecar travels with the file it
  describes — `ernie.msh.opt` beside `ernie.msh` — so a relocated dataset brings it along, which is
  precisely the case §8's relocate dialog exists for; an absolute fallback covers a LUT the user
  picked from somewhere else entirely. The engine remembers what the host handed to `addDataset`
  rather than re-deriving it: the app's `lib/sidecars.ts` *guesses* candidates from the dataset's
  name and checks which exist, and a user who picked a LUT the guesser would not have found must
  still get it back.
  Two consequences worth naming. `loadSource` now reads sidecars **best-effort**: a scene whose data
  moved without its `.msh.opt` must still open, and everything downstream already has an answer for
  "no sidecar" (§7.6's palette, `Label <id>`). The dataset's own failure stays fatal. And the app
  allow-lists the derived sidecar paths before `Engine.load` (§5 directive A2 serves only what main
  admitted), using the engine's own `sidecarPathsFor` — one derivation, exported, rather than two
  that can drift into a silent 403.


- 2026-08-28 — **§11's Transparency (ii) does not close in Phase 2, and the reason is a rule, not an
  omission.** §11 asks for "GM tag 1002 at opacity 0.5 with an opaque 10 mm sphere at the thalamus
  target, diffed against a **CPU per-fragment-sorted reference render**, reporting max per-pixel
  delta", and `docs/PHASE2-OWNERSHIP.md` says it "decides whether `twoPhase` is enough for v1 or
  depth peeling moves out of Phase 3 — report the number even if it passes". A reference render of
  that scene needs the mesh's triangles on the side doing the rendering, and §5 rule 3 and rule 7
  put them out of a Playwright spec's reach: bulk arrays never touch the UI thread, they arrive as
  GPU-bound transferables the engine uploads and drops, and 1.18 M triangles ray-traced per pixel in
  page JS is not a test in any case.
  What did close is **Transparency (i)**, on ernie, as a number rather than a look: the blend count
  `k = ln((P − S)/(G − S)) / ln(1 − a)` recovered per pixel from three renders of the same scene,
  measuring **median 1.000, p05 0.968, p95 1.014** over the crown with **0 of 363 channels** outside
  the convex hull of `{S, G, background}` (`packages/engine/test/e2e/mesh-real.spec.ts`). One sheet,
  blended once — `k = 2` there is exactly the double-blended back face §11 names. That covers "no
  sheet is composited twice"; what it does not cover is **order** between two differently-coloured
  sheets, which is (ii)'s subject.
  The vehicle for (ii) is the CPU reference renderer being built on `feat/reference-renderer`
  (`scripts/reference/`), which is exactly a per-fragment reference outside the browser. Until it
  can render a mesh, Phase 3's transparency decision stands on §7.2's measured depth complexity
  (4–6 median / 8–10 p90, ROADMAP Phase 3) rather than on a diff. Recorded as the one Phase-2 gate
  item that does not close, with its owner, rather than satisfied by a weaker test wearing its name.


- 2026-08-28 — **The mesh editor has ONE tissue list, and a row is a tissue rather than a tag.**
  The editor mounted two lists of the same thing: `panels/layers/mesh/TissueTable.tsx` and, under
  it, `panels/regions/RegionPanel` on the same `meshTag` source. Both listed the same tags, and both
  listed every tissue **twice** on top of that, because a SimNIBS `.msh` carries each tissue as a
  volume tag `t` over its tets (`1`…`10`) and a surface tag `t + 1000` over its tris (`1001`…), and
  `.msh.opt` gives the two the *same* name. `ernie.msh` therefore rendered as 19 rows, in two
  places, for ten tissues.
  `TissueTable` is deleted. The Region panel is the survivor because it had the behaviours the
  table never grew — click-select, ⇧/⌘ multi-select and R5's "clicking a tissue in a pane selects
  its row" — and it already served label volumes and annots, which are unchanged. `regions.ts` now
  pairs `t` with `t + 1000` (partner must be the other element kind) into one row keyed by the
  **volume** tag, with the two tag ids and element counts in `RegionRow.parts`. A row is a colour
  swatch, a name, a "Vol" and a "Surf" toggle with independent eye states, a count and an opacity
  slider; solo, show/hide/invert, search, recolour and opacity all move **both** tags, and the two
  toggles are the only gesture that addresses one tag.
  This is **presentation only**. Every patch still writes per-tag `MeshLayer.tagStyle`, nothing new
  is persisted, and a scene file means exactly what it meant. The editor's "Solid colour" control
  moved from the bottom of the old table into `FieldSection`, beside the colour-source selector it
  actually feeds.

- 2026-08-28 — **The headless capture surface is `--job job.json --out DIR`, not `--scene … --screenshot …`.**
  §8 sketched a Phase-3 CLI as `tetravox --scene s.tetravox.json --screenshot out.png --width 2400
  --background white [--headless]`: one file in, one picture out. The maintainer's ask (4) is broader —
  "load + auto-configure visualization, load + capture screenshots, create videos / sweeps through
  slices" — and a flag-per-option CLI cannot express a *sequence* of captures over one loaded scene.
  That matters for cost, not for taste: `ernie.msh` is 184 MB and about a second of parsing, so six
  figures from six invocations pay for it six times, and a sweep is a hundred captures.
  A job file is therefore a scene plus an ordered list of actions (`set` / `screenshot` / `sweep` /
  `orbit`), validated before a window exists, with a `job-result.json` naming what was written. §8's
  single-shot case is the one-action job. `--headless` does not exist: a `--job` run takes the
  offscreen window mode unconditionally, and `TETRAVOX_E2E_HEADED` does not outrank it.
  Two things follow that are worth stating. **PNG bytes cross IPC**: a screenshot the renderer just
  rendered, bounded by the window, written by main because main owns the filesystem — §5 rule 3's
  subject is raw *file* bytes, which still reach only the dataset's worker. And **a job window has no
  §8 panels**: they are 18 rem + 20 rem of chrome that no screenshot contains, and on a 700 px window
  they left the view grid about 100 px wide.
  No frozen interface moved. The GIF encoder and the PNG decoder are written in-repo (`main/gif.ts`,
  `main/png.ts`) rather than installed, per §12.3; ffmpeg stays optional and its absence is a warning,
  never a failure. Python client: `python/`, standard library only.



- 2026-08-28 — **A user-enabled display feature is never dropped mid-gesture: `edges` leaves the
  quality ladder.**
  §7.2's `interacting` `QualityLevel` named `edges false`, and `render/passes/mesh.ts` honoured it in
  `variantOf` / `capVariantOf` via a `qualityEdges` helper. The visible result, reported by the
  maintainer: with element edges enabled on a mesh layer, the edge lines vanish for the whole of
  every orbit / pan / dolly and reappear `settleMs` (120 ms) after the hand stops. On ernie that is
  every gesture, on both the tag surfaces and the cut caps.
  It was §7.2's own rule being broken by the level that wrote it. "Forbidden in the fallback set: any
  knob that changes displayed *values* rather than displayed *resolution*" was read as covering only
  readings like `interpolation`; a wireframe was filed under resolution. It is not. A feature the user
  reached over and switched on is *what is displayed* — the same category as which region is
  emphasised (`TVX_EMPHASIS`, never gated for exactly this reason). Cheapness of the flip was the
  argument for gating it (a program bind, no re-upload), and cheapness is not a licence.
  So the knob is **gone from the type**, not merely set to `true` in every level — the same
  enforcement `interpolation` has always had, and the reason `scene/types.ts`'s `QualityLevel` (a
  §12.3 frozen interface, edited here in the same commit as §7.2) now carries a comment saying so.
  `qualityEdges`, `FrameUniforms.edges` and the `edges?:` parameter on `variantOf` / `capVariantOf`
  are deleted; `TVX_EDGES` follows `MeshLayer.edges.surface` / `.caps` and nothing else.
  **What remains in the ladder is unchanged and still Phase 3**: `dprScale` (1 at every level, so it
  changes nothing), `msaa` and `capDecimation` — both pure resolution, neither with a consumer yet.
  A consequence worth stating: `edges` was the only live knob, so `interacting` now degrades
  *nothing*. §8's status bar keeps the indicator — a gesture in flight is worth showing — but its
  tooltips no longer claim a degradation the renderer does not perform, which is the same honesty
  §7.2 demands in the other direction.
  §11's E-SCENE obligation ("assert a pixel that the `interacting` level would have changed") is
  **inverted rather than deleted**: `pointer.spec.ts` now asserts the edge pixel is present at full
  quality *and* mid-gesture — byte for byte under a stationary press, and by an exact-edge-colour
  pixel count sampled in the middle of a synthetic orbit drag, against a transparent-edge control
  that counts zero. `mesh-real.spec.ts` runs the same shape on ernie's surface and cap edges under a
  mid-axial clip. `input/interaction.test.ts` pins that no level names the knob.


## 2026-08-28 — `VolumeLayer.iso3d`: the volume layer owns its 3D isosurfaces (directed task 2)

**Decision.** §4.4's `VolumeLayer` gains one additive, optional field, `iso3d?: VolumeIso3d`
(`{ enabled, iso, color, opacity, smooth, faceMode }`), and §4.7's `Engine` gains one member,
`iso3dStatus(layerId)`. The surfaces themselves are **derived, never stored**: `layers/iso3d.ts` is a pure
function from the volume layer to the `IsosurfaceLayer`s it implies, and the engine reconciles one
`IsoLayerRuntime` per derived layer, keyed by the owning layer's id, delivered to §7.2 through the new optional
`DrawInput.ownedRuntimes`.

**Why an owned surface rather than a second layer.** The maintainer asked to "render isosurfaces of NIfTI in
the 3D viewer". A standalone `IsosurfaceLayer` could already do it — and that is exactly the problem: the user
would have to add a second layer, point it back at the volume they are already looking at, and then keep the
two in step by hand. Nothing would hold the surface on the 4D frame the volume shows, or on the regions the
region panel just hid, or delete it when the volume goes. Deriving the surfaces on every reconcile makes all
four true with no synchronisation code, and makes them untestable-by-drift: the claim is a pure function, and
`layers/iso3d.test.ts` tests the function.

**What it did not cost.** No new geometry path. `marchingCubes` is Phase 1's, `layers/iso.ts` already owns the
op with latest-wins on a slider drag and a `GpuStore` cache keyed by the surface's inputs, and §7.2's iso draw
is unchanged. The surfaces draw in **3D panes only**.

**Defaults.** p95 for a scalar volume, because `m2m_ernie/T1.nii.gz`'s max is exactly 65535.0 `[DATA]` and a
`[min, max]` midpoint is an empty surface. Measured on that file p95 is 15991.17 against a median of −0.78 —
a head volume is mostly background, so p95 lands up the tissue histogram rather than on the scalp rind, and the
real-data test says so rather than asserting a shape the data does not have. For a label volume: one surface
per visible-or-selected region at `label − 0.5` in its LUT colour, background id 0 excluded.

**A label volume needed a new op, and this is why.** The first cut derived each region's surface as
`marchingCubes` at `label − 0.5`, on the reasoning that the level halfway below an id bounds it. That is
wrong, and the screenshot showed it: a label volume's samples are **ids**, so `value ≥ k − 0.5` is the union
of every id at or above `k`, and SimNIBS ids do not nest (`final_tissues` is 1 WM, 2 GM, 3 CSF, 5 scalp,
7 compact bone …, and 4 is absent `[DATA]`). "Compact bone" came back as the whole outer head. So §6.3 gains
`marching_cubes_label` and §6.5.2 gains `marchingCubesLabel` (both additive; `OP_NAMES` goes 18 → 19), which
read the volume through `value == label ? 1 : 0` and march at 0.5 — the region's own boundary and nothing
else's. `IsosurfaceLayer.source.label` (additive) is what selects it. Measured on `final_tissues.nii.gz`:
the isolated compact-bone surface encloses **601,788 mm³** against **601,300 mm³** counted (ratio 1.0008),
while the level set at 6.5 encloses 674,738 mm³ and is a different shape;
`crates/tvx-geom/tests/real_data.rs` asserts both halves, so the wrong answer cannot come back.

**Not done, on purpose.** An isosurface still has no clip plane: §7.2's iso draw disables clip distances, so
clipping one is a new shader path plus a further frozen field, and neither belongs in this change. Region
visibility shows interior tissue today.

## 2026-08-28 — every layout the app offers contains the 3D pane (directed task 3)

**Decision.** `LayoutKind` gains `'1+3'` (3D large at 2/3 width, the three slices stacked in the remaining
third) and `'3d+1'` (the 3D pane and one slice, side by side). The app's **catalogue** — the toolbar and the
`x` cycle — becomes `2x2`, `1+3`, `3d+1`, `3d-only`, and a scene naming a removed layout is migrated on load:
`1x1 → 3d+1`, `1x3` / `1x3-horizontal` → `1+3`, with the cells recomputed and the 3D pane leading.

**Why the removed kinds stay in the type.** The maintainer's ask ("the 3D viewer is always on") is a statement
about the *viewer*, and the enforcement point is the catalogue. §11's single-pane pixel harnesses set
`{kind:'1x1', cells:['axial']}` in some thirty specs; deleting the kind would rewrite every one of them and
turn a UI decision into a rendering-verification change. The brief also said to keep the engine's view model
intact. So `view/layout.ts` still lays out all seven kinds, and `migrateLayoutKind` — not a parse error — is
what a saved scene meets.

**Visual change, stated.** `packages/app/e2e/catalogue.spec.ts`'s `14-oblique-slice.png` was a `1x1` oblique
pane and is now `3d+1`: the same zoomed oblique slice, with the 3D pane beside it. `1x1` is no longer a button
to click.

---

## 2026-08-28 — Coordinate systems (directed task 8, `feat/coordinate-systems`)

- 2026-08-28 — **`toTemplate` grows a nonlinear form, and §3's "nonlinear warps are out of scope" is
  withdrawn.** Phase 2 derived `toTemplate` from `sform_code`/`qform_code == 4` and offered an affine
  matrix only. On the reference dataset that means the MNI readout is permanently greyed out with
  "not in a template space": every `m2m_ernie` volume is `sform_code = 2`, and SimNIBS 4's `charm`
  writes **no** `MNI2conform_12DOF.txt` or `MNI2conform_6DOF.txt` at all — those are a SimNIBS-3 /
  `headreco` artefact, and `subject2mni_coords(..., '12dof')` raises `FileNotFoundError` on ernie
  `[DATA]`. The transform that exists is the pair of warps in `toMNI/`. Affine-only was therefore a
  correct answer to the wrong question. `TemplateSpace` (§4.3) is the widened form; Phase 2's shape is
  still assignable.
- 2026-08-28 — **The two MNI answers are reported separately, never merged.** `MNI152 (affine)` and
  `MNI152 (nonlinear)` are two selector entries and two info-panel lines. They disagree by centimetres
  where the warp is doing work, and a single "MNI" row would not say which number a user copied into
  a paper.
- 2026-08-28 — **The inverse of a warp is the other file, not an iteration.** SimNIBS ships
  `Conform2MNI_nonl.nii.gz` *and* `MNI2Conform_nonl.nii.gz`, and `mni2subject_coords` samples the
  second exactly the way `subject2mni_coords` samples the first. So typed entry in the nonlinear space
  is a forward trilinear sample, exact to the same tolerance as the outbound direction — no
  fixed-point steps, and no "not supported". Round-tripping five ernie landmarks through both fields,
  SimNIBS itself returns to 2.0e-2 mm `[DATA]`; our forward and return samples match
  `subject2mni_coords` / `mni2subject_coords` to **1e-3 mm** `[DATA]`.
- 2026-08-28 — **The deformation fields are ordinary datasets, loaded on demand.** They go through
  `addDataset` — same worker, same `tetravox://file/…` fetch, same fingerprint — but get **no layer**:
  nobody wants to look at a warp, and `view/coord-spaces.ts` filters a *referenced* field out of the
  space menu (by reference, not by filename, because a user may have renamed it). They are 97 MB and
  230 MB on ernie, so they are loaded the first time the nonlinear space is **selected**, not when the
  subject volume opens: paying for a second dataset's worth of load before the first picture is on
  screen would be a worse default than a two-second wait on a menu the user just chose. The cost of
  reusing `addDataset` is one GPU texture per field that nothing draws; a separate no-upload load path
  would have been a second volume reader, which §6.1 exists to prevent.
- 2026-08-28 — **The nonlinear space is enabled by the *file existing*, not by the field having
  loaded** (`TemplateSpace.nonlinearAvailable`). Selecting the space is what starts the 97 MB load,
  and an HTML `<select>` cannot select a disabled `<option>` — so gating the option on "the field is
  in the scene" made the load unreachable from the UI. The e2e caught exactly that. The option is
  offered as soon as `toMNI/Conform2MNI_nonl.nii.gz` is known to exist, reads "loading…" for the
  seconds it takes, and `toSpace` still returns null until the samples are there.
- 2026-08-28 — **A `toMNI/` folder is discovered in the main process, and only text crosses the
  bridge.** §5 keeps the filesystem in main, and the folder is *beside* the volume, so nothing on the
  load path sees it. `main/subject-spaces.ts` walks up to three ancestors of the opened volume, reads
  the ≤ 64 kB affine text, and returns the two warps as **allow-listed URLs** — never their bytes
  (§5 rule 3, AGENTS rule 7).
- 2026-08-28 — **`tkr-RAS` is always reported with the volume it belongs to.** `vox2ras-tkr` is built
  from dims and spacing alone, so one subject's 1 mm `T1.nii.gz` and 0.5 mm
  `label_prep/T1_upsampled.nii.gz` are *different* tkr spaces. A bare tkr triple is not a coordinate,
  it is a guess; `ProbeResult.tkrVolume` and the selector's `tkr-RAS · <name>` label are the fix. The
  matrix reproduces `nibabel`'s `MGHHeader.get_vox2ras_tkr()` on ernie's T1 with **max abs error 0.0**
  `[DATA]`.
- 2026-08-28 — **The space selector is a `CoordSpaceRef`, not a string.** Phase 2's
  `'ras' | 'voxel' | 'mni'` could not name a per-volume space, and "Voxel (active layer)" silently
  re-pointed when the active layer changed. Every entry now carries its `datasetId`, so a chosen menu
  entry keeps meaning the same thing; a ref whose dataset has been closed resolves to null and the bar
  falls back to world RAS in **both** directions — it has to, because it is displaying a world triple
  and rejecting the number it is showing would be worse.
- 2026-08-28 — **The fsaverage correspondence is built in the subject's worker from a flat coordinate
  array, not from a second handle.** §5 rule 1 gives one worker one dataset, so no wasm instance ever
  holds both spheres. `mesh_vertices` reads the fsaverage sphere's 163,842 directions out of its own
  worker as one 2.0 MB transferable and `surface_sphere_map` takes them as `&[f32]`. The alternative —
  loading both surfaces into one worker — would have made a cross-dataset op the only op in §6.5 that
  violates the one-dataset rule, to save a 2 MB copy that happens once per session.
- 2026-08-28 — **`sphere_map` normalises both spheres before the nearest-neighbour search.**
  `lh.sphere.reg.gii` is radius 1.0000000 ± 8.2e-8 and `fsaverage/surf/lh.sphere` is 99.9923 …
  100.0080 `[DATA]`. The radius spread perturbs the squared Euclidean distance by ~3.1 against a ~9e-4
  angular signal, so the un-normalised argmin is a **different vertex on all seven** sampled ernie
  vertices — subject vertex 0 → 40,188 normalised, 161,546 raw. The real-data test asserts both
  values, the second as the answer it must not give.
- 2026-08-28 — **`nearest_vertex` is a linear scan and stays one.** One query per pick, 0.31 ms over
  245,762 nodes `[M2Max]`, against a permanent 3.4–9.2 MB index that nothing else would read.
  `sphere_map` is the case that needed a structure — 4.0e10 evaluations, ~50 s brute force against
  **42 ms** — and it builds a throwaway 64³ direction grid with an exact expanding-ring stop, so its
  output is bit-identical to brute force rather than approximate.
- 2026-08-28 — **A surface layer has a probe row for the first time.** `locate` is a
  point-in-tetrahedron search, so a 0-tet `.gii` produced no `ProbeRow` at all. `nearestVertex` runs
  for *every* mesh on its own latest-wins key, so `lh.central.gii` now answers with a vertex index and
  that vertex's own coordinate — which is deliberately **not** the probe point.



- 2026-08-28 — **Gmsh parsed post-processing views (`.geo` / `.pos`) load through `loadMesh`, not
  through a nineteenth op.**
  A parsed view is a literal dump of primitives — `View "" { SP(x,y,z){v}; T3(x,y,z,0){"E001"}; };`,
  which is how SimNIBS writes `m2m_*/eeg_positions/*.geo` — and its `ST`/`SQ` triangles *are* a
  surface with a per-corner scalar. Once they are a `Mesh`, every existing op works on them
  unchanged: `surface`, `field`, `contours`, `cut`, `locate`, the whole §7.4 shader path. A
  `loadGeoView` op would have duplicated all of that to gain nothing, and §6.5's frozen `OpName`
  union would have grown for a format, which is the one thing it is frozen against.
  So `MeshFormatSel` gains `'geo'` and `OpResult['loadMesh']` gains an **optional** `geo` half
  (§6.5.1 `GeoPayloadT`) carrying the three things a `Mesh` has no room for: points, `T2`/`T3` text
  labels and `SL` segments. `OP_NAMES` is still eighteen entries and `OP_TO_EXPORT` is unchanged;
  a `.msh` load sees no difference at all, which `packages/wasm/src/index.test.ts` asserts.
  The mesh is **de-indexed** — a parsed view has no node table, so `ST(…)` lists three independent
  corners. Welding them would need a tolerance and a tolerance would silently merge two electrodes
  of a dense net, so each corner is its own node and the per-corner values land on a node field
  named `value`. One `tri_tag` per view, so a multi-view file is one dataset whose per-view
  visibility is the existing `tagStyle` machinery.
  A `.geo`/`.pos` is routed by **extension**, not by `sniff`: content sniffing recognises a parsed
  view from its leading `View` token perfectly well, but then a `.geo` that turns out to be a Gmsh
  *geometry script* falls out of `sniff` as "unrecognised mesh format", burying the one message
  that says what is actually wrong with the file. `read_geo_view` rejects it as `Unsupported` and
  names the command — `Point(` — that gave it away.

- 2026-08-28 — **`PointsLayer` grows the parsed view's extras; the mode is `valueMode`, not
  `colorMode`; labels are drawn in the overlay pass and are NOT occlusion-tested.**
  §4.4's `PointsLayer` gains `labels` / `labelScale` / `labelColor`, `lineSegments` /
  `lineWidthPx` / `lineColor`, and `valueMode` + `colormap` + `valueRange` beside a per-point
  `value`. Every one is optional, and absent reproduces the Phase-2 behaviour exactly, so a scene
  file that names a points layer loads unchanged and no golden moves.
  It is `valueMode` and not the obvious `colorMode` because `MeshLayer.colorMode` is a *different*
  four-value union on the same `Layer` union: TypeScript widens a spread of `Partial<Layer>` to the
  union of both, and the collision broke every `addLayer({ ...patch })` call site — the app's scene
  restore is where it surfaced. Two knobs on one union may not share a name and disagree about its
  values.
  Per-point colours from `value` are resolved on the **CPU**, in `packPoints`. A dense net is 256
  instances × 8 floats = 8 KB, so recolouring the whole layer is cheaper than the LUT texture, the
  extra uniform and the shader variant a GPU colormap would need — and it keeps one testable
  definition of what a point looks like. The instance-buffer cache therefore keys on the colour
  inputs as well as on the `points` array's identity.
  **Labels are screen-projected in §7.2's overlay pass and a label behind the head still draws.**
  §7.2.3's pick target carries element ids, not depth, and it is rendered after the overlay in the
  frame it would have to be read from, so occlusion would need a `readPixels` stall per pane per
  frame or a second depth resolve. What is implemented is the free half: an anchor behind the eye
  or outside the pane is dropped, and a 2D pane draws only the anchors within one point radius of
  its plane — a 187-electrode net projected whole onto one axial slice is an unreadable smear of
  names belonging to slices 80 mm away. `SL` segments draw through the existing contour program, so
  they keep a constant screen width like a 2D contour; `gl.lineWidth()` is a no-op (§7.0.6).
  Installer: `.pos` is `rank: Owner`, `.geo` is `rank: Default`. The `.geo` extension is shared with
  Gmsh's geometry-script language, which this app does not open, so it must not claim to be the
  system-wide handler for every `.geo` on the machine.

## 2026-08-28 — two themes, and `Engine.setTheme` (directed task 9)

**Decision.** The app ships a **Light** theme (white/light-grey surfaces, near-black text, soft shading from a
one-step surface ramp and a hairline) and a **Dark** theme (graphite `#16181c`/`#1e2126`, not black), both
carrying one muted slate-blue accent — `#3b5ba9` on white, `#93aae2` on graphite. The Phase-1 cyan `#6ee7ff` is
gone, along with every saturated highlight it inspired: the histogram's cyan window handles and amber threshold
rule, the active-row and load-card bars, the toolbar's accent-coloured pressed state, the modal scrim's flat
black, and Chromium's own system-blue slider (`accent-color`). A toolbar group switches System / Light / Dark,
persisted in `settings.json` under `userData` and applied live — no reload, no remount.

**`renderer/src/theme/tokens.ts` is the single source of truth**, for the CSS variables *and* for the engine's
chrome, and `theme/tokens.test.ts` parses `index.css` and `main/index.ts` so neither can drift from it. Every
foreground/surface pair is held to WCAG 4.5:1 (text) or 3:1 (a UI boundary); the hairline is declared
`decorative` **in the table**, with its own visible-but-quiet bound, rather than quietly skipped — a separator
carries no information and a border you can see from across the room is the neon this task removes.

**§4.7 gains `setTheme`, and it is additive.** §7.2's pass-3 chrome is drawn into the GL framebuffer (§8 calls it
a laterality-safety requirement, §11 requires it in every golden), so CSS cannot reach it: without this member a
light theme flips every panel and leaves near-white orientation letters with a black halo. It is the neighbour of
`setAnnotations` — that says *which* chrome is drawn, this says what colour. A theme is **not** scene state and
is not serialised; `background` is the single exception and is forwarded to `Scene.background`, which §4.6
already carries. `OverlayBuilder.setHalo` exists for the one colour that must **invert** rather than shift, set
once per pane instead of threaded through four `draw*` signatures.

**No golden was regenerated, on purpose.** `DEFAULT_OVERLAY_THEME` is the Phase-1/2 constants verbatim — the
same near-white text, black halo, amber crosshair, blue active border and cyan gizmo — and `DrawInput.theme` is
optional, so a `DrawInput` with no theme draws what it always drew. `pointer.spec.ts` still finds the crosshair
by "bright in R and G, dark in B". The muted palette is what the *app* sends; the engine's own defaults are
unchanged and moving them stays a conversation, not a patch.

**The view panes stay dark in both themes.** Imaging convention: a light viewport changes what a greyscale T1
and a heat overlay look like. `ThemeTokens.paneBackground` is the per-theme option, and the overlay palette is
keyed off **the pane**, never off the theme name — so flipping it inverts the letters and the halo together,
and leaving it alone keeps a light-theme window's viewport a viewport.

**App settings are main's, not `localStorage`'s.** Every E2E launch gets a fresh `--user-data-dir` so two runs
cannot collide over the single-instance lock, which also discards anything per-profile — a preference in
`localStorage` could never be tested across a relaunch without giving that up. `main/settings.ts` owns a small
JSON file, `e2e/fixtures.ts` gains a `userDataDir` option, and `theme.spec.ts` launches twice against one
directory. Main also reads the file to choose `BrowserWindow.backgroundColor`, so a light-theme launch does not
open on a black rectangle.

---

## 2026-08-28 — the fsaverage read-out, app half (directed task 8, `feat/coordinate-systems`)

- 2026-08-28 — **The FreeSurfer subjects directory is an app setting, and nothing is bundled.**
  `fsaverage` is FreeSurfer's, ~6 MB per surface and ~50 MB per hemisphere of them, and every machine
  that wants this feature already has a copy. `AppSettings.freesurferSubjectsDir` (`''` = unset) sits
  beside the theme in `settings.json`; it describes the **machine**, not the data, so it is not a
  `ViewSpec` field. When it is empty, or the files under it are not there, the readout omits the
  fsaverage row rather than reporting anything — the same shape as a subject with no `toMNI/`.
- 2026-08-28 — **`coercePatch` exists because a patch is not a settings object.** `writeSettings` ran
  `coerceSettings({ ...readSettings(), ...coerceSettings(patch) })`, and `coerceSettings` fills every
  absent field with its default — correct for a file, data loss for a partial write. With one key it
  was invisible; the moment a second key existed, setting the subjects directory would have silently
  reset the user's theme. `coercePatch` keeps absent keys absent, and a field of the wrong **type** is
  dropped rather than defaulted, because defaulting is indistinguishable from the user asking for the
  default.
- 2026-08-28 — **The hemisphere comes from the file name.** A SimNIBS GIfTI pointset carries no
  `AnatomicalStructurePrimary`, so `lh.` / `rh.` is the only place it is written down. A surface that
  declares none — `ernie.msh` — simply has no correspondence, which is the same answer as an unset
  setting. Both spellings of the subject sphere are looked for (`lh.sphere.reg.gii` from SimNIBS,
  the extensionless `lh.sphere.reg` from FreeSurfer's own `surf/`); the reader sniffs the format by
  magic either way, so the only question is which name is on disk.
- 2026-08-28 — **The correspondence is built by the engine, from four ordinary datasets.**
  `Engine.attachFsaverage` composes `vertices` → `sphereMap` → `vertices`; the app only discovers the
  paths (in main, §5) and loads the files. The three helpers get **no layer** — nobody wants to look
  at a sphere — exactly like the `toMNI/` warps, and they are cached by path, so `fsaverage/lh.sphere`
  is read once however many surfaces of that hemisphere are open. The engine checks that the
  `sphere.reg` and the displayed surface have the same node count rather than trusting it: the map is
  indexed by the sphere's numbering and read with an index off the surface, and a mismatch would point
  the readout at a random gyrus instead of showing nothing.
- 2026-08-28 — **`EngineEvents` gains `probe`, and it fixes a hole that predates this branch.** §4.7
  has always said a mesh probe is "at most one round trip stale", but nothing told the app when the
  real row arrived, so §8's info panel showed a mesh row only after a *second* interaction — and for a
  surface, whose only row is the vertex, it showed nothing at all. `LayerRuntimeContext.probeLanded`
  now announces an async row and the engine re-emits it as `probe` when that point is still the cursor
  or the hover. A second `cursor` emit would have been the smaller change and the wrong one: the app's
  `cursor` handler clears the coordinate bar's draft, and a probe landing must not delete what a user
  is typing.
- 2026-08-28 — **An fsaverage coordinate is quoted in fsaverage's own tkr-RAS**, labelled with the
  surface it came from (`fsaverage lh.pial`) rather than called "RAS". §3 loads a FreeSurfer binary
  surface as-is when no companion volume is named, and tkr-RAS is the space `mris_info` and
  `nibabel.freesurfer.read_geometry` report — so the number in the panel is the number a FreeSurfer
  user expects, and the label says which space it is rather than leaving them to guess.

## 2026-08-28 — vector glyphs: verified against numpy, and a scaling model (directed task 7)

**What the verification found.** `scripts/reference/glyphs.py` (SimNIBS + numpy) and
`packages/engine/test/e2e/glyphs-real.spec.ts` compare the engine's own glyph instances against the
reference on `ernie_TDCS_1_scalar.msh`: every grey-matter tet whose centroid is within 0.05 mm of
`z = 40`, 1,397 of them. **Set equality on the element numbers, worst origin error 1.13e-5 mm, worst
direction error 2.83e-6°** `[DATA]`. Placement, the `ownerTet − 1` field indexing and the direction
were correct; three things around them were not.

* **`shape: 'line'` was ignored.** `render/passes/derived.ts` built `buildArrow(true)` once in its
  constructor, so a §4.4 value documented since the type was written drew a head anyway. There is now
  one template per `(shape, headProportion)`, built on first use — 24 triangles of constant data, a
  handful of keys per session, so still nothing like per-element geometry (AGENTS rule 7).
* **`clipToCutPlane` was inert.** §7.4 has always said "when a cut plane is active and
  `clipToCutPlane`, [restrict] to elements the plane intersects"; the renderer read the field
  nowhere. It is implemented as a slab test in the vertex shader — `onCutPlaneOnly` is the new
  spelling, `clipToCutPlane` still honoured — about the layer's **first enabled clip plane**, which is
  the only cut plane a 3D pane has. With no enabled plane the switch is inert *and the app's control
  says so*, rather than silently blanking the layer.
* **`scale: 'byMagnitude'` normalised to the field maximum**, which is the defect that made the
  feature unusable rather than merely incomplete. `E`'s maximum on the reference mesh is
  57.7899 V/m; its 99th percentile is 3.8458 `[DATA]`. The maximum is electrode gel. A grey-matter
  magnitude of 0.0182 V/m therefore drew 0.0019 mm of arrow at a 6 mm setting — 15× shorter than the
  same value against p99, sub-pixel at any zoom, and indistinguishable from a broken field lookup.

**Decision — `GlyphScaling`, additive on `GlyphSpec.scale`.** `scale` becomes
`'fixed' | 'byMagnitude' | GlyphScaling`, so every scene saved before today round-trips and reads
exactly as it did (`'byMagnitude'` = linear against `max`), while a new spec carries
`{ mode, lengthMm, normalizeTo, logFloor }`. The three decisions that were tangled in one word are
now three fields: the **shape** of the map (`fixed` / `linear` / `sqrt` / `log`), the **reference**
magnitude that maps to `lengthMm` (`p99` / `max` / a number / `null` for "per unit"), and where
`log` **bottoms out**. `GlyphSpec` also gains `onCutPlaneOnly`, `cutSlabMm` and `headProportion`, all
optional, all defaulting to today's picture. App defaults: **linear, p99, 6 mm**.

**Why a floor is not a nicety.** `E`'s minimum magnitude is 8.56e-13 `[DATA]` — thirteen decades
below its p99. Unfloored, `log` spends twelve of them on numerical noise. The floor defaults to the
field's 5th percentile, and at or below it the instance is dropped rather than drawn at a length the
scale cannot justify.

**One model, four consumers.** `derived/glyph-scale.ts` is the only implementation of the length
function, the legend sentence and the scaling word; the vertex shader carries the same arithmetic
term for term because it has to run per instance, and `glyphs.spec.ts` measures a **drawn** arrow in
pane pixels against it so the two cannot drift silently. The renderer and the §11 readback also share
`derived/glyph-plan.ts`, so a test cannot pass by asserting a different plan than the one drawn.

**A legend and a colour bar, because a length encodes a number.** The overlay's corner lines gain one
line per glyph layer, and §8's bars gain a third producer (`glyphColorbarSpec`) for the magnitude
ramp, titled with the scaling. Both are written in the alphabet `render/font.ts` actually has —
`A-Z 0-9 space . , : - + / ( )`, with **no `|`, `~` or `=`** — because a missing glyph decodes as a
space and `LENGTH ~ |E| = 6 MM` would reach the picture as `LENGTH   E    6 MM`.

**Visual change, stated.** The new golden is `derived-glyphs-log`. `derived-glyphs-e-field` is
regenerated: `Annotations.cornerInfo` defaults to `true`, so it gains the legend line at the bottom
left. Nothing else in it moves.

**A test-only readback, and why the engine carries one.** Everything a glyph *is* happens in the
vertex shader, so a golden PNG can only say that ink arrived. `Engine.glyphInstances` (gated on
`Engine.retainGlyphSources`, which the app never calls) reports the instances out of the same arrays
the tables were uploaded from. It is the only way §11 rule 0 — "an agent cannot judge a PNG; it can
judge a number" — reaches this feature at all.

## 2026-08-28 — scenes that just work: `ViewSpec` v2, Open Recent, drop-to-open (directed task 13)

`*.tetravox.json` is **version 2**. The bump buys two optional fields and one honest reader:
`theme` (§8's choice, so a scene mailed to a colleague opens looking as its author left it) and
`measurements` (directed task 11's, carried opaquely). `migrateViewSpec` in
`packages/engine/src/scene/serialize.ts` upgrades a v1 file — a version stamp, because everything v2
adds is optional — and it is the **only** place a version is decided, so `Engine.load` and a host
that read the file itself cannot disagree. `lib/scene.ts`'s `parseScene` accepts 1 and 2 and still
refuses 3: a future file opened as a current one restores the wrong scene silently, which is the
failure a version number exists to prevent.

**`theme` is not engine state.** `Scene` has no theme — the choice lives in `settings.json` and
reaches the engine only as a chrome palette — so `serialize()` does not and cannot produce the
field. The app writes it in `serialiseScene` and applies it on load *only when it is there*, so a
scene that never mentioned a theme does not override the reader's preference.

**Two round-trip bugs the audit found, and they were both silent.**

* `isRestorableKind` claimed `volume | mesh` only, "because `addLayer` derives a layer's kind from
  its dataset". That stopped being true when `defaultLayerFor` gained its `kind` parameter — which
  `addLayer` passes straight through, and two of whose four cases are `iso` and `points`. Every
  isosurface and every electrode-position layer was dropped from a reopened scene.
* `remapLayer` deleted `MeshLayer.label` **wholesale**, on the correct grounds that §4.6 does not
  serialise a `LabelTable`. But `mode`, `outlineWidthPx` and `visibleLabels` are things the user set,
  and they went with it: every saved scene reopened with its annotation back in `fill`, at the
  default width, with every hidden region visible again. The settings are now carried and
  `Engine.addLayer` merges the re-derived table back underneath them — the one place that can, since
  it is the one place that has the seeded layer.

`packages/engine/src/scene/roundtrip.test.ts` is the guard: a fully-populated layer of each of the
four kinds, through `toViewSpec` → JSON → `migrateViewSpec` → `remapLayer`, deep-equal to what went
in. A field a user can set and a scene file loses now fails a test.

**One `Engine` member, optional: `setSceneDir`.** It existed on `TetravoxEngine`; the facade did not
declare it, so the app could not tell the engine where the file was about to be written and paths
were measured from the datasets' common directory instead. Optional rather than required because
`MockEngine` has no dataset paths to be relative to.

**Scene files take the scene route, decided in main.** `main/menu.ts`'s `isScenePath` matches the
whole compound suffix (a §7.6 `_LUT.json` colormap is a `.json` and is not a scene), and `sendOpened`
splits a selection into datasets and scenes. That makes one set of doors — the menu, ⌘O, a drop,
argv, `open-file`, a second instance, Open Recent, "reopen last scene" — serve both kinds, and the
renderer never sniffs a filename. Only the **last** scene of a multi-selection is opened: loading
several in sequence would show each one only to discard it.

**A drop needs an allow-list entry.** `openScenePath` now calls `allowPath` before `readSceneFile`: a
dropped scene has never been through a dialog, so main has not admitted it, and the read would have
failed with "not on the allow-list" for a file that is right there. The call is idempotent, so every
route takes one line.

**Open Recent is ten paths in `settings.json`, and the menu is rebuilt, not mutated.** An Electron
menu is immutable once set, so "the list changed" is `buildMenu(getWindow)` — which is why
`tetravox:remember-scene` lives in main and the renderer only reports the path. Entries are
allow-listed at **click** time, not at build time: admitting ten paths on every rebuild would open
files the user has not asked for this session. A dead entry is dropped and the menu rebuilt, so it is
never offered twice.

**"Reopen last scene on launch" is off by default,** and only fills a startup slot nothing else
claimed. Reopening a scene reloads every dataset in it, which for a 184 MB head mesh is seconds of
work nobody asked for; and a launch that names a file — `Tetravox study.nii.gz`, a double-clicked
scene — is a user saying what they want open, which a remembered scene must never overrule.

**The dirty marker is conservative on purpose.** `sceneDirty` is set from the engine's own events
(`layers`, `datasets`, `cursor`) plus any frame drawn at `interacting` quality, which is §7.2's
signal that a camera is being moved and the only one §4.5's view state has. A gesture that ends where
it began still marks the scene dirty: "possibly changed" and "changed" have the same right answer for
a save prompt, and the opposite mistake loses work. A scene with no datasets is never dirty.

**The Save sheet opens on a path, not a name.** `<first dataset's directory>/<name>.tetravox.json`,
anchored on the ref's `absPath` — the scene-relative `path` is measured from a file that does not
exist yet. A typed name with no extension gets `.tetravox.json` in `main/scene-io.ts`, because
without the suffix the file association does not fire and dropping the file back on the window opens
it as a dataset.

## 2026-08-28 — The orientation cube, the scale bar, and six presets that were four

Directed task 10. Two items §4.5's `Annotations` has named since Phase 0 — `scaleBar`, and now
`orientationCube` — and neither was drawn. Both are §7.2 pass-3 items, both take the pane's
**bottom-right** corner (corner info is bottom-left, the badge top-right, the colour bars down the
right edge from under it, the orientation letters at the edge midpoints), and they can never contend
for it: a cube is a 3D-pane item and a bar a 2D one.

**`Annotations.orientationCube` and `ScreenshotOptions.include.orientationCube` are additive changes
to frozen files** (`scene/types.ts`, `api.ts`), made with ARCHITECTURE §4.5 / §4.7 / §7.2 / §8 in
this commit, per rule 4. Both default **off** in `scene/defaults.ts`, for the reason `scaleBar` and
`colorbars` do: an engine default that moves every golden with a 3D pane in it is a conversation, not
a patch. The app turns both on at attach and gives them toolbar buttons, the same shape the colour
bars already had.

**The bar is snapped, and the snap is the feature.** `1 / 2 / 5 / 10 / 20 / 50 / 100 mm`, the rung
picked so the drawn length lands in 60…160 px. A bar labelled `137 mm` is arithmetic, not a ruler.
The **drawn length is `mm / mmPerPx` exactly** — never rounded to the rung — and §11 measures it off
the framebuffer at two zooms rather than comparing `snapScaleBar` to itself, because a scale bar is a
promise about a distance and a promise nobody measured is decoration. `ZOOM 1.42X` in the corner info
is a ratio to a fit the reader of a saved PNG never saw; that is what this closes.

**The cube gets its own projection.** Not the pane's view-projection (which the gizmo does use): the
cube must be the same size at every dolly and must not meet the near plane. It is an orthographic
projection of a unit cube at `half/√3` px per unit, which is the scale at which **no** rotation can
push a corner out of its box, so it never grows into the corner info as the camera turns.
`cubeFaces` produces the picture *and* the hit test — the same rule `overlay/gizmo.ts` states as "a
handle you can see and a handle you can grab have to be the same three points" — and a click routes
through `Engine.cameraPreset`, so the cube and §7.5's `1..6` keys are the same six views by
construction. Colours are the theme's `text` and `halo` and nothing else: a face is `halo` mixed
toward `text` by its Lambert term, capped at 0.48, which keeps the **letter** the brightest thing on
the cube — §11 decodes those letters with the same 5×7 template matcher §8's chrome uses, and a face
as bright as its own label decodes as a filled cell rather than as an `A`.

**`presetRotation` was wrong for four of its six, and the cube is what exposed it.** Composed out of
`quat.rotateX` / `quat.rotateY`, which **post-multiply** — they rotate in the quaternion's *local*
frame, so `rotateY(q, id, −90)` followed by `rotateX(q, q, −90)` applies the X rotation first in
world terms. Measured on the shipped code, presets 1–4 all produced the eye axis `(0, 1, 0)`: `A`,
`P`, `L` and `R` were **one anterior view in four different rolls**, and `A` itself was upside down
(`up = (0, 0, −1)`). Nothing caught it because nothing in the product pictured the camera's
direction — which is exactly what the cube does, and a cube built on that table would have shown `A`
for a click on `L`.

The fix names the three vectors `camera3dMatrices` actually reads out of the rotation (`right`, `up`,
`back`) and derives the quaternion from them, so a preset is data rather than a composition order.
`up` is superior for the four lateral views and anterior for the two axial ones, and `right` is
`up × back`; the inferior view is therefore the axial view **mirrored left-for-right**, not rolled
180° as it was. `test/unit/geometry.test.ts` pins all six as directions, through
`camera3dMatrices`, so a future refactor of the quaternion cannot quietly re-break them. No golden
moves: nothing in §11 photographed a preset.

**New goldens:** `scene-scale-bar` (a 2D pane at 0.1 mm/px, `10 MM` over a 100 px bar, with the rest
of the chrome on so a future layout change that collides with it fails here) and
`scene-orientation-cube` (a 3D pane off-preset, three shaded faces labelled). Real data:
`docs/screenshots/directed-2026-08-28/cube-scalebar.png` — ernie's T1 in the 2×2 layout, three scale
bars and a cube over the slice planes in 3D.

## 2026-08-28 — surfaces in the 2D panes (directed task 12, `feat/surface-contours-2d`)

**The reference is a Freeview screenshot**: `lh.pial.gii` over `T1.nii.gz`, its intersection with
each plane drawn as a thin yellow outline on the axial, sagittal and coronal panes, the surface
itself shaded in 3D. Everything below is what that picture costs, and nothing more — the geometry
(§6.3's `surface_contours`), the op (`contours`), the store path
(`derived/store.ts#surfaceContourGeometry`) and the screen-space quad expansion (§7.0.6) were all
already there and are untouched. What was missing was that the picture never appeared by default,
had no colour of its own, and could not be clicked.

**A default changed, which `scene/defaults.ts` says is a conversation.** A **surface** — a
triangle-only mesh, `nTets === 0` — now opens with `contoursIn2D: true`, `fillIn2D: **false**`,
`contourWidthPx: 1.5` and a `contourColor` from `SURFACE_CONTOUR_PALETTE`. `fillIn2D` goes *off*
because a tet-less mesh has nothing to fill: `paneCut` sends it to the `contours` op, which returns
lines and no polygons, so the toggle was advertising an operation that could not happen. **A tet
mesh does not move**: R4's `contoursIn2D: true` / `contourWidthPx: 1` / `fillIn2D: true` are still
what `ernie.msh` opens with, and no existing golden contains a surface layer in a 2D pane.

**`MeshLayer.contourColor?: vec4`, appended to a §12.3 frozen interface** (§4.4 and §7.4 edited in
the same commit). `undefined` means "the layer's `edgeColor`", which is exactly what every mesh
contour drew before, so the field is invisible to every scene that predates it. It exists because a
surface's contour is the *whole* of that layer's 2D presence and a tissue mesh's contour is its
wireframe seen edge-on: one wants a colour of its own, the other wants the colour the user already
picked. The palette is seeded **in `Engine.addLayer`**, not in `defaultMeshLayer`, because the index
is "how many surfaces this scene already holds" and a pure function of one dataset cannot know it.
Entry 0 is Freeview's yellow; cyan is absent because Freeview means the white-matter surface by it.

**Fills first, then contours, across layers.** `DerivedPass#run2D` drew each layer's fill and
contour together, so a surface opened before a tissue mesh had its 1.5 px outline buried under that
mesh's fill. §7.4 puts contours above the volumes and the fills; the pass now makes two passes over
the same collected cuts. One layer's two draws keep their relative order, so no single-mesh golden
moves.

**The contour pick is a CPU nearest-segment test, not the pick pass.** §7.2.3's pass draws mesh
triangles and slice quads into an id buffer; a contour is neither — it is an instanced screen-space
quad in the *derived* pass. Adding it there would mean a second expansion program whose only job is
to be 1.5 px wide in a buffer nobody looks at, and it would have to reproduce the expansion exactly
or the drawn line and the clickable line would differ. Instead `overlay/contours.ts` — which already
holds the CPU twin of the vertex shader, for §11 — gains `segmentDistanceSqPx` /
`nearestContourDistanceSqPx`, and `Engine.contourAtScreen` runs them over the segments the last
frame drew (`DerivedStore.paneContourSegments`). A pial contour is a few thousand segments and a
click is one event, so a linear scan needs no acceleration structure. `setCursorFromScreen` calls
it, so a plain left-click selects the surface **in addition to** setting the cursor — R1's gesture is
not replaced. The unit test asserts the two functions against `expandContourSegment` rather than
against hand-computed numbers, because the invariant that matters is that a point inside the drawn
quad measures less than half the width.

**Verified against numpy.** `scripts/refvalues/contour_refvalues.py` (nibabel + a vectorised
plane-triangle intersection) writes `contour_refvalues.json` for `lh.pial.gii` at the ernie cursor —
its bounding-box centre — on all three axis planes;
`crates/tvx-geom/tests/real_data.rs::surface_contours_match_numpy_on_lh_pial` asserts total contour
length within 1 % on each and every endpoint within 0.1 mm of a reference segment on the axial one.
Measured: 3,312 / 2,153 / 4,092 segments and 1075.328 / 711.678 / 1336.458 mm. Only the axial
plane's geometry is committed — three planes of segments is a megabyte of JSON in the tree — and the
other two carry the count and the length, which is the whole of the length assertion.

**Visual change, stated.** One new golden, `derived-surface-contours-2x2` (the fixture surface in
the 2×2 layout: yellow outlines on three panes, the shaded patch in 3D). No existing golden is
regenerated.

## 2026-08-28 — the measurement tool is scene state, and its points are world millimetres

`docs/PLAN-2026-08-28-directed.md` #11. `Scene` gains `measurements: Measurement[]`, `ViewSpec` gains an
**optional** `measurements`, `EngineEvents` gains `measurements`, and `Engine` gains four members —
`setMeasureMode`, `measureMode`, `addMeasurement`, `removeMeasurement`, `cancelMeasurement`. Three frozen files
(§12.3): `scene/types.ts`, `api.ts` and ARCHITECTURE §4.5 / §4.6 / §4.7 / §7.2 / §7.5 / §8 changed in the same
commit. Every change is additive; the `ViewSpec` field is optional, so a `*.tetravox.json` written before today
still loads and means "no measurements".

**Why `Scene` and not a layer.** A measurement has no dataset, nothing colours it, and nothing about it belongs
in the layer panel's stacking order — a layer row for one would carry an eye, an opacity slider and a position
in the transparency sort, none of which mean anything. And not host chrome either: R5's "edits persist in the
scene" is exactly what a measurement is. A note that vanished on save/load is a note taken in disappearing ink.

**Why world millimetres.** §3 fixes one world, and the two clicks are turned into world points before they ever
reach a `Measurement` — `paneToWorld` in a 2D pane, the §7.2.3 `pick` in the 3D one. So the number does not move
when the pane is zoomed, when the convention flips to radiological, or when the same segment is read off the 3D
pane. A screen-space length scaled by `mmPerPx` would be right only for a point that happens to lie on the plane
it was clicked in, and silently wrong for every 3D pick. §11's gate asserts exactly this identity from the other
side: two clicks at pane pixels `p1`, `p2` give `hypot(p2 − p1) · mmPerPx`, to within 0.05 mm, derived from §3's
orthonormal basis rather than from the engine.

**Why the mode is the engine's.** Only the engine can turn a pane pixel into a world point (a 2D cursor is the
pointer ray ∩ that view's *derived* plane), and §8 forbids the app deriving it. The app owns the toolbar button,
the `m` key and the panel; everything else is `Engine.setMeasureMode` and the pointer layer's
`addMeasurePoint` — the same shape as §7.5's plane-from-3-points, which already consumes clicks this way.

**Three clicks, one measurement.** Two clicks make a `'distance'` and it is stored immediately, so the common
case needs no third click; the third **promotes that same row** to an `'angle'` with the vertex at the shared
endpoint, rather than leaving a stray segment behind and adding a second measurement. `Esc` drops the gesture and
nothing else. The half-placed gesture rides on `DrawInput.measureDraft`, never on `Scene`, for the reason
`DrawInput.gizmo` does: a saved scene must not carry transient pointer state.

**`OverlayTheme` gains `measure`, and `Measurement.color` is an optional override.** The colour is the theme's by
default and only the theme's, so a measurement saved under the light theme is legible when reopened under the
dark one — baking a colour in at placement time would make "theme-aware" false for the one kind of scene content
that outlives the window it was made in. The default is magenta, chosen the way the gizmo's cyan was: three
overlay items that can share a pane need three colours a test can name without a tolerance that also matches
their neighbours.

**A visual change, stated.** Nothing moves in any existing golden: `Scene.measurements` starts empty, the
overlay item returns before writing a vertex when it is, and `DEFAULT_OVERLAY_THEME`'s existing seven fields are
untouched. The new picture is `docs/screenshots/directed-2026-08-28/measure.png`, on `T1.nii.gz` + `ernie.msh`.

**One placement bug §11 caught, and the fix.** An angle's label was first lifted straight up from its vertex,
which put it on top of a vertical arm; the chrome decoder read `90.0 DEG` back as `90.0LDEG`. It is now pushed
out along the **bisector** — by construction the direction furthest from both arms. That is the whole value of
decoding a label out of the framebuffer rather than looking at it: a golden PNG would have passed.

**A test-helper change.** `test/helpers/chrome.ts`'s `ChromeReadOptions` gains an optional `ink` predicate.
Its default is tuned for the near-white chrome text and reads every glyph of a magenta label as blank; a caller
that knows what colour its text is now passes the test for that colour. Additive, and every existing caller is
unchanged.

**A `tetravoxrc` config file, and the unified settings dialog (directed task: unified settings,
2026-08-28).** All app preferences now sit behind one toolbar gear and one tabbed `SettingsDialog`
(Appearance/Capture/Paths/Startup), replacing the three-scattered-controls state (theme in the toolbar,
subjects dir + reopen in the old settings dialog, screenshot options only in the screenshot dialog).
Alongside `settings.json` (Electron `userData`, edited only through the app) there is now a hand-editable
rc file: `$TETRAVOX_HOME/tetravoxrc` if `TETRAVOX_HOME` is set, else `~/.tetravox/tetravoxrc`. It is plain
JSON (a `_comment` field stands in for the comments JSON cannot carry) and is created with a starter file
on first run via `ensureRcFile`. Precedence is **hardcoded defaults < `tetravoxrc` < `settings.json`** —
the rc file sets a machine-wide default, and anything picked in the running app's dialog wins. A missing or
corrupt rc file degrades silently to the defaults, exactly like `settings.json` always has. `AppSettings`
gains `screenshotDefaults` (`background`/`dpi`/`scale?`/`autoTrim`), merged into the live
`screenshotOptions` on startup. The screenshot gear still opens `ScreenshotDialog` directly rather than the
settings dialog's Capture tab — several e2e specs drive that dialog's own testids (target/size/dpi/
background/include/preview/save) and its live Preview needs the real `Engine.screenshot` call, which the
settings dialog has no business holding — but `ScreenshotDialog` gained a "Defaults…" button that jumps to
Capture for the standing preferences.

## 2026-08-29 — no coverage badge, no `badges` branch

The README's coverage badge was served from an orphan `badges` branch that every push to `main`
rewrote with a `coverage.json` for `img.shields.io/endpoint` — a workaround for Codecov refusing
tokenless uploads. The owner does not want a bot-maintained branch as the mechanism. Removed: the
badge, `scripts/coverage-badge.mjs`, the `test:coverage` script and vitest `coverage` block, the
Codecov upload, the CI publish step, and the branch itself. `ci.yml`'s `test` job is back to
`contents: read`. Coverage is not tracked until there is a mechanism that does not need a bot branch
(a Codecov token, or a reporter with no external service).

## 2026-08-30 — `VolumeLayer.iso3d.opacity` multiplies the layer's opacity

**Decision.** A volume layer's derived 3D isosurfaces are drawn at `LayerBase.opacity × iso3d.opacity`,
not at `iso3d.opacity` alone. `derivedIsoLayers` (`layers/iso3d.ts`) is the one place it is computed.

**Why.** The 2026-08-28 design made the surfaces' opacity "independent of the slice", so that a ghost
shell could sit over a solid slice. In use, the layer panel's opacity slider then did nothing to the
surfaces, and the owner reported it as a bug — the slider is *the* opacity control a user reaches
for. Multiplying keeps the ghost-shell case (`iso3d.opacity < 1`) and makes the slider govern the
surfaces as it governs the slices. The default `iso3d.opacity` is 1, so every scene saved before
this renders the same unless its slider was below 1 — in which case it now renders as the user
expected when they dragged it. Additive: no `ViewSpec` field changes.

## 2026-08-30 — `worker-src blob:` is removed from the renderer CSP

**Decision.** `main/protocol.ts`'s policy for `tetravox://app` drops `blob:` from `worker-src`,
leaving `worker-src 'self'`. `img-src 'self' data: blob:` is unchanged.

**Why it was there, and why it is not.** Nothing ever asked for it. Both of this app's workers are
built from a `new URL(…, import.meta.url)` that Vite emits as a same-origin asset under
`tetravox://app/assets/…` — the engine's dataset worker (`packages/engine/src/engine.ts`) and the
Phase-0 skeleton's (`renderer/src/Phase0App.tsx`) — so `'self'` covers every worker that is supposed
to exist. What `blob:` covered was the one that is not: a module Worker constructed from a Blob of
text the page fetched, which is a working script-execution path through a policy whose whole point is
`script-src 'self'`. It is an undesigned door, and closing it costs this build nothing.

**Why now.** The modules surface (§13) is first-party and compiled into `out/renderer`; §13.8
describes a later stage where a module's code is loaded at runtime, and a Blob module Worker is
exactly the mechanism that stage would reach for. Closing the door **before** anything wants it is
what makes opening it later a deliberate, argued change rather than an accident that was already
permitted. Nothing in §13 needs a CSP change: no new scheme, no `tetravox://ext`, no `script-src`
edit.

**The directive is narrowed, not deleted.** Removing `worker-src` entirely would fall back to
`child-src` and then to `default-src 'none'`, which forbids *every* worker — the dataset worker
included, i.e. the whole application. `worker-src 'self'` is the change; the empty diff would be a
catastrophe.

**How it is verified.** `packages/app/e2e/csp.spec.ts`, which asserts the policy from inside the page
it governs — the CSP is a response header, not a `<meta>`, so there is nothing in the DOM to read.
Constructing a Blob module Worker fires a `securitypolicyviolation` naming `worker-src`; a Blob PNG
still loads into an `<img>`, which is the screenshot dialog's preview; and every other app E2E that
opens a dataset exercises the same-origin worker that must keep working. The dev server carries no
CSP, so this is a built-app assertion, as `e2e:packaged` is.

## 2026-08-30 — Modules: a first-party extension surface (feat/modules-host)

**Decision.** Tetravox gains a **module** surface: a first-party tool, compiled into `out/renderer`, that owns
one kind of data end to end — its own panel, keys, files and undo. §1's `plugins` non-goal is **narrowed**,
not withdrawn: "third-party runtime-loaded plugins (first-party modules are §13)". The whole contract is the
new ARCHITECTURE §13; this entry records the choices behind it.

**First-party first, and why the alternative was not chosen.** A runtime-loaded tier is a different product:
a module Worker with no DOM, a JSON-only bridge, permissions with reasons, a Restricted Mode for a scene that
arrives with an unknown module, a single-file library build, a §5 rule 9 rewrite and a security review — 8–9
engineer-days and a different threat model. First-party costs none of that and loses nothing that exists
today, because "community" here means a pull request that adds one directory. §13.8 keeps the path open and
names its price. The one thing stage 1 does that makes stage 2 a port rather than a rewrite is the **import
wall**: `modules/<id>/**` may reach `../host`, the shared control kit and `@tetravox/engine` **types**, and
nothing else. It is an ESLint rule *and* a source scan in `modules.test.ts`, because a lint rule can be
disabled inline and a test cannot.

**A docked slot in the right column, not a floating palette and not a tab.** The shell has no floating,
draggable or popover primitive; pane overlays are `pointer-events: none` by contract, so a palette over the
canvas would fight the WebGL grid for pointer capture; and at 1512 px the sidebars already take 608 px, so a
floating editor would cover the very pane it asks the user to click in. A *tab* was rejected for a different
reason: the feedback most module actions are judged by is the info panel's Cursor block — the value under the
crosshair — and a tab hides it at the moment it matters. The slot renders nothing while idle, so the DOM is
unchanged with no module active, and it sits outside the info panel's scrolling container, which is what makes
its 55% cap hard rather than advisory.

**One switcher in the toolbar's right column, never a button per module.** Measured, not aesthetic:
`Toolbar.tsx` is `flex-wrap`, and a second module's button in the centre cluster wraps the row at 1440 px,
which grows the header and shrinks the view grid — the same canvas-resize class the status bar was pinned
against. The status cell goes **before** the dataset cells for the same kind of reason: two BIDS-named
datasets already overflow `tvx-strip`, which does not scroll, and `ml-auto` cannot pull a cell back inside a
container that has overflowed.

**A synchronous host with a lint wall, rather than async JSON from day one.** Every scene read and write is a
call into the engine through the controller, exactly as every §8 panel's is; only files, dialogs and
confirmations are promises, because those already cross a process boundary or wait for a person. Stage 2 costs
a mechanical `await` pass over the modules that exist then. Making every call async today would have bought
that same pass in advance, at the price of every module's readability, for a tier that may never be built.

**`host.ts` is pre-freeze, and says so with dates.** Three of its members are backed by work that has not
landed — `scene.peakCentroid`, the whole of `tool`, the whole of `files` — so freezing it now would freeze it
around stubs. It grows additively and is declared frozen (§12.3 item 6) in the commit that lands the last of
them: one governance round rather than four. Meanwhile an unwired member **throws `ModuleHostError`** rather
than returning a plausible `null`, because "this build has no point tool" and "nothing is selected" must not
be the same answer to a module written against the finished surface.

**Persistence is core-typed layers plus one opaque block.** A module's geometry is ordinary `Scene.layers`, so
a build without the module still draws the scene and no pass or property editor grew a case. Its own record is
`ViewSpec.extensions[<moduleId>]`, written by the app's `serialiseScene` exactly as `theme` is and for the
same reason — `Engine.serialize()` enumerates engine fields, and a module's record is not one. A block never
holds a `LayerId` or a `DatasetId` (both are reassigned on load), is capped at 256 KiB, and — the rule that
makes the format shareable — **a block belonging to a module this build does not have is carried through
verbatim**, so opening a colleague's scene and re-saving it cannot silently delete their work. The reader is
strict about the envelope and does not inspect `data` at all.

**`moduleDirty` is a separate flag from `sceneDirty`, and the guard reads only the new one.** `sceneDirty` is
set by any cursor click — deliberately conservative, so a gesture that ended where it started still marks the
scene — and therefore cannot ever mean "the contacts were edited". The title's `•` is the OR of the two. The
discard guard runs at five sites where work would otherwise vanish without a word: New, opening a scene (which
covers Open Recent and the drop route, since all three reach `openScenePath`), and a layer row's ✕, which
closes the dataset a module's layers hang off. `⌘S` saves the scene and says plainly that it did not save the
module's files, because a module writes those from its own panel.

**Two deviations from the design worth naming.** The guard offers `Save…` only when the dirty module declares
a `save` command — a three-button question whose first button did nothing would be worse than a two-button
one. And an answer to a confirm question the controller is not waiting on is **ignored entirely** rather than
dismissing the dialog: clearing it would leave the awaiting gesture with nothing left to answer it.

**Keys are a closed pool, resolved last.** `a s d f g n p t z Delete Backspace`, unmodified or with Shift,
live only while their module is active and only after `keymap.ts` has returned `null`. So a module can never
shadow a documented binding and adding one can never change what a key already does. The single exception to
"an unmodified key stays harmless" is `when: 'selection' | 'toolArmed'`, and it is an exception with teeth:
with nothing selected the key resolves to **nothing at all**, not to a command that does nothing.

**The `docs-guard` CI job.** Two rules this repository has always stated and never been able to check: a
§12.3 frozen path in the merge-base diff without both `ARCHITECTURE.md` and `DECISIONS.md`, and a manifest's
`docs` heading missing from `USER_GUIDE.md` or from the website's `GUIDE_PAGES`. Its own job, because a
merge-base diff needs `fetch-depth: 0` and because that failure should reach a reviewer before the test legs
finish. §12.3 item 5 — the Rust signatures — is deliberately not enforced by path: a `crates/**` trigger would
fire on every implementation change and teach everyone to ignore the job.

**No new dependency, no lockfile change, and no engine or main-process change** beyond one CSP line, which has
its own entry above. The fixture module `tetravox.hello` ships in every build and is listed only behind
`?modules=hello`, because `pnpm e2e` drives the production bundle and a fixture excluded from it would prove
nothing about the bundle users get.

## 2026-08-30 — an opened scene is admitted for writing, so ⌘S saves it

**Decision.** A successful `readSceneFile` of a path whose whole compound suffix is `.tetravox.json`
adds that path to `scene-io.ts`'s `writable` set. One line, and it carves a hole in A-SHELL decision 1
(2026-08-27) that is worth naming: "being able to read `T1.nii.gz` must never imply being able to
overwrite it" still stands for every other file, and this is the one exception.

**Why it is not the general case.** The rejected primitive was `readTextFile`/`writeTextFile` over
anything on the read allow-list. This admits **one compound extension** — the app's own scene format,
matched by `isScenePath` on the whole suffix, so §7.6's `hot_LUT.json` is not a scene — and only after
a read of a path the user had already named through the Open sheet, a drop, argv or `open-file`.
Opening `study.tetravox.json` *is* naming the file ⌘S will save over: the write it enables is the one
write the user just asked to be able to make.

**The bug it fixes.** `ShellController.saveScene` writes to `sceneFile.path` when one is attached, and
`openScenePath` attaches it after `allowPath` + `readSceneFile` — but only `showSaveSceneDialog` ever
called `allowWrite`, so ⌘S on an opened scene came back "not on the write list" and the scene silently
stayed on disk as it was. Save As… worked, which is what hid it: the second save of a session was
fine, and the first was refused. `e2e/scene-save-opened.spec.ts` opens a saved scene in a fresh window,
edits it, saves with the File menu's Save Scene item, and reads the change back off disk.

**Scope.** `writeSceneFile` is unchanged: still the exact-path check, still the 8 MiB cap, still
`allowPath` on the way out. Nothing admits a directory, a pattern or a second extension.

## 2026-08-30 — module file IO: a Save sheet that admits its own siblings, and a backup main makes

**Decision.** `main/module-io.ts` adds four channels for §13 modules — `module-read-text`,
`module-open-dialog`, `module-save-dialog`, `module-write-text` — registered from main the way
`registerJobIpc()` registers the `--job` group. This **amends A-SHELL decision 1** (2026-08-27) rather
than working around it, and the amendment is in two named parts.

**Reading restates a door that is already open.** The 2026-08-27 rejection was of a general
`readTextFile`/`writeTextFile` pair. `module-read-text` is the read half only, and it is *narrower*
than what ships today: `readSceneFile` returns up to 8 MiB of any allow-listed path with no content
check, and `tetravox:subject-spaces` already reads sidecar text in main and hands it back. This one
answers only for a path already on the `tetravox://file` allow-list, caps at 1 MiB, and takes five
extensions (`.tsv .csv .json .txt .fcsv`). It admits nothing — a path still gets on the list only
through the Open sheet, a drop, argv or `open-file` — and it has no write twin. Being able to read
`T1.nii.gz` still implies nothing about writing it.

**The write family is the real change, and it is bounded by the Save sheet.** A module writes only to
paths its **own** Save sheet admitted: the file the user chose, plus that writer's declared
same-directory siblings, in a `Map<moduleId, …>` kept apart from `scene-io.ts`'s `writable`. Three
things keep "same directory" true rather than intended: a template must match
`^[A-Za-z0-9_.{}-]{1,96}$` before substitution; the substituted result must still be a plain name with
no separator, no `..` and no brace left over; and both ends are checked, because the template is what
a manifest declares and the anchor's basename is what a *file* supplies. A `{stamp}` template is
admitted as a shape (`\d{8}-\d{6}`), not as one instant, or only the first save of a session could
make a `.bak`.

**Why main does the backup and the rename.** The `.bak` is a copy of the file that is about to be
replaced, so main makes it from the path it already holds and no backup bytes cross IPC — §5 rule 3
is kept by there being nothing to carry. The write itself is `<path>.part` then `renameSync`, the
`sample-data.ts` precedent: a rename inside one directory is atomic, so an interrupted save leaves the
previous electrode table intact instead of half of the new one. A writer that did not declare a
`{name}.{stamp}.bak` gets `backupPath: null` and its write; the backup is a courtesy the manifest opts
into, not a condition of saving.

**Rejected: a main-side sibling resolver.** BIDS sibling discovery stays in the renderer, where
`open/sources.ts#firstAllowed` already probes derived sidecar names through `bridge().allowPath` and a
null return doubles as the existence check. A resolver in main would buy no admission-policy gain over
that status quo — `allowPath` admits any existing absolute path today — and would be the directory
listing IPC this app deliberately does not have. Tightening `allowPath` itself is a separate question
and is not answered here.

**Tested by refusal.** `module-io.test.ts` is new infrastructure (there was no `scene-io` unit test;
`sample-data.test.ts` is the nearest template): accepted and rejected templates, a traversal that only
appears after substitution, cross-module isolation, the read cap and extension filter, `.bak` naming,
`.part` cleanup, and every write that must be refused.

## 2026-08-30 — the window asks before closing on unsaved module edits, and offers no Save

**Decision.** `installCloseGuard` (`main/module-io.ts`) adds the codebase's first `BrowserWindow
'close'` handler — until today only `'closed'` was listened for. When the window carries the
module-edited flag, the close is `preventDefault`ed and a two-button `dialog.showMessageBox`
**{Discard, Cancel}** decides it. The flag arrives on `tetravox:set-document-edited`, which main also
hands to `win.setDocumentEdited` so macOS draws the dot in the close button.

**Why the flag is pushed and not derived.** `sceneDirty` is set by any cursor click, any layer or
dataset event and any interacting frame (`controller.ts`), so it cannot mean "a module has edits that
are not on disk"; a guard keyed on it would stop every close of every session. `UiState.moduleDirty`
is fed by a module's own `ui.setDirty`, and this channel is the one bit of it main needs.

**Why there is no Save button.** Saving a module's file means its Save sheet, its writer's filters and
its siblings, and `module-write-text` — all of which live in the renderer and the module. A Save here
would be a second write path driven from main, on a window that is halfway through closing, and §5's
write rule exists to keep there being exactly one. The renderer's own five-site guard (New, Open,
Open Recent, drop, close-dataset) is where a three-button "Save…, Discard, Cancel" belongs, because
that is where the module is still alive to save.

**Two ways it must stay out of the way.** A `--job` window never installs it: a batch render has
nobody to answer the box and would sit until the watchdog fires, spending the 45-minute CI cap on a
hung window. And `TETRAVOX_E2E_DISCARD=1` disables it entirely, read at close time so a spec can set
it per launch — the seam a windowless e2e needs to tear down a window it deliberately made dirty
(AGENTS rule 8). Both are asserted: `shouldPromptOnClose` is a pure function with a unit test for all
four cases, and `e2e/module-guard.spec.ts` closes a real window three times — Cancel keeps it,
Discard closes it, a cleared flag and the E2E seam close it with no box at all — with
`dialog.showMessageBox` stubbed in main, because an OS-modal box no click can reach would otherwise
hang the run.

## 2026-08-30 — §13's five scene fields: a module tags its layer, a point has an identity, `ViewSpec` carries a block

Phase 1 of the modules build (`feat/points-engine`). `scene/types.ts` is frozen (§12.3), so ARCHITECTURE
§4.4 and §4.6 change in this commit with it. Five additions, every one optional, and **absent reproduces the
previous behaviour** — which for these five is checkable rather than asserted: three of them are read by
nobody in the engine at all.

* `LayerBase.module?: string` — which module owns a layer's edits.
* `points[].id?` / `.group?` / `.ordinal?` — a stable identity, its electrode, its 1-based contact number.
* `PointsLayer.offPlaneOpacity?` and `.labelSource?` — the two rendering fields, decided in the entry below.
* `ViewSpec.extensions?` — the per-module state blocks.

**`module` is a `string`, not a union, and the engine never reads it.** §4.4 is the scene model; a union of
module ids would put the app's registry inside the frozen engine and make adding a module a frozen-file
change. The field exists because §4.6 reassigns every `LayerId` on load, so a module looking for its own
layer afterwards has only dataset, kind and name to match on — which two subjects' contact layers share, and
which two runs of the same subject share exactly. The app is the only reader: a module-owned layer gets a
read-only summary row where the core property editor would be, so the core per-point colour reset and the
0.5–20 mm radius slider cannot rewrite a module's invariants behind its back.

**Why a per-point `id` when the array index already identifies a point.** It does, to the engine, and it
still does: `ProbeRow.labelId`, `nearestPoint` and the instance row are all the index, and none of that
changes. But an index is not an identity across an edit. Deleting the second of twelve contacts renumbers
ten, so a selection held as an index then names a different electrode, and an undo step holding one restores
the wrong contact. Selection is therefore by `id` and survives a wholesale `points` replacement — which is
how every edit reaches the engine, since the instance buffer is keyed on the array's identity and a layer is
patched by handing it a new array.

**Why one layer with `group`/`ordinal` and not one layer per electrode.** Twelve same-kind rows each mount a
full property editor, add a stop to `[` / `]`, take a probe row and put a ✕ on the layer panel that closes
the carrier dataset. One layer with a `group` tag costs two optional fields and no rendering change at all.
`ordinal` is separate from array order because the array is drawing order and the ordinal is anatomy: a
contact inserted between 4 and 5 sits wherever the editor put it and is still ordinal 5 after a renumber.

**`ViewSpec.extensions` is written by the app, like `theme`.** `Engine.serialize()` enumerates `Scene`, and
there is no module state in `Scene` to enumerate — deliberately, because the engine has no module registry
and must not grow one. So the field is *typed* here (a scene file is one schema, not two) and *written*
there, and the app carries an unregistered module's block forward verbatim so that opening a colleague's
scene in a build without their module does not delete their work. §13.2 caps a block at 256 KiB of JSON and
forbids a `LayerId` or `DatasetId` inside one: both are reassigned on load, so a block that named one would
be silently wrong rather than loudly broken.

**The degradation contract, and the guarantee it rests on.** A scene re-saved by a build that predates a
module keeps the layer and every per-point field — they ride `serializableLayer`'s `{ ...layer }` spread and
`remapLayer`'s — and drops only `extensions`. That pass-through was already true and was undocumented; §4.6
now states it as a guarantee, so narrowing `SerializableLayer` to an explicit field list is recognisable as
the breaking change it would be. `roundtrip.test.ts` pins it by deep-equality over every key of a fully
populated layer of each kind.

## 2026-08-30 — points ghost off-slice, label themselves, and wear a selection ring

Phase 1 of the modules build, the rendering half. Three things reach §7.2, all default-off, and
`docs/ARCHITECTURE.md` §7.2 changes in the same commits.

**Ghosting is a uniform, not a program variant.** §7.2's 2D rule for a points layer — the sphere ∩
plane disc, with `|d| ≥ r` dropped — is what makes a scalp net sweep with the cursor, and it is
exactly wrong for a depth electrode: a shaft is twelve contacts along a line no single slice
contains, so scrolling shows one contact at a time and the shaft is never visible as a shaft.
`offPlaneOpacity > 0` draws the dropped points too, at the **full** radius, because there is no
cross-section to size them by. It is a `uGhostAlpha` uniform on the existing `POINTS_2D` program:
`derived.ts` already writes per-layer uniforms there, the branch is one comparison on a draw of a few
hundred instances, and a variant would double the program cache for a layer flag. At 0 — what absent
means, and what the 3D variant never sets it to at all — the shader takes the cull branch verbatim.
The value is clamped to 0…1 in the pass, because a scene file is user-editable text and a 3.0 would
make the ghosts brighter than the contacts on the slice.

**The two 2D rules diverge under ghosting, and that is the decision.** The discs ghost; the labels
stay slab-culled at `max(radiusMm, 1 mm)`. A disc at 0.6 alpha is a legible hint of where a shaft
goes. A whole shaft's worth of names on one slice is the smear the slab rule was added to prevent —
187 electrodes projected onto one axial plane, names belonging to slices 80 mm away. So `§7.2` states
both rules next to each other rather than quietly applying one of them.

**`labelSource` exists so a module never maintains a `labels` array.** The overlay read
`layer.labels` and nothing else, which is right for a parsed Gmsh view (a `T3` is independent of the
`SP`s and SimNIBS lifts it 5 mm clear of the sphere) and wrong for a layer whose text simply *is* its
points' names — and §4.6 does not serialise `labels`, so an editor that used it would rebuild it on
every edit and lose it on every open. One pure resolver, `pointLabelAnchors`, so the pass has no
branch in its loop and §11 can assert which strings a layer emits with no GL context.

**The selection ring is on the frame, by index, and only where the disc is.** `DrawInput` gains
`pointSelection` and `pointHot`, beside `gizmo` and `measureDraft` and for the same reason: which
contact is selected is pointer state, and a `*.tetravox.json` must never carry it — a scene mailed to
a colleague would open with a stranger's cursor in it. They are addressed by **array index** because
that is the frame's key into the array the pass walks; a tool selects by `points[].id`, which is what
survives an edit, and resolves it on the way in. The radius comes from `discRadiusPx`, the shader's
rule restated once on the CPU and shared with the hit test that P2 adds — `gizmoHandleAt` shares
`handlePoints` with `drawGizmo` for the same reason, and a hit rule stated twice is a hit rule that
drifts away from the picture. It returns `null` for a culled point, so a ring is never drawn around
something the pane does not show, and a stale index draws nothing rather than ringing its neighbour.

**`OverlayTheme` gains `select`, violet, engine default only.** `measure` is not in the app's
`overlayPalette` either, so this is no app token work. Violet because a ring sits *on* a coloured
disc in a pane that may also hold the amber crosshair, the cyan gizmo and the blue active border, and
§11 has to be able to name it without a tolerance that also matches one of those. Notably not a
green: `gizmoHot` is one.

**`TetravoxEngine.setPointHighlight` is a class member, not a §4.7 facade one.** The facade is what
§8's "everything the UI can do must be reachable from the `Engine` API alone" is about, and a *ring*
is not something the UI does — it is what the engine's own pointer layer shows while a tool is armed.
Same class as `showGizmo`, `gizmoAt` and `worldAtScreen`. So `MockEngine` and the app's `NoGlEngine`
need nothing for this phase.

**Nothing moves.** `DEFAULT_OVERLAY_THEME`'s existing eight fields are untouched, `pointSelection`
and `pointHot` are absent on every frame nothing sets them on, and `offPlaneOpacity` / `labelSource`
are absent on every layer. The full engine e2e suite, goldens included, is green unchanged; the one
new picture is `derived-points-ghost`.

## 2026-08-30 — `sampleVoxelBox` / `peakCentroid`: §4.3's "for probes only" becomes "and bounded local reads"

§4.3 kept `VolumeDataset.data` on the UI thread "for probes only", and a probe is one voxel. Snapping an
sEEG contact to the metal it is inside needs the neighbourhood — Slicer's editor takes a box of radius
1.5 mm and moves the contact to the intensity-weighted peak, which on a 0.5 mm CT is a few hundred voxels
and well under a millisecond. So §4.3's sentence is amended in the same commit as the code, and the
amendment carries its own bound: `derived/voxel-box.ts` reads at most `MAX_BOX_VOXELS` = **32 voxels on an
axis**, and a whole-volume scan is still not a probe.

**The cap is the decision, not a performance note.** Without one, "you may read `data` on the UI thread"
is a door to a 512³ loop inside a `pointermove` handler, and §5's whole worker-per-dataset arrangement
leaks through it. 32 rather than a millimetre limit because the bound has to hold whatever the spacing is:
1.5 mm is a 3-voxel half-extent on ernie's 1 mm T1 and 15 on a 0.2 mm micro-CT. A caller who wants more
than a box asks a worker (§6.5).

**The box is axis-aligned in voxel space, half-extent `ceil(radiusMm / spacing)` per axis.** A world-aligned
box would need the affine's row norms and would still have to be padded to whole voxels; this covers the
requested radius in every direction on an oblique volume and is one `ceil` per axis. It is clipped to the
volume rather than refused there, so a contact near a face reads a smaller box and says so through `ijk0`
and `dims`. It **refuses** two things instead of coping: `rgb24`/`rgba32`, whose samples are interleaved
components with no single value (§4.2's scalar model does not cover them either), and a query point outside
the volume — never clamped, because a snap that silently pulled a click 40 mm back inside the head is worse
than one that says no.

**The weighting is Slicer's, verbatim: `clip(v − (max − ½(max − min)), 0)`.** Half way up the box's *own*
range, not a fixed HU floor — which is what makes it work unchanged on a CT whose background is soft tissue
at ~40 HU and whose contacts are metal at ~3000, and on the same scan rescaled. It has no parameter but the
radius. The centroid is computed in **voxel indices** and mapped through the affine at the end, so the
weights and the coordinates stay in one frame; on a flat box every weight is zero and the answer is `null`,
because uniform background has no peak and returning the box centre would be a snap pretending to have found
something.

**Both are pure and exported from `@tetravox/engine`.** The app's `NoGlEngine` must give the same answers as
the real engine, and a module that re-implemented "where is this contact really" would be a second source of
truth for an electrode position. Exported for the reason the colormaps and the coordinate spaces are.

**Two references, and neither is this code.** The synthetic fixture is `testdata/ct_shafts.nii.gz` — a CT
phantom with three depth electrodes at a 3.5 mm contact pitch, oblique to every axis, on **anisotropic**
spacing (0.4 / 0.5 / 0.8 mm) so that `ceil(1.5 / spacing)` is 4, 3 and 2 voxels and an implementation that
used one spacing for all three axes is right on an isotropic volume and wrong here. It is stored as
`HU + 1024` with `scl = (1, −1024)`, so a reader that forgets §6.1's scaling is off by exactly 1024 rather
than subtly wrong. `scripts/gen-fixtures.py`'s verification half re-reads the file with **nibabel** and
recomputes every expectation in numpy, per AGENTS.md "Test data". The real-data half is
`scripts/refvalues/voxelbox_refvalues.py` over `m2m_ernie/T1.nii.gz`, which is the file that matters —
float32 with a max of exactly 65535 and a non-diagonal sform, where a box built from `dims` and `spacing`
instead of the inverse affine would pass on the phantom and fail on a subject.

**One convention had to be pinned to make the two agree: the query's voxel index rounds HALF-UP**, like
JavaScript's `Math.round`. `np.rint` is half-to-even and disagreed on every index landing exactly between
two voxels. Both references now state the rule, and the fixture's origin puts an integer voxel index at
world 0 on every axis with no query on a half-index — a test whose expectations turn on a tie-break is
pinning the tie-break rather than the rule.

## 2026-08-30 — the point tool: place on every click, select by id, and one `dragEnd` per drag

§13's contact editor needs three things the engine had no member for: a mode in which a click edits points
instead of moving the cursor, a way to say *which* point a tool is about that survives an edit, and a signal
that a drag is over. `api.ts` gains five members, an event and three types; `engine.ts` implements them;
`input/gestures.ts` gains a `GestureKind`; `input/pointer.ts` gains one slot in its precedence chain. Two
frozen files (§12.3) — `api.ts`, and ARCHITECTURE §4.7 / §7.5 / §11 edited in the same commit. Every addition
is additive and nothing is armed by default, so the whole engine e2e suite, goldens included, is unchanged.

**The template is the measurement tool** (`docs/DECISIONS.md`, 2026-08-28), deliberately and almost line for
line: the mode is the engine's because only the engine can turn a pane pixel into a world point and §8 forbids
the app deriving one; the app owns the thing that arms it and nothing else; the pointer layer is where a click
becomes an edit. What is new is that the thing being edited is **scene state a layer already holds**, not a
new `Scene` collection — §4.4's `PointsLayer` is the contact model (2026-08-30), so every edit is one
`updateLayer` and a host that never heard of this tool still sees the points move.

**Place mode does not hit-test first, and that is Slicer's semantics rather than an omission.** In `'place'`
every left click appends a point. The alternative — hit first, place on a miss — reads as helpful and is
wrong at the pitch this is for: sEEG contacts are 3.5 mm apart, about five pixels at a default zoom, and the
click that matters most is the one filling the gap *between* two contacts that were found. A hit-first rule
answers that click by selecting a neighbour, and the user's correction has silently become a no-op.

**Selection is by `points[].id`, and the engine re-finds it after every `points` replacement.** The array
index is the frame's key and cannot be an identity: deleting the second of twelve contacts renumbers ten of
them. So the tool holds `{ layerId, pointId }`, `updateLayer` re-resolves it, and an id that is no longer
there **clears** the selection with a `cleared` event rather than leaving the ring on whatever took the index.
Arming the tool also *materialises* ids — a layer whose points carry none gets `p<index>` on every one of
them — so that the tool, the selection and the saved scene name the same contact by the same string instead of
the engine answering with ids that are not in the scene.

**A ghost is never hit.** `offPlaneOpacity` draws the off-slice contacts of a shaft so the shaft reads as a
shaft (2026-08-30), and every one of those discs is at a position the pane is *not* showing a cross-section
of. Grabbing one and dragging it would move a contact in a plane it is not in, by a delta measured in a plane
it is not in. So the hit test asks the disc rule with the ghost switched off, which is one argument
(`offPlaneOpacity: 0`) rather than a second rule: `overlay/point-ring.ts`'s `discRadiusPx` is the shader's
rule stated once, and the ring, the hit test and the picture cannot drift apart — the arrangement
`gizmoHandleAt` already has with `handlePoints`. The floor under it is `max(disc, 8 px)`, because a 0.8 mm
contact at 0.5 mm/px is a 3 px target and a hand does not aim at 3 px.

**One `dragEnd`, delivered from all three of the gesture machine's exits.** The gizmo drag discards its
`end` (`#onUp` is `void g`) because it has no host that cares; a point drag does — one drag is one undo step
and one dirty mark, and the module's `.bak` is the only other net. The `end` arrives from `#onUp`, from
`#onCancel` (which is `pointercancel` **and** the window `blur` bound to the same handler) and from the
second-pointer branch of `down()`, whose events until now were read only for a `begin`. All three are
forwarded for kind `'point'` and for no other kind, and `gestures.test.ts` has a case per exit — a tool that
listened to only the first would leave a half-committed edit behind every time a user switched windows
mid-drag.

**`GestureKind 'point'` is resolved in the 2D branch, between `Shift` and `space`.** After the ctrl/meta and
`Shift` tests so a menu accelerator is still not a drag and `Shift`+drag over a contact is still the layer's
opacity; before the `space` test, and testing `space` itself, so `space`+drag over a contact still pans the
pane. §7.5 binds those three and a new tool does not get to quietly take them. `GestureMachine.down` and
`resolveGesture` now take a `GestureTargets` bag where `overGizmo` was a positional boolean — `overPoint`
would have been a fifth — and a bare boolean is still read as `{ overGizmo }`, so no existing caller changes.

**One armed mode at a time.** Arming the point tool disarms measure mode and `setMeasureMode(true)` disarms
the point tool. Both take the left click away from the cursor, and there is no place in §8's chrome that could
honestly show which of two armed modes a click went to. §7.5 states the invariant.

**`Esc` is `place` → `select` → off**, in the engine's own `keydown` beside `cancelMeasurement`'s and
**before** the "is the pointer over a pane" early return, so it works with the pointer over the panel — which
is where a user's pointer is when they decide they are done placing. It cannot be the app's: `keymap.ts`
returns `cancelMeasurement` for `Escape` unconditionally and `Shell.tsx` `preventDefault`s it, so "core first,
module on null" would never reach a module. Two steps rather than one because the two modes fail differently:
a user who armed `place` by mistake wants out of *placing*, not out of the tool.

**The hover hit test runs only while `select` is armed.** §8 budgets a volume hover at 16 ms and the 2D
`#onMove` path is the hottest code in the pointer layer, so an unconditional per-move CPU test over a points
layer would be a tax on every user who is not editing points. Armed, it sets `DrawInput.pointHot` and the
canvas cursor; unarmed, it is one property read. `pointer.spec.ts` keeps a timing case on the unarmed path so
that stays true.

**Both mocks, and one of them behaviourally.** `MockEngine` inside the frozen `api.ts` throws, like every
other member of it — its job is to be the compile-time proof that the facade needs no GL. The app's
`NoGlEngine` implements the tool **for real** (arm/disarm, ids, selection by id, place, drag, the events),
because the app's e2e launches with `?engine=mock` and there is no canvas there for a pointer layer to listen
to. Its hit test is the engine's own exported `pointAtPane`, so "which contact did that click grab" has one
answer in both engines; what it cannot borrow is the pane, so its 2D pane is an explicit `pointPane` with its
in-plane origin at the cursor — the case the real engine reduces to when the scene anchor and the cursor
coincide — and its 3D hit test answers `null` rather than inventing a projection from a camera matrix that
never drew anything. `pointToolClick` / `pointToolDrag` / `pointToolDragEnd` are the three calls the real
pointer layer would have made, exposed as a seam like `terminations` and `theme`, and not on `Engine`.

**One P1 member had to be corrected to make the hover ring work.** `setPointHighlight({ hot: null })` kept the
old value: the implementation read `highlight.hot ?? this.#pointHot`, and `??` cannot tell `null` — the value
a caller passes to *clear* one half — from "not mentioned". It now tests `'hot' in highlight`. Without it, a
pointer leaving a contact could only clear the hover ring by clearing the selection's with it.

**Nothing moves.** No mode is armed unless something arms it, `pointSelection`/`pointHot` stay absent on every
frame that predates a tool, and `resolveGesture` returns exactly what it returned for every press that is not
over a point with a tool armed. The full engine e2e suite (both renderer projects) and every golden are
unchanged; the new coverage is `points-tool.spec.ts`, which asserts the drag as `40 · mmPerPx ± 0.05 mm`
derived from §3 rather than from the engine.

## 2026-08-30 — the module host is wired, and frozen: §12.3 gains item 6

**Decision.** `packages/app/src/renderer/src/modules/host.ts` is a §12.3 frozen interface from this
commit, at `MODULE_HOST_VERSION = 1`, because this is the commit in which its last three unwired
members stopped being stubs: `host.tool` is the engine's §4.7 point tool, `host.files` is
`createHostFiles(manifest, bridge().allowPath)` over §5 rule 11's channels, and
`host.scene.peakCentroid` is the engine's §4.3 bounded local read over the dataset the module names.
`ModuleEvents.pointTool` **is** `EngineEvents.pointTool` — the three point-tool shapes are re-exported
from `@tetravox/engine` rather than declared a second time — and the event reaches a module the way
`layers` and `measurements` reach the store: one `engine.on('pointTool', …)` in
`ShellController.attach`, fanned out to whoever subscribed.

**Why the freeze is here and not in Phase 0.** A surface frozen before the work behind it exists is a
surface frozen around stubs, and every one of the three would have had to be amended: `addLayer`
stamps a field `scene/types.ts` did not have, `peakCentroid` needs a helper the engine did not
export, `tool` and `files` had no implementation at all. The design named this moment ("Phase 3
completes the surface") precisely so the governance round would happen **once**, with the whole
surface in front of the reviewer, rather than four times with a quarter of it each. `MODULE_HOST_VERSION`
is what a module names in `manifest.hostApi`, so the freeze is not a promise never to change the host
— it is the promise that a change is additive, documented in the same commit, and that a breaking one
bumps an integer the registry test checks.

**The stubs stay.** `createModuleHost`'s `tool`, `files` and `peakCentroid` remain optional
dependencies whose defaults throw `ModuleHostError`, even though the shipping build passes all three.
Two reasons. A harness builds a host with none of them and asserts exactly that distinction — "this
build has no point tool" is a different answer from "nothing is selected", and a module written
against the second must not silently do nothing against the first. And a module compiled against a
later host will meet an older build one day; a member that throws is the only shape in which that is
reportable rather than invisible.

**The dialogs take their title, filters and templates from the manifest.** `main/module-io.ts` now
imports `MANIFESTS` — the data-only barrel main already validates job actions against — and looks up
the reader or writer a sheet names, so an Open sheet offers a declared reader's extensions and a Save
sheet admits a declared writer's sibling templates. The renderer still sends its own copies and they
are still sanitised on arrival, because they are the fallback for a module a build's barrel does not
carry (a harness, or a `--job` window told about one). The half that matters is the sibling template:
it is what admits a *second* path for writing, so it is the one that stops being renderer-supplied
the moment main can look it up. Nothing is trusted for coming from a manifest — every template is
still validated before substitution and its result again after.

**One sibling resolver, not two.** `modules/siblings.ts` owns the manifest's token rules, the
filename-segment rule, the three-ascent limit and `resolveSibling`; `hostFiles.ts` imports them and
`ShellController.dispatchSiblings` calls the same function. The two had grown independently on
parallel branches with different strictness — one normalised `a/../b` and the other refused it — and
a path rule that is right in one of two places is a path rule that will be wrong in the other. The
stricter reading won: a re-descent, a climb past the root, an empty segment and a backslash are all
refused rather than normalised, because `../a/../../etc/passwd` normalises to something perfectly
ordinary and this is the last place either a manifest's template or a filename on disk can be caught.

## 2026-08-30 — the module job envelope: one action type, and the manifest is its schema

**Decision.** A module operation reaches `--job` as `{ "type": "module", "module", "op", "args" }` and never
as an action type of its own. The automation surface has two closed switches — `main/job.ts`'s
`validateAction` and `automation/run.ts`'s `runAction` — and they are the whole cost of a job action; a
module that wanted `{ "type": "seeg-snap" }` would make every module after it pay that cost again, in two
files neither module owns. One envelope, edited once, and `modules.test.ts`'s rule that nothing
module-specific appears in the shell survives into automation.

**The manifest is the schema.** `module` is looked up in `MANIFESTS`, `op` in that manifest's `operations`,
and `args` against the operation's own `ArgShape` — in **main**, before a window exists, which is what keeps
§2.6's promise that every problem in a job file is reported at once with a path into the document. Nothing
new was needed for that: `MANIFESTS` is the data-only barrel `module-io.ts` already imports, and a manifest
that stopped being erasable data would break this validator first.

**An undeclared `args` key is an error, and a `set`'s `patch` key is not.** The asymmetry is not an
inconsistency: a `patch` is a `Partial<Layer>` that `updateLayer` merges and nothing here can enumerate,
while an operation declares every argument it takes. So an undeclared argument is a typo, and a typo that is
silently dropped is a job that appears to have run — the worst outcome available to an unattended render.

**`path` and `out` are the two types that are about files, and they are opposites.** A `path` is an input and
gets exactly what `scene.files` get, for the reason §5 directive A2 gives: `${VAR}` expanded, resolved
against the job file, allow-listed before the window opens, and handed to the renderer already resolved. An
`out` is a name under `--out`, held to the same `outName` rule every other output is, and admitted to that
module's write list (§5 rule 11) together with the sibling templates its writers declare — the union of them,
because an `out` names a file and a job has no vocabulary for "using the electrodes writer". That admission
is the whole mechanism by which a module can save in a batch run: there is no Save sheet to open, and a
second write path driven from main is what §5's write rule exists to prevent. It also means an `out` can
never name the file the job read, so the first save in a fresh `--out` mints no `.bak` — there is nothing
there to back up.

**`ArgType` gains `path?`.** The sEEG `load` operation takes a T1 it will use if it is given one, and
`string?` would have carried the same value with none of the meaning: only a `path` joins `jobInputPaths`,
and a path a job named but main never allow-listed is a file the module is told about and cannot read.
Additive, and absent reproduces the previous behaviour.

**`JOB_SCHEMA_VERSION` does not move.** It is bumped when a required field appears or a default changes.
An unknown action type was already rejected with a message naming the types that exist, so a job written
before today behaves identically, and a job written today against an older build is refused rather than
half-run. For the same reason `job-result.json` grows `modules: [{ id, version }]` **only when the run
actually used a module**: a job that uses none produces the result file it produced before, byte for byte,
and a client parsing it needs no version check to know what it is looking at. The list is main's answer
rather than the renderer's, since main validated the actions against the manifests and already knows every
module the run depends on — and a result naming the version that produced a figure is what makes the figure
re-derivable a year later.

**`validateJob` and the four helpers take the manifest list as a last argument, defaulted to `MANIFESTS`.**
No shipped manifest declares every `ArgType`, so a validator driven only by what ships would have eight
untested branches; the seam is the same one `shouldPromptOnClose` takes `env` for, and the tests still run
the whole envelope against the real barrel through `tetravox.hello`'s `echo` so the default binding is
proven and not assumed.

## 2026-08-30 — AUTOMATION §2.7 is generated from the manifests, and CI grows its first Python step

**Decision.** The table of module operations in `docs/AUTOMATION.md` is written by
`scripts/sync-module-docs.mjs` from the manifests themselves, and `docs-guard` runs it with
`--check`. A hand-written table would be a **second declaration** of the automation surface, and the
two would agree exactly until somebody added an argument — at which point the documentation would be
the thing telling a user their job was legal and the validator the thing refusing it. Generating it
is how "the manifest is the schema" stays true of the documentation as well as of the code.

**It imports each `<id>/manifest.ts`, not the `manifests.ts` barrel.** Node runs TypeScript by
stripping the types, and a manifest's own imports are all `import type` and vanish with them — so a
manifest file is a standalone ES module the moment the annotations are gone, which is the same
property `modules.test.ts` already enforces for its own reasons. The barrel is not: it carries a real
`import { helloManifest } from './hello/manifest'`, extensionless, which is a TypeScript convention
Node's resolver does not implement. Type stripping is unflagged from Node 23.6 (CI's Node 24 and a
local Node 25 both need nothing) and behind `--experimental-strip-types` from 22.6 to 23.5, so the
script re-execs **itself** once with the flag if the import fails the way an older Node fails it —
one retry, guarded by an environment variable, rather than a build step and a generated JSON file
nobody would remember to regenerate.

**The section is delimited by markdown, not by an HTML comment.** `<!-- BEGIN GENERATED -->` was the
obvious marker and is the wrong one here: `website/scripts/sync.mjs` escapes every tag it does not
recognise, so the marker would appear as visible text on the published page. The script instead owns
everything from its `### 2.7` heading to the next heading **at that level or above**, or the next
`---` rule. Both halves of that sentence are load-bearing and both were found by a failing test: a
scan that stopped at any heading stopped at the first `####` of the section's own body and
re-inserted the section in front of the tables it had just written, and a splice done on strings
rather than on lines ate the blank line above the heading and then glued the heading to the
paragraph above it. A generator whose first run looks right is exactly the kind that needs its own
tests.

**CI's first Python step, and its own job.** `python -m unittest discover -s python/tests` runs under
`actions/setup-python`, pinned to 3.12, installing nothing: the client is standard library only, and
that is a design decision rather than an omission (`python/pyproject.toml`). It is a separate job for
the reasons `docs-guard` is one — no pnpm install, no toolchains, ~20 seconds — and specifically not
a step of `test`, where it would run a second time on the macOS leg at 10x the minutes for identical
coverage. The end-to-end halves (`test_client.py`'s example run, `test_capture_examples.py`) skip
when there is no build and no data, exactly as every real-data test in the repository does; what CI
gates is the **documents** a `Job` builds, which is the half that is the contract with
`main/job.ts` — and the half whose other end `job.test.ts` asserts.

This is the first non-JavaScript, non-Rust dependency in the workflow, and it is worth naming as a
cost: the Python client has shipped untested by CI since it was written, its schema is the same
schema the validator implements, and the two drifting is a class of bug no other test in the
repository can see.

## 2026-08-30 — the module host gains `scene.activePlane()`, and nothing else about a view

**Decision.** `ModuleHost['scene']` gains one member — `activePlane(): { normal, point } | null` —
answering the plane the **active 2-D pane** is showing, with the cursor as its point, and `null` for
the 3-D pane. `host.ts` is frozen (§12.3 item 6), so ARCHITECTURE §13.1 changes in this commit with
it; `MODULE_HOST_VERSION` does not move, because the addition is additive and absent it was simply
not askable.

**What made it necessary.** The sEEG editor's contact list quotes each contact's **distance from the
plane you are looking at** — the number that says "this one is on your slice, that one is 8 mm
behind it". A module has no other way to know: `ModuleHost` publishes layers, datasets and the
cursor, and the plane a pane draws is the view's `{normal, up}`, which is engine state. The
alternatives were all worse in a way §13.7 rule 7 already names. Deriving the normal from the pane's
`SliceMode` would be a second source of truth that is wrong on an oblique view and does not follow an
in-plane rotation — the same class of mistake §8 forbids when it tells the app not to turn a pane
pixel into a world point itself. Quoting the 3-D distance from the crosshair instead would be a
different quantity wearing the same label: a contact exactly on the slice but 30 mm to the left of
the crosshair would read 30 mm, which is precisely the reading a clinician must not get from a column
headed "off-plane".

**Why this shape, and why nothing more.** `{ normal, point }` rather than a `View` or a `ViewId`:
§7.5's rule is that a slice pane shows the plane with the view's normal **through the cursor**, so
those two vectors are the whole of the answer, and a module that received a `View` would also receive
a camera, a zoom and a per-view layer visibility it has no business reading. `null` for the 3-D pane
is the honest answer rather than a fabricated plane, and a panel that shows a dash for it is showing
the truth. The normal is re-normalised in the controller rather than trusted: a `*.tetravox.json` is
user-editable text, and a non-unit normal there would silently scale every distance a module quotes.

**It is always wired.** Unlike `tool`, `files` and `peakCentroid`, this is not an optional dependency
of `createModuleHost`: it is answered from the controller and the store, which are required, so there
is no build in which the shell exists and the active pane does not. Nothing here can throw
`ModuleHostError`.

## 2026-08-30 — `tetravox.seeg`: the contact editor, and the library under it

The first product module (§13), reproducing the 3D Slicer `SEEGContactEditor`'s Inputs → Edit → Save
loop over a BIDS-iEEG `electrodes.tsv` and the registered CT it was localised on. It reads and writes
the same files as that module and as `seegprep`, so the two can be used on one subject
interchangeably. This entry records what it decides that a reader would otherwise have to infer.

**A shared contact library, and a line drawn through it.** The owner's requirement was that DBS leads
and ECoG grids be addable later without a fork, so `modules/shared/contacts/**` holds everything that
is true of *any* set of named implanted positions — the model and its identity rules, the tolerant
reader, the canonical writer, the editlog schema, the PCA line primitives, the palette, the layer
bridge, the snap scoping — and `modules/seeg/**` holds what is true of a **depth electrode**. The
test of where the line falls is simple: a rule that a 4×8 grid would also obey is shared, and one
that mentions a shaft is not. `refitShaft`, the tip rule and the `seegprep` file layout are therefore
sEEG's; `fitLine` and `respaceEven` are not. Everything under `shared/` is inside §13.1's import wall,
which is what keeps "shared" from becoming a back door to the store.

**The tip rule is stated, because Slicer's is a stub.** `_tipSign` there has a docstring describing a
heuristic and a body that returns `1.0`, and the module's own README lists "verify contact 1 =
deepest" as a known limitation. Here: **contact 1 is the end of the shaft nearer the reference
centre**, where the reference is the bound volume's bounding-box centre (falling back to the centroid
of every contact). Not the electrode's own centroid, which lies *between* its ends and would make the
rule a coin toss. It is a heuristic and not a brain mask — an occipital shaft entering near the
midline can defeat it — so the tip contact is marked in the panel, `t` pins the other end per
electrode, and the choice is saved with the scene.

**Only Re-fit and Renumber ever relabel.** Loading, placing, dragging, snapping and deleting leave
every contact's number and name exactly as they were. A clinical table's numbering is wired to the
recording system through its `csc` column, so a renumber is a decision, not a side effect — and both
buttons that make it say so. New names keep the **zero-padding the file used** (`LINS01`, not
`LINS1`), which is the Slicer defect that made every relabelled contact read as `added` on the next
load.

**Floats are formatted like Python's `repr`.** `seegprep` writes `repr` so its tables round-trip bit
for bit, and JavaScript disagrees with it in three places: `String(3)` is `3` where `repr(3.0)` is
`3.0`, `String(1e-7)` is `1e-7` where `repr` is `1e-07`, and the two switch to exponent notation at
different magnitudes (21/−7 against 17/−4). `formatFloat` is CPython's layout rule over
`toExponential()`'s shortest digits, pinned by a generated fixture of two dozen pairs. The
consequence that matters: **an untouched contact is written back byte for byte**, which is what makes
the `status` column mean something.

**The save is three files and the editlog's name is a contract.** The table (tab-separated, LF, the
original columns in their original order with `electrode` / `contact` / `status` appended if absent),
a `<name>.<stamp>.bak` main copies from the bytes that were there, and `<stem>_editlog.json`.
`seegprep`'s CLI globs `<derivatives>/sub-<id>/ieeg/*_electrodes_editlog.json` and refuses to re-run
over a hand-edited subject without `--force`, so a save whose stem does not end in `_electrodes`, or
which lands outside an `ieeg/` directory, is warned about **before** it is written. The editlog keeps
every count Slicer's wrote, under the same names, and adds a per-contact diff — counts answer "was
this hand-edited?", and the reviewer three months later is asking "what was changed?".

**`status` keeps what the localiser said.** `edited` for a contact that moved by more than 1e-3 mm
(Slicer's L1 test), `added` for one with no row behind it, and otherwise the row's own status if it
had one — so `located` and `gapfilled` survive a save that did not touch them, rather than being
flattened to `kept`.

**Undo is a `{ before, after }` pair.** `ModuleHistory` is a stack of states: `undo()` pops the last
thing pushed and moves it to the redo side, which expresses "restore this snapshot" exactly and
cannot express a redo on its own — after an undo, `redo()` would hand back the state just restored.
Pushing the pair makes both directions correct with the published host surface and no second stack.
A drag is coalesced by comparing positions against the snapshot taken at `selected`, because a plain
click emits `selected` and then one zero-length `dragEnd`; a snap of any scope is one entry however
many contacts moved.

**Two things Slicer does that this does not.** Its display preset also puts the CT *above* the T1,
and `ModuleHost` has no `reorderLayers`; adding one for a display nicety is not worth a §12.3 change,
so the module applies the colormap, the opacity and the 150 HU `mode: 'hide'` floor and *says* when
another volume is drawn over the CT. And a table opened before any volume is held rather than
loaded — a module cannot open a dataset, and inventing a way for it to would be a second load path
beside `runOne`'s.

**The `sub-P076` sample table was deliberately not committed.** It is patient-derived electrode
geometry; `gen-fixtures.py` writes a table with the same column set over the CT phantom instead, plus
one deliberately awkward file (BOM, commas, CRLF, `R`/`A`/`S`, no group column, a ragged row) for the
reader's tolerance. The real-data half is gated on `TETRAVOX_SEEG_TESTDATA` and asserts properties
rather than numbers, because a real table's numbers belong to the site that produced it.

## 2026-08-30 — the ⌘S carve-out is minted where main hands a scene over, not by reading one

**Decision.** `readSceneFile` admits nothing. The write admission §5 rule 10 grants an opened scene
is minted by `scene-io.ts#allowOpenedScene`, called at the five places **main** is the one choosing
the path: `showOpenSceneDialog`'s result, `menu.ts#sendOpenScene` (the scene half of the
`tetravox:opened` routing — argv, `open-file`, a second instance, File ▸ Open Recent, Sample Data),
the `tetravox:startup-scene` drain, and a new `tetravox:dropped-path` message. This amends the
2026-08-30 entry above it, which put the admission in `readSceneFile`.

**What was wrong with the read.** The entry above justified the carve-out as "only after a read of a
path the user had already named through the Open sheet, a drop, argv or `open-file`". The renderer
can synthesise that precondition: `tetravox:allow-path` is an unconditional handler that puts *any*
existing absolute path on the read allow-list and hands back its canonical form — the same entry says
so, in its own "rejected: a main-side sibling resolver" paragraph. So `allowPath(victim)` +
`readSceneFile(victim)` + `writeSceneFile(victim, …)` was a silent overwrite of any
`*.tetravox.json` on the machine, reachable from any script in the renderer, with no dialog and no
gesture at any step. The threat model in `paths.ts`'s header — "an arbitrary-file-read primitive for
anything that gets script into the renderer" — is exactly that attacker, and `origin/main` had no
such write: before the carve-out, only the Save sheet filled `writable`.

**Why the delivery points are the right place.** The justification was always about provenance, and
provenance is a fact main holds and the renderer cannot forge. At each of these five, main already
knows the path *because it chose it* — from the picker, from argv, from `settings.json`, from a
downloaded sample. The renderer's own routes reach none of them.

**The drop is preserved, and it is the interesting one.** A drop never reaches main: the renderer
gets the path from `bridge().getDroppedFilePath`, which is `webUtils.getPathForFile` in **preload**.
That is what makes it trustworthy — it answers only for a `File` the user really handed the page, and
renderer script cannot manufacture one backed by a path of its choosing. So preload sends every
dropped path on `tetravox:dropped-path` and main admits the ones that are scenes. It is the only
capability on this bridge that a compromised renderer cannot mint for an arbitrary path, and it is
now what carries the drop half of §5 rule 10.

**Both spellings of the path.** `sendOpenScene` sends whatever main holds (`settings.json`'s
remembered string) and the Open sheet sends `realpath`'s, while `writeSceneFile`'s check is
`resolve()` only. `allowOpenedScene` admits both forms so ⌘S works whichever one the renderer was
handed and saves back.

**Tested both ways.** `scene-io.test.ts` is new (there was no unit test for this file): a path
admitted only through `allowPath` reads and is refused the write, with the bytes on disk asserted;
a path `allowOpenedScene` named saves. `e2e/scene-save-opened.spec.ts` keeps the ⌘S-on-an-opened-scene
flow green and now also performs the escalation through the real bridge in the real window — allow,
read, write — and asserts the refusal and the untouched file.

## 2026-08-30 — a module's write admissions end with its editing session

**Decision.** `module-io.ts` grows `revokeModuleWrites(moduleId)` and `revokeAllModuleWrites()`, and
a fifth channel, `tetravox:module-clear-writes`. The renderer sends it from
`ShellController.deactivateModule`; main calls `revokeAllModuleWrites()` from `sendOpenScene` and
from `sendSceneCommand('new'|'open')` — the two places main itself replaces the document.

**The gap.** `writeLists` was filled by every confirmed Save sheet and every job `out` target, and
emptied only by `clearModuleWriteLists`, whose sole caller was a test. So a user who saved subject
A's `electrodes.tsv` left A's table, A's editlog and the `<anchor>.<YYYYMMDD-HHMMSS>.bak` *shape* in
A's directory writable for the rest of the process — including after they moved to subject B and the
UI stopped mentioning A at all. A stale path in a module, or a replayed `moduleWriteText` with A's
path and a matching module id, then overwrites a table nothing on screen names.

**Why deactivate is the right hook.** It is where the module's own `savePath` dies: the instance is
disposed, and its next save calls `saveDialog` again regardless. So revocation takes away nothing a
legitimate module still had — it makes main's list agree with the module's own state instead of
outliving it by the length of the session.

**What this does and does not buy.** It scopes **accidents** — a stale path, a module that kept a
reference, a capability that outlived the subject it was granted for. It does not stop a compromised
renderer, which simply never sends the message. That is not a flaw in the hook but a property of
where the admission comes from: `allowPath` admits any existing absolute path today, so every
admission in this app is only as strong as the renderer. Tightening `allowPath` is the durable fix,
it is a change to the oldest security surface here, it is out of scope for this branch, and it is
now written down in `docs/ROADMAP.md` under Modules.

**Inert for `--job`.** A batch run's admissions come from the envelope's `out` arguments, admitted in
`prepareJob` before a window exists, and its actions activate modules in whatever order they are
listed — `activateModule` deactivates the previous one, which is a step *between* two actions and not
the end of an editing session. `registerModuleIpc({ isJob })` drops the message there.

## 2026-08-30 — `TETRAVOX_E2E_DISCARD` is honoured only in a build that runs tests

**Decision.** `shouldPromptOnClose` gains `packaged`, and returns `true` — prompt — whenever it is
set, whatever the environment says. `installCloseGuard` takes it from main's `app.isPackaged`.

**Why.** The seam was read from `process.env` in every build, packaged and notarised included. It is
ambient state: a dotfile, a launcher script, a wrapper, or a shell where someone once exported it for
a test run. A user in that shell makes unsaved sEEG contact edits, presses ⌘W, and the window closes
with no prompt and no trace — and the module's only reversibility is the `.bak` its *save* writes,
which never ran. §5 rule 12's guard is the whole of the protection on that gesture, and an
environment variable should not be able to switch it off.

**Why not read `app.isPackaged` in `module-io.ts`.** `shouldPromptOnClose` is pure, which is why all
four of its cases have a unit test rather than a window; importing `app` for one boolean would trade
that for nothing. Main already has it. Absent means "not packaged", so every existing caller —
including the e2e's — behaves exactly as before.

**The e2e says both halves.** `module-guard.spec.ts`'s seam test now branches on its target: on `dev`
the seam still closes a dirty window silently, and on `packaged` the box is shown, Cancel keeps the
window and Discard closes it. `module-seeg.spec.ts` clears the edited flag in `afterAll` instead of
relying on the seam, so its teardown does not depend on which build it is running.

## 2026-08-30 — the docs guard checks the sidebar §13.7 always said it checked

**Decision.** `scripts/check-frozen-docs.mjs` reads `website/.vitepress/config.ts` and requires a
`/guide/<slug>` entry for every module manifest's `docs` heading, where the slug is the one
`GUIDE_PAGES` maps that heading to.

**Why it was a real hole.** §13.7 item 3 has always listed three things — the `## ` section, the
`GUIDE_PAGES` entry "and the site sidebar" — and said "The `docs-guard` CI job fails without them."
It checked two. The sidebar is a hand-written literal: `sync.mjs` generates `website/src/guide/
<slug>.md` but never generates or validates the list that links to it, and VitePress's
`ignoreDeadLinks: false` fails only the opposite mistake — a sidebar entry with no page. A page with
no sidebar entry builds perfectly and ships reachable from nothing, which is precisely the late,
silent failure the guard's own header says it exists to prevent, while the contract claimed CI had
caught it.

**A grep, not a parser.** The config is TypeScript and this script is plain ESM run by `node --test`
with no build step. The sidebar is a literal array of `link:` strings, which a regex reads exactly as
well as a parser would, and a config that stopped being that shape would fail loudly here rather than
quietly pass. `sidebar` defaults to `''` rather than being optional, so a caller that forgets to pass
it gets a failure instead of a silently skipped rule — which is the failure mode this fixes.

**Scope.** Manifests only, matching §13.7's wording; the guard does not audit the eighteen core guide
pages, whose sidebar entries no module PR touches.
