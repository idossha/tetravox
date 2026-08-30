//! `read_mgh` — FreeSurfer MGH / MGZ (ARCHITECTURE.md §6.1).
//!
//! The format is **big-endian** throughout. The header is padded to 284 bytes and the samples start
//! at byte 284; an optional footer (`TR`, `flip_angle`, `TE`, `TI`, `FoV`, then tags) follows the
//! samples. The affine is not stored; it is rebuilt exactly as nibabel's `MGHHeader.get_affine`
//! does — `M = Mdcᵀ·diag(delta)`, `t = Pxyz_c − M·(dims/2)` with **float** division — and when
//! `goodRASFlag == 0` the header's geometry is replaced by nibabel's `_set_affine_default`:
//! `delta = 1`, `Mdc = [[-1,0,0],[0,0,1],[0,-1,0]]` (FreeSurfer's LIA cosines), `Pxyz_c = 0`.

use tvx_core::{Error, ProgressSink, Result};

use crate::common::{
    data_slice, decode_samples, finish, jmat, jnum, jnums, take_inflated, voxel_count, Meta,
};
use crate::{DataType, Volume};

/// Data offset: the fixed header is padded to this many bytes.
pub(crate) const HEADER_LEN: usize = 284;

fn be_i32(b: &[u8], o: usize) -> Result<i32> {
    let s = b
        .get(o..o + 4)
        .ok_or_else(|| Error::Parse(format!("MGH header truncated at byte {o}")))?;
    Ok(i32::from_be_bytes([s[0], s[1], s[2], s[3]]))
}
fn be_i16(b: &[u8], o: usize) -> Result<i16> {
    let s = b
        .get(o..o + 2)
        .ok_or_else(|| Error::Parse(format!("MGH header truncated at byte {o}")))?;
    Ok(i16::from_be_bytes([s[0], s[1]]))
}
fn be_f32(b: &[u8], o: usize) -> Result<f32> {
    Ok(f32::from_bits(be_i32(b, o)? as u32))
}

/// FreeSurfer `MRI_*` type codes.
fn datatype_of(code: i32) -> Result<DataType> {
    match code {
        0 => Ok(DataType::U8),
        1 => Ok(DataType::I32),
        3 => Ok(DataType::F32),
        4 => Ok(DataType::I16),
        10 => Ok(DataType::U16),
        2 => Err(Error::Unsupported("MGH type MRI_LONG (2)".into())),
        5 => Err(Error::Unsupported("MGH type MRI_BITMAP (5)".into())),
        6 => Err(Error::Unsupported("MGH type MRI_TENSOR (6)".into())),
        other => Err(Error::Parse(format!(
            "MGH type {other} is not a FreeSurfer type code"
        ))),
    }
}

/// Parse a `.mgh` / `.mgz` byte vector. Takes ownership and frees it before returning (§5 rule 5).
pub fn read_mgh(bytes: Vec<u8>, p: &mut dyn ProgressSink) -> Result<Volume> {
    let raw = take_inflated(bytes, p)?;
    read_mgh_raw(raw, p)
}

/// The MGH reader proper, over already-inflated bytes.
pub(crate) fn read_mgh_raw(raw: Vec<u8>, p: &mut dyn ProgressSink) -> Result<Volume> {
    use serde_json::{json, Map, Value};

    if raw.len() < HEADER_LEN {
        return Err(Error::Parse(format!(
            "MGH header is {HEADER_LEN} bytes, file has {}",
            raw.len()
        )));
    }
    let version = be_i32(&raw, 0)?;
    if version != 1 {
        return Err(Error::Parse(format!("MGH version {version}, expected 1")));
    }
    let dims_i = [
        be_i32(&raw, 4)?,
        be_i32(&raw, 8)?,
        be_i32(&raw, 12)?,
        be_i32(&raw, 16)?,
    ];
    if dims_i.iter().any(|&d| d <= 0) {
        return Err(Error::Parse(format!(
            "MGH dims {dims_i:?} must be positive"
        )));
    }
    let type_code = be_i32(&raw, 20)?;
    let datatype = datatype_of(type_code)?;
    let dof = be_i32(&raw, 24)?;
    let good_ras = be_i16(&raw, 28)?;
    let mut delta = [0f64; 3];
    let mut mdc = [[0f64; 3]; 3];
    let mut pxyz_c = [0f64; 3];
    for i in 0..3 {
        delta[i] = be_f32(&raw, 30 + 4 * i)? as f64;
        pxyz_c[i] = be_f32(&raw, 78 + 4 * i)? as f64;
        for (j, m) in mdc[i].iter_mut().enumerate() {
            *m = be_f32(&raw, 42 + 4 * (3 * i + j))? as f64;
        }
    }
    let on_disk = (delta, mdc, pxyz_c);
    let affine_source = if good_ras != 0 {
        "header (goodRASFlag = 1)"
    } else {
        // nibabel `MGHHeader._set_affine_default`.
        delta = [1.0; 3];
        mdc = [[-1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]];
        pxyz_c = [0.0; 3];
        "nibabel default (goodRASFlag = 0)"
    };

    let dims = [dims_i[0] as usize, dims_i[1] as usize, dims_i[2] as usize];
    let nvols = dims_i[3] as usize;
    let n_vox = voxel_count(dims, nvols)?;
    let src = data_slice(&raw, HEADER_LEN, n_vox, datatype)?;
    let data_end = HEADER_LEN + src.len();
    let data = decode_samples(src, n_vox, datatype, false, p)?;

    // Optional footer: five big-endian floats, then FreeSurfer tags (ignored, counted).
    let footer = &raw[data_end..];
    let mut hdr = Map::new();
    if footer.len() >= 20 {
        for (i, name) in ["tr", "flip_angle", "te", "ti", "fov"].iter().enumerate() {
            hdr.insert((*name).into(), jnum(be_f32(footer, 4 * i)? as f64));
        }
        hdr.insert("footerTagBytes".into(), json!(footer.len() - 20));
    }
    drop(raw);

    // nibabel: `MdcD = Mdc.T * delta; vol_center = MdcD.dot(dims[:3]) / 2; t = Pxyz_c - vol_center`.
    let mut affine = [[0f64; 4]; 4];
    affine[3] = [0.0, 0.0, 0.0, 1.0];
    for r in 0..3 {
        for c in 0..3 {
            affine[r][c] = mdc[c][r] * delta[c];
        }
        let center: f64 = (0..3).map(|c| affine[r][c] * dims[c] as f64).sum::<f64>() / 2.0;
        affine[r][3] = pxyz_c[r] - center;
    }

    hdr.insert("version".into(), json!(version));
    hdr.insert("width".into(), json!(dims_i[0]));
    hdr.insert("height".into(), json!(dims_i[1]));
    hdr.insert("depth".into(), json!(dims_i[2]));
    hdr.insert("nframes".into(), json!(dims_i[3]));
    hdr.insert("type".into(), json!(type_code));
    hdr.insert("typeName".into(), json!(datatype.name()));
    hdr.insert("dof".into(), json!(dof));
    hdr.insert("goodRASFlag".into(), json!(good_ras));
    hdr.insert("delta".into(), jnums(&on_disk.0));
    hdr.insert("x_ras".into(), jnums(&on_disk.1[0]));
    hdr.insert("y_ras".into(), jnums(&on_disk.1[1]));
    hdr.insert("z_ras".into(), jnums(&on_disk.1[2]));
    hdr.insert("Pxyz_c".into(), jnums(&on_disk.2));
    hdr.insert("endian".into(), json!("big"));
    hdr.insert("dataOffset".into(), json!(HEADER_LEN));
    hdr.insert("affine".into(), jmat(&affine));
    hdr.insert("affineSource".into(), json!(affine_source));

    let mut meta = Meta::new(dims, nvols, "MGH");
    meta.affine = affine;
    meta.spacing = [delta[0].abs(), delta[1].abs(), delta[2].abs()];
    meta.header_json = Value::Object(hdr).to_string();
    finish(meta, datatype, data, p)
}
