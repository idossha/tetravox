---
title: Install
---

# Install

Tetravox ships as a desktop app for **macOS**, **Linux** and **Windows**.

Every release is built, smoke-tested and published by CI from a version tag.
The artefacts on the [**Releases page**](https://github.com/idossha/tetravox/releases/latest) are the official builds. Nothing here requires a toolchain; building from source is a [developer topic](/developers/building).

## Download

Pick the file for your machine. Names follow `Tetravox-<version>-<os>-<arch>.<ext>`.

| Platform               | File                                       | Notes                                                                |
| ---------------------- | ------------------------------------------ | -------------------------------------------------------------------- |
| macOS, Apple silicon   | `Tetravox-<version>-mac-arm64.dmg`         | M1 and later. Signed with a Developer ID and notarised by Apple.     |
| macOS, Intel           | `Tetravox-<version>-mac-x64.dmg`           | Signed and notarised, as above.                                      |
| Linux, x86-64          | `Tetravox-<version>-linux-x86_64.AppImage` | Runs on any distribution; no install.                                |
| Linux, Debian / Ubuntu | `Tetravox-<version>-linux-amd64.deb`       | Installs to `/opt/Tetravox` with a menu entry and file associations. |
| Linux, anything else   | `Tetravox-<version>-linux-x64.tar.gz`      | Unpack and run `Tetravox` from the folder.                           |
| Windows, x86-64        | `Tetravox-<version>-win-x64.exe`           | NSIS installer. Unsigned — see below.                                |

## macOS

1. Open the `.dmg` and drag **Tetravox** into **Applications**.
2. Launch it from Applications or Spotlight.

The releases are signed and notarised, so Gatekeeper opens them directly — no Terminal command is
needed. If you ever see _"Tetravox is damaged and can't be opened"_, you are running an **unsigned
local build** (one produced by `pnpm package` without a certificate), not a release; clear the
quarantine attribute once with `xattr -dr com.apple.quarantine /Applications/Tetravox.app`.

## Linux

**AppImage** — make it executable once, then run it:

```sh
chmod +x Tetravox-*.AppImage
./Tetravox-*.AppImage
```

**Debian / Ubuntu**:

```sh
sudo apt install ./Tetravox-*-linux-amd64.deb
```

**tar.gz** — unpack anywhere and run `./Tetravox` inside the folder.

If the app refuses to start with a message about `chrome-sandbox`, the kernel's unprivileged user
namespaces are disabled on your system. Either fix the sandbox helper's ownership as the message
says, or run with `--no-sandbox`. If the status bar reports a **software renderer**, the GPU was
blocklisted by Chromium — Tetravox still runs, only slowly, and says so rather than pretending
otherwise; `chrome://gpu` in any Chromium browser says why.

## Windows

Run the installer. Windows SmartScreen will warn that the publisher is unknown, because the
Windows build is not code-signed: choose **More info → Run anyway**. The installer adds a Start-menu
entry and the file associations.

## First launch

Drag files onto the window, press **⌘O / Ctrl+O**, or name them on the command line:

```sh
Tetravox T1.nii.gz ernie.msh
```

Opening data **adds** it to what is already on screen; opening a saved scene (`*.tetravox.json`)
**replaces** the scene. Tetravox registers itself for `.nii`, `.nii.gz`, `.msh`, `.gii`, `.geo`,
`.pos` and `.tetravox.json`, so double-clicking one of those opens it too.

The [Get started](/get-started) page walks through the window; the [Guide](/guide/opening-data)
covers every control.

## Upgrading

Install the new version over the old one — the same drag on macOS, the same installer on Windows,
the same `apt install` on Debian. Settings (theme, capture defaults, the FreeSurfer subjects
directory) are kept between versions; scenes are plain JSON files that any version reads. There is no
in-app auto-update; new versions are announced on the
[Releases page](https://github.com/idossha/tetravox/releases) and in the
[changelog](https://github.com/idossha/tetravox/blob/main/CHANGELOG.md).

## Requirements

- A GPU with **WebGL2** — any machine from the last decade. The app checks for a working context at
  startup and says so if there is none, rather than opening a blank window.
- Memory in proportion to your data: a full SimNIBS head mesh is 100–200 MB on disk and several
  times that in memory. See [Troubleshooting](/guide/troubleshooting).
- No Python, no Node, no Rust. Those are only needed to
  [build from source](/developers/building) or to drive the app
  [from a script](/automation).
