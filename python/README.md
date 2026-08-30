# tetravox (Python client)

Drive [Tetravox](../README.md) from a script: load data, auto-configure a visualisation, and capture
screenshots, slice sweeps and 3D orbits. The app runs with **no window** and never takes focus, so a
batch of figures can be produced while you work.

```sh
pip install -e python/
```

```python
from tetravox import Job

result = (
    Job(files=["m2m_ernie/T1.nii.gz", "Simulations/.../sim_TI_max.nii.gz"], preset="ti-field-on-t1")
    .set(cursor=(0, -18, 8))
    .screenshot("axial.png", view="axial", width=1600, dpi=300)
    .sweep("sweep", view="axial", count=24, fps=12, format="mp4")
    .run("figures/")
)
result.raise_for_status()
print(result.files)
```

Set `TETRAVOX_APP` if the app is not in `/Applications` (macOS) or on `PATH`. The full job schema,
the preset table and the dev-build recipe are in [`docs/AUTOMATION.md`](../docs/AUTOMATION.md).
Runnable examples are in [`examples/capture/`](../examples/capture).

## Modules

A **module** is a first-party tool inside the app with its own panel, keys and files — the sEEG
contact editor is the first. Every button in its panel is also a job *operation*, and `Job.module`
runs any of them:

```python
job.module("tetravox.seeg", "snap", scope="all", radiusMm=1.5)
```

The argument names there are the module's manifest's, verbatim, because the manifest is the schema
the app validates against. `tetravox.modules` is where each module's vocabulary is written in
Python's — snake_case, a real signature per operation, and paths made absolute the way
`Job(files=...)` makes them absolute:

```python
from tetravox import Job
from tetravox.modules import seeg

job = Job(files=[ct], preset="plain")
seeg.load(job, ct=ct, tsv=tsv)
seeg.snap(job, scope="all", radius_mm=1.5)
seeg.refit(job)
seeg.stats(job)
seeg.save(job, out="sub-01_space-T1w_electrodes.tsv")

result = job.run("out/").raise_for_status()
print(result.modules)    # [{'id': 'tetravox.seeg', 'version': '0.1.0'}]
print(result.results())  # what each operation reported, in order
```

`results()` is the half a renderer does not have: `stats` writes no file at all and answers with
per-electrode geometry, so a batch over twenty subjects can print a table and produce nothing else.
The wrappers are data — they build a document and never import the module — so they install and run
on a machine whose Tetravox build does not carry it. The app is what refuses that job, by name.

## Tests

Standard library only, and no app required for the document half:

```sh
python -m unittest discover -s python/tests
```

The end-to-end half runs one of `examples/capture/` against a real build and **skips** when there is
no app (`TETRAVOX_APP`) or no data (`scripts/fetch-data.sh`).
