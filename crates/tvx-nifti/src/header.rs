//! The NIfTI-1 (348 B) and NIfTI-2 (540 B) fixed headers, in either byte order.
//!
//! Both layouts are decoded into one [`RawHeader`], widened to `i64` / `f64`, so that everything
//! downstream — affine, scaling, datatype, `header_json` — is written once (ARCHITECTURE.md §6.1).
//! The field offsets below are the ones in the NIfTI-1.1 / NIfTI-2 standard headers.

use tvx_core::{Error, Result};

pub(crate) const NIFTI1_HDR: usize = 348;
pub(crate) const NIFTI2_HDR: usize = 540;

/// A byte-order-aware reader over the fixed header block.
pub(crate) struct Rdr<'a> {
    b: &'a [u8],
    le: bool,
}

impl<'a> Rdr<'a> {
    fn at(&self, o: usize, n: usize) -> Result<&'a [u8]> {
        self.b
            .get(o..o + n)
            .ok_or_else(|| Error::Parse(format!("header truncated at byte {o}")))
    }
    fn i16(&self, o: usize) -> Result<i16> {
        let s = self.at(o, 2)?;
        let a = [s[0], s[1]];
        Ok(if self.le {
            i16::from_le_bytes(a)
        } else {
            i16::from_be_bytes(a)
        })
    }
    fn i32(&self, o: usize) -> Result<i32> {
        let s = self.at(o, 4)?;
        let a = [s[0], s[1], s[2], s[3]];
        Ok(if self.le {
            i32::from_le_bytes(a)
        } else {
            i32::from_be_bytes(a)
        })
    }
    fn i64(&self, o: usize) -> Result<i64> {
        let s = self.at(o, 8)?;
        let a = [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]];
        Ok(if self.le {
            i64::from_le_bytes(a)
        } else {
            i64::from_be_bytes(a)
        })
    }
    fn f32(&self, o: usize) -> Result<f32> {
        Ok(f32::from_bits(self.i32(o)? as u32))
    }
    fn f64(&self, o: usize) -> Result<f64> {
        Ok(f64::from_bits(self.i64(o)? as u64))
    }
    /// A NUL-padded fixed-width string field. Invalid UTF-8 is replaced, never rejected — a bad
    /// `descrip` must not stop a volume from loading.
    fn cstr(&self, o: usize, n: usize) -> Result<String> {
        let s = self.at(o, n)?;
        let end = s.iter().position(|&c| c == 0).unwrap_or(n);
        Ok(String::from_utf8_lossy(&s[..end]).trim_end().to_string())
    }
}

/// Fields that exist only in the NIfTI-1 header, kept for `header_json` (§6.1: "every raw header
/// field, for the UI header panel").
#[derive(Clone, Debug, Default)]
pub(crate) struct N1Extras {
    pub data_type: String,
    pub db_name: String,
    pub extents: i32,
    pub session_error: i16,
    pub regular: String,
    pub glmax: i32,
    pub glmin: i32,
}

/// One NIfTI header, version-independent.
#[derive(Clone, Debug)]
pub(crate) struct RawHeader {
    pub version: u8,
    pub little_endian: bool,
    pub sizeof_hdr: i64,
    pub dim: [i64; 8],
    pub intent_p: [f64; 3],
    pub intent_code: i32,
    pub datatype: i16,
    pub bitpix: i16,
    pub slice_start: i64,
    pub slice_end: i64,
    pub pixdim: [f64; 8],
    pub vox_offset: i64,
    pub scl_slope: f64,
    pub scl_inter: f64,
    pub slice_code: i32,
    pub xyzt_units: i32,
    pub cal_max: f64,
    pub cal_min: f64,
    pub slice_duration: f64,
    pub toffset: f64,
    pub descrip: String,
    pub aux_file: String,
    pub qform_code: i32,
    pub sform_code: i32,
    pub quatern: [f64; 3],
    pub qoffset: [f64; 3],
    pub srow: [[f64; 4]; 3],
    pub intent_name: String,
    pub dim_info: u8,
    pub magic: String,
    pub n1: Option<N1Extras>,
}

/// `(version, little_endian, header_len)` from `sizeof_hdr` alone — the only field whose value is
/// fixed by the standard, and therefore the only reliable byte-order probe.
fn sniff(b: &[u8]) -> Result<(u8, bool, usize)> {
    let head = b
        .get(0..4)
        .ok_or_else(|| Error::Parse("file is shorter than a NIfTI header".into()))?;
    let a = [head[0], head[1], head[2], head[3]];
    match i32::from_le_bytes(a) {
        348 => return Ok((1, true, NIFTI1_HDR)),
        540 => return Ok((2, true, NIFTI2_HDR)),
        _ => {}
    }
    match i32::from_be_bytes(a) {
        348 => Ok((1, false, NIFTI1_HDR)),
        540 => Ok((2, false, NIFTI2_HDR)),
        other => Err(Error::Parse(format!(
            "not a NIfTI file: sizeof_hdr is {} (little-endian) / {other} (big-endian), \
             expected 348 or 540",
            i32::from_le_bytes(a)
        ))),
    }
}

impl RawHeader {
    pub fn parse(b: &[u8]) -> Result<Self> {
        let (version, le, len) = sniff(b)?;
        if b.len() < len {
            return Err(Error::Parse(format!(
                "NIfTI-{version} header needs {len} bytes, file has {}",
                b.len()
            )));
        }
        let r = Rdr { b, le };
        let h = if version == 1 {
            Self::parse_v1(&r, le)?
        } else {
            Self::parse_v2(&r, le)?
        };
        h.check_magic()?;
        Ok(h)
    }

    fn parse_v1(r: &Rdr, le: bool) -> Result<Self> {
        let mut dim = [0i64; 8];
        for (i, d) in dim.iter_mut().enumerate() {
            *d = r.i16(40 + 2 * i)? as i64;
        }
        let mut pixdim = [0f64; 8];
        for (i, p) in pixdim.iter_mut().enumerate() {
            *p = r.f32(76 + 4 * i)? as f64;
        }
        let mut srow = [[0f64; 4]; 3];
        for (row, dst) in srow.iter_mut().enumerate() {
            for (col, v) in dst.iter_mut().enumerate() {
                *v = r.f32(280 + 16 * row + 4 * col)? as f64;
            }
        }
        Ok(RawHeader {
            version: 1,
            little_endian: le,
            sizeof_hdr: 348,
            dim,
            intent_p: [r.f32(56)? as f64, r.f32(60)? as f64, r.f32(64)? as f64],
            intent_code: r.i16(68)? as i32,
            datatype: r.i16(70)?,
            bitpix: r.i16(72)?,
            slice_start: r.i16(74)? as i64,
            slice_end: r.i16(120)? as i64,
            pixdim,
            vox_offset: r.f32(108)? as i64,
            scl_slope: r.f32(112)? as f64,
            scl_inter: r.f32(116)? as f64,
            slice_code: r.at(122, 1)?[0] as i32,
            xyzt_units: r.at(123, 1)?[0] as i32,
            cal_max: r.f32(124)? as f64,
            cal_min: r.f32(128)? as f64,
            slice_duration: r.f32(132)? as f64,
            toffset: r.f32(136)? as f64,
            descrip: r.cstr(148, 80)?,
            aux_file: r.cstr(228, 24)?,
            qform_code: r.i16(252)? as i32,
            sform_code: r.i16(254)? as i32,
            quatern: [r.f32(256)? as f64, r.f32(260)? as f64, r.f32(264)? as f64],
            qoffset: [r.f32(268)? as f64, r.f32(272)? as f64, r.f32(276)? as f64],
            srow,
            intent_name: r.cstr(328, 16)?,
            dim_info: r.at(39, 1)?[0],
            magic: r.cstr(344, 4)?,
            n1: Some(N1Extras {
                data_type: r.cstr(4, 10)?,
                db_name: r.cstr(14, 18)?,
                extents: r.i32(32)?,
                session_error: r.i16(36)?,
                regular: r.cstr(38, 1)?,
                glmax: r.i32(140)?,
                glmin: r.i32(144)?,
            }),
        })
    }

    fn parse_v2(r: &Rdr, le: bool) -> Result<Self> {
        let mut dim = [0i64; 8];
        for (i, d) in dim.iter_mut().enumerate() {
            *d = r.i64(16 + 8 * i)?;
        }
        let mut pixdim = [0f64; 8];
        for (i, p) in pixdim.iter_mut().enumerate() {
            *p = r.f64(104 + 8 * i)?;
        }
        let mut srow = [[0f64; 4]; 3];
        for (row, dst) in srow.iter_mut().enumerate() {
            for (col, v) in dst.iter_mut().enumerate() {
                *v = r.f64(400 + 32 * row + 8 * col)?;
            }
        }
        Ok(RawHeader {
            version: 2,
            little_endian: le,
            sizeof_hdr: 540,
            dim,
            intent_p: [r.f64(80)?, r.f64(88)?, r.f64(96)?],
            intent_code: r.i32(504)?,
            datatype: r.i16(12)?,
            bitpix: r.i16(14)?,
            slice_start: r.i64(224)?,
            slice_end: r.i64(232)?,
            pixdim,
            vox_offset: r.i64(168)?,
            scl_slope: r.f64(176)?,
            scl_inter: r.f64(184)?,
            slice_code: r.i32(496)?,
            xyzt_units: r.i32(500)?,
            cal_max: r.f64(192)?,
            cal_min: r.f64(200)?,
            slice_duration: r.f64(208)?,
            toffset: r.f64(216)?,
            descrip: r.cstr(240, 80)?,
            aux_file: r.cstr(320, 24)?,
            qform_code: r.i32(344)?,
            sform_code: r.i32(348)?,
            quatern: [r.f64(352)?, r.f64(360)?, r.f64(368)?],
            qoffset: [r.f64(376)?, r.f64(384)?, r.f64(392)?],
            srow,
            intent_name: r.cstr(508, 16)?,
            dim_info: r.at(524, 1)?[0],
            magic: r.cstr(4, 8)?,
            n1: None,
        })
    }

    /// §6.1: the two-file `ni1` / `ni2` pair is `Error::Unsupported("two-file NIfTI")`.
    fn check_magic(&self) -> Result<()> {
        match (self.version, self.magic.as_str()) {
            (1, "n+1") | (2, "n+2") => Ok(()),
            (1, "ni1") | (2, "ni2") => Err(Error::Unsupported(
                "two-file NIfTI (.hdr/.img); only the single-file form is supported".into(),
            )),
            (v, m) => Err(Error::Parse(format!(
                "NIfTI-{v} magic is {m:?}, expected \"n+{v}\" or \"ni{v}\""
            ))),
        }
    }

    /// `dim[0]` clamped into the range the standard allows, so a corrupt value cannot index past
    /// `dim`.
    pub fn ndim(&self) -> usize {
        self.dim[0].clamp(0, 7) as usize
    }

    /// The three spatial extents, with the standard's "0 means 1" normalisation.
    pub fn spatial_dims(&self) -> Result<[usize; 3]> {
        let nd = self.ndim();
        let mut out = [1usize; 3];
        for (i, o) in out.iter_mut().enumerate() {
            if i < nd {
                let d = self.dim[i + 1];
                if d < 0 {
                    return Err(Error::Parse(format!("dim[{}] is {d}", i + 1)));
                }
                *o = if d == 0 { 1 } else { d as usize };
            }
        }
        Ok(out)
    }

    /// Everything past the third axis collapses into one volume index (§6.1: 4D with `nvols`).
    pub fn nvols(&self) -> Result<usize> {
        let mut n: usize = 1;
        for i in 4..=self.ndim() {
            let d = self.dim[i];
            if d < 0 {
                return Err(Error::Parse(format!("dim[{i}] is {d}")));
            }
            let d = if d == 0 { 1 } else { d as usize };
            n = n
                .checked_mul(d)
                .ok_or_else(|| Error::Parse("volume count overflows".into()))?;
        }
        Ok(n)
    }

    pub fn qfac(&self) -> f64 {
        if self.pixdim[0] < 0.0 {
            -1.0
        } else {
            1.0
        }
    }
}
