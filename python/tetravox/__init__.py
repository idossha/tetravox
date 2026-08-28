"""Tetravox automation client — build a job, run the app, get your pictures back.

    from tetravox import Job

    result = Job(files=["T1.nii.gz", "sim_TI_max.nii.gz"], preset="ti-field-on-t1") \\
        .set(cursor=(0, -18, 8)) \\
        .screenshot("axial.png", view="axial", width=1200) \\
        .sweep("sweep", view="axial", count=24, format="mp4") \\
        .run("out/")

    print(result.files)

Standard library only, on purpose: this is meant to be dropped into an analysis environment that
already has its own pinned scientific stack, and a visualisation helper that drags in dependencies is
one nobody installs. The whole client is a JSON document builder plus a `subprocess` call.

The job schema is `docs/AUTOMATION.md`; `packages/app/src/main/job.ts` is its validator, and it is the
one that decides. This module builds documents that satisfy it and reports what it says when they do
not — it deliberately does **not** re-implement the validation, because two validators disagree the
moment one of them is edited.
"""

from .job import Job, JobError, Preset
from .runner import JobResult, find_app

__all__ = ["Job", "JobError", "JobResult", "Preset", "find_app", "__version__"]

__version__ = "0.1.0"
