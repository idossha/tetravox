#!/usr/bin/env bash
# Linux artefacts (.AppImage, .deb, .tar.gz) from a macOS or Linux host, via Docker.
#
#   scripts/package-linux.sh          # build, then smoke-test the result inside the container
#   scripts/package-linux.sh --no-smoke
#   scripts/package-linux.sh --smoke-only   # re-run just the smoke test on the artefacts on disk
#
# ------------------------------------------------------------------------------------------------
# WHY THIS SHAPE — three options were tried, this is the one that works
# ------------------------------------------------------------------------------------------------
#
# (a) `electronuserland/builder:wine` with Rust + wasm-pack installed in the container. Works, and is
#     the most self-contained, but it pays for a `rustup` install and a full `cargo build --release`
#     for wasm32 on every run — several minutes, in a container with no cargo cache — to produce a
#     .wasm file that is byte-identical to the one the host already built. The wine layer is dead
#     weight on top of that: this project's Windows target is unsigned NSIS, which electron-builder
#     produces with a native `makensis` and no wine at all (see electron-builder.yml `win:`).
#
# (b) The plain `electronuserland/builder` image, **wasm pre-built on the host**, container runs
#     `pnpm install` + `electron-vite build` + `electron-builder --linux`. This is what runs below.
#     `packages/wasm/pkg` is a committed-shape build output that `pnpm wasm` writes on the host, and
#     nothing in it is platform-specific — wasm32-unknown-unknown is the same file everywhere — so
#     carrying it into the container is correct rather than a shortcut. `--rm` and a named volume for
#     the electron cache keep a second run to about a minute.
#
# (c) `pnpm package` on the host with `--linux`. Rejected: §12.1 says Linux artefacts are never built
#     on macOS, and it is right — the .deb's `strip`, the AppImage's runtime and the desktop-file
#     validation are all Linux-native steps that either fail or silently no-op on darwin.
#
# The image tag carries an explicit node major: the app's `engines.node` is `>=22`, and the
# `electronuserland/builder:20` tag makes pnpm print an "Unsupported engine" warning on every command. The container runs as root (the `electronuserland` images assume it), so
# it `chown`s the two directories it writes back into the bind mount — `release/` and `out/` — to the
# invoking uid on the way out. Leaving them root-owned is the classic failure of running these images
# naively: the host's next build fails with an EACCES that names no container.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${TETRAVOX_BUILDER_IMAGE:-electronuserland/builder:24}"
SMOKE=1
BUILD=1
case "${1:-}" in
  --no-smoke) SMOKE=0 ;;
  --smoke-only) BUILD=0 ;;
  "") ;;
  *) echo "unknown flag: $1" >&2; exit 2 ;;
esac

command -v docker >/dev/null || { echo "docker is not on PATH" >&2; exit 1; }

bash "$ROOT/scripts/ensure-icons.sh"

# (b): the wasm is built on the host, once, and carried in. Never inside the container.
if [ ! -f "$ROOT/packages/wasm/pkg/tvx_wasm_bg.wasm" ]; then
  echo "==> pnpm wasm (host)"
  (cd "$ROOT" && pnpm wasm)
fi

# A named volume for ~/.cache/electron, so the ~100 MB binary is downloaded once across runs. Electron
# ≥ 42 fetches it on first launch rather than on install, but electron-builder still populates this
# cache when it assembles the app, and a cold container otherwise re-downloads it every time (§12.2).
docker volume create tetravox-electron-cache >/dev/null
# NAMED VOLUMES OVER EVERY node_modules IN THE WORKSPACE. This is the load-bearing part of the script.
#
# The checkout is bind-mounted, and pnpm's `node_modules` in it is a symlink farm full of **darwin**
# binaries: esbuild, electron, rollup. A container `pnpm install` into the same paths replaces them
# with linux ones, and the host's next `pnpm dev` then dies with an esbuild platform mismatch that
# says nothing about Docker. A volume mounted over each of them hides the host's tree entirely — the
# container installs into the volume, the host's copy is untouched, and because the volumes are named
# the second run reuses the install instead of repeating it.
#
# `packages/wasm/pkg` is deliberately NOT masked: it is the host-built wasm this whole arrangement
# exists to carry in.
NM_MOUNTS=(-v tetravox-linux-nm-root:/project/node_modules)
for pkg in protocol engine wasm app; do
  NM_MOUNTS+=(-v "tetravox-linux-nm-$pkg:/project/packages/$pkg/node_modules")
  docker volume create "tetravox-linux-nm-$pkg" >/dev/null
done
docker volume create tetravox-linux-nm-root >/dev/null

UID_GID="$(id -u):$(id -g)"

# A marker whose mtime the artefacts must beat. The quoting bug this guards against (see the
# NO APOSTROPHES note below) made the container exit 0 without building anything, and the script then
# listed the PREVIOUS run's artefacts as if they were new — a green run over stale files, which is the
# worst outcome a packaging script can have.
STARTED_AT="$(mktemp)"
trap 'rm -f "$STARTED_AT"' EXIT

if [ "$BUILD" = "1" ]; then
echo "==> electron-builder --linux in $IMAGE"
docker run --rm --platform linux/amd64 \
  -v "$ROOT":/project \
  "${NM_MOUNTS[@]}" \
  -v tetravox-electron-cache:/root/.cache/electron \
  -w /project \
  -e ELECTRON_CACHE=/root/.cache/electron \
  -e CI=true \
  "$IMAGE" \
  bash -c '
    set -euo pipefail
    corepack enable
    export PNPM_HOME=/tmp/pnpm-home
    export PATH="$PNPM_HOME:$PATH"
    pnpm config set store-dir /tmp/pnpm-store
    pnpm install --frozen-lockfile
    # NO APOSTROPHES ANYWHERE IN THIS BLOCK, comments included: the whole body is one single-quoted
    # argument to bash -c, so a lone apostrophe closes it. The failure is silent and bizarre — the
    # commands after it simply never run, docker exits 0, and the script cheerfully reports the
    # artefacts from the PREVIOUS run as if it had just built them.
    #
    # --publish never is NOT optional. electron-builder treats CI=true as consent to publish
    # ("Implicit publishing triggered by CI detection") and, after building every artefact, dies with
    # "GitHub Personal Access Token is not set" — twenty minutes in, with the .deb already on disk.
    # Uploading a Release belongs to release.yml and to nothing else.
    #
    # NOT pnpm build, and not pnpm -r run build. The root build script runs pnpm wasm first, which
    # needs wasm-pack in a container that has no Rust — the whole point of (b) is that
    # packages/wasm/pkg came in from the host. A recursive build also sweeps in the VitePress site.
    # packages/app is the only workspace package with a build script at all: protocol, engine and
    # wasm are consumed as TypeScript source by electron-vite.
    pnpm --filter @tetravox/app exec electron-vite build
    pnpm --filter @tetravox/app exec electron-builder --config electron-builder.yml --linux --x64 --publish never
    # Only `release/` is written back into the bind mount, and it must not end up root-owned.
    chown -R '"$UID_GID"' /project/packages/app/release /project/packages/app/out
  '

fi

echo
echo "==> artefacts"
ls -lh "$ROOT/packages/app/release" | grep -E 'AppImage|\.deb|tar\.gz' || true

# Every artefact must be newer than the marker, or the container did not actually build it.
stale=0
[ "$BUILD" = "0" ] && stale=skip
[ "$stale" = "skip" ] || for pattern in '*.AppImage' '*.deb' '*.tar.gz'; do
  found="$(find "$ROOT/packages/app/release" -maxdepth 1 -name "$pattern" -newer "$STARTED_AT" | head -1)"
  if [ -z "$found" ]; then
    echo "no fresh $pattern — the container produced nothing for this target" >&2
    stale=1
  fi
done
if [ "$stale" != "0" ] && [ "$stale" != "skip" ]; then
  echo "package-linux: the build did not run. Check the container output above." >&2
  exit 1
fi

if [ "$SMOKE" = "0" ]; then exit 0; fi

# ------------------------------------------------------------------------------------------------
# The smoke test, inside a container, under Xvfb
# ------------------------------------------------------------------------------------------------
#
# WHAT IS RUN, AND WHY IT IS THE UNPACKED TREE RATHER THAN THE .AppImage.
#
# The thing being proved is that the Linux build can start a renderer and write a frame, so the
# subject is `release/linux-unpacked/tetravox` — the exact binary and asar the .AppImage wraps, minus
# its self-mounting runtime.
#
# Running the .AppImage itself is attempted first and is allowed to fail on ONE specific host: an
# Apple-silicon Mac. `electronuserland/builder` has no arm64 image, so the container is x86_64 under
# emulation, and while ordinary x86_64 binaries exec fine there (the unpacked `tetravox` does), the
# AppImage runtime is linked against a very old glibc and comes back as
# `cannot execute binary file: Exec format error`. The payload is a perfectly good ELF —
# `file` reports `ELF 64-bit LSB executable, x86-64 ... for GNU/Linux 2.6.18` — so this is the
# emulator, not the build. The native `ubuntu-24.04` leg in CI runs the same smoke test against the
# same artefacts with nothing emulated, and that is where the AppImage wrapper is actually exercised.
#
# `--no-sandbox` on every launch: `chrome-sandbox` is not root-owned setuid inside either the AppImage
# or the unpacked tree, and Chromium aborts rather than drop the sandbox silently (§12.2).
echo
echo "==> smoke test (under Xvfb, in the container)"
APPIMAGE="$(cd "$ROOT/packages/app/release" && ls -1 ./*.AppImage 2>/dev/null | head -1 | sed 's|^\./||')"
[ -n "$APPIMAGE" ] || { echo "no .AppImage was produced" >&2; exit 1; }

docker run --rm --platform linux/amd64 \
  -v "$ROOT":/project \
  -w /project \
  -e APPIMAGE_EXTRACT_AND_RUN=1 \
  "$IMAGE" \
  bash -c '
    set -euo pipefail
    apt-get update -qq
    apt-get install -y -qq xvfb x11-utils libgtk-3-0 libnss3 libatk-bridge2.0-0 libgbm1 \
      libxkbcommon0 libxdamage1 libxcomposite1 libxrandr2 libpango-1.0-0 libcairo2 >/dev/null
    # ALSA was renamed libasound2 -> libasound2t64 in the 64-bit-time_t transition, so the right name
    # depends on the base image release rather than on anything here. Try both, require one.
    apt-get install -y -qq libasound2t64 >/dev/null 2>&1 || apt-get install -y -qq libasound2 >/dev/null
    Xvfb :99 -screen 0 1280x1024x24 >/dev/null 2>&1 &
    export DISPLAY=:99
    for _ in $(seq 1 30); do xdpyinfo -display :99 >/dev/null 2>&1 && break; sleep 1; done

    # 1. The AppImage wrapper, best effort (see the note above about emulated hosts).
    echo "--- AppImage wrapper"
    cd /tmp
    if "/project/packages/app/release/'"$APPIMAGE"'" --appimage-extract >/dev/null 2>/tmp/appimage.err; then
      echo "AppImage self-extracted; running the smoke test against it"
      node /project/scripts/smoke-artefact.mjs --exe /tmp/squashfs-root/tetravox
      exit 0
    fi
    echo "AppImage could not run in this container:"
    sed "s/^/    /" /tmp/appimage.err
    if ! grep -q "Exec format error" /tmp/appimage.err; then
      echo "That is not the known emulated-host limitation. Failing." >&2
      exit 1
    fi
    echo "    ^ the known Apple-silicon/emulation limitation; CI ubuntu-24.04 covers this natively."

    # 2. The unpacked tree, which must work on every host.
    echo "--- unpacked tree"
    node /project/scripts/smoke-artefact.mjs --exe /project/packages/app/release/linux-unpacked/tetravox
  '

echo
echo "package-linux: done."
