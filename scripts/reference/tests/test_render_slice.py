"""§7.3's slice compositing, asserted analytically on the committed fixtures.

Rule 0 of §11 applies to a reference implementation more than to anything else: every number below
is derived from §3 / §4.2 / §6.1 / §7.3, never read off a previous run. The fixtures are the ones
`testdata/README.md` names for exactly this purpose — `vol_ramp4.nii` (`v = i`, §11's worked
example), `vol_asym.nii` (a bright cube in the **left**-anterior-superior octant) and the
`labels_*` volumes.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import colormaps as C  # noqa: E402
import niftiref as N  # noqa: E402
import render_slice as R  # noqa: E402
from pngio import read_png, write_png  # noqa: E402

TESTDATA = Path(__file__).resolve().parents[3] / "testdata"
TMP = Path(
    "/private/tmp/claude-501/-Users-idohaber-01-production-TI-toolbox/"
    "4f5f3999-31ec-4eb1-8431-0a7a3cb91177/scratchpad"
)


def ramp_layer(**over):
    """A `vol_ramp4.nii` scalar layer: 4x4x4 `u8`, `v = i`, identity affine, voxel centres on ints."""
    layer = {
        "path": str(TESTDATA / "vol_ramp4.nii"),
        "kind": "volume",
        "colormap": "gray",
        "scale": {"kind": "linear", "lo": 0, "hi": 3},
        "interpolation": "nearest",
        "opacity": 1.0,
    }
    layer.update(over)
    return layer


def one_pixel(layers, cursor, mode="axial", radiological=False, background=(0, 0, 0, 1)):
    """Render a **1x1** pane centred exactly on `cursor` and return its RGBA (floats, 0..1).

    A 1x1 pane samples `u = v = 0`, i.e. the cursor itself: `paneToWorld` puts pixel `p` at
    `(p + 0.5 - W/2) * mmPerPx`, which is 0 for the only pixel of a one-pixel pane. That makes an
    analytic assertion about one world point exact, with no "which pixel is the centre" argument.
    """
    scene = {
        "layers": list(layers),
        "view": {
            "mode": mode,
            "cursor": list(cursor),
            "mmPerPx": 0.25,
            "widthPx": 1,
            "heightPx": 1,
            "radiological": radiological,
        },
        "background": list(background),
    }
    return R.render_scene(scene)["rgba"][0, 0]


def probe(layer_spec, cursor, mode="axial", radiological=False):
    """One layer's own `(rgb, alpha, drawn)` at `cursor`, **before** compositing.

    `drawn` is the thing the composite cannot tell you: over an opaque background, a discarded
    fragment and an opaque one both leave an opaque pixel, so every assertion about §7.3's
    `discard` has to read the layer's output rather than the pane's.
    """
    view = R.ViewSpec.from_json(
        {"mode": mode, "cursor": list(cursor), "mmPerPx": 0.25, "widthPx": 1, "heightPx": 1,
         "radiological": radiological}
    )
    layer = R.load_layers({"layers": [layer_spec]}, TESTDATA)[0]
    rgb, alpha, keep = R.render_layer(layer, view, R.pane_to_world(view), TESTDATA)
    return rgb[0, 0], float(alpha[0, 0]), bool(keep[0, 0])


def bytes_of(rgba) -> list[int]:
    return [int(v) for v in np.rint(np.asarray(rgba) * 255)]


class TestWorkedExample(unittest.TestCase):
    """§11's named analytic pixel test, end to end through the renderer."""

    def test_gray_ramp_at_v_equals_1_is_85(self):
        px = one_pixel([ramp_layer()], cursor=(1, 1.5, 1.5))
        self.assertEqual(bytes_of(px), [85, 85, 85, 255])

    def test_the_whole_ramp(self):
        for i, want in ((0, 0), (1, 85), (2, 170), (3, 255)):
            px = one_pixel([ramp_layer()], cursor=(i, 1.5, 1.5))
            self.assertEqual(bytes_of(px), [want, want, want, 255], f"v = {i}")

    def test_a_pane_lays_the_ramp_out_along_screen_x(self):
        """`right = cross(up, normal) = +X` for axial, so `v = i` increases to the right."""
        scene = {
            "layers": [ramp_layer()],
            "view": {"mode": "axial", "cursor": [1.5, 1.5, 1.5], "mmPerPx": 0.25,
                     "widthPx": 32, "heightPx": 32, "radiological": False},
            "background": [0, 0, 0, 1],
        }
        row = np.rint(R.render_scene(scene)["rgba"][16, :, 0] * 255).astype(int)
        # 4 voxels x 1 mm at 0.25 mm/px = 16 px of data, centred: columns 8..23.
        self.assertEqual(list(row[8:12]), [0, 0, 0, 0])
        self.assertEqual(list(row[12:16]), [85] * 4)
        self.assertEqual(list(row[16:20]), [170] * 4)
        self.assertEqual(list(row[20:24]), [255] * 4)


class TestOrientation(unittest.TestCase):
    """§11's **three mandatory orientation tests**, on `vol_asym.nii`.

    The fixture is a bright 3^3 cube in the left-anterior-superior octant (world x, y, z in
    -3.5..-1.5, 1.5..3.5, 1.5..3.5). §11 requires it on screen-**left** in neurological and
    screen-**right** after `setRadiological(true)`, in **each** of the three 2D views — which is
    what §3's `(+Z, -Y, -X)` preset triple exists to make simultaneously true.
    """

    CURSOR = {"axial": (0, 0, 2.5), "coronal": (0, 2.5, 0), "sagittal": (-2.5, 0, 0)}
    PANE = 64

    def bright_centroid(self, mode, radiological):
        scene = {
            "layers": [{
                "path": str(TESTDATA / "vol_asym.nii"), "kind": "volume", "colormap": "gray",
                "scale": {"kind": "linear", "lo": 0, "hi": 255}, "interpolation": "nearest",
            }],
            "view": {"mode": mode, "cursor": list(self.CURSOR[mode]), "mmPerPx": 0.25,
                     "widthPx": self.PANE, "heightPx": self.PANE, "radiological": radiological},
            "background": [0, 0, 0, 1],
        }
        bright = R.render_scene(scene)["rgba"][..., 0] > 0.5
        self.assertTrue(bright.any(), f"{mode}: the cube must be in frame")
        ys, xs = np.nonzero(bright)
        return float(xs.mean()), float(ys.mean()), int(bright.sum())

    def test_left_is_screen_left_in_neurological(self):
        for mode in ("axial", "coronal", "sagittal"):
            cx, _, n = self.bright_centroid(mode, radiological=False)
            self.assertLess(cx, self.PANE / 2 - 4, f"{mode}: LAS cube must be on screen-left")
            self.assertEqual(n, 12 * 12, mode)  # a 3 mm cube at 0.25 mm/px

    def test_left_is_screen_right_in_radiological(self):
        for mode in ("axial", "coronal", "sagittal"):
            cx, _, _ = self.bright_centroid(mode, radiological=True)
            self.assertGreater(cx, self.PANE / 2 + 4, f"{mode}: RAD must mirror it to the right")

    def test_anterior_and_superior_are_screen_up(self):
        """`up` is `+Y` for axial and `+Z` for the other two, and RAD never touches `up`."""
        for mode in ("axial", "coronal", "sagittal"):
            for rad in (False, True):
                _, cy, _ = self.bright_centroid(mode, rad)
                self.assertLess(cy, self.PANE / 2 - 4, f"{mode} rad={rad}")

    def test_radiological_is_exactly_a_horizontal_mirror(self):
        """§3: `radiological` negates `right` **only**. So the pane is `fliplr` of itself."""
        def render(rad):
            scene = {
                "layers": [{
                    "path": str(TESTDATA / "vol_asym.nii"), "kind": "volume", "colormap": "viridis",
                    "scale": {"kind": "linear", "lo": 0, "hi": 255}, "interpolation": "linear",
                }],
                "view": {"mode": "coronal", "cursor": [0, 2.5, 0], "mmPerPx": 0.3,
                         "widthPx": 48, "heightPx": 48, "radiological": rad},
                "background": [0.1, 0.1, 0.1, 1],
            }
            return R.render_scene(scene)["rgba"]

        np.testing.assert_array_equal(render(True), np.fliplr(render(False)))

    def test_the_basis_is_right_equals_cross_up_normal(self):
        for mode, want_right in (
            ("axial", [1, 0, 0]),      # cross(+Y, +Z) = +X
            ("coronal", [1, 0, 0]),    # cross(+Z, -Y) = +X
            ("sagittal", [0, -1, 0]),  # cross(+Z, -X) = -Y
        ):
            right, up, n = R.slice_basis(R.preset_normal(mode), R.preset_up(mode), False)
            np.testing.assert_allclose(right, want_right, atol=1e-12, err_msg=mode)
            np.testing.assert_allclose(np.cross(up, n), right, atol=1e-12, err_msg=mode)
            rad_right, rad_up, _ = R.slice_basis(R.preset_normal(mode), R.preset_up(mode), True)
            np.testing.assert_allclose(rad_right, -np.asarray(right), atol=1e-12)
            np.testing.assert_allclose(rad_up, up, atol=1e-12, err_msg=f"{mode}: up is untouched")


class TestSampling(unittest.TestCase):
    def test_trilinear_reads_between_voxels(self):
        """Halfway between `i = 1` and `i = 2`, `v = 1.5` -> texel floor(0.5 * 256) = 128."""
        px = one_pixel([ramp_layer(interpolation="linear")], cursor=(1.5, 1.5, 1.5))
        self.assertEqual(bytes_of(px)[0], 128)

    def test_nearest_snaps_to_the_voxel(self):
        """NEAREST is `floor(tc * dims)`; `tc = (1.5 + 0.5)/4 = 0.5` selects voxel 2 -> `v = 2`."""
        px = one_pixel([ramp_layer(interpolation="nearest")], cursor=(1.5, 1.5, 1.5))
        self.assertEqual(bytes_of(px)[0], 170)

    def test_trilinear_and_nearest_agree_on_a_voxel_centre(self):
        for interp in ("linear", "nearest"):
            px = one_pixel([ramp_layer(interpolation=interp)], cursor=(2, 1.5, 1.5))
            self.assertEqual(bytes_of(px)[0], 170, interp)

    def test_outside_the_aabb_is_discarded(self):
        """§7.3: a `tc` outside `[0,1]^3` is outside the layer's own box — background survives."""
        px = one_pixel([ramp_layer()], cursor=(50, 1.5, 1.5), background=(0.2, 0.3, 0.4, 1))
        np.testing.assert_allclose(px, [0.2, 0.3, 0.4, 1.0], atol=1e-6)

    def test_the_aabb_edge_is_half_a_voxel_outside_the_centre(self):
        """`tc = (voxel + 0.5)/dims`, so voxel -0.5 .. dims-0.5 is inside; -0.51 is not."""
        self.assertTrue(probe(ramp_layer(), (-0.49, 1.5, 1.5))[2])
        self.assertFalse(probe(ramp_layer(), (-0.51, 1.5, 1.5))[2])
        self.assertTrue(probe(ramp_layer(), (3.49, 1.5, 1.5))[2])
        self.assertFalse(probe(ramp_layer(), (3.51, 1.5, 1.5))[2])

    def test_scl_slope_and_inter_are_applied_not_folded(self):
        """§6.1: `vol_scl.nii` carries `slope 2.5 / inter -100` in the header, samples stay raw."""
        vol = N.load_volume(TESTDATA / "vol_scl.nii")
        self.assertEqual((vol.scl_slope, vol.scl_inter), (2.5, -100.0))
        raw = int(vol.frame(0)[2, 1, 0])
        world = vol.affine[:3, :3] @ np.array([2.0, 1.0, 0.0]) + vol.affine[:3, 3]
        want = raw * 2.5 - 100.0
        px = one_pixel(
            [{"path": str(TESTDATA / "vol_scl.nii"), "kind": "volume", "colormap": "gray",
              "scale": {"kind": "linear", "lo": want, "hi": want + 1},
              "interpolation": "nearest"}],
            cursor=world,
        )
        # v == lo -> t = 0 -> texel 0 -> gray 0. One level either side would mean the physical
        # value was not what the header says.
        self.assertEqual(bytes_of(px)[0], 0)

    def test_nan_slope_is_normalised_to_identity(self):
        """§6.1's guard, which only the fixture exercises."""
        vol = N.load_volume(TESTDATA / "vol_scl_nan.nii")
        self.assertEqual((vol.scl_slope, vol.scl_inter), (1.0, 0.0))


class TestThreshold(unittest.TestCase):
    """§4.2's `Threshold`, §7.3's `discard`, and the `softEdge` ramp."""

    def gate(self, cursor, threshold, **over):
        return probe(ramp_layer(threshold=threshold, interpolation="linear", **over), cursor)

    def test_hide_with_no_soft_edge_is_a_hard_discard(self):
        t = {"lo": 0.5, "hi": 2.5, "symmetric": False, "mode": "hide", "softEdge": 0}
        self.assertFalse(self.gate((0, 1.5, 1.5), t)[2], "v = 0 is below lo")
        self.assertFalse(self.gate((3, 1.5, 1.5), t)[2], "v = 3 is above hi")
        self.assertTrue(self.gate((1, 1.5, 1.5), t)[2])
        self.assertEqual(self.gate((1, 1.5, 1.5), t)[1], 1.0, "inside the window alpha is 1")

    def test_clamp_never_discards_and_pulls_the_value_in(self):
        t = {"lo": 1.0, "hi": 2.0, "symmetric": False, "mode": "clamp", "softEdge": 0}
        # v = 0 clamps to 1 -> the same colour as v = 1: texel 85.
        px = one_pixel([ramp_layer(threshold=t, interpolation="linear")], (0, 1.5, 1.5))
        self.assertEqual(bytes_of(px), [85, 85, 85, 255])
        self.assertTrue(self.gate((0, 1.5, 1.5), t)[2], "clamp never discards")
        # v = 3 clamps to 2 -> texel 170.
        px = one_pixel([ramp_layer(threshold=t, interpolation="linear")], (3, 1.5, 1.5))
        self.assertEqual(bytes_of(px), [170, 170, 170, 255])

    def test_soft_edge_is_a_fraction_of_hi_minus_lo(self):
        """`ramp = softEdge * (hi - lo)`, then `smoothstep(lo, lo + ramp, v)` on the low edge.

        `lo = 0.5, hi = 2.5, softEdge = 0.25` -> `ramp = 0.5`. At `v = 0.75` the smoothstep
        parameter is exactly 0.5, so `alpha = 0.5^2 * (3 - 2*0.5) = 0.5` — and the composite over
        black is half the LUT colour.
        """
        t = {"lo": 0.5, "hi": 2.5, "symmetric": False, "mode": "hide", "softEdge": 0.25}
        _, alpha, drawn = self.gate((0.75, 1.5, 1.5), t)
        self.assertTrue(drawn)
        self.assertAlmostEqual(alpha, 0.5, places=9)
        lut_rgb = C.lut_sample(C.bake_scale({"kind": "linear", "lo": 0, "hi": 3}, "gray"), 0.75)[0]
        px = one_pixel([ramp_layer(threshold=t, interpolation="linear")], (0.75, 1.5, 1.5))
        self.assertAlmostEqual(float(px[0]), (lut_rgb / 255.0) * 0.5, places=6)

    def test_the_ramp_mirrors_on_the_high_edge(self):
        t = {"lo": 0.5, "hi": 2.5, "symmetric": False, "mode": "hide", "softEdge": 0.25}
        # ramp = 0.5, so the high edge ramps over 2.0 .. 2.5; at v = 2.25 the parameter is 0.5.
        self.assertAlmostEqual(self.gate((2.25, 1.5, 1.5), t)[1], 0.5, places=9)

    def test_the_ramp_reaches_zero_and_discards_at_the_edges(self):
        t = {"lo": 0.5, "hi": 2.5, "symmetric": False, "mode": "hide", "softEdge": 0.25}
        self.assertFalse(self.gate((0.5, 1.5, 1.5), t)[2])
        self.assertFalse(self.gate((2.5, 1.5, 1.5), t)[2])
        self.assertAlmostEqual(self.gate((1.5, 1.5, 1.5), t)[1], 1.0, places=9)

    def test_symmetric_compares_the_magnitude(self):
        """A signed volume: `symmetric` keeps `|v|` in the window (§7.3: it compares `|v|`)."""
        vol = N.load_volume(TESTDATA / "vol_scl.nii")  # slope 2.5, inter -100 -> signed values
        phys = vol.physical(0)
        neg = np.argwhere(phys < -50)[0]
        world = vol.affine[:3, :3] @ neg.astype(float) + vol.affine[:3, 3]
        v = float(phys[tuple(neg)])
        layer = {
            "path": str(TESTDATA / "vol_scl.nii"), "kind": "volume", "colormap": "gray",
            "scale": {"kind": "linear", "lo": -200, "hi": 200}, "interpolation": "nearest",
            "threshold": {"lo": abs(v) + 5, "hi": 1e9, "symmetric": True, "mode": "hide",
                          "softEdge": 0},
        }
        self.assertFalse(probe(layer, world)[2], "|v| below lo is hidden")
        layer["threshold"] = dict(layer["threshold"], lo=abs(v) - 5)
        self.assertTrue(probe(layer, world)[2], "|v| above lo survives")
        # ...and the same window without `symmetric` compares the signed value, which is far below
        # `lo`, so the fragment goes.
        layer["threshold"] = dict(layer["threshold"], symmetric=False)
        self.assertFalse(probe(layer, world)[2], "a signed compare drops the negative value")

    def test_symmetric_clamp_keeps_the_sign(self):
        vol = N.load_volume(TESTDATA / "vol_scl.nii")
        phys = vol.physical(0)
        neg = np.argwhere(phys < -50)[0]
        world = vol.affine[:3, :3] @ neg.astype(float) + vol.affine[:3, 3]
        v = float(phys[tuple(neg)])
        scale = {"kind": "linear", "lo": -200, "hi": 200}
        layer = {
            "path": str(TESTDATA / "vol_scl.nii"), "kind": "volume", "colormap": "gray",
            "scale": scale, "interpolation": "nearest",
            "threshold": {"lo": 0.0, "hi": abs(v) / 2, "symmetric": True, "mode": "clamp",
                          "softEdge": 0},
        }
        want = C.lut_sample(C.bake_scale(scale, "gray"), -abs(v) / 2)
        self.assertEqual(bytes_of(one_pixel([layer], world))[:3], [int(x) for x in want[:3]])

    def test_unbounded_threshold_never_produces_nan(self):
        """`Threshold`'s default is +/-Infinity; `softEdge * (hi - lo)` must stay finite."""
        t = {"lo": None, "hi": None, "symmetric": False, "mode": "hide", "softEdge": 0.25}
        rgb, alpha, drawn = self.gate((1, 1.5, 1.5), t)
        self.assertTrue(drawn)
        self.assertTrue(np.all(np.isfinite(rgb)) and np.isfinite(alpha))
        px = one_pixel([ramp_layer(threshold=t, interpolation="linear")], (1, 1.5, 1.5))
        self.assertEqual(bytes_of(px), [85, 85, 85, 255])


class TestHeatRender(unittest.TestCase):
    HEAT = {"kind": "heat", "min": 1.0, "mid": 2.0, "max": 3.0,
            "truncate": False, "inverse": False, "negative": "hide"}

    def test_below_min_is_transparent(self):
        px = one_pixel(
            [ramp_layer(scale=self.HEAT, colormap="hot")], cursor=(0, 1.5, 1.5),
            background=(0.25, 0, 0, 1),
        )
        np.testing.assert_allclose(px, [0.25, 0, 0, 1], atol=1e-6)

    def test_mid_is_half_way_up_the_colormap(self):
        px = one_pixel([ramp_layer(scale=self.HEAT, colormap="hot")], cursor=(2, 1.5, 1.5))
        want = C.lut_sample(C.bake_scale(self.HEAT, "hot"), 2.0)
        self.assertEqual(bytes_of(px)[:3], [int(x) for x in want[:3]])
        # `hot` at t = 0.5 is on its red -> yellow leg (stops at 0, 0.375, 0.75, 1).
        self.assertGreater(want[0], 250)
        self.assertGreater(want[1], 0)
        self.assertEqual(int(want[2]), 0)

    def test_truncate_discards_above_max(self):
        truncated = dict(self.HEAT, max=2.5, truncate=True)
        px = one_pixel(
            [ramp_layer(scale=truncated, colormap="hot")], cursor=(3, 1.5, 1.5),
            background=(0, 0.5, 0, 1),
        )
        np.testing.assert_allclose(px, [0, 0.5, 0, 1], atol=1e-6)

    def test_without_truncate_the_max_colour_is_kept(self):
        px = one_pixel(
            [ramp_layer(scale=dict(self.HEAT, max=2.5), colormap="hot")], cursor=(3, 1.5, 1.5)
        )
        self.assertEqual(bytes_of(px)[3], 255)


class TestCompositing(unittest.TestCase):
    """§7.3: depth test off, layer order bottom -> top, `SRC_ALPHA, ONE_MINUS_SRC_ALPHA`."""

    def test_layer_order_and_opacity(self):
        bottom = ramp_layer()  # at v = 3 -> white
        top = ramp_layer(scale={"kind": "linear", "lo": 0, "hi": 6}, opacity=0.25)  # v = 3 -> t 0.5
        px = one_pixel([bottom, top], cursor=(3, 1.5, 1.5))
        base = C.lut_sample(C.bake_scale({"kind": "linear", "lo": 0, "hi": 3}, "gray"), 3.0)[0]
        over = C.lut_sample(C.bake_scale({"kind": "linear", "lo": 0, "hi": 6}, "gray"), 3.0)[0]
        want = (over / 255.0) * 0.25 + (base / 255.0) * 0.75
        self.assertAlmostEqual(float(px[0]), want, places=6)
        self.assertEqual(bytes_of(px)[0], 223)  # 128/255*0.25 + 1*0.75 = 0.87549 -> 223

    def test_swapping_the_order_swaps_the_result(self):
        a = ramp_layer(opacity=0.5)
        b = ramp_layer(scale={"kind": "linear", "lo": 0, "hi": 6}, opacity=0.5)
        self.assertNotEqual(
            bytes_of(one_pixel([a, b], (3, 1.5, 1.5))),
            bytes_of(one_pixel([b, a], (3, 1.5, 1.5))),
        )

    def test_an_opaque_layer_hides_what_is_under_it(self):
        """§11's independence property: at opacity 1 the composite ignores the layer below."""
        under_a = ramp_layer(colormap="viridis")
        under_b = ramp_layer(colormap="turbo")
        top = ramp_layer(opacity=1.0)
        self.assertEqual(
            bytes_of(one_pixel([under_a, top], (2, 1.5, 1.5))),
            bytes_of(one_pixel([under_b, top], (2, 1.5, 1.5))),
        )

    def test_the_alpha_channel_takes_the_same_blend_factors(self):
        """`gl/state.ts` sets a non-separate `blendFunc`, so alpha blends with `SRC_ALPHA` too.

        `A = As*As + Ad*(1 - As)`. With `As = 0.5` over an opaque background that is
        `0.25 + 0.5 = 0.75` — which is why a discarded fragment is **not** identifiable from the
        composite's alpha, and why every discard assertion above reads the layer instead.
        """
        px = one_pixel([ramp_layer(opacity=0.5)], (2, 1.5, 1.5), background=(0, 0, 0, 1))
        self.assertAlmostEqual(float(px[3]), 0.75, places=9)

    def test_a_discarded_fragment_leaves_the_layer_below_untouched(self):
        hidden = ramp_layer(
            threshold={"lo": 9, "hi": 10, "symmetric": False, "mode": "hide", "softEdge": 0}
        )
        alone = bytes_of(one_pixel([ramp_layer()], (2, 1.5, 1.5)))
        with_top = bytes_of(one_pixel([ramp_layer(), hidden], (2, 1.5, 1.5)))
        self.assertEqual(alone, with_top)


class TestLabels(unittest.TestCase):
    """§7.3's label path: dense palette, forced NEAREST, and the normative 4-tap outline."""

    LUT = str(TESTDATA / "labels_simnibs_LUT.txt")
    VOL = str(TESTDATA / "labels_simnibs.nii.gz")

    def scene(self, mode="fill", width=2.0, mm=0.05, pane=160, **label_over):
        label = {"lut": self.LUT, "mode": mode, "outlineWidthPx": width}
        label.update(label_over)
        return {
            "layers": [{"path": self.VOL, "kind": "volume", "colormap": "gray",
                        "scale": {"kind": "linear", "lo": 0, "hi": 1}, "label": label}],
            "view": {"mode": "axial", "cursor": [0, 10, 0], "mmPerPx": mm,
                     "widthPx": pane, "heightPx": pane, "radiological": False},
            "background": [0, 0, 0, 1],
        }

    @staticmethod
    def runs(mask: np.ndarray) -> list[int]:
        """Horizontal run lengths of `mask` — an upper bound on perpendicular band thickness."""
        out: list[int] = []
        for row in mask:
            n = 0
            for v in row:
                if v:
                    n += 1
                elif n:
                    out.append(n)
                    n = 0
            if n:
                out.append(n)
        return out

    def test_interpolation_is_forced_to_nearest(self):
        layers = R.load_layers(self.scene(), TESTDATA)
        self.assertEqual(layers[0].interpolation, "nearest")

    def test_fill_paints_the_lut_colour(self):
        """A voxel of label 1 must come out as the LUT's `230 230 210`, exactly (§4.1)."""
        vol = N.load_volume(TESTDATA / "labels_simnibs.nii.gz")
        ids = np.rint(vol.physical(0)).astype(int)
        idx = np.argwhere(ids == 1)[0]
        world = vol.affine[:3, :3] @ idx.astype(float) + vol.affine[:3, 3]
        px = one_pixel(
            [{"path": self.VOL, "kind": "volume", "colormap": "gray",
              "scale": {"kind": "linear", "lo": 0, "hi": 1},
              "label": {"lut": self.LUT, "mode": "fill", "outlineWidthPx": 1}}],
            cursor=world,
        )
        self.assertEqual(bytes_of(px), [230, 230, 210, 255])

    def test_id_zero_is_transparent_because_its_lut_alpha_is_zero(self):
        """Background is decided by **alpha**, not by index (§7.3)."""
        vol = N.load_volume(TESTDATA / "labels_simnibs.nii.gz")
        ids = np.rint(vol.physical(0)).astype(int)
        idx = np.argwhere(ids == 0)[0]
        world = vol.affine[:3, :3] @ idx.astype(float) + vol.affine[:3, 3]
        px = one_pixel(
            [{"path": self.VOL, "kind": "volume", "colormap": "gray",
              "scale": {"kind": "linear", "lo": 0, "hi": 1},
              "label": {"lut": self.LUT, "mode": "fill", "outlineWidthPx": 1}}],
            cursor=world, background=(0, 0, 1, 1),
        )
        np.testing.assert_allclose(px, [0, 0, 1, 1], atol=1e-6)

    def test_outline_width_is_the_requested_screen_width(self):
        """The 4 taps sit at `+/- 0.5 * outlineWidthPx`, so the band is `outlineWidthPx` wide.

        A naive `+/- outlineWidthPx` offset would draw twice the requested width, which is the
        defect the `0.5` in §7.3's formula exists to prevent — so the assertion is the median run,
        not merely "wider for a wider setting".
        """
        for width in (1, 2, 4):
            mask = R.render_scene(self.scene("outline", width))["mask"]
            self.assertTrue(mask.any(), width)
            self.assertEqual(float(np.median(self.runs(mask))), float(width), f"width {width}")

    def test_the_outline_is_screen_relative_not_voxel_relative(self):
        """Zoom by 5x and the band stays the same number of **pixels** (§7.3's whole rationale).

        A voxel-space step would scale the band with the zoom instead — 12.87 px at 0.05 mm/px, a
        13x regression. The zoom range here stops where this 5x4x3 fixture's regions stop being
        wider than the band itself; §11's 0.05/1.0/5.0 mm/px version of the test needs a real atlas
        and lives in `test_real_data.py`.
        """
        for mm in (0.05, 0.1, 0.25):
            mask = R.render_scene(self.scene("outline", 2, mm=mm))["mask"]
            self.assertTrue(mask.any(), f"{mm} mm/px")
            self.assertEqual(float(np.median(self.runs(mask))), 2.0, f"{mm} mm/px")

    def test_zero_width_draws_no_outline(self):
        self.assertFalse(R.render_scene(self.scene("outline", 0))["mask"].any())

    def test_outline_is_a_subset_of_fill(self):
        fill = R.render_scene(self.scene("fill"))["mask"]
        outline = R.render_scene(self.scene("outline", 2))["mask"]
        self.assertTrue(fill.any() and outline.any())
        self.assertTrue(np.all(fill[outline]))
        self.assertLess(outline.sum(), fill.sum())

    def test_both_keeps_the_fill_and_darkens_the_rim(self):
        """`both` must not be pixel-identical to `fill`, or the mode has no meaning."""
        fill = R.render_scene(self.scene("fill"))
        both = R.render_scene(self.scene("both", 2))
        outline = R.render_scene(self.scene("outline", 2))["mask"]
        np.testing.assert_array_equal(fill["mask"], both["mask"])
        interior = fill["mask"] & ~outline
        np.testing.assert_allclose(both["rgba"][interior], fill["rgba"][interior], atol=1e-6)
        rim = outline
        np.testing.assert_allclose(
            both["rgba"][rim][:, :3],
            fill["rgba"][rim][:, :3] * R.LABEL_OUTLINE_DARKEN,
            atol=1e-6,
        )

    def test_a_selected_label_gets_a_wider_white_rim_in_fill_mode(self):
        """R5's emphasis: the border lights up while the fill stays exactly as it was."""
        plain = R.render_scene(self.scene("fill"))
        picked = R.render_scene(self.scene("fill", selectedLabels=[1]))
        np.testing.assert_array_equal(plain["mask"], picked["mask"])
        rim = np.all(np.isclose(picked["rgba"][..., :3], 1.0), axis=-1) & picked["mask"]
        self.assertGreater(int(rim.sum()), 0, "the selected label must gain a rim")
        # The rim is one-sided — only the **selected** label's own fragments take it — so its width
        # is the tap distance itself, `0.5 * outlineWidthPx * LABEL_SELECT_WIDTH_SCALE` = 2 px,
        # against the 1 px an ordinary 2 px outline contributes on that same side.
        self.assertEqual(float(np.median(self.runs(rim))), 2.0)
        # Everything that is not the rim is untouched by the selection.
        np.testing.assert_allclose(picked["rgba"][~rim], plain["rgba"][~rim], atol=1e-6)

    def test_a_hidden_label_gets_no_selection_rim(self):
        """`LABEL_BODY` discards a zero-alpha palette entry *inside* the selected branch."""
        hidden = R.render_scene(self.scene("fill", visibleLabels=[2, 3], selectedLabels=[1]))
        without = R.render_scene(self.scene("fill", visibleLabels=[2, 3]))
        np.testing.assert_array_equal(hidden["rgba"], without["rgba"])

    def test_visible_labels_hides_exactly_those_pixels(self):
        """R5's gate: hiding a label leaves every other pixel byte-identical."""
        every = R.render_scene(self.scene("fill"))
        vol = N.load_volume(TESTDATA / "labels_simnibs.nii.gz")
        kept = [1, 2, 3, 5, 10]
        some = R.render_scene(self.scene("fill", visibleLabels=kept))
        self.assertTrue(some["mask"].sum() < every["mask"].sum())
        self.assertTrue(np.all(every["mask"][some["mask"]]))
        np.testing.assert_allclose(
            some["rgba"][some["mask"]], every["rgba"][some["mask"]], atol=1e-6
        )
        self.assertIsNotNone(vol)

    def test_label_opacity_scales_the_alpha(self):
        opaque = R.render_scene(self.scene("fill"))
        faded = R.render_scene(self.scene("fill", labelOpacity={"1": 0.5}))
        self.assertTrue(np.any(faded["rgba"] != opaque["rgba"]))
        # Everything that is not label 1 is untouched, so the difference is bounded by one label.
        self.assertLess(float(np.abs(faded["rgba"] - opaque["rgba"]).mean()), 0.5)

    def test_layer_opacity_multiplies_on_top_of_the_palette(self):
        full = R.render_scene(self.scene("fill"))
        scene = self.scene("fill")
        scene["layers"][0]["opacity"] = 0.5
        got = R.render_scene(scene)["rgba"]
        mask = full["mask"]
        np.testing.assert_allclose(got[mask][:, :3], full["rgba"][mask][:, :3] * 0.5, atol=1e-6)


class TestAffine(unittest.TestCase):
    """§3's source order, on the fixture built for it."""

    def test_qfac_applies_to_the_third_column_only(self):
        h = N.read_raw_header(TESTDATA / "vol_qfac_neg.nii")
        self.assertEqual(h.sform_code, 0)
        self.assertGreater(h.qform_code, 0)
        self.assertLess(h.pixdim[0], 0)
        with_qfac = N.affine_from_header(h)
        without = N.affine_from_header(
            N.RawHeader(**{**h.__dict__, "pixdim": (1.0,) + h.pixdim[1:]})
        )
        # Dropping qfac flips the third column and nothing else.
        delta = np.abs(with_qfac - without)
        self.assertAlmostEqual(float(delta.max()), 6.0, places=6)
        np.testing.assert_allclose(delta[:, [0, 1, 3]], 0, atol=1e-12)

    def test_sform_wins_over_qform(self):
        h = N.read_raw_header(TESTDATA / "labels_simnibs.nii.gz")
        self.assertGreater(h.sform_code, 0)
        np.testing.assert_allclose(N.affine_from_header(h)[0, :], h.srow[0], atol=1e-12)

    def test_is_label_ignores_the_dtype(self):
        """§6.1: `labels_float32.nii.gz` is float32 with `intent_code = 1002`."""
        vol = N.load_volume(TESTDATA / "labels_float32.nii.gz")
        self.assertEqual(vol.raw.dtype, np.float32)
        self.assertTrue(vol.is_label)
        self.assertFalse(N.load_volume(TESTDATA / "vol_scl.nii").is_label)


class TestPng(unittest.TestCase):
    def test_round_trip(self):
        rgba = (np.arange(8 * 5 * 4, dtype=np.uint8).reshape(8, 5, 4) * 3).astype(np.uint8)
        TMP.mkdir(parents=True, exist_ok=True)
        path = TMP / "pngio-roundtrip.png"
        write_png(path, rgba)
        np.testing.assert_array_equal(read_png(path), rgba)

    def test_the_png_is_the_quantised_composite(self):
        scene = {
            "layers": [ramp_layer()],
            "view": {"mode": "axial", "cursor": [1.5, 1.5, 1.5], "mmPerPx": 0.5,
                     "widthPx": 16, "heightPx": 16, "radiological": False},
            "background": [0, 0, 0, 1],
        }
        r = R.render_scene(scene)
        np.testing.assert_array_equal(r["png"], np.rint(r["rgba"] * 255).astype(np.uint8))


if __name__ == "__main__":
    unittest.main()
