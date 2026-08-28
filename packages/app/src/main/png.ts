/**
 * A PNG **decoder** for the main process, because the GIF encoder needs RGBA and what crosses IPC is
 * a PNG.
 *
 * The alternative — sending raw RGBA from the renderer — is 5 MB per 1400×900 frame against ~300 kB
 * for the PNG the engine already produced, and a 36-frame orbit would then be 180 MB of
 * structured-clone traffic. Decoding here costs a few milliseconds per frame and keeps the channel
 * small.
 *
 * Scope is exactly what `Engine.screenshot` emits: 8-bit, non-interlaced, colour type 2 (RGB) or 6
 * (RGBA). Anything else throws rather than guessing. `e2e/png.ts` is the same reader for the test
 * side; they are deliberately separate copies — an E2E must be able to disagree with the code under
 * test (`docs/TESTING.md` §4).
 */

import { inflateSync } from 'node:zlib';

export interface DecodedPng {
  width: number;
  height: number;
  /** RGBA8, row-major, top-left origin. */
  pixels: Uint8Array;
}

export function decodePng(buffer: Buffer): DecodedPng {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];

  for (let offset = 8; offset + 8 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body.readUInt8(8);
      colorType = body.readUInt8(9);
      if (body.readUInt8(12) !== 0) throw new Error('interlaced PNG unsupported');
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  if (bitDepth !== 8) throw new Error(`bit depth ${bitDepth} unsupported`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (channels === 0) throw new Error(`colour type ${colorType} unsupported`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  const line = new Uint8Array(stride);
  const prev = new Uint8Array(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const start = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[start + x] ?? 0;
      const a = x >= channels ? (line[x - channels] ?? 0) : 0;
      const b = prev[x] ?? 0;
      const c = x >= channels ? (prev[x - channels] ?? 0) : 0;
      let recon: number;
      switch (filter) {
        case 0:
          recon = value;
          break;
        case 1:
          recon = value + a;
          break;
        case 2:
          recon = value + b;
          break;
        case 3:
          recon = value + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          recon = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`filter ${filter} unsupported`);
      }
      line[x] = recon & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const src = x * channels;
      const dst = (y * width + x) * 4;
      out[dst] = line[src] ?? 0;
      out[dst + 1] = line[src + 1] ?? 0;
      out[dst + 2] = line[src + 2] ?? 0;
      out[dst + 3] = channels === 4 ? (line[src + 3] ?? 0) : 255;
    }
    prev.set(line);
  }

  return { width, height, pixels: out };
}
