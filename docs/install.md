---
layout: page
title: Install & Run
permalink: /install.html
nav_order: 2
---

# Install & run

The full README lives at the repository root — this page is a short pointer, not a copy. See
**[README.md on GitHub](https://github.com/idossha/tetravox/blob/main/README.md)** for the complete,
up-to-date text (requirements, package layout, status and limitations).

## Packaged app

Download the artefact for your platform from the [releases page](https://github.com/idossha/tetravox/releases),
or build one yourself with `pnpm package` (produces a `.dmg` on macOS, `.AppImage`/`.deb` on Linux — this
platform's artefacts only).

**macOS — the app is unsigned.** Gatekeeper will refuse to open it ("Tetravox is damaged and can't be
opened"). Clear the quarantine attribute once:

```sh
xattr -dr com.apple.quarantine /Applications/Tetravox.app
```

See the [User Guide]({{ site.baseurl }}/USER_GUIDE.html#installing) for why, and for the Linux
`chrome-sandbox` note.

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

## File associations

Tetravox opens NIfTI (`.nii`, `.nii.gz`), Gmsh meshes (`.msh`), GIfTI, FreeSurfer surfaces, STL/PLY/OBJ,
and its own scene format (`*.tetravox.json`) — drag a file onto the window, use **Open…**, or pass a path
on the command line.

## Where to go next

- **[User Guide]({{ site.baseurl }}/USER_GUIDE.html)** — opening data, navigating, layers, regions,
  measuring, scenes, themes.
- **[Automation & Python]({{ site.baseurl }}/AUTOMATION.html)** — driving the same engine headlessly from
  a script.
- **[Architecture]({{ site.baseurl }}/ARCHITECTURE.html)** — the full technical contract, if you're
  building or contributing.
