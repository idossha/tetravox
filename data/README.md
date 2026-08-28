# `data/` — the reference subject the examples read

`data/ernie/` is **git-ignored** and populated by [`scripts/fetch-data.sh`](../scripts/fetch-data.sh):

```sh
export TETRAVOX_TESTDATA=/path/to/derivatives/SimNIBS/sub-ernie   # a SimNIBS subject directory
scripts/fetch-data.sh
```

It copies exactly the fourteen files `examples/` opens — 906 MB, 90 % of it two meshes — out of a
subject directory that is several gigabytes. Everything in [`examples/capture/`](../examples/capture)
defaults to `data/ernie/…`, so once this has run an example is `python examples/capture/orbit.py`
with no environment to set.

## Provenance

`sub-ernie` is the SimNIBS example head model *ernie*, run through the
[TI-Toolbox](https://github.com/idossha/TI-Toolbox) pipeline: `charm` produced `m2m_ernie/`, and
`Simulations/` holds two temporal-interference simulations of it. The subject is the one
`docs/TESTING.md` names as `TETRAVOX_TESTDATA` and the one every screenshot in `docs/` was made
from, which is the point — a picture in the documentation and a picture an example prints should be
the same picture.

Nothing here is patient data: ernie is a published example dataset that ships with SimNIBS.

## What is in it

| File | Size | What it is |
|---|---:|---|
| `m2m_ernie/T1.nii.gz` | 13 MB | The T1, conformed to 1 mm — the anatomy under everything. |
| `m2m_ernie/segmentation/labeling.nii.gz` | 920 kB | The aseg-like atlas: 57 labelled regions, one integer per voxel. |
| `m2m_ernie/segmentation/labeling_LUT.txt` | 2.5 kB | Its lookup table. Without it the regions arrive as `tag 10` rather than `Left-Thalamus-Proper`. |
| `m2m_ernie/final_tissues.nii.gz` | 936 kB | The head model's tissue segmentation — the 14 tags the mesh is built from. |
| `m2m_ernie/final_tissues_LUT.txt` | 598 B | Its lookup table. |
| `m2m_ernie/ernie.msh` | 176 MB | The head model: 847,165 nodes, 4.7 M tetrahedra, tagged by tissue. |
| `m2m_ernie/ernie.msh.opt` | 2.5 kB | Gmsh display options beside it — the tissue colours the app reads out rather than inventing. |
| `m2m_ernie/surfaces/lh.pial.gii` | 7.6 MB | The left pial surface, for a field-on-a-surface shot. |
| `m2m_ernie/eeg_positions/GSN-HydroCel-185.geo` | 28 kB | 183 electrode positions of a GSN HydroCel 185 net. |
| `Simulations/Thalamus/TI/niftis/grey_Thalamus_TI_subject_TI_max.nii.gz` | 2.9 MB | The TI field as a volume, masked to grey matter, in the subject's own space. The heat overlay. |
| `Simulations/Thalamus/TI/mesh/grey_Thalamus_TI.msh` | 61 MB | The same field on the grey-matter surface only. |
| `Simulations/Thalamus/TI/mesh/Thalamus_TI.msh` | 243 MB | `ernie.msh` again — same nodes, same tetrahedra — carrying `TI_max` on every element. |
| `Simulations/Thalamus/TI/mesh/Thalamus_TI.msh.opt` | 1.9 kB | Its display options. |
| `Simulations/L_Insula/high_Frequency/mesh/ernie_TDCS_1_scalar.msh` | 401 MB | One tDCS solve of the other simulation, carrying the **vector** field `E` (3 components per element). The glyph shot's data. |

## Why the field volume is the grey-matter one

`Simulations/Thalamus/TI/niftis/` also holds the unmasked `Thalamus_TI_subject_TI_max.nii.gz`, and
it is the wrong file for a heat overlay: its 99th percentile is 0.81 V/m against the grey-matter
volume's 0.15, because the scalp between the electrodes carries an order of magnitude more field
than the brain does. A scale anchored on that renders the whole cortex in the bottom colour. The
grey-matter volume covers the thalamus (96 % of thalamic voxels are non-zero in it), so nothing the
examples point at is missing from it.
