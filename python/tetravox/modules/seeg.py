"""`tetravox.seeg` — the sEEG contact editor's job operations, as typed functions.

    from tetravox import Job
    from tetravox.modules import seeg

    job = Job(files=[ct], preset="plain")
    seeg.load(job, ct=ct, tsv=tsv)
    seeg.snap(job, scope="all", radius_mm=1.5)
    seeg.refit(job)
    seeg.save(job, out="sub-01_space-T1w_electrodes.tsv")

    result = job.run("out/").raise_for_status()
    print(result.results())          # what each operation reported

Each function appends one `{"type": "module", "module": "tetravox.seeg", ...}` action and returns the
job, so a script reads in the order the app executes it.

**Three things these do that `job.module("tetravox.seeg", ...)` does not.** They spell the arguments
in Python (`radius_mm` for the manifest's `radiusMm`); they make a `path` argument absolute, which
matters because the job document is written *into the output directory* and the app resolves a
relative path against the document — the same rule, from the same function, that `Job(files=[...])`
follows; and they check the two things that are cheap to check here and expensive to discover after
an app launch, which are a `scope` that is not one of the three and a `save` whose `out` would climb
out of `--out`.

**Data only.** Nothing here imports the module — it is TypeScript compiled into the app — or asks
whether the build has it. A wrapper describes an operation's arguments; the app is what runs it, and
the app is what refuses a job naming a module it does not carry.
"""

from __future__ import annotations

import os
from typing import Optional, Tuple, Union

from ..job import Job, JobError, _abspath

#: The module id, so a script can say `job.module(seeg.MODULE_ID, ...)` for an operation added to
#: the manifest after this file was written.
MODULE_ID = "tetravox.seeg"

#: What `snap` may be asked to move: the selected contact, one whole electrode, or everything.
SCOPES: Tuple[str, ...] = ("contact", "electrode", "all")

PathLike = Union[str, "os.PathLike[str]"]


def _out_name(out: str) -> str:
    """An output name, checked the way the app checks it (`job.ts`'s `outName`)."""
    if not isinstance(out, str) or out == "":
        raise JobError("save(out=...) needs a file name under --out")
    if out.startswith("/") or ".." in out:
        raise JobError(f"save(out={out!r}) must be a relative name inside --out (no leading /, no ..)")
    return out


def load(job: Job, ct: PathLike, tsv: PathLike, t1: Optional[PathLike] = None) -> Job:
    """Open a CT and an electrode table, and bind the contacts to the CT.

    `ct` is the bone-window CT the contacts were localised in, `tsv` a BIDS `*_electrodes.tsv`, and
    `t1` the anatomy to show underneath if there is one. Every path is allow-listed by the app before
    the window opens, which is why they are `path` arguments rather than strings.

    Reports `{"contacts": n, "electrodes": n}`.
    """
    return job.module(
        MODULE_ID,
        "load",
        ct=_abspath(ct),
        tsv=_abspath(tsv),
        t1=None if t1 is None else _abspath(t1),
    )


def snap(
    job: Job,
    scope: str = "contact",
    electrode: Optional[str] = None,
    contact: Optional[str] = None,
    radius_mm: Optional[float] = None,
) -> Job:
    """Move contacts onto the intensity peak nearest them.

    `scope` is `"contact"` (the selected one), `"electrode"` (all of one shaft, named by `electrode`)
    or `"all"`. `radius_mm` is the search radius — the panel's default is 1.5 mm, which is about a
    contact's own length, and a larger one starts finding the *neighbouring* contact's metal.

    Reports `{"moved": n, "meanShiftMm": mm}`.
    """
    if scope not in SCOPES:
        raise JobError(f"unknown scope {scope!r}; expected one of {', '.join(SCOPES)}")
    return job.module(
        MODULE_ID,
        "snap",
        scope=scope,
        electrode=electrode,
        contact=contact,
        radiusMm=None if radius_mm is None else float(radius_mm),
    )


def refit(job: Job, electrode: Optional[str] = None) -> Job:
    """Re-fit a shaft: a line through its contacts, then even spacing along it at the median gap.

    Every electrode when `electrode` is omitted. Reports one
    `{"electrode", "rmsMm", "spacingCv"}` per shaft — the two numbers that say whether the fit is a
    fit: how far the contacts sit off the line, and how uneven their spacing was.
    """
    return job.module(MODULE_ID, "refit", electrode=electrode)


def renumber(job: Job, electrode: Optional[str] = None) -> Job:
    """Renumber a shaft's contacts tip-first, 1 at the deepest.

    Every electrode when `electrode` is omitted.
    """
    return job.module(MODULE_ID, "renumber", electrode=electrode)


def ghost(job: Job, on: bool) -> Job:
    """Draw the off-slice contacts of a shaft, so a shaft reads as a shaft while you scroll.

    The 2D projection Slicer has on by default; off for a figure of one slice's contacts alone.
    """
    return job.module(MODULE_ID, "ghost", on=bool(on))


def stats(job: Job) -> Job:
    """Report per-electrode geometry and write nothing.

    `{"electrodes": [{"n", "rmsMm", "spacingCv", "pitchMm"}, ...]}`, read back with
    `JobResult.results()`. This is the operation that makes a job an *analysis* rather than a
    renderer: a batch over twenty subjects that prints a table and produces no files at all.
    """
    return job.module(MODULE_ID, "stats")


def save(job: Job, out: str) -> Job:
    """Write the electrode table, and its edit log beside it, under `--out`.

    `out` is a name inside the output directory and cannot climb out of it, so a job never writes
    over the table it read — which also means there is nothing there to back up, and no `.bak` is
    made. Reports `{"path", "editlog"}`.
    """
    return job.module(MODULE_ID, "save", out=_out_name(out))
