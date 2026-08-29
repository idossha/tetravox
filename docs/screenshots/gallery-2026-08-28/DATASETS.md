# Public datasets used by this gallery

Fetched by [`scripts/fetch-public-samples.sh`](../../../scripts/fetch-public-samples.sh) into
`data/public/<name>/` (git-ignored; ~190 MB total), sha256-verified on every run. Rendered by
[`jobs/build_public.py`](jobs/build_public.py) into the `public-*.png` images indexed in
[README.md](README.md).

| Name | File | Source | Licence | sha256 |
|---|---|---|---|---|
| `totalsegmentator` | `example_ct_sm.nii.gz` | https://github.com/wasserth/TotalSegmentator (`tests/reference_files/`) | Apache-2.0 (repository) | `e50c00b2914e2cac0aaee8e7f3b5f57d44d9f21bfd5c0577271c54c0cb49e9fb` |
| `totalsegmentator` | `example_seg_fast.nii.gz` | same — the `--fast` multi-organ segmentation of that CT | Apache-2.0 | `353a7c65c9ff5d5b9b331f811130f0ebbaedb509df74587d3bd0d1ad5ebc3910` |
| `niivue-images` | `CT_Abdo.nii.gz` | https://github.com/neurolabusc/niivue-images | BSD-2-Clause (Chris Rorden, `LICENSE` fetched alongside) | `cfa3081e28fdcd6392d9c63de44851769983df26c931434529ae735c36eab0b3` |
| `niivue-images` | `CT_Philips.nii.gz` | same | BSD-2-Clause | `6b6ebf958bfe2972f27c3f8dc06bd3763eb7646186bd2e5251f37f9aa7a16971` |
| `ctspine1k` | `volume-covid19-A-0377_ct.nii.gz` | https://huggingface.co/datasets/alexanderdann/CTSpine1K (`raw_data/volumes/COVID-19/`), a CTSpine1K re-host of a COVID-19-CT-Seg chest CT | CC-BY-NC-SA (per the dataset README) — non-commercial, documentation use only | `5c5972eb06312906ba1fab9fa261e1c8fde2bf0b761f12150adde3f1ece4a67a` |
| `ctspine1k` | `volume-covid19-A-0377_ct_seg.nii.gz` | same (`raw_data/labels/COVID-19/`) — per-vertebra label map | CC-BY-NC-SA | `132a19f436ad6809c3c8472e4daa2bd32ff7cdde0672bb33366ae7df3eeebc19` |
| `ctspine1k` | `colonog-0477_ct.nii.gz` + `_seg` | same (`raw_data/{volumes,labels}/COLONOG/1.3.6.1.4.1.9328.50.4.0477`), a CT-colonography abdomen/pelvis CT | CC-BY-NC-SA | `bba2263f…` / `2e5a2b64…` |
| `ctspine1k` | `msd-t10-liver_0_ct.nii.gz` + `_seg` | same (`raw_data/{volumes,labels}/MSD-T10/liver_0`), a contrast abdomen CT from MSD Task 03 | CC-BY-NC-SA | `ffc5bbc5…` / `2f4884b0…` |
| `amos22-ct` | `amos_0004_ct.nii.gz`, `amos_0088_ct.nii.gz` + `_seg` | https://huggingface.co/datasets/MedOtter/amos22-ct-dataset (`train/{imagesTr,labelsTr}/`), AMOS22 abdominal CT with 15-organ labels | CC-BY-4.0 | `0c65994c…`/`cb8bac8e…`, `6948c143…`/`e11b4fda…` |
| `amos22-mri` | `amos_0555_mri.nii.gz`, `amos_0584_mri.nii.gz` + `_seg` | https://huggingface.co/datasets/MedOtter/amos22-mri-dataset — AMOS22 abdominal T1-weighted MRI (Siemens Prisma, 3D GRE) with the same 15-organ labels | CC-BY-4.0 | `b16fae6f…`/`41ea5b70…`, `64797b44…`/`536a1eea…` |
| `totalsegmentator-mr` | `s0375/`, `s0132/`, `s0187/`, `s0175/` — `mri.nii.gz` + `segmentations/*.nii.gz`, merged locally into `seg.nii.gz` + `seg_LUT.txt` by `scripts/merge-totalseg-mr.py` | https://huggingface.co/datasets/MedOtter/TotalSegmentatorMR (re-host of TotalSegmentator MRI, Zenodo 11367005) | CC-BY-NC-SA — non-commercial, documentation use only | mri.nii.gz: `7612ace5…`, `fcfc3bde…`, `650dc62e…`, `0f311daa…` (full hashes in the script) |

What each one is, as rendered and checked by eye:

* **TotalSegmentator `example_ct_sm`** — a low-resolution (~3 mm) thorax/abdomen CT, 483 kB, with a
  multi-organ label map. Superior up in coronal/sagittal; liver on the subject's right. Small enough
  that the label outlines look blocky, which is the file, not the renderer.
* **niivue-images `CT_Abdo`** — a contrast chest/upper-abdomen CT (heart and lung bases in the axial
  frame shown). 7.7 MB.
* **niivue-images `CT_Philips`** — a **head** CT, despite the neutral name: it was picked from the
  listing as a second CT and turned out to be a skull. Kept because it is the one sample with a
  clean lung/bone/soft-tissue window triple on dense bone; it does not count as non-head coverage.
* **CTSpine1K / COVID-19 `A-0377`** — a full chest CT (14 MB) with every vertebra labelled: the spine
  sample. The sagittal pane shows the column vertical with superior up; the vertebra iso-surfaces in
  3D stack the same way.
* **CTSpine1K / COLONOG `0477`** — abdomen–pelvis CT (26 MB, 0.7 × 0.7 × 5 mm) with T10–L5 and the
  sacrum region labelled: the lumbar-spine CT. Vertebra labels follow VerSe numbering (1–7 C1–C7,
  8–19 T1–T12, 20–24 L1–L5, 25 L6), written into `*_seg_LUT.txt` by the fetch script.
* **CTSpine1K / MSD-T10 `liver_0`** — contrast abdomen CT (21 MB) with thoracolumbar vertebrae labelled.
* **AMOS22 CT `0004`, `0088`** — abdominal CT (512 × 512 × ~70, 5 mm slices) with spleen, kidneys,
  gallbladder, oesophagus, liver, stomach, aorta, IVC, pancreas, adrenals, duodenum and bladder
  labelled; the multi-organ abdomen sample. `*_seg_LUT.txt` carries the official AMOS label order.
* **AMOS22 MRI `0555`, `0584`** — abdominal **T1-weighted** MRI (1.4 × 1.4 × 3 mm) with the same 13–15
  organs labelled: the T1w-with-segmentation sample for soft tissue. `amos_0540` was tried and
  dropped — its header scales the int16 data into the millions.
* **TotalSegmentator-MR `s0375`** — sagittal lumbar-spine MRI (14 slices, 0.67 mm in-plane) with
  vertebrae, intervertebral discs, spinal cord and sacrum: the spine-MRI sample. `s0132` is a 2 mm
  GRE of the pelvis/lower lumbar region (muscles, hips, bladder), `s0187` an abdomen–pelvis GRE with
  43 structures, `s0175` a whole-body 3 mm GRE with 49. The per-structure masks are merged into one
  `seg.nii.gz` (later structures win where masks overlap) with a golden-angle-hue LUT.

## Not fetched

* **Knee MRI.** No small, login-free NIfTI knee sample was found: fastMRI, SKM-TEA, OAI-ZIB and MRNet
  all require registration; the Hugging Face mirrors found (`arjundd/mridata-stanford-knee-3d-fse`,
  `AVS-Net/knee_fast_mri`, …) are multi-GB HDF5/k-space, not NIfTI volumes. A follow-up could convert
  one mridata.org case with `nibabel`, but that is a derived file rather than a public download and
  was left out.
* **Learn2Reg / Medical Segmentation Decathlon** — the smallest MSD task tarball is ~1.5 GB and
  Learn2Reg's abdomen CT is a Zenodo archive of similar size; CTSpine1K's per-file HF hosting gave the
  same anatomy (MSD-T10 liver cases are in it) for one 14 MB `curl`, so that route was used instead.
* **nilearn / OpenNeuro** — brain data; the SimNIBS subject already covers that.
