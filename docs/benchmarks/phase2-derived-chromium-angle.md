# Phase 2 — E-DERIVED benchmarks — `chromium-angle`

**Measured inside the page** (`packages/engine/test/e2e/derived-r4.spec.ts`), around the whole
round trip a sweep pays for: `setCursor` → the `cut` op in the dataset worker → transfer →
table and VBO upload → render, with `whenSettled()` closing each step (§7.2). Not a shader
timing and not a worker timing — the number R4 asks for.

Machine: darwin arm64, `chromium-angle`, DPR 1, 768×768.
Data: `m2m_ernie/ernie.msh` (847,165 nodes / 1,177,213 tris / 4,722,625 tets), no volume,
`fillIn2D` and `contoursIn2D` both on (the R4 default), 0.5 mm/px.

| Sweep | Steps | Total | Per step (median) | Worst step | End-to-end fps | Bar |
|---|---|---|---|---|---|---|
| `1x1` axial | 20 × 1 mm | 473.8 ms | 24.5 ms | 26.4 ms | **42.2 fps** | ≥ 30 |
| `2x2` (3 panes + 3D) | 20 × 1 mm | 469.5 ms | 24.4 ms | 29.6 ms | **42.6 fps** | ≥ 30 |

Context from §9.1 row 10: `plane_cut` on ernie is **12.9 ms axial / 16.6 ms oblique in WASM**
and the worker round trip for the same planes is 16.9 / 21.2 ms. A one-pane step is that round
trip plus the upload and the draw, which is why the 1×1 figure sits where it does.

The `2x2` row sweeps along the axial normal, so only the axial pane's plane moves: the coronal
and sagittal keys re-request the identical plane and the cut source drops the repeat, which is
what keeps three panes from costing three cuts per step.

Row 15 of §9.1 (`T1 + Thalamus_TI.msh` `fillIn2D` + contours, 30 fps, cut latency < 25 ms)
stays `[TARGET]`: this measures `ernie.msh`, which is the file R4 names.

This is the leg R4's bar applies to.
