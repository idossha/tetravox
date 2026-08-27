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
wasm-pack build "$PROFILE" --target web --out-dir "$OUT_REL" --out-name tvx_wasm

# wasm-pack writes pkg/package.json named after the crate and pkg/.gitignore containing '*'.
# pkg/ is NEVER a pnpm workspace member (§2) — the hand-written @tetravox/wasm wraps it.
echo "ok: $(cd "$ROOT" && ls packages/wasm/pkg | tr '\n' ' ')"
