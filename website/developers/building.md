---
title: Building from source
---

# Building from source

Users don't need any of this — the [Install](/install) page has the official builds. This page is
for working on Tetravox itself: Rust + WebGL2 engine, Electron shell, pnpm workspace.

## Toolchain

- **Rust**, pinned by `rust-toolchain.toml` (rustup picks it up), with the `wasm32-unknown-unknown`
  target and `wasm-pack`.
- **Node ≥ 22** and **pnpm** (the exact version is `packageManager` in `package.json`; `corepack
enable` is enough).
- macOS or Linux. Windows builds are produced by CI; developing on Windows is untested.

## Dev build

```sh
git clone git@github.com:idossha/tetravox.git
cd tetravox
pnpm install
pnpm exec electron --version   # warms the ~100 MB Electron binary on a cold machine
pnpm wasm                      # crates/tvx-wasm -> packages/wasm/pkg
pnpm dev                       # the app, with hot reload, against the dev server
```

`pnpm wasm` is a prerequisite of `build`, `test` and `typecheck` — the TypeScript packages import the
generated bindings.

## Everything else

```sh
pnpm build      # wasm + every package
pnpm package    # this platform's artefacts only (unsigned unless CSC_LINK is set)
pnpm test       # cargo test --workspace + wasm + vitest
pnpm e2e        # Playwright, in Chromium and in Electron
pnpm typecheck
pnpm lint       # eslint + prettier (Prettier deliberately leaves docs/ alone)
cargo clippy --workspace --all-targets -- -D warnings
```

Real-data tests skip, never fail, when `TETRAVOX_TESTDATA` is unset; `scripts/fetch-data.sh` and
`scripts/fetch-public-samples.sh` pull the sample datasets the screenshots and examples use.
[Testing](/developers/testing) is the operator's manual for the suites and the golden policy.

## Packaging

`pnpm package` writes this platform's artefacts to `packages/app/release/`. Without a signing
certificate it is an ordinary unsigned build: on macOS, Gatekeeper will then refuse the first launch
until `xattr -dr com.apple.quarantine /Applications/Tetravox.app` — that is the one case the command
is for. Linux artefacts can be built from a macOS host with `scripts/package-linux.sh` (Docker), and
`node scripts/smoke-artefact.mjs` launches a packaged binary with `--job` and asserts it rendered.
How a version becomes a signed, notarised, cross-platform release is on the
[Releasing](/developers/releasing) page.

## Where to read next

- [Contributing](/developers/contributing) — the working manual: commands, test data, and the rules
  every change follows.
- [Architecture](/developers/architecture) — the engineering contract, cited by section number from
  code and tests.
- [Decisions](/developers/decisions) — the append-only record of why things are the way they are.
