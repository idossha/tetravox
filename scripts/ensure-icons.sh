#!/usr/bin/env bash
# The icon set electron-builder.yml names, in the one place it names them.
#
# `directories.buildResources: build` is relative to `packages/app`, so the canonical location is
# `packages/app/build/`: `icon.png` (1024²), `icon.icns`, `icon.ico` and `icons/<n>x<n>.png`. A logo
# pipeline that dropped them at the repo root instead is mirrored across here rather than being
# renamed at the far end, because the config path is the thing that must stay stable.
#
# It never generates anything. A packaging run with no icons must fail loudly and name the files, not
# ship a release wearing the stock Electron logo.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/packages/app/build"
SRC="$ROOT/build"

if [ -d "$SRC" ] && [ ! -f "$DEST/icon.icns" ]; then
  echo "ensure-icons: mirroring $SRC → $DEST"
  mkdir -p "$DEST"
  cp -R "$SRC/." "$DEST/"
fi

missing=()
for f in icon.png icon.icns icon.ico; do
  [ -f "$DEST/$f" ] || missing+=("packages/app/build/$f")
done
[ -d "$DEST/icons" ] && [ -n "$(ls -A "$DEST/icons" 2>/dev/null)" ] || missing+=("packages/app/build/icons/*.png")

if [ ${#missing[@]} -ne 0 ]; then
  echo "ensure-icons: missing icon assets:" >&2
  printf '  %s\n' "${missing[@]}" >&2
  echo "These are produced by the logo pipeline and committed. See docs/RELEASING.md §2." >&2
  exit 1
fi

echo "ensure-icons: ok ($DEST)"
