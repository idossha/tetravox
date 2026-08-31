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

## Adding an extension

A **extension** is a first-party tool that ships with the app — its own panel, keys and files, one active
at a time in the right column. `docs/ARCHITECTURE.md` §13 is the contract; this is the short version.

The rule the whole design rests on: **an extension is a directory and one line in a registry.** If you find
yourself editing `Shell.tsx`, `Toolbar.tsx`, `keymap.ts`, `StatusBar.tsx` or `controller.ts` to make
your extension work, the _host_ is missing a member — add it to
`packages/app/src/renderer/src/modules/host.ts` under §12.3's rules, and say why in
`docs/DECISIONS.md`.

1. `packages/app/src/modules/<name>/manifest.ts` — data only: no DOM types, no `node:` imports, no
   engine imports. It is typechecked by all three tsconfigs because the **main process** reads it
   before a window exists. Add it to `manifests.ts`.
2. `packages/app/src/renderer/src/modules/<name>/` — `index.ts` exporting `activate(host)`, a
   `Panel.tsx`, and whatever pure kernels the work needs. Add one line to `registry.ts`.
3. Your extension may import `../host`, the shared control kit and `@tetravox/engine` **types**. Not the
   store, not the engine's runtime, not `bridge()`. ESLint enforces it and `modules.test.ts` re-proves
   it by reading your source, so an inline disable will not help.
4. Keys come from §13.5's pool (`a s d f g n p t z Delete Backspace`) or your extension has none. A key
   that would destroy something is bound with `when: 'selection'`.
5. A `## ` section in `docs/USER_GUIDE.md` named by your manifest's `docs`, plus its entry in
   `website/scripts/sync.mjs`'s `GUIDE_PAGES` and the sidebar in `website/.vitepress/config.ts`. The
   `docs-guard` CI job fails without all three.
6. Tests per §13.4: pure kernels get vitest, panel behaviour gets a Playwright spec (vitest runs under
   `environment: 'node'`, so there is no DOM there), real data is gated on an environment variable and
   skips when it is unset.

`tetravox.hello` (`?modules=hello`) is the worked example. Read it before writing a manifest.

### …and an extension that ships separately

The steps above are for an extension **in this repository**, reviewed as a pull request here. An extension can also
be its own repository and be downloaded at runtime — see `docs/ARCHITECTURE.md` §13.8 and the user-facing
**Extensions** section of `docs/USER_GUIDE.md`. Two things change and nothing else does:

- you build against **`@tetravox/module-sdk`**, a tarball attached to each Tetravox release and pinned by
  URL. `scripts/module-sdk/README.md` is that package's README — it carries the rollup config, the "your
  bundle must have no imports" CI check, and the release loop that names each asset by its own sha256. Read
  it before writing a line;
- your `docs` field is a **URL** rather than a `## ` heading in `docs/USER_GUIDE.md`. The docs guard ties a
  heading to the guide for extensions in this tree; it has no reach into another repository's README.

Everything else is identical, deliberately: the same `ModuleManifest`, the same `ModuleHost`, the same key
pool, the same scene block. An extension written in-tree becomes an external one by changing its imports.

## Reporting bugs

Open a GitHub issue with the file format, platform, and the app version (Help ▸ About), and attach
the smallest file that reproduces it if you can share it. Security issues go through
`SECURITY.md` instead.

## License

By contributing you agree that your contributions are licensed under the MIT License in `LICENSE`.
