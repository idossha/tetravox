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

See the [home page](/) for why. On Linux the AppImage needs a correctly-owned `chrome-sandbox`, or run it
with `--no-sandbox`; if the status bar reports a software renderer the GPU was blocklisted — Tetravox still
runs, just slowly, and says so rather than pretending otherwise.

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

## A first look

![The Tetravox window in its dark theme: layer panel, view grid and region panel](/shots/ui/ui-window-dark.png)

The window is three areas: the view grid in the centre (2D panes plus a 3D pane, in a layout you cycle with
`x`), a left panel listing your layers — volumes, meshes, points, isosurfaces — each with its own editor, and
a right panel for regions and measurements. A coordinate bar and an info panel along the top report what is
under the crosshair and under the pointer, in every coordinate space that data supports.

The toolbar rail down the side holds the view controls; **⚙** opens **Settings** (the FreeSurfer subjects
directory that turns on fsaverage vertex read-out, and "reopen last scene on launch" — machine preferences,
not scene state), and **?** opens the key-map dialog, whose tabs group every binding by what it acts on.

![The key-map dialog, bindings grouped in tabs](/shots/ui/ui-keymap-tabs.png)

## File formats and file associations

Tetravox opens NIfTI (`.nii`, `.nii.gz`), Gmsh meshes (`.msh`), GIfTI, FreeSurfer surfaces, STL/PLY/OBJ,
and its own scene format (`*.tetravox.json`) — drag a file onto the window, use **Open…**, or pass a path
on the command line.

## Where to go next

- **[The wiki](/guide/opening-data)** — opening data, the panes, layers, regions, meshes, measuring,
  coordinates, scenes, themes, keyboard shortcuts and troubleshooting, one topic per page.
- **[Showcase](/showcase)** — the film, and the same viewer across CT and MRI of the head, chest, abdomen
  and spine.
- **[Automation & Python](/automation)** — driving the same engine headlessly from a script.
- **[Architecture](/developers/architecture)** — the full technical contract, if you're building or
  contributing.
