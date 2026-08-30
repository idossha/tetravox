# tetravox-sample-data

The data store behind **File ▸ Sample Data…** in [Tetravox](https://github.com/idossha/tetravox),
organised the way [3D Slicer's SlicerDataStore](https://github.com/Slicer/SlicerDataStore) is: every
file is an asset of the single `SHA256` release, **named by its own sha256**, so a URL is

    https://github.com/idossha/tetravox-sample-data/releases/download/SHA256/<sha256>

and the app verifies what it downloaded against the name. What each hash _is_ — file name, sample,
source, licence — is listed on the website's
[Sample data](https://idossha.github.io/tetravox/sample-data) page and in
`packages/app/src/shared/sample-catalog.json` in the Tetravox repository, which is also where new
samples are added (`scripts/sample-data/stage.py` verifies and stages them, `publish.sh` uploads).

Nothing here is original work. Each sample carries the licence of its source: SimNIBS example
dataset (GPL-3.0), TotalSegmentator (Apache-2.0), niivue-images (BSD-2-Clause), AMOS22 (CC-BY-4.0).
Data under a non-commercial licence (CTSpine1K, CC-BY-NC-SA) is **not** re-hosted here; the
catalogue links to its source.
