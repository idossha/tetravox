# Directives for ARCHITECTURE v2 (planner decisions on the 2026-08-27 design review)

Source: `docs/review/2026-08-27-design-review.json` (68 findings from 4 lenses; 14 graphics findings adversarially
verified — 13 upheld, 1 refuted with an improved formula). Decisions below are final; the rewrite must implement
them and may use the reviewers' concrete text/numbers (they measured on M2 Max / ANGLE-Metal / Node 25 / rustc 1.93).

## A. Process, memory, loading (rust-wasm + delivery lenses)
A1. **Worker-per-dataset.** Each dataset (volume or mesh) gets its own Web Worker + its own WASM instance; closing the
    dataset = `worker.terminate()` (the only way to give wasm linear memory back). One extra long-lived "utility"
    worker for cheap cross-dataset ops (e.g. label-volume sampling for isolation) is allowed. Parallelism across
    datasets comes for free; **single-threaded WASM, permanently** — delete "rayon-ready" and the Phase-3 rayon bullet.
A2. **Privileged `tetravox://` scheme** registered in Electron main (`registerSchemesAsPrivileged` with `standard,
    secure, supportFetchAPI, stream, corsEnabled`) + `protocol.handle`. It serves the renderer bundle
    (`tetravox://app/…`, loaded with `loadURL`, never `loadFile`), the wasm module (`content-type: application/wasm`,
    so `instantiateStreaming` works), and user data as streaming responses (`tetravox://file/<percent-encoded abs path>`).
    Module Workers work under this origin. This is a **Phase-0 deliverable and gate item**.
A3. **Bytes never cross IPC and never touch the UI thread.** IPC is for dialogs/menus/paths only. The dataset worker
    `fetch`es `tetravox://file/…` itself, inflates `.gz` with a streaming `DecompressionStream('gzip')` inside the
    worker, and hands the bytes to WASM. In plain-browser mode the same worker accepts a `File`/`ArrayBuffer` source.
    The Rust readers still sniff `1f 8b` and inflate with `miniz_oxide` as a fallback (keeps crates usable natively/CLI).
A4. **Progress + cancel** are part of the protocol: `progress {requestId, phase: 'read'|'inflate'|'parse'|'topology'|'index'|'upload', done, total}`
    and `cancel(requestId)`; Rust parsers take a progress callback + abort flag checked at section boundaries
    (every ~1 M records). Latest-wins drops *queued* requests; an in-flight WASM call runs to completion — say so.
A5. **No views into wasm memory in the contract.** Bulk results are `Vec<T>` returned by wasm-bindgen (already a fresh
    ArrayBuffer → transfer `.buffer` as-is) or written into a caller-owned `js_sys::Float32Array` via `copy_from` for
    hot paths (cuts). Never hand out `view()`s (memory.grow detaches them).
A6. Input bytes are copied into WASM once; after parse the input buffer is dropped. Budget per worker: state measured
    peaks (ernie.msh ≈ 1.0 GB, ernie_seeg.msh ≈ 2.8 GB) and the 4 GiB wasm32 ceiling; > 2 GiB files get a warning.

## B. Geometry (graphics + rust-wasm lenses)
B1. **Default 3D representation of a mesh that has surface elements is its own tagged triangles** (SimNIBS invariant:
    stored tris == exterior ∪ inter-tissue faces; verified 0 missing / 0 extra on ernie and ernie_seeg — encode as a
    real-data test). `tag_surfaces(mesh)` takes no topology. `extract_boundary(tets, tags, mask)` (sort-based, scratch
    dropped before return) serves tri-less meshes (`grey_*_TI.msh`) and post-isolation/clip boundaries.
B2. `build_topology` is explicit, awaitable, progress-reporting, called eagerly *after first frame* only when
    isolation/clipping needs it — never lazily from a drag. Unique faces via **counting sort on min-vertex + sort of
    (v1,v2) pairs** — no packed key, no node-count limit (ernie_seeg has 2,301,899 nodes > 2^21).
B3. **Spatial locality at load:** after parsing, tets are reordered by Morton code of centroid (keep `tet_perm` and
    original Gmsh element numbers; UI always reports Gmsh numbers); then a uniform-grid `TetGrid` (per-cell AABB) is
    built. `plane_cut(mesh, grid, planes: &[Plane], mask) -> Vec<Cut>` — one `Cut` per plane, each clipped by the
    others; write the exact `Cut`/`CutInterp` structs. Perf targets: morton < 250 ms, grid < 500 ms, cut < 15 ms
    (canonical) / < 30 ms (oblique) on ernie in WASM. Caps upload into a pre-sized double-buffered VBO via
    `bufferSubData`; coarse cut while the gizmo is held, exact on release (interaction/settle split).
B4. **De-indexing, normals, edge masks, element-id attributes are geometry → computed in the worker**, delivered as
    transferables. `mesh_surface(handle, {maskId?, variant:'indexed'|'deindexed'})` returns draw-ready buffers with
    per-tag ranges; `indexed` is the default (tag colouring, smooth node fields); `deindexed` only for flat element
    fields / edges / caps. The engine never builds vertex buffers element-by-element.
B5. Gmsh v2 binary layout must be written down: nodes `i32 id + 3×f64`; `$NodeData/$ElementData` records `i32 id +
    ncomp×f64` (data-size 8); element blocks `[type, count, ntags]` headers with `numTags` honoured; values narrowed to
    f32; **scatter by id** through an `elmNumber → index` map (fast path when ids are 1..N); gaps → NaN with
    `Field.partial=true`. Physical names/colours from `$PhysicalNames` when present, else sibling `<mesh>_LUT.txt`.
    Also parse `<mesh>.msh.opt` (`read_msh_opt`) to seed tag colours/visibility, field range, colormap, colorbar.
B6. NIfTI: spell out the qform construction incl. **qfac = pixdim[0] < 0 ? −1 : 1 on the third column**; real-data
    test on `m2m_ernie/T1.nii.gz` voxel (0,0,0) and (255,255,207) against nibabel. Add percentile 99.9.
B7. GIfTI: XML via `quick-xml`; encodings ASCII / Base64Binary / GZipBase64Binary (**zlib stream → ZlibDecoder**) /
    ExternalFileBinary → Unsupported; honour Endian and CoordinateSystemTransformMatrix. `base64` crate. Record deps.
B8. Add `label_centroids(vol) -> Vec<(id, centroid, count)>` and `PointLocator` built at load (for hover probes).

## C. Rendering (graphics lens — all 13 upheld findings apply verbatim where not restated here)
C1. **Capability probe at context creation** (`OES_texture_float_linear`, `EXT_texture_norm16`, `WEBGL_clip_cull_distance`,
    `MAX_3D_TEXTURE_SIZE`, `MAX_SAMPLES`); `getExtension` must be *called*; never LINEAR on a non-filterable format.
    Scalar volumes default to **R16F** (with scale/offset carried for reconstruction); R32F only when float-linear is
    present or interpolation is nearest; u8 → R8; labels → **R16UI dense index remap** (id→dense map built at load,
    cap 65535) + `N×1 RGBA8` palette texture. Continuous colormaps stay 256×1 RGBA8.
C2. **Clipping** = `WEBGL_clip_cull_distance` (`gl_ClipDistance[i] = dot(n, p) + offset`, keep ≥ 0 — identical to
    `tvx-core::Plane`) with a `discard` fallback selected at program-compile time; program variants keyed on active
    plane count N ∈ 0..6; both paths pixel-identical under the same goldens.
C3. **Slice geometry belongs to the plane, not the volume:** one quad per plane sized to scene bounds, shared VAO for
    every layer on that plane; per-volume extent handled by fragment discard. 2D views: depth test off, blend in layer
    order. 3D `showIn3D` planes use the same VAO with LEQUAL. Label outline formula per the refuted finding's improved
    text (screen-relative taps: `texcoord ± 0.5·outlineWidthPx·(inverseAffine·dFdx(world))/dims`).
C4. **Pick pass:** `RGBA32UI` + `DEPTH_COMPONENT24`; payload `(pickId=layerIndex+1, elementId, floatBitsToUint(gl_FragCoord.z), 0)`;
    element ids come from a per-vertex attribute (no `gl_PrimitiveID` in WebGL2); cursor set by unprojecting depth.
C5. **Edges:** masked barycentric wireframe (3-bit `edgeMask` per triangle; quads from tet cuts suppress the diagonal),
    one mechanism for surfaces and caps; constant attribute when unmasked.
C6. **Transparency v1:** scene-wide two-phase (2a back faces sorted by far extent, 2b front faces sorted by near extent),
    `faceMode` replaces `backfaceCull`; per-tag draws so per-tag opacity sorts naturally. WBOIT in Phase 3 behind the
    same pass; `Framebuffer` carries `samples` from day one; canvas `antialias:true`; 2D views single-sample.
C7. **Frame pump:** `requestRender()` sets dirty bits, one rAF drains them, ≤ 1 render per view per frame; worker
    results mutate state then `requestRender()`. Budget stated at 120 Hz (≤ 8 ms) on ProMotion; interaction vs settle
    quality split; adaptive fallback (drop MSAA / coarse cut) when frame time > budget for 10 frames.
C8. GPU availability rationale corrected (Chromium M137 removed auto-SwiftShader; Electron ≥ 38 floor; add
    `enable-unsafe-swiftshader` switch; `getContext('webgl2') === null` → real error screen).
C9. **View model:** `SliceView { id, mode:'axial'|'coronal'|'sagittal'|'oblique', normal, up, camera:{center, mmPerPx}, layerVisibility }`
    (plane derived from cursor + normal, never stored), `View3D { camera, showSlicePlanes }`, layouts reference view ids;
    ViewSpec serialises all of it. Oblique is Phase 2, not 3.

## D. UX contract (product-ux lens)
D1. Phase 1: orientation letters L/R/A/P/S/I derived from the affine + radiological flag, corner info (view name,
    slice index of active volume, plane RAS), persistent RAD/NEU badge; **active layer** (`activeLayerId`, `[`/`]`
    cycle, `v` visibility, right-drag W/L on active or top non-label volume); hover readout (`Mouse`) beside `Cursor`.
D2. Phase 2: colour bars (one per visible scalar layer, ticks, units, threshold notch — required in screenshots);
    scale model `scale: {kind:'linear',lo,hi} | {kind:'heat',min,mid,max,truncate,inverse,negative:'mirror'|'hide'|'separate'}`
    shared by volume/mesh/iso layers (LUT baked on CPU, shader unchanged); histogram widget with draggable window /
    threshold handles + presets; per-region visibility/opacity + Region panel (search, solo, jump-to-centroid);
    `colorMode:'label'` for meshes (.annot / .label.gii) with shared `LabelTable`; `tagStyle: Record<tag,{visible,opacity,color?}>`
    replaces `tagVisibility`; vector glyphs (instanced arrows, subsample, clipToCutPlane); typed coordinate entry +
    copy/paste + optional affine `toTemplate` (MNI) column; load cards with progress/cancel; `.msh.opt` seeding;
    screenshot spec `{target,width,height,scale,dpi,background,include,autoTrim}` with pHYs DPI.
D3. Phase 3: CLI headless render (`tetravox --scene s.json --screenshot out.png --width 2400`), measurement, orientation cube.

## E. Interfaces frozen at the end of Phase 0 (delivery lens)
E1. `packages/protocol/src/index.ts` — worker envelope: `Req {id, key, op, args}`, `Res {id, ok:true, result, transfer[]} | {id, ok:false, error:{code,message}}`,
    `Progress`, op list (`loadVolume, loadMesh, surface, boundary, buildTopology, cut, isolate, field, elmToNode, locate,
    marchingCubes, marchingTets, contours, labelCentroids, free, freeMask`), and every args/result type. Changing it
    requires an ARCHITECTURE.md edit in the same commit.
E2. `packages/engine/src/scene/types.ts` (all §4 types, zero imports) and `packages/engine/src/api.ts` (Engine facade:
    `create(canvas, opts)`, `addDataset`, `removeDataset`, `addLayer`, `updateLayer(id, patch)`, `reorderLayers`,
    `setActiveLayer`, `setCursor`, `setLayout`, `views`, `pick`, `probe`, `screenshot`, `serialize/load`, typed events).
E3. Rust crate stubs with the exact §6 signatures (`unimplemented!()` bodies) compile in Phase 0, so Phase-1 crate
    agents fill bodies rather than invent signatures; `tvx-wasm` exports the §6.4 surface against those stubs.
E4. **Dependency freeze at end of Phase 0**: every crate/package dependency Phase 1 needs is added by the scaffold with
    both lockfiles committed (list them). pnpm 10: `"pnpm": {"onlyBuiltDependencies": ["esbuild","electron"]}`;
    explicit `electron` binary warm-up; gate: clean clone with empty store reaches `pnpm e2e` green.

## F. Verification (§11, new)
F1. Every rendering feature ships an **analytic pixel test** (expected RGBA computed from first principles via
    `expectPixel(view, x, y, rgba, tol)` on synthetic fixtures) **plus** a golden. Goldens are captured only under
    headless Chromium/SwiftShader, fixed canvas size, DPR 1, Playwright pinned; compared with `maxDiffPixelRatio ≤ 0.002`,
    `threshold 0.15`; regenerating requires a commit body stating the visual change. Rewrite AGENTS rule 1 accordingly
    (agents cannot judge a PNG; they can judge a number).
F2. CI matrix: `test` on ubuntu-24.04 (golden authority) + macos-latest; `package` on macos-latest (arm64 dmg),
    macos-intel (x64 dmg), ubuntu-24.04 (AppImage + deb). Linux artefacts are never built on macOS.
F3. macOS signing: **unsigned for now** (record in DECISIONS with the Gatekeeper consequence and the
    `xattr -dr com.apple.quarantine` walkthrough in USER_GUIDE); Developer ID + notarisation is a documented switch.

## G. AGENTS.md corrections
G1. Re-verify and state the exact reference numbers with host SimNIBS (`/Users/idohaber/Applications/SimNIBS-4.6/bin/simnibs_python`,
    `simnibs.mesh_io.read_msh`) and nibabel: ernie.msh per-tag counts + bbox; `Thalamus_TI.msh` field list with
    min/max; `grey_Thalamus_TI.msh` (368,762 nodes / 1,340,029 tets / 0 tris per the reviewer — verify);
    `lh.central.gii` (245,762 verts / 491,520 tris — verify); `ernie_seeg.msh` node count.
G2. Lockfiles: `pnpm-lock.yaml` and `Cargo.lock` are frozen after Phase 0; Phase-1 agents may not add dependencies
    without coordinating through the integrator; worktree branches rebase on `main` before merge.
