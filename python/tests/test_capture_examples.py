"""The job documents `examples/capture/` builds.

These are claims about the *documents*, not about the pictures: the schema's own validator lives in
`packages/app/src/main/job.ts` and the film's look is a thing to watch. What can go wrong here and be
caught cheaply is the bookkeeping — a sequence that never encodes, a caption that drifts off its
shot, a film that quietly grew to three minutes — and every one of those costs a ten-minute render
to discover any other way.

No data and no app are needed: building a job resolves paths, it does not open them.
"""

from __future__ import annotations

import os
import sys
import unittest

_REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(_REPO, "python"))
sys.path.insert(0, os.path.join(_REPO, "examples", "capture"))

import showcase  # noqa: E402
from tetravox import Job  # noqa: E402


def build_all(work: str = "/tmp") -> list[dict]:
    """Every job the film is made of, as documents, in the order they are rendered."""
    showcase.STORYBOARD.clear()
    jobs = []
    for build in (showcase.tour_regions, showcase.tour_tissues):
        job = _capture(build, work)
        jobs.append(job)
    for _name, build in showcase.ACTS:
        job = Job(
            files=[showcase.T1, showcase.LABELS],
            window=(showcase.WIDTH, showcase.HEIGHT),
        )
        build(job)
        jobs.append(job.to_dict())
    return jobs


def _capture(build, work: str) -> dict:
    """Run a tour builder without writing to disk, by intercepting `Job.write`."""
    written = {}
    original = Job.write

    def spy(self, path):  # noqa: ANN001
        written["doc"] = self.to_dict()
        return str(path)

    Job.write = spy
    try:
        build(work)
    finally:
        Job.write = original
    return written["doc"]


class TestFilmLength(unittest.TestCase):
    def setUp(self) -> None:
        build_all()

    def test_the_film_is_between_ninety_and_a_hundred_and_twenty_seconds(self) -> None:
        # The brief's window. A film that has crept past it is a film nobody watches to the end, and
        # this is the only place the total is visible without rendering it.
        self.assertGreaterEqual(showcase.total_seconds(), 90.0)
        self.assertLessEqual(showcase.total_seconds(), 120.0)

    def test_the_timeline_is_contiguous_and_starts_after_the_title_card(self) -> None:
        entries = showcase.timeline()
        self.assertEqual(entries[0]["start"], showcase.TITLE_SECONDS)
        for previous, entry in zip(entries, entries[1:]):
            self.assertAlmostEqual(previous["end"], entry["start"], places=6)
        self.assertAlmostEqual(
            entries[-1]["end"] + showcase.END_SECONDS, showcase.total_seconds(), places=6
        )

    def test_every_shot_id_is_unique(self) -> None:
        ids = [entry["shot"] for entry in showcase.STORYBOARD]
        self.assertEqual(len(ids), len(set(ids)), "two shots share an id")

    def test_captions_fit_one_line_and_carry_a_reason(self) -> None:
        for entry in showcase.STORYBOARD:
            self.assertLessEqual(len(entry["caption"]), 76, entry["shot"])
            self.assertNotIn("\n", entry["caption"], entry["shot"])
            # A held frame may have no caption; every shot has a note saying why its numbers are
            # what they are, because that column is the storyboard page.
            self.assertTrue(entry["note"], entry["shot"])


class TestJobDocuments(unittest.TestCase):
    def setUp(self) -> None:
        self.jobs = build_all()

    def test_every_job_is_a_1920x1080_document_with_actions(self) -> None:
        for job in self.jobs:
            self.assertEqual(job["version"], 1)
            self.assertEqual(job["window"]["width"], showcase.WIDTH)
            self.assertEqual(job["window"]["height"], showcase.HEIGHT)
            self.assertTrue(job["actions"])

    def test_the_tours_ask_for_panels_and_capture_the_window(self) -> None:
        for job in self.jobs[:2]:
            self.assertTrue(job["window"]["panels"], "a UI tour without panels shows nothing")
            frames = [a for a in job["actions"] if a["type"] in ("tween", "orbit", "sweep")]
            self.assertTrue(frames)
            for action in frames:
                self.assertEqual(action["view"], "window")

    def test_the_film_does_not_ask_for_panels(self) -> None:
        # Everything after the tour comes off the engine's canvas, which never contains them.
        for job in self.jobs[2:]:
            self.assertNotIn("panels", job["window"])
            for action in job["actions"]:
                self.assertNotEqual(action.get("view"), "window")

    def test_every_sequence_starts_once_and_ends_once_with_an_mp4(self) -> None:
        for index, job in enumerate(self.jobs):
            frames = [a for a in job["actions"] if a["type"] in ("tween", "orbit", "sweep")]
            markers = [a.get("sequence") for a in frames]
            self.assertEqual(markers[0], "start", f"job {index} does not open a sequence")
            self.assertEqual(markers[-1], "end", f"job {index} never closes its sequence")
            self.assertEqual(markers.count("start"), 1, f"job {index}")
            self.assertEqual(markers.count("end"), 1, f"job {index}")
            self.assertEqual(markers[1:-1], ["continue"] * (len(markers) - 2), f"job {index}")
            # Only the closing action encodes: one file over every frame the job wrote.
            self.assertEqual(frames[-1].get("format"), "mp4", f"job {index}")
            for action in frames[:-1]:
                self.assertIsNone(action.get("format"), f"job {index}")

    def test_the_documents_account_for_every_storyboard_frame(self) -> None:
        rendered = sum(
            action["frames"]
            for job in self.jobs
            for action in job["actions"]
            if action["type"] in ("tween", "orbit")
        )
        self.assertEqual(rendered, sum(e["frames"] for e in showcase.STORYBOARD))

    def test_output_names_stay_inside_the_out_directory(self) -> None:
        for job in self.jobs:
            for action in job["actions"]:
                name = action.get("out")
                if name is None:
                    continue
                self.assertFalse(name.startswith("/"), name)
                self.assertNotIn("..", name)

    def test_scene_paths_are_absolute(self) -> None:
        for job in self.jobs:
            for path in job["scene"]["files"]:
                self.assertTrue(os.path.isabs(path), path)


class TestSmallExamples(unittest.TestCase):
    """The three ≤40-line examples, built but not run."""

    @staticmethod
    def _source(name: str) -> str:
        path = os.path.join(_REPO, "examples", "capture", f"{name}.py")
        with open(path, encoding="utf-8") as handle:
            return handle.read()

    def test_each_one_builds_a_job_it_could_run(self) -> None:
        import importlib.util

        for name, expect in (
            ("screenshot", "screenshot"),
            ("sweep", "sweep"),
            ("orbit", "orbit"),
        ):
            path = os.path.join(_REPO, "examples", "capture", f"{name}.py")
            spec = importlib.util.spec_from_file_location(f"capture_{name}", path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            self.assertTrue(hasattr(module, "main"), name)
            self.assertIn(expect, self._source(name))

    def test_they_stay_short_enough_to_read_in_one_screen(self) -> None:
        for name in ("screenshot", "sweep", "orbit"):
            code = [
                line
                for line in self._source(name).splitlines()
                if line.strip() and not line.strip().startswith("#")
            ]
            self.assertLessEqual(len(code), 40, f"{name}.py is {len(code)} lines of code")


if __name__ == "__main__":
    unittest.main()
