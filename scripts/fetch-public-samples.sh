#!/usr/bin/env bash
# Fetch the small public, non-head NIfTI samples the docs/screenshots gallery renders.
#
# Everything lands in data/public/<name>/ (git-ignored). Each file's sha256 is checked after
# download; docs/screenshots/gallery-2026-08-28/DATASETS.md carries the URL, licence and hash
# for every entry. Total is ~30 MB.
#
# Usage:  scripts/fetch-public-samples.sh            # fetch what is missing, verify all
#         scripts/fetch-public-samples.sh --verify   # only verify existing files
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/data/public"
VERIFY_ONLY="${1:-}"

# name|relative path|url|sha256
ENTRIES='
totalsegmentator|example_ct_sm.nii.gz|https://raw.githubusercontent.com/wasserth/TotalSegmentator/master/tests/reference_files/example_ct_sm.nii.gz|e50c00b2914e2cac0aaee8e7f3b5f57d44d9f21bfd5c0577271c54c0cb49e9fb
totalsegmentator|example_seg_fast.nii.gz|https://raw.githubusercontent.com/wasserth/TotalSegmentator/master/tests/reference_files/example_seg_fast.nii.gz|353a7c65c9ff5d5b9b331f811130f0ebbaedb509df74587d3bd0d1ad5ebc3910
niivue-images|CT_Abdo.nii.gz|https://raw.githubusercontent.com/neurolabusc/niivue-images/main/CT_Abdo.nii.gz|cfa3081e28fdcd6392d9c63de44851769983df26c931434529ae735c36eab0b3
niivue-images|CT_Philips.nii.gz|https://raw.githubusercontent.com/neurolabusc/niivue-images/main/CT_Philips.nii.gz|6b6ebf958bfe2972f27c3f8dc06bd3763eb7646186bd2e5251f37f9aa7a16971
niivue-images|LICENSE|https://raw.githubusercontent.com/neurolabusc/niivue-images/main/LICENSE|fa3060ed64a885d5e3205205d793349967b105829c727ae8590f6b2ebb9fed55
ctspine1k|volume-covid19-A-0377_ct.nii.gz|https://huggingface.co/datasets/alexanderdann/CTSpine1K/resolve/main/raw_data/volumes/COVID-19/volume-covid19-A-0377_ct.nii.gz|5c5972eb06312906ba1fab9fa261e1c8fde2bf0b761f12150adde3f1ece4a67a
ctspine1k|volume-covid19-A-0377_ct_seg.nii.gz|https://huggingface.co/datasets/alexanderdann/CTSpine1K/resolve/main/raw_data/labels/COVID-19/volume-covid19-A-0377_ct_seg.nii.gz|132a19f436ad6809c3c8472e4daa2bd32ff7cdde0672bb33366ae7df3eeebc19
'

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

status=0
while IFS='|' read -r name rel url want; do
  [ -z "$name" ] && continue
  dir="$OUT/$name"; path="$dir/$rel"
  mkdir -p "$dir"
  if [ ! -f "$path" ]; then
    if [ "$VERIFY_ONLY" = "--verify" ]; then echo "MISSING  $path"; status=1; continue; fi
    echo "fetch    $url"
    curl -fsSL --retry 3 -o "$path" "$url"
  fi
  got="$(sha "$path")"
  if [ "$got" = "$want" ]; then
    echo "ok       $name/$rel"
  elif [[ "$want" == SHA_* ]]; then
    echo "unpinned $name/$rel  sha256=$got   (fill this into the script)"
  else
    echo "MISMATCH $name/$rel  want=$want got=$got"; status=1
  fi
done <<< "$ENTRIES"
exit $status
