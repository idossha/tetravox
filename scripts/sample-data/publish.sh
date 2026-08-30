#!/usr/bin/env bash
# Publish the staged sample-data assets to the content-addressed store.
#
#   scripts/sample-data/stage.py                 # verifies + copies sources to data/sample-store/<sha256>
#   scripts/sample-data/publish.sh [--create]    # uploads them to the SHA256 release
#
# The store is the GitHub repository idossha/tetravox-sample-data with a single release tagged
# `SHA256`, each asset named by its hash — 3D Slicer's SlicerDataStore layout, which is what lets the
# app verify a download against its own URL. `--create` makes the repository and the release the
# first time; every later run only uploads assets that are not there yet (`--clobber` is never
# passed: an asset's content is its name, so re-uploading can only ever be a no-op or a mistake).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPO="${TETRAVOX_SAMPLE_REPO:-idossha/tetravox-sample-data}"
TAG="SHA256"
STORE="${TETRAVOX_SAMPLE_STORE:-$ROOT/data/sample-store}"

if [ "${1:-}" = "--create" ]; then
  gh repo create "$REPO" --public \
    --description "Sample datasets for Tetravox — content-addressed release assets (see the Tetravox website's Sample data page)"
  gh release create "$TAG" --repo "$REPO" --title "$TAG" \
    --notes "Content-addressed sample files: every asset is named by its own sha256. What each one is — file name, sample, source, licence — is listed on https://idossha.github.io/tetravox/sample-data and in packages/app/src/shared/sample-catalog.json in the Tetravox repository."
fi

existing="$(gh release view "$TAG" --repo "$REPO" --json assets --jq '.assets[].name')"
n=0
for f in "$STORE"/*; do
  name="$(basename "$f")"
  if grep -qx "$name" <<< "$existing"; then
    echo "have     $name"
  else
    echo "upload   $name  ($(stat -f%z "$f" 2>/dev/null || stat -c%s "$f") B)"
    gh release upload "$TAG" "$f" --repo "$REPO"
    n=$((n + 1))
  fi
done
echo "$n uploaded to https://github.com/$REPO/releases/tag/$TAG"
