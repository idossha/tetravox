"""Building a job document.

`Job` is a chainable builder over the JSON schema in `docs/AUTOMATION.md`. Each method appends one
action and returns `self`, so a script reads in the order the app will execute it.

Two design choices worth stating:

* **Paths are made absolute at build time.** The app resolves relative paths against the job file's
  directory, and a job written to a temporary directory would then look for `T1.nii.gz` beside itself.
  Resolving here means a script's paths mean what they mean *in the script*.
* **Nothing is validated beyond the obvious.** The app's validator is the contract, and it reports
  every problem at once with a path into the document (`actions[2].step: must not be 0`). A second,
  drifting copy of those rules here would turn one clear error into two confusing ones. What this
  module does check is the handful of things it can catch *before* an app launch costs a second:
  unknown keyword arguments, an empty file list, a preset that is not a preset.
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, Iterable, List, Literal, Optional, Sequence, Tuple, Union

Preset = Literal["plain", "ti-field-on-t1", "mesh-tissues-translucent", "atlas-outline"]

PRESETS: Tuple[str, ...] = (
    "plain",
    "ti-field-on-t1",
    "mesh-tissues-translucent",
    "atlas-outline",
)

VIEWS: Tuple[str, ...] = ("axial", "coronal", "sagittal", "view3d")
# What a `screenshot` or a `tween` may photograph: a pane, the whole view grid, or the whole window
# — panels, toolbar and status bar included. `window` needs `Job(panels=True)` to have anything to
# show, and it is the only capture that does not come off the engine's canvas.
CAPTURE_TARGETS: Tuple[str, ...] = VIEWS + ("grid", "window")
SLICE_VIEWS: Tuple[str, ...] = ("axial", "coronal", "sagittal")
LAYOUTS: Tuple[str, ...] = (
    "1x1",
    "1x3",
    "1x3-horizontal",
    "2x2",
    "3d-only",
    "1+3",
    "3d+1",
)
FORMATS: Tuple[str, ...] = ("png", "gif", "mp4")
BACKGROUNDS: Tuple[str, ...] = ("scene", "white", "black", "transparent")

Vec3 = Sequence[float]


class JobError(RuntimeError):
    """A job that could not be built, launched, or that the app refused.

    Carries `errors` — the app's own messages, one per problem — when the app is what refused it.
    """

    def __init__(self, message: str, errors: Optional[Sequence[str]] = None) -> None:
        super().__init__(message)
        self.errors: List[str] = list(errors or [])


def _abspath(path: Union[str, "os.PathLike[str]"]) -> str:
    return os.path.abspath(os.path.expanduser(os.fspath(path)))


def _drop_none(bag: Dict[str, Any]) -> Dict[str, Any]:
    """Omit unset options entirely: the app fills its own defaults, and a `null` is not one."""
    return {k: v for k, v in bag.items() if v is not None}


def _include(
    colorbar: Optional[bool] = None,
    orientation_labels: Optional[bool] = None,
    crosshair: Optional[bool] = None,
    corner_info: Optional[bool] = None,
    scale_bar: Optional[bool] = None,
) -> Optional[Dict[str, bool]]:
    bag = _drop_none(
        {
            "colorbar": colorbar,
            "orientationLabels": orientation_labels,
            "crosshair": crosshair,
            "cornerInfo": corner_info,
            "scaleBar": scale_bar,
        }
    )
    return bag or None


class Job:
    """One `--job` document: a scene, a window and a list of actions."""

    def __init__(
        self,
        files: Optional[Iterable[Union[str, "os.PathLike[str]"]]] = None,
        preset: Preset = "plain",
        *,
        window: Optional[Tuple[int, int]] = None,
        panels: bool = False,
    ) -> None:
        if files is None:
            raise JobError("Job(files=...) needs at least one file; use Job.from_scene(path) for a saved scene")
        paths = [_abspath(f) for f in files]
        if not paths:
            raise JobError("Job(files=[]) has nothing to load")
        if preset not in PRESETS:
            raise JobError(f"unknown preset {preset!r}; expected one of {', '.join(PRESETS)}")
        self._scene: Dict[str, Any] = {"files": paths, "preset": preset}
        self._window: Optional[Tuple[int, int]] = window
        self._panels = bool(panels)
        self._actions: List[Dict[str, Any]] = []

    # -- construction ------------------------------------------------------------------------

    @classmethod
    def from_scene(
        cls,
        path: Union[str, "os.PathLike[str]"],
        *,
        window: Optional[Tuple[int, int]] = None,
        panels: bool = False,
    ) -> "Job":
        """A job over a scene saved from the app (`*.tetravox.json`, ARCHITECTURE §4.6).

        Everything the scene carries — layers, colormaps, thresholds, the camera — is restored, so a
        saved scene is how you script a visualisation you built by hand rather than describing it
        again in Python.
        """
        job = cls.__new__(cls)
        job._scene = {"path": _abspath(path)}
        job._window = window
        job._panels = bool(panels)
        job._actions = []
        return job

    def window(self, width: int, height: int, *, panels: Optional[bool] = None) -> "Job":
        """The offscreen window's size. Screenshots are captured from panes of *this* window, so a
        larger window is a sharper picture, not a bigger crop of the same one.

        `panels=True` draws the §8 shell — layer panel, region panel, tissue table, toolbar — in that
        window, which is what a `view="window"` capture photographs. Off by default: an engine
        screenshot never contains the panels, so a job that is not about the interface gives the
        whole window to the view grid.
        """
        self._window = (int(width), int(height))
        if panels is not None:
            self._panels = bool(panels)
        return self

    # -- actions -----------------------------------------------------------------------------

    def set(
        self,
        *,
        layer: Optional[Union[int, str]] = None,
        patch: Optional[Dict[str, Any]] = None,
        active: Optional[Union[int, str]] = None,
        cursor: Optional[Vec3] = None,
        layout: Optional[str] = None,
        camera: Optional[str] = None,
        view: Optional[str] = None,
        mm_per_px: Optional[float] = None,
        center: Optional[Sequence[float]] = None,
        distance: Optional[float] = None,
        radiological: Optional[bool] = None,
        reset: Optional[bool] = None,
        annotations: Optional[Dict[str, bool]] = None,
    ) -> "Job":
        """Change the scene: a layer patch, the cursor, the layout, the 3D camera.

        `patch` is a `Partial<Layer>` in the app's own vocabulary (ARCHITECTURE §4.4) and is passed
        through untouched — `{"colormap": "viridis", "opacity": 0.6}`. `layer` selects it by index,
        by name (`"T1.nii.gz"`), by a suffix of its path, or `"active"`.

        `camera` is a §7.5 preset: `"1".."6"` or one of `A P L R S I` (anterior, posterior, left,
        right, superior, inferior).

        `mm_per_px` is the 2D zoom for `view` — smaller is closer. The scene default is 0.5, which
        covers 350 mm on a 700 px pane, so a head fills about half the frame; 0.3 fills it. This is
        the control a figure wants; `reset=True` fits the scene bounds to one axis of the pane and
        crops the other.

        `distance` is the same idea for the 3D view: the camera's distance from its target in
        millimetres (default 400, which frames about 250 mm at the default field of view).

        `active` selects the layer the panels show — the same selector as `layer`, and the same
        thing as clicking a row in the layer panel. It changes nothing an engine screenshot can see,
        and everything a `view="window"` capture can.
        """
        if layout is not None and layout not in LAYOUTS:
            raise JobError(f"unknown layout {layout!r}; expected one of {', '.join(LAYOUTS)}")
        if view is not None and view not in VIEWS:
            raise JobError(f"unknown view {view!r}; expected one of {', '.join(VIEWS)}")
        action = _drop_none(
            {
                "type": "set",
                "layer": layer,
                "patch": patch,
                "active": active,
                "cursor": [float(v) for v in cursor] if cursor is not None else None,
                "layout": layout,
                "camera": str(camera) if camera is not None else None,
                "view": view,
                "mmPerPx": mm_per_px,
                "center": [float(v) for v in center] if center is not None else None,
                "distance": distance,
                "radiological": radiological,
                "reset": reset,
                "annotations": annotations,
            }
        )
        self._actions.append(action)
        return self

    def screenshot(
        self,
        out: str,
        *,
        view: str = "grid",
        width: Optional[int] = None,
        height: Optional[int] = None,
        scale: Optional[int] = None,
        dpi: Optional[int] = None,
        background: Optional[str] = None,
        autotrim: Optional[bool] = None,
        colorbar: Optional[bool] = None,
        orientation_labels: Optional[bool] = None,
        crosshair: Optional[bool] = None,
        corner_info: Optional[bool] = None,
        scale_bar: Optional[bool] = None,
    ) -> "Job":
        """One PNG. `view="grid"` captures the whole view grid; a view id captures that pane.

        `width` / `height` describe the **output** and the frame is rendered at that size rather than
        upscaled from the pane, so asking for 2400 px gives you 2400 px of detail. `dpi` is written
        into the PNG's `pHYs` chunk, which is what a journal's figure checker reads.
        """
        if view not in CAPTURE_TARGETS:
            raise JobError(f"unknown view {view!r}; expected one of {', '.join(CAPTURE_TARGETS)}")
        if background is not None and background not in BACKGROUNDS:
            raise JobError(f"unknown background {background!r}; expected one of {', '.join(BACKGROUNDS)}")
        self._actions.append(
            _drop_none(
                {
                    "type": "screenshot",
                    "out": out,
                    "view": view,
                    "width": width,
                    "height": height,
                    "scale": scale,
                    "dpi": dpi,
                    "background": background,
                    "autoTrim": autotrim,
                    "include": _include(colorbar, orientation_labels, crosshair, corner_info, scale_bar),
                }
            )
        )
        return self

    def sweep(
        self,
        out: str,
        *,
        view: str = "axial",
        start: Optional[float] = None,
        stop: Optional[float] = None,
        step: Optional[float] = None,
        count: Optional[int] = None,
        fps: Optional[int] = None,
        format: Optional[Union[str, Sequence[str]]] = None,
        colors: Optional[int] = None,
        sequence: Optional[str] = None,
        gif: Optional[bool] = None,
        width: Optional[int] = None,
        height: Optional[int] = None,
        background: Optional[str] = None,
        colorbar: Optional[bool] = None,
        crosshair: Optional[bool] = None,
    ) -> "Job":
        """Step a 2D view through the volume: a PNG sequence, a GIF, and an MP4 when asked for.

        `start` / `stop` are millimetres along the view's normal in world RAS; leave them out and the
        sweep covers the scene's own extent along that axis, inset so it does not open on an empty
        slice. Pace it with either `step` (millimetres per frame) or `count` (frames, both ends
        inclusive) — not both.

        PNG frames and a GIF are always written. `format="mp4"` adds an H.264 file when `ffmpeg` is on
        PATH, and records a warning in the result rather than failing when it is not.

        `colors` caps the GIF's palette (2..256, default 256). A dense 3D render at 500 px can make a
        5 MB GIF at full colour and a 1 MB one at 64, with no visible difference on a 3D surface.
        """
        if view not in SLICE_VIEWS:
            raise JobError(f"a sweep steps a slice: view must be one of {', '.join(SLICE_VIEWS)}")
        if sequence is not None and sequence not in ("start", "continue", "end"):
            raise JobError(f"unknown sequence {sequence!r}; expected start, continue or end")
        self._actions.append(
            _drop_none(
                {
                    "type": "sweep",
                    "out": out,
                    "view": view,
                    "from": start,
                    "to": stop,
                    "step": step,
                    "count": count,
                    "fps": fps,
                    "format": _formats(format),
                    "colors": colors,
                    "sequence": sequence,
                    "gif": gif,
                    "width": width,
                    "height": height,
                    "background": background,
                    "include": _include(colorbar=colorbar, crosshair=crosshair),
                }
            )
        )
        return self

    def orbit(
        self,
        out: str,
        *,
        degrees: Optional[float] = None,
        frames: Optional[int] = None,
        axis: Optional[str] = None,
        fps: Optional[int] = None,
        format: Optional[Union[str, Sequence[str]]] = None,
        colors: Optional[int] = None,
        sequence: Optional[str] = None,
        gif: Optional[bool] = None,
        width: Optional[int] = None,
        height: Optional[int] = None,
        background: Optional[str] = None,
        colorbar: Optional[bool] = None,
        orientation_labels: Optional[bool] = None,
        crosshair: Optional[bool] = None,
        corner_info: Optional[bool] = None,
        scale_bar: Optional[bool] = None,
    ) -> "Job":
        """Turntable the 3D view: a PNG sequence, a GIF, and an MP4 when asked for.

        Defaults to a full 360° in 36 frames about `z` (the superior axis in RAS). The last frame
        stops one step short of the full turn, so the animation loops without a repeated frame, and
        the camera is put back where it was afterwards.
        """
        if axis is not None and axis not in ("x", "y", "z"):
            raise JobError(f"unknown axis {axis!r}; expected x, y or z")
        if sequence is not None and sequence not in ("start", "continue", "end"):
            raise JobError(f"unknown sequence {sequence!r}; expected start, continue or end")
        self._actions.append(
            _drop_none(
                {
                    "type": "orbit",
                    "out": out,
                    "degrees": degrees,
                    "frames": frames,
                    "axis": axis,
                    "fps": fps,
                    "format": _formats(format),
                    "colors": colors,
                    "sequence": sequence,
                    "gif": gif,
                    "width": width,
                    "height": height,
                    "background": background,
                    "include": _include(
                        colorbar, orientation_labels, crosshair, corner_info, scale_bar
                    ),
                }
            )
        )
        return self

    def tween(
        self,
        out: str,
        *,
        to: Optional[Dict[str, Any]] = None,
        start: Optional[Dict[str, Any]] = None,
        frames: Optional[int] = None,
        ease: Optional[str] = None,
        orbit: Optional[Dict[str, Any]] = None,
        view: Optional[str] = None,
        fps: Optional[int] = None,
        format: Optional[Union[str, Sequence[str]]] = None,
        colors: Optional[int] = None,
        sequence: Optional[str] = None,
        gif: Optional[bool] = None,
        width: Optional[int] = None,
        height: Optional[int] = None,
        background: Optional[str] = None,
        colorbar: Optional[bool] = None,
        orientation_labels: Optional[bool] = None,
        crosshair: Optional[bool] = None,
        corner_info: Optional[bool] = None,
        scale_bar: Optional[bool] = None,
    ) -> "Job":
        """N eased frames between two scene states.

        `sweep` steps a slice and `orbit` turns a camera; a tween moves anything a number can
        describe — the cursor, the 3D camera's distance and target, a pane's zoom, and any numeric
        field of any layer (an opacity, a clip offset, a threshold, an iso level).

        `start` is the JSON document's `from`, renamed because `from` is a Python keyword — the same
        forced rename `sweep(start=, stop=)` already carries. Omit it and the tween begins wherever
        the scene already is. Unlike `orbit`, a tween leaves the scene where it ended.

        `sequence` is `start` / `continue` / `end`: several actions writing into one `out`, encoded
        once at the end. That is how a long video is made of many shots.
        """
        if ease is not None and ease not in ("linear", "in", "out", "inOut"):
            raise JobError(f"unknown ease {ease!r}; expected linear, in, out or inOut")
        if sequence is not None and sequence not in ("start", "continue", "end"):
            raise JobError(f"unknown sequence {sequence!r}; expected start, continue or end")
        if view is not None and view not in CAPTURE_TARGETS:
            raise JobError(f"unknown view {view!r}; expected one of {', '.join(CAPTURE_TARGETS)}")
        if to is None and orbit is None:
            raise JobError("a tween with no `to` and no `orbit` has nowhere to go")
        self._actions.append(
            _drop_none(
                {
                    "type": "tween",
                    "out": out,
                    "frames": frames,
                    "ease": ease,
                    "from": start,
                    "to": to,
                    "orbit": orbit,
                    "view": view,
                    "fps": fps,
                    "format": _formats(format),
                    "colors": colors,
                    "sequence": sequence,
                    "gif": gif,
                    "width": width,
                    "height": height,
                    "background": background,
                    "include": _include(
                        colorbar, orientation_labels, crosshair, corner_info, scale_bar
                    ),
                }
            )
        )
        return self

    # -- output ------------------------------------------------------------------------------

    def to_dict(self) -> Dict[str, Any]:
        """The job document, exactly as it will be written."""
        if not self._actions:
            raise JobError(
                "a job with no actions renders nothing; add a screenshot, sweep, orbit or tween"
            )
        job: Dict[str, Any] = {"version": 1, "scene": self._scene}
        if self._window is not None or self._panels:
            width, height = self._window or (1400, 900)
            job["window"] = {"width": width, "height": height}
            if self._panels:
                job["window"]["panels"] = True
        job["actions"] = self._actions
        return job

    def to_json(self, indent: int = 2) -> str:
        return json.dumps(self.to_dict(), indent=indent)

    def write(self, path: Union[str, "os.PathLike[str]"]) -> str:
        """Write the job to a file and return its path — for `Tetravox --job` by hand, or for a
        record of what a script asked for."""
        target = _abspath(path)
        with open(target, "w", encoding="utf-8") as handle:
            handle.write(self.to_json() + "\n")
        return target

    def run(
        self,
        out_dir: Union[str, "os.PathLike[str]"],
        app: Optional[Union[str, "os.PathLike[str]"]] = None,
        *,
        quiet: bool = True,
        timeout: Optional[float] = 900.0,
        keep_job_file: bool = False,
    ):  # -> JobResult
        """Run the job and return the parsed `job-result.json`.

        Imported lazily so `Job` can be built, inspected and written on a machine with no app
        installed — which is what a test suite and a notebook that only generates job files do.
        """
        from .runner import run_job

        return run_job(
            self,
            out_dir,
            app=app,
            quiet=quiet,
            timeout=timeout,
            keep_job_file=keep_job_file,
        )

    def __repr__(self) -> str:
        what = self._scene.get("path") or f"{len(self._scene.get('files', []))} files"
        return f"<Job {what}, {len(self._actions)} actions>"


def _formats(format: Optional[Union[str, Sequence[str]]]) -> Optional[Union[str, List[str]]]:
    if format is None:
        return None
    values = [format] if isinstance(format, str) else list(format)
    for value in values:
        if value not in FORMATS:
            raise JobError(f"unknown format {value!r}; expected one of {', '.join(FORMATS)}")
    return values[0] if isinstance(format, str) else values
