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
Runnable examples are in [`examples/`](examples).
