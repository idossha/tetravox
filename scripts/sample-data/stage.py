#!/usr/bin/env python3
"""Stage the files behind packages/app/src/shared/sample-catalog.json as content-addressed assets.

    python3 scripts/sample-data/stage.py [--out <dir>]

For every catalogue file whose `url` points at the tetravox-sample-data store, find the source
file on this machine (see SOURCES), check that its sha256 and size match the catalogue, and copy it
to `<out>/<sha256>` — the asset name the store uses. Files hosted upstream (non-commercial licences)
are verified but not staged. `publish.sh` then uploads the directory.

Sources are looked up under `TETRAVOX_TESTDATA` (the SimNIBS subject) and `data/public/`
(`scripts/fetch-public-samples.sh`). A file that is missing here is reported, not invented — the
catalogue's hash is the contract and this script only ever proves a local file meets it.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CATALOG = ROOT / "packages" / "app" / "src" / "shared" / "sample-catalog.json"
TESTDATA = Path(os.environ.get("TETRAVOX_TESTDATA", ""))
PUBLIC = ROOT / "data" / "public"

# catalogue file name -> where it comes from on a developer machine
SOURCES: dict[str, Path] = {
    "T1.nii.gz": TESTDATA / "m2m_ernie" / "T1.nii.gz",
    "labeling.nii.gz": TESTDATA / "m2m_ernie" / "segmentation" / "labeling.nii.gz",
    "labeling_LUT.txt": TESTDATA / "m2m_ernie" / "segmentation" / "labeling_LUT.txt",
    "lh.pial.gii": TESTDATA / "m2m_ernie" / "surfaces" / "lh.pial.gii",
    "rh.pial.gii": TESTDATA / "m2m_ernie" / "surfaces" / "rh.pial.gii",
    "EEG10-10_UI_Jurak_2007.geo": TESTDATA / "m2m_ernie" / "eeg_positions" / "EEG10-10_UI_Jurak_2007.geo",
    "grey_TI.msh": TESTDATA / "Simulations" / "docs_example" / "TI" / "mesh" / "grey_docs_example_TI.msh",
    "TI_max.nii.gz": TESTDATA / "Simulations" / "docs_example" / "TI" / "niftis" / "docs_example_TI_subject_TI_max.nii.gz",
    "example_ct_sm.nii.gz": PUBLIC / "totalsegmentator" / "example_ct_sm.nii.gz",
    "example_seg_fast.nii.gz": PUBLIC / "totalsegmentator" / "example_seg_fast.nii.gz",
    "CT_Abdo.nii.gz": PUBLIC / "niivue-images" / "CT_Abdo.nii.gz",
    "amos_0004_ct.nii.gz": PUBLIC / "amos22-ct" / "amos_0004_ct.nii.gz",
    "amos_0004_seg.nii.gz": PUBLIC / "amos22-ct" / "amos_0004_seg.nii.gz",
    "amos_0004_seg_LUT.txt": PUBLIC / "amos22-ct" / "amos_0004_seg_LUT.txt",
    "amos_0555_mri.nii.gz": PUBLIC / "amos22-mri" / "amos_0555_mri.nii.gz",
    "amos_0555_seg.nii.gz": PUBLIC / "amos22-mri" / "amos_0555_seg.nii.gz",
    "amos_0555_seg_LUT.txt": PUBLIC / "amos22-mri" / "amos_0555_seg_LUT.txt",
    "volume-covid19-A-0377_ct.nii.gz": PUBLIC / "ctspine1k" / "volume-covid19-A-0377_ct.nii.gz",
    "volume-covid19-A-0377_ct_seg.nii.gz": PUBLIC / "ctspine1k" / "volume-covid19-A-0377_ct_seg.nii.gz",
    "volume-covid19-A-0377_ct_seg_LUT.txt": PUBLIC / "ctspine1k" / "volume-covid19-A-0377_ct_seg_LUT.txt",
}


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "data" / "sample-store"))
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    catalog = json.loads(CATALOG.read_text())
    store = catalog["store"]
    seen: set[str] = set()
    status = 0
    for sample in catalog["samples"]:
        for f in sample["files"]:
            if f["sha256"] in seen:
                continue
            seen.add(f["sha256"])
            src = SOURCES.get(f["name"])
            if src is None or not src.is_file():
                print(f"MISSING  {sample['id']}/{f['name']}  (looked at {src})")
                status = 1
                continue
            size = src.stat().st_size
            got = sha256(src)
            if size != f["bytes"] or got != f["sha256"]:
                print(f"MISMATCH {sample['id']}/{f['name']}  {size} B {got[:12]} vs catalogue {f['bytes']} B {f['sha256'][:12]}")
                status = 1
                continue
            if f["url"].startswith(store):
                dst = out / f["sha256"]
                if not dst.exists():
                    shutil.copyfile(src, dst)
                print(f"staged   {f['sha256'][:12]}  {f['name']}  ({size} B)")
            else:
                print(f"upstream {f['sha256'][:12]}  {f['name']}  ({f['url']})")
    n = len(list(out.iterdir()))
    print(f"{n} assets in {out}")
    return status


if __name__ == "__main__":
    sys.exit(main())
