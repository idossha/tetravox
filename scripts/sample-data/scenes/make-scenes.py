#!/usr/bin/env python3
"""Generate the scene shipped with each sample (packages/app/src/shared/scenes/<id>.tetravox.json).

    python3 scripts/sample-data/scenes/make-scenes.py --cache <dir> [--only <id> ...]

`<dir>` holds the samples exactly as the app's cache does — `<dir>/<id>/<file>` with the catalogue
names (stage the store, then hard-link the files into that layout, or point at the app's own cache).
For every sample with a JOB below, the app is driven headlessly with `--job`: the files are opened as
the Open… dialog opens them, a preset configures the layers **from the data** (docs/AUTOMATION.md
§2.2 — no threshold is ever typed here), a few `set` actions choose layout and camera, and
`save-scene` writes the scene next to the data so every `DatasetRef.path` is a bare file name. That
file is then copied into the app. A sample without a JOB keeps its hand-saved scene (ernie-ti, saved
from the app with the TI field, clip plane and colour scale set by hand).

Needs a built app (`pnpm --filter @tetravox/app run build`). Runs offscreen; nothing appears on
screen.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CATALOG = ROOT / "packages" / "app" / "src" / "shared" / "sample-catalog.json"
SCENES = ROOT / "packages" / "app" / "src" / "shared" / "scenes"
ELECTRON = ROOT / "node_modules" / ".bin" / "electron"
APP = ROOT / "packages" / "app"

TWO_BY_TWO = {"type": "set", "layout": "2x2"}


def job(files: list[str], preset: str, *actions: dict) -> dict:
    return {"scene": {"files": files, "preset": preset}, "actions": [*actions]}


# sample id -> job (files are catalogue names; the sample's directory is prepended)
JOBS: dict[str, dict] = {
    "ernie-t1": job(["T1.nii.gz"], "plain", TWO_BY_TWO, {"type": "set", "camera": "L"}),
    "ernie-tissues": job(
        ["T1.nii.gz", "labeling.nii.gz"],
        "atlas-outline",
        TWO_BY_TWO,
        {"type": "set", "camera": "L"},
    ),
    "ernie-pial": job(
        ["T1.nii.gz", "lh.pial.gii", "rh.pial.gii"],
        "plain",
        TWO_BY_TWO,
        {"type": "set", "camera": "L", "distance": 420},
    ),
    "ernie-eeg": job(
        ["T1.nii.gz", "EEG10-10_UI_Jurak_2007.geo"],
        "plain",
        TWO_BY_TWO,
        {"type": "set", "camera": "L", "distance": 420},
    ),
    "totalseg-ct": job(
        ["example_ct_sm.nii.gz", "example_seg_fast.nii.gz"],
        "atlas-outline",
        TWO_BY_TWO,
        {"type": "set", "camera": "A"},
    ),
    "amos-ct": job(
        ["amos_0004_ct.nii.gz", "amos_0004_seg.nii.gz"],
        "atlas-outline",
        TWO_BY_TWO,
        {"type": "set", "camera": "A"},
    ),
    "amos-mri": job(
        ["amos_0555_mri.nii.gz", "amos_0555_seg.nii.gz"],
        "atlas-outline",
        TWO_BY_TWO,
        {"type": "set", "camera": "A"},
    ),
    "ct-abdo": job(["CT_Abdo.nii.gz"], "plain", TWO_BY_TWO, {"type": "set", "camera": "A"}),
    "spine-ct": job(
        ["volume-covid19-A-0377_ct.nii.gz", "volume-covid19-A-0377_ct_seg.nii.gz"],
        "atlas-outline",
        TWO_BY_TWO,
        {"type": "set", "camera": "L"},
    ),
}


def run_one(sample_id: str, sample_dir: Path, spec: dict) -> bool:
    files = [str(sample_dir / f) for f in spec["scene"]["files"]]
    for f in files:
        if not Path(f).is_file():
            print(f"MISSING  {f}")
            return False
    doc = {
        "scene": {"files": files, "preset": spec["scene"]["preset"]},
        "actions": [*spec["actions"], {"type": "save-scene", "out": f"{sample_id}.tetravox.json"}],
    }
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as tmp:
        json.dump(doc, tmp)
        job_path = tmp.name
    env = {**os.environ, "TETRAVOX_E2E_OFFSCREEN": "1"}
    proc = subprocess.run(
        [str(ELECTRON), str(APP), "--job", job_path, "--out", str(sample_dir)],
        env=env,
        capture_output=True,
        text=True,
    )
    os.unlink(job_path)
    result_path = sample_dir / "job-result.json"
    if proc.returncode != 0 or not result_path.is_file():
        print(f"FAILED   {sample_id}: exit {proc.returncode}\n{proc.stderr[-2000:]}")
        return False
    result = json.loads(result_path.read_text())
    result_path.unlink()
    for w in result.get("warnings", []):
        print(f"warning  {sample_id}: {w}")
    if not result.get("ok", False):
        print(f"FAILED   {sample_id}: {result.get('errors')}")
        return False
    scene = sample_dir / f"{sample_id}.tetravox.json"
    spec_out = json.loads(scene.read_text())
    bad = [d["path"] for d in spec_out["datasets"] if "/" in d["path"] or d["path"].startswith(".")]
    if bad:
        print(f"FAILED   {sample_id}: non-relative dataset paths {bad}")
        return False
    for d in spec_out["datasets"]:
        d.pop("absPath", None)  # the machine this ran on is nobody's business
    SCENES.mkdir(parents=True, exist_ok=True)
    (SCENES / scene.name).write_text(json.dumps(spec_out, indent=2) + "\n")
    scene.unlink()
    print(f"scene    {sample_id}: {len(spec_out['layers'])} layers, {spec_out['layout']['kind']}")
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", required=True)
    ap.add_argument("--only", nargs="*", default=None)
    args = ap.parse_args()
    cache = Path(args.cache)
    catalog = json.loads(CATALOG.read_text())
    ids = [s["id"] for s in catalog["samples"]]
    unknown = set(JOBS) - set(ids)
    if unknown:
        print(f"jobs for samples not in the catalogue: {sorted(unknown)}")
        return 1
    if not ELECTRON.exists() or not (APP / "out" / "main").exists():
        print("build the app first: pnpm --filter @tetravox/app run build")
        return 1
    status = 0
    for sid in ids:
        if args.only is not None and sid not in args.only:
            continue
        spec = JOBS.get(sid)
        if spec is None:
            existing = SCENES / f"{sid}.tetravox.json"
            print(f"kept     {sid}: {'hand-saved scene' if existing.exists() else 'NO SCENE'}")
            if not existing.exists():
                status = 1
            continue
        if not run_one(sid, cache / sid, spec):
            status = 1
    return status


if __name__ == "__main__":
    sys.exit(main())
