# Reference values for real-data tests

These two scripts produce every number in `AGENTS.md` § "Test data". Re-run them instead of retyping numbers.

```
/Users/idohaber/Applications/SimNIBS-4.6/bin/simnibs_python scripts/refvalues/mesh_refvalues.py > scripts/refvalues/mesh_refvalues.json
python3 scripts/refvalues/nifti_refvalues.py                                                   > scripts/refvalues/nifti_refvalues.json
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

The committed `*.json` files are the 2026-08-27 output on this machine; a diff against a fresh run is a dataset
change, not a test failure.
