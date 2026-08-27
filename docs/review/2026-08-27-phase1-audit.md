# Phase-1 audit — what the contract asks for against what `main` contains

**Date** 2026-08-27 · **Tree** `phase-1` = `8f39c0f` · **Machine** M2 Max, macOS 15.7 ·
`TETRAVOX_TESTDATA=/Users/idohaber/datasets/000/derivatives/SimNIBS/sub-ernie`

Why this document exists: `tvx-geom` and `packages/engine` reached the Phase-1 gate written by the
**integrator**, not by the `p1/geom` and `p1/engine` agents the plan named (ROADMAP, "Outstanding at
the gate"). Two verifiers then re-ran the gate and fixed what they found. This is a third pass with a
different question — not *"does the gate reproduce"* (it does; every baseline below is green) but
*"which contract clauses does the code actually satisfy, clause by clause"*, so that Phase 2's four
to five parallel agents inherit a list rather than a surprise.

**Baselines, this tree, before any edit in this task:**

| Command | Result |
|---|---|
| `pnpm typecheck && pnpm lint` | ✔ 4 packages, eslint + prettier clean |
| `cargo test --workspace` (via `pnpm test`) | ✔ **189** passed / 0 failed / 0 ignored, 21 suites |
| `vitest run` | ✔ **141** passed, 12 files |
| `pnpm --filter @tetravox/engine run e2e` (both projects) | ✔ **27** passed, 1 skipped (the R16 branch skips on SwiftShader, by design) |
| `pnpm --filter @tetravox/app exec playwright test --project=dev` | ✔ **29** passed |

---

## Scoreboard

| Section audited | Implemented | Partial | Missing | Rows |
|---|---|---|---|---|
| ROADMAP · engine-foundation bullet | 8 | 4 | 2 | 14 |
| ROADMAP · minimum-shader bullets | 6 | 0 | 0 | 6 |
| ROADMAP · app-shell bullet | 9 | 1 | 0 | 10 |
| §7.5 · every mouse/key binding | 9 | 2 | 10 | 21 |
| §7.2 · frame pump | 5 | 1 | 5 | 11 |
| §7.0 · target chain | 6 | 1 | 1 | 8 |
| §7.1 · probe rules | 9 | 2 | 0 | 11 |
| §4.7 · Engine facade | 24 | 5 | 1 | 30 |
| §5 · process/thread rules | 9 | 0 | 0 | 9 |
| §8 · shell items | 12 | 2 | 8 | 22 |
| **Total** | **97** | **18** | **27** | **142** |

Nothing in the "missing" column is a *regression*: 21 of the 27 are features ROADMAP puts in Phase 2
or Phase 3 and are listed here only so the ownership map can claim them. The six that are **Phase-1
scope and absent** are all in one place — §7.5's pointer interaction — and they are called out under
[Larger gaps](#larger-gaps--phase-2-work-items) as **P2-01**.

---

## 1. ROADMAP Phase 1 — the `packages/engine` foundation bullet

> GL kit + `probeCapabilities` + `forceCaps`, the rAF frame pump with `interacting` / `whenSettled()`,
> cameras/controls, scene/layer store with `activeLayerId`, `SliceView` model incl. oblique, view
> layouts, cursor/crosshair, pick pass, screenshot, colormaps + LUT parsers (§7.6).

| # | Item | State | Evidence |
|---|---|---|---|
| 1 | GL kit — `Program`, `Buffer`, `VertexArray`, `Texture3D`, `Framebuffer`, `Timer` | implemented | `gl/program.ts:54`, `gl/buffer.ts`, `gl/texture.ts:118`, `gl/framebuffer.ts:23`, `gl/timer.ts` |
| 2 | `Program` **variant cache** keyed on `(colorMode, flatShading, isLabel, activeClipPlaneCount)` | partial | `gl/program.ts:124` `ProgramVariants` is generic over any defines; only `IS_LABEL` is passed today (`render/renderer.ts:194`). The other three keys arrive with Phase 2's features — the cache itself needs no change. |
| 3 | `probeCapabilities` | implemented | `gl/caps.ts:49` → `gl/context.ts:128`; every optional extension is `getExtension`ed, not looked up (`context.ts:142-149`) |
| 4 | `forceCaps` (may only remove) | implemented | `gl/caps.ts:62-76`, each field ANDed with the probe; exercised by gate 6 on both Playwright projects |
| 5 | rAF frame pump, one per engine, `requestRender` never synchronous | implemented | `engine.ts:818-831` |
| 6 | Per-**view** dirty bits | partial | `engine.ts:140` is one global `#dirty`; `#renderFrame` redraws every pane in the layout each frame (`engine.ts:846-869`). Behaviourally a superset of "each dirty view at most once", but a 2×2 layout pays 4 panes for a 1-pane change. |
| 7 | `interacting` state | **missing** | `engine.ts:143` is declared and never assigned `true`; `#settleTimer` (`engine.ts:144`) is never armed. Nothing can set it, because the engine binds no pointer events at all (see §7.5 below). |
| 8 | `whenSettled()` | implemented | `engine.ts:882-904`; every golden awaits it |
| 9 | Cameras | implemented | `view/geometry.ts:206` (3D), `:112` (2D ortho slice), `:241` `fitCamera`, `:269` presets |
| 10 | **Controls** (orbit / pan / dolly / window-level / slice wheel) | **missing** | no `addEventListener` anywhere in `packages/engine/src`; `ui/ViewGrid.tsx:8` states the gestures "belong to the engine and live on the canvas" — the engine never installs them |
| 11 | Scene/layer store with `activeLayerId` | implemented | `engine.ts:453-502`, `scene/defaults.ts:65` |
| 12 | `SliceView` model incl. oblique | implemented | `view/geometry.ts:72` `sliceBasis`, `:100` derived plane, `:112` `sliceViewProj`; gate 4's golden is the oblique one |
| 13 | View layouts | implemented | `view/layout.ts:40`, all five kinds |
| 14 | Cursor / crosshair, pick pass, screenshot, colormaps + LUTs | implemented (screenshot partial — see §4.7 row) | `engine.ts:508`, `render/overlay.ts:141`, `render/pick.ts:91`, `engine.ts:928`, `color/colormaps.ts`; the §7.6 LUT parsers live in `tvx-mesh-io` and arrive on the meta |

## 2. ROADMAP Phase 1 — the minimum-shader bullets

| # | Clause | State | Evidence |
|---|---|---|---|
| 1 | §7.3 minimum slice: one scalar layer per plane, `Scale{kind:'linear'}` | implemented | `render/shaders.ts:38` `SLICE_FS`; `render/renderer.ts:187-229` is one draw per (layer, plane) |
| 2 | Shared plane geometry — one quad per plane, every layer drawn from it | implemented | `render/renderer.ts:135` `#writeQuad`, written **once** per pane before the layer loop (`:184`) |
| 3 | `invariant gl_Position` | implemented | `render/shaders.ts:26`, and again on the pick variant `:164` |
| 4 | 2D depth-off blending | implemented | `render/renderer.ts:179-181` |
| 5 | Per-layer AABB discard | implemented | `render/shaders.ts:66` — the `tc ∉ [0,1]³` discard *is* the layer's own AABB, in voxel space |
| 6 | §7.4 minimum mesh: indexed tag surfaces, tag colour as a uniform, headlight Blinn-Phong, `faceMode` | implemented | `render/shaders.ts:88`/`:106`, `render/renderer.ts:264-288` (uniform per sub-draw), `:312-319` `faceMode` |

The four "**no**" clauses (no labels/threshold/heat/`showIn3D` in the slice shader; no clip/caps/edges/
field/glyphs in the mesh shader) are all honoured — the shaders contain none of them, which is what
makes them the *minimum* the bullet asks for and Phase 2's starting point.

## 3. ROADMAP Phase 1 — the `packages/app` shell bullet

| # | Item | State | Evidence |
|---|---|---|---|
| 1 | Window + privileged scheme wiring | implemented | `src/main/index.ts`, `src/main/protocol.ts` |
| 2 | Open dialog / drag-drop / CLI args | implemented | `ui/Shell.tsx:99-129`, `:166-179`, `store/controller.ts:174` |
| 3 | Layer list with load cards | implemented | `ui/LayerPanel.tsx`, `ui/LoadCards.tsx` |
| 4 | Info panel with `Cursor` **and** `Mouse` blocks | partial | `ui/InfoPanel.tsx` renders both; the `Mouse` block is wired to `engine.on('hover')` (`store/controller.ts:96`) and **the engine never emits `hover`** — the block is permanently blank in the real app. Structure is right, source is absent. |
| 5 | Coordinate bar (RAS/voxel) | implemented | `ui/CoordinateBar.tsx`, `lib/coords.ts` |
| 6 | Orientation letters | implemented | `view/geometry.ts:178` `edgeLetters` → `render/overlay.ts:147` |
| 7 | Corner info | implemented | `render/renderer.ts:379-388`, slice index from the affine (`renderer.ts:518`) |
| 8 | RAD/NEU badge | implemented | `render/renderer.ts:407`, `render/overlay.ts:173` |
| 9 | Status bar | implemented | `ui/StatusBar.tsx`, `lib/metrics.ts` |
| 10 | Everything reachable from the `Engine` API alone | implemented | `store/controller.ts` is the only file holding an `Engine`; §4.7 gained the five members the app used to duck-type (`api.ts`, 2026-08-27 DECISIONS entry) |

---

## 4. §7.5 — every mouse and key binding

The contract's list, one row per binding. **This is where Phase 1 is genuinely incomplete.**

### 2D pointer

| Binding | State | Evidence |
|---|---|---|
| left-click/drag sets the cursor | **missing** | no pointer handler in `packages/engine/src`; `Engine.setCursor` exists and is only ever called by the app's coordinate bar and by `#onFirstDataset` (`engine.ts:412`) |
| wheel = slice ±1 | **missing** | `Engine.stepCursor` (`engine.ts:519`) exists; nothing wheels it |
| ⌘/Ctrl+wheel = zoom | **missing** | `SliceView.camera.mmPerPx` is only written by `resetView`/`#onFirstDataset` |
| right-drag = window/level on the **active** layer, falling back to the topmost non-label volume | **missing** | `#topVolume()` (`engine.ts:557`) exists for the step rule only; no gesture writes `layer.scale` |
| middle/space-drag = pan | **missing** | `SliceView.camera.center` is only ever `[0,0]` |
| arrows nudge the cursor | partial | `lib/keymap.ts:99-106` maps `↑→` and `↓←` to `stepCursor`, i.e. **along the view normal** — the same action as PgUp/PgDn. §7.5 lists the two separately, so "nudge" should be in-plane. |
| PgUp/PgDn slice | implemented | `lib/keymap.ts:99`, `:104` → `controller.stepCursor` → `engine.stepCursor` |

### 3D pointer

| Binding | State | Evidence |
|---|---|---|
| left orbit (arcball) | **missing** | `Camera3D.rotation` is written only by `cameraPreset` (`engine.ts:609`) |
| right pan | **missing** | `Camera3D.target` is written only by `fitCamera` |
| wheel dolly | **missing** | `Camera3D.distance` likewise |
| double-click = `setCursorFromPick` | **missing** | `engine.ts:661` implements it; only the e2e harness calls it |

### Keys

| Key | State | Evidence |
|---|---|---|
| `r` reset view | implemented | `lib/keymap.ts:76` → `controller.resetActiveView` → `engine.resetView` (`engine.ts:589`) |
| `1..6` presets | implemented | `lib/keymap.ts:31` `PRESET_KEYS` → `engine.cameraPreset` (`engine.ts:609`), `presetRotation` (`geometry.ts:269`) |
| `c` toggle crosshair | implemented | `lib/keymap.ts:79` → `engine.setAnnotations({crosshair})` |
| `x` cycle layout | implemented | `lib/keymap.ts:82` → `controller.cycleLayout` |
| `o` orthographic | implemented | `lib/keymap.ts:85` → `engine.setView({camera:{orthographic}})`; honoured at `geometry.ts:223` |
| `[` / `]` cycle active layer | implemented | `lib/keymap.ts:88-91` |
| `v` toggle active layer visibility | implemented | `lib/keymap.ts:92` |
| `Shift+drag` opacity | **missing** | a pointer gesture; `lib/keymap.ts:10` correctly says it belongs to the engine, which has no pointer layer |
| `Ctrl+↑/↓` reorder | implemented | `lib/keymap.ts:66-67` → `engine.reorderLayers` |
| `,` / `.` 4D index | partial | `lib/keymap.ts:95-98` → `controller.stepVolumeIndex` (`controller.ts:363`) → `updateLayer({volumeIndex})`. **The engine has no texture for index > 0**: `#adoptVolume` uploads only `` `${id}|0` `` (`engine.ts:354`) while the draw looks up `` `${datasetId}|${volumeIndex}` `` (`renderer.ts:72`), so on a 4D volume the layer silently stops drawing. The `volumeFrame` op is in the protocol (`protocol/src/index.ts:322`) and unused by the engine. ROADMAP puts the 4D spinner in Phase 2, so the *binding* is early, not the engine. |
| cut-plane sliders + gizmo | Phase 2 | ROADMAP Phase 2, "6 clip planes … + gizmo" |

## 5. §7.2 — passes per frame and the frame pump

| Clause | State | Evidence |
|---|---|---|
| Pass order 1 opaque → 2 transparent (2a back / 2b front) → 3 overlay → 4 pick | implemented | `render/renderer.ts:309-352` (1, 2a, 2b, `faceMode:'both'` last in 2b), `:359` overlay, `render/pick.ts:91` |
| Overlay pass disables depth and all clip distances | implemented | `render/renderer.ts:418`; no clip distance is ever enabled in Phase 1, so the reset set is trivially empty |
| `requestRender` sets a dirty bit, never renders synchronously | implemented | `engine.ts:818` |
| One rAF per engine drains all dirty bits, each dirty view at most once | partial | one global bit (`engine.ts:140`); every pane redraws each frame |
| Worker results mutate state and call `requestRender`; they never draw | implemented | `engine.ts:774-777`, `:414`, `:512` |
| Budget per cadence (≤ 8 ms @ 60 Hz, ≤ 5 ms @ 120 Hz); skip alternate vsyncs above ~6 ms | **missing** | no cadence logic anywhere |
| `interacting` entered on input, left `settleMs` (120 ms) after the last one | **missing** | `engine.ts:143-144` — see §7.5 |
| The `interacting` `QualityLevel` (`dprScale 1`, `msaa 0`, `edges false`, `capDecimation`) | **missing** | `Scene.quality` (`scene/defaults.ts:93`) is a constant `'full'` |
| `interpolation` never degraded | implemented | `render/renderer.ts:204-211` reads `layer.interpolation` every draw and only ever downgrades it for a **format** reason, never a quality one |
| Automatic degradation on median-of-30 over budget, surfaced in the status bar | **missing** | `engine.ts:873-874` pushes into `#frameTimes` and **nothing ever reads it**; `#lastQuality` (`engine.ts:147`) is a constant; the `quality` event is declared (`api.ts`) and never emitted |
| `whenSettled()` semantics | implemented | `engine.ts:882` |
| Depth: standard NDC, no `EXT_clip_control`, no reverse-Z; `near = max(1, r/1000)`, `far = 8r` | implemented | `view/geometry.ts:263-264`; no clip-control call exists |

## 6. §7.0 — antialiasing and target chain

| Clause | State | Evidence |
|---|---|---|
| Canvas created with `antialias: true` (v1), passes 1–3 to the default framebuffer | implemented | `engine.ts:160`, `gl/context.ts:77`; `#renderFrame` binds `null` (`engine.ts:840`) |
| **2D views render single-sample** | **missing** (inherent to v1) | 2D panes share the one multisampled default framebuffer, because §7.0 item 2 forbids an FBO chain in v1. The two clauses cannot both hold before Phase 3 moves the main render offscreen; recorded so the Phase-3 OIT work inherits it rather than rediscovering it. |
| `Framebuffer.samples` exists from day one and allocates via `renderbufferStorageMultisample` when > 0 | implemented | `gl/framebuffer.ts:28`, `:36`, `:59-69` |
| Pick target never uses the multisample entry point | implemented | `gl/framebuffer.ts:46` `texStorage2D`; `render/pick.ts:73` passes `samples: 0` with the §7.0.4 reason in a comment |
| No MSAA FBO chain yet | implemented | none exists |
| `gl.lineWidth()` never used; `*WidthPx` as quads | implemented | `render/overlay.ts:141-145` draws the crosshair as two `rect`s; `grep lineWidth packages/engine/src` is empty |
| Progressive refinement is Phase 3 but the API shape is Phase 1 | implemented | `whenSettled()` is the converging-state-machine hook |
| Goldens use `aa: 'off'` | implemented | `test/pages/scene.ts:27`; `playwright.config.ts` |

## 7. §7.1 — GL kit and capability rules

| Clause | State | Evidence |
|---|---|---|
| Probe runs **once**, at context creation, before any texture exists, cached on the engine | implemented | `gl/context.ts:184` inside `createContext`; `engine.ts:157-165` stores the result |
| `getExtension` is *called*, not looked up | implemented | `gl/context.ts:142-149` |
| **Never LINEAR on a non-filterable format** | implemented | `gl/texture.ts:135-137` (`linear && filterable && !integer`) **and** re-asserted per draw at `render/renderer.ts:204-211` |
| Integer texture ⇒ compiled variant, not a uniform switch | implemented | `render/shaders.ts:50` `#if IS_LABEL`, `render/renderer.ts:194` |
| `floatLinear` absent ⇒ force `nearest` **and flag it in the layer panel** | partial | forced (above); **not flagged** — `ui/LayerPanel.tsx` has no such badge |
| `norm16` absent ⇒ §6.1 ladder steps to R32F/R8 | implemented | caps travel to the worker at `engine.ts:229-231`; gate 6 asserts both branches |
| `clipDistance` absent ⇒ discard path | Phase 2 | no clip path exists yet; `forceDiscardClip` is declared in `EngineOptions` and unused |
| `timerQuery` absent ⇒ wall clock only | implemented | `gl/timer.ts`, `engine.ts:169` |
| Never `gl_CullDistance`, enforced by a lint | implemented | `eslint.config.js` — identifier, string literal **and** template-element selectors |
| `forceCaps` may only remove | implemented | `gl/caps.ts:66-75` |
| `Capabilities` surfaced verbatim in the status bar / scene dumps / bench output | partial | status bar `ui/StatusBar.tsx:66-72` ✔, bench lines ✔ (`[bench]`/`[pick]` in the e2e output); the `ViewSpec` (§4.6) has no field for it, so "scene JSON dumps" has nowhere to land |
| `getContext('webgl2') === null` ⇒ a real error screen naming `chrome://gpu` | implemented | `ui/Webgl2Error.tsx:25`, reached from `ui/Shell.tsx:71` |

## 8. §4.7 — the Engine facade, member by member

Every member is present and none throws. Five do less than the contract's sentence says.

| Member | State | Note / evidence |
|---|---|---|
| `caps`, `scene`, `views` | implemented | `engine.ts:125`, `:199`, `:203` |
| `addDataset` | implemented | `engine.ts:233`; volume/mesh split by `looksLikeVolume` |
| `removeDataset` | implemented | `engine.ts:417` |
| `cancelDataset` | partial → **fixed here** | `engine.ts:429` also tore down the worker when **no** load was in flight, which silently killed that mesh's `locate` probes and its `heapBytes`. See [Fixed in this task](#fixed-in-this-task). |
| `addLayer` / `removeLayer` / `updateLayer` / `reorderLayers` / `setActiveLayer` | implemented | `engine.ts:453-502` |
| `setCursor` | implemented | `engine.ts:508`, emits `cursor` and refreshes mesh probes |
| `stepCursor` | implemented | `engine.ts:519`, with the §7.5 voxel-plane snap |
| `setLayout` / `setView` / `setRadiological` | implemented | `engine.ts:567`, `:572`, `:583` |
| `pick` / `setCursorFromPick` | implemented | `engine.ts:630`, `:661`; §11's four pick clauses are asserted by gate 5 |
| `probe` | partial | `engine.ts:675`. Volume rows are exact and synchronous. Mesh rows come from `#locateCache`, i.e. **one worker round trip stale**, and are omitted until the first `locate` lands — the honest consequence of a synchronous signature over an async op, and documented as such at `engine.ts:668-674`. `ProbeResult.mni` is never populated (needs `toTemplate`, Phase 2). |
| `resetView` / `cameraPreset` / `setAnnotations` | implemented | `engine.ts:589`, `:609`, `:621` |
| `heapBytes` | implemented | `engine.ts:445` |
| `requestRender` | partial | `engine.ts:818` ignores `viewId` (global dirty bit) |
| `renderNow` / `readPixel` | implemented | `engine.ts:907`, `:912` |
| `whenSettled` | implemented | `engine.ts:882` |
| `screenshot` | partial | `engine.ts:928` honours `background: 'white'` and nothing else of `ScreenshotOptions`: `target`/`viewId` (no crop), `width`/`height`/`scale` (no resample), `dpi` (**no pHYs chunk**), `include` (no per-item suppression), `autoTrim`. `background: 'transparent'` fell through to the opaque scene clear — **fixed here**. |
| `serialize` | partial | `engine.ts:973`. Emits every §4.6 field, but `DatasetRef.fingerprint` is `''` and `path` is absolute — §4.6 asks for paths relative to the scene file with an absolute fallback, plus a fingerprint. |
| `load` | partial | `engine.ts:1005`. Restores views, layout, cursor, radiological, background, lighting, annotations, transparency — and **never restores `spec.layers` or `spec.activeLayerId`**. It also cannot: the datasets it re-adds get fresh ids (`ds1`, `ds2`, …) that do not match the spec's, so the id remap is the missing piece, not the assignment. |
| `readPixel`, `on`, `destroy` | implemented | `engine.ts:912`, `:177`, `:1023` |
| `create()` | implemented | `api.ts`, returns a live `TetravoxEngine` |
| **event `hover`** | **missing** | declared in `EngineEvents`; nothing in `packages/engine/src` emits it. The app subscribes (`store/controller.ts:96`) and §8's `Mouse` block therefore never fills. Blocked on §7.5's pointer layer. |
| event `quality` | missing | see §7.2 |
| events `cursor` / `pick` / `layers` / `datasets` / `progress` / `frame` / `error` | implemented | `engine.ts:510`, `:654`, `:461`, `:357`, `:250`, `:863`, `:256` |

## 9. §5 — process and thread architecture

All nine rules hold. This is the strongest area of the Phase-1 code.

| Rule | State | Evidence |
|---|---|---|
| 1 · Worker-per-dataset, `removeDataset` ⇒ `terminate()` | implemented | `engine.ts:236-239` (one `new Worker` per `addDataset`), `:437-442` |
| 2 · `Req.args` buffers never transferred | implemented | `wasm/src/compute-client.ts:18-21` and its `#lastTransfers` bookkeeping; no op donates |
| 3 · Bytes never cross IPC, never touch the UI thread | implemented | `engine.ts:106-122` turns a `DatasetSource` into a `LoadSource` **URL/File**, never bytes; `engine.ts:101` `fileUrl`. The one bulk array coming back is `VolumeDataset.data`, which §4.3 requires. |
| 4 · Gzip in the worker | implemented | `wasm/src/sources.ts` |
| 5 · Input bytes copied into WASM once | implemented | Rust side, `tvx-wasm` |
| 6 · Latest-wins on `key`; cancel = `terminate()` | implemented | `compute-client.ts:71` `TERMINATE_ON_CANCEL`; `engine.ts:429`; gate item 1 measures 4–6 ms |
| 7 · Results are owned buffers, never views | implemented | §6.4, Rust side |
| 8 · A panic/OOM poisons the module ⇒ tear down, mark failed, emit `error`, never retry | implemented | `compute-client.ts` `onPoisoned` → `engine.ts:255-257` |
| 9 · `tetravox://file/` reads only user-named paths, sidecars admitted with the dataset | implemented | `src/main/protocol.ts`, `src/main/paths.ts`; asserted by `e2e/phase0.spec.ts:99` |

**No parse or geometry work runs on the UI thread.** `render/gpu.ts:1-10` states the rule and the file
keeps it: every array it uploads arrived as a transferable, and the one expansion it makes is a
`texelFetch` at `gl_VertexID / 3` (`render/gpu.ts:174-204`) rather than a per-vertex attribute.

## 10. §8 — the shell, item by item

| Item | State |
|---|---|
| Dark theme; left layer panel / centre view grid / right info panel / top toolbar / status bar | implemented |
| Ordered layer list, eye, opacity slider, 1 px accent on the active layer | implemented |
| Per-dataset load card with phase + percent + elapsed + Cancel | implemented |
| Coloured border on the active view pane | implemented (`ui/ViewGrid.tsx:92`) |
| 2D chrome: letters, corner info, RAD/NEU badge, in every golden | implemented — and *decoded* out of the framebuffer by `test/helpers/chrome.ts`, not merely present |
| Info panel `Cursor` block | implemented |
| Info panel `Mouse` block | partial — no `hover` source (§4.7) |
| Coordinate bar RAS / Voxel, Enter jumps, copy, paste | implemented |
| Coordinate bar **MNI** column | missing — needs `toTemplate` (Phase 2) |
| Status bar: renderer, fps, frame ms, GPU ms, heap bytes, last load time, `isSoftware` | implemented |
| Status bar: current `QualityLevel` when below full | partial — rendered, never below full (§7.2) |
| Open: menu / ⌘O / drag-drop / CLI | implemented |
| Renderer never calls `file.arrayBuffer()` | implemented |
| Screenshot → PNG | implemented (the spec's knobs are not — §4.7) |
| Per-kind property editor | missing (Phase 2) |
| Colour bars | missing (Phase 2) |
| Histogram widget | missing (Phase 2) |
| Region panel | missing (Phase 2) |
| Mesh tissue table | missing (Phase 2) |
| Scene save/load + relocate dialog | missing (Phase 2) |
| `.msh.opt` chip + Reset | missing (Phase 2) |
| Probing: hover values, element info, header panel | missing (Phase 2) |

---

## Fixed in this task

Small, contained, no rendering change — every golden is byte-identical afterwards.

| # | Gap | Fix | Lines |
|---|---|---|---|
| F1 | `cancelDataset` on a dataset whose load had **already finished** fell into `#teardown`, terminating a live worker. The dataset stayed in the scene with no worker behind it, so `locate` probes stopped returning and `heapBytes` went `undefined` — a silently half-dead dataset. §4.7 says the method "cancels an in-flight load"; with no load in flight it must be a no-op, and `removeDataset` is the method that closes a dataset. | `engine.ts` — drop the `else` branch | 3 |
| F2 | Two different slice-quad half-extent formulas: `TetravoxEngine.#quadHalfFor` (`engine.ts:808`, used **only** by the pick pass) and `Renderer.#quadHalf` (`renderer.ts:152`, used by the draw). The pick one omits the pan term, so a panned 2D pane could hand the pick pass a quad smaller than the one on screen and a click near the edge would miss a slice that is visibly there. | delete `#quadHalfFor`; expose `Renderer.quadHalfFor(view, rect, scene)` and use the one formula in both places | 18 |
| F3 | `removeDataset` filtered the removed dataset's layers out of the scene but left `activeLayerId` pointing at one of them. | re-point `activeLayerId` the way `removeLayer` already does | 4 |
| F4 | `screenshot({background: 'transparent'})` returned an opaque PNG: the frame had already been cleared to `scene.background`, whose alpha is 1. | clear to `[0,0,0,0]` for that one render, then restore | 9 |
| F5 | `destroy()` left `#locateCache`, `#lastViewProj` and `#lastRects` populated — three maps that outlive the GL objects they describe. | clear them alongside `#listeners` | 3 |

`F2` is also the largest single duplication the audit found; folding it removes a whole method from
`engine.ts` and puts the quad's geometry entirely inside the renderer, which is where Part 2's
`render/passes/slice.ts` will own it.

---

## Larger gaps — Phase-2 work items

Each is claimed by exactly one owner in `docs/PHASE2-OWNERSHIP.md`.

| Id | Gap | Size | Proposed owner |
|---|---|---|---|
| **P2-01** | **§7.5 pointer interaction, all of it** — 2D click/drag cursor, wheel slice, ⌘-wheel zoom, right-drag window/level, middle/space pan, `Shift+drag` opacity; 3D orbit/pan/dolly, double-click pick. This is the one Phase-1-scope hole. It also unblocks `interacting`, `hover` and the `Mouse` block. | large | **E-SCENE** |
| P2-02 | `interacting` state + `settleMs` + the `interacting` `QualityLevel`, and the adaptive-degradation hook that reads `#frameTimes` and emits `quality` | medium | **E-SCENE** (state) → Phase 3 owns the actual knobs |
| P2-03 | Per-view dirty bits in the frame pump | small | **E-SCENE** |
| P2-04 | `hover` event emission + hover probe rows + element info (§8's `Mouse` block, ≤ 16 ms volume / ≤ 50 ms mesh) | medium | **E-SCENE** |
| P2-05 | `,`/`.` 4D stepping: the `volumeFrame` op, a second texture key, new `Stats` for the colour bar and histogram | medium | **E-SLICE** |
| P2-06 | `screenshot` spec: `target:'view'` crop, `width`/`height`/`scale`, `dpi` → pHYs chunk, `include` suppression, `autoTrim` | medium | **E-SCENE** (engine) + **A-SHELL** (dialog) |
| P2-07 | `serialize`/`load`: relative paths, fingerprints, dataset-id remap on load, layers and `activeLayerId` restored, relocate dialog | medium | **E-SCENE** (engine) + **A-SHELL** (dialog) |
| P2-08 | `floatLinear`-absent flag in the layer panel (§7.1's named fallback is "force nearest **and flag it**") | small | **A-PROPS** |
| P2-09 | Arrows nudge **in-plane**, distinct from PgUp/PgDn's slice step (§7.5 lists them separately) | small | **E-SCENE** (needs an engine-side in-plane nudge; the app may not compute the basis — §8 forbids logic in React) |
| P2-10 | `ProbeResult.mni` + the coordinate bar's MNI column, via `toTemplate` | small | **E-SCENE** + **A-SHELL** |
| P2-11 | Everything in §10's "missing (Phase 2)" rows: property editors, colour bars, histogram, region panel, tissue table, `.msh.opt` chip | large | **A-PROPS** / **A-SHELL** / **E-SLICE** / **E-MESH** / **E-DERIVED** |

Deferred beyond Phase 2, recorded so nobody re-files them: 2D single-sample rendering (needs the
Phase-3 offscreen chain), the cadence-aware vsync skip, progressive refinement, and label
minification AA.

---

## Code-quality risks in `engine.ts` and `renderer.ts`

Written before Part 2's refactor, and the reason for it.

**1. `engine.ts` is a god object with five unrelated jobs.** 1,057 lines holding: the dataset/worker
lifecycle (`:233-447`), the layer store (`:453-502`), the cursor/view/camera commands (`:508-624`),
pick and probe (`:630-782`), the frame pump (`:788-926`), screenshot, and serialisation. Four to five
Phase-2 agents all need to touch it. Every kind-specific decision in it — "is this a volume or a mesh"
— is an `if` on `layer.kind` or `ds.kind`, at `:266`, `:371`, `:680`, `:707`, `:718`, `:762`. Adding
`iso` and `points` layers means finding all six. **This is what `src/layers/*` fixes.**

**2. The volume/mesh branch is duplicated across three files with three different shapes.**
`engine.ts:680`/`:707` switches on `layer.kind` for probing, `renderer.ts:188` (`if (layer.kind !== 'volume') continue`) and `renderer.ts:244` (`if (layer.kind !== 'mesh') continue`) for drawing, and
`pick.ts:131`/`:159` (`layer.kind === 'mesh' && !isSliceView` / `layer.kind === 'volume' && isSliceView`)
for picking. Three enumerations of the same taxonomy, none of which the type system checks for
exhaustiveness — a new layer kind compiles cleanly and draws nothing.

**3. Duplicated GL state handling.** `renderer.ts` sets depth/blend/cull state inline in three places
(`:179-181` 2D slice, `:296-298` and `:310` opaque 3D, `:326-350` transparent) and `pick.ts:120-124`
sets a fourth, independent set. Nothing tracks what is currently enabled, so every pass must set
everything defensively; `renderer.ts:351` disables `CULL_FACE` "just in case" on the way out. §7.4's
clip-distance rule ("the GL kit tracks `CLIP_DISTANCE0_WEBGL + i` as render state — it is global and
survives `useProgram`") explicitly asks for a state tracker that does not exist yet, and Phase 2 is
where six clip planes and cap draws make the absence expensive.

**4. Duplicated geometry formulas.** `#quadHalfFor` vs `#quadHalf` (fixed as F2 above) and
`worldToVoxel`, which is exported from `render/renderer.ts:499` — a *rendering* module — and imported
by `engine.ts:43` for probing. A world→voxel transform is scene maths, not a renderer concern.
`topVolume` likewise exists twice: `engine.ts:557` (`#topVolume`) and `renderer.ts:489` (`topVolume`),
same loop, same rule, two copies.

**5. Missing dispose paths.**
* `GpuStore.uploadVolume` (`gpu.ts:101-102`) and `uploadSurface` (`gpu.ts:149-150`) return the
  **existing** entry when the key is taken and drop the freshly-arrived payload on the floor. Correct
  today (nothing re-uploads the same key), a leak the moment Phase 2 re-uploads a surface after an
  isolation change — the cache key is documented as `(dataset, maskId, clip state)` and the clip state
  is not in it yet.
* `GpuStore.#luts` (`gpu.ts:70`) grows without bound: the key is
  `JSON.stringify(scale)|colormap|negative`, so **every drag of a window/level slider mints a new
  256×1 texture that is never freed**. Phase 1 never drags one; §7.5's right-drag (P2-01) will, at
  ~60 textures/second.
* `removeLayer` (`engine.ts:466`) drops no GPU resource. Harmless while resources are keyed by dataset,
  but Phase 2's per-layer caps, glyph and de-indexed buffers are per **layer**.
* `destroy()` did not clear the three bookkeeping maps (fixed as F5).

**6. `#renderFrame`'s `frame` event reports cumulative time.** `engine.ts:862` computes
`cpuMs = performance.now() - t0` **inside** the per-view loop with `t0` taken before the first view, so
in a 2×2 layout the fourth pane's `cpuMs` is the whole frame's. `lib/metrics.ts` then takes a median
over the mixed population. Not fixed here on purpose: it would change every number in
`docs/benchmarks/phase1.md`, and re-baselining benchmarks is not a refactor's business. **Phase 3's
performance pass owns it** — flagged here so it is not "discovered" as a regression.

**7. `renderer.ts` mixes orchestration with per-kind drawing.** `renderView` (`:434`) is the only
orchestration in the file; the other 380 lines are the slice draw, the mesh draw, tag colour
resolution, the two-phase sort and the whole overlay composition. §7.2's pass list is a natural seam
and nothing enforces it. **This is what `src/render/passes/*` fixes.**

**8. Shader sources are one 236-line string table.** `render/shaders.ts` holds five programs with no
shared chunks, so §7.1's `#include`-style chunks (the caps ladder, the LUT lookup, the clip-plane
block) have nowhere to live, and E-SLICE and E-MESH would edit the same file on the same days.
**This is what `src/shaders/*` fixes.**
