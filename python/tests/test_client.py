"""Tests for the Python client.

Two halves, and the split is deliberate:

* **Document tests** run everywhere, with no app and no data. They assert the JSON a `Job` builds,
  because that JSON is the contract with `packages/app/src/main/job.ts` — and the schema unit test on
  the TypeScript side asserts the other end of the same contract.
* **An end-to-end test** runs one of `examples/capture/` against a real build, and **skips** when
  either is absent. That is the repository's rule for real-data tests (`docs/TESTING.md`): they skip,
  never fail, when `TETRAVOX_TESTDATA` is unset, so a checkout with no dataset and no packaged app is
  still green.

Run it with:

    scripts/fetch-data.sh
    TETRAVOX_APP=$(pnpm exec which electron) TETRAVOX_APP_ARGS=$PWD/packages/app \\
      python -m unittest discover -s python/tests
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from tetravox import Job, JobError, find_app  # noqa: E402

# The examples moved out of `python/` and into the repository's own `examples/capture/` — one copy,
# next to the data they read (`data/ernie/`, `scripts/fetch-data.sh`).
EXAMPLES = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "examples", "capture")
)


class TestJobDocument(unittest.TestCase):
    def test_minimal_job(self) -> None:
        job = Job(files=["/data/T1.nii.gz"]).screenshot("a.png")
        document = job.to_dict()
        self.assertEqual(document["version"], 1)
        self.assertEqual(document["scene"], {"files": ["/data/T1.nii.gz"], "preset": "plain"})
        self.assertEqual(document["actions"], [{"type": "screenshot", "out": "a.png", "view": "grid"}])

    def test_paths_are_absolute_because_the_app_resolves_against_the_job_file(self) -> None:
        job = Job(files=["T1.nii.gz"]).screenshot("a.png")
        path = job.to_dict()["scene"]["files"][0]
        self.assertTrue(os.path.isabs(path))
        self.assertEqual(path, os.path.join(os.getcwd(), "T1.nii.gz"))

    def test_unset_options_are_omitted_not_null(self) -> None:
        # A `null` is not a default: the app fills its own, and a key that is present with `null`
        # would have to be special-cased on the other side.
        action = Job(files=["/a.nii"]).screenshot("a.png", width=800).to_dict()["actions"][0]
        self.assertEqual(set(action), {"type", "out", "view", "width"})

    def test_chaining_preserves_action_order(self) -> None:
        job = (
            Job(files=["/a.nii"])
            .set(cursor=(1, 2, 3))
            .screenshot("a.png")
            .sweep("s", view="coronal", count=4)
            .orbit("o", frames=8)
        )
        self.assertEqual([a["type"] for a in job.to_dict()["actions"]], ["set", "screenshot", "sweep", "orbit"])

    def test_sweep_range_uses_the_schema_key_names(self) -> None:
        # Python cannot have a parameter called `from`, so the client says `start` / `stop` and
        # translates. Getting this wrong would produce a job the app rejects.
        action = Job(files=["/a.nii"]).sweep("s", start=-40, stop=40, step=8).to_dict()["actions"][0]
        self.assertEqual(action["from"], -40)
        self.assertEqual(action["to"], 40)
        self.assertEqual(action["step"], 8)
        self.assertNotIn("start", action)

    def test_from_scene(self) -> None:
        job = Job.from_scene("/data/s.tetravox.json").screenshot("a.png")
        self.assertEqual(job.to_dict()["scene"], {"path": "/data/s.tetravox.json"})

    def test_window(self) -> None:
        job = Job(files=["/a.nii"], window=(1400, 900)).screenshot("a.png")
        self.assertEqual(job.to_dict()["window"], {"width": 1400, "height": 900})
        self.assertEqual(job.window(800, 600).to_dict()["window"], {"width": 800, "height": 600})

    def test_camera_preset_digits_survive_as_strings(self) -> None:
        action = Job(files=["/a.nii"]).set(camera=1).to_dict()["actions"][0]
        self.assertEqual(action["camera"], "1")

    def test_format_shape_matches_what_was_asked_for(self) -> None:
        one = Job(files=["/a.nii"]).sweep("s", format="mp4").to_dict()["actions"][0]
        many = Job(files=["/a.nii"]).sweep("s", format=["gif", "mp4"]).to_dict()["actions"][0]
        self.assertEqual(one["format"], "mp4")
        self.assertEqual(many["format"], ["gif", "mp4"])

    def test_write_produces_parseable_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Job(files=["/a.nii"]).screenshot("a.png").write(os.path.join(tmp, "j.json"))
            with open(path, encoding="utf-8") as handle:
                self.assertEqual(json.load(handle)["version"], 1)

    def test_rejects_what_it_can_reject_before_launching_an_app(self) -> None:
        with self.assertRaises(JobError):
            Job(files=[])
        with self.assertRaises(JobError):
            Job(files=["/a.nii"], preset="pretty")  # type: ignore[arg-type]
        with self.assertRaises(JobError):
            Job(files=["/a.nii"]).sweep("s", view="view3d")
        with self.assertRaises(JobError):
            Job(files=["/a.nii"]).screenshot("a.png", background="chartreuse")
        with self.assertRaises(JobError):
            Job(files=["/a.nii"]).orbit("o", axis="w")
        with self.assertRaises(JobError):
            Job(files=["/a.nii"]).to_dict()  # no actions


class TestFindApp(unittest.TestCase):
    def test_an_explicit_path_that_does_not_exist_is_an_error_naming_it(self) -> None:
        with self.assertRaises(JobError) as caught:
            find_app("/nowhere/Tetravox")
        self.assertIn("/nowhere/Tetravox", str(caught.exception))

    def test_TETRAVOX_APP_is_checked_rather_than_trusted(self) -> None:
        previous = os.environ.get("TETRAVOX_APP")
        os.environ["TETRAVOX_APP"] = "/nowhere/Tetravox"
        try:
            with self.assertRaises(JobError) as caught:
                find_app()
            self.assertIn("TETRAVOX_APP", str(caught.exception))
        finally:
            if previous is None:
                del os.environ["TETRAVOX_APP"]
            else:
                os.environ["TETRAVOX_APP"] = previous


def _app_available() -> bool:
    try:
        find_app()
        return True
    except JobError:
        return False


def _data_available() -> bool:
    """Whether `scripts/fetch-data.sh` has been run. The examples read `data/ernie/`, not the
    subject directory, so that is what to look for — the same skip-never-fail rule
    (`docs/TESTING.md`), applied to where the data now is."""
    sys.path.insert(0, EXAMPLES)
    from _data import T1  # noqa: PLC0415

    return os.path.exists(T1)


@unittest.skipUnless(_data_available(), "data/ernie is empty — run scripts/fetch-data.sh")
@unittest.skipUnless(_app_available(), "no Tetravox build (set TETRAVOX_APP)")
class TestExampleEndToEnd(unittest.TestCase):
    """Run a real example against a real build, and check the files it claims are there.

    `sweep.py` is the one chosen: it is the fastest of the four (two volumes, no mesh) and it
    exercises the whole chain — load, preset, sweep, PNG frames, the pure-JS GIF encoder, and the
    result file the client parses.
    """

    def test_sweep_example(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            # The example is a separate process, so it needs the package on its own path — the same
            # thing `pip install -e python/` does for a user.
            root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
            environment = {
                **os.environ,
                "TETRAVOX_EXAMPLE_OUT": tmp,
                "PYTHONPATH": os.pathsep.join([root, os.environ.get("PYTHONPATH", "")]).rstrip(os.pathsep),
            }
            completed = subprocess.run(
                [sys.executable, os.path.join(EXAMPLES, "sweep.py")],
                capture_output=True,
                text=True,
                timeout=900,
                env=environment,
                cwd=tmp,
            )
            self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)

            out = os.path.join(tmp, "sweep")
            with open(os.path.join(out, "job-result.json"), encoding="utf-8") as handle:
                result = json.load(handle)
            self.assertTrue(result["ok"], result["errors"])

            files = [os.path.join(out, n) for o in result["outputs"] for n in o["files"]]
            pngs = [f for f in files if f.endswith(".png")]
            gifs = [f for f in files if f.endswith(".gif")]
            self.assertEqual(len(pngs), 32, "the example asked for 32 frames")
            self.assertEqual(len(gifs), 1)
            for path in files:
                self.assertTrue(os.path.exists(path), path)
                self.assertGreater(os.path.getsize(path), 1000, f"{path} is suspiciously small")
            with open(gifs[0], "rb") as handle:
                self.assertEqual(handle.read(6), b"GIF89a")

    def test_run_returns_a_parsed_result(self) -> None:
        """The client's own return value, rather than the file on disk."""
        sys.path.insert(0, EXAMPLES)
        from _data import T1  # noqa: PLC0415  — the examples\' own path table, not a second copy

        with tempfile.TemporaryDirectory() as tmp:
            result = (
                Job(files=[T1], preset="plain", window=(600, 600))
                .set(layout="1x1", view="axial")
                .screenshot("one.png", view="axial", width=300)
                .run(tmp)
            )
            result.raise_for_status()
            self.assertEqual(len(result.files), 1)
            self.assertTrue(result.files[0].endswith("one.png"))
            self.assertGreater(result.timings["totalMs"], 0)
            self.assertEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
