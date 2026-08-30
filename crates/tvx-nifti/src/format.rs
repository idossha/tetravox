//! `VolumeFormat`, `sniff_volume`, `read_volume` — one entry point over every voxel reader
//! (ARCHITECTURE.md §6.1).
//!
//! Content first, extension second. A whole-file gzip member (`.nii.gz`, `.mgz`) is inflated
//! **once**: `read_volume` inflates, sniffs the inflated head, and hands the inflated vector to the
//! format's `read_*_raw`; `sniff_volume` on gzip bytes inflates only the first block, enough to see
//! the head.

use std::io::Read;

use tvx_core::{Error, ProgressSink, Result};

use crate::common::{is_gzip, take_inflated};
use crate::Volume;

/// The voxel formats `read_volume` dispatches over.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VolumeFormat {
    /// NIfTI-1 / NIfTI-2, `.nii` / `.nii.gz`.
    Nifti,
    /// FreeSurfer `.mgh` / `.mgz`.
    Mgh,
    /// NRRD with an attached header, `.nrrd`.
    Nrrd,
    /// MetaImage with an attached header, `.mha`.
    MetaImage,
}

impl VolumeFormat {
    pub fn name(self) -> &'static str {
        match self {
            VolumeFormat::Nifti => "NIfTI",
            VolumeFormat::Mgh => "MGH",
            VolumeFormat::Nrrd => "NRRD",
            VolumeFormat::MetaImage => "MetaImage",
        }
    }
}

/// The MetaImage keys a header may open with — MetaIO writes `ObjectType` first, but a hand-written
/// header may start anywhere in the list.
const META_KEYS: &[&str] = &[
    "objecttype",
    "ndims",
    "dimsize",
    "elementtype",
    "binarydata",
    "headersize",
    "elementspacing",
    "comment",
];

/// Sniff already-inflated bytes.
pub(crate) fn sniff_raw(head: &[u8]) -> Option<VolumeFormat> {
    if head.len() >= 4 {
        let a = [head[0], head[1], head[2], head[3]];
        let le = i32::from_le_bytes(a);
        let be = i32::from_be_bytes(a);
        if le == 348 || le == 540 || be == 348 || be == 540 {
            return Some(VolumeFormat::Nifti);
        }
        // MGH: big-endian `version = 1`, then a positive width. A NIfTI header never starts with
        // `00 00 00 01`, and neither text format does.
        if be == 1 && head.len() >= 8 {
            let w = i32::from_be_bytes([head[4], head[5], head[6], head[7]]);
            if w > 0 {
                return Some(VolumeFormat::Mgh);
            }
        }
    }
    if head.starts_with(b"NRRD000") {
        return Some(VolumeFormat::Nrrd);
    }
    let text = String::from_utf8_lossy(&head[..head.len().min(256)]);
    let first = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with('#'));
    if let Some(line) = first {
        if let Some((k, _)) = line.split_once('=') {
            if META_KEYS.contains(&k.trim().to_ascii_lowercase().as_str()) {
                return Some(VolumeFormat::MetaImage);
            }
        }
    }
    None
}

fn by_extension(hint_ext: Option<&str>) -> Option<VolumeFormat> {
    let e = hint_ext?.trim().to_ascii_lowercase();
    let e = e.rsplit('.').next().unwrap_or(&e);
    match e {
        "nii" | "gz" | "nifti" => Some(VolumeFormat::Nifti),
        "mgh" | "mgz" => Some(VolumeFormat::Mgh),
        "nrrd" | "nhdr" => Some(VolumeFormat::Nrrd),
        "mha" | "mhd" => Some(VolumeFormat::MetaImage),
        _ => None,
    }
}

/// Which reader `bytes` want. Content first; `hint_ext` (an extension such as `"mgz"`, `".nrrd"`
/// or a file name) only breaks a tie the bytes cannot. A gzip member is peeked at, not inflated.
pub fn sniff_volume(bytes: &[u8], hint_ext: Option<&str>) -> Result<VolumeFormat> {
    let mut head = [0u8; 64];
    let n = if is_gzip(bytes) {
        let mut dec = flate2::read::GzDecoder::new(bytes);
        let mut n = 0usize;
        while n < head.len() {
            match dec.read(&mut head[n..]) {
                Ok(0) => break,
                Ok(k) => n += k,
                Err(_) => break,
            }
        }
        n
    } else {
        let n = bytes.len().min(head.len());
        head[..n].copy_from_slice(&bytes[..n]);
        n
    };
    sniff_raw(&head[..n])
        .or_else(|| by_extension(hint_ext))
        .ok_or_else(|| {
            Error::Parse("unrecognised volume format: not NIfTI, MGH/MGZ, NRRD or MetaImage".into())
        })
}

/// Read a volume of `format`, or of whatever the bytes sniff as when `format` is `None`. Every
/// format produces the same [`Volume`]. Takes ownership and frees the bytes before returning (§5
/// rule 5); a gzip member is inflated exactly once.
pub fn read_volume(
    bytes: Vec<u8>,
    format: Option<VolumeFormat>,
    p: &mut dyn ProgressSink,
) -> Result<Volume> {
    let raw = take_inflated(bytes, p)?;
    let format = match format {
        Some(f) => f,
        None => sniff_raw(&raw).ok_or_else(|| {
            Error::Parse("unrecognised volume format: not NIfTI, MGH/MGZ, NRRD or MetaImage".into())
        })?,
    };
    match format {
        VolumeFormat::Nifti => crate::read::read_nifti_raw(raw, p),
        VolumeFormat::Mgh => crate::mgh::read_mgh_raw(raw, p),
        VolumeFormat::Nrrd => crate::nrrd::read_nrrd_raw(raw, p),
        VolumeFormat::MetaImage => crate::metaimage::read_metaimage_raw(raw, p),
    }
}
