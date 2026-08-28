# testdata — synthetic fixtures + ground truth

Everything here is generated and committed:

```
python3 scripts/gen-fixtures.py            # regenerate fixtures AND manifest.json
python3 scripts/gen-fixtures.py --no-verify  # fixtures only (no simnibs_python needed)
```

The fixture *writing* half needs only python3 + numpy + nibabel. The *verification* half
re-executes the script under `$TETRAVOX_SIMNIBS_PYTHON`
(default `~/Applications/SimNIBS-4.6/bin/simnibs_python`) for the Gmsh side. Generation is
deterministic: rerunning reproduces every byte, so a diff in `git status` means a real change.

## `manifest.json` is the ground truth, and it does not come from the writer

Every number was produced by an **independent reader** reading the committed file back
(`docs/ARCHITECTURE.md` §11):

| Section | Reader |
|---|---|
| `volumes` | nibabel, plus the raw 348/540-byte header for the on-disk `scl_slope`/`scl_inter` and `pixdim` |
| `gifti`, `freesurfer` | nibabel |
| `msh` (v2.2, contiguous numbering) | `simnibs.mesh_io.read_msh` **and** the Gmsh 4.14 Python API, both recorded |
| `msh` (v4.1, non-contiguous numbering) | the Gmsh Python API — SimNIBS refuses v4 and renumbers the other |
| `surfaces` (STL/PLY/OBJ) | the Gmsh Python API |
| `mshOptParsedByGmsh` | Gmsh, applying the `.msh.opt` as options |
| `sidecars[*].expected` | **authored** — no third-party parser yields §6.2 `MshOptions` or §6.0 `LabelTable` |
| `writerNotes` | the writer. Never an expectation on its own; the readers above confirm each one. |

Each v4.1 file is additionally converted back to v2.2 by Gmsh and re-read by SimNIBS, under
`roundTripToV22ReadBySimnibs`.

Non-finite floats appear as the JSON strings `"NaN"`, `"Infinity"`, `"-Infinity"`.
`conventions` at the top of the manifest states the affine layout, the voxel order, the raw
vs. physical rule and the colour range.

## What each fixture is for

**Volumes** — 5x4x3 unless noted, i fastest, `value = i + 10j + 100k (+ 1000t)` scaled per dtype.

| File | Pins |
|---|---|
| `vol_{u8,i8,u16,i16,u32,i32,f32,f64}.nii[.gz]` | the eight scalar dtypes §6.1 accepts; the `.gz` ones also the magic sniff |
| `vol_u8.nii` + `vol_u8.nii.gz` | identical content either side of gzip |
| `vol_rgb24.nii`, `vol_rgba32.nii` | ladder row 10 |
| `vol_qfac_neg.nii` | `sform_code = 0`, `qform_code = 1`, `pixdim[0] = -1` — **the only case that catches a missing qfac** (§3). Dropping it moves the affine by 6 mm/voxel. |
| `vol_scl.nii` | `scl_slope = 2.5`, `scl_inter = -100`, patched into the header bytes so the raw samples stay raw |
| `vol_scl_nan.nii` | `scl_slope = NaN` — §6.1's guard, which **no reference file exercises** |
| `vol_bigendian.nii` | big-endian header and data |
| `vol_nifti2.nii` | the 540-byte header |
| `vol_4d.nii.gz` | `nvols = 3`, the `volumeFrame` op (§6.5.2) |
| `labels_simnibs.nii.gz` + `labels_simnibs_LUT.txt` | sparse ids 0..530 and the SimNIBS LUT format |
| `labels_freesurfer.nii.gz` + `labels_freesurfer_LUT.txt` | the FreeSurferColorLUT format |
| `labels_float32.nii.gz` | **float32 label volume**, `intent_code = 1002` — an `is_label` heuristic that requires an integer dtype misreads it (§6.1) |
| `vol_ramp4.nii` | §11's 4x4x4 `v = i` analytic pixel fixture |
| `vol_asym.nii` | §11's orientation fixture: a bright 3^3 cube in the **left**-anterior-superior octant only |

Every affine is oblique (a 30° x 30° rotation, 1.5/2.0/3.0 mm spacing), with an exact sform
beside a float32-quaternion qform, so `maxAbsSformQformDelta` is non-zero and §3's ordering is
observable.

**Meshes** — a 2x2x2 lattice of cubes cut into 6 tets each: **27 nodes, 56 tris, 48 tets**,
spanning (-10,-10,-10)..(10,10,10). Tet tags 1 (lower half) and 2, 24 each; tri tags 1001 (24)
and 1002 (32). Its 56 triangles are exactly the 48 exterior faces plus the 8 tag-differing
interior ones — §6.3's surface invariant at a size a human can check by hand.

| File | Pins |
|---|---|
| `mesh_v2_ascii.msh` | v2.2 ASCII, `$PhysicalNames`, `$NodeData` scalar + vector, `$ElementData` scalar + vector |
| `mesh_v2_binary.msh` | **SimNIBS's** `2.2 1 8` dialect: `i32` id + 3x`f64` nodes, element blocks with 2 tags, tris first then tets, and **no newline** before `$End*` |
| `mesh_v2_binary_gmsh.msh` | **Gmsh's** v2.2 binary dialect, which *does* write that newline. SimNIBS's own reader rejects its data sections; ours must not. |
| `mesh_v41_ascii.msh`, `mesh_v41_binary.msh` | Gmsh 4.1, both encodings, written by Gmsh itself |
| `mesh_tetonly.msh` | **0 triangles** — the `grey_Thalamus_TI.msh` case that renders empty without `extract_boundary` |
| `mesh_noncontig.msh` | element numbers 10, 13, 16, … and node numbers 102, 104, …, plus an `elm_gap` field covering every *other* element: scatter-by-id, `NaN` gaps, `partial = true` (§6.2) |
| `mesh_v2_binary.msh.opt` | the §6.2 sidecar in SimNIBS's real syntax, `Hide "*"` / `Show {…}` included |
| `mesh_v2_binary_LUT.txt` | the sibling `<mesh>_LUT.txt` |

**Surfaces**

| File | Pins |
|---|---|
| `surf_gzipb64.surf.gii`, `surf_b64.surf.gii`, `surf_ascii.surf.gii` | all three GIfTI encodings of one 16-vertex / 18-triangle patch. `GZipBase64Binary` is a **zlib** stream (§6.2). Each carries a non-identity `CoordinateSystemTransformMatrix` with `TransformedSpace = NIFTI_XFORM_SCANNER_ANAT`, so the loader must bake it in and report it in `appliedTransform`. |
| `surf.func.gii`, `surf.label.gii` | node fields keyed by intent, and a `<LabelTable>` with sparse keys 0/3/7/11 |
| `lh.fixture.surf` | FreeSurfer binary triangle file, magic `0xFFFFFE`, big-endian f32 |
| `lh.fixture.curv` | new-format curv, magic `0xFFFFFF` |
| `lh.fixture.annot` | packed-RGB raw labels spanning 255..16,711,680 that **must** be remapped to dense 0..3 at parse time — a 256x1 LUT cannot address the raw values (§6.2) |
| `patch_ascii.stl`, `patch_binary.stl` | both STL encodings. Node count is reader policy; see `readerNote`. |
| `patch_tri_ascii.ply`, `patch_tri_binary.ply` | both PLY encodings |
| `patch_quad.obj`, `patch_quad_ascii.ply` | 9 quads — the n-gon path that must emit `tri_edge_mask`. The OBJ is the authoritative one (Gmsh's PLY reader truncates n-gons). |
| `patch_tri.obj` | the triangle-only OBJ |
| `view_electrodes.geo` | a parsed Gmsh post-processing view (§6.2, task 6): the SimNIBS `View""{` dialect plus one of every supported primitive — `SP`, `T3`, `SL`, `ST`, `SQ` (fanned), `VP` (magnitude), a skipped `SS`, and a second named view. **Hand-written, not generated**: it exists to pin the dialect, and Gmsh round-tripping it would normalise away the very spellings it pins. |
| `view_geometry_script.geo` | a Gmsh **geometry script** — the file `read_geo_view` must reject with `Unsupported`, not read as an empty view |

## What is deliberately absent

See the manifest's `notGenerated` section: a `>= 2**21`-node mesh (built in memory by
`crates/tvx-geom/tests/fixtures.rs` instead — it would blow the 2 MB budget), a two-file
`.hdr`/`.img` NIfTI and a GIfTI `ExternalFileBinary` (both rejected by name, so the tests patch
a good file in memory rather than committing a bad one).
