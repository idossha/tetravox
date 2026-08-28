"""`make_ct.py`: the HU table, the rotated grid, the contact rasteriser and the two encodings.

Everything except the last class runs without the reference dataset — the geometry is exercised on
a synthetic head so a machine with no `sub-ernie` still gets the coverage.
"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import make_ct as M  # noqa: E402
import niftiref as N  # noqa: E402

TMP = Path(
    "/private/tmp/claude-501/-Users-idohaber-01-production-TI-toolbox/"
    "4f5f3999-31ec-4eb1-8431-0a7a3cb91177/scratchpad"
)
ERNIE = Path(
    os.environ.get(
        "TETRAVOX_TESTDATA", "/Users/idohaber/datasets/000/derivatives/SimNIBS/sub-ernie"
    )
)
M2M = ERNIE / "m2m_ernie"


class TestHuTable(unittest.TestCase):
    def test_the_tissues_the_brief_names(self):
        want = {0: -1000, 1: 30, 2: 37, 3: 15, 5: 40, 6: 20, 7: 1200, 8: 300, 9: 45, 10: 50}
        for ident, hu in want.items():
            self.assertEqual(M.TISSUE_HU[ident], hu, f"label {ident}")

    def test_mapping_is_a_lookup_not_a_ramp(self):
        labels = np.array([[[0, 1], [2, 7]]], dtype=np.uint16)
        hu = M.label_to_hu(labels)
        np.testing.assert_array_equal(hu, [[[-1000, 30], [37, 1200]]])

    def test_unknown_ids_fall_back_to_air(self):
        self.assertEqual(float(M.label_to_hu(np.array([[[99]]], dtype=np.uint16))[0, 0, 0]), -1000)


class TestGrid(unittest.TestCase):
    def test_rotation_is_orthonormal_and_of_the_asked_angle(self):
        r = M.rotation_matrix([1, 2, 3], 5.0)
        np.testing.assert_allclose(r @ r.T, np.eye(3), atol=1e-12)
        self.assertAlmostEqual(float(np.linalg.det(r)), 1.0, places=12)
        # trace = 1 + 2 cos(theta)
        self.assertAlmostEqual(
            float(np.degrees(np.arccos((np.trace(r) - 1) / 2))), 5.0, places=9
        )

    def test_the_grid_is_isotropic_and_covers_the_corners(self):
        corners = np.array(
            [[x, y, z] for x in (-50.0, 60.0) for y in (-40.0, 70.0) for z in (-30.0, 80.0)]
        )
        g = M.ct_grid(corners, spacing=0.7, tilt_deg=5.0, margin=6.0)
        for c in range(3):
            self.assertAlmostEqual(float(np.linalg.norm(g.affine[:3, c])), 0.7, places=12)
        inv = np.linalg.inv(g.affine)
        vox = corners @ inv[:3, :3].T + inv[:3, 3]
        self.assertTrue(np.all(vox > 0), "every corner is inside the grid")
        self.assertTrue(np.all(vox < np.asarray(g.dims) - 1), "with room to spare")

    def test_the_origin_is_offset_by_a_non_integer_number_of_voxels(self):
        """So no CT voxel centre lands on a T1 one and a resample cannot be right by accident."""
        corners = np.array([[0.0, 0, 0], [100.0, 100, 100]])
        g = M.ct_grid(corners, spacing=0.7, tilt_deg=5.0, margin=6.0)
        inv = np.linalg.inv(g.affine)
        vox = np.array([0.0, 0.0, 0.0]) @ inv[:3, :3].T + inv[:3, 3]
        self.assertTrue(np.all(np.abs(vox - np.rint(vox)) > 1e-3), vox)

    def test_world_of_slab_agrees_with_the_affine(self):
        g = M.Grid(affine=np.diag([0.7, 0.7, 0.7, 1.0]), dims=(3, 4, 5))
        g.affine[:3, 3] = [1.0, 2.0, 3.0]
        w = g.world_of_slab(2)
        np.testing.assert_allclose(w[1, 3], [1 + 0.7, 2 + 3 * 0.7, 3 + 2 * 0.7], atol=1e-12)


def sphere_head(radius=40.0, spacing=1.0, dims=(96, 96, 96)):
    """A synthetic head: a scalp shell, a bone shell and a brain core, on an identity-ish affine."""
    affine = np.diag([spacing, spacing, spacing, 1.0])
    affine[:3, 3] = -np.asarray(dims) * spacing / 2
    idx = np.indices(dims).astype(np.float64)
    world = np.stack(
        [affine[c, c] * idx[c] + affine[c, 3] for c in range(3)], axis=-1
    )
    r = np.linalg.norm(world, axis=-1)
    labels = np.zeros(dims, dtype=np.int16)
    labels[r <= radius] = 5  # scalp
    labels[r <= radius - 4] = 7  # compact bone
    labels[r <= radius - 8] = 2  # grey matter
    return labels, affine


class TestTrajectories(unittest.TestCase):
    def setUp(self):
        self.labels, self.affine = sphere_head()
        self.inv = np.linalg.inv(self.affine)

    def test_marching_stops_just_outside_the_scalp(self):
        entry = M.march_to_air(self.labels, self.inv, [0, 0, 0], [1, 0, 0])
        self.assertAlmostEqual(float(np.linalg.norm(entry)), 40.0, delta=1.5)

    def test_a_lead_crosses_bone_on_its_way_out(self):
        lead = M.build_lead("test", [0, 0, 0], [1, 0.2, 0.1], self.labels, self.inv)
        self.assertIn(7, lead.tissues, "the trajectory must pass through compact bone")
        self.assertEqual(lead.tissues[-1], 0, "and end in air")
        self.assertEqual(len(lead.contacts), M.CONTACTS_PER_LEAD)

    def test_contacts_are_spaced_by_the_pitch(self):
        lead = M.build_lead("test", [0, 0, 0], [1, 0, 0], self.labels, self.inv)
        starts = np.array([c[0] for c in lead.contacts])
        gaps = np.linalg.norm(np.diff(starts, axis=0), axis=1)
        np.testing.assert_allclose(gaps, M.CONTACT_PITCH_MM, atol=1e-9)
        length = np.linalg.norm(lead.contacts[0][1] - lead.contacts[0][0])
        self.assertAlmostEqual(float(length), M.CONTACT_LENGTH_MM, places=9)


class TestContactRaster(unittest.TestCase):
    def test_a_fully_enclosed_voxel_reads_exactly_3000_hu(self):
        grid = M.Grid(affine=np.diag([0.35, 0.35, 0.35, 1.0]), dims=(40, 40, 40))
        grid.affine[:3, 3] = [-7.0, -7.0, -7.0]
        vol = np.zeros(grid.dims, dtype=np.float32)
        lead = M.Lead(
            name="x", tip=np.zeros(3), entry=np.zeros(3),
            contacts=[(np.array([0.0, 0.0, -1.0]), np.array([0.0, 0.0, 1.0]))], tissues=[],
        )
        n = M.stamp_contacts(vol, grid, [lead])
        self.assertGreater(n, 0)
        self.assertEqual(float(vol.max()), M.METAL_HU, "a fully enclosed voxel is not diluted")
        # Total coverage — the sum of the partial-volume fractions — is the cylinder's volume.
        # (`n` counts every voxel the cylinder *touches*, which is necessarily larger.)
        covered = float(vol.sum()) / M.METAL_HU
        expected = np.pi * (M.CONTACT_DIAMETER_MM / 2) ** 2 * M.CONTACT_LENGTH_MM / 0.35**3
        self.assertLess(abs(covered - expected) / expected, 0.05, f"{covered} vs {expected}")
        self.assertGreater(n, covered, "partial-volume voxels exist at this scale")

    def test_nothing_outside_the_radius_is_touched(self):
        grid = M.Grid(affine=np.diag([0.35, 0.35, 0.35, 1.0]), dims=(40, 40, 40))
        grid.affine[:3, 3] = [-7.0, -7.0, -7.0]
        vol = np.zeros(grid.dims, dtype=np.float32)
        lead = M.Lead("x", np.zeros(3), np.zeros(3),
                      [(np.array([0.0, 0.0, -1.0]), np.array([0.0, 0.0, 1.0]))], [])
        M.stamp_contacts(vol, grid, [lead])
        hit = np.argwhere(vol > 0).astype(float)
        world = hit @ grid.affine[:3, :3].T + grid.affine[:3, 3]
        radial = np.linalg.norm(world[:, :2], axis=1)
        # A voxel is touched only if part of it is inside; its centre can be one half-diagonal out.
        self.assertLess(float(radial.max()), M.CONTACT_DIAMETER_MM / 2 + 0.35 * np.sqrt(3) / 2)
        self.assertLess(float(np.abs(world[:, 2]).max()), 1.0 + 0.35 * np.sqrt(3) / 2)


class TestEncodings(unittest.TestCase):
    """The two files, and the §6.1 rule they exist to exercise."""

    def setUp(self):
        TMP.mkdir(parents=True, exist_ok=True)
        self.hu = np.array(
            [[[-1000.0, -50.0], [0.0, 37.0]], [[300.0, 1200.0], [3000.0, 12.0]]]
        )
        self.affine = np.eye(4)
        self.affine[:3, :3] = M.rotation_matrix([1, 2, 3], 5.0) * 0.7
        self.affine[:3, 3] = [1.5, -2.5, 3.5]
        self.u16 = TMP / "ct-encoding-uint16.nii.gz"
        self.i16 = TMP / "ct-encoding-int16.nii.gz"
        M.write_nifti_raw(
            self.u16, np.clip(self.hu + 1024.0, 0, 65535).astype(np.uint16), self.affine,
            slope=1.0, inter=-1024.0, descrip="synthetic CT (HU)",
        )
        M.write_nifti_raw(
            self.i16, self.hu.astype(np.int16), self.affine, slope=1.0, inter=0.0,
            descrip="synthetic CT (HU)",
        )

    def test_uint16_carries_the_hu_in_scl_inter(self):
        stored = np.clip(self.hu + 1024.0, 0, 65535).astype(np.uint16)
        vol = N.load_volume(self.u16)
        self.assertEqual(vol.raw.dtype, np.uint16)
        self.assertEqual((vol.scl_slope, vol.scl_inter), (1.0, -1024.0))
        self.assertEqual(vol.header.descrip, "synthetic CT (HU)")
        np.testing.assert_array_equal(vol.frame(0), stored, "samples stay RAW on disk")
        np.testing.assert_allclose(vol.physical(0), self.hu, atol=1e-6)

    def test_int16_carries_the_hu_directly(self):
        vol = N.load_volume(self.i16)
        self.assertEqual(vol.raw.dtype, np.int16)
        # §6.1 normalises the identity to (1, 0): "no scaling".
        self.assertEqual((vol.scl_slope, vol.scl_inter), (1.0, 0.0))
        np.testing.assert_allclose(vol.physical(0), self.hu, atol=1e-6)

    def test_the_two_encodings_agree_and_the_affine_survives(self):
        a = N.load_volume(self.u16)
        b = N.load_volume(self.i16)
        np.testing.assert_allclose(a.physical(0), b.physical(0), atol=1e-6)
        np.testing.assert_allclose(a.affine, self.affine, atol=1e-4)
        np.testing.assert_allclose(b.affine, self.affine, atol=1e-4)

    def test_a_ct_is_not_mistaken_for_a_label_volume(self):
        """§6.1's `is_label` wants integral values **and** min >= 0; HU is signed."""
        self.assertFalse(N.load_volume(self.i16).is_label)


@unittest.skipUnless(
    (M2M / "final_tissues.nii.gz").exists(), f"reference dataset not at {M2M}"
)
class TestRealCt(unittest.TestCase):
    """One coarse end-to-end build on ernie — the same code path, 8x fewer voxels."""

    @classmethod
    def setUpClass(cls):
        cls.report = M.build(M2M, TMP / "ct-selftest", spacing=2.0, tilt_deg=5.0, margin=6.0)

    def test_both_leads_enter_through_the_skull(self):
        self.assertEqual(len(self.report["leads"]), 2)
        for lead in self.report["leads"]:
            self.assertTrue(lead["crossesBone"], lead["name"])
            self.assertEqual(lead["tissueSequence"][-1], 0, "the trajectory ends in air")
            self.assertGreater(lead["lengthMm"], 30.0)

    def test_the_hu_range_is_a_ct_range(self):
        hu = self.report["hu"]
        self.assertLess(hu["min"], -900.0)
        self.assertLess(hu["p50"], -500.0, "most of the field of view is air")
        # At this deliberately coarse 2 mm build no voxel is fully inside a 1.3 mm contact, so the
        # peak is partial-volume metal rather than 3000 exactly — it still has to be unambiguously
        # brighter than bone. The shipped 0.7 mm build does reach 3000 (see the raster unit test).
        self.assertLessEqual(hu["max"], M.METAL_HU)
        self.assertGreater(hu["max"], 1300.0)
        self.assertGreaterEqual(
            self.report["metalVoxels"], 2 * M.CONTACTS_PER_LEAD, "every contact reached a voxel"
        )

    def test_each_tissue_lands_near_its_nominal_hu(self):
        """Noise is σ = 15, so a well-interior tissue's mean must be within a few HU."""
        for ident in ("1", "2", "5", "6"):
            s = self.report["perTissue"][ident]
            self.assertLess(abs(s["mean"] - s["nominalHu"]), 5.0, f"label {ident}")
        # Bone is a thin, high-contrast structure: partial volume pulls its mean down, but it must
        # stay far above every soft tissue.
        self.assertGreater(self.report["perTissue"]["7"]["mean"], 800.0)

    def test_the_grid_is_not_the_t1_grid(self):
        ct = np.asarray(self.report["affine"])
        t1 = np.asarray(self.report["t1Affine"])
        self.assertGreater(float(np.abs(ct - t1).max()), 1.0)
        for c in range(3):
            self.assertAlmostEqual(float(np.linalg.norm(ct[:3, c])), 2.0, places=6)

    def test_the_written_files_read_back_as_hu(self):
        u16 = N.load_volume(TMP / "ct-selftest" / "ct_hu_uint16.nii.gz")
        i16 = N.load_volume(TMP / "ct-selftest" / "ct_hu_int16.nii.gz")
        self.assertEqual((u16.scl_slope, u16.scl_inter), (1.0, -1024.0))
        self.assertEqual((i16.scl_slope, i16.scl_inter), (1.0, 0.0))
        self.assertEqual(u16.header.descrip, "synthetic CT (HU)")
        pa, pb = u16.physical(0), i16.physical(0)
        # The one difference between the files: uint16 has no code below -1024 HU, so the noise
        # floor clips there. Everywhere else the two must be bit-identical after scaling.
        keep = pb >= -1024.0
        np.testing.assert_array_equal(pa[keep], pb[keep])
        self.assertLess(float(pb.min()), -1024.0)
        self.assertEqual(float(pa.min()), -1024.0)
        self.assertEqual(float(pa.max()), float(pb.max()))


if __name__ == "__main__":
    unittest.main()
