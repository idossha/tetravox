#!/usr/bin/env python3
"""Builds the brain / ernie stills of `docs/screenshots/2026-08-29/` — `brain/`, `hero/`, `features/`.

Every job document is written to this directory with `${TETRAVOX_DATA}` /
`${TETRAVOX_TESTDATA}` paths — never absolute ones — so a single shot can be
reproduced with

    Tetravox --job jobs/<name>.json --out <brain|hero|features>

Run with the app already built (`pnpm wasm && pnpm --filter @tetravox/app build`):

    export TETRAVOX_DATA=$PWD/data/ernie
    export TETRAVOX_TESTDATA=~/datasets/000/derivatives/SimNIBS/sub-ernie
    export TETRAVOX_APP="$PWD/node_modules/.bin/electron"
    export TETRAVOX_APP_ARGS="$PWD/packages/app"
    python3 docs/screenshots/2026-08-29/jobs/build_brain.py [name ...]

With no arguments it builds everything; with names it builds only those jobs.
`TETRAVOX_SHOT_OUT=<dir>` renders into `<dir>/<group>/` instead of the set, which
is how a job is checked against a plate without overwriting it.

The `brain/` group reproduces the plates captured by hand in the app on
2026-08-29 (2×2 layout, chrome hidden, crosshair and colour bar on, 2344×1904 —
a 1172×952 window at 2×). The cursor of each is the one its corner info shows;
the framing and camera are chosen to match the plate, not read off it, so a
rebuild is the same scene and not a pixel-identical picture.

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
OUT_ROOT = os.environ.get("TETRAVOX_SHOT_OUT") or SET_DIR

# ---------------------------------------------------------------------------
# Datasets — env-var paths only (the schema expands `${NAME}`).
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
TDCS = "${TETRAVOX_DATA}/Simulations/L_Insula/high_Frequency/mesh/ernie_TDCS_1_scalar.msh"

# The full SimNIBS subject: `data/ernie` carries only the left pial surface.
TD = "${TETRAVOX_TESTDATA}/m2m_ernie"
PIAL_L = f"{TD}/surfaces/lh.pial.gii"
PIAL_R = f"{TD}/surfaces/rh.pial.gii"

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


def linear(lo, hi):
    """A plain linear scale with the threshold parked below the data — nothing hidden."""
    return {
        "scale": {"kind": "linear", "lo": lo, "hi": hi},
        "threshold": {"lo": -BIG, "hi": BIG, "symmetric": False, "mode": "clamp", "softEdge": 0},
    }


# Landmarks (world RAS mm).
MIDBRAIN = [0, -18, 8]
THAL = [-11, -19, 8]

# final_tissues tags (final_tissues_LUT.txt): 1 WM, 2 GM, 3 CSF, 4 bone, 5 scalp,
# 6 eyes, 7 compact bone, 8 spongy bone, 9 blood, 10 muscle.
# labeling ids (labeling_LUT.txt): 10/49 thalamus, 16 brain-stem, 17/53 hippocampus.
# ernie.msh / ernie_TDCS_1_scalar.msh tet tags are 1 WM, 2 GM, 3 CSF, 5 scalp, 6 eyes,
# 7 compact bone, 8 spongy bone, 9 blood, 10 muscle, and the tissue SURFACES are 1000 + tag.
# `tagStyle` is keyed by the surface tag — a style on `"5"` changes nothing on screen.
WM, GM, CSF, SCALP, EYES, COMPACT, SPONGY, BLOOD, MUSCLE = (
    1001, 1002, 1003, 1005, 1006, 1007, 1008, 1009, 1010,
)

GRID = dict(width=1400, height=1140)  # 2×2 of 700×570 panes
PLATE = dict(width=2344, height=1904, background="black")  # the plates' size (same 1.23 aspect as GRID) and canvas
ONE = dict(width=900, height=900)  # single pane
MM = 0.32  # fills a 700 px pane of a 2x2 grid with a 224 mm head
PMM = 0.30  # the plates were taken a notch closer
# The window the plates were taken in, off their colour bar; the T1's min-max is -0.8..20354.
T1_WINDOW = {"scale": {"kind": "linear", "lo": 889, "hi": 19896}}
GREEN = [0.45, 0.85, 0.35, 1]
YELLOW = [0.95, 0.85, 0.2, 1]


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
    out = os.path.join(OUT_ROOT, out_sub)
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
    # A one-frame camera tween writes a throwaway frame beside the plate.
    for stray in glob.glob(os.path.join(out, "_*-[0-9][0-9][0-9][0-9].png")):
        os.remove(stray)
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


def zoom2d(mm, center=None):
    """The same zoom (and pan) in all three slice panes."""
    out = []
    for v in ("axial", "coronal", "sagittal"):
        a = s(view=v, mmPerPx=mm)
        if center is not None:
            a["center"] = list(center)
        out.append(a)
    return out


def oblique(degrees, distance):
    """Turn the 3D camera `degrees` about the superior axis from the preset it is on.

    `set`'s `camera` only takes the six axis presets, so an oblique is a one-frame tween whose end
    state the next action inherits (AUTOMATION.md 2.3: "a tween is a move").
    """
    return {
        "type": "tween",
        "out": "_camera-oblique",
        "frames": 1,
        "view": "view3d",
        "width": 64,
        "height": 64,
        "gif": False,
        "orbit": {"degrees": degrees, "axis": "z"},
        "to": {"distance": distance},
    }


PLATE_INCLUDE = {"crosshair": True, "colorbar": True, "cornerInfo": True, "orientationLabels": True}

# ===========================================================================
# brain/ — the hand-captured plates, as jobs
# ===========================================================================

# 1. The T1 alone, four panes, the three planes standing in the 3D pane.
run(
    "brain-t1",
    job(
        [T1],
        actions=[
            s(layer="T1.nii.gz", patch={"showIn3D": True, "showColorbar": True, **T1_WINDOW}),
            s(layout="2x2", cursor=[19.3, 15.5, 14.8]),
            *zoom2d(PMM),
            s(view="view3d", camera="A", distance=430),
            shot("brain-t1-2x2", view="grid", **PLATE, include=PLATE_INCLUDE),
        ],
    ),
    "brain",
)

# 2. The left pial surface: a contour on every slice it crosses, the surface in 3D.
run(
    "brain-t1-pial-left",
    job(
        [T1, PIAL],
        actions=[
            s(layer="T1.nii.gz", patch={"showIn3D": True, "showColorbar": True, **T1_WINDOW}),
            s(layer="lh.pial.gii", patch={"contoursIn2D": True, "contourWidthPx": 3, "contourColor": GREEN}),
            s(layout="2x2", cursor=[-29.0, -3.7, 14.8]),
            *zoom2d(PMM),
            s(view="view3d", camera="L", distance=400),
            oblique(-35, 400),
            shot("brain-t1-pial-left", view="grid", **PLATE, include=PLATE_INCLUDE),
        ],
    ),
    "brain",
)

# 3. Both pial surfaces — the right one is only in the full subject (`${TETRAVOX_TESTDATA}`).
run(
    "brain-t1-pial-both",
    job(
        [T1, PIAL_L, PIAL_R],
        actions=[
            s(layer="T1.nii.gz", patch={"showIn3D": True, "showColorbar": True, **T1_WINDOW}),
            s(layer="lh.pial.gii", patch={"contoursIn2D": True, "contourWidthPx": 3, "contourColor": GREEN}),
            s(layer="rh.pial.gii", patch={"contoursIn2D": True, "contourWidthPx": 3, "contourColor": YELLOW}),
            s(layout="2x2", cursor=[47.6, 40.8, 0.7]),
            *zoom2d(PMM),
            s(view="view3d", camera="A", distance=400),
            shot("brain-t1-pial-both", view="grid", **PLATE, include=PLATE_INCLUDE),
        ],
    ),
    "brain",
)

# 4. The thalamus soloed out of the atlas, and as a surface between the planes, close up.
run(
    "brain-t1-thalamus",
    job(
        [T1, LABELS],
        actions=[
            s(layer="T1.nii.gz", patch={"showIn3D": True, "showColorbar": True, **T1_WINDOW}),
            s(
                layer="labeling.nii.gz",
                patch={
                    "labelMode": "fill",
                    "opacity": 1.0,
                    "visibleLabels": [10, 49],
                    "showIn3D": True,
                    "iso3d": {
                        "enabled": True,
                        "iso": 0,
                        "color": [0, 0.46, 0.05, 1],
                        "opacity": 1.0,
                        "smooth": True,
                        "faceMode": "both",
                    },
                },
            ),
            s(layout="2x2", cursor=[11.1, 10.4, 17.4]),
            *zoom2d(PMM),
            s(view="view3d", camera="A", distance=220),
            # `set` cannot move the camera's target, so the aim is a one-frame tween.
            {
                "type": "tween",
                "out": "_camera-oblique",
                "frames": 1,
                "view": "view3d",
                "width": 64,
                "height": 64,
                "gif": False,
                "orbit": {"degrees": 35, "axis": "z"},
                "to": {"target": [11.1, 10.4, 17.4], "distance": 220},
            },
            shot("brain-t1-thalamus", view="grid", **PLATE, include=PLATE_INCLUDE),
        ],
    ),
    "brain",
)

# 5. The HydroCel net: labelled spheres on the slices they touch, the whole net in 3D.
run(
    "brain-t1-eeg",
    job(
        [T1, EEG],
        actions=[
            s(layer="T1.nii.gz", patch={"showIn3D": True, "showColorbar": True, **T1_WINDOW}),
            s(layout="2x2", cursor=[19.3, 15.5, 14.8]),
            *zoom2d(PMM),
            s(view="view3d", camera="L", distance=430),
            shot("brain-t1-eeg", view="grid", **PLATE, include=PLATE_INCLUDE),
        ],
    ),
    "brain",
)

# 6. The head mesh alone: its tissue cross-section filled and outlined in the slice panes, and
#    the scalp — every tissue opaque, so the outer surface is all the 3D pane shows.
run(
    "brain-tissues",
    job(
        [MESH],
        actions=[
            s(
                layer="ernie.msh",
                patch={
                    "tagStyle": {str(t): {"visible": True, "opacity": 1.0} for t in range(1001, 1013)},
                    "contoursIn2D": True,
                    "contourWidthPx": 1,
                    "contourColor": [0, 0, 0, 1],
                    "fillIn2D": True,
                },
            ),
            s(layout="2x2", cursor=[-0.5, 21.9, -14.5]),
            *zoom2d(PMM),
            s(view="view3d", camera="A", distance=430),
            oblique(-30, 430),
            shot("brain-tissues-2x2", view="grid", **PLATE, include={**PLATE_INCLUDE, "colorbar": False}),
        ],
    ),
    "brain",
)

# 7. The skull through a translucent scalp, one 3D pane, anterior-oblique.
run(
    "brain-mesh-skull",
    job(
        [MESH],
        preset="mesh-tissues-translucent",
        actions=[
            s(
                layer="ernie.msh",
                patch={
                    "tagStyle": {
                        str(SCALP): {"visible": True, "opacity": 0.3},
                        str(COMPACT): {"visible": True, "opacity": 1.0},
                        str(SPONGY): {"visible": True, "opacity": 1.0},
                        str(WM): {"visible": False, "opacity": 1.0},
                        str(GM): {"visible": False, "opacity": 1.0},
                        str(CSF): {"visible": False, "opacity": 1.0},
                    },
                },
            ),
            s(layout="3d-only"),
            s(view="view3d", camera="A", distance=400),
            oblique(-30, 400),
            shot("brain-mesh-skull-3d", view="view3d", **PLATE, include={"colorbar": False, "crosshair": False}),
        ],
    ),
    "brain",
)

# 8. |E| of the tDCS simulation on every tissue: the cuts filled by the field with the tissue
#    boundaries outlined, and the scalp in 3D with the two electrodes as the hot spots.
MAGNE = {"source": "elm", "name": "magnE", "component": "mag"}
run(
    "brain-mesh-tdcs-magne",
    job(
        [TDCS],
        actions=[
            s(
                layer="ernie_TDCS_1_scalar.msh",
                patch={
                    "colorMode": "field",
                    "field": MAGNE,
                    "colormap": "jet",
                    **linear(0.0, 1.0),
                    "showColorbar": True,
                    "fillIn2D": True,
                    "contoursIn2D": True,
                    "contourWidthPx": 1,
                    "contourColor": [0, 0, 0, 1],
                },
            ),
            s(layout="2x2", cursor=[-0.5, 35.9, 33.8]),
            *zoom2d(PMM),
            s(view="view3d", camera="A", distance=430),
            shot("brain-mesh-tdcs-magne-2x2", view="grid", **PLATE, include=PLATE_INCLUDE),
        ],
    ),
    "brain",
)

# 9. TI_max on the grey-matter mesh, jet 0.01 → 0.2 V/m, cut by the slices in 2D and whole in 3D.
run(
    "brain-mesh-ti-max",
    job(
        [TI_GREY_MESH],
        actions=[
            s(
                layer="grey_Thalamus_TI.msh",
                patch={
                    "colorMode": "field",
                    "field": {"source": "elm", "name": "TI_max", "component": "mag"},
                    "colormap": "jet",
                    **linear(0.01, 0.2),
                    "showColorbar": True,
                    "fillIn2D": True,
                    "contoursIn2D": False,
                    "faceMode": "both",
                },
            ),
            s(layout="2x2", cursor=[3.8, 19.0, 18.0]),
            *zoom2d(PMM),
            s(view="view3d", camera="L", distance=330),
            shot("brain-mesh-ti-max-2x2", view="grid", **PLATE, include=PLATE_INCLUDE),
        ],
    ),
    "brain",
)

# 10 / 11. The E vector field as arrows: coloured by magnitude, log-scaled in length so the
#          electrode peak does not swamp the brain (6 mm at the p99 of |E|), over a translucent scalp.
GLYPHS = {
    "field": {"source": "elm", "name": "E"},
    "shape": "arrow",
    "subsample": {"everyNth": 120},
    "scale": {"mode": "log", "lengthMm": 6.0, "normalizeTo": "p99", "logFloor": 0.026},
    "lengthMm": 6.0,
    "colorBy": "magnitude",
    "color": [1, 1, 1, 1],
    "clipToCutPlane": False,
    "origins": "volume",
}
GLYPH_TISSUES = {
    str(SCALP): {"visible": True, "opacity": 0.3},
    str(COMPACT): {"visible": False, "opacity": 1.0},
    str(SPONGY): {"visible": False, "opacity": 1.0},
    str(CSF): {"visible": False, "opacity": 1.0},
    "1099": {"visible": False, "opacity": 1.0},  # the simulation mesh's extra interface surface
    str(EYES): {"visible": False, "opacity": 1.0},
    str(MUSCLE): {"visible": False, "opacity": 1.0},
    str(GM): {"visible": True, "opacity": 0.25},
    str(WM): {"visible": True, "opacity": 0.25},
}
run(
    "brain-mesh-e-glyphs",
    job(
        [TDCS],
        preset="mesh-tissues-translucent",
        actions=[
            s(
                layer="ernie_TDCS_1_scalar.msh",
                patch={
                    "colorMode": "tag",
                    "colormap": "jet",
                    "tagStyle": GLYPH_TISSUES,
                    "faceMode": "both",
                    "fillIn2D": True,
                    "contoursIn2D": False,
                    "glyphs": GLYPHS,
                    "showColorbar": True,
                },
            ),
            s(layout="2x2", cursor=[-0.5, 13.5, 20.5]),
            *zoom2d(PMM),
            s(view="view3d", camera="L", distance=430),
            shot("brain-mesh-e-glyphs-2x2", view="grid", **PLATE, include=PLATE_INCLUDE),
            s(layout="3d-only"),
            s(view="view3d", camera="L", distance=380),
            shot(
                "brain-mesh-e-glyphs-3d",
                view="view3d",
                **PLATE,
                include={"colorbar": True, "crosshair": False},
            ),
        ],
    ),
    "brain",
)

# ===========================================================================
# hero/
# ===========================================================================

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
            *zoom2d(0.46),
            s(view="view3d", camera="L", distance=460),
            # ~30 degrees off left-lateral toward anterior, so the surface has depth.
            oblique(-30, 460),
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

# ===========================================================================
# features/
# ===========================================================================

# one region as a 3D surface, over the T1's own slice planes
run(
    "feat-labels",
    job(
        [T1, LABELS],
        actions=[
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

# per-tissue paint: the field on the grey matter, the white matter in its own tissue colour, on
# one sagittal cut — one mesh, two colour sources.
FIELD = {"source": "elm", "name": "E", "component": "mag"}
run(
    "feat-mesh-field",
    job(
        [TDCS],
        actions=[
            s(
                layer="ernie_TDCS_1_scalar.msh",
                patch={
                    "field": FIELD,
                    "colormap": "hot",
                    "scale": {"kind": "linear", "lo": 0.0, "hi": 0.12},
                    "threshold": {"lo": 0, "hi": 0, "symmetric": False, "mode": "clamp", "softEdge": 0},
                    "showColorbar": True,
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
            s(layout="3d-only"),
            s(view="view3d", camera="R", distance=400),
            shot(
                "feat-mesh-per-tissue-paint",
                view="view3d",
                **ONE,
                include={"colorbar": True, "crosshair": False},
            ),
        ],
    ),
    "features",
)

# points — the EEG net over the T1's slice planes
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

print("\n=== BUILT ===")
for name, sub, files in BUILT:
    print(f"{name:24s} {sub}/ {files}")
