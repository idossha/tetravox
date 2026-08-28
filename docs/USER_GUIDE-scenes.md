# Scenes

A **scene** is one file — `something.tetravox.json` — that remembers what you were looking at: which
files were open, how every layer was set up, where the crosshair was, which panes were on screen and
where each camera was pointing. Reopen it and you are back where you left off.

It is a few kilobytes of readable JSON. It does **not** contain your data: it points at the files on
disk. Copy the scene and the data together and it still opens; copy the scene alone to a machine
where the data lives somewhere else and Tetravox asks you where the data went.

---

## Saving

| | |
|---|---|
| **⌘S** / **Ctrl+S** — File ▸ Save Scene | Saves. The first time, a Save sheet appears; after that it writes the same file, with no dialog. |
| **⇧⌘S** / **Ctrl+Shift+S** — File ▸ Save Scene As… | Always asks for a name and location. |

The first Save sheet opens **beside your data**, on
`<the first dataset's folder>/<that dataset's name>.tetravox.json` — so saving a scene built on
`m2m_ernie/T1.nii.gz` offers `m2m_ernie/T1.tetravox.json`. Type any name you like; if you leave the
extension off, `.tetravox.json` is added, which is what makes the file open by double-click later.

The window title tells you where you stand:

```
Tetravox                          nothing open, or nothing changed
Tetravox •                        unsaved changes, no scene file yet
study.tetravox.json — Tetravox    saved, and unchanged since
study.tetravox.json • — Tetravox  saved, and changed since
```

The `•` is deliberately eager: it appears for anything that could have changed the scene, including a
camera you moved and put back. Saving again costs a keystroke; not being told costs the work.

---

## Opening

Any of these opens a scene — they all end in the same place:

* **drag the `.tetravox.json` onto the window**;
* **⌘O / Ctrl+O** (File ▸ Open…) and pick it, the same dialog you open data with;
* **⇧⌘O / Ctrl+Shift+O** (File ▸ Open Scene…), which filters to scenes only;
* **File ▸ Open Recent**, the last ten scenes you saved or opened;
* **double-click it** in Finder or your file manager (the installer registers the extension);
* **name it on the command line**: `Tetravox study.tetravox.json`.

Opening a scene **replaces** what is on screen; opening data **adds** to it. Dropping a scene and
three volumes at once is the one thing you should not do — the scene wins and the volumes are added
on top of it, which is probably not what you meant.

### Reopen last scene on launch

Off by default. Turn it on in the toolbar's **Settings** dialog, under *Scenes*, and Tetravox opens
the most recent entry of Open Recent when it starts. It is off by default because reopening a scene
reloads every file in it, and a head mesh is 184 MB. A launch that names a file of its own — a
double-clicked file, or one on the command line — always wins over the remembered scene.

---

## What comes back

Everything you can set:

* **the files**, with their sidecars — a mesh's `.msh.opt` (tissue names and colours) and a label
  volume's `_LUT.txt` come back with it;
* **every layer setting**: colormap, window and threshold, opacity, visibility, interpolation, the 3D
  surface (`iso3d`) and its level, label outlines and widths, glyph field/shape/scaling/density,
  clip planes (including "follow cursor"), isolation, edges, contours in the 2D panes;
* **region edits**: hidden regions, per-region opacity, and colours you overrode — for a label
  volume, for a mesh's tissue tags, and for a surface annotation;
* **electrode nets and other Gmsh views**: point size, labels on or off, colouring;
* **the crosshair**, the **layout**, and **each pane's camera** — pan, zoom, orbit, distance;
* **annotations**: orientation labels, corner info, scale bar, colour bars, crosshair;
* **the theme** the scene was saved in, applied on open. A scene saved before themes existed simply
  does not mention one, and your own preference stands.

What is *not* in a scene, on purpose: which layer rows you collapsed in the panel (that is this
window, not this scene), and anything that describes your machine rather than your data — the
FreeSurfer subjects directory, for instance, lives in Settings.

---

## When the data has moved

Tetravox looks for each file in three places, in this order:

1. the path recorded **relative to the scene file** — this is the one that makes "copy the whole
   folder" and "put it on a share" work without a dialog;
2. the **absolute** path it had when the scene was saved;
3. the file's own name, next to the scene.

If a file is not in any of them, the **Locate** dialog opens and lists what is missing, what was
tried, and the fingerprint recorded for each. Point it at the file — one at a time — and confirm.
Nothing is loaded until you have answered: half a scene with the wrong files in it is worse than no
scene.

You can **Skip** a file. Its layers are left out and the rest of the scene opens.

The fingerprint (`tvxfp1-…`) identifies a file by its length and a digest of three windows of its
bytes. It tells you whether the file you are pointing at is the file the scene was built on. It is
not a security check, and it will not notice an edit deep inside a large file that missed all three
windows.

---

## The file itself

It is JSON, indented, and meant to be readable:

```jsonc
{
  "version": 2,
  "datasets": [
    {
      "id": "ds1",
      "kind": "volume",
      "name": "T1.nii.gz",
      "path": "m2m_ernie/T1.nii.gz",          // relative to this file
      "absPath": "/data/sub-ernie/m2m_ernie/T1.nii.gz",
      "fingerprint": "tvxfp1-0000000001a2b3c4-9f3c...",
      "sidecars": { "opt": { "path": "ernie.msh.opt" } }   // relative to the DATASET
    }
  ],
  "layers": [ /* … */ ],
  "cursor": [4.26, 26.19, -15.64],
  "layout": { "kind": "1+3", "cells": ["view3d", "axial", "coronal", "sagittal"] },
  "theme": "dark"
}
```

Two things to know if you edit one by hand:

* a threshold with **no** bound is written as `null`, not as `Infinity` — JSON has no infinity, and
  `null` reads back as "unbounded";
* `version` is **2**. Files written by older builds say `1` and still open; they are upgraded in
  memory, and the next save writes 2. A file claiming a version this build does not know is refused
  rather than guessed at, because a wrong guess restores the wrong scene without saying so.
