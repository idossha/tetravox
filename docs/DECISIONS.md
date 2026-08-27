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

- 2026-08-27 — **§6.2 promises two pieces of data the frozen structs have no field for, so both got an
  *additive* entry point rather than a struct change.** §6.2 says a `.label.gii`'s `<LabelTable>` "becomes a
  `LabelTable`", but `read_gifti` returns a `Mesh`, which has no such field; and §6.2's name ladder ends at
  "sibling `<mesh>.msh.opt` (`Physical Volume(" GM",2)` …)", but `MshOptions` carries only
  `tag_color` / `tag_visible` / `views`. The second gap is not academic: `m2m_ernie/ernie.msh` has **no
  `$PhysicalNames` section at all** `[DATA]`, so its `.msh.opt` is the *only* source of "WM", "GM", "CSF" …
  for the flagship file, and a reader that drops those names leaves the tissue table unnamed. Changing
  either struct is an ARCHITECTURE.md edit, which is not this agent's to make, and silently discarding the
  data is worse than a two-line addition — so `tvx_mesh_io::read_gifti_labels(&[u8]) -> Result<LabelTable>`
  and `tvx_mesh_io::read_msh_opt_names(&[u8]) -> Result<Vec<(i32, String)>>` exist beside the frozen
  signatures, which are untouched. **The integrator should fold them into §6.2** — most naturally as
  `Mesh.label_table: Option<LabelTable>` and `MshOptions.tag_name: Vec<(i32, String)>` — and then delete
  them.
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
- 2026-08-27 — **Two §8 behaviours have no member on the frozen §4.7 facade, and the app duck-types them
  rather than editing it.** (a) §7.5's `r` (reset view) and `1..6` (A/P/L/R/S/I presets) need `fit()` and
  the preset rotations, which are engine maths; `setView(id, patch)` could carry a whole `Camera3D`, but
  computing one in the app would put scene-bounds fitting in React, which §8's last line forbids. §7.5's
  `c` edits `Scene.annotations`, and `Scene` is exposed `Readonly` with no setter at all. (b) §8's status
  bar owes "wasm `heapBytes` per dataset", which §6.5.2 stamps on every `Res` — and `EngineEvents` carries
  none, so it stops at the engine. `engine/commands.ts` declares both as optional interfaces
  (`resetView`/`cameraPreset`/`setAnnotations`, `heapBytes(id)`) and probes for them at runtime: an engine
  that has them gets the behaviour, one that does not shows a disabled control. `NoGlEngine` implements
  all four. **The integrator closes this one of two ways** — the real engine implements the same four
  members (no contract change, since an implementation may exceed its interface), or §4.7 grows them in
  an ARCHITECTURE edit. Leaving it duck-typed forever is not the third option: it is a gap, recorded so
  it is not mistaken for a design.
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
