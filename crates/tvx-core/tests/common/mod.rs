//! Loads `testdata/manifest.json` and the fixture bytes beside it.
//!
//! The manifest is written by `scripts/gen-fixtures.py`; every number in it came from an
//! independent reader (nibabel, `simnibs.mesh_io.read_msh`, the Gmsh 4.14 Python API),
//! never from the writer that produced the fixtures — see `docs/ARCHITECTURE.md` §11.
//! This file is duplicated verbatim in every crate's `tests/common/`: a shared test-only
//! crate would be a new workspace member, and the dependency set is frozen (§12.3).

#![allow(dead_code)]

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub fn dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../testdata")
}

pub fn manifest() -> &'static Value {
    static M: OnceLock<Value> = OnceLock::new();
    M.get_or_init(|| {
        let p = dir().join("manifest.json");
        let text = std::fs::read_to_string(&p)
            .unwrap_or_else(|e| panic!("{}: {e} (run scripts/gen-fixtures.py)", p.display()));
        serde_json::from_str(&text).expect("manifest.json is not valid JSON")
    })
}

pub fn section(name: &str) -> &'static serde_json::Map<String, Value> {
    manifest()[name]
        .as_object()
        .unwrap_or_else(|| panic!("manifest has no object section {name:?}"))
}

/// `(filename, record)` for every entry of one section, so a test can loop over all
/// fixtures of one kind without repeating the list.
pub fn entries(name: &str) -> Vec<(&'static str, &'static Value)> {
    let mut v: Vec<_> = section(name).iter().map(|(k, v)| (k.as_str(), v)).collect();
    v.sort_by_key(|(k, _)| *k);
    v
}

pub fn bytes(name: &str) -> Vec<u8> {
    let p = dir().join(name);
    std::fs::read(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

pub fn text(name: &str) -> String {
    let p = dir().join(name);
    std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

/// A manifest float. Non-finite values are encoded as the strings `"NaN"`, `"Infinity"`
/// and `"-Infinity"`, because JSON has no literal for them.
pub fn num(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap(),
        Value::String(s) if s == "NaN" => f64::NAN,
        Value::String(s) if s == "Infinity" => f64::INFINITY,
        Value::String(s) if s == "-Infinity" => f64::NEG_INFINITY,
        other => panic!("not a manifest float: {other}"),
    }
}

pub fn nums(v: &Value) -> Vec<f64> {
    v.as_array().expect("array").iter().map(num).collect()
}

pub fn usizes(v: &Value) -> Vec<usize> {
    v.as_array()
        .expect("array")
        .iter()
        .map(|x| x.as_u64().expect("uint") as usize)
        .collect()
}

pub fn u64_of(v: &Value) -> u64 {
    v.as_u64().unwrap_or_else(|| panic!("not a uint: {v}"))
}

#[track_caller]
pub fn close(what: &str, got: f64, want: f64, tol: f64) {
    if want.is_nan() {
        assert!(got.is_nan(), "{what}: expected NaN, got {got}");
        return;
    }
    assert!(
        (got - want).abs() <= tol,
        "{what}: got {got}, want {want} (tol {tol})"
    );
}

/// Compare a 4x4 affine (row-major, `m[row][col]` — the §6.1 layout) against a manifest
/// matrix. Kept here so no test has to write the double index loop clippy dislikes.
#[track_caller]
pub fn close_mat(what: &str, got: &[[f64; 4]; 4], want: &Value, tol: f64) {
    for (r, row) in got.iter().enumerate() {
        for (c, g) in row.iter().enumerate() {
            close(&format!("{what}[{r}][{c}]"), *g, num(&want[r][c]), tol);
        }
    }
}

/// The largest absolute difference between a 4x4 affine and a manifest matrix.
pub fn max_abs_delta(got: &[[f64; 4]; 4], want: &Value) -> f64 {
    let mut worst = 0.0f64;
    for (r, row) in got.iter().enumerate() {
        for (c, g) in row.iter().enumerate() {
            worst = worst.max((g - num(&want[r][c])).abs());
        }
    }
    worst
}
