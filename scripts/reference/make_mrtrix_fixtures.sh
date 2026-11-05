#!/usr/bin/env bash
# testdata/mrtrix_small*: a tractogram, a .tsf and a per-streamline mean, all written by MRtrix3, so
# the reader is tested against the format's own writer. Run once with MRtrix3 on PATH, then blank the
# `command_history` values (same length, so `file: . <offset>` still holds): they hold local paths.
#
#   make_mrtrix_fixtures.sh <tracks.tck> <fa.nii.gz> <out_dir>
set -euo pipefail
tracks=$1 fa=$2 out=$3
tckedit -force -number 40 -minlength 30 "$tracks" "$out/mrtrix_small.tck"
tcksample -force "$out/mrtrix_small.tck" "$fa" "$out/mrtrix_small_fa.tsf"
tcksample -force -stat_tck mean "$out/mrtrix_small.tck" "$fa" "$out/mrtrix_small_fa_mean.txt"
