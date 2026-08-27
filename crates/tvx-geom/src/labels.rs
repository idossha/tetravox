//! `label_centroids` (§6.3) — one label's centre of mass, for Phase 2's jump-to-centroid.

use crate::voxel;
use crate::LabelCentroid;
use tvx_core::{Error, Result};
use tvx_nifti::Volume;

/// Refuse rather than allocate an accumulator per id for a volume that is not a label volume.
/// `labeling.nii.gz` reaches id 530 `[DATA]`; FreeSurfer's `aparc+aseg` reaches ~2035.
const MAX_ID: u32 = 1 << 22;

pub fn label_centroids(vol: &Volume, vol_index: usize) -> Result<Vec<LabelCentroid>> {
    let [nx, ny, nz] = vol.dims;
    let voxels = nx * ny * nz;
    if vol_index >= vol.nvols || voxels == 0 {
        return Err(Error::Parse(format!(
            "label_centroids: frame {vol_index} of a {}-frame {nx}x{ny}x{nz} volume",
            vol.nvols
        )));
    }
    if voxel::len(&vol.data) < voxels * (vol_index + 1) {
        return Err(Error::Parse(
            "label_centroids: volume is shorter than its dims".into(),
        ));
    }
    let base = vol_index * voxels;

    let mut max_id = 0u32;
    for i in 0..voxels {
        if let Some(id) = voxel::label(&vol.data, base + i) {
            if id > max_id {
                max_id = id;
            }
        }
    }
    if max_id > MAX_ID {
        return Err(Error::Unsupported(format!(
            "label_centroids: largest id {max_id} exceeds {MAX_ID}; this is not a label volume"
        )));
    }

    let n = max_id as usize + 1;
    let mut count = vec![0u64; n];
    // Accumulate in voxel space and transform the *mean* once, which is exact for an affine map
    // and avoids 13.6 M matrix multiplies.
    let mut sum = vec![[0.0f64; 3]; n];
    for k in 0..nz {
        for j in 0..ny {
            for i in 0..nx {
                let li = (k * ny + j) * nx + i;
                if let Some(id) = voxel::label(&vol.data, base + li) {
                    let s = &mut sum[id as usize];
                    s[0] += i as f64;
                    s[1] += j as f64;
                    s[2] += k as f64;
                    count[id as usize] += 1;
                }
            }
        }
    }

    let a = &vol.affine;
    let mut out = Vec::new();
    for id in 0..n {
        if count[id] == 0 {
            continue;
        }
        let c = count[id] as f64;
        let (x, y, z) = (sum[id][0] / c, sum[id][1] / c, sum[id][2] / c);
        out.push(LabelCentroid {
            id: id as u32,
            centroid: [
                (a[0][0] * x + a[0][1] * y + a[0][2] * z + a[0][3]) as f32,
                (a[1][0] * x + a[1][1] * y + a[1][2] * z + a[1][3]) as f32,
                (a[2][0] * x + a[2][1] * y + a[2][2] * z + a[2][3]) as f32,
            ],
            count: count[id],
        });
    }
    Ok(out)
}
