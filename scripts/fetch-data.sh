#!/usr/bin/env bash
#
# Populate `data/ernie/` — the files `examples/` reads, and nothing else.
#
# The repository carries no imaging data: the reference subject is ~1 GB, most of it two meshes, and
# a checkout that drags that along is a checkout nobody clones. `data/` is git-ignored and this
# script fills it, so an example's default path is a real path on a machine that has run this once.
#
#   scripts/fetch-data.sh                       # from $TETRAVOX_TESTDATA, or the default below
#   TETRAVOX_TESTDATA=/other/sub-ernie scripts/fetch-data.sh
#   scripts/fetch-data.sh --dest /elsewhere/ernie
#
# It copies rather than symlinks on purpose: a symlink farm into someone's dataset breaks the moment
# the dataset moves, and the failure then looks like a Tetravox bug rather than a missing file.
# Copies already present with the right size are skipped, so a second run is nearly free.

set -euo pipefail

SRC="${TETRAVOX_TESTDATA:-/Users/idohaber/datasets/000/derivatives/SimNIBS/sub-ernie}"
DEST="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/data/ernie"

while [ $# -gt 0 ]; do
  case "$1" in
    --src) SRC="$2"; shift 2 ;;
    --dest) DEST="$2"; shift 2 ;;
    -h|--help) sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ ! -d "$SRC" ]; then
  cat >&2 <<EOF
no subject at: $SRC

Point TETRAVOX_TESTDATA at a SimNIBS subject directory (the one docs/TESTING.md names), e.g.

  export TETRAVOX_TESTDATA=/data/derivatives/SimNIBS/sub-ernie
  scripts/fetch-data.sh
EOF
  exit 2
fi

# Every file an example opens, as a path relative to the subject directory. Sidecars are listed
# explicitly rather than globbed: `labeling_LUT.txt` and `ernie.msh.opt` are found beside their data
# by the app itself, and a copy that quietly left one behind would render `tag 1005` instead of
# `Compact_bone` with nothing to say why.
FILES=(
  # Anatomy.
  m2m_ernie/T1.nii.gz
  # The atlas, and its lookup table — names and colours for the regions.
  m2m_ernie/segmentation/labeling.nii.gz
  m2m_ernie/segmentation/labeling_LUT.txt
  # The head model's tissue segmentation, and its lookup table.
  m2m_ernie/final_tissues.nii.gz
  m2m_ernie/final_tissues_LUT.txt
  # The simulated TI field over grey matter, as a volume: the heat overlay.
  Simulations/Thalamus/TI/niftis/grey_Thalamus_TI_subject_TI_max.nii.gz
  # The same field on the grey-matter surface, and on the whole head model.
  Simulations/Thalamus/TI/mesh/grey_Thalamus_TI.msh
  Simulations/Thalamus/TI/mesh/Thalamus_TI.msh
  Simulations/Thalamus/TI/mesh/Thalamus_TI.msh.opt
  # The head model itself, with the tissue colours the app reads out of the .opt.
  m2m_ernie/ernie.msh
  m2m_ernie/ernie.msh.opt
  # A cortical surface, for a surface-under-the-field shot.
  m2m_ernie/surfaces/lh.pial.gii
  # The 185-channel EEG net, as the .geo the app opens.
  m2m_ernie/eeg_positions/GSN-HydroCel-185.geo
  # One vector field: E over every element of the head model, for the glyph shot.
  Simulations/L_Insula/high_Frequency/mesh/ernie_TDCS_1_scalar.msh
)

mkdir -p "$DEST"
copied=0
skipped=0
missing=()

for rel in "${FILES[@]}"; do
  from="$SRC/$rel"
  to="$DEST/$rel"
  if [ ! -f "$from" ]; then
    missing+=("$rel")
    continue
  fi
  mkdir -p "$(dirname "$to")"
  if [ -f "$to" ] && [ "$(stat -f %z "$to" 2>/dev/null || stat -c %s "$to")" = \
                        "$(stat -f %z "$from" 2>/dev/null || stat -c %s "$from")" ]; then
    skipped=$((skipped + 1))
    continue
  fi
  echo "  $rel"
  cp "$from" "$to"
  copied=$((copied + 1))
done

echo
echo "$DEST"
echo "  $copied copied, $skipped already there, $(du -sh "$DEST" | cut -f1) total"

if [ ${#missing[@]} -gt 0 ]; then
  echo
  echo "not in $SRC:" >&2
  printf '  %s\n' "${missing[@]}" >&2
  echo "(the examples that need those will stop with the same list)" >&2
  exit 1
fi
