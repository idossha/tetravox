#!/usr/bin/env python3
"""An **independent reference implementation** of §7.3's slice compositing.

Rule 0 of §11 is that an agent cannot judge a PNG, only a number. This is where the numbers come
from for a whole *pane* rather than a hand-computed pixel: the same scene JSON goes to the engine
and to this file, and the engine's screenshot is differenced against this file's `.npy`. It shares
exactly one thing with `packages/engine` — the colormap tables, which `colormaps.py` reads out of
`packages/engine/src/color/colormaps.ts` rather than copying (see that module's header). Everything
else is written from the prose of §3, §4.2, §6.1, §7.3 and §7.6.

The pipeline, per pixel, is §7.3's fragment shader done on the CPU:

    pixel -> world (view basis)  ->  voxel = inverseAffine * world  ->  tc = (voxel + 0.5) / dims
          -> sample (trilinear for scalars, nearest for labels)     ->  v = raw*slope + inter
          -> Threshold gate / heat truncate -> LUT or label palette -> alpha blend, bottom to top

**Scene JSON**

```json
{
  "layers": [{
    "path": "testdata/vol_ramp4.nii",
    "kind": "volume",
    "colormap": "gray",
    "colormapNegative": "blue-cyan",
    "scale":     { "kind": "linear", "lo": 0, "hi": 3 },
    "threshold": { "lo": null, "hi": null, "symmetric": false, "mode": "clamp", "softEdge": 0 },
    "opacity": 1.0,
    "interpolation": "linear",
    "volumeIndex": 0,
    "label": { "lut": "testdata/labels_simnibs_LUT.txt", "mode": "outline",
               "outlineWidthPx": 2, "visibleLabels": [1, 2], "labelOpacity": {"3": 0.5},
               "selectedLabels": [] }
  }],
  "view": { "mode": "axial", "normal": null, "up": null, "cursor": [0, 0, 0],
            "mmPerPx": 0.5, "widthPx": 512, "heightPx": 512, "radiological": false,
            "center": [0, 0] },
  "background": [0, 0, 0, 1]
}
```

`null` (or an absent key) for `threshold.lo` / `.hi` means `-Infinity` / `+Infinity`, matching
`scene/defaults.ts`'s `NO_THRESHOLD`. Paths are resolved relative to the scene file's directory,
then to the repo root, then as given. A layer carrying a `label` block takes §7.3's label path and
its interpolation is forced to `nearest`, exactly as §4.4 requires of a label dataset.

**Outputs** — `<out>.png` (RGBA8), `<out>.npy` (float32 `(H, W, 4)` in 0..1, the composite before
8-bit quantisation) and `<out>.mask.npy` (bool `(H, W)`, true where any layer drew — §11's "volume
footprint", which is what a tolerance is averaged over).

Usage:

    python3 scripts/reference/render_slice.py scene.json -o /tmp/out
    python3 scripts/reference/render_slice.py scene.json -o /tmp/out --stats
"""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Sequence

import numpy as np

from colormaps import bake_scale, build_label_palette, lut_sample, parse_label_lut
from niftiref import Volume, load_volume
from pngio import write_png

REPO_ROOT = Path(__file__).resolve().parents[2]

# `render/passes/slice.ts`'s three label constants, which are engine policy rather than §7.3 prose.
LABEL_OUTLINE_DARKEN = 0.5
LABEL_SELECT_COLOR = (1.0, 1.0, 1.0, 1.0)
LABEL_SELECT_WIDTH_SCALE = 2.0
# The finite stand-in the engine sends for +/-Infinity, so `softEdge * (hi - lo)` is never NaN.
UNBOUNDED = 1e30


# ---------------------------------------------------------------------------------------------
# §3 — the view basis, and pixel -> world
# ---------------------------------------------------------------------------------------------


def _norm(v: Sequence[float]) -> np.ndarray:
    a = np.asarray(v, dtype=np.float64)
    n = np.linalg.norm(a)
    return a / n if n > 0 else np.array([0.0, 0.0, 1.0])


def preset_normal(mode: str) -> np.ndarray:
    """§3's canonical presets: axial `+Z`, coronal `-Y`, sagittal `-X`.

    A plane and its opposite normal are the **same plane** — the sign picks only which side the
    camera sits on — and this is the only triple under which `right = cross(up, normal)` puts the
    subject's left on screen-left in all three panes at once. Coronal `+Y` would give
    `right = -X`, i.e. one `NEU` badge over two opposite conventions. Phase 1 shipped `(+Z, +Y, +X)`
    and the mirrored coronal pane that follows from it; `docs/DECISIONS.md` records the correction.
    """
    return {
        "axial": np.array([0.0, 0.0, 1.0]),
        "coronal": np.array([0.0, -1.0, 0.0]),
        "sagittal": np.array([-1.0, 0.0, 0.0]),
        "oblique": _norm([1.0, 1.0, 1.0]),
    }[mode]


def preset_up(mode: str) -> np.ndarray:
    """Anterior up for axial, superior up for everything else."""
    return np.array([0.0, 1.0, 0.0]) if mode == "axial" else np.array([0.0, 0.0, 1.0])


def slice_basis(normal: Sequence[float], up: Sequence[float], radiological: bool):
    """§3's handedness rule: `right = cross(up, normal)`; `radiological` negates `right` **only**.

    `up` is re-orthogonalised (§4.5), with a fallback for a degenerate `up` rather than NaNs.
    Negating `right` alone is a mirror about the vertical screen axis and never touches `up`, which
    is what makes the flag well defined for an oblique plane too.
    """
    n = _norm(normal)
    u = np.asarray(up, dtype=np.float64) - np.dot(up, n) * n
    if np.linalg.norm(u) < 1e-4:
        ax = int(np.argmin(np.abs(n)))
        fallback = np.eye(3)[ax]
        u = fallback - np.dot(fallback, n) * n
    u = _norm(u)
    r = np.cross(u, n)
    if radiological:
        r = -r
    return _norm(r), u, n


@dataclass
class ViewSpec:
    """A 2D slice pane. The plane is **derived** from `cursor` + `normal`, never stored (§4.5)."""

    mode: str = "axial"
    normal: np.ndarray = field(default_factory=lambda: preset_normal("axial"))
    up: np.ndarray = field(default_factory=lambda: preset_up("axial"))
    cursor: np.ndarray = field(default_factory=lambda: np.zeros(3))
    mm_per_px: float = 0.5
    width_px: int = 256
    height_px: int = 256
    radiological: bool = False
    center: tuple[float, float] = (0.0, 0.0)

    @staticmethod
    def from_json(d: dict) -> "ViewSpec":
        mode = d.get("mode", "axial")
        if mode not in ("axial", "coronal", "sagittal", "oblique"):
            raise ValueError(f"unknown view mode {mode!r}")
        normal = d.get("normal") or preset_normal(mode)
        up = d.get("up") or preset_up(mode)
        return ViewSpec(
            mode=mode,
            normal=np.asarray(normal, dtype=np.float64),
            up=np.asarray(up, dtype=np.float64),
            cursor=np.asarray(d.get("cursor", [0, 0, 0]), dtype=np.float64),
            mm_per_px=float(d.get("mmPerPx", 0.5)),
            width_px=int(d.get("widthPx", 256)),
            height_px=int(d.get("heightPx", 256)),
            radiological=bool(d.get("radiological", False)),
            center=tuple(float(x) for x in d.get("center", (0.0, 0.0))),  # type: ignore[arg-type]
        )

    def basis(self):
        return slice_basis(self.normal, self.up, self.radiological)


def pane_to_world(view: ViewSpec) -> np.ndarray:
    """Every pixel centre of the pane, as world mm. Shape `(H, W, 3)`, **top-left origin**.

    `view/geometry.ts`'s `paneToWorld`, vectorised: pixel `(x, y)` samples its own **centre**,
    `p + 0.5`, so `u = center.x + (x + 0.5 - W/2) * mmPerPx` and
    `v = center.y + (H/2 - y - 0.5) * mmPerPx`, and `world = cursor + right*u + up*v`.

    `center` here is the pane offset **from the cursor**, i.e. the engine's `effectiveSliceView`
    value (§4.5's R3 anchor folded in). A scene JSON has no scene bounds, so it cannot re-derive the
    bbox anchor; the engine-side harness must pass the effective centre. See `docs/TESTING.md`.
    """
    right, up, _ = view.basis()
    xs = (np.arange(view.width_px) + 0.5 - view.width_px / 2) * view.mm_per_px + view.center[0]
    ys = (view.height_px / 2 - np.arange(view.height_px) - 0.5) * view.mm_per_px + view.center[1]
    u = xs[None, :, None]
    v = ys[:, None, None]
    return view.cursor[None, None, :] + right[None, None, :] * u + up[None, None, :] * v


def screen_steps(view: ViewSpec, vol: Volume) -> tuple[np.ndarray, np.ndarray]:
    """§7.3's `duv` / `dvv`: the **texture-space** extent of one screen pixel.

    `duv = (inverseAffine . dFdx(worldPos)) / dims`, and likewise `dvv` with `dFdy`. On a 2D pane
    `dFdx(world)` is exactly `right * mmPerPx`, so the derivative is analytic here rather than a
    2x2-quad estimate. The sign of `dFdy` is irrelevant — the formula taps symmetrically at `+/-k`.
    """
    right, up, _ = view.basis()
    inv3 = vol.inv_affine[:3, :3]
    dims = np.asarray(vol.dims, dtype=np.float64)
    duv = (inv3 @ (right * view.mm_per_px)) / dims
    dvv = (inv3 @ (up * view.mm_per_px)) / dims
    return duv, dvv


# ---------------------------------------------------------------------------------------------
# Sampling — §7.3's `tc = (voxel + 0.5) / dims`, CLAMP_TO_EDGE, LINEAR or NEAREST
# ---------------------------------------------------------------------------------------------


def world_to_tc(vol: Volume, world: np.ndarray) -> np.ndarray:
    """`voxel = inverseAffine * world`, then `tc = (voxel + 0.5) / dims` (§7.3, §3)."""
    m = vol.inv_affine
    voxel = world @ m[:3, :3].T + m[:3, 3]
    return (voxel + 0.5) / np.asarray(vol.dims, dtype=np.float64)


def inside_tc(tc: np.ndarray) -> np.ndarray:
    """§7.3's per-layer AABB discard: a `tc` outside `[0,1]^3` is outside this layer's own box."""
    return np.all((tc >= 0.0) & (tc <= 1.0), axis=-1)


def sample_nearest(data: np.ndarray, tc: np.ndarray) -> np.ndarray:
    """GL `NEAREST` on a 3D texture: texel `floor(tc * dims)`, clamped."""
    dims = np.asarray(data.shape[:3], dtype=np.float64)
    idx = np.floor(tc * dims).astype(np.int64)
    for a in range(3):
        np.clip(idx[..., a], 0, data.shape[a] - 1, out=idx[..., a])
    return data[idx[..., 0], idx[..., 1], idx[..., 2]]


def sample_trilinear(data: np.ndarray, tc: np.ndarray) -> np.ndarray:
    """GL `LINEAR` on a 3D texture with `CLAMP_TO_EDGE`, on the **raw** samples.

    Interpolating raw codes and then applying `v = raw*scale + offset` is what the shader does, and
    it agrees with interpolating physical values because the map is affine — but doing it in this
    order keeps the reference on the same side of §6.1's "scaling is never folded" as the engine.
    """
    d = data.astype(np.float64)
    dims = np.asarray(d.shape[:3], dtype=np.float64)
    p = tc * dims - 0.5
    i0 = np.floor(p).astype(np.int64)
    f = p - i0
    out = np.zeros(tc.shape[:-1], dtype=np.float64)
    for corner in range(8):
        w = np.ones(tc.shape[:-1], dtype=np.float64)
        idx = []
        for a in range(3):
            hi = (corner >> a) & 1
            w *= f[..., a] if hi else (1.0 - f[..., a])
            idx.append(np.clip(i0[..., a] + hi, 0, d.shape[a] - 1))
        out += w * d[idx[0], idx[1], idx[2]]
    return out


# ---------------------------------------------------------------------------------------------
# §4.2's value gate
# ---------------------------------------------------------------------------------------------


def _finite_or(v: float | None, fallback: float) -> float:
    """`null` in the scene JSON, and `+/-Infinity`, both mean "unbounded" — the finite sentinel."""
    return float(v) if v is not None and math.isfinite(v) else fallback


def value_gate(
    v: np.ndarray, threshold: dict, clip_max: float
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """§4.2's `Threshold` plus `heat`'s `truncate` clip. Returns `(v, gateAlpha, keep)`.

    `softEdge` is §4.2's definition verbatim — *width of the alpha ramp as a fraction of `hi - lo`;
    0 = hard discard* — so the ramp is `smoothstep(lo, lo + softEdge*(hi-lo), v)` on the low edge
    and its mirror on the high edge. It is a fraction of the scalar range, not of a histogram bin.

    The ramp lives only on the `'hide'` branch: it **is** the soft form of the discard, and a
    clamped fragment was never going to be dropped. `symmetric` compares `|v|` (and clamps the
    magnitude while keeping the sign).
    """
    lo = _finite_or(threshold.get("lo", -math.inf), -UNBOUNDED)
    hi = _finite_or(threshold.get("hi", math.inf), UNBOUNDED)
    soft = max(0.0, float(threshold.get("softEdge", 0.0)))
    symmetric = bool(threshold.get("symmetric", False))
    mode = threshold.get("mode", "clamp")

    v = v.copy()
    gate = np.ones_like(v)
    keep = np.ones(v.shape, dtype=bool)
    gv = np.abs(v) if symmetric else v

    if mode == "hide":
        ramp = soft * (hi - lo)
        if ramp <= 0.0:
            keep &= (gv >= lo) & (gv <= hi)
        else:
            gate = _smoothstep(lo, lo + ramp, gv) * (1.0 - _smoothstep(hi - ramp, hi, gv))
            keep &= gate > 0.0
    elif symmetric:
        v = np.sign(v) * np.clip(np.abs(v), lo, hi)
    else:
        v = np.clip(v, lo, hi)

    if math.isfinite(clip_max):
        keep &= np.abs(v) <= clip_max
    return v, gate, keep


def _smoothstep(edge0: float, edge1: float, x: np.ndarray) -> np.ndarray:
    """GLSL `smoothstep`, including its `edge0 == edge1` degenerate step."""
    if edge1 == edge0:
        return (x >= edge1).astype(np.float64)
    t = np.clip((x - edge0) / (edge1 - edge0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


# ---------------------------------------------------------------------------------------------
# Layers
# ---------------------------------------------------------------------------------------------


@dataclass
class LayerSpec:
    """One `VolumeLayer` of the scene, with its dataset already loaded."""

    volume: Volume
    colormap: str = "gray"
    colormap_negative: str = "blue-cyan"
    scale: dict = field(default_factory=lambda: {"kind": "linear", "lo": 0.0, "hi": 1.0})
    threshold: dict = field(default_factory=dict)
    opacity: float = 1.0
    interpolation: str = "linear"
    volume_index: int = 0
    label: dict | None = None
    name: str = ""

    @property
    def is_label(self) -> bool:
        return self.label is not None


def resolve_path(p: str, base: Path) -> Path:
    """Scene-relative, then repo-relative, then as given."""
    cand = Path(p)
    if cand.is_absolute() and cand.exists():
        return cand
    for root in (base, REPO_ROOT):
        if (root / p).exists():
            return root / p
    return cand


def load_layers(scene: dict, base: Path) -> list[LayerSpec]:
    layers: list[LayerSpec] = []
    for i, spec in enumerate(scene.get("layers", [])):
        if spec.get("kind", "volume") != "volume":
            raise ValueError(f"layer {i}: only kind 'volume' is implemented")
        path = resolve_path(spec["path"], base)
        label = spec.get("label")
        vol = load_volume(path, force_label=label is not None)
        layers.append(
            LayerSpec(
                volume=vol,
                colormap=spec.get("colormap", "gray"),
                colormap_negative=spec.get("colormapNegative", "blue-cyan"),
                scale=spec.get("scale", {"kind": "linear", "lo": 0.0, "hi": 1.0}),
                threshold=spec.get("threshold", {}),
                opacity=float(spec.get("opacity", 1.0)),
                # §4.4: interpolation is forced to 'nearest' when the dataset is a label volume.
                interpolation="nearest" if label is not None else spec.get("interpolation", "linear"),
                volume_index=int(spec.get("volumeIndex", 0)),
                label=label,
                name=spec.get("name", Path(spec["path"]).name),
            )
        )
    return layers


def render_scalar_layer(layer: LayerSpec, view: ViewSpec, world: np.ndarray):
    """The scalar branch of §7.3's fragment: decode, gate, LUT. Returns `(rgb, alpha, keep)`."""
    vol = layer.volume
    tc = world_to_tc(vol, world)
    keep = inside_tc(tc)
    frame = vol.frame(layer.volume_index)
    raw = (
        sample_trilinear(frame, tc)
        if layer.interpolation == "linear"
        else sample_nearest(frame, tc).astype(np.float64)
    )
    v = raw * vol.scl_slope + vol.scl_inter
    baked = bake_scale(layer.scale, layer.colormap, layer.colormap_negative)
    v, gate, gate_keep = value_gate(v, layer.threshold, baked.clip_max)
    keep &= gate_keep
    rgba = lut_sample(baked, v).astype(np.float64) / 255.0
    keep &= rgba[..., 3] > 0.0
    return rgba[..., :3], rgba[..., 3] * gate * layer.opacity, keep


def render_label_layer(layer: LayerSpec, view: ViewSpec, world: np.ndarray, base: Path):
    """§7.3's label branch: dense palette, `NEAREST`, and the normative 4-tap outline.

    The engine uploads a **dense index remap** and compares dense indices; comparing the ids
    themselves is the same test, because the remap is a bijection. `visibleLabels` / `labelOpacity`
    are baked into the palette here for the same reason they are there: hiding a label is one
    texel's alpha, so no branch in the per-fragment path can get it wrong.
    """
    assert layer.label is not None
    vol = layer.volume
    cfg = layer.label
    tc = world_to_tc(vol, world)
    keep = inside_tc(tc)

    frame = vol.frame(layer.volume_index)
    phys = np.rint(frame.astype(np.float64) * vol.scl_slope + vol.scl_inter).astype(np.int64)
    ids = np.unique(phys)
    lut = parse_label_lut(resolve_path(cfg["lut"], base)) if cfg.get("lut") else None
    opacity_map = {int(k): float(v) for k, v in (cfg.get("labelOpacity") or {}).items()}
    colours = {
        int(k): tuple(float(x) for x in v) for k, v in (cfg.get("labelColors") or {}).items()
    }
    palette = build_label_palette(
        ids, lut, cfg.get("visibleLabels"), opacity_map, colours or None
    )

    def dense_at(coord: np.ndarray) -> np.ndarray:
        return np.searchsorted(ids, sample_nearest(phys, np.clip(coord, 0.0, 1.0)))

    dense = dense_at(tc)
    rgba = palette[dense].astype(np.float64) / 255.0

    duv, dvv = screen_steps(view, vol)
    width = max(0.0, float(cfg.get("outlineWidthPx", 1.0)))
    mode = {"fill": 0, "outline": 1, "both": 2}[cfg.get("mode", "fill")]

    def edge(k: float) -> np.ndarray:
        """§7.3's 4 taps at `+/- k` along the two screen axes, in texture space, clamped.

        The `0.5` in `k = 0.5 * outlineWidthPx` is because **both** sides of a boundary are
        flagged: a naive `+/- outlineWidthPx` offset draws twice the requested width. 4 taps, and
        the step is screen-relative on purpose — a voxel-space step gives a 12.87 px band at
        0.05 mm/px, a 13x regression, and cannot recover a distance from 4 binary taps anyway.
        """
        if k <= 0.0:
            return np.zeros(dense.shape, dtype=bool)
        diff = np.zeros(dense.shape, dtype=bool)
        for step in (duv, -duv, dvv, -dvv):
            diff |= dense_at(tc + k * step) != dense
        return diff

    k = 0.5 * width
    label_edge = edge(k) if mode != 0 else np.zeros(dense.shape, dtype=bool)

    # Whether the fragment survives is decided by the **palette's** alpha, and it has to be read
    # before the selection rim overwrites the colour: a hidden label (alpha 0) gets no rim, which
    # is `LABEL_BODY`'s `if (c.a <= 0.0) discard;` inside the selected branch.
    visible = rgba[..., 3] > 0.0

    selected = set(int(x) for x in (cfg.get("selectedLabels") or []))
    if selected:
        is_sel = np.isin(ids[dense], list(selected))
        sel_rim = is_sel & edge(k * LABEL_SELECT_WIDTH_SCALE) & visible
        # R5's emphasis rim is drawn in **every** mode, `fill` included: select a region and its
        # border lights up while its fill stays exactly as it was.
        rgba[sel_rim] = np.asarray(LABEL_SELECT_COLOR)
    else:
        sel_rim = np.zeros(dense.shape, dtype=bool)

    if mode == 1:
        keep &= label_edge | sel_rim
    elif mode == 2:
        darken = label_edge & ~sel_rim
        rgba[darken, :3] *= LABEL_OUTLINE_DARKEN

    keep &= visible
    return rgba[..., :3], rgba[..., 3] * layer.opacity, keep


def render_layer(layer: LayerSpec, view: ViewSpec, world: np.ndarray, base: Path = REPO_ROOT):
    """One layer's fragment output: `(rgb, alpha, keep)`, before it is blended.

    Exposed because `keep` — which fragments §7.3 **discarded** — is not recoverable from the
    composite: `SRC_ALPHA, ONE_MINUS_SRC_ALPHA` over an opaque background produces an opaque pixel
    whether the layer drew nothing or drew something opaque. A test of the value gate has to look
    here.
    """
    if layer.is_label:
        return render_label_layer(layer, view, world, base)
    return render_scalar_layer(layer, view, world)


def render_scene(scene: dict, base: Path = REPO_ROOT) -> dict[str, np.ndarray]:
    """Render a scene. Returns `{'rgba': float (H,W,4), 'mask': bool (H,W), 'png': uint8 (H,W,4)}`.

    Compositing is §7.3's: **depth test off**, layer order bottom -> top, `SRC_ALPHA,
    ONE_MINUS_SRC_ALPHA` — which is not a separate blend for alpha, so the alpha channel takes the
    same factors (`A = As*As + Ad*(1-As)`), exactly as `gl/state.ts` sets it.
    """
    view = ViewSpec.from_json(scene.get("view", {}))
    layers = load_layers(scene, base)
    world = pane_to_world(view)

    bg = np.asarray(scene.get("background", [0.0, 0.0, 0.0, 1.0]), dtype=np.float64)
    out = np.empty((view.height_px, view.width_px, 4), dtype=np.float64)
    out[...] = bg
    mask = np.zeros((view.height_px, view.width_px), dtype=bool)

    for layer in layers:
        rgb, alpha, keep = render_layer(layer, view, world, base)
        a = np.where(keep, alpha, 0.0)[..., None]
        out[..., :3] = rgb * a + out[..., :3] * (1.0 - a)
        out[..., 3:4] = a * a + out[..., 3:4] * (1.0 - a)
        mask |= keep

    rgba = np.clip(out, 0.0, 1.0).astype(np.float32)
    png = np.rint(rgba * 255.0).astype(np.uint8)
    return {"rgba": rgba, "mask": mask, "png": png}


def render_file(scene_path: str | Path, out_prefix: str | Path) -> dict[str, np.ndarray]:
    scene_path = Path(scene_path)
    scene = json.loads(scene_path.read_text(encoding="utf-8"))
    result = render_scene(scene, base=scene_path.parent)
    out = Path(out_prefix)
    out.parent.mkdir(parents=True, exist_ok=True)
    write_png(out.with_suffix(".png"), result["png"])
    np.save(out.with_suffix(".npy"), result["rgba"])
    np.save(out.with_suffix(".mask.npy"), result["mask"])
    return result


def _stats(result: dict[str, np.ndarray]) -> str:
    rgba, mask = result["rgba"], result["mask"]
    cov = float(mask.mean())
    lines = [
        f"pane           : {rgba.shape[1]} x {rgba.shape[0]} px",
        f"footprint      : {int(mask.sum())} px ({cov * 100:.2f} %)",
        f"mean RGB       : {np.round(rgba[..., :3].mean(axis=(0, 1)), 5).tolist()}",
    ]
    if mask.any():
        inside = rgba[mask]
        lines.append(f"mean RGB (foot): {np.round(inside[:, :3].mean(axis=0), 5).tolist()}")
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("scene", help="scene JSON")
    ap.add_argument("-o", "--out", required=True, help="output prefix (.png/.npy/.mask.npy)")
    ap.add_argument("--stats", action="store_true", help="print footprint and mean colour")
    args = ap.parse_args(argv)
    result = render_file(args.scene, args.out)
    print(f"wrote {Path(args.out).with_suffix('.png')}")
    print(f"wrote {Path(args.out).with_suffix('.npy')}")
    print(f"wrote {Path(args.out).with_suffix('.mask.npy')}")
    if args.stats:
        print(_stats(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
