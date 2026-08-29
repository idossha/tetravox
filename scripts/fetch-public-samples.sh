#!/usr/bin/env bash
# Fetch the small public, non-head NIfTI samples the docs/screenshots gallery renders.
#
# Everything lands in data/public/<name>/ (git-ignored). Each file's sha256 is checked after
# download; docs/screenshots/2026-08-29/DATASETS.md carries the URL, licence and hash
# for every entry. Total is ~190 MB (the AMOS22 and TotalSegmentator-MR abdomen/spine cases are the bulk).
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
ctspine1k|colonog-0477_ct.nii.gz|https://huggingface.co/datasets/alexanderdann/CTSpine1K/resolve/main/raw_data/volumes/COLONOG/1.3.6.1.4.1.9328.50.4.0477.nii.gz|bba2263ff3fa175b88033d9d4186c18802770114c9c1b01c90139daf6ef738a6
ctspine1k|colonog-0477_ct_seg.nii.gz|https://huggingface.co/datasets/alexanderdann/CTSpine1K/resolve/main/raw_data/labels/COLONOG/1.3.6.1.4.1.9328.50.4.0477_seg.nii.gz|2e5a2b64549af49b50200d683f46682dd77a034ce17e76c32709444eda87613c
ctspine1k|msd-t10-liver_0_ct.nii.gz|https://huggingface.co/datasets/alexanderdann/CTSpine1K/resolve/main/raw_data/volumes/MSD-T10/liver_0.nii.gz|ffc5bbc51875660f7e72a8b3b5391a8b256e3b83edffc7428041a54422d3fec7
ctspine1k|msd-t10-liver_0_ct_seg.nii.gz|https://huggingface.co/datasets/alexanderdann/CTSpine1K/resolve/main/raw_data/labels/MSD-T10/liver_0_seg.nii.gz|2f4884b0631fe09baf9513fb19a95d7ff79a2b9e75e7095b0b033fe6c2d6e092
amos22-ct|amos_0004_ct.nii.gz|https://huggingface.co/datasets/MedOtter/amos22-ct-dataset/resolve/main/train/imagesTr/amos_0004.nii.gz|0c65994c6c53182ef0fe8e1d86e597b843cb99db2dc1ac8f27876e34319ca9d9
amos22-ct|amos_0004_seg.nii.gz|https://huggingface.co/datasets/MedOtter/amos22-ct-dataset/resolve/main/train/labelsTr/amos_0004.nii.gz|cb8bac8e724ccff8842285f460c0d5ab361aa15c4bab25bd371a25fef9cf79b3
amos22-ct|amos_0088_ct.nii.gz|https://huggingface.co/datasets/MedOtter/amos22-ct-dataset/resolve/main/train/imagesTr/amos_0088.nii.gz|6948c143220d7abdb876d22cd5b47349e1edbbcbba04ee953271f04fc6662ac7
amos22-ct|amos_0088_seg.nii.gz|https://huggingface.co/datasets/MedOtter/amos22-ct-dataset/resolve/main/train/labelsTr/amos_0088.nii.gz|e11b4fda234d2a5d5bc134294954aa361b52ebc11961b129262ee463e5d0145b
amos22-mri|amos_0555_mri.nii.gz|https://huggingface.co/datasets/MedOtter/amos22-mri-dataset/resolve/main/train/imagesTr/amos_0555.nii.gz|b16fae6f7d84118f5212a0fab1664c10370fc15aafe706dfd2386fb7015b3a5a
amos22-mri|amos_0555_seg.nii.gz|https://huggingface.co/datasets/MedOtter/amos22-mri-dataset/resolve/main/train/labelsTr/amos_0555.nii.gz|41ea5b7097c456575e1c48c6f8e6a65adc51329e6b06a671f2a95de7ca78acdc
amos22-mri|amos_0584_mri.nii.gz|https://huggingface.co/datasets/MedOtter/amos22-mri-dataset/resolve/main/train/imagesTr/amos_0584.nii.gz|64797b44a47b9744e7f5ade47c86876612f0b17008ccc1d9114c0ece59c68f81
amos22-mri|amos_0584_seg.nii.gz|https://huggingface.co/datasets/MedOtter/amos22-mri-dataset/resolve/main/train/labelsTr/amos_0584.nii.gz|536a1eeaeecf523ce3ffb40d8ea0fcc5f36cbe79d839a3089b3cc4b78b7e0f85
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

# --- TotalSegmentator-MR: one MRI + ~50 per-structure masks per subject, merged into seg.nii.gz ---
# name|subject|sha256 of mri.nii.gz. Masks are fetched from the tree listing (no per-mask pins:
# the merged label map is what the gallery renders, and it is rebuilt from them on every run).
TSMR_REPO="https://huggingface.co/datasets/MedOtter/TotalSegmentatorMR"
TSMR='
s0375|7612ace59b9cd2e8d54d9b3f99d4109c1d35ca8f535386a31a29cd2b8fe9fae8
s0132|fcfc3bde340ce2d406d33d3e497ea149af727ce4e0150610e1a7ac64050fa185
s0187|650dc62e46ef79bf1b4d861520ed0b86dda1db8db3e897368fedde2526737984
s0175|0f311daa4f19d8b89c1380832332db11d5f32cf406d2b591ba6800e6433eb379
'
while IFS='|' read -r subj want; do
  [ -z "$subj" ] && continue
  dir="$OUT/totalsegmentator-mr/$subj"; mkdir -p "$dir/segmentations"
  if [ ! -f "$dir/mri.nii.gz" ] || [ -z "$(ls "$dir/segmentations" 2>/dev/null)" ]; then
    if [ "$VERIFY_ONLY" = "--verify" ]; then echo "MISSING  totalsegmentator-mr/$subj"; status=1; continue; fi
    echo "fetch    $TSMR_REPO $subj (mri + masks)"
    curl -fsSL --retry 3 -o "$dir/mri.nii.gz" "$TSMR_REPO/resolve/main/$subj/mri.nii.gz"
    curl -fsSL "https://huggingface.co/api/datasets/MedOtter/TotalSegmentatorMR/tree/main/$subj/segmentations" \
      | python3 -c 'import sys,json;[print(e["path"]) for e in json.load(sys.stdin)]' \
      | xargs -P 16 -I{} curl -fsSL --retry 3 -o "$OUT/totalsegmentator-mr/{}" "$TSMR_REPO/resolve/main/{}"
  fi
  got="$(sha "$dir/mri.nii.gz")"
  if [ "$got" = "$want" ]; then echo "ok       totalsegmentator-mr/$subj/mri.nii.gz"; else echo "MISMATCH totalsegmentator-mr/$subj/mri.nii.gz  want=$want got=$got"; status=1; fi
  [ -f "$dir/seg.nii.gz" ] || python3 "$ROOT/scripts/merge-totalseg-mr.py" "$dir"
done <<< "$TSMR"

# --- LUT sidecars the app auto-associates (<stem>_LUT.txt) for the label maps above ---
write_amos_lut() { cat > "$1" <<'LUT'
#No.	Label Name:	R	G	B	A
0	Unknown	0	0	0	0
1	Spleen	0	128	0	255
2	Right-Kidney	255	0	0	255
3	Left-Kidney	255	140	0	255
4	Gallbladder	0	200	200	255
5	Esophagus	160	82	45	255
6	Liver	128	0	64	255
7	Stomach	255	215	0	255
8	Aorta	220	20	60	255
9	Inferior-Vena-Cava	30	144	255	255
10	Pancreas	255	255	0	255
11	Right-Adrenal-Gland	186	85	211	255
12	Left-Adrenal-Gland	147	112	219	255
13	Duodenum	0	255	127	255
14	Urinary-Bladder	255	105	180	255
15	Prostate-Uterus	70	130	180	255
LUT
}
for f in "$OUT"/amos22-*/*_seg.nii.gz; do [ -f "${f%.nii.gz}_LUT.txt" ] || write_amos_lut "${f%.nii.gz}_LUT.txt"; done
# CTSpine1K: 1-7 C1-C7, 8-19 T1-T12, 20-24 L1-L5, 25 L6 (sacral lumbarization cases).
for f in "$OUT"/ctspine1k/*_seg.nii.gz; do
  lut="${f%.nii.gz}_LUT.txt"; [ -f "$lut" ] && continue
  python3 - "$lut" <<'PY'
import sys, colorsys
names = [f"C{i}" for i in range(1,8)] + [f"T{i}" for i in range(1,13)] + [f"L{i}" for i in range(1,7)]
lines = ["#No.\tLabel Name:\tR\tG\tB\tA", "0\tUnknown\t0\t0\t0\t0"]
for i, n in enumerate(names, 1):
    r, g, b = colorsys.hsv_to_rgb((i * 0.618033988749895) % 1, 0.6, 0.95)
    lines.append(f"{i}\t{n}\t{int(r*255)}\t{int(g*255)}\t{int(b*255)}\t255")
open(sys.argv[1], "w").write("\n".join(lines) + "\n")
PY
done
exit $status
