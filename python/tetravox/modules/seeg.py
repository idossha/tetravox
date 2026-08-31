"""`tetravox.seeg` — the sEEG contact editor's job operations, as typed functions.

    from tetravox import Job
    from tetravox.modules import seeg

    job = Job(files=[ct], preset="plain")
    seeg.load(job, ct=ct, tsv=tsv)
    seeg.snap(job, scope="all", radius_mm=1.5)
    seeg.wire(job, on=False)
    seeg.size(job, px=7)
    seeg.flip_tip(job, electrode="LOCC")
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
    `t1` the anatomy to show underneath. Every path is allow-listed by the app before the window
    opens, which is why they are `path` arguments rather than strings.

    **The module opens no files.** It cannot add a dataset, so the CT and — if you name one — the T1
    have to be in the scene already: put them in `Job(files=[...])`, or open them with an earlier
    action. Given a T1 that is open, `load` makes that layer visible in plain grey under the CT's
    150 HU floor and records the file in the saved scene.

    Reports `{"contacts": n, "electrodes": n, "bound": bool}` — `bound` is false when the CT was
    not open, which is the one failure a job can produce that still writes a table. A `t1` you asked
    for adds `{"t1": "shown"}`, or `{"t1": "not-open"}` when the scene does not have that file;
    omitting `t1` reports nothing about it.
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

    Every electrode when `electrode` is omitted. Reports
    `{"electrodes": [{"electrode", "rmsMm", "spacingCv"}, ...]}` — the two numbers that say whether
    the fit is a fit: how far the contacts sit off the line, and how uneven their spacing was.
    """
    return job.module(MODULE_ID, "refit", electrode=electrode)


def renumber(job: Job, electrode: Optional[str] = None) -> Job:
    """Renumber a shaft's contacts tip-first, 1 at the deepest.

    Every electrode when `electrode` is omitted. Reports
    `{"electrodes": [{"electrode", "renamed": n}, ...]}` — `renamed` is how many names changed, so
    a shaft that was already numbered tip-first reports 0 rather than a diff of nothing.
    """
    return job.module(MODULE_ID, "renumber", electrode=electrode)


def ghost(job: Job, on: bool) -> Job:
    """Draw the off-slice contacts of a shaft, so a shaft reads as a shaft while you scroll.

    The 2D projection Slicer has on by default; off for a figure of one slice's contacts alone.
    """
    return job.module(MODULE_ID, "ghost", on=bool(on))


def wire(job: Job, on: bool) -> Job:
    """Draw the shaft line between consecutive contacts of each electrode, or hide it.

    On by default, in the electrode's own colour. Off is for a figure of the contacts alone: fifteen
    shafts' worth of lines over a bone-window CT is a lot of ink for a slice that is about one of
    them. Hiding it changes nothing on disk — the line is drawn from the contact positions.
    """
    return job.module(MODULE_ID, "wire", on=bool(on))


def size(job: Job, px: float) -> Job:
    """How big a contact marker is drawn, in CSS pixels — the panel's Size stepper.

    `px` is **held to 2–12** by the app, the stepper's own bounds: below 2 a marker is a pixel of
    noise over a bone-window CT, above 12 one contact covers the neighbour you are comparing it
    with. It is not clamped here — the app is what clamps, and the operation reports the size it
    settled on, so read `{"dotRadiusPx": px}` back if the number matters to you.

    A display switch like `ghost` and `wire`: nothing changes on disk, and the size is saved with
    the scene. The bigger marker is also a bigger click target, which is why a figure at a clinical
    zoom usually wants one.
    """
    return job.module(MODULE_ID, "size", px=float(px))


def stats(job: Job) -> Job:
    """Report per-electrode geometry and write nothing.

    `{"electrodes": [{"electrode", "n", "rmsMm", "spacingCv", "pitchMm"}, ...]}`, read back with
    `JobResult.results()`. This is the operation that makes a job an *analysis* rather than a
    renderer: a batch over twenty subjects that prints a table and produces no files at all.
    """
    return job.module(MODULE_ID, "stats")


def flip_tip(job: Job, electrode: Optional[str] = None) -> Job:
    """Pin the other end of a shaft as contact 1, without moving or renaming anything.

    Which end is contact 1 comes from a heuristic — the end nearer the head's centre is the deeper
    one — and an occipital shaft entering near the midline can defeat it. `renumber` applies whatever
    the tip currently is, so this is the remedy for a shaft it read backwards, and it is the same
    thing the panel's `t` does. Nothing changes on disk until you `renumber` after it.

    Every electrode when `electrode` is omitted. Reports
    `{"electrodes": [{"electrode", "tip": "low" | "high"}, ...]}`.
    """
    return job.module(MODULE_ID, "flip-tip", electrode=electrode)


def revert(job: Job) -> Job:
    """Put every contact back where the table had it, and bring back the ones deleted since.

    The in-session undo of everything, for a job that decided its own edits were wrong — the `.bak`
    a save writes is the on-disk one. Reports `{"contacts": n, "restored": n}`, where `restored`
    counts the deletions that came back.
    """
    return job.module(MODULE_ID, "revert")


def delete(job: Job, contact: str) -> Job:
    """Remove one contact, named by the label the table gave it (`LINS01`).

    Never "the selected one": a job has no selection. The deletion is recorded in the edit log a
    later `save` writes, with the position the contact had. Reports `{"deleted", "contacts"}`, and
    raises inside the app when no contact has that name — a job that deletes nothing silently is a
    job whose output nobody can check.
    """
    if not isinstance(contact, str) or contact == "":
        raise JobError("delete(contact=...) needs the name of a contact")
    return job.module(MODULE_ID, "delete", contact=contact)


def save(job: Job, out: str) -> Job:
    """Write the electrode table, and its edit log beside it, under `--out`.

    `out` is a name inside the output directory and cannot climb out of it, so a job never writes
    over the table it read — which also means there is nothing there to back up, and no `.bak` is
    made. Reports `{"path", "editlog"}`.
    """
    return job.module(MODULE_ID, "save", out=_out_name(out))
