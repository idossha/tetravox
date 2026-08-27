/**
 * `@tetravox/wasm` is the seam between the §6.5 worker protocol and the §6.4 wasm-bindgen exports, and
 * the committed `pkg/tvx_wasm.d.ts` stub is what `tsc` sees before the first `pnpm wasm` (§12.3 item 4).
 *
 * Nothing type-checks the seam itself: `OP_TO_EXPORT` maps an op to a *string*, and a typo there — or a
 * renamed export on the Rust side — compiles cleanly and fails at run time on a real dataset. So read
 * the stub as data and assert the mapping lands on functions that exist.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OP_NAMES, OP_TO_EXPORT } from '@tetravox/protocol';

const DTS = readFileSync(fileURLToPath(new URL('../pkg/tvx_wasm.d.ts', import.meta.url)), 'utf8');

/** Top-level `export function <name>(` declarations in the wasm-pack d.ts. */
function declaredExports(source: string): Set<string> {
  const out = new Set<string>();
  const re = /^export function ([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;
  let m: RegExpExecArray | null = re.exec(source);
  while (m !== null) {
    if (m[1] !== undefined) out.add(m[1]);
    m = re.exec(source);
  }
  return out;
}

describe('§6.4 wasm export surface', () => {
  const exports = declaredExports(DTS);

  it('declares every export the §6.5.2 op table points at', () => {
    expect(exports.size).toBeGreaterThan(0);
    const missing = OP_NAMES.map((op) => OP_TO_EXPORT[op]).filter((name) => !exports.has(name));
    expect(missing, `ops point at wasm exports that pkg/tvx_wasm.d.ts does not declare`).toEqual(
      []
    );
  });

  it('declares wasm_heap_bytes, which every successful Res carries (§6.5)', () => {
    expect(exports.has('wasm_heap_bytes')).toBe(true);
  });

  it('has no op-reachable export that the op table never names', () => {
    // The reverse direction. `free`/`free_mask` are ops; the wasm-bindgen lifecycle helpers
    // (`initSync`, the default init) are not, and are excluded by name rather than by heuristic.
    const lifecycle = new Set(['initSync', 'wasm_heap_bytes']);
    const mapped = new Set<string>(OP_NAMES.map((op) => OP_TO_EXPORT[op]));
    const orphans = [...exports].filter((name) => !mapped.has(name) && !lifecycle.has(name));
    expect(
      orphans,
      'a §6.4 export no §6.5.2 op can reach is either dead or an unwired feature'
    ).toEqual([]);
  });
});
