# Decision log

Format: `YYYY-MM-DD — decision — why — alternatives rejected`. Append-only.

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
  **Linux artefacts are never built on macOS.** Every package job ends with an artefact smoke test.
- 2026-08-27 — macOS builds are **unsigned for v1** — Sequoia removed the Control-click Gatekeeper bypass, so a
  downloaded unsigned `.dmg` shows a hard "cannot be opened" dialog and the user must use System Settings →
  Privacy & Security → Open Anyway; `USER_GUIDE.md` carries that walkthrough plus
  `xattr -dr com.apple.quarantine /Applications/Tetravox.app`. Auto-update is therefore out of scope. Developer ID
  + notarisation is a documented switch (`APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` +
  `notarize: true`). Ad-hoc signing (`identity: "-"`) — rejected: it only runs on the build machine and has
  known electron-builder regressions. `electron-builder` is pinned to an exact patch.
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
