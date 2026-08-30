# Reference values for real-data tests

These scripts produce every number in `AGENTS.md` § "Test data", plus the contour reference a Rust
test reads back. Re-run them instead of retyping numbers.

```
/Users/idohaber/Applications/SimNIBS-4.6/bin/simnibs_python scripts/refvalues/mesh_refvalues.py > scripts/refvalues/mesh_refvalues.json
python3 scripts/refvalues/nifti_refvalues.py                                                   > scripts/refvalues/nifti_refvalues.json
python3 scripts/refvalues/contour_refvalues.py                                                 > scripts/refvalues/contour_refvalues.json
python3 scripts/refvalues/mgz_refvalues.py                                                     > scripts/refvalues/mgz_refvalues.json
python3 scripts/refvalues/voxelbox_refvalues.py                                                > scripts/refvalues/voxelbox_refvalues.json
```

Both take an optional testdata root as `argv[1]`, defaulting to `$TETRAVOX_TESTDATA` and then to
`/Users/idohaber/datasets/000/derivatives/SimNIBS/sub-ernie`.

* `mesh_refvalues.py` needs the SimNIBS interpreter (`simnibs.mesh_tools.mesh_io`) plus nibabel. It reports
  per-file byte size, node/tri/tet counts, per-tag element census, node bounding box, and each field's
  name/kind/ncomp/min/max; for GIfTI it reports the per-`DataArray` encoding, endianness, index order and
  coordinate-system codes; for `.annot` the vertex count, colortable size and raw label range.
* `nifti_refvalues.py` needs nibabel + numpy only. It reads `scl_slope`/`scl_inter`/`datatype`/`pixdim` from the
  **raw 348-byte header**, because `nib.load(p).header` reports NaN slopes for every file —
  `Nifti1Image.from_file_map` calls `set_slope_inter(None, None)` after handing scaling to the array proxy.
  It also rebuilds the qform from the quaternion and reports the max abs error against the image affine both
  with and without `qfac`, which is the assertion the qfac test uses.

* `contour_refvalues.py` needs nibabel + numpy only. It intersects every triangle of
  `m2m_ernie/surfaces/lh.pial.gii` with the three axis planes through the surface's own bounding-box
  centre — the cursor a freshly opened scene puts there — and reports the segment count and the total
  contour length for each, plus the **axial** plane's segments in full. That geometry is what
  `crates/tvx-geom/tests/real_data.rs::surface_contours_match_numpy_on_lh_pial` asserts §6.3's
  `surface_contours` against: length within 1 %, every endpoint within 0.1 mm of a reference segment.
  Only one plane's geometry is committed because three is a megabyte of JSON.

The committed `*.json` files are the 2026-08-27 output on this machine; a diff against a fresh run is a dataset
change, not a test failure.

* `mgz_refvalues.py` needs nibabel + numpy only. It takes the `.mgz` path as `argv[1]`, defaulting to
  `$TETRAVOX_MGZ` and then to nibabel's own `tests/data/test.mgz` inside the SimNIBS environment — the only
  `.mgz` on the reference machine. It reports dims, frames, the FreeSurfer type code, `delta`, nibabel's
  `MGHImage.affine`, `vox2ras-tkr`, per-frame min/max/mean and spot values; the file's name and size are
  recorded so `tests/realdata.rs::mgz_matches_nibabel` skips rather than misjudges another file.

* `voxelbox_refvalues.py` needs nibabel + numpy only. It is the real-data half of AGENTS.md rule 2 for
  §4.3's bounded local reads (`packages/engine/src/derived/voxel-box.ts`): `sampleVoxelBox` and
  `peakCentroid` re-implemented in numpy over `m2m_ernie/T1.nii.gz`, at seven world points including
  one outside the volume and one whose radius hits the 32-voxel cap. It reports each box's `ijk0`,
  `dims`, min/max/sum and five spot values (corners and centre, which a transposed window cannot
  reproduce), plus the peak centroid in world mm.
  `packages/engine/src/derived/voxel-box.realdata.test.ts` reads it and skips without
  `TETRAVOX_TESTDATA`. The synthetic half is `testdata/ct_shafts.nii.gz`, whose expectations live in
  `testdata/manifest.json` under `voxelBox` and come from `scripts/gen-fixtures.py`.
