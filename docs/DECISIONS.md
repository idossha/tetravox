# Decision log

Format: `YYYY-MM-DD — decision — why — alternatives rejected`. Append-only.

- 2026-08-27 — Electron over Tauri — Chromium guarantees WebGL2 parity on macOS/Linux; WebKitGTK WebGL2 is inconsistent and lacks WebGPU — Tauri (smaller binary) rejected for GPU risk.
- 2026-08-27 — Custom WebGL2 engine, no three.js/NiiVue — need one context + depth buffer for slices *and* tet meshes, integer 3D textures, exact caps; NiiVue cannot host tets and its clip planes ignore meshes (verified spike 2026-08-27); three.js API churn and abstraction fights — rejected.
- 2026-08-27 — Rust→WASM in a worker for all parsing/geometry — UI thread must never block; pure-Rust crates keep a native/CLI path open — JS parsers rejected (5 M-element face hashing too slow / GC-heavy).
- 2026-08-27 — Sort-based unique-face extraction instead of HashMap — deterministic output for golden tests and ~3× faster in WASM.
- 2026-08-27 — Exact cut caps from `plane_cut` (CPU) + GPU `discard` for clipped surfaces — Gmsh-quality per-element caps; pure-GPU tet rendering (16 M+ triangles) rejected for integrated GPUs.
- 2026-08-27 — Latest-wins compute scheduling — dragging a plane must never queue stale work.
