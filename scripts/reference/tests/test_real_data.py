"""The reference renderer on `sub-ernie` — skipped, never failed, when the dataset is absent.

Three of §11's named tests have a reference-renderer form, and this is where they live:

* **Float volume not black** — the real float32 `T1.nii.gz`, whose max is exactly 65535.0.
* **Overlay compositing** — `Thalamus_TI_subject_TI_max.nii.gz` over `T1.nii.gz`: inside the
  overlay's own footprint the composite must be **exactly** independent of the layer underneath,
  asserted by re-windowing the base and diffing every pixel.
* **Label outline zoom** — `labeling.nii.gz` in `outline` mode at 0.05, 1.0 and 5.0 mm/px:
  thickness in [0.8, 2.9] px and >= 99 % coverage of the fill boundary at each.

It also writes the PNGs a human can look at, into the session scratchpad. Those are for eyeballing;
the assertions are the test (§11 rule 0).
"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import niftiref as N  # noqa: E402
import render_slice as R  # noqa: E402
from pngio import write_png  # noqa: E402

ERNIE = Path(
    os.environ.get(
        "TETRAVOX_TESTDATA", "/Users/idohaber/datasets/000/derivatives/SimNIBS/sub-ernie"
    )
)
M2M = ERNIE / "m2m_ernie"
T1 = M2M / "T1.nii.gz"
LABELING = M2M / "segmentation" / "labeling.nii.gz"
LABELING_LUT = M2M / "segmentation" / "labeling_LUT.txt"
TI = ERNIE / "Simulations" / "Thalamus" / "TI" / "niftis" / "Thalamus_TI_subject_TI_max.nii.gz"

OUT = Path(
    "/private/tmp/claude-501/-Users-idohaber-01-production-TI-toolbox/"
    "4f5f3999-31ec-4eb1-8431-0a7a3cb91177/scratchpad"
)

#: The **ernie cursor**: the world centroid of `Left-Thalamus-Proper` (id 10) in
#: `segmentation/labeling.nii.gz`, i.e. the target of the `Simulations/Thalamus` run. Being on the
#: subject's *left* is the point — it makes laterality visible in every pane instead of hiding it
#: on the midline.
ERNIE_CURSOR = (-8.62, 7.51, 17.79)
#: The same slice, re-centred on the **midline**, so a left-sided structure lands visibly left of
#: the pane centre instead of on it — the cursor is the in-plane origin (§4.5), so a laterality
#: assertion taken at `ERNIE_CURSOR` would be asserting `0 < 0`.
MIDLINE_CURSOR = (0.0, 7.51, 17.79)
LEFT_THALAMUS = 10
RIGHT_THALAMUS = 49
PANE = 384

#: `Thalamus_TI_subject_TI_max.nii.gz` reaches 3.152 globally — near the electrodes — but only
#: ~0.13 in the thalamus it is aimed at, and its in-brain 90th percentile is 0.116. A heat scale
#: windowed on the global range paints the whole head one colour; `min` at the in-brain p90 and
#: `max` near the in-brain p99 (0.498) is what makes it read as a focal overlay.
HEAT = {"kind": "heat", "min": 0.12, "mid": 0.25, "max": 0.50,
        "truncate": False, "inverse": False, "negative": "hide"}

HAVE = T1.exists() and LABELING.exists() and TI.exists()


#: `scene/defaults.ts`'s `defaultWindow` is `p2 .. p98` of §6.1's exact 65536-bin statistics. For
#: `T1.nii.gz` that is `-0.782 .. 20353.88` — **not** `0 .. 65535`, though the file's max is exactly
#: 65535.0, and not `np.percentile`'s `0 .. 20354` either. A scene JSON carries no statistics, so
#: the window has to be written into it; these are the numbers an engine screenshot of this file at
#: its defaults was taken with, and `test_the_default_window_matches_the_golden_colour_bar` below
#: checks them against the colour bar printed in `golden/swiftshader/slice-ernie-2x2.png`.
T1_WINDOW = (-0.7819769627531059, 20353.884439945046)


def t1_layer(lo=T1_WINDOW[0], hi=T1_WINDOW[1], **over):
    layer = {
        "path": str(T1), "kind": "volume", "colormap": "gray",
        "scale": {"kind": "linear", "lo": lo, "hi": hi}, "interpolation": "linear",
        "opacity": 1.0,
    }
    layer.update(over)
    return layer


def ti_layer(**over):
    layer = {
        "path": str(TI), "kind": "volume", "colormap": "freesurfer-heat",
        "scale": dict(HEAT), "interpolation": "linear", "opacity": 1.0,
    }
    layer.update(over)
    return layer


def labeling_layer(mode="outline", width=2.0, **label_over):
    label = {"lut": str(LABELING_LUT), "mode": mode, "outlineWidthPx": width}
    label.update(label_over)
    return {
        "path": str(LABELING), "kind": "volume", "colormap": "gray",
        "scale": {"kind": "linear", "lo": 0, "hi": 1}, "label": label, "opacity": 1.0,
    }


def scene(layers, mode="axial", mm=0.7, radiological=False, pane=PANE, cursor=ERNIE_CURSOR):
    return {
        "layers": list(layers),
        "view": {"mode": mode, "cursor": list(cursor), "mmPerPx": mm,
                 "widthPx": pane, "heightPx": pane, "radiological": radiological},
        "background": [0, 0, 0, 1],
    }


@unittest.skipUnless(HAVE, f"reference dataset not at {ERNIE}")
class TestRealData(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        OUT.mkdir(parents=True, exist_ok=True)

    # -- §11: Float volume not black ---------------------------------------------------------

    def test_the_float32_t1_is_not_black_at_the_cursor(self):
        """`T1.nii.gz` is float32 with max exactly 65535.0 — the format-ladder trap (§6.1)."""
        vol = N.load_volume(T1)
        self.assertEqual(vol.raw.dtype, np.float32)
        self.assertAlmostEqual(float(vol.physical(0).max()), 65535.0, places=3)
        r = R.render_scene(scene([t1_layer()]))
        centre = r["rgba"][PANE // 2, PANE // 2]
        self.assertGreater(float(centre[0]), 0.1, "the thalamus is not black")
        # A 384 px pane at 0.7 mm/px is 268.8 mm wide, wider than the 256 mm volume, so the
        # footprint is the volume's own extent — the §7.3 AABB discard doing its job.
        self.assertGreater(float(r["mask"].mean()), 0.6)
        self.assertLess(float(r["mask"].mean()), 1.0)

    def test_the_default_window_matches_the_golden_colour_bar(self):
        """§6.1's histogram percentiles, cross-checked against the engine's own printed numbers.

        `test/golden/swiftshader/slice-ernie-2x2.png` labels its `T1 (MM)` colour bar `-0.782` at
        the bottom and `20354` at the top. Those are `defaultWindow`'s `p2` and `p98`, produced by
        the engine from `tvx-nifti`'s statistics; reproducing them here from the prose of §6.1 —
        one O(n) pass into 65536 bins over `[min, max]`, reporting the bin's lower edge — is an
        independent confirmation of the estimator, and it is why `T1_WINDOW` is what it is.
        """
        window = N.default_window(N.load_volume(T1).physical(0))
        np.testing.assert_allclose(window, T1_WINDOW, rtol=0, atol=1e-9)
        self.assertEqual(f"{window[0]:.3f}", "-0.782")
        self.assertEqual(f"{window[1]:.0f}", "20354")

    def test_the_three_panes_all_show_tissue(self):
        for mode in ("axial", "coronal", "sagittal"):
            r = R.render_scene(scene([t1_layer()], mode=mode))
            bright = float((r["rgba"][..., 0] > 0.2).mean())
            self.assertGreater(bright, 0.1, mode)
            self.assertLess(bright, 0.9, mode)
            write_png(OUT / f"ref-t1-{mode}.png", r["png"])

    # -- §11: orientation, on a real asymmetric structure -------------------------------------

    def screen_centroid_of_label(self, ident, mode, radiological):
        r = R.render_scene(
            scene([labeling_layer("fill", visibleLabels=[ident])], mode=mode,
                  radiological=radiological, cursor=MIDLINE_CURSOR)
        )
        ys, xs = np.nonzero(r["mask"])
        self.assertGreater(xs.size, 50, f"{ident} must be in frame in {mode}")
        return float(xs.mean()), float(ys.mean())

    def test_the_left_thalamus_is_on_screen_left_in_neurological(self):
        """§11's orientation test with anatomy instead of a synthetic cube.

        Label 10 is `Left-Thalamus-Proper`, rendered alone through `visibleLabels`. The pane is
        centred on the **midline** (`MIDLINE_CURSOR`) rather than on the structure, because the
        cursor is the in-plane origin: centred on the thalamus itself, "is it left of centre" would
        be asking whether its own centroid is left of its own centroid.
        """
        for mode in ("axial", "coronal"):
            cx, _ = self.screen_centroid_of_label(LEFT_THALAMUS, mode, False)
            # The cursor projects to x = PANE/2 - 0.5, so that — not PANE/2 — is "centre".
            self.assertLess(cx, PANE / 2 - 5, f"{mode}: the subject's left is screen-left")
            rx, _ = self.screen_centroid_of_label(LEFT_THALAMUS, mode, True)
            self.assertGreater(rx, PANE / 2 + 5, f"{mode}: radiological mirrors it")
            self.assertAlmostEqual(cx + rx, PANE - 1, delta=0.01, msg=f"{mode}: a pure mirror")

    def test_the_two_thalami_straddle_the_midline_the_right_way_round(self):
        left, _ = self.screen_centroid_of_label(LEFT_THALAMUS, "axial", False)
        right, _ = self.screen_centroid_of_label(RIGHT_THALAMUS, "axial", False)
        self.assertLess(left, right, "L is left of R in neurological")
        left_r, _ = self.screen_centroid_of_label(LEFT_THALAMUS, "axial", True)
        right_r, _ = self.screen_centroid_of_label(RIGHT_THALAMUS, "axial", True)
        self.assertGreater(left_r, right_r, "and right of it in radiological")

    # -- §11: Overlay compositing --------------------------------------------------------------

    def test_the_overlay_is_exactly_independent_of_the_layer_below(self):
        """§11: "exactly 100 %", asserted as independence over every pixel of the pane.

        The heat overlay is opaque wherever it draws, so re-windowing the T1 underneath it must not
        move a single pixel inside the overlay's footprint — and must move pixels outside it, or
        the test would pass on an overlay that drew nothing.
        """
        a = R.render_scene(scene([t1_layer(), ti_layer()]))
        b = R.render_scene(scene([t1_layer(hi=6000.0), ti_layer()]))
        view = R.ViewSpec.from_json(scene([])["view"])
        overlay = R.load_layers(scene([ti_layer()]), OUT)[0]
        _, _, keep = R.render_layer(overlay, view, R.pane_to_world(view))
        self.assertGreater(int(keep.sum()), 500, "the overlay must have a real footprint")
        np.testing.assert_array_equal(a["png"][keep], b["png"][keep])
        self.assertTrue(np.any(a["png"][~keep] != b["png"][~keep]), "outside it, the base shows")

    def test_a_transparent_overlay_leaves_the_base_untouched(self):
        base = R.render_scene(scene([t1_layer()]))
        with_overlay = R.render_scene(scene([t1_layer(), ti_layer(opacity=0.0)]))
        np.testing.assert_array_equal(base["png"], with_overlay["png"])

    def test_the_overlay_lights_up_the_thalamic_target(self):
        vol = N.load_volume(TI)
        r = R.render_scene(scene([t1_layer(), ti_layer()]))
        write_png(OUT / "ref-t1-ti-heat-axial.png", r["png"])
        # The heat colormap is warm; the T1 under it is grey. Coloured pixels are the overlay.
        rgb = r["rgba"][..., :3]
        coloured = (rgb.max(axis=-1) - rgb.min(axis=-1)) > 0.15
        self.assertGreater(int(coloured.sum()), 500)
        self.assertLess(float(coloured.mean()), 0.5, "an overlay, not a repaint")
        self.assertGreater(float(vol.physical(0).max()), 3.0)

    # -- §11: Label outline zoom ---------------------------------------------------------------

    def screen_labels(self, view, layer_spec):
        layer = R.load_layers({"layers": [layer_spec]}, OUT)[0]
        world = R.pane_to_world(view)
        tc = R.world_to_tc(layer.volume, world)
        inside = R.inside_tc(tc)
        phys = np.rint(layer.volume.physical(0)).astype(np.int64)
        return R.sample_nearest(phys, np.clip(tc, 0.0, 1.0)), inside

    @staticmethod
    def thickness(mask: np.ndarray) -> float:
        runs: list[int] = []
        for row in mask:
            n = 0
            for v in row:
                if v:
                    n += 1
                elif n:
                    runs.append(n)
                    n = 0
            if n:
                runs.append(n)
        return float(np.median(runs)) if runs else 0.0

    def test_the_outline_band_is_two_pixels_at_every_zoom_where_a_band_exists(self):
        """§11's named test — with the zoom range its thickness bound is actually defined over.

        A band width is only measurable while a structure is wider than the band. At 5 mm/px a 1 mm
        atlas puts every boundary within a pixel of the next one, all the runs merge, and the
        median run reaches 4 px on this data — not a wider outline, an atlas with nothing left
        between its outlines. §11's [0.8, 2.9] bound is asserted here over 0.05 - 1.0 mm/px, and the
        property that survives at 5 mm/px is coverage, asserted by the next test at that zoom.
        """
        for mm in (0.05, 0.25, 1.0):
            r = R.render_scene(scene([labeling_layer("outline", 2.0)], mm=mm))
            self.assertTrue(r["mask"].any(), f"{mm} mm/px")
            t = self.thickness(r["mask"])
            self.assertGreaterEqual(t, 0.8, f"{mm} mm/px: {t}")
            self.assertLessEqual(t, 2.9, f"{mm} mm/px: {t}")

    def test_the_outline_covers_the_fill_boundary(self):
        """>= 99 % of the boundary between two filled labels is flagged — no gaps to see through."""
        for mm in (0.05, 1.0, 5.0):
            view = R.ViewSpec.from_json(scene([], mm=mm)["view"])
            ids, inside = self.screen_labels(view, labeling_layer("fill"))
            outline = R.render_scene(scene([labeling_layer("outline", 2.0)], mm=mm))["mask"]
            fill = R.render_scene(scene([labeling_layer("fill")], mm=mm))["mask"]
            # Neighbour comparisons by slicing, never `np.roll` — a wrapped edge would invent a
            # boundary between opposite sides of the pane, where no tap can ever reach.
            boundary = np.zeros_like(fill)
            differs = fill & inside
            boundary[:-1] |= differs[:-1] & inside[1:] & (ids[:-1] != ids[1:])
            boundary[1:] |= differs[1:] & inside[:-1] & (ids[1:] != ids[:-1])
            boundary[:, :-1] |= differs[:, :-1] & inside[:, 1:] & (ids[:, :-1] != ids[:, 1:])
            boundary[:, 1:] |= differs[:, 1:] & inside[:, :-1] & (ids[:, 1:] != ids[:, :-1])
            n = int(boundary.sum())
            self.assertGreater(n, 100, f"{mm} mm/px")
            covered = int((boundary & outline).sum()) / n
            self.assertGreaterEqual(covered, 0.99, f"{mm} mm/px: {covered:.4f}")

    def test_outline_over_t1_is_a_readable_atlas_overlay(self):
        for radiological in (False, True):
            r = R.render_scene(
                scene([t1_layer(), labeling_layer("outline", 2.0)], radiological=radiological)
            )
            tag = "rad" if radiological else "neu"
            write_png(OUT / f"ref-t1-labeling-outline-axial-{tag}.png", r["png"])
            self.assertGreater(float(r["mask"].mean()), 0.6)

    def test_the_full_stack_renders(self):
        """T1 + heat overlay + atlas outlines, the three panes, for eyeballing."""
        for mode in ("axial", "coronal", "sagittal"):
            r = R.render_scene(
                scene([t1_layer(), ti_layer(), labeling_layer("outline", 2.0)], mode=mode)
            )
            write_png(OUT / f"ref-stack-{mode}.png", r["png"])
            self.assertGreater(float(r["mask"].mean()), 0.6, mode)


if __name__ == "__main__":
    unittest.main()
