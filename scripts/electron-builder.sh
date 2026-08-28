#!/usr/bin/env bash
# electron-builder, plus the ONE conditional that macOS code signing needs. Every packaging path goes
# through here: `pnpm package`, `.github/workflows/ci.yml`'s package legs and `release.yml`'s.
#
#   scripts/electron-builder.sh                 # this platform's default targets
#   scripts/electron-builder.sh --mac           # both mac slices
#   scripts/electron-builder.sh --linux --x64
#
# WHY A SCRIPT AND NOT TWO CONFIGS. `electron-builder.yml` describes the *signed* build — hardened
# runtime, entitlements, notarisation — because that is what a release must be. A fork, a contributor
# running `pnpm package`, and ci.yml's package legs have no certificate, and for them every one of
# those settings is wrong in a way that is worse than unsigned: electron-builder ad-hoc-signs the
# arm64 slice regardless, and an ad-hoc signature plus `hardenedRuntime: true` is an app the kernel
# kills at launch. So the rule is written once, here:
#
#   CSC_LINK set    → sign and notarise exactly as the config says (release.yml passes the secrets).
#   CSC_LINK empty  → CSC_IDENTITY_AUTO_DISCOVERY=false, hardenedRuntime and notarize back to false.
#
# `CSC_IDENTITY_AUTO_DISCOVERY=false` is what keeps this deterministic on a *developer's* Mac: without
# it electron-builder would find whatever Developer ID happens to be in the login keychain and sign a
# local build with it, so `pnpm package` would behave differently for two people on the same commit.
#
# `--publish never` is load-bearing and is set here for everyone: electron-builder reads `CI=true` as
# consent to publish and otherwise builds every artefact and *then* dies with
# `⨯ GitHub Personal Access Token is not set`. Attaching assets is release.yml's explicit step.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/packages/app"

extra=()
if [ "$(uname -s)" = "Darwin" ] && [ -z "${CSC_LINK:-}" ]; then
  echo "==> no CSC_LINK: building UNSIGNED (no hardened runtime, no notarisation)"
  # UNSET, not merely empty. A workflow writes `CSC_LINK: ${{ secrets.CSC_LINK }}` unconditionally, so
  # on a runner with no secret the variable exists and is the empty string — and electron-builder
  # tests these for *defined*, not for non-empty. It then resolves "" as a certificate path and dies
  # with `⨯ /path/to/packages/app not a file`, which names neither signing nor the empty variable.
  unset CSC_LINK CSC_KEY_PASSWORD APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID
  export CSC_IDENTITY_AUTO_DISCOVERY=false
  extra=(--config.mac.hardenedRuntime=false --config.mac.notarize=false)
elif [ "$(uname -s)" = "Darwin" ]; then
  echo "==> CSC_LINK is present: signing with Developer ID${APPLE_ID:+ and notarising as $APPLE_ID}"
fi

# `${extra[@]+...}` rather than a bare `"${extra[@]}"`: macOS ships bash 3.2, where an empty array
# expanded under `set -u` is an unbound-variable error.
exec ./node_modules/.bin/electron-builder \
  --config electron-builder.yml \
  --publish never \
  ${extra[@]+"${extra[@]}"} \
  "$@"
