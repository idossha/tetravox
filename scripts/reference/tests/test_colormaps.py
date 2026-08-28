"""§7.6: the colormap tables, the `Scale` bake and the label LUTs.

Every expectation here is computed from the prose of §4.2 / §7.6, or is §11's own worked example.
The one thing not recomputed is the colour tables themselves — `colormaps.py` reads those out of
`packages/engine/src/color/colormaps.ts`, and the first test is that it really did.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import colormaps as C  # noqa: E402

TESTDATA = Path(__file__).resolve().parents[3] / "testdata"


class TestTables(unittest.TestCase):
    def test_every_frozen_colormap_name_is_present(self):
        """§4.1's `ColormapName` union is frozen; all 15 must come out of the TypeScript."""
        self.assertEqual(tuple(C.TABLES), C.EXPECTED_NAMES)

    def test_tables_are_rgb_triples_in_0_255(self):
        for name, stops in C.TABLES.items():
            self.assertGreaterEqual(len(stops), 2, name)
            for stop in stops:
                self.assertEqual(len(stop), 3, name)
                for ch in stop:
                    self.assertTrue(0 <= ch <= 255, f"{name}: {stop}")

    def test_hot_is_the_only_non_uniform_table(self):
        """§7.6's `POSITIONS`: the classics whose stops are not evenly spaced."""
        self.assertEqual(C.POSITIONS, {"hot": [0, 0.375, 0.75, 1]})

    def test_gray_is_a_straight_ramp(self):
        self.assertEqual(C.sample_colormap("gray", 0.0), (0, 0, 0))
        self.assertEqual(C.sample_colormap("gray", 1.0), (255, 255, 255))
        self.assertEqual(C.sample_colormap("gray", 1 / 3), (85, 85, 85))

    def test_sampling_clamps_outside_0_1(self):
        self.assertEqual(C.sample_colormap("viridis", -5), C.sample_colormap("viridis", 0.0))
        self.assertEqual(C.sample_colormap("viridis", 5), C.sample_colormap("viridis", 1.0))


class TestLinearBake(unittest.TestCase):
    def setUp(self):
        self.baked = C.bake_scale({"kind": "linear", "lo": 0, "hi": 3}, "gray")

    def test_shape_and_range(self):
        self.assertEqual(self.baked.width, 256)
        self.assertEqual((self.baked.lo, self.baked.hi), (0.0, 3.0))
        self.assertFalse(self.baked.signed)
        self.assertEqual(self.baked.clip_max, float("inf"))

    def test_section_11_worked_example(self):
        """§11: `v = 1` under `gray` with `lo:0, hi:3` is exactly `rgb(85,85,85)`."""
        self.assertEqual(list(C.lut_sample(self.baked, 1.0)), [85, 85, 85, 255])

    def test_texel_centres_not_endpoints(self):
        """Texel `i` holds the value at `(i + 0.5) / width` — the value a NEAREST fetch means."""
        for i in (0, 1, 128, 254, 255):
            want = round(255 * (i + 0.5) / 256)
            self.assertEqual(int(self.baked.rgba[i, 0]), want, f"texel {i}")

    def test_texel_selection_is_floor_times_width(self):
        self.assertEqual(int(C.lut_texel_of(self.baked, -10.0)), 0)
        self.assertEqual(int(C.lut_texel_of(self.baked, 0.0)), 0)
        self.assertEqual(int(C.lut_texel_of(self.baked, 3.0)), 255)
        self.assertEqual(int(C.lut_texel_of(self.baked, 99.0)), 255)
        # t = 1/3 -> floor(256/3) = 85
        self.assertEqual(int(C.lut_texel_of(self.baked, 1.0)), 85)

    def test_degenerate_range_does_not_divide_by_zero(self):
        flat = C.bake_scale({"kind": "linear", "lo": 2.0, "hi": 2.0}, "gray")
        self.assertEqual(int(C.lut_texel_of(flat, 2.0)), 0)


class TestHeatScale(unittest.TestCase):
    """§4.2's `heat`: min/mid/max, `truncate`, `inverse`, `negative`."""

    SCALE = {"kind": "heat", "min": 1.0, "mid": 2.0, "max": 3.0,
             "truncate": False, "inverse": False, "negative": "mirror"}

    def test_two_segment_ramp(self):
        s = self.SCALE
        self.assertEqual(C.scale_position(s, 0.5), 0.0)  # below min
        self.assertEqual(C.scale_position(s, 1.0), 0.0)
        self.assertAlmostEqual(C.scale_position(s, 1.5), 0.25)
        self.assertAlmostEqual(C.scale_position(s, 2.0), 0.5)  # saturates at mid, not at max
        self.assertAlmostEqual(C.scale_position(s, 2.5), 0.75)
        self.assertAlmostEqual(C.scale_position(s, 3.0), 1.0)
        self.assertAlmostEqual(C.scale_position(s, 99.0), 1.0)

    def test_symmetric_in_the_value(self):
        for v in (1.5, 2.0, 2.75):
            self.assertEqual(C.scale_position(self.SCALE, -v), C.scale_position(self.SCALE, v))

    def test_inverse_reverses_the_ramp(self):
        s = dict(self.SCALE, inverse=True)
        self.assertAlmostEqual(C.scale_position(s, 1.5), 0.75)
        self.assertAlmostEqual(C.scale_position(s, 3.0), 0.0)

    def test_bake_spans_minus_max_to_max(self):
        b = C.bake_scale(self.SCALE, "hot")
        self.assertEqual((b.lo, b.hi), (-3.0, 3.0))
        self.assertEqual(b.width, 256)

    def test_dead_band_below_min_is_transparent(self):
        """Below `min` a heat scale contributes nothing — that is what makes it an overlay."""
        b = C.bake_scale(self.SCALE, "hot")
        self.assertEqual(int(C.lut_sample(b, 0.0)[3]), 0)
        self.assertEqual(int(C.lut_sample(b, 0.9)[3]), 0)
        self.assertEqual(int(C.lut_sample(b, 2.5)[3]), 255)
        self.assertEqual(int(C.lut_sample(b, -2.5)[3]), 255)

    def test_negative_hide_drops_the_negative_branch(self):
        b = C.bake_scale(dict(self.SCALE, negative="hide"), "hot")
        self.assertEqual(int(C.lut_sample(b, -2.5)[3]), 0)
        self.assertEqual(int(C.lut_sample(b, 2.5)[3]), 255)

    def test_negative_mirror_reuses_the_positive_colormap(self):
        b = C.bake_scale(dict(self.SCALE, negative="mirror"), "hot")
        self.assertEqual(list(C.lut_sample(b, -2.5)[:3]), list(C.lut_sample(b, 2.5)[:3]))

    def test_negative_separate_is_a_512_wide_signed_lut(self):
        b = C.bake_scale(dict(self.SCALE, negative="separate"), "hot", "blue-cyan")
        self.assertEqual(b.width, 512)
        self.assertTrue(b.signed)
        pos, neg = C.lut_sample(b, 2.5), C.lut_sample(b, -2.5)
        self.assertNotEqual(list(pos[:3]), list(neg[:3]))
        # The negative branch is the negative colormap at the same ramp position.
        self.assertEqual(tuple(neg[:3]), C.sample_colormap("blue-cyan", 0.75))

    def test_truncate_travels_as_clip_max_because_a_lut_cannot_discard(self):
        self.assertEqual(C.bake_scale(self.SCALE, "hot").clip_max, float("inf"))
        self.assertEqual(C.bake_scale(dict(self.SCALE, truncate=True), "hot").clip_max, 3.0)


class TestLabelLuts(unittest.TestCase):
    def test_simnibs_lut(self):
        t = C.parse_label_lut(TESTDATA / "labels_simnibs_LUT.txt")
        self.assertEqual(sorted(t), [0, 1, 2, 3, 5, 10, 530])
        self.assertEqual(t[0], (0, 0, 0, 0))
        self.assertEqual(t[1], (230, 230, 210, 255))
        self.assertEqual(t[530], (20, 180, 90, 255))

    def test_freesurfer_alpha_is_taken_verbatim(self):
        """FreeSurfer writes 0 and means transparency; §6.0 fixes the colour as written."""
        t = C.parse_label_lut(TESTDATA / "labels_freesurfer_LUT.txt")
        self.assertEqual(t[3], (255, 0, 0, 0))

    def test_palette_is_dense_indexed_with_no_offset(self):
        ids = [0, 1, 2, 3, 5, 10, 530]
        t = C.parse_label_lut(TESTDATA / "labels_simnibs_LUT.txt")
        pal = C.build_label_palette(ids, t)
        self.assertEqual(list(pal[0]), [0, 0, 0, 0])  # id 0 is transparent -> background
        self.assertEqual(list(pal[1]), [230, 230, 210, 255])
        self.assertEqual(list(pal[6]), [20, 180, 90, 255])

    def test_visible_labels_zero_the_alpha(self):
        ids = [0, 1, 2, 3]
        t = C.parse_label_lut(TESTDATA / "labels_simnibs_LUT.txt")
        pal = C.build_label_palette(ids, t, visible=[1])
        self.assertEqual(int(pal[1, 3]), 255)
        self.assertEqual(int(pal[2, 3]), 0)
        self.assertEqual(int(pal[3, 3]), 0)

    def test_label_opacity_scales_the_alpha(self):
        ids = [0, 1, 2]
        t = C.parse_label_lut(TESTDATA / "labels_simnibs_LUT.txt")
        pal = C.build_label_palette(ids, t, label_opacity={2: 0.5})
        self.assertEqual(int(pal[1, 3]), 255)
        self.assertEqual(int(pal[2, 3]), round(255 * 0.5))

    def test_unnamed_labels_get_the_deterministic_fallback(self):
        pal = C.build_label_palette([0, 7, 9], None)
        self.assertEqual(list(pal[0]), [0, 0, 0, 0])
        self.assertEqual(int(pal[1, 3]), 255)
        self.assertEqual(
            list(pal[1, :3]), [round(c * 255) for c in C.fallback_label_color(1)[:3]]
        )


if __name__ == "__main__":
    unittest.main()
