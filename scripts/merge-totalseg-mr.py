#!/usr/bin/env python3
"""Merge a TotalSegmentator-MR subject's per-structure masks into one label map plus a LUT.

    scripts/merge-totalseg-mr.py data/public/totalsegmentator-mr/s0132

writes `<subject>/seg.nii.gz` (uint8, one label per structure in `LABELS` order) and
`<subject>/seg_LUT.txt` beside it, the SimNIBS/FreeSurfer LUT shape the app auto-associates.
Masks are applied in order, so where two overlap the later structure wins; the order puts the
large container-like structures first so a vertebra or a vessel is never painted over.
"""
import sys, pathlib, colorsys
import nibabel as nib, numpy as np

LABELS = [
    "spleen", "kidney_right", "kidney_left", "gallbladder", "liver", "stomach", "pancreas",
    "adrenal_gland_right", "adrenal_gland_left", "lung_left", "lung_right", "esophagus",
    "small_bowel", "duodenum", "colon", "urinary_bladder", "prostate", "sacrum", "vertebrae",
    "intervertebral_discs", "spinal_cord", "heart", "aorta", "inferior_vena_cava",
    "portal_vein_and_splenic_vein", "iliac_artery_left", "iliac_artery_right", "iliac_vena_left",
    "iliac_vena_right", "humerus_left", "humerus_right", "scapula_left", "scapula_right",
    "clavicula_left", "clavicula_right", "femur_left", "femur_right", "hip_left", "hip_right",
    "gluteus_maximus_left", "gluteus_maximus_right", "gluteus_medius_left", "gluteus_medius_right",
    "gluteus_minimus_left", "gluteus_minimus_right", "autochthon_left", "autochthon_right",
    "iliopsoas_left", "iliopsoas_right", "brain",
]

def colour(i: int) -> tuple[int, int, int]:
    # golden-angle hue walk: neighbours in label order get well-separated hues
    h = (i * 0.618033988749895) % 1.0
    r, g, b = colorsys.hsv_to_rgb(h, 0.65, 0.95)
    return int(r * 255), int(g * 255), int(b * 255)

def main(subject: pathlib.Path) -> None:
    ref = nib.load(subject / "mri.nii.gz")
    seg = np.zeros(ref.shape[:3], dtype=np.uint8)
    present = []
    for i, name in enumerate(LABELS, start=1):
        p = subject / "segmentations" / f"{name}.nii.gz"
        if not p.exists():
            continue
        m = np.asarray(nib.load(p).dataobj) > 0
        if m.any():
            seg[m] = i
            present.append((i, name))
    out = nib.Nifti1Image(seg, ref.affine)
    out.header.set_xyzt_units(*ref.header.get_xyzt_units())
    nib.save(out, subject / "seg.nii.gz")
    with open(subject / "seg_LUT.txt", "w") as f:
        f.write("#No.\tLabel Name:\tR\tG\tB\tA\n0\tUnknown\t0\t0\t0\t0\n")
        for i, name in present:
            r, g, b = colour(i)
            f.write(f"{i}\t{name}\t{r}\t{g}\t{b}\t255\n")
    print(f"{subject.name}: {len(present)} non-empty structures -> seg.nii.gz + seg_LUT.txt")

if __name__ == "__main__":
    for arg in sys.argv[1:]:
        main(pathlib.Path(arg))
