"""The module half of the client: `Job.module` and the typed wrappers (ARCHITECTURE §13.6).

Document tests, like `test_client.py`'s: they assert the JSON a job builds, because that JSON is the
contract with `packages/app/src/main/job.ts`, whose own unit test asserts the other end of it. There
is deliberately no app here — the sEEG module may not even be in the build a reader has, and a
wrapper that only worked against a build that carried it would be a wrapper nobody could write a
script with.

    python -m unittest discover -s python/tests
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from tetravox import Job, JobError, JobResult  # noqa: E402
from tetravox.modules import seeg  # noqa: E402


def action(job: Job, index: int = 0) -> dict:
    return job.to_dict()["actions"][index]


class TestJobModule(unittest.TestCase):
    def test_the_envelope_is_the_whole_action(self) -> None:
        job = Job(files=["/a.nii"]).module("tetravox.hello", "echo", text="hi")
        self.assertEqual(
            action(job),
            {"type": "module", "module": "tetravox.hello", "op": "echo", "args": {"text": "hi"}},
        )

    def test_argument_names_are_the_manifests_verbatim(self) -> None:
        # The manifest is the schema the app validates against, so this client does not rename:
        # `radiusMm` goes out as `radiusMm`. Snake case lives in the typed wrappers.
        job = Job(files=["/a.nii"]).module("tetravox.seeg", "snap", scope="all", radiusMm=1.5)
        self.assertEqual(action(job)["args"], {"scope": "all", "radiusMm": 1.5})

    def test_an_operation_with_no_arguments_sends_no_args_key(self) -> None:
        # `{"args": {}}` and no `args` mean the same thing to the validator, and the shorter one is
        # what a person reads in a job file they were handed.
        self.assertEqual(
            action(Job(files=["/a.nii"]).module("tetravox.seeg", "stats")),
            {"type": "module", "module": "tetravox.seeg", "op": "stats"},
        )

    def test_none_is_omitted_rather_than_sent_as_null(self) -> None:
        job = Job(files=["/a.nii"]).module("m.x", "op", a=1, b=None)
        self.assertEqual(action(job)["args"], {"a": 1})

    def test_false_and_zero_are_values_not_absences(self) -> None:
        job = Job(files=["/a.nii"]).module("m.x", "op", on=False, radiusMm=0.0)
        self.assertEqual(action(job)["args"], {"on": False, "radiusMm": 0.0})

    def test_it_chains_with_every_other_action(self) -> None:
        job = (
            Job(files=["/a.nii"])
            .module("tetravox.seeg", "snap", scope="all")
            .set(cursor=(1, 2, 3))
            .screenshot("a.png")
        )
        self.assertEqual([a["type"] for a in job.to_dict()["actions"]], ["module", "set", "screenshot"])

    def test_it_rejects_what_it_can_before_launching_an_app(self) -> None:
        with self.assertRaises(JobError):
            Job(files=["/a.nii"]).module("seeg", "snap")  # not <vendor>.<name>
        with self.assertRaises(JobError):
            Job(files=["/a.nii"]).module("tetravox.seeg", "")


class TestSeegWrappers(unittest.TestCase):
    def test_load_names_every_path_absolutely(self) -> None:
        # The job document is written *into the output directory* and the app resolves a relative
        # path against the document, so a relative `tsv=` would look for a table beside the output.
        job = Job(files=["/data/ct.nii.gz"])
        seeg.load(job, ct="/data/ct.nii.gz", tsv="contacts.tsv", t1="~/anat/T1.nii.gz")
        args = action(job)["args"]
        self.assertEqual(args["ct"], "/data/ct.nii.gz")
        self.assertEqual(args["tsv"], os.path.join(os.getcwd(), "contacts.tsv"))
        self.assertTrue(args["t1"].startswith(os.path.expanduser("~")))
        self.assertNotIn("~", args["t1"])

    def test_load_without_a_t1_omits_it(self) -> None:
        job = Job(files=["/a.nii"])
        seeg.load(job, ct="/data/ct.nii.gz", tsv="/data/c.tsv")
        self.assertEqual(set(action(job)["args"]), {"ct", "tsv"})

    def test_snap_translates_the_snake_case_and_defaults_to_one_contact(self) -> None:
        job = Job(files=["/a.nii"])
        seeg.snap(job, scope="electrode", electrode="LINS", radius_mm=2)
        self.assertEqual(
            action(job),
            {
                "type": "module",
                "module": "tetravox.seeg",
                "op": "snap",
                "args": {"scope": "electrode", "electrode": "LINS", "radiusMm": 2.0},
            },
        )
        self.assertEqual(action(seeg.snap(Job(files=["/a.nii"])))["args"], {"scope": "contact"})

    def test_snap_refuses_a_scope_that_is_not_one_of_the_three(self) -> None:
        with self.assertRaises(JobError) as caught:
            seeg.snap(Job(files=["/a.nii"]), scope="everything")
        self.assertIn("contact, electrode, all", str(caught.exception))

    def test_the_shaft_operations_take_an_optional_electrode(self) -> None:
        for run, op in ((seeg.refit, "refit"), (seeg.renumber, "renumber")):
            self.assertEqual(action(run(Job(files=["/a.nii"])))["op"], op)
            self.assertNotIn("args", action(run(Job(files=["/a.nii"]))))
            self.assertEqual(
                action(run(Job(files=["/a.nii"]), electrode="LINS"))["args"], {"electrode": "LINS"}
            )

    def test_ghost_sends_a_boolean_both_ways(self) -> None:
        self.assertEqual(action(seeg.ghost(Job(files=["/a.nii"]), on=True))["args"], {"on": True})
        self.assertEqual(action(seeg.ghost(Job(files=["/a.nii"]), on=False))["args"], {"on": False})

    def test_stats_takes_nothing_and_writes_nothing(self) -> None:
        self.assertEqual(action(seeg.stats(Job(files=["/a.nii"])))["op"], "stats")

    def test_save_holds_out_to_the_rule_the_app_holds_it_to(self) -> None:
        self.assertEqual(
            action(seeg.save(Job(files=["/a.nii"]), out="sub-01_electrodes.tsv"))["args"],
            {"out": "sub-01_electrodes.tsv"},
        )
        for out in ("/etc/passwd", "../up.tsv", "a/../../b.tsv", ""):
            with self.assertRaises(JobError):
                seeg.save(Job(files=["/a.nii"]), out=out)

    def test_every_wrapper_returns_the_job_so_a_script_can_chain_off_it(self) -> None:
        job = Job(files=["/a.nii"])
        self.assertIs(seeg.stats(job), job)
        self.assertIs(seeg.ghost(job, on=True).screenshot("a.png"), job)

    def test_the_seven_operations_of_the_manifest_are_all_here(self) -> None:
        # If an operation is added to the manifest, this is the line that says the client has not
        # been told about it yet.
        offered = {
            name
            for name, value in vars(seeg).items()
            if not name.startswith("_")
            and callable(value)
            and getattr(value, "__module__", "") == seeg.__name__
        }
        self.assertEqual(offered, {"load", "snap", "refit", "renumber", "ghost", "stats", "save"})
        self.assertEqual(seeg.MODULE_ID, "tetravox.seeg")


class TestJobResultModules(unittest.TestCase):
    """`job-result.json`'s module half, as `runner.py` parses it."""

    def _result(self) -> JobResult:
        return JobResult(
            ok=True,
            out_dir="/out",
            outputs=[
                {"action": 0, "type": "module", "module": "tetravox.seeg", "op": "snap",
                 "files": [], "ms": 4, "result": {"moved": 96, "meanShiftMm": 0.42}},
                {"action": 1, "type": "screenshot", "files": ["a.png"], "ms": 9},
                {"action": 2, "type": "module", "module": "tetravox.seeg", "op": "save",
                 "files": ["c.tsv"], "ms": 2, "result": {"path": "c.tsv"}},
            ],
            modules=[{"id": "tetravox.seeg", "version": "0.1.0"}],
        )

    def test_results_are_what_the_operations_returned_in_order(self) -> None:
        self.assertEqual(
            self._result().results(),
            [{"moved": 96, "meanShiftMm": 0.42}, {"path": "c.tsv"}],
        )

    def test_files_still_answer_the_other_question(self) -> None:
        result = self._result()
        self.assertEqual(result.files, ["/out/a.png", "/out/c.tsv"])
        self.assertEqual(result.files_for(2), ["/out/c.tsv"])

    def test_a_run_with_no_module_has_no_modules_and_no_results(self) -> None:
        # The key is absent from the file in that case, so the default has to be the empty list
        # rather than a `KeyError` waiting in a script that never used a module.
        plain = JobResult(ok=True, out_dir="/out", outputs=[{"action": 0, "files": ["a.png"]}])
        self.assertEqual(plain.modules, [])
        self.assertEqual(plain.results(), [])


if __name__ == "__main__":
    unittest.main()
