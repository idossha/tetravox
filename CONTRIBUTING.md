# Contributing to Tetravox

Thanks for your interest. Tetravox is a Rust + WebGL2 + Electron viewer for volumes and meshes; the
engineering contract is `docs/ARCHITECTURE.md`, and `AGENTS.md` is the working manual for humans
and agents alike. Read those two before opening a substantial pull request.

## Getting started

```bash
git clone git@github.com:idossha/tetravox.git
cd tetravox
pnpm install
pnpm wasm          # builds crates/tvx-wasm → packages/wasm/pkg
pnpm dev           # the app, with hot reload
```

Rust is pinned by `rust-toolchain.toml`; Node ≥ 22 and pnpm (`packageManager` in `package.json`).

## Before you push

- `pnpm lint` — eslint + prettier (Prettier deliberately does not format `docs/`).
- `pnpm typecheck`
- `pnpm test` — `cargo test --workspace`, the wasm build, vitest.
- `cargo clippy --workspace --all-targets -- -D warnings`
- `pnpm e2e` when you touched the renderer or the shell. `docs/TESTING.md` explains the golden
  policy: ubuntu-24.04 SwiftShader is the authority, so re-bless goldens from a CI render, not from
  your GPU.

## Pull requests

- One change per PR, with a description that says what changed and why. Cite the
  `ARCHITECTURE.md` section you are implementing or amending.
- Design changes go through `docs/DECISIONS.md` (append-only) — add an entry rather than editing
  an old one.
- New file-format support needs a synthetic fixture in `testdata/` produced by
  `scripts/gen-fixtures.py`, with expected values read back by an independent library.
- Do not bump versions or push tags in a PR; releases are cut by a maintainer per
  `docs/RELEASING.md`.

## Reporting bugs

Open a GitHub issue with the file format, platform, and the app version (Help ▸ About), and attach
the smallest file that reproduces it if you can share it. Security issues go through
`SECURITY.md` instead.

## License

By contributing you agree that your contributions are licensed under the MIT License in `LICENSE`.
