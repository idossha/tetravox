# `examples/capture/` — scripted pictures

Four Python scripts that drive the app from the outside: they build a job, hand it to Tetravox, and
get PNGs, GIFs and MP4s back. The app renders **offscreen** — a job never puts a window on your
screen and never takes focus — through the same `Engine` calls a user makes with the mouse, so a
picture one of these produces is a picture the product produces.

The client is `python/tetravox/`, the job schema is [`docs/AUTOMATION.md`](../../docs/AUTOMATION.md).

## Running them

```sh
# 1. the data — ~906 MB into data/ernie/, which is git-ignored
export TETRAVOX_TESTDATA=/path/to/derivatives/SimNIBS/sub-ernie
scripts/fetch-data.sh

# 2. the client
pip install -e python/

# 3. the app. Against a packaged build, nothing to set; against a dev checkout:
pnpm wasm && pnpm --filter @tetravox/app build
export TETRAVOX_APP="$PWD/node_modules/.bin/electron"
export TETRAVOX_APP_ARGS="$PWD/packages/app"

python examples/capture/orbit.py
```

`run()` looks for the app in `TETRAVOX_APP`, then this repository's own `packages/app/release/`,
then `/Applications/Tetravox.app` or `tetravox` on `PATH`, and lists everywhere it looked when it
finds nothing.

## Where the output goes

| Script | Writes to | What it makes |
|---|---|---|
| [`screenshot.py`](screenshot.py) | `out/screenshot/` | Two PNGs from one launch: an axial T1, and the left pial surface over the T1's three planes. |
| [`sweep.py`](sweep.py) | `out/sweep/` | A 32-frame axial sweep through the TI field on the T1 — PNG frames, a GIF and an MP4. |
| [`orbit.py`](orbit.py) | `out/orbit/` | A 36-frame turntable of the head mesh, as a GIF and an MP4. |
| [`showcase.py`](showcase.py) | `docs/media/` | The whole showcase film: `showcase.mp4`, `showcase-preview.gif` and `SHOWCASE.md`. |

`TETRAVOX_EXAMPLE_OUT` moves the first three somewhere else; `TETRAVOX_DATA` points all four at a
different copy of the data. `showcase.py` takes `--out` (default `docs/media/`) and `--work` (default
`/tmp/tetravox-showcase`, where ~3 GB of PNG frames and the three job documents land).

Every run also writes `job-result.json` beside its output: what was written, in what order, how long
each action took, and every warning. A failed run still writes it, which is what makes a failure
diagnosable from a log rather than from a screen.

## The showcase script

`showcase.py` is the long one, and it is meant to be read and changed. It is one function per shot,
in screen order, and each one opens with the numbers that shot is about:

```python
def act_c_field(job: Job) -> None:
    zoom_wide, zoom_close = 0.30, 0.17   # mm per pixel
    field_opacity = 0.92
    ...
```

Every shot calls `story(shot, caption, frames, note)`. That one list is the caption burned into the
film, the timeline in `docs/media/SHOWCASE.md`, and the film's length — so a shot cannot get longer
without its caption and its row moving with it. To re-cut the film, change a constant or reorder the
calls in `build_film`; to see what a change costs before rendering 2,900 frames, run

```sh
python examples/capture/showcase.py --jobs-only
```

which writes the job documents and prints the shot count and running time without launching the app.

## Two things worth knowing

**A job's window normally has no panels.** A screenshot comes off the engine's canvas, which never
contains them, so `--job` gives the whole window to the view grid. The showcase's opening tour is the
exception: it asks for `Job(panels=True)` and captures with `view="window"`, which photographs the
window itself — toolbar, layer panel, region list, tissue table and all. That is the only capture in
any of these scripts that does not come off the engine.

**A job has one scene.** Loading `Thalamus_TI.msh` is 243 MB and about a second, and six figures from
six launches would pay for it six times — so one job loads once and runs every action against that
scene in order. It is also why the showcase is three jobs rather than one: the tour needs a *small*
scene, because the layer panel shows every layer that is loaded.
