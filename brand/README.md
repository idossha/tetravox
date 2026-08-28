# Tetravox brand

<img src="../docs/media/logo.png" alt="Tetravox" width="420">

The mark says what the app is in one shape: a **cube** with one corner sliced
off, and the **tetrahedron** that came out of that corner, lifted clear of the
socket it left behind. A voxel and a finite element, the two things Tetravox
draws in one scene, cut from the same solid.

Everything in this directory is generated. `generate.py` builds the polyhedra in
3D, projects them isometrically, culls the back faces and shades what is left —
so every coordinate in every SVG is computed, none of it traced or nudged by
hand. To change the mark, change a constant and re-run:

```sh
python3 brand/generate.py          # all SVGs + every raster export
python3 brand/generate.py --svg    # SVGs only (no rsvg-convert / iconutil needed)
```

## Construction

The eye sits on the cube diagonal, which is what makes the projection *true*
isometric: the three cube axes come out 120° apart and all three edge lengths
are equal. Two consequences drive the whole design.

* **The cut face is seen flat on.** Slicing the near corner `(1,1,1)` at `CUT`
  along each of its three edges leaves a triangular face whose normal is the
  view direction — so the socket reads as a clean equilateral triangle rather
  than a foreshortened sliver.
* **The freed tetrahedron's apex projects to the centroid of its own base.**
  Its three side faces therefore meet at the middle of the triangle in a Y, and
  because their normals are the cube's own axes they take exactly the cube's
  three face shades. The element is visibly a solid, and visibly made of the
  cube it came from.

Back-face culling and painter's-order sorting are done from the real geometry,
and every face winding is re-derived by `orient()` rather than trusted —
a winding error is otherwise silent, since the face simply vanishes into the
cull.

Shading is one fixed Lambert term per face against one light, with an ambient
floor of 0.18 so nothing goes black. Flat, no gradients, no bevels.

### The knobs

| Constant | Value | What it does |
| --- | --- | --- |
| `CUT` | `0.56` | How far down each corner edge the cut bites. Bigger = bigger element and bigger socket. |
| `TET_LIFT` | `0.45` | How far the element is lifted out, in cube edge lengths. |
| `TET_SCALE` | `1.20` | Element size. Just over 1 so it reads as the subject, not as debris. |
| `TET_SPIN` / `TET_TILT` | `0` | Extra rotation of the element. Zero is deliberate: on the diagonal the Y of interior edges is at its most symmetric. |
| `LIGHT` | `(0.30, 0.12, 1.0)` | Overhead, biased right, so top > right > left on both solids. |
| `MARK_PAD` | `14` of `256` | Clear space inside the mark's own box. |

These were chosen by rendering the candidates at 16, 32, 64 and 512 px and
looking at them. The failure modes worth knowing about, if you re-tune:

* Lift the element too far and its base edge collides with the cube's top
  vertex, leaving a grey nub poking out of the blue — it reads as an artefact.
* Cut too deep and the black socket stops being a hole and becomes a second
  silhouette that competes with the cube's.

## Colours

Two hues from `packages/app/src/renderer/src/theme/tokens.ts`, both muted,
neither neon — the app deleted its cyan accent and the mark never had one.

| Role | Range | Token it comes from |
| --- | --- | --- |
| Cube | `#313846` → `#6f7889` | graphite, the `bg` / `panel` / `lineStrong` family |
| Element | `#3b5ba9` → `#a8bcea` | the one accent (`#3b5ba9` light theme, `#93aae2` dark) |
| Socket | `#252c39` | darker than any lit face, but not black |
| Seam | `#1b2029` | one value for every edge |
| Icon plate | `#2b313b` → `#1b1f26` | graphite, a vertical ramp |

The cube deliberately sits mid-value so the mark holds up on a white page and
on the app's own `#16181c` chrome without a second artwork.

### Monochrome

`tetravox-mark-mono.svg` is one ink (`#15181d`) at varying opacity, and it
inverts two things from the colour mark because it has no hue to separate the
solids with:

* the seam is the **paper**, not a darker ink — at 16 px a dark hairline between
  two dark facets fills in and the facets silt together;
* the socket is **lighter** than the element, so the two do not merge into one
  blob directly under the apex, which is where the mark has to stay readable.

It assumes a light ground. On a dark one, invert the whole thing rather than
recolouring facets individually.

## Files

| File | What it is |
| --- | --- |
| `tetravox-mark.svg` | The mark. 256², transparent. |
| `tetravox-mark-mono.svg` | One-ink variant, for stamps, print and anywhere colour is not available. |
| `tetravox-wordmark.svg` | Mark + `Tetravox` set in Jost Medium, outlined. |
| `tetravox-plate.svg` | The mark on the macOS-style rounded plate. Source for every app icon. |
| `generate.py` | Builds all of the above and every export below. |

Generated outside this directory, all by the same command:

| Path | Used by |
| --- | --- |
| `packages/app/build/icon.png` | electron-builder, 1024² |
| `packages/app/build/icon.icns` | macOS app bundle (10 slots, 16 → 512@2x) |
| `packages/app/build/icon.ico` | Windows (256/128/64/48/32/16) |
| `packages/app/build/icons/*.png` | Linux AppImage + deb (16 → 512) |
| `website/public/logo.svg` | VitePress `themeConfig.logo` |
| `website/public/favicon.svg`, `favicon.png` | VitePress `head` |
| `docs/media/logo.png` | README header |

Nothing under those paths should ever be hand-edited; re-run the generator.

### Why the icon has a plate and the website logo does not

macOS and Windows both draw an app icon against a background nobody controls,
and the HIG's answer is a rounded square that provides its own ground. The plate
follows the macOS icon grid: an 824 × 824 rounded square inside a 1024 box
(100 px clear on every side) with a corner radius of 0.2237 of its side.

The favicon uses the same plate with **no** outer inset and a much tighter
margin. At 16 px the app-icon margin leaves the mark about ten pixels across and
it goes to mush; the website logo, which is only ever shown large and on a known
background, needs no plate at all.

## Type

The wordmark is [Jost\*](https://github.com/indestructibletype/Jost) at weight
500 — a geometric sans in the Futura line, chosen because its round bowls and
single-storey `a` sit naturally beside a mark built from flat facets, and its
pointed `v` echoes the element.

The outlines are **baked into `generate.py`** as a path string, so the wordmark
needs neither the font file nor fontTools to rebuild. To change the type:

```sh
curl -L -o /tmp/jost.ttf \
  'https://github.com/google/fonts/raw/main/ofl/jost/Jost%5Bwght%5D.ttf'
python3 brand/generate.py --regen-wordmark /tmp/jost.ttf   # rewrites the baked block
python3 brand/generate.py
```

That is the only mode that needs a third-party package (`fonttools`), and the
font itself is not vendored. Jost\* is licensed under the SIL Open Font License
1.1; outlines converted to paths carry that licence, which permits their use and
redistribution as part of this artwork.

## Usage

* **Clear space** — the mark's own box already carries about 5% padding. Keep at
  least the height of the tetrahedron's base edge clear on every side beyond it.
* **Minimum size** — 16 px for the plate (favicon, tray), 20 px for the bare
  mark, 120 px wide for the wordmark. Below the mark's minimum the socket closes
  up and it reads as a plain cube.
* **Don't** re-colour facets individually, add gradients or shadows, outline the
  mark, rotate it, or set the wordmark in a substitute face. If a one-colour
  version is needed, that is what `tetravox-mark-mono.svg` is for.

## Requirements

`--svg` needs only Python 3.11+. The raster exports additionally need:

* **`rsvg-convert`** (librsvg) or **`cairosvg`** — SVG → PNG.
* **`iconutil`** — `.icns`. macOS only; the step is skipped elsewhere with a
  note, and the rest of the exports still run.

`.ico` is written by hand at the bottom of `generate.py`, so it needs nothing:
every Windows since Vista reads PNG-compressed frames inside an ICO container,
and the frames are already PNG bytes on disk by that point.
