# Public datasets — status

The task asked for at least one non-head public NIfTI sample (spine/chest/abdomen CT, knee MRI, …)
rendered alongside the SimNIBS head data. **This was not done in this pass** — the time budget for
this gallery went to building the app, working out the job schema's `layout`/`view` interaction (see
`jobs/build_gallery.py`'s header comment for the `1x1` bug that cost most of the debugging time), and
producing the ~90 SimNIBS-derived images plus their README. No public file was downloaded and no
`data/public/` directory was created.

## What a follow-up pass should do

Pick one small, well-known file so `sha256sum` and the licence are easy to state:

| Candidate | Source | Notes |
|---|---|---|
| TotalSegmentator example CT | https://github.com/wasserth/TotalSegmentator (`totalsegmentator --license` / Zenodo release) | Whole-body CT, license CC BY 4.0 on the Zenodo record |
| A single Medical Segmentation Decathlon case (e.g. Task09_Spleen, one `imagesTr/*.nii.gz`) | http://medicaldecathlon.com/ | CC-BY-SA 4.0; download the smallest task rather than the full archive |
| 3D Slicer SampleData (`CTChest`, `MRSpine` presets) | https://github.com/Slicer/SlicerSampleData / `slicer.util.downloadSample` | Public domain / CC0 depending on the entry — check the specific one used |
| VerSe spine CT (single subject) | https://github.com/anjany/verse | CC BY 4.0, per-subject `.nii.gz` |

```sh
# scripts/fetch-public-samples.sh (to write):
#   - one curl/wget per file above, into data/public/<name>/
#   - print the sha256 after download so DATASETS.md can be filled in with real values
#   - keep the total under ~2GB (a single CT or MRI volume is tens of MB, well inside budget)
```

`data/public/` should be added to `.gitignore` (check the existing rules first — the SimNIBS fixtures
are already git-ignored the same way) so the binary NIfTI files themselves never enter the repo; only
this file, the fetch script, and the rendered PNGs would be committed.

Once fetched, render per file: axial/coronal/sagittal/3D, a bone window for CT (`scale: {kind: linear,
lo: 300, hi: 1500}` is a reasonable start for a chest/abdomen CT; a spine CT wants a narrower window
around cortical bone), and the shipped label map if the sample carries one — verifying superior-up and,
for a spine volume, that the column renders vertically rather than sideways (`gen-fixtures.py`-style
synthetic volumes in this repo default to RAS; a downloaded NIfTI's own orientation must be checked
with its own header before assuming the same).
