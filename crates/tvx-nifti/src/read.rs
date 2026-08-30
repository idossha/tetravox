//! `read_nifti` — magic sniff, inflate, header, samples (ARCHITECTURE.md §6.1).

use tvx_core::{Error, ProgressSink, Result};

use crate::common::{
    data_slice, decode_samples, finish, jnum, jnums, take_inflated, voxel_count, Meta,
};
use crate::header::RawHeader;
use crate::{DataType, SpaceUnit, TimeUnit, Units, Volume};

/// §6.1's accepted datatypes, and the rejections *by name*.
fn datatype_of(code: i16) -> Result<DataType> {
    let name = |n: &str| Err(Error::Unsupported(format!("NIfTI datatype {n} ({code})")));
    match code {
        2 => Ok(DataType::U8),
        256 => Ok(DataType::I8),
        512 => Ok(DataType::U16),
        4 => Ok(DataType::I16),
        768 => Ok(DataType::U32),
        8 => Ok(DataType::I32),
        16 => Ok(DataType::F32),
        64 => Ok(DataType::F64),
        128 => Ok(DataType::Rgb24),
        2304 => Ok(DataType::Rgba32),
        32 => name("complex64"),
        1792 => name("complex128"),
        2048 => name("complex256"),
        1024 => name("int64"),
        1280 => name("uint64"),
        1536 => name("float128"),
        1 => name("binary (1 bit per voxel)"),
        0 => name("unknown (0)"),
        _ => name("unrecognised"),
    }
}

impl DataType {
    /// Bytes on disk per voxel.
    pub(crate) fn size(self) -> usize {
        match self {
            DataType::U8 | DataType::I8 => 1,
            DataType::U16 | DataType::I16 => 2,
            DataType::U32 | DataType::I32 | DataType::F32 | DataType::Rgba32 => 4,
            DataType::F64 => 8,
            DataType::Rgb24 => 3,
        }
    }
    pub(crate) fn name(self) -> &'static str {
        match self {
            DataType::U8 => "uint8",
            DataType::I8 => "int8",
            DataType::U16 => "uint16",
            DataType::I16 => "int16",
            DataType::U32 => "uint32",
            DataType::I32 => "int32",
            DataType::F32 => "float32",
            DataType::F64 => "float64",
            DataType::Rgb24 => "rgb24",
            DataType::Rgba32 => "rgba32",
        }
    }
    /// True for the two colour types, which §4.2's scalar display model does not cover.
    pub(crate) fn is_color(self) -> bool {
        matches!(self, DataType::Rgb24 | DataType::Rgba32)
    }
}

fn units_of(xyzt: i32) -> Units {
    Units {
        space: match xyzt & 0x07 {
            1 => SpaceUnit::Meter,
            2 => SpaceUnit::Millimeter,
            3 => SpaceUnit::Micron,
            _ => SpaceUnit::Unknown,
        },
        time: match xyzt & 0x38 {
            8 => TimeUnit::Second,
            16 => TimeUnit::Millisecond,
            24 => TimeUnit::Microsecond,
            32 => TimeUnit::Hz,
            40 => TimeUnit::Ppm,
            48 => TimeUnit::Rads,
            _ => TimeUnit::Unknown,
        },
    }
}

/// §3: sform when `sform_code > 0`, else the qform with **`qfac` on the third column only**, else
/// `diag(pixdim[1..4], 1)`. Row-major `m[row][col]`.
fn affine_of(h: &RawHeader) -> ([[f64; 4]; 4], &'static str) {
    let mut m = [[0f64; 4]; 4];
    m[3] = [0.0, 0.0, 0.0, 1.0];
    if h.sform_code > 0 {
        m[0] = h.srow[0];
        m[1] = h.srow[1];
        m[2] = h.srow[2];
        return (m, "sform");
    }
    if h.qform_code > 0 {
        let (b, c, d) = (h.quatern[0], h.quatern[1], h.quatern[2]);
        let a = (1.0 - (b * b + c * c + d * d)).max(0.0).sqrt();
        let r = [
            [
                a * a + b * b - c * c - d * d,
                2.0 * (b * c - a * d),
                2.0 * (b * d + a * c),
            ],
            [
                2.0 * (b * c + a * d),
                a * a + c * c - b * b - d * d,
                2.0 * (c * d - a * b),
            ],
            [
                2.0 * (b * d - a * c),
                2.0 * (c * d + a * b),
                a * a + d * d - b * b - c * c,
            ],
        ];
        let s = [h.pixdim[1], h.pixdim[2], h.pixdim[3] * h.qfac()];
        for (row, dst) in m.iter_mut().take(3).enumerate() {
            for col in 0..3 {
                dst[col] = r[row][col] * s[col];
            }
            dst[3] = h.qoffset[row];
        }
        return (m, "qform");
    }
    for (i, dst) in m.iter_mut().take(3).enumerate() {
        dst[i] = h.pixdim[i + 1];
    }
    (m, "pixdim")
}

fn header_json(h: &RawHeader, affine_source: &str) -> String {
    use serde_json::{json, Map, Value};
    let mut m = Map::new();
    m.insert("niftiVersion".into(), json!(h.version));
    m.insert(
        "endian".into(),
        json!(if h.little_endian { "little" } else { "big" }),
    );
    m.insert("sizeof_hdr".into(), json!(h.sizeof_hdr));
    m.insert("dim_info".into(), json!(h.dim_info));
    m.insert("dim".into(), json!(h.dim));
    m.insert("intent_p1".into(), jnum(h.intent_p[0]));
    m.insert("intent_p2".into(), jnum(h.intent_p[1]));
    m.insert("intent_p3".into(), jnum(h.intent_p[2]));
    m.insert("intent_code".into(), json!(h.intent_code));
    m.insert("datatype".into(), json!(h.datatype));
    m.insert("bitpix".into(), json!(h.bitpix));
    m.insert("slice_start".into(), json!(h.slice_start));
    m.insert("pixdim".into(), jnums(&h.pixdim));
    m.insert("vox_offset".into(), json!(h.vox_offset));
    m.insert("scl_slope".into(), jnum(h.scl_slope));
    m.insert("scl_inter".into(), jnum(h.scl_inter));
    m.insert("slice_end".into(), json!(h.slice_end));
    m.insert("slice_code".into(), json!(h.slice_code));
    m.insert("xyzt_units".into(), json!(h.xyzt_units));
    m.insert("cal_max".into(), jnum(h.cal_max));
    m.insert("cal_min".into(), jnum(h.cal_min));
    m.insert("slice_duration".into(), jnum(h.slice_duration));
    m.insert("toffset".into(), jnum(h.toffset));
    m.insert("descrip".into(), json!(h.descrip));
    m.insert("aux_file".into(), json!(h.aux_file));
    m.insert("qform_code".into(), json!(h.qform_code));
    m.insert("sform_code".into(), json!(h.sform_code));
    m.insert("quatern_b".into(), jnum(h.quatern[0]));
    m.insert("quatern_c".into(), jnum(h.quatern[1]));
    m.insert("quatern_d".into(), jnum(h.quatern[2]));
    m.insert("qoffset_x".into(), jnum(h.qoffset[0]));
    m.insert("qoffset_y".into(), jnum(h.qoffset[1]));
    m.insert("qoffset_z".into(), jnum(h.qoffset[2]));
    m.insert("srow_x".into(), jnums(&h.srow[0]));
    m.insert("srow_y".into(), jnums(&h.srow[1]));
    m.insert("srow_z".into(), jnums(&h.srow[2]));
    m.insert("intent_name".into(), json!(h.intent_name));
    m.insert("magic".into(), json!(h.magic));
    if let Some(n1) = &h.n1 {
        m.insert("data_type".into(), json!(n1.data_type));
        m.insert("db_name".into(), json!(n1.db_name));
        m.insert("extents".into(), json!(n1.extents));
        m.insert("session_error".into(), json!(n1.session_error));
        m.insert("regular".into(), json!(n1.regular));
        m.insert("glmax".into(), json!(n1.glmax));
        m.insert("glmin".into(), json!(n1.glmin));
    }
    // Derived, so the header panel can show what the reader actually did with the header.
    m.insert("qfac".into(), jnum(h.qfac()));
    m.insert("affineSource".into(), json!(affine_source));
    Value::Object(m).to_string()
}

/// Parse a `.nii` / `.nii.gz` byte vector. Takes ownership and frees it before returning (§5 rule 5).
pub fn read_nifti(bytes: Vec<u8>, p: &mut dyn ProgressSink) -> Result<Volume> {
    let raw = take_inflated(bytes, p)?;
    read_nifti_raw(raw, p)
}

/// The NIfTI reader proper, over already-inflated bytes — `read_volume` (§6.1) lands here after its
/// own single inflate. Frees `raw` before returning.
pub(crate) fn read_nifti_raw(raw: Vec<u8>, p: &mut dyn ProgressSink) -> Result<Volume> {
    let h = RawHeader::parse(&raw)?;
    let datatype = datatype_of(h.datatype)?;
    let dims = h.spatial_dims()?;
    let nvols = h.nvols()?;
    let n_vox = voxel_count(dims, nvols)?;

    let hdr_len = if h.version == 1 { 348 } else { 540 };
    let off = if h.vox_offset < hdr_len as i64 {
        hdr_len
    } else {
        h.vox_offset as usize
    };
    let src = data_slice(&raw, off, n_vox, datatype)?;
    let data = decode_samples(src, n_vox, datatype, h.little_endian, p)?;
    drop(raw);

    let (affine, affine_source) = affine_of(&h);
    let mut meta = Meta::new(dims, nvols, &h.descrip);
    meta.affine = affine;
    meta.spacing = [h.pixdim[1].abs(), h.pixdim[2].abs(), h.pixdim[3].abs()];
    meta.scl_slope = h.scl_slope;
    meta.scl_inter = h.scl_inter;
    meta.cal_min = h.cal_min as f32;
    meta.cal_max = h.cal_max as f32;
    meta.intent_code = h.intent_code as i16;
    meta.intent_name = h.intent_name.clone();
    meta.xyz_units = units_of(h.xyzt_units);
    meta.header_json = header_json(&h, affine_source);
    finish(meta, datatype, data, p)
}
