//! `tvx-mesh-io` against the real SimNIBS dataset (AGENTS.md's reference tables, ARCHITECTURE.md
//! §6.2, §11 rule 2).
//!
//! Every test **skips, never fails**, when `TETRAVOX_TESTDATA` is unset:
//!
//! ```sh
//! export TETRAVOX_TESTDATA=/Users/idohaber/datasets/000/derivatives/SimNIBS/sub-ernie
//! ```
//!
//! The numbers are AGENTS.md's, which came from
//! `simnibs_python scripts/refvalues/mesh_refvalues.py` — never from this reader. Where AGENTS.md
//! is silent (the fsaverage surface, the DK40 annotation's dense census) the value was measured
//! with nibabel and the command that produced it is named in the comment.

use std::path::{Path, PathBuf};

use tvx_core::{NoProgress, Phase, ProgressSink};
use tvx_mesh_io::{
    read_fs_annot, read_fs_surface, read_geo_view, read_gifti, read_medit, read_msh, read_msh_opt,
    read_vtk, read_vtk_xml, Mesh,
};

/// `None` ⇒ the whole test skips (§11 rule 2 / TESTING.md).
fn root() -> Option<PathBuf> {
    let v = std::env::var("TETRAVOX_TESTDATA").ok()?;
    let p = PathBuf::from(v);
    p.is_dir().then_some(p)
}

macro_rules! testdata {
    () => {
        match root() {
            Some(r) => r,
            None => {
                eprintln!("skipped: TETRAVOX_TESTDATA is unset");
                return;
            }
        }
    };
}

fn bytes(p: &Path) -> Vec<u8> {
    std::fs::read(p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

fn mesh(p: &Path) -> Mesh {
    read_msh(bytes(p), &mut NoProgress).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

fn count_tag(tags: &[i32], tag: i32) -> u64 {
    tags.iter().filter(|t| **t == tag).count() as u64
}

#[track_caller]
fn close(what: &str, got: f64, want: f64, tol: f64) {
    assert!(
        (got - want).abs() <= tol,
        "{what}: got {got}, want {want} (tol {tol})"
    );
}

#[track_caller]
fn close_rel(what: &str, got: f64, want: f64, rel: f64) {
    let tol = want.abs() * rel;
    assert!(
        (got - want).abs() <= tol,
        "{what}: got {got}, want {want} (rel {rel})"
    );
}

#[track_caller]
fn bbox(m: &Mesh, min: [f64; 3], max: [f64; 3]) {
    for k in 0..3 {
        // Node coordinates are f64 on disk and f32 in `Mesh` (§6.2); 1e-4 mm is far inside f32's
        // resolution at head scale and far outside any parsing slip.
        close(
            &format!("bounds.min[{k}]"),
            m.bounds.min[k] as f64,
            min[k],
            1e-4,
        );
        close(
            &format!("bounds.max[{k}]"),
            m.bounds.max[k] as f64,
            max[k],
            1e-4,
        );
    }
}

const ERNIE_MIN: [f64; 3] = [-84.436612, -92.398125, -128.860523];
const ERNIE_MAX: [f64; 3] = [83.397800, 136.157040, 99.951712];

/// AGENTS.md's `ernie.msh` per-tag census. Tag 4 is **absent** — tags are not contiguous.
const ERNIE_TRI_TAGS: [(i32, u64); 10] = [
    (1001, 249_245),
    (1002, 335_930),
    (1003, 121_238),
    (1005, 77_032),
    (1006, 2_178),
    (1007, 143_499),
    (1008, 158_262),
    (1009, 35_930),
    (1010, 2_317),
    (1099, 51_582),
];
const ERNIE_TET_TAGS: [(i32, u64); 9] = [
    (1, 517_144),
    (2, 1_340_029),
    (3, 874_602),
    (5, 567_089),
    (6, 4_546),
    (7, 1_056_826),
    (8, 283_432),
    (9, 74_557),
    (10, 4_400),
];

// -------------------------------------------------------------------------------------------
// m2m_ernie/ernie.msh — the flagship file
// -------------------------------------------------------------------------------------------

#[test]
fn ernie_msh_counts_tags_bounds_and_the_identity_numbering() {
    let root = testdata!();
    let p = root.join("m2m_ernie/ernie.msh");
    assert_eq!(
        std::fs::metadata(&p).unwrap().len(),
        184_207_351,
        "AGENTS.md pins the byte count"
    );
    let m = mesh(&p);
    assert_eq!(m.nodes.len(), 847_165);
    assert_eq!(m.tris.len(), 1_177_213);
    assert_eq!(m.tets.len(), 4_722_625);

    for (tag, want) in ERNIE_TRI_TAGS {
        assert_eq!(count_tag(&m.tri_tags, tag), want, "tri tag {tag}");
    }
    for (tag, want) in ERNIE_TET_TAGS {
        assert_eq!(count_tag(&m.tet_tags, tag), want, "tet tag {tag}");
    }
    // "Tag 4 does not exist in either census — code that assumes 1..10 is wrong."
    assert_eq!(count_tag(&m.tet_tags, 4), 0);
    assert_eq!(count_tag(&m.tri_tags, 1004), 0);
    let tri_total: u64 = ERNIE_TRI_TAGS.iter().map(|(_, c)| c).sum();
    let tet_total: u64 = ERNIE_TET_TAGS.iter().map(|(_, c)| c).sum();
    assert_eq!(tri_total, m.tris.len() as u64, "the tri census is complete");
    assert_eq!(tet_total, m.tets.len() as u64, "the tet census is complete");

    bbox(&m, ERNIE_MIN, ERNIE_MAX);

    // §6.2's fast path: `[tri3 ×1,177,213 ids 1…][tet4 ×4,722,625 ids 1,177,214…]`.
    assert!(m.gmsh_elm_numbers.is_none(), "identity element numbering");
    assert!(m.gmsh_node_numbers.is_none(), "identity node numbering");
    assert_eq!(m.tet_perm.len(), m.tets.len());
    assert!(m.skipped.is_empty(), "ernie.msh holds only tri3 and tet4");
    // "`ernie.msh` carries no fields."
    assert!(m.node_fields.is_empty() && m.elm_fields.is_empty());
    assert!(m.tri_edge_mask.is_none(), "§6.2: read_msh emits None");
}

#[test]
fn ernie_msh_reports_progress_and_honours_an_abort() {
    let root = testdata!();
    let p = root.join("m2m_ernie/ernie.msh");

    #[derive(Default)]
    struct Counting {
        reports: usize,
        last: u64,
    }
    impl ProgressSink for Counting {
        fn report(&mut self, _phase: Phase, done: u64, total: u64) {
            self.reports += 1;
            self.last = done;
            assert!(done <= total, "progress must not overshoot");
        }
        fn aborted(&self) -> bool {
            false
        }
    }
    let mut c = Counting::default();
    let m = read_msh(bytes(&p), &mut c).unwrap();
    assert_eq!(m.nodes.len(), 847_165);
    assert!(
        c.reports > 4,
        "ROADMAP Phase-1 gate 1 wants a moving bar, got {} reports",
        c.reports
    );
    assert_eq!(c.last, 184_207_351, "the last report is 100 %");

    // The native build can poll a real abort flag (§6.0); wasm cancels by `worker.terminate()`.
    struct Aborting;
    impl ProgressSink for Aborting {
        fn report(&mut self, _p: Phase, _d: u64, _t: u64) {}
        fn aborted(&self) -> bool {
            true
        }
    }
    match read_msh(bytes(&p), &mut Aborting) {
        Err(tvx_core::Error::Cancelled) => {}
        other => panic!("expected Cancelled, got {other:?}"),
    }
}

// -------------------------------------------------------------------------------------------
// The simulation meshes
// -------------------------------------------------------------------------------------------

#[test]
fn thalamus_ti_carries_exactly_one_scalar_field() {
    let root = testdata!();
    let m = mesh(&root.join("Simulations/Thalamus/TI/mesh/Thalamus_TI.msh"));
    // "the same mesh plus a field"
    assert_eq!(m.nodes.len(), 847_165);
    assert_eq!(m.tris.len(), 1_177_213);
    assert_eq!(m.tets.len(), 4_722_625);
    bbox(&m, ERNIE_MIN, ERNIE_MAX);

    assert!(m.node_fields.is_empty(), "there is no vector E field in it");
    assert_eq!(m.elm_fields.len(), 1, "exactly one $ElementData field");
    let f = &m.elm_fields[0];
    assert_eq!(f.name, "TI_max");
    assert_eq!(f.ncomp, 1);
    assert_eq!(f.tri.len() + f.tet.len(), 5_899_838);
    assert_eq!(f.tri.len(), m.tris.len());
    assert_eq!(f.tet.len(), m.tets.len());
    assert!(!f.partial, "every element carries a value");
    close_rel(
        "TI_max min",
        f.stats.min as f64,
        1.0863735014567724e-12,
        1e-6,
    );
    close_rel("TI_max max", f.stats.max as f64, 10.293712064403254, 1e-6);
}

#[test]
fn grey_thalamus_has_no_triangles_at_all() {
    let root = testdata!();
    let m = mesh(&root.join("Simulations/Thalamus/TI/mesh/grey_Thalamus_TI.msh"));
    // §6.3's canonical boundary-extraction case: a mesh that ships no surface of its own.
    assert_eq!(m.tris.len(), 0);
    assert!(m.tri_tags.is_empty());
    assert_eq!(m.nodes.len(), 368_762);
    assert_eq!(m.tets.len(), 1_340_029);
    assert_eq!(count_tag(&m.tet_tags, 2), 1_340_029, "a single tet tag 2");
    bbox(
        &m,
        [-65.293617, -80.356236, -50.713399],
        [69.302530, 103.183221, 82.478744],
    );

    assert_eq!(m.elm_fields.len(), 1);
    let f = &m.elm_fields[0];
    assert_eq!(f.name, "TI_max");
    assert!(f.tri.is_empty(), "no triangles ⇒ no triangle values");
    assert_eq!(f.tet.len(), 1_340_029);
    assert!(!f.partial);
    close_rel("TI_max min", f.stats.min as f64, 0.010271207198531621, 1e-6);
    close_rel("TI_max max", f.stats.max as f64, 0.5450851782061356, 1e-6);
}

#[test]
fn ernie_tdcs_1_scalar_carries_the_vector_field_and_the_electrode_tags() {
    let root = testdata!();
    let p = root.join("Simulations/L_Insula/high_Frequency/mesh/ernie_TDCS_1_scalar.msh");
    assert_eq!(std::fs::metadata(&p).unwrap().len(), 420_249_153);
    let m = mesh(&p);
    assert_eq!(m.nodes.len(), 847_306);
    assert_eq!(m.tris.len(), 1_177_378);
    assert_eq!(m.tets.len(), 4_723_120);
    // "Node bbox is identical to ernie.msh's."
    bbox(&m, ERNIE_MIN, ERNIE_MAX);

    // "Its tri tags 1001–1099 and tet tags 1–10 are identical counts to ernie.msh's."
    for (tag, want) in ERNIE_TRI_TAGS {
        assert_eq!(count_tag(&m.tri_tags, tag), want, "tri tag {tag}");
    }
    for (tag, want) in ERNIE_TET_TAGS {
        assert_eq!(count_tag(&m.tet_tags, tag), want, "tet tag {tag}");
    }
    // §7.6: "a viewer colouring only 1–10 / 1001–1010 renders every electrode and gel layer as
    // untagged grey" — these are the tags that prove the palette has to reach further.
    for (tag, want) in [
        (1101, 28u64),
        (1102, 27),
        (1501, 28),
        (1502, 27),
        (2101, 28),
        (2102, 27),
    ] {
        assert_eq!(count_tag(&m.tri_tags, tag), want, "electrode tri tag {tag}");
    }
    for (tag, want) in [(101, 84u64), (102, 81), (501, 168), (502, 162)] {
        assert_eq!(count_tag(&m.tet_tags, tag), want, "electrode tet tag {tag}");
    }

    assert_eq!(m.elm_fields.len(), 2, "E and magnE");
    let e = m.elm_fields.iter().find(|f| f.name == "E").expect("E");
    let mag = m
        .elm_fields
        .iter()
        .find(|f| f.name == "magnE")
        .expect("magnE");
    assert_eq!(e.ncomp, 3, "the only reference file with a vector field");
    assert_eq!(mag.ncomp, 1);
    for f in [e, mag] {
        assert_eq!(
            (f.tri.len() + f.tet.len()) / f.ncomp,
            5_900_498,
            "{}: one record per element",
            f.name
        );
        assert!(!f.partial, "{}", f.name);
    }

    // `FieldStats` is of the **magnitude** when ncomp > 1 (§6.0), so E's stats equal magnE's.
    close_rel("E |min|", e.stats.min as f64, 8.563626769948982e-13, 1e-5);
    close_rel("E |max|", e.stats.max as f64, 57.78990622669672, 1e-6);
    close_rel(
        "magnE min",
        mag.stats.min as f64,
        8.563626769948982e-13,
        1e-5,
    );
    close_rel("magnE max", mag.stats.max as f64, 57.78990622669672, 1e-6);

    // The component-wise extremes are AGENTS.md's for `E` itself, not for its magnitude.
    let (mut lo, mut hi) = (f32::INFINITY, f32::NEG_INFINITY);
    for v in e.tri.iter().chain(e.tet.iter()) {
        lo = lo.min(*v);
        hi = hi.max(*v);
    }
    close_rel("E component min", lo as f64, -44.684382404915226, 1e-6);
    close_rel("E component max", hi as f64, 54.317663395011905, 1e-6);
}

#[test]
fn ernie_seeg_exceeds_the_twenty_one_bit_face_key() {
    let root = testdata!();
    let p = root.join("m2m_ernie/ernie_seeg.msh");
    assert_eq!(std::fs::metadata(&p).unwrap().len(), 492_090_201);
    let m = mesh(&p);
    assert_eq!(m.nodes.len(), 2_301_899);
    assert_eq!(m.tris.len(), 2_612_423);
    assert_eq!(m.tets.len(), 13_033_527);
    // "Both exceed 2²¹ nodes (22 bits), so both break a 3×21-bit packed face key."
    assert!(m.nodes.len() > 1 << 21);
    bbox(
        &m,
        [-84.393866, -92.294742, -128.728416],
        [83.377527, 136.488600, 99.839603],
    );
    for (tag, want) in [(1013, 68_178u64), (1014, 91_918), (1015, 117_131)] {
        assert_eq!(count_tag(&m.tri_tags, tag), want, "seeg tri tag {tag}");
    }
    for (tag, want) in [(13, 206_930u64), (14, 373_004), (15, 573_265)] {
        assert_eq!(count_tag(&m.tet_tags, tag), want, "seeg tet tag {tag}");
    }
    // The largest element number in the dataset still fits u32 (§6.2's guard is not tripped).
    assert!(m.gmsh_elm_numbers.is_none());
    assert!((m.tris.len() + m.tets.len()) as u64 <= u32::MAX as u64);
}

// -------------------------------------------------------------------------------------------
// The `.msh.opt` sidecar
// -------------------------------------------------------------------------------------------

#[test]
fn ernie_msh_opt_names_and_colours_every_tissue_tag() {
    let root = testdata!();
    let raw = bytes(&root.join("m2m_ernie/ernie.msh.opt"));
    let opt = read_msh_opt(&raw).unwrap();
    let color = |t: i32| opt.tag_color.iter().find(|(k, _)| *k == t).map(|(_, c)| *c);

    // SimNIBS's carousel defaults, straight out of the file: tag N takes `Mesh.Color.<Nth>`.
    assert_eq!(color(1), Some([230, 230, 230, 255]), "WM");
    assert_eq!(color(2), Some([129, 129, 129, 255]), "GM");
    assert_eq!(color(3), Some([104, 163, 255, 255]), "CSF");
    assert_eq!(color(5), Some([255, 166, 133, 255]), "Scalp");
    assert_eq!(color(10), Some([0, 118, 14, 255]), "Muscle");
    // §6.2's inheritance rule: `1xxx` takes volume tag `1xxx − 1000`'s colour.
    assert_eq!(color(1001), color(1), "surface WM inherits volume WM");
    assert_eq!(color(1002), color(2));
    assert_eq!(color(1010), color(10));
    // 1099 − 1000 = 99, and there is no `Mesh.Color.NinetyNine`: the palette fallback owns it.
    assert_eq!(color(1099), None);
    // The file carries no Hide/Show, so nothing is pinned visible or hidden.
    assert!(opt.tag_visible.is_empty());
    assert!(opt.views.is_empty(), "ernie.msh.opt declares no View[n]");

    // `ernie.msh` has no `$PhysicalNames`, so this sidecar is the only source of tissue names.
    assert!(mesh(&root.join("m2m_ernie/ernie.msh"))
        .physical_names
        .is_empty());
    // §6.2's `MshOptions.tag_name` (Phase 1 read these through an additive `read_msh_opt_names`).
    let names = &opt.tag_name;
    assert_eq!(names.len(), 19, "9 volumes + 10 surfaces");
    let name = |t: i32| {
        names
            .iter()
            .find(|(k, _)| *k == t)
            .map(|(_, n)| n.trim().to_string())
    };
    // Verbatim, leading space and all — the display layer trims (`tvx-wasm::resolve_tags`).
    assert_eq!(
        names.iter().find(|(k, _)| *k == 5).map(|(_, n)| n.as_str()),
        Some(" Scalp")
    );
    assert_eq!(name(1).as_deref(), Some("WM"));
    assert_eq!(name(2).as_deref(), Some("GM"));
    assert_eq!(name(1099).as_deref(), Some("Internal_air_surface"));
    assert_eq!(name(4), None, "tag 4 is absent here too");
}

// -------------------------------------------------------------------------------------------
// Surfaces and annotations
// -------------------------------------------------------------------------------------------

#[test]
fn the_two_gifti_surfaces_load_with_their_transforms_baked_in() {
    let root = testdata!();
    for (rel, bytes_len, min, max) in [
        (
            "m2m_ernie/surfaces/lh.central.gii",
            8_052_485u64,
            [-64.371368, -79.962860, -28.561777],
            [3.572175, 100.309242, 81.128761],
        ),
        (
            "m2m_ernie/surfaces/lh.pial.gii",
            7_997_897,
            [-65.527679, -80.793640, -30.076311],
            [3.624710, 101.465622, 82.150192],
        ),
    ] {
        let p = root.join(rel);
        assert_eq!(std::fs::metadata(&p).unwrap().len(), bytes_len, "{rel}");
        // Both are `GZipBase64Binary` — a **zlib** stream. A `GzDecoder` fails on byte 0.
        let m = read_gifti(bytes(&p), &mut NoProgress).unwrap_or_else(|e| panic!("{rel}: {e}"));
        assert_eq!(m.nodes.len(), 245_762, "{rel}: nodes");
        assert_eq!(m.tris.len(), 491_520, "{rel}: tris");
        assert!(m.tets.is_empty() && m.node_fields.is_empty(), "{rel}");
        assert!(m.tri_edge_mask.is_none(), "{rel}: GIfTI ships triangles");
        for k in 0..3 {
            close(
                &format!("{rel} min[{k}]"),
                m.bounds.min[k] as f64,
                min[k],
                1e-4,
            );
            close(
                &format!("{rel} max[{k}]"),
                m.bounds.max[k] as f64,
                max[k],
                1e-4,
            );
        }
        let maxv = m.tris.iter().flatten().copied().max().unwrap();
        assert_eq!(maxv as usize, m.nodes.len() - 1, "{rel}: indices are dense");
    }
}

#[test]
fn lh_ernie_dk40_annot_is_remapped_to_dense_indices() {
    let root = testdata!();
    let raw = bytes(&root.join("m2m_ernie/segmentation/lh.ernie_DK40.annot"));
    let (field, table) = read_fs_annot(&raw).unwrap();
    assert_eq!(field.data.len(), 245_762);
    assert_eq!(table.entries.len(), 36);
    assert_eq!(field.ncomp, 1);

    // §6.2: `LabelEntry::id` keeps the original packed-RGB value, which a 256×1 LUT could not
    // address. `nib.freesurfer.read_annot` reports the same ids in the same order.
    assert_eq!(table.entries[0].id, 1_639_705);
    assert_eq!(table.entries[0].name, "unknown");
    assert_eq!(table.entries[0].color[..3], [25, 5, 25]);
    assert_eq!(table.entries[1].id, 2_647_065);
    assert_eq!(table.entries[1].name, "bankssts");
    assert_eq!(table.entries[35].id, 2_146_559);
    assert_eq!(table.entries[35].name, "insula");

    // Dense 0..35 — never the raw packed values, whose range reaches 10,511,485.
    let (lo, hi) = field
        .data
        .iter()
        .fold((f32::INFINITY, f32::NEG_INFINITY), |(a, b), v| {
            (a.min(*v), b.max(*v))
        });
    assert_eq!((lo, hi), (0.0, 35.0));

    // Measured with `nib.freesurfer.read_annot`: 11,721 vertices carry raw 0 (nibabel reports
    // −1) and 2 carry the packed id of `unknown`. §6.2 sends both to dense index 0.
    let dense0 = field.data.iter().filter(|v| **v == 0.0).count();
    assert_eq!(dense0, 11_723);
    let dense35 = field.data.iter().filter(|v| **v == 35.0).count();
    assert_eq!(dense35, 5_224);
}

#[test]
fn a_freesurfer_binary_surface_loads_big_endian() {
    // Not part of the SimNIBS tree; AGENTS.md lists it under "other data on this machine".
    let p = std::env::var("TETRAVOX_FSAVERAGE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from("/Users/idohaber/mne_data/MNE-fsaverage-data/fsaverage/surf/lh.pial")
        });
    if !p.is_file() {
        eprintln!("skipped: {} is not present", p.display());
        return;
    }
    let raw = bytes(&p);
    assert_eq!(&raw[..3], &[0xFF, 0xFF, 0xFE], "triangle-file magic");
    let m = read_fs_surface(raw).unwrap();
    // Measured with `nib.freesurfer.read_geometry`.
    assert_eq!(m.nodes.len(), 163_842);
    assert_eq!(m.tris.len(), 327_680);
    assert_eq!(m.tris[0], [0, 40_964, 40_962]);
    for (k, want) in [-38.83454895f64, -19.01935577, 66.90840912]
        .iter()
        .enumerate()
    {
        close(&format!("node0[{k}]"), m.nodes[0][k] as f64, *want, 1e-4);
    }
    for (k, (lo, hi)) in [
        (-68.79433441f64, 1.78275895f64),
        (-104.82635498, 68.96263123),
        (-47.05241394, 78.02754974),
    ]
    .iter()
    .enumerate()
    {
        close(&format!("min[{k}]"), m.bounds.min[k] as f64, *lo, 1e-4);
        close(&format!("max[{k}]"), m.bounds.max[k] as f64, *hi, 1e-4);
    }
    assert!(
        m.tri_edge_mask.is_none(),
        "a triangle file, not a quad file"
    );
}

// -------------------------------------------------------------------------------------------
// Parsed post-processing views — `m2m_ernie/eeg_positions/*.geo` (§6.2, directed task 6)
// -------------------------------------------------------------------------------------------

/// `GSN-HydroCel-185.geo` — SimNIBS's EEG net as a parsed view: 187 `SP` + 187 `T3`.
///
/// The counts and the first/last coordinates were read out of the file with
/// `grep -c 'SP(' … ` and a five-line Python regex, never from this reader. The bounding box was
/// measured with numpy over the same regex's captures.
#[test]
fn gsn_hydrocel_185_is_187_points_and_187_labels() {
    let root = testdata!();
    let p = root.join("m2m_ernie/eeg_positions/GSN-HydroCel-185.geo");
    let views = read_geo_view(bytes(&p)).unwrap();

    assert_eq!(views.len(), 1, "SimNIBS writes one view per net");
    let v = &views[0];
    assert_eq!(v.name, "", "`View\"\"` — empty and unspaced");
    assert_eq!(v.points.len(), 187);
    assert_eq!(v.labels.len(), 187);
    assert!(v.lines.is_empty(), "an electrode net has no SL");
    assert!(v.tris.is_empty(), "and no ST");
    assert!(v.skipped.is_empty(), "every primitive in it is supported");

    // First and last records, exact: the f32 narrowing of the f64 the file spells out.
    assert_eq!(
        v.points[0],
        [
            71.115_927_093_976_99_f64 as f32,
            76.046_244_409_456_6_f64 as f32,
            1.235_366_124_277_992_f64 as f32,
        ]
    );
    assert_eq!(
        v.point_values[0], 0.0,
        "SimNIBS writes a zero value per electrode"
    );
    assert_eq!(v.labels[0].1, "E001");
    assert_eq!(
        v.labels[0].0,
        [
            71.115_927_093_976_99_f64 as f32,
            76.046_244_409_456_6_f64 as f32,
            // The label anchor sits 5 mm above its electrode — the offset SimNIBS bakes in.
            6.235_366_124_277_992_f64 as f32,
        ]
    );

    assert_eq!(
        v.points[186],
        [
            -77.242_827_542_615_8_f64 as f32,
            8.438_809_514_325_781_f64 as f32,
            -31.999_574_948_695_294_f64 as f32,
        ]
    );
    assert_eq!(
        v.labels[186].1, "RPA",
        "the net ends with the three fiducials"
    );
    assert!(
        v.point_values.iter().all(|x| *x == 0.0),
        "every SP value in the net is 0"
    );

    // Bounding box, measured with numpy over the same file's SP coordinates in float32 — with
    // `z_max` 5 mm higher, because the box covers the `T3` label anchors too and SimNIBS puts
    // each of them 5 mm above its electrode.
    assert_eq!(v.bounds.min, [-79.231_14, -91.479_06, -33.041_55]);
    assert_eq!(v.bounds.max, [82.969_21, 118.489_944, 98.937_95 + 5.0]);

    // Every other net in the directory parses too, and each SP has exactly one T3.
    for name in [
        "GSN-HydroCel-256.geo",
        "EEG10-10_UI_Jurak_2007.geo",
        "easycap_BC_TMS64_X21.geo",
        "Fiducials.geo",
    ] {
        let vs = read_geo_view(bytes(&root.join("m2m_ernie/eeg_positions").join(name))).unwrap();
        let v = &vs[0];
        assert_eq!(v.points.len(), v.labels.len(), "{name}");
        assert!(!v.points.is_empty(), "{name}");
    }
}

// -------------------------------------------------------------------------------------
// VTK legacy / VTK XML / MEDIT (§6.2)
// -------------------------------------------------------------------------------------

/// The SimNIBS reference dataset ships no `.vtk` / `.vtu` / `.mesh`, so there is no real-data
/// leg for these readers (AGENTS.md rule 2 is honoured in spirit instead): the committed
/// `lattice_*` fixtures are the very lattice `testdata/mesh_v2_binary.msh` holds, so the
/// Gmsh reader — proven against ernie above — is the cross-check. Not gated on
/// `TETRAVOX_TESTDATA`; the fixtures are always present.
#[test]
fn the_general_format_lattices_are_the_gmsh_v2_lattice() {
    let td = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../testdata");
    let base = mesh(&td.join("mesh_v2_binary.msh"));
    for name in [
        "lattice_ascii.vtk",
        "lattice_binary.vtk",
        "lattice_ascii.vtu",
        "lattice_b64.vtu",
        "lattice_appended_zlib.vtu",
        "lattice.mesh",
    ] {
        let b = bytes(&td.join(name));
        let m = if name.ends_with(".vtk") {
            read_vtk(b, &mut NoProgress)
        } else if name.ends_with(".vtu") {
            read_vtk_xml(b, &mut NoProgress)
        } else {
            read_medit(b)
        }
        .unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(m.nodes.len(), base.nodes.len(), "{name}: nodes");
        assert_eq!(m.tris.len(), base.tris.len(), "{name}: tris");
        assert_eq!(m.tets.len(), base.tets.len(), "{name}: tets");
        for k in 0..3 {
            close(
                &format!("{name}: min[{k}]"),
                m.bounds.min[k] as f64,
                base.bounds.min[k] as f64,
                1e-4,
            );
            close(
                &format!("{name}: max[{k}]"),
                m.bounds.max[k] as f64,
                base.bounds.max[k] as f64,
                1e-4,
            );
        }
        for tag in [1, 2] {
            assert_eq!(
                count_tag(&m.tet_tags, tag),
                count_tag(&base.tet_tags, tag),
                "{name}: tet tag {tag}"
            );
        }
        for tag in [1001, 1002] {
            assert_eq!(
                count_tag(&m.tri_tags, tag),
                count_tag(&base.tri_tags, tag),
                "{name}: tri tag {tag}"
            );
        }
    }
}
