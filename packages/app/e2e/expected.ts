/**
 * The expected values, recomputed **from first principles** in JS (§11 rule 0: an agent cannot judge a
 * PNG; it can judge a number).
 *
 * `tvxPing` is an independent transcription of `tvx_ping` in `crates/tvx-wasm/src/lib.rs`, not a
 * constant copied out of a previous run. If the two ever disagree, one of them is wrong — which is the
 * whole point of asserting the triangle's colour instead of diffing a screenshot against itself.
 */

/** murmur3's 32-bit finalizer over `x ^ 0x9E3779B9`. `Math.imul` is the 32-bit multiply. */
export function tvxPing(x: number): number {
  let h = (x ^ 0x9e3779b9) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h;
}

/** `tvx_ping_bytes`: fold `tvx_ping` over the bytes, seeded with the length. */
export function tvxPingBytes(bytes: Uint8Array): number {
  let h = bytes.length >>> 0;
  for (const b of bytes) h = tvxPing((h ^ b) >>> 0);
  return h;
}

/** `resources/phase0-fixture.bin` is exactly the 256 bytes 0x00..0xFF. */
export const FIXTURE_BYTES = Uint8Array.from({ length: 256 }, (_, i) => i);
