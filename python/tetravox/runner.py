"""Finding the app, running it, and reading the result back.

Locating the executable is the part that decides whether this client is usable, so it is explicit and
it says what it looked for when it fails:

1. ``TETRAVOX_APP`` — an absolute path to an executable, or to a macOS ``.app`` bundle. Set this and
   nothing else is consulted; it is the answer for a CI image and for an install in an unusual place.
2. The **repository's own build**, when this package is installed from a checkout (``pip install -e``):
   ``packages/app/release/**/Tetravox.app`` or a Linux ``AppImage`` / ``linux-unpacked`` tree.
3. The platform's install location — ``/Applications/Tetravox.app`` on macOS, ``tetravox`` on PATH
   elsewhere.

A dev checkout with no packaged artefact is a *supported* case: ``TETRAVOX_APP`` may point at the
``electron`` binary, and ``TETRAVOX_APP_ARGS`` then carries the app directory it needs
(``TETRAVOX_APP_ARGS=/path/to/packages/app``). That is how this client's own test runs against a
``pnpm build`` without packaging anything.
"""

from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Union

from .job import Job, JobError


@dataclass
class JobResult:
    """The parsed ``job-result.json``."""

    ok: bool
    out_dir: str
    outputs: List[Dict[str, Any]] = field(default_factory=list)
    timings: Dict[str, float] = field(default_factory=dict)
    warnings: List[str] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)
    #: The process's exit status: 0 when every action succeeded.
    returncode: int = 0
    #: Everything the app printed, for a failure that never reached ``job-result.json``.
    stdout: str = ""
    stderr: str = ""
    #: The modules the run used and the version that ran them (ARCHITECTURE §13.6). Empty when it
    #: used none — the key is absent from ``job-result.json`` in that case, which is what keeps a
    #: job written before modules existed producing exactly the file it always produced.
    modules: List[Dict[str, str]] = field(default_factory=list)

    @property
    def files(self) -> List[str]:
        """Every file the run produced, as absolute paths, in the order they were written."""
        return [
            os.path.join(self.out_dir, name)
            for output in self.outputs
            for name in output.get("files", [])
        ]

    def results(self) -> List[Dict[str, Any]]:
        """What each module operation returned, in the order they ran.

        ``files`` answers "what did this run write"; this answers "what did it find" — a `stats`
        operation reports per-electrode geometry and writes nothing at all, and a job that could only
        produce files could not ask it.
        """
        return [
            output["result"]
            for output in self.outputs
            if isinstance(output.get("result"), dict)
        ]

    def files_for(self, index: int) -> List[str]:
        """The files one action produced, by its index in the job."""
        for output in self.outputs:
            if output.get("action") == index:
                return [os.path.join(self.out_dir, name) for name in output.get("files", [])]
        return []

    def raise_for_status(self) -> "JobResult":
        """Raise `JobError` unless the run succeeded — for a script that wants a hard stop."""
        if not self.ok:
            raise JobError(
                f"the job failed ({len(self.errors)} errors): " + "; ".join(self.errors[:3]),
                self.errors,
            )
        return self


def _candidates() -> List[str]:
    """Where an app might be, in the order they are tried, for the error message."""
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.abspath(os.path.join(here, "..", ".."))
    release = os.path.join(repo, "packages", "app", "release")
    out: List[str] = []

    if sys.platform == "darwin":
        if os.path.isdir(release):
            for entry in sorted(os.listdir(release)):
                out.append(os.path.join(release, entry, "Tetravox.app", "Contents", "MacOS", "Tetravox"))
        out.append("/Applications/Tetravox.app/Contents/MacOS/Tetravox")
        out.append(os.path.expanduser("~/Applications/Tetravox.app/Contents/MacOS/Tetravox"))
    else:
        if os.path.isdir(release):
            for entry in sorted(os.listdir(release)):
                if entry.endswith(".AppImage"):
                    out.append(os.path.join(release, entry))
            out.append(os.path.join(release, "linux-unpacked", "tetravox"))
        out.append("/opt/Tetravox/tetravox")
        out.append("/usr/local/bin/tetravox")
    return out


def _resolve_bundle(path: str) -> str:
    """A macOS ``.app`` is a directory; the executable is inside it."""
    if path.endswith(".app") and os.path.isdir(path):
        return os.path.join(path, "Contents", "MacOS", os.path.basename(path)[: -len(".app")])
    return path


def find_app(app: Optional[Union[str, "os.PathLike[str]"]] = None) -> str:
    """The Tetravox executable to run.

    Raises `JobError` listing everywhere it looked, because "app not found" with no list is the least
    actionable error a client can produce.
    """
    if app is not None:
        resolved = _resolve_bundle(os.path.abspath(os.path.expanduser(os.fspath(app))))
        if not os.path.exists(resolved):
            raise JobError(f"no Tetravox at {resolved}")
        return resolved

    from_env = os.environ.get("TETRAVOX_APP")
    if from_env:
        resolved = _resolve_bundle(os.path.expanduser(from_env))
        if not os.path.exists(resolved):
            raise JobError(f"TETRAVOX_APP is set to {from_env!r}, which does not exist")
        return resolved

    tried = _candidates()
    for candidate in tried:
        if os.path.exists(candidate):
            return candidate

    from shutil import which

    on_path = which("tetravox") or which("Tetravox")
    if on_path:
        return on_path

    raise JobError(
        "could not find the Tetravox app. Set TETRAVOX_APP to its executable "
        "(or to the .app bundle). Looked in: " + ", ".join(tried + ["$PATH"])
    )


def _extra_args() -> List[str]:
    """``TETRAVOX_APP_ARGS``: arguments that come before ``--job``.

    This exists for the dev-build case, where ``TETRAVOX_APP`` is the ``electron`` binary and the app
    is a directory it has to be pointed at. Split with `shlex` so a path with a space works.
    """
    raw = os.environ.get("TETRAVOX_APP_ARGS", "").strip()
    return shlex.split(raw) if raw else []


def run_job(
    job: Job,
    out_dir: Union[str, "os.PathLike[str]"],
    app: Optional[Union[str, "os.PathLike[str]"]] = None,
    *,
    quiet: bool = True,
    timeout: Optional[float] = 900.0,
    keep_job_file: bool = False,
    extra_args: Optional[Sequence[str]] = None,
) -> JobResult:
    """Write the job, run the app, parse ``job-result.json``.

    The job document is written **into the output directory** (as ``job.json``) and deleted afterwards
    unless `keep_job_file` is set. That keeps a run self-describing while it happens — a job that hangs
    can be inspected — without leaving clutter behind a successful one.

    The app is run with no window (`docs/AUTOMATION.md`: a job is always offscreen and never takes
    focus), so this is safe to call from a script while you are doing something else.
    """
    executable = find_app(app)
    target = os.path.abspath(os.path.expanduser(os.fspath(out_dir)))
    os.makedirs(target, exist_ok=True)

    document = job.to_dict()
    job_path = os.path.join(target, "job.json")
    with open(job_path, "w", encoding="utf-8") as handle:
        json.dump(document, handle, indent=2)
        handle.write("\n")

    command = [executable, *_extra_args(), *(extra_args or []), "--job", job_path, "--out", target]
    if quiet:
        command.append("--quiet")

    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as expired:
        raise JobError(f"the job did not finish within {timeout} s") from expired
    finally:
        if not keep_job_file:
            try:
                os.remove(job_path)
            except OSError:
                pass

    result_path = os.path.join(target, "job-result.json")
    if not os.path.exists(result_path):
        raise JobError(
            "the app produced no job-result.json — it may have failed to start.\n"
            f"command: {' '.join(command)}\n"
            f"exit {completed.returncode}\n{completed.stdout}\n{completed.stderr}"
        )
    with open(result_path, encoding="utf-8") as handle:
        parsed = json.load(handle)

    return JobResult(
        ok=bool(parsed.get("ok")),
        out_dir=parsed.get("outDir", target),
        outputs=parsed.get("outputs", []),
        timings=parsed.get("timings", {}),
        warnings=parsed.get("warnings", []),
        errors=parsed.get("errors", []),
        returncode=completed.returncode,
        stdout=completed.stdout,
        stderr=completed.stderr,
        modules=parsed.get("modules", []),
    )


def _temp_out() -> str:
    return tempfile.mkdtemp(prefix="tetravox-job-")
