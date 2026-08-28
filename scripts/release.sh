#!/usr/bin/env bash
# Cut a release: bump every version in the repo, open the CHANGELOG section, commit, tag.
#
#   scripts/release.sh 0.2.0
#   scripts/release.sh 0.2.0 --no-tag      # commit only
#   scripts/release.sh 0.2.0 --dry-run     # print what would change, touch nothing
#
# It does NOT push. Pushing the tag is what starts `.github/workflows/release.yml` and therefore what
# publishes a draft Release, so it stays a deliberate act by a human on `main`: `docs/RELEASING.md` §3.
#
# THE VERSION LIVES IN TWO KINDS OF PLACE and this script is the only thing that knows both:
#
#   * `package.json` × 5 — the root and the four workspace packages. `packages/app/package.json` is
#     the one electron-builder reads for `${version}` in every artefact name, so a partial bump ships
#     `Tetravox-0.1.0-mac-arm64.dmg` out of a 0.2.0 tree.
#   * `Cargo.toml` — `[workspace.package] version`, which all five crates inherit via
#     `version.workspace = true`. Bumping it moves `Cargo.lock`, so the lock is regenerated here with
#     `cargo update --workspace` (an offline, path-only update — it does NOT touch any dependency
#     version) and committed in the same commit. AGENTS.md rule 4 freezes the lockfiles against
#     *merges*, not against this.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="${1:-}"
shift || true
DRY=0
TAG=1
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --no-tag) TAG=0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

if [ -z "$VERSION" ]; then
  echo "usage: scripts/release.sh <version> [--dry-run] [--no-tag]" >&2
  exit 2
fi
# Semver, no leading `v` — the tag gets the `v`, the files do not. npm and Cargo both reject `v0.2.0`.
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "not a semver version: '$VERSION' (expected e.g. 0.2.0, and no leading 'v')" >&2
  exit 2
fi

TAG_NAME="v$VERSION"

# ------------------------------------------------------------------------------------------------
# Preconditions
# ------------------------------------------------------------------------------------------------
if [ "$DRY" = "0" ]; then
  if [ -n "$(git status --porcelain)" ]; then
    echo "the working tree is dirty; commit or stash first" >&2
    git status --short >&2
    exit 1
  fi
  if git rev-parse -q --verify "refs/tags/$TAG_NAME" >/dev/null; then
    echo "tag $TAG_NAME already exists" >&2
    exit 1
  fi
fi

CURRENT="$(node -p "require('./package.json').version")"
echo "==> $CURRENT → $VERSION"

PACKAGE_JSONS=(package.json packages/protocol/package.json packages/engine/package.json \
  packages/wasm/package.json packages/app/package.json)

# ------------------------------------------------------------------------------------------------
# The edits
# ------------------------------------------------------------------------------------------------
bump() {
  for f in "${PACKAGE_JSONS[@]}"; do
    node - "$f" "$VERSION" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const [file, version] = process.argv.slice(2);
const text = readFileSync(file, 'utf8');
// A targeted replacement of the FIRST top-level "version", not JSON.parse + stringify: rewriting the
// whole document would reformat it and fight prettier, and a dependency's own "version" key must not
// be touched. The `^  "version"` anchor is the top-level one in every file here.
const next = text.replace(/^(\s*"version":\s*)"[^"]*"/m, `$1"${version}"`);
if (next === text) { console.error(`no top-level "version" in ${file}`); process.exit(1); }
writeFileSync(file, next);
NODE
    echo "    $f"
  done

  # `[workspace.package] version`, which the five crates inherit.
  node - Cargo.toml "$VERSION" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const [file, version] = process.argv.slice(2);
const text = readFileSync(file, 'utf8');
const next = text.replace(
  /(\[workspace\.package\][\s\S]*?\nversion = )"[^"]*"/,
  `$1"${version}"`
);
if (next === text) { console.error('no [workspace.package] version in Cargo.toml'); process.exit(1); }
writeFileSync(file, next);
NODE
  echo "    Cargo.toml [workspace.package]"

  # CHANGELOG: turn `## [Unreleased]` into the released section, dated, and open a fresh Unreleased.
  node - CHANGELOG.md "$VERSION" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const [file, version] = process.argv.slice(2);
const today = new Date().toISOString().slice(0, 10);
let text = readFileSync(file, 'utf8');
if (text.includes(`## [${version}]`)) {
  // The section was written by hand ahead of the bump — the normal case for a release whose notes are
  // the point. Only date it if it is undated.
  text = text.replace(new RegExp(`## \\[${version.replace(/\./g, '\\.')}\\](?! - )`), `## [${version}] - ${today}`);
} else if (text.includes('## [Unreleased]')) {
  text = text.replace('## [Unreleased]', `## [Unreleased]\n\nNothing yet.\n\n## [${version}] - ${today}`);
} else {
  console.error('CHANGELOG.md has neither an [Unreleased] section nor one for this version');
  process.exit(1);
}
writeFileSync(file, text);
NODE
  echo "    CHANGELOG.md"
}

if [ "$DRY" = "1" ]; then
  echo "    (dry run) would rewrite:"
  printf '      %s\n' "${PACKAGE_JSONS[@]}" Cargo.toml CHANGELOG.md
  echo "    (dry run) would run: cargo update --workspace --offline"
  echo "    (dry run) would commit 'chore(release): $VERSION' and tag $TAG_NAME"
  exit 0
fi

bump

echo "==> cargo update --workspace (regenerates Cargo.lock's own version entries)"
cargo update --workspace --offline >/dev/null 2>&1 || cargo update --workspace >/dev/null

echo "==> prettier --write on the files that were touched"
pnpm exec prettier --write "${PACKAGE_JSONS[@]}" CHANGELOG.md >/dev/null

echo "==> sanity: every version now reads $VERSION"
for f in "${PACKAGE_JSONS[@]}"; do
  got="$(node -p "require('./$f').version")"
  [ "$got" = "$VERSION" ] || { echo "$f is $got, not $VERSION" >&2; exit 1; }
done
grep -q "^version = \"$VERSION\"" Cargo.toml || { echo "Cargo.toml did not take" >&2; exit 1; }

git add "${PACKAGE_JSONS[@]}" Cargo.toml Cargo.lock CHANGELOG.md
git commit -m "chore(release): $VERSION"

if [ "$TAG" = "1" ]; then
  # An annotated tag: `release.yml` reads its message nowhere, but `git describe` and the GitHub
  # release UI both do, and a lightweight tag has no author or date of its own.
  git tag -a "$TAG_NAME" -m "Tetravox $VERSION"
  echo "==> tagged $TAG_NAME"
fi

cat <<EOF

Done, locally. Nothing has been pushed.

  git show --stat HEAD
  git push origin main
  git push origin $TAG_NAME     # <- this is what builds and drafts the Release

docs/RELEASING.md §3 has the rest.
EOF
