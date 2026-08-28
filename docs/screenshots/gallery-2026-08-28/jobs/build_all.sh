#!/usr/bin/env bash
# Regenerate every job-driven image in this gallery, in sequence (one Electron at a time).
# Needs TETRAVOX_TESTDATA, TETRAVOX_APP, TETRAVOX_APP_ARGS (see README.md) and
# scripts/fetch-public-samples.sh to have run. The Playwright half is ui-tour-gallery.spec.ts.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="${PYTHON:-python3}"
"$PY" "$HERE/build_gallery.py"
"$PY" "$HERE/build_tdcs_glyphs.py"
"$PY" "$HERE/build_seeg.py"
"$PY" "$HERE/build_public.py"
