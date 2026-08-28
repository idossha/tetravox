# The showcase video — storyboard

`showcase.mp4` is 1920×1080, 30 fps, **63.8 s**, H.264 / yuv420p, 22.1 MB. `showcase-preview.gif` is the
same film at 640×360, 6 fps, 64 colours — 7.4 MB, under the 8 MB the brief allows. Neither is hand-edited: both come out of **one** automation job,
[`showcase.job.json`](showcase.job.json), which the app renders offscreen through the same `Engine`
calls a user makes with the mouse (`docs/AUTOMATION.md`). Every number below is in the job file; this
page says *why* each one is what it is.

```sh
export TETRAVOX_TESTDATA=/path/to/derivatives/SimNIBS/sub-ernie
pnpm --filter @tetravox/app run build
TETRAVOX_JOB_TIMEOUT_MS=7200000 \
  node_modules/.bin/electron packages/app --job docs/media/showcase.job.json --out /tmp/showcase
# → /tmp/showcase/showcase.mp4 plus 1,915 PNG frames (~2.2 GB) and job-result.json
ffmpeg -i /tmp/showcase/showcase.mp4 -vf "fps=6,scale=640:-2:flags=lanczos,split[a][b];\
[a]palettegen=max_colors=64[p];[b][p]paletteuse=dither=none" -loop 0 docs/media/showcase-preview.gif
```

The job names its data as `${TETRAVOX_TESTDATA}/…`, so it runs on any checkout with the reference
subject on disk — the same variable `docs/TESTING.md` already defines. It never puts a window on the
screen: `--job` forces the offscreen mode and `TETRAVOX_E2E_HEADED` does not override it.

## The scene

Six files, opened the way the Open… dialog opens them, so `ernie.msh.opt` and `labeling_LUT.txt` come
along and the tissues and regions arrive named and coloured. `preset: "plain"` — the film configures
everything explicitly, because a preset choosing a threshold off the data is a *feature* to be shown
rather than a thing to hide the film's own numbers behind.

| Layer | File | Used for |
|---|---|---|
| `T1.nii.gz` | `m2m_ernie/` | the anatomy under everything in Act 1 |
| `grey_L_Insula_TI_subject_TI_max.nii.gz` | `Simulations/L_Insula/TI/niftis/` | the TI field, grey matter only |
| `labeling.nii.gz` (+ `labeling_LUT.txt`) | `m2m_ernie/segmentation/` | the atlas, and the bone isosurface in B11 |
| `L_Insula_TI.msh` (+ `.msh.opt`) | `Simulations/L_Insula/TI/mesh/` | the head mesh **and** its `TI_max` element field |
| `ernie_TDCS_1_scalar.msh` | `Simulations/L_Insula/high_Frequency/mesh/` | the vector `E` field, for the glyphs |
| `GSN-HydroCel-185.geo` | `m2m_ernie/eeg_positions/` | the 183 electrodes |

`L_Insula_TI.msh` is `ernie.msh` — the same 847,165 nodes, 1,177,213 triangles and 4,722,625
tetrahedra — with the simulated `TI_max` on every element. Act 2 uses it instead of `ernie.msh`
because the tissue table, the transparency, the clip caps and the field colouring then all belong to
**one** layer, which is the point being made: the field is a property of the mesh, not a second
picture laid over it.

## Where the left insula came from

**There is no volumetric insula label in this subject's space, and the video does not pretend there
is.** `m2m_ernie/segmentation/labeling.nii.gz` is aseg-like — its LUT has 57 entries, cortex is one
label per hemisphere (`3` / `42`) and there is no insula among them; `massp2021_subject.nii.gz` is
subcortical. The subject *does* have DK40, a2009s and HCP-MMP1 insular parcels, but only as
`lh.ernie_*.annot` — a per-vertex surface annotation. Tetravox reads `.annot` (`crates/tvx-mesh-io`),
but has no way to *open* one: the file dialog takes `.nii/.msh/.gii/.geo/.pos`, and sidecar discovery
derives only `_LUT.txt` and `.msh.opt`. Rather than build an automation-only path into the renderer —
which `docs/ARCHITECTURE.md` §8 forbids and which would make the film show something the product
cannot — the insula is located the way the dataset itself locates it:

* **The target.** `m2m_ernie/ROIs/L_Insula_MNI.csv` holds the simulation's own target, MNI
  **(−38, 5, 0)**. Sampling the subject's `m2m_ernie/toMNI/MNI2Conform_nonl.nii.gz` at that point —
  the same nonlinear warp the coordinate bar uses for its MNI readout — gives subject RAS
  **(−33.4, 31.2, 16.3) mm**. That is the cursor for the whole of Act 1. Checks: `labeling.nii.gz` is
  `3` (`Left-Cerebral-Cortex`) at that voxel with `12` (`Left-Putamen`) 78 voxels inside a 5-voxel
  neighbourhood, and the grey-matter TI there is 0.075 V/m — the field's 95th percentile — with a
  local maximum of 0.112 V/m.
* **The landmark.** Shot A5 solos exactly two atlas labels: `3` in white and `12` in cyan. The insular
  cortex *is* the cortical ribbon between them — the band of `3` lateral to the left putamen — and at
  0.13 mm/px it fills the frame with the TI focus sitting on it. That is an anatomical identification
  a reader can check against the picture, which a coloured-in "insula" region derived from an atlas
  this subject does not have would not be.

## Field numbers, and where they come from

The heat scale and threshold in A2/A3 are the grey-matter TI volume's own distribution over its
non-zero voxels (702,214 of them): p50 0.0357, **p90 0.0606**, p95 0.0722, **p99 0.0924**,
**p99.9 0.1257**, max 0.1496 V/m. The scale runs p90 → p99 → p99.9 and the threshold ends at p90, for
the reason `ti-field-on-t1` gives: this field peaks at 0.15 V/m against a p90 of 0.06, and a
max-anchored scale paints the whole cortex in the bottom colour.

## Orientation

Non-negotiable, and checked frame by frame by reading extracted frames rather than by trusting the
code:

* **Axial: anterior up, neurological.** `A` on the top edge, `L` on the left, `NEU` in the corner. The
  TI field sits on the screen-**left** of every axial frame — which is the left hemisphere, which is
  where an `L_Insula` simulation must put it. The convention badge is in every frame and is not
  optional (§8).
* **Coronal and sagittal: superior up.** `S` top, `I` bottom.
* **3D starts left-lateral.** Every 3D shot begins from camera preset `L` — eye on −X, superior up,
  nose to screen-left — and moves by slow eased orbits about a world axis from there. B3 lifts to a
  left-**superior** ¾ by orbiting 44° about `+Y`, which is how you get to look *into* an axial cut
  without rolling the head; B9 looks straight down the axial cut from preset `S`, where anterior is up
  by construction. Nothing in the film is upside-down, and nothing is inside a surface: the two
  interior shots (B4–B6, B9) are behind a real clip plane with real caps, not a camera pushed through
  a wall.

## Shot list

`t` is the start of each shot in the finished film; every one is a `tween` unless it says otherwise.

| t | Shot | What moves | Settings that matter |
|---|---|---|---|
| 0:00.0 | **A1** the anatomy | eased zoom of all three panes, 0.62 → **0.30 mm/px** | `1x3-horizontal`, cursor on the insula, `gray`, scale bar + crosshair on. 0.30 mm/px is what fills a 640 × 1080 pane with a 180 mm head. |
| 0:02.5 | **A2** the field arrives | the TI layer's `opacity` 0 → **0.92** | `hot`, heat scale p90 / p99 / p99.9, `threshold.lo = p99.9`, colour bar on. It fades in already thresholded to its own top 0.1 %, so the first thing visible is the focus. |
| 0:05.2 | **A3** the threshold falls | `threshold.lo` p99.9 → **p90** | The field *grows out of* its hottest core instead of appearing whole. One number moving, which is what a threshold slider does. |
| 0:07.5 | **A4** the atlas | the label layer's `opacity` 0 → **0.34** | `labelMode: "both"` — filled low **and** outlined at 2 px — `visibleLabels` restricted to the 41 intracranial ids, because `Background` and `Skin` filled at 34 % is a wash over the whole pane and not an atlas. |
| 0:09.8 | **A5** the insula | atlas → outline at 0.9; axial and coronal zoom to **0.13 mm/px**, panned onto the target | `visibleLabels: [3, 12]`, `labelColors`: `3` white, `12` cyan. The sagittal pane deliberately stays wide, so there is always one frame of context. |
| 0:12.3 | **A6** sweep up | cursor z **2 → 34 mm** | A cursor tween, not a `sweep` action: a `sweep` captures the pane it steps, and this shot has to stay in the three-plane grid so the crosshair can be seen tracking in the other two panes. |
| 0:16.0 | **A7** sweep down | cursor z **34 → 2 mm** | Back through the same stack, so the eye gets the volume twice. |
| 0:19.7 | **A8** settle | axial widens to 0.19, coronal tightens to **0.115 mm/px** | The cursor has been placed at y = 12 mm, behind the insula, ready for the coronal run. |
| 0:21.0 | **A9** one coronal | cursor y **12 → 52 mm** | Superior up throughout. The axial pane's slice does not move — only its crosshair — which is the cursor-sync claim, visible. |
| 0:24.3 | **A10** back out | all three panes to 0.30 mm/px, pan to centre | Ends where A1 ended, which is the cut point into Act 2. |
| 0:26.3 | **B1** fly in | camera distance **760 → 440 mm**, target → (0, 18, 4) | `3d-only`, camera preset `L`. Volumes hidden, `L_Insula_TI.msh` opaque by tag, colours from `ernie.msh.opt`. |
| 0:28.8 | **B2** transparency | scalp 1 → **0.20**, compact and spongy bone → 0.42, CSF → 0.30, muscle → 0.25, eyes → 0.60, with a **−30° orbit about z** | Per **tissue tag**, not per layer, so one mesh is part glass and part solid; the brain underneath keeps its colour because the transparent sheets are drawn after the opaque ones and blended once. |
| 0:32.2 | **B3** the cut | clip plane offset **130 → −16.3** (an axial plane descending to the insula's z), with a **+44° orbit about y** to a left-superior ¾ | `clip.caps: true`, `capColorMode: "tag"`. The cut is not a hole: every clipped tetrahedron contributes an exact cap polygon, so the plane is closed and coloured by the tissue it passes through. |
| 0:35.5 | **B4** dolly in | distance 430 → **205 mm**, target → (0, 26, 14) | Aimed at the cap, not at the head's centre — otherwise the elements to be shown next are at the bottom of the frame. |
| 0:37.5 | **B5** edges up | `edgeWidthPx` **0.5 → 2.4**, `edges.caps: true` | The tetrahedra of the cap, one by one. Edges are screen-space width (§7.0.5), and they stay on through the move — `interacting` no longer drops them (task 5). |
| 0:39.2 | **B6** edges down | `edgeWidthPx` 2.4 → **0.8**, distance back to 430 | Down and out in one move, so the next shot starts framed. |
| 0:40.8 | **B7** the field on the cut | scalp **0.20 → 0.06** and bone 0.42 → 0.12, with a −26° orbit — the tissues dissolve off the field | `colorMode: "field"`, `TI_max` (element field), `jet`, flat shading, `capColorMode: "inherit"` — so the caps carry the field rather than the tissue, which is the whole reason to cut. The scale is fixed at 0…0.30 V/m and **not** tweened: the colour bar prints the number it is given, and a bar counting through `0.1379437096702…` for three seconds is a worse picture than a fixed one. |
| 0:43.8 | **B8** isolate | isolation `field.lo` **0.30 → 0.085 V/m**, +34° orbit, target drifting to the left hemisphere | `isolate: { tags: [2], field: { name: "TI_max", lo, hi }, combine: "all" }` — grey matter **and** above threshold. The cloud grows as the threshold falls. It is diffuse rather than a tidy focus, because that is what a TI field in grey matter is. The mask is over elements, not a new file: the field colouring and the caps keep working on what is left. |
| 0:47.2 | **B9** the E field as arrows | glyph length **0.2 → 8 mm**, +24° orbit about z | `ernie_TDCS_1_scalar.msh`, `E` (3 components over all 5,900,498 elements), `origins: "volume"` (one per tet), `everyNth: 30`, `onCutPlaneOnly` with a 4 mm slab, coloured by magnitude on `cool`. Clip flipped to keep the **inferior** part and camera preset `S`, so the cut is seen face-on from above. `scale.mode: "log"` above a 0.05 V/m floor: linear or p99-normalised, the scalp's 3.8 V/m rim makes every intracranial arrow sub-pixel. The legend line under the frame quotes the mapping. |
| 0:50.5 | **B10** the net | electrode radius **0.1 → 4 mm**, +26° orbit | The `.geo` view's 183 points as spheres on the scalp, labels off — 185 labels at once is a wall of text, and the panel is where you find one by name. |
| 0:52.8 | **B11** a bone isosurface | `iso3d.opacity` **0 → 1**, −30° orbit | The label volume's own 3D surface: `visibleLabels: [515, 516]` (cortical and cancellous bone) with `iso3d.enabled`, so the engine runs marching cubes per visible region at `label − 0.5` in the LUT's colour. It is stair-stepped because it is the real marching-cubes surface of a 1 mm label volume, and `smooth` is per-vertex shading rather than geometry smoothing. |
| 0:55.8 | **B12a** settle | camera target → (0, 16, 0) at distance 470 | The three preceding shots left the target where each of them needed it; without this the turntable would swing a head cropped at the neck. |
| 0:56.8 | **B12b** closing turntable | **360° about z in 210 frames** (`orbit`) | Back on the tissue mesh with scalp 0.22 and bone 0.45. The last frame stops one step short of the full turn, so the film loops without a repeated frame. Superior stays up for all 360°, because `z` is the superior axis in RAS and the camera started at preset `L`. |

## What is not in it, and why

* **No captions or titles.** The engine's overlay font draws the §8 chrome — orientation letters,
  corner block, colour bar, scale bar, convention badge — and there is no caption item in
  `Annotations`. Adding one would be a product feature (a control in the app, a field in the
  `ViewSpec`, a golden), not a video edit, and §8 forbids an automation-only path into the renderer.
  The storyboard above is the narration.
* **No `.annot` parcellation.** See *Where the left insula came from*.
* **No oblique slice and no measurement tool.** Both are real features (scenarios 14 and task 11) and
  both would have earned a shot; at 63 s the film was already at the top of the 60–90 s brief, and
  cutting an existing shot to fit them would have cost the through-line from anatomy to field to
  mesh.
* **`ernie.msh` itself never appears.** `L_Insula_TI.msh` is the same mesh; see *The scene*.

## Reproducing it

The render is deterministic given the same build, the same subject and the same GPU: every action is a
fixed number of frames at fixed parameters, nothing is sampled and nothing is timed. Frame counts and
pixel values are a function of the scene, not of the machine's speed. What is **not** guaranteed
identical across machines is the rasterisation itself — the two renderer classes §11 names produce
different pixels for the same scene — so the committed MP4 is a build artefact, not a golden.

The full run took **170 s** on an M2 Max (67 actions, 1,915 frames, 4.6 s of it loading 740 MB of mesh
and three volumes) and writes ~2.2 GB of PNG frames next to the MP4; only the MP4, the GIF, the job and
this page are committed. `TETRAVOX_JOB_TIMEOUT_MS` must still be raised from its 600 s default — a
slower machine or a cold page cache will pass it.
