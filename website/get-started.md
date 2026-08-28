---
title: Get started
---

# Get started

## Packaged app

Download the artefact for your platform from the [releases page](https://github.com/idossha/tetravox/releases),
or build one yourself with `pnpm package` (produces a `.dmg` on macOS, `.AppImage`/`.deb` on Linux — this
platform's artefacts only).

**macOS — the app is unsigned.** Gatekeeper will refuse to open it ("Tetravox is damaged and can't be
opened"). Clear the quarantine attribute once:

```sh
xattr -dr com.apple.quarantine /Applications/Tetravox.app
```

See the [User Guide's installing section](https://github.com/idossha/tetravox/blob/main/docs/USER_GUIDE.md#installing)
for why, and for the Linux `chrome-sandbox` note.

## Dev build

```sh
pnpm install
pnpm exec electron --version   # warms the ~100 MB binary on a cold machine
pnpm dev                       # the app, against the dev server
```

```sh
pnpm build      # wasm + every package
pnpm package    # this platform's artefacts only
pnpm test       # cargo test --workspace + vitest
pnpm e2e        # Playwright, in Chromium and in Electron
pnpm typecheck · pnpm lint
```

`pnpm wasm` builds `crates/tvx-wasm` → `packages/wasm/pkg` and is a prerequisite of `build` / `test` /
`typecheck`.

## File formats and file associations

Tetravox opens NIfTI (`.nii`, `.nii.gz`), Gmsh meshes (`.msh`), GIfTI, FreeSurfer surfaces, STL/PLY/OBJ,
and its own scene format (`*.tetravox.json`) — drag a file onto the window, use **Open…**, or pass a path
on the command line.

## Where to go next

- **[Viewing data](/viewing-data)** — opening data, navigating, layers, regions, measuring, scenes,
  themes.
- **[Automation & Python](/automation)** — driving the same engine headlessly from a script.
- **[Architecture](/developers/architecture)** — the full technical contract, if you're building or
  contributing.
