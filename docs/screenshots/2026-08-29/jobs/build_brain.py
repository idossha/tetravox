#!/usr/bin/env python3
"""Builds the brain / ernie stills of `docs/screenshots/2026-08-29/` (Agent A's half).

Every job document is written to this directory with `${TETRAVOX_DATA}` /
`${TETRAVOX_TESTDATA}` paths — never absolute ones — so a single shot can be
reproduced with

    Tetravox --job jobs/<name>.json --out <hero|features|modalities>

Run with the app already built (`pnpm wasm && pnpm --filter @tetravox/app build`):

    export TETRAVOX_DATA=$PWD/data/ernie
    export TETRAVOX_TESTDATA=~/datasets/000/derivatives/SimNIBS/sub-ernie
    export TETRAVOX_APP="$PWD/node_modules/.bin/electron"
    export TETRAVOX_APP_ARGS="$PWD/packages/app"
    python3 docs/screenshots/2026-08-29/jobs/build_brain.py [name ...]

With no arguments it builds everything; with names it builds only those jobs.

The UI captures (`ui/`) are NOT here — they are window captures and come from
`packages/app/e2e/ui-tour-gallery.spec.ts`.
"""
import glob
import json
import os
import shlex
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SET_DIR = os.path.dirname(HERE)  # docs/screenshots/2026-08-29
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(SET_DIR)))

# ---------------------------------------------------------------------------
# Datasets — env-var paths only (the schema expands `${NAME}`); the public CT
# is in the repository, so it is relative to this job directory.
# ---------------------------------------------------------------------------
D = "${TETRAVOX_DATA}/m2m_ernie"
T1 = f"{D}/T1.nii.gz"
TISSUES = f"{D}/final_tissues.nii.gz"
LABELS = f"{D}/segmentation/labeling.nii.gz"
MESH = f"{D}/ernie.msh"
PIAL = f"{D}/surfaces/lh.pial.gii"
EEG = f"{D}/eeg_positions/GSN-HydroCel-185.geo"
TI_MESH = "${TETRAVOX_DATA}/Simulations/Thalamus/TI/mesh/Thalamus_TI.msh"
TI_GREY_MESH = "${TETRAVOX_DATA}/Simulations/Thalamus/TI/mesh/grey_Thalamus_TI.msh"
TI_NII = "${TETRAVOX_DATA}/Simulations/Thalamus/TI/niftis/grey_Thalamus_TI_subject_TI_max.nii.gz"

# The field's own percentiles, for `hero-field-on-mesh`.
#
# `ti-field-on-t1` reads p90/p97/p99.9 off `Stats.histogram`, which is taken over **every** voxel of
# the volume. `grey_Thalamus_TI_subject_TI_max.nii.gz` is masked to grey matter and 94.8 % of it is
# exactly zero, so that p90 is 0: the preset thresholds at nothing and paints the whole of the grey
# matter in the middle of a hot scale. The same is true of the mesh, whose field the job then
# overrode with no threshold at all — a flat red cortex.
#
# So the shot supplies the percentiles of the field *where the field exists*, which is what the
# preset means by "the field's own 90th percentile":
#
#   python3 -c "import nibabel,numpy as np; \
#     d=np.asanyarray(nibabel.load(NII).dataobj); v=d[d>0]; \
#     print([np.percentile(v,p) for p in (90,97,99.9)])"          -> 0.112 0.132 0.190
#
# and, for the mesh, the same three quantiles of the 1,340,029 `TI_max` element values carried by
# `grey_Thalamus_TI.msh` (the grey-matter half of `Thalamus_TI.msh`) -> 0.115 0.142 0.240.
TI_VOL_P = (0.1121, 0.1325, 0.1903)  # V/m
TI_MESH_P = (0.1151, 0.1421, 0.2399)  # V/m
BIG = 1e9  # JSON has no Infinity; `threshold.hi` only has to sit above the field's maximum


def heat(p):
    lo, mid, hi = p
    return {
        "scale": {
            "kind": "heat",
            "min": lo,
            "mid": mid,
            "max": hi,
            "truncate": False,
            "inverse": False,
            "negative": "hide",
        },
        "threshold": {"lo": lo, "hi": BIG, "symmetric": False, "mode": "hide", "softEdge": 0},
    }

TDCS = "${TETRAVOX_DATA}/Simulations/L_Insula/high_Frequency/mesh/ernie_TDCS_1_scalar.msh"

TD = "${TETRAVOX_TESTDATA}/m2m_ernie"
T2 = f"{TD}/T2_reg.nii.gz"
SEEG = f"{TD}/ernie_seeg.msh"
SEEG_POS = f"{TD}/ernie_seeg_views.pos"
WARP = f"{TD}/toMNI/Conform2MNI_nonl.nii.gz"
CT = "../../../../data/public/niivue-images/CT_Philips.nii.gz"

# The cursor of the user's reference capture, and a few landmarks.
CUR = [-0.5, 21.9, -14.5]
MIDBRAIN = [0, -18, 8]
HIPPO = [-26, -22, -16]
THAL = [-11, -19, 8]

# final_tissues tags (final_tissues_LUT.txt): 1 WM, 2 GM, 3 CSF, 4 bone, 5 scalp,
# 6 eyes, 7 compact bone, 8 spongy bone, 9 blood, 10 muscle.
# labeling ids (labeling_LUT.txt): 10/49 thalamus, 16 brain-stem, 17/53 hippocampus.

SKIP_IDS = {0, 517}  # 517 is `labeling`'s own opaque blue "Background"


def lut_ids(rel):
    """The ids a LUT names, minus the two that are not anatomy.

    `labeling_LUT.txt` gives id 517 ("Background") an opaque `0 168 255`, so a
    `fill` of the whole table floods the pane blue outside the head; id 0 is
    named by neither LUT and the engine gives it a palette colour. Listing the
    ids a shot wants in `visibleLabels` is what leaves the pane black.
    """
    path = os.path.join(os.environ["TETRAVOX_DATA"], rel)
    ids = []
    with open(path) as f:
        for line in f:
            head = line.split()
            if head and head[0].isdigit() and int(head[0]) not in SKIP_IDS:
                ids.append(int(head[0]))
    return sorted(set(ids))


LABEL_IDS = lut_ids("m2m_ernie/segmentation/labeling_LUT.txt")

GRID = dict(width=1400, height=1140)  # 2×2 of 700×570 panes
TALL = dict(width=560, height=1400)  # 1x3 is three stacked rows
ONE = dict(width=900, height=900)  # single pane
MM = 0.32  # fills a 700 px pane of a 2x2 grid with a 224 mm head
MM1 = 0.21  # fills a single 900 px pane with a 189 mm head
ZOOM = 0.13  # a 117 mm detail in a 900 px pane


def px(**kw):
    return kw


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------
def app_cmd():
    app = os.environ.get("TETRAVOX_APP")
    if not app:
        sys.exit("TETRAVOX_APP is unset (point it at electron or a packaged Tetravox)")
    return [app] + shlex.split(os.environ.get("TETRAVOX_APP_ARGS", ""))


ONLY = set(sys.argv[1:])
BUILT = []


def run(name, doc, out_sub):
    if ONLY and name not in ONLY:
        return
    path = os.path.join(HERE, f"{name}.json")
    with open(path, "w") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")
    out = os.path.join(SET_DIR, out_sub)
    os.makedirs(out, exist_ok=True)
    cmd = app_cmd() + ["--job", path, "--out", out, "--quiet"]
    print(f"[run] {name} -> {out_sub}/", flush=True)
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    res_path = os.path.join(out, "job-result.json")
    res = {}
    if os.path.exists(res_path):
        with open(res_path) as f:
            res = json.load(f)
        os.remove(res_path)
    if proc.returncode != 0 or not res.get("ok"):
        print(proc.stdout[-4000:], proc.stderr[-4000:], sep="\n")
        print("errors:", res.get("errors"))
        raise SystemExit(f"job {name} failed")
    for w in res.get("warnings", []):
        print(f"  [warn] {w}")
    files = [f for f in res.get("outputs", []) for f in f.get("files", [])]
    print(f"  [ok] {files}")
    BUILT.append((name, out_sub, files))


def job(files, preset="plain", actions=None, window=(1400, 1140)):
    return {
        "version": 1,
        "scene": {"files": files, "preset": preset},
        "window": {"width": window[0], "height": window[1]},
        "actions": actions or [],
    }


def s(**kw):
    kw["type"] = "set"
    return kw


def shot(out, **kw):
    kw["type"] = "screenshot"
    kw["out"] = out
    return kw


ANN_OFF = {"colorbar": False, "crosshair": False, "orientationLabels": True, "cornerInfo": True}

# ===========================================================================
# hero/
# ===========================================================================

# The user's reference recreated: final_tissues filled and opaque, 2×2, the head
# mesh's scalp alone in the 3D pane, crosshair on.
run(
    "hero-tissues",
    job(
        [TISSUES, MESH],
        actions=[
            s(layer="final_tissues.nii.gz", patch={"labelMode": "fill", "opacity": 1.0, "labelOpacity": {"0": 0}}),
            s(
                layer="ernie.msh",
                patch={
                    "tagStyle": {
                        str(t): {"visible": t == 5, "opacity": 1.0} for t in range(1, 13)
                    },
                    "contoursIn2D": False,
                    "fillIn2D": False,
                },
            ),
            s(layout="2x2", cursor=CUR),
            s(view="axial", mmPerPx=MM),
            s(view="coronal", mmPerPx=MM),
            s(view="sagittal", mmPerPx=MM),
            s(view="view3d", camera="A", distance=430),
            shot(
                "hero-tissues-2x2",
                view="grid",
                **GRID,
                include={"crosshair": True, "colorbar": False},
            ),
        ],
    ),
    "hero",
)

# T1 with the atlas as outline+fill at 0.35, and the pial surface in 3D.
run(
    "hero-t1-atlas",
    job(
        [T1, LABELS, PIAL],
        actions=[
            s(layer="labeling.nii.gz", patch={"labelMode": "both", "opacity": 0.35, "visibleLabels": LABEL_IDS}),
            s(layer="lh.pial.gii", patch={"contoursIn2D": False}),
            s(layout="2x2", cursor=MIDBRAIN),
            s(view="axial", mmPerPx=MM),
            s(view="coronal", mmPerPx=MM),
            s(view="sagittal", mmPerPx=MM),
            s(view="view3d", camera="L", distance=330),
            shot(
                "hero-t1-atlas-2x2",
                view="grid",
                **GRID,
                include={"crosshair": True, "colorbar": False},
            ),
        ],
    ),
    "hero",
)

# The TI field: the grey matter of the simulation mesh coloured by `TI_max` in 3D, the TI_max
# volume over the T1 in the 2D panes, colour bar on.
#
# Both the mesh field and the volume overlay are thresholded at the field's own p90 with the scale
# running p90 -> p97 -> p99.9 (`TI_MESH_P` above), which is what `ti-field-on-t1` does for a field
# that is not 95 % zeros.
#
# A mesh threshold DISCARDS its fragments rather than falling back to the tag colour
# (`packages/engine/src/shaders/mesh.ts`), so a single thresholded grey-matter surface is a brain
# with holes in it. The 3D pane is therefore two mesh layers: the whole grey-matter surface of
# `Thalamus_TI.msh` as a translucent neutral grey — the context the hotspot needs — and, inside it,
# `grey_Thalamus_TI.msh` coloured by its thresholded `TI_max`. The peak of a thalamic TI montage is
# deep, so an opaque cortex would hide the very thing the picture is about.
run(
    "hero-field-on-mesh",
    job(
        [T1, TI_NII, TI_MESH, TI_GREY_MESH],
        preset="ti-field-on-t1",
        actions=[
            s(layer="T1.nii.gz", patch={"showColorbar": False}),
            s(
                layer="grey_Thalamus_TI_subject_TI_max.nii.gz",
                patch={
                    # One colour bar for the shot, off the volume. The volume is the mesh field
                    # resampled onto the T1 grid, so one bar is true for both panes' worth of it;
                    # the volume's own p90/p97/p99.9 (0.112 / 0.132 / 0.190) agree with the mesh's
                    # to within 3 %.
                    "name": "TI_max (V/m)",
                    "colormap": "hot",
                    "opacity": 0.85,
                    "showColorbar": True,
                    **heat(TI_MESH_P),
                },
            ),
            # The context surface: grey matter only, nothing below the cerebellum (the tags carry
            # the brain stem all the way down the spinal cord, which in a lateral view is a long
            # stalk hanging out of the bottom of the pane), translucent so the deep field shows.
            s(
                layer="Thalamus_TI.msh",
                patch={
                    "colorMode": "solid",
                    "solidColor": [0.80, 0.79, 0.76, 1],
                    "opacity": 0.3,
                    "faceMode": "both",
                    "isolate": {
                        "tags": [2],
                        "box": {"min": [-120, -140, -58], "max": [120, 120, 120]},
                        "combine": "all",
                    },
                    "showColorbar": False,
                    "contoursIn2D": False,
                    "fillIn2D": False,
                },
            ),
            s(
                layer="grey_Thalamus_TI.msh",
                patch={
                    "colorMode": "field",
                    "field": {"source": "elm", "name": "TI_max", "component": "mag"},
                    "colormap": "hot",
                    "isolate": {
                        "box": {"min": [-120, -140, -58], "max": [120, 120, 120]},
                        "combine": "all",
                    },
                    "faceMode": "both",
                    "showColorbar": False,
                    "contoursIn2D": False,
                    "fillIn2D": False,
                    "opacity": 1.0,
                    **heat(TI_MESH_P),
                },
            ),
            s(layout="1+3", cursor=THAL),
            s(view="axial", mmPerPx=0.46),
            s(view="coronal", mmPerPx=0.46),
            s(view="sagittal", mmPerPx=0.46),
            s(view="view3d", camera="L", distance=460),
            # ~30 degrees off left-lateral toward anterior, so the surface has depth. `set`'s
            # `camera` only takes the six axis presets, so the oblique is a one-frame tween whose
            # end state the next action inherits (AUTOMATION.md 2.3: "a tween is a move").
            {
                "type": "tween",
                "out": "_camera-oblique",
                "frames": 1,
                "view": "view3d",
                "width": 64,
                "height": 64,
                "gif": False,
                "orbit": {"degrees": -30, "axis": "z"},
                "to": {"distance": 460},
            },
            shot(
                "hero-field-on-mesh",
                view="grid",
                **GRID,
                include={"crosshair": True, "colorbar": True},
            ),
        ],
    ),
    "hero",
)
for _f in glob.glob(os.path.join(SET_DIR, "hero", "_camera-oblique-*.png")):
    os.remove(_f)

# ===========================================================================
# modalities/ — brain and head CT
# ===========================================================================

run(
    "mod-brain-t1",
    job(
        [T1],
        actions=[
            s(cursor=MIDBRAIN, layout="1x1", view="axial", mmPerPx=MM1),
            shot("mod-brain-t1-axial", view="axial", **ONE, include=ANN_OFF),
            s(view="axial", mmPerPx=ZOOM, center=[-26, -22]),
            s(cursor=HIPPO),
            shot(
                "mod-brain-t1-axial-zoom",
                view="axial",
                **ONE,
                include={"colorbar": False, "crosshair": False, "scaleBar": True},
            ),
        ],
    ),
    "modalities",
)

run(
    "mod-brain-t2",
    job(
        [T2],
        actions=[
            # A `1x1` layout shows whichever view was last active and a job cannot
            # choose that, so the coronal pane is captured out of a 2x2.
            s(cursor=MIDBRAIN, layout="2x2", view="coronal", mmPerPx=MM1),
            shot("mod-brain-t2-coronal", view="coronal", **ONE, include=ANN_OFF),
        ],
    ),
    "modalities",
)

run(
    "mod-head-ct",
    job(
        [CT],
        actions=[
            s(cursor=[0, 10, 20], layout="1x1", view="axial", mmPerPx=0.20),
            s(layer=0, patch={"scale": {"kind": "linear", "lo": -20, "hi": 100}}),
            shot("mod-head-ct-axial", view="axial", **ONE, include=ANN_OFF),
            s(
                layer=0,
                patch={
                    "scale": {"kind": "linear", "lo": 150, "hi": 1500},
                    "colormap": "bone",
                    "showIn3D": True,
                },
            ),
            s(layout="3d-only"),
            s(view="view3d", camera="A", distance=480),
            shot(
                "mod-head-ct-bone-3d",
                view="view3d",
                **ONE,
                include={"colorbar": False, "crosshair": False},
            ),
        ],
    ),
    "modalities",
)

# ===========================================================================
# features/ — the panes
# ===========================================================================

# Each layout gives its panes a different size, so the zoom and the 3D camera
# distance are set per layout rather than once: a fixed mmPerPx that fills a
# 700 px pane crops a 460 px one and leaves margins in a 940 px one.
def zoom2d(mm):
    return [s(view=v, mmPerPx=mm) for v in ("axial", "coronal", "sagittal")]


layout_actions = [
    s(layer="T1.nii.gz", patch={"showColorbar": False}),
    s(layer="labeling.nii.gz", patch={"labelMode": "outline", "opacity": 0.9}),
    s(layer="T1.nii.gz", patch={"showIn3D": True}),
    s(cursor=MIDBRAIN),
    s(view="view3d", camera="L"),
    s(layout="1x1"),
    *zoom2d(MM1),
    shot("feat-layouts-1x1", view="grid", **px(width=900, height=900), include={"crosshair": True}),
    s(layout="1x3"),
    *zoom2d(0.34),
    shot("feat-layouts-1x3", view="grid", **TALL, include={"crosshair": True}),
    s(layout="2x2"),
    *zoom2d(MM),
    s(view="view3d", distance=430),
    shot("feat-layouts-2x2", view="grid", **GRID, include={"crosshair": True}),
    s(layout="1+3"),
    *zoom2d(0.46),
    s(view="view3d", distance=520),
    shot("feat-layouts-1plus3", view="grid", **GRID, include={"crosshair": True}),
    s(layout="3d+1"),
    *zoom2d(0.28),
    s(view="view3d", distance=520),
    shot("feat-layouts-3dplus1", view="grid", **GRID, include={"crosshair": True}),
    # zoom pair — the same axial slice, wide and close
    s(layout="1x1"),
    s(view="axial", mmPerPx=MM1, center=[0, 0]),
    shot("feat-zoom-overview", view="axial", **ONE, include={"crosshair": True}),
    s(view="axial", mmPerPx=ZOOM, center=[-26, -22]),
    s(cursor=HIPPO),
    shot(
        "feat-zoom-detail",
        view="axial",
        **ONE,
        include={"crosshair": False, "scaleBar": True, "colorbar": False},
    ),
    # convention pair
    s(view="axial", mmPerPx=MM1, center=[0, 0]),
    s(cursor=MIDBRAIN, radiological=False),
    shot("feat-convention-neu", view="axial", **ONE, include={"crosshair": True}),
    s(radiological=True),
    shot("feat-convention-rad", view="axial", **ONE, include={"crosshair": True}),
    s(radiological=False),
]
run("feat-panes", job([T1, LABELS], actions=layout_actions), "features")

# window / level and colormaps — T1 alone
run(
    "feat-window-colormap",
    job(
        [T1],
        actions=[
            s(cursor=MIDBRAIN, layout="1x1", view="axial", mmPerPx=MM1),
            s(layer=0, patch={"scale": {"kind": "linear", "lo": 0, "hi": 65535}}),
            shot("feat-window-minmax", view="axial", **ONE, include=ANN_OFF),
            s(layer=0, patch={"scale": {"kind": "linear", "lo": 900, "hi": 15000}}),
            shot("feat-window-p2-98", view="axial", **ONE, include=ANN_OFF),
            s(
                layer=0,
                patch={
                    "scale": {"kind": "linear", "lo": 900, "hi": 15000},
                    "colormap": "hot",
                    "showColorbar": True,
                },
            ),
            shot("feat-colormap-hot", view="axial", **ONE, include={"colorbar": True}),
            s(layer=0, patch={"colormap": "viridis"}),
            shot("feat-colormap-viridis", view="axial", **ONE, include={"colorbar": True}),
        ],
    ),
    "features",
)

# the field over the T1, thresholded at its own p90 (the preset's whole point)
run(
    "feat-threshold-field",
    job(
        [T1, TI_NII],
        preset="ti-field-on-t1",
        actions=[
            s(layer="T1.nii.gz", patch={"showColorbar": False}),
            s(cursor=THAL, layout="1x1", view="axial", mmPerPx=MM1),
            shot(
                "feat-threshold-field-on-t1",
                view="axial",
                **ONE,
                include={"colorbar": True, "crosshair": False},
            ),
        ],
    ),
    "features",
)

# ---------------------------------------------------------------------------
# atlases & regions
# ---------------------------------------------------------------------------
run(
    "feat-labels",
    job(
        [T1, LABELS],
        actions=[
            s(cursor=MIDBRAIN, layout="1x1", view="axial", mmPerPx=MM1),
            s(layer="labeling.nii.gz", patch={"labelMode": "fill", "opacity": 0.75, "visibleLabels": LABEL_IDS}),
            shot("feat-labels-fill", view="axial", **ONE, include=ANN_OFF),
            s(layer="labeling.nii.gz", patch={"labelMode": "outline", "opacity": 1.0, "visibleLabels": LABEL_IDS}),
            shot("feat-labels-outline", view="axial", **ONE, include=ANN_OFF),
            s(layer="labeling.nii.gz", patch={"labelMode": "both", "opacity": 0.6, "visibleLabels": LABEL_IDS}),
            shot("feat-labels-both", view="axial", **ONE, include=ANN_OFF),
            s(cursor=[-11, -19, 16]),
            s(
                layer="labeling.nii.gz",
                patch={"labelMode": "fill", "opacity": 1.0, "visibleLabels": [10, 49]},
            ),
            shot("feat-labels-solo-thalamus", view="axial", **ONE, include=ANN_OFF),
            # one region as a 3D surface, over the T1's own slice planes
            s(
                layer="labeling.nii.gz",
                patch={
                    "visibleLabels": [16],
                    "showIn3D": True,
                    "iso3d": {
                        "enabled": True,
                        "iso": 0,
                        "color": [0.47, 0.62, 0.69, 1],
                        "opacity": 1.0,
                        "smooth": True,
                        "faceMode": "both",
                    },
                },
            ),
            s(layer="T1.nii.gz", patch={"showIn3D": True}),
            s(cursor=[0, -28, -24], layout="3d-only"),
            s(view="view3d", camera="L", distance=420),
            shot(
                "feat-labels-iso-brainstem",
                view="view3d",
                **ONE,
                include={"colorbar": False, "crosshair": False},
            ),
        ],
    ),
    "features",
)

# ---------------------------------------------------------------------------
# meshes
# ---------------------------------------------------------------------------
TAGS_ALL = {str(t): {"visible": True, "opacity": 1.0} for t in range(1, 13)}
run(
    "feat-mesh",
    job(
        [MESH],
        actions=[
            s(cursor=MIDBRAIN, layout="1x1", view="axial", mmPerPx=MM1),
            s(layer="ernie.msh", patch={"contoursIn2D": True, "fillIn2D": True}),
            shot("feat-mesh-cut-2d", view="axial", **ONE, include={"crosshair": True}),
            s(layer="ernie.msh", patch={"contoursIn2D": False, "fillIn2D": False}),
            s(layer="ernie.msh", patch={"tagStyle": TAGS_ALL}),
            s(layout="3d-only"),
            s(view="view3d", camera="L", distance=520),
            shot("feat-mesh-tissues-3d", view="view3d", **ONE, include={"colorbar": False}),
            s(
                layer="ernie.msh",
                patch={
                    "clip": {
                        "planes": [
                            {"plane": {"normal": [-1, 0, 0], "offset": 0}, "enabled": True}
                        ],
                        "caps": True,
                        "capColorMode": "tag",
                    }
                },
            ),
            s(camera="R", distance=520),
            shot("feat-mesh-clip-caps", view="view3d", **ONE, include={"colorbar": False}),
            s(layer="ernie.msh", patch={"clip": {"planes": [], "caps": True, "capColorMode": "tag"}}),
            s(layer="ernie.msh", patch={"isolate": {"tags": [1, 2], "combine": "all"}}),
            s(camera="L", distance=400),
            shot("feat-mesh-isolate-brain", view="view3d", **ONE, include={"colorbar": False}),
            s(layer="ernie.msh", patch={"isolate": None}),
        ],
    ),
    "features",
)

run(
    "feat-mesh-translucent",
    job(
        [MESH],
        preset="mesh-tissues-translucent",
        actions=[
            s(layout="3d-only"),
            s(view="view3d", camera="L", distance=520),
            shot("feat-mesh-translucent", view="view3d", **ONE, include={"colorbar": False}),
        ],
    ),
    "features",
)

# the TDCS mesh: the field on grey matter, per-tissue paint, and glyphs
FIELD = {"source": "elm", "name": "E", "component": "mag"}
run(
    "feat-mesh-field",
    job(
        [TDCS],
        actions=[
            s(
                layer="ernie_TDCS_1_scalar.msh",
                patch={
                    "colorMode": "field",
                    "field": FIELD,
                    "colormap": "hot",
                    "scale": {"kind": "linear", "lo": 0.0, "hi": 0.12},
                    "threshold": {"lo": 0, "hi": 0, "symmetric": False, "mode": "clamp", "softEdge": 0},
                    "showColorbar": True,
                    "isolate": {"tags": [2], "combine": "all"},
                },
            ),
            s(layout="3d-only"),
            s(view="view3d", camera="L", distance=400),
            shot(
                "feat-mesh-field-tdcs-3d",
                view="view3d",
                **ONE,
                include={"colorbar": True, "crosshair": False},
            ),
            # per-tissue paint: the field on the grey matter, the white matter in
            # its own tissue colour, on one sagittal cut — one mesh, two colour sources.
            s(
                layer="ernie_TDCS_1_scalar.msh",
                patch={
                    "isolate": {"tags": [1, 2], "combine": "all"},
                    "colorMode": "tag",
                    "tagStyle": {
                        "2": {"visible": True, "opacity": 1.0, "colorMode": "field"},
                        "1": {"visible": True, "opacity": 1.0, "colorMode": "color"},
                    },
                    "clip": {
                        "planes": [
                            {"plane": {"normal": [-1, 0, 0], "offset": 0}, "enabled": True}
                        ],
                        "caps": True,
                        "capColorMode": "inherit",
                    },
                },
            ),
            s(camera="R", distance=400),
            shot(
                "feat-mesh-per-tissue-paint",
                view="view3d",
                **ONE,
                include={"colorbar": True, "crosshair": False},
            ),
            # glyphs
            s(
                layer="ernie_TDCS_1_scalar.msh",
                patch={
                    "isolate": None,
                    "clip": {"planes": [], "caps": True, "capColorMode": "inherit"},
                    "colorMode": "tag",
                    "opacity": 0.12,
                    "tagStyle": TAGS_ALL,
                    "glyphs": {
                        "field": {"source": "elm", "name": "E"},
                        "shape": "arrow",
                        "subsample": {"everyNth": 400},
                        "scale": {
                            "mode": "log",
                            "lengthMm": 8.0,
                            "normalizeTo": 1.0,
                            "logFloor": 0.05,
                        },
                        "lengthMm": 8.0,
                        "colorBy": "magnitude",
                        "color": [1, 1, 1, 1],
                        "clipToCutPlane": False,
                    },
                },
            ),
            shot(
                "feat-glyphs-arrows",
                view="view3d",
                **ONE,
                include={"colorbar": True, "crosshair": False},
            ),
            s(
                layer="ernie_TDCS_1_scalar.msh",
                patch={
                    "glyphs": {
                        "field": {"source": "elm", "name": "E"},
                        "shape": "line",
                        "subsample": {"everyNth": 400},
                        "scale": {
                            "mode": "log",
                            "lengthMm": 8.0,
                            "normalizeTo": 1.0,
                            "logFloor": 0.05,
                        },
                        "lengthMm": 8.0,
                        "colorBy": "magnitude",
                        "color": [1, 1, 1, 1],
                        "clipToCutPlane": False,
                    }
                },
            ),
            shot(
                "feat-glyphs-lines",
                view="view3d",
                **ONE,
                include={"colorbar": True, "crosshair": False},
            ),
        ],
    ),
    "features",
)

# surfaces
run(
    "feat-surfaces",
    job(
        [T1, PIAL],
        actions=[
            s(layout="3d-only"),
            s(view="view3d", camera="L", distance=420),
            shot("feat-surface-pial-3d", view="view3d", **ONE, include={"colorbar": False}),
            s(layer="lh.pial.gii", patch={"contoursIn2D": True, "contourWidthPx": 2}),
            s(layout="2x2", cursor=MIDBRAIN),
            s(view="axial", mmPerPx=MM),
            s(view="coronal", mmPerPx=MM),
            s(view="sagittal", mmPerPx=MM),
            shot(
                "feat-surface-contours-2x2",
                view="grid",
                **GRID,
                include={"crosshair": True, "colorbar": False},
            ),
        ],
    ),
    "features",
)

# points — EEG electrodes and sEEG contacts
run(
    "feat-points-eeg",
    job(
        [T1, EEG],
        actions=[
            s(layer="T1.nii.gz", patch={"showIn3D": True}),
            s(layout="3d-only"),
            s(view="view3d", camera="S", distance=460),
            shot("feat-points-eeg-3d", view="view3d", **ONE, include={"colorbar": False}),
        ],
    ),
    "features",
)

run(
    "feat-seeg",
    job(
        [T1, SEEG, SEEG_POS],
        preset="mesh-tissues-translucent",
        actions=[
            s(layer="T1.nii.gz", patch={"showColorbar": False}),
            s(layer="ernie_seeg.msh", patch={"contoursIn2D": False, "fillIn2D": False}),
            s(cursor=[40, 8, -1], layout="1x1", view="axial", mmPerPx=MM1),
            shot("feat-seeg-contacts-axial", view="axial", **ONE, include={"crosshair": True}),
            s(layout="3d-only"),
            s(view="view3d", camera="R", distance=520),
            shot("feat-seeg-mesh-3d", view="view3d", **ONE, include={"colorbar": False}),
        ],
    ),
    "features",
)

# the publication figure export: white page, A/B/C/D, 300 dpi
run(
    "feat-figure-export",
    job(
        [T1, LABELS],
        actions=[
            s(layer="labeling.nii.gz", patch={"labelMode": "outline", "opacity": 1.0}),
            s(layer="T1.nii.gz", patch={"showIn3D": True}),
            s(layout="2x2", cursor=MIDBRAIN),
            s(view="axial", mmPerPx=MM),
            s(view="coronal", mmPerPx=MM),
            s(view="sagittal", mmPerPx=MM),
            s(view="view3d", camera="L", distance=430),
            # `view: "figure"` (the labelled multi-panel page) is documented in
            # docs/AUTOMATION.md but is not in this build's job schema, so the
            # publication example is the same 2x2 on a white page at 300 dpi.
            shot(
                "feat-figure-export-2x2",
                view="grid",
                width=2008,
                height=1634,
                dpi=300,
                background="white",
                autoTrim=True,
                include={
                    "crosshair": False,
                    "cornerInfo": False,
                    "colorbar": False,
                    "orientationLabels": False,
                },
            ),
        ],
    ),
    "features",
)

print("\n=== BUILT ===")
for name, sub, files in BUILT:
    print(f"{name:24s} {sub}/ {files}")
