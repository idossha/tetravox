#!/usr/bin/env python3
"""Builds the docs/screenshots/gallery-2026-08-28/ gallery.

Run with the app built (`pnpm wasm && pnpm --filter @tetravox/app build`) and
TETRAVOX_TESTDATA pointed at a SimNIBS subject directory:

    export TETRAVOX_TESTDATA=/path/to/derivatives/SimNIBS/sub-ernie
    export TETRAVOX_APP="$PWD/node_modules/.bin/electron"
    export TETRAVOX_APP_ARGS="$PWD/packages/app"
    python3 docs/screenshots/gallery-2026-08-28/jobs/build_gallery.py

Writes PNGs to docs/screenshots/gallery-2026-08-28/ and each job's JSON
document to docs/screenshots/gallery-2026-08-28/jobs/ (for reproducibility —
`--job jobs/<name>.json --out .` reruns any single shot).
"""
import os
import sys
import json
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))  # .../docs/screenshots/gallery-2026-08-28/jobs
GALLERY_DIR = os.path.dirname(HERE)  # .../docs/screenshots/gallery-2026-08-28
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(GALLERY_DIR)))  # repo root
sys.path.insert(0, os.path.join(ROOT, "python"))

from tetravox import Job  # noqa: E402

TD = os.environ["TETRAVOX_TESTDATA"]
OUT = GALLERY_DIR
JOBS = os.path.join(OUT, "jobs")
os.makedirs(OUT, exist_ok=True)
os.makedirs(JOBS, exist_ok=True)

T1 = f"{TD}/m2m_ernie/T1.nii.gz"
LABELS = f"{TD}/m2m_ernie/segmentation/labeling.nii.gz"
MESH = f"{TD}/m2m_ernie/ernie.msh"
TDCS_SCALAR = f"{TD}/Simulations/motor_updrs/high_Frequency/mesh/ernie_TDCS_1_scalar.msh"
TI_MESH = f"{TD}/Simulations/Thalamus/TI/mesh/grey_Thalamus_TI.msh"
LH_PIAL = f"{TD}/m2m_ernie/surfaces/lh.pial.gii"
RH_PIAL = f"{TD}/m2m_ernie/surfaces/rh.pial.gii"
EEG_GEO = f"{TD}/m2m_ernie/eeg_positions/GSN-HydroCel-185.geo"

results = []  # (job_name, description, files)


def run(name, job, description):
    job.write(os.path.join(JOBS, f"{name}.json"))
    r = job.run(OUT)
    r.raise_for_status()
    results.append((name, description, [os.path.basename(f) for f in r.files]))
    print(f"[ok] {name}: {[os.path.basename(f) for f in r.files]}")


# Resolve actual TDCS scalar mesh path (subject dir name for the simulation may vary).
if not os.path.exists(TDCS_SCALAR):
    import glob
    cands = glob.glob(f"{TD}/Simulations/*/high_Frequency/mesh/*_TDCS_1_scalar.msh")
    if cands:
        TDCS_SCALAR = cands[0]

# ---------------------------------------------------------------------------
# 1. T1 volume — views, layouts, zoom
# ---------------------------------------------------------------------------

j = Job(files=[T1], preset="plain")
j.set(view="axial", cursor=(0, -18, 8), mm_per_px=0.35)
j.screenshot("t1-axial-1x1-zoom", view="axial", width=1400)
j.set(view="coronal", mm_per_px=0.35)
j.screenshot("t1-coronal-1x1-zoom", view="coronal", width=1400)
j.set(view="sagittal", mm_per_px=0.35)
j.screenshot("t1-sagittal-1x1-zoom", view="sagittal", width=1400)
j.set(view="view3d", camera="A", distance=260)
j.screenshot("t1-3d-anterior", view="view3d", width=1400)
j.set(camera="S")
j.screenshot("t1-3d-superior", view="view3d", width=1400)
j.set(layout="2x2")
j.screenshot("t1-layout-2x2", view="grid", width=1600, height=1000)
j.set(layout="1+3")
j.screenshot("t1-layout-1plus3", view="grid", width=1600, height=1000)
j.set(layout="3d+1")
j.screenshot("t1-layout-3dplus1", view="grid", width=1600, height=1000)
j.set(layout="1x3")
j.screenshot("t1-layout-1x3", view="grid", width=1600, height=700)
j.set(layout="1x3-horizontal")
j.screenshot("t1-layout-1x3-horizontal", view="grid", width=1600, height=700)
run("t1-views-layouts", j, "T1 volume: axial/coronal/sagittal/3D close-ups and all five layouts")

# window/level presets, colormaps, interpolation, crosshair/scalebar/cube
j = Job(files=[T1], preset="plain")
j.set(view="axial", cursor=(0, -18, 8), mm_per_px=0.35)
j.set(layer=T1, patch={"scale": {"kind": "linear", "lo": 0, "hi": 65535}})
j.screenshot("t1-window-min-max", view="axial", width=1400)
j.set(layer=T1, patch={"scale": {"kind": "linear", "lo": 800, "hi": 3200}})
j.screenshot("t1-window-p2-98", view="axial", width=1400)
j.set(layer=T1, patch={"scale": {"kind": "linear", "lo": 400, "hi": 5200}})
j.screenshot("t1-window-p50-p999", view="axial", width=1400)
j.set(layer=T1, patch={"scale": {"kind": "linear", "lo": 0, "hi": 4000}, "colormap": "viridis"})
j.screenshot("t1-colormap-viridis", view="axial", width=1400)
j.set(layer=T1, patch={"colormap": "hot"})
j.screenshot("t1-colormap-hot", view="axial", width=1400)
j.set(layer=T1, patch={"colormap": "bone"})
j.screenshot("t1-colormap-bone", view="axial", width=1400)
j.set(layer=T1, patch={"colormap": "gray", "interpolation": "nearest"})
j.screenshot("t1-interp-nearest", view="axial", width=1400)
j.set(layer=T1, patch={"interpolation": "linear"})
j.screenshot("t1-interp-linear", view="axial", width=1400)
j.set(radiological=True)
j.screenshot("t1-convention-radiological", view="axial", width=1400, crosshair=True)
j.set(radiological=False)
j.screenshot("t1-convention-neurological", view="axial", width=1400, crosshair=True)
j.screenshot("t1-crosshair-off", view="axial", width=1400, crosshair=False)
j.screenshot("t1-cursor-readout", view="axial", width=1400, crosshair=True)
j.screenshot("t1-scale-bar", view="axial", width=1400, colorbar=False)
j.set(view="view3d", camera="A")
j.screenshot("t1-orientation-cube", view="view3d", width=1400)
run("t1-window-colormap-convention", j, "T1: window/level presets, colormaps, nearest vs linear, RAD/NEU, crosshair, scale bar, orientation cube")

# ---------------------------------------------------------------------------
# 2. Label volume
# ---------------------------------------------------------------------------

j = Job(files=[T1, LABELS], preset="plain")
j.set(layer=LABELS, patch={"opacity": 0.7, "labelMode": "fill"})
j.set(view="axial", cursor=(0, -18, 8), mm_per_px=0.35)
j.screenshot("labels-fill-axial", view="axial", width=1400)
j.set(layer=LABELS, patch={"labelMode": "outline"})
j.screenshot("labels-outline-axial", view="axial", width=1400)
j.set(layer=LABELS, patch={"labelMode": "both"})
j.screenshot("labels-fill-outline-axial", view="axial", width=1400)
j.set(view="coronal", mm_per_px=0.35)
j.screenshot("labels-coronal", view="coronal", width=1400)
# isolate a single tissue (grey matter is typically label 2 in SimNIBS segmentation)
j.set(layer=LABELS, patch={"visibleLabels": [2], "labelMode": "fill", "opacity": 1.0})
j.screenshot("labels-isolate-single-tissue", view="axial", width=1400)
j.set(layer=LABELS, patch={"visibleLabels": None, "opacity": 0.7, "showIn3D": True,
                            "iso3d": {"enabled": True}})
j.set(view="view3d", camera="A")
j.screenshot("labels-show-in-3d-iso", view="view3d", width=1400)
run("labels-lut-modes", j, "Label volume: fill/outline/both modes, LUT colours, single-tissue isolation, 3D iso surfaces")

# ---------------------------------------------------------------------------
# 3. Head mesh (tissues)
# ---------------------------------------------------------------------------

j = Job(files=[MESH], preset="mesh-tissues-translucent")
j.set(view="view3d", camera="A", distance=280)
j.screenshot("mesh-tissues-translucent-anterior", view="view3d", width=1400)
j.set(camera="L")
j.screenshot("mesh-tissues-translucent-left", view="view3d", width=1400)
j.set(camera="S")
j.screenshot("mesh-tissues-translucent-superior", view="view3d", width=1400)
mesh_name = os.path.basename(MESH)
j.set(layer=mesh_name, patch={"tagStyle": {"5": {"visible": False, "opacity": 0.3}}})
j.set(camera="A")
j.screenshot("mesh-per-tissue-visibility-scalp-off", view="view3d", width=1400)
j.set(layer=mesh_name, patch={"tagStyle": {"5": {"visible": True, "opacity": 0.3}},
                               "clip": {"planes": [{"plane": {"normal": [1, 0, 0], "offset": 0}, "enabled": True}], "caps": True}})
j.screenshot("mesh-clip-plane-sagittal", view="view3d", width=1400)
j.set(layer=mesh_name, patch={"clip": {"planes": [], "caps": True}})
j.set(view="axial", cursor=(0, -18, 8), mm_per_px=0.35)
j.screenshot("mesh-cross-section-2d-axial", view="axial", width=1400)
j.set(layer=mesh_name, patch={"isolate": {"tags": [1]}}, view="view3d", camera="A")
j.screenshot("mesh-isolate-brain-only", view="view3d", width=1400)
run("mesh-tissues", j, "ernie.msh: translucent tissue preset, per-tissue visibility, clip plane, 2D cross-section, isolation, .msh.opt tissue colours")

# ---------------------------------------------------------------------------
# 4. Scalar field on mesh (TI) + vector field (TDCS) glyphs
# ---------------------------------------------------------------------------

if os.path.exists(TI_MESH):
    j = Job(files=[T1, TI_MESH], preset="ti-field-on-t1")
    j.set(view="axial", cursor=(-33, -4, 12), mm_per_px=0.35)
    j.screenshot("ti-field-on-t1-axial", view="axial", width=1400)
    j.set(view="coronal", mm_per_px=0.35)
    j.screenshot("ti-field-on-t1-coronal", view="coronal", width=1400)
    j.set(view="view3d", camera="A", distance=260)
    j.screenshot("ti-field-on-t1-3d", view="view3d", width=1400, colorbar=True)
    field_name = os.path.basename(TI_MESH)
    j.set(layer=field_name, patch={"colormap": "turbo"})
    j.screenshot("ti-field-colormap-turbo", view="view3d", width=1400)
    run("ti-field", j, "TI field (grey_Thalamus_TI.msh): ti-field-on-t1 preset, thresholded colour bar with p90/p97/p99.9 ticks, alternate colormap")
    # NOTE: ti-field-on-t1-3d is dropped from the published gallery — grey_Thalamus_TI.msh has
    # 0 triangles (documented in AGENTS.md), so its 3D pane is legitimately empty; the 2D captures
    # above are the field's real pictures.
else:
    print("[skip] TI_MESH not found:", TI_MESH)

# TDCS vector-field glyphs: see build_tdcs_glyphs.py. MeshLayer colorMode:'field' renders fully
# black in the 3D pane for ernie_TDCS_1_scalar.msh (the colour-bar statistics compute correctly,
# but the field-coloured surface geometry does not draw) — an apparent app bug, not fixed here
# per the task's "do not modify app source" constraint. Glyphs read meshCentroids independently
# of that colour pass and render correctly, so build_tdcs_glyphs.py captures those instead.

# ---------------------------------------------------------------------------
# 5. Surfaces (GIfTI pial)
# ---------------------------------------------------------------------------

surf_files = [T1]
if os.path.exists(LH_PIAL):
    surf_files.append(LH_PIAL)
if os.path.exists(RH_PIAL):
    surf_files.append(RH_PIAL)
if len(surf_files) > 1:
    j = Job(files=surf_files, preset="plain")
    j.set(view="view3d", camera="L", distance=260)
    j.screenshot("surfaces-pial-3d-left", view="view3d", width=1400)
    j.set(camera="A")
    j.screenshot("surfaces-pial-3d-anterior", view="view3d", width=1400)
    j.set(view="axial", cursor=(0, -18, 8), mm_per_px=0.35)
    j.screenshot("surfaces-pial-contours-axial", view="axial", width=1400)
    j.set(view="coronal", mm_per_px=0.35)
    j.screenshot("surfaces-pial-contours-coronal", view="coronal", width=1400)
    j.set(layout="2x2")
    j.screenshot("surfaces-pial-overview-2x2", view="grid", width=1600, height=1000)
    run("surfaces-pial", j, "GIfTI pial surfaces (lh/rh) as a 3D mesh and as 2D contours over the T1")
else:
    print("[skip] pial surfaces not found")

# ---------------------------------------------------------------------------
# 6. Points — EEG electrodes
# ---------------------------------------------------------------------------

if os.path.exists(EEG_GEO):
    j = Job(files=[T1, EEG_GEO], preset="plain")
    j.set(view="view3d", camera="S", distance=280)
    j.screenshot("eeg-electrodes-3d-superior", view="view3d", width=1400)
    j.set(camera="A")
    j.screenshot("eeg-electrodes-3d-anterior", view="view3d", width=1400)
    run("eeg-points", j, "GSN-HydroCel-185.geo EEG electrode positions rendered as labelled points over the T1")
else:
    print("[skip] EEG_GEO not found:", EEG_GEO)

# ---------------------------------------------------------------------------
# 7. Overview shots
# ---------------------------------------------------------------------------

if os.path.exists(TI_MESH):
    j = Job(files=[T1, TI_MESH], preset="ti-field-on-t1")
    j.set(layout="2x2", cursor=(-33, -4, 12))
    j.screenshot("overview-ti-field-2x2", view="grid", width=1600, height=1000)
    j.set(layout="1+3")
    j.screenshot("overview-ti-field-1plus3", view="grid", width=1600, height=1000)
    run("overview-ti-field", j, "TI field overview captures: 2x2 and 1+3 layouts")

# ---------------------------------------------------------------------------
# 8. Automation: sweep + orbit
# ---------------------------------------------------------------------------

j = Job(files=[T1], preset="plain")
j.set(view="axial", mm_per_px=0.5)
j.sweep("axial-sweep", view="axial", start=-40, stop=60, count=16, fps=10, width=900)
run("automation-sweep", j, "16-frame axial sweep of the T1 (PNG frames + GIF)")

j = Job(files=[MESH], preset="mesh-tissues-translucent")
j.orbit("head-orbit", frames=24, degrees=360, axis="z", fps=12, width=900)
run("automation-orbit", j, "24-frame 360-degree turntable of the translucent tissue mesh (PNG frames + GIF)")

# ---------------------------------------------------------------------------
# 9. UI tour (panels window) — light and dark
# ---------------------------------------------------------------------------

j = Job(files=[T1, LABELS], preset="plain", window=(1600, 1000), panels=True)
j.set(view="axial", cursor=(0, -18, 8))
j.screenshot("ui-tour-window-panels", view="window", width=1600)
run("ui-tour", j, "Full application window with panels: toolbar, layer panel, status bar (§8 shell)")

print("\n=== SUMMARY ===")
total = 0
for name, desc, files in results:
    pngs = [f for f in files if f.endswith(".png")]
    total += len(pngs)
    print(f"{name}: {len(pngs)} png(s) — {desc}")
print(f"\nTotal PNGs: {total}")

with open(os.path.join(JOBS, "_manifest.json"), "w") as f:
    json.dump(results, f, indent=2)
