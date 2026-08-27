/**
 * A ~60-line PNG **encoder**, for the no-GL engine's `screenshot()` (§4.7).
 *
 * The frozen dependency list (§12.3) has no image library and adding one is a coordinated change, so
 * the stand-in engine writes its own: 8-bit RGBA, non-interlaced, one uncompressed (stored) deflate
 * block. `e2e/png.ts` is the matching decoder, and the E2E asserts the round trip — which is what
 * makes "the screenshot button produced a PNG" a checkable claim rather than a MIME type.
 *
 * `pHYs` is written when a DPI is given, because `ScreenshotOptions.dpi` is defined as "written to the
 * PNG `pHYs` chunk" and a stand-in that silently drops it would hide the real engine forgetting to.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** zlib stream around stored deflate blocks — no compression, but a legal `IDAT`. */
function zlibStored(raw: Uint8Array): Uint8Array {
  const blocks: Uint8Array[] = [];
  const MAX = 0xffff;
  for (let offset = 0; offset < raw.length || offset === 0; offset += MAX) {
    const slice = raw.subarray(offset, Math.min(offset + MAX, raw.length));
    const last = offset + MAX >= raw.length ? 1 : 0;
    const header = new Uint8Array(5);
    header[0] = last;
    header[1] = slice.length & 0xff;
    header[2] = (slice.length >>> 8) & 0xff;
    header[3] = ~slice.length & 0xff;
    header[4] = (~slice.length >>> 8) & 0xff;
    blocks.push(header, slice);
    if (last) break;
  }
  const body = concat(blocks);
  const out = new Uint8Array(2 + body.length + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  out.set(body, 2);
  new DataView(out.buffer).setUint32(2 + body.length, adler32(raw));
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export interface EncodePngOptions {
  width: number;
  height: number;
  /** RGBA8, row-major, top-left origin, `width * height * 4` bytes. */
  pixels: Uint8Array;
  /** Written to the `pHYs` chunk when set (§4.7 `ScreenshotOptions.dpi`). */
  dpi?: number;
}

export function encodePng({ width, height, pixels, dpi }: EncodePngOptions): Uint8Array {
  if (pixels.length !== width * height * 4) {
    throw new Error(`expected ${width * height * 4} RGBA bytes, got ${pixels.length}`);
  }
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10, 11, 12: compression 0, filter 0, interlace 0

  const parts: Uint8Array[] = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
  ];
  if (dpi !== undefined && Number.isFinite(dpi) && dpi > 0) {
    const phys = new Uint8Array(9);
    const pv = new DataView(phys.buffer);
    const perMetre = Math.round(dpi / 0.0254);
    pv.setUint32(0, perMetre);
    pv.setUint32(4, perMetre);
    phys[8] = 1; // unit: metre
    parts.push(chunk('pHYs', phys));
  }
  parts.push(chunk('IDAT', zlibStored(raw)), chunk('IEND', new Uint8Array(0)));
  return concat(parts);
}
