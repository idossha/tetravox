#!/usr/bin/env bash
# Build crates/tvx-wasm -> packages/wasm/pkg (ARCHITECTURE.md §2).
#
# `pnpm wasm` is a prerequisite of `pnpm build` / `pnpm test` / `pnpm typecheck`.
# Never typecheck against a missing pkg/ (AGENTS.md).
#
# wasm-pack's version is pinned here and `wasm-bindgen` is pinned `=0.2.127` in Cargo.toml (§2);
# a mismatch between the two produces glue that does not match the module.
set -euo pipefail

WASM_PACK_VERSION="0.15.0"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE="$ROOT/crates/tvx-wasm"
OUT_REL="../../packages/wasm/pkg"
PROFILE="${TETRAVOX_WASM_PROFILE:---release}"

if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "error: wasm-pack not found on PATH." >&2
  echo "  install: cargo install wasm-pack --version ${WASM_PACK_VERSION} --locked" >&2
  exit 1
fi

have="$(wasm-pack --version | awk '{print $2}')"
if [ "$have" != "$WASM_PACK_VERSION" ]; then
  echo "warning: wasm-pack ${have} found, ${WASM_PACK_VERSION} pinned (scripts/build-wasm.sh)." >&2
  echo "  CI pins the version; a local mismatch can produce different glue." >&2
fi

if ! rustup target list --installed 2>/dev/null | grep -qx wasm32-unknown-unknown; then
  echo "error: rust target wasm32-unknown-unknown is not installed." >&2
  echo "  install: rustup target add wasm32-unknown-unknown" >&2
  exit 1
fi

echo "wasm-pack ${have} -> packages/wasm/pkg (${PROFILE})"
cd "$CRATE"

# wasm-pack downloads binaryen (for wasm-opt) from a GitHub release on a cold cache, and that
# download is the one part of this build that depends on the network being kind:
#
#   Error: failed to download from https://github.com/WebAssembly/binaryen/releases/download/\
#   version_117/binaryen-version_117-x86_64-linux.tar.gz
#
# which is exactly what killed one CI leg (run 33444860430, `e2e (engine 1/3)`) while three other
# legs building the same crate at the same moment succeeded. CI fans out now, so several runners
# reach for that tarball at once and one losing the race must not be a red build.
#
# Retried ONLY on that message. A compile error is a compile error and fails on the first attempt —
# retrying it would just bill three builds to reach the same red.
log="$(mktemp)"
trap 'rm -f "$log"' EXIT
attempt=1
until wasm-pack build "$PROFILE" --target web --out-dir "$OUT_REL" --out-name tvx_wasm 2>&1 | tee "$log"; do
  if ! grep -q 'failed to download' "$log"; then
    exit 1
  fi
  if [ "$attempt" -ge 3 ]; then
    echo "error: wasm-pack could not download its binaryen tarball in ${attempt} attempts." >&2
    exit 1
  fi
  sleep "$((attempt * 5))"
  attempt=$((attempt + 1))
  echo "wasm-pack's binaryen download failed; retrying (attempt ${attempt}/3)." >&2
done

# wasm-pack writes pkg/package.json named after the crate and pkg/.gitignore containing '*'.
# pkg/ is NEVER a pnpm workspace member (§2) — the hand-written @tetravox/wasm wraps it.
echo "ok: $(cd "$ROOT" && ls packages/wasm/pkg | tr '\n' ' ')"
