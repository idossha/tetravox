#!/usr/bin/env python3
"""Renders the public non-head samples fetched by scripts/fetch-public-samples.sh.

    scripts/fetch-public-samples.sh
    export TETRAVOX_APP="$PWD/node_modules/.bin/electron"
    export TETRAVOX_APP_ARGS="$PWD/packages/app"
    python3 docs/screenshots/gallery-2026-08-28/jobs/build_public.py

Per volume: axial/coronal/sagittal/3D single panes, one 2x2 overview, and for the CTs a bone
window and a soft-tissue window (Hounsfield units, as `scale` on the layer). Where the sample ships
a label map it is overlaid in fill and outline mode.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
GALLERY_DIR = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(GALLERY_DIR)))
sys.path.insert(0, os.path.join(ROOT, "python"))

from tetravox import Job  # noqa: E402

PUB = os.path.join(ROOT, "data", "public")
OUT = GALLERY_DIR
JOBS = HERE

BONE = {"kind": "linear", "lo": -450, "hi": 1050}      # W1500 / L300
SOFT = {"kind": "linear", "lo": -160, "hi": 240}       # W400  / L40
LUNG = {"kind": "linear", "lo": -1350, "hi": 150}      # W1500 / L-600


def run(name, job):
    job.write(os.path.join(JOBS, f"{name}.json"))
    r = job.run(OUT)
    for w in r.warnings:
        print("   warn:", w)
    r.raise_for_status()
    print(f"[ok] {name}: {len(r.files)} files")


def panes(j, prefix, layer, three_d=True):
    for v in ("axial", "coronal", "sagittal"):
        j.set(view=v, reset=True)
        j.screenshot(f"{prefix}-{v}", view=v, width=1400)
    if three_d:
        # A volume has no 3D presence until `showIn3D` puts its three slice planes in the 3D pane.
        j.set(layer=layer, patch={"showIn3D": True}, view="view3d", camera="A", reset=True)
        j.screenshot(f"{prefix}-3d", view="view3d", width=1400)
    j.set(layout="2x2")
    j.screenshot(f"{prefix}-2x2", view="grid", width=1600, height=1000)


# 1. TotalSegmentator example CT (abdomen/thorax, 1.5 mm) + its fast multi-organ segmentation
ct = os.path.join(PUB, "totalsegmentator", "example_ct_sm.nii.gz")
seg = os.path.join(PUB, "totalsegmentator", "example_seg_fast.nii.gz")
j = Job(files=[ct, seg], preset="plain")
j.set(layer=seg, patch={"visible": False})
j.set(layer=ct, patch={"scale": SOFT})
panes(j, "public-totalseg-ct-soft", ct)
j.set(layer=ct, patch={"scale": BONE}, view="coronal", reset=True, layout="2x2")
j.screenshot("public-totalseg-ct-bone-coronal", view="coronal", width=1400)
j.set(view="sagittal", reset=True)
j.screenshot("public-totalseg-ct-bone-sagittal", view="sagittal", width=1400)
j.set(layer=ct, patch={"scale": SOFT})
j.set(layer=seg, patch={"visible": True, "opacity": 0.6, "labelMode": "fill", "interpolation": "nearest"})
j.set(view="coronal", reset=True)
j.screenshot("public-totalseg-labels-fill-coronal", view="coronal", width=1400)
j.set(view="axial", reset=True)
j.screenshot("public-totalseg-labels-fill-axial", view="axial", width=1400)
j.set(layer=seg, patch={"labelMode": "outline", "opacity": 1.0})
j.screenshot("public-totalseg-labels-outline-axial", view="axial", width=1400)
j.set(layer=seg, patch={"labelMode": "fill", "opacity": 0.6, "showIn3D": True, "iso3d": {"enabled": True}})
j.set(view="view3d", camera="A", reset=True)
j.screenshot("public-totalseg-labels-3d-iso", view="view3d", width=1400)
run("public-totalseg", j)

# 2. niivue-images CT_Abdo (abdomen CT)
ct = os.path.join(PUB, "niivue-images", "CT_Abdo.nii.gz")
j = Job(files=[ct], preset="plain")
j.set(layer=ct, patch={"scale": SOFT})
panes(j, "public-ct-abdo-soft", ct)
j.set(layer=ct, patch={"scale": BONE}, view="coronal", reset=True)
j.screenshot("public-ct-abdo-bone-coronal", view="coronal", width=1400)
j.set(view="axial", reset=True)
j.screenshot("public-ct-abdo-bone-axial", view="axial", width=1400)
run("public-ct-abdo", j)

# 3. niivue-images CT_Philips (chest CT)
ct = os.path.join(PUB, "niivue-images", "CT_Philips.nii.gz")
j = Job(files=[ct], preset="plain")
j.set(layer=ct, patch={"scale": LUNG})
panes(j, "public-ct-chest-lung", ct)
j.set(layer=ct, patch={"scale": SOFT}, view="axial", reset=True)
j.screenshot("public-ct-chest-soft-axial", view="axial", width=1400)
j.set(layer=ct, patch={"scale": BONE}, view="sagittal", reset=True)
j.screenshot("public-ct-chest-bone-sagittal", view="sagittal", width=1400)
run("public-ct-chest", j)

# 4. CTSpine1K chest CT + vertebra labels (spine)
ct = os.path.join(PUB, "ctspine1k", "volume-covid19-A-0377_ct.nii.gz")
seg = os.path.join(PUB, "ctspine1k", "volume-covid19-A-0377_ct_seg.nii.gz")
j = Job(files=[ct, seg], preset="plain")
j.set(layer=seg, patch={"visible": False})
j.set(layer=ct, patch={"scale": BONE})
panes(j, "public-spine-ct-bone", ct)
j.set(layer=ct, patch={"scale": SOFT}, view="sagittal", reset=True)
j.screenshot("public-spine-ct-soft-sagittal", view="sagittal", width=1400)
j.set(layer=ct, patch={"scale": BONE})
j.set(layer=seg, patch={"visible": True, "opacity": 0.6, "labelMode": "fill", "interpolation": "nearest"})
j.screenshot("public-spine-vertebra-labels-sagittal", view="sagittal", width=1400)
j.set(view="coronal", reset=True)
j.screenshot("public-spine-vertebra-labels-coronal", view="coronal", width=1400)
j.set(layer=seg, patch={"labelMode": "outline", "opacity": 1.0})
j.set(view="axial", reset=True)
j.screenshot("public-spine-vertebra-labels-outline-axial", view="axial", width=1400)
j.set(layer=seg, patch={"labelMode": "fill", "opacity": 0.7, "showIn3D": True, "iso3d": {"enabled": True}})
j.set(view="view3d", camera="A", reset=True)
j.screenshot("public-spine-vertebra-labels-3d-iso", view="view3d", width=1400)
j.set(camera="L")
j.screenshot("public-spine-vertebra-labels-3d-iso-left", view="view3d", width=1400)
run("public-spine-ct", j)
