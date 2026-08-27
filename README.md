# Tetravox

A desktop viewer for **voxel volumes** (NIfTI-1/2) and **finite-element / surface meshes** (Gmsh `.msh`,
GIfTI, FreeSurfer, STL/PLY/OBJ), with a linked 3D view and sagittal/axial/coronal 2D slices. Rendering is
a custom WebGL2 engine in TypeScript; parsing and geometry are Rust compiled to WASM, one worker and one
wasm instance per dataset, so nothing heavy ever touches the UI thread. The shell is Electron, and the
targets are macOS and Linux.

## Where things are

| Path | What |
| --- | --- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | **The contract.** Layout (§2), coordinates (§3), data model (§4), threading (§5), Rust + worker-protocol APIs (§6), rendering (§7), budgets (§9), verification (§11), CI (§12). Read it first. |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | What is in flight, and the gate every phase must pass. |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Append-only decision log. Every deviation from the contract lands here. |
| [`AGENTS.md`](AGENTS.md) | Commands, the reference dataset's measured numbers, and the working rules. |
| `crates/` | `tvx-core`, `tvx-nifti`, `tvx-mesh-io`, `tvx-geom` (pure Rust, native + wasm), `tvx-wasm` (bindings). |
| `packages/` | `@tetravox/protocol` (worker protocol), `@tetravox/wasm` (worker + client), `@tetravox/engine` (renderer), `@tetravox/app` (Electron). |

## Commands

```
pnpm install                       # then: pnpm exec electron --version   (warms the ~100 MB binary)
pnpm wasm                          # crates/tvx-wasm -> packages/wasm/pkg; prerequisite of build/test/typecheck
pnpm build · pnpm test · pnpm e2e · pnpm typecheck · pnpm lint · pnpm dev · pnpm package
cargo test --workspace · cargo clippy --workspace --all-targets -- -D warnings · cargo fmt --check
```

`packages/wasm/pkg` is generated and git-ignored (except the committed `tvx_wasm.d.ts` stub) and is never
a pnpm workspace member.

## Status

Phase 0. The frozen interfaces of §12.3 exist and compile; the Rust bodies are `unimplemented!("phase 1")`.
Both lockfiles are committed and, per AGENTS rule 5, frozen after Phase 0.
