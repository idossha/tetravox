/**
 * A PNG **reader** for the §11 screenshot assertions — chunks and pixels.
 *
 * `screenshot()` (§4.7) returns a `Blob`, and P2-06's whole subject is what is inside it: the size
 * the caller asked for, the `pHYs` DPI, the chrome items `include` did or did not draw, the border
 * `autoTrim` removed. §11 rule 0 applies to all of it — *an agent cannot judge a PNG; it can judge a
 * number* — so the spec decodes the file and counts, and never compares it to a picture.
 *
 * The frozen dependency list (§12.3) has no image library and adding one is a coordinated change, so
 * this is 60 lines over `node:zlib`. `packages/app/e2e/png.ts` is its sibling on the app side; the
 * two are deliberately separate files rather than a cross-package import between two test trees.
 *
 * Covers exactly what `canvas.toBlob('image/png')` emits: 8-bit, non-interlaced, colour type 2 (RGB)
 * or 6 (RGBA). Anything else throws rather than guessing.
 */

import { inflateSync } from 'node:zlib';

export interface DecodedPng {
  width: number;
  height: number;
  /** RGBA8, row-major, **top-left origin** — §11's convention everywhere. */
  pixels: Uint8Array;
  /** From the `pHYs` chunk, or `null` when the file carries none. */
  dpi: number | null;
}

export function decodePng(bytes: Uint8Array): DecodedPng {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let dpi: number | null = null;
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
    } else if (type === 'pHYs') {
      // Unit specifier 1 is metres; 0 means "aspect ratio only" and carries no physical size.
      dpi = body.readUInt8(8) === 1 ? body.readUInt32BE(0) * 0.0254 : null;
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

  return { width, height, pixels: out, dpi };
}

export function pixelAt(png: DecodedPng, x: number, y: number): [number, number, number, number] {
  const i = (y * png.width + x) * 4;
  return [
    png.pixels[i] ?? 0,
    png.pixels[i + 1] ?? 0,
    png.pixels[i + 2] ?? 0,
    png.pixels[i + 3] ?? 0,
  ];
}

/** How many pixels satisfy `hit`, over the whole image or one rectangle of it. */
export function countPixels(
  png: DecodedPng,
  hit: (r: number, g: number, b: number, a: number) => boolean,
  rect?: { x: number; y: number; width: number; height: number }
): number {
  const x0 = rect?.x ?? 0;
  const y0 = rect?.y ?? 0;
  const x1 = Math.min(png.width, x0 + (rect?.width ?? png.width));
  const y1 = Math.min(png.height, y0 + (rect?.height ?? png.height));
  let n = 0;
  for (let y = Math.max(0, y0); y < y1; y += 1) {
    for (let x = Math.max(0, x0); x < x1; x += 1) {
      const i = (y * png.width + x) * 4;
      if (
        hit(
          png.pixels[i] ?? 0,
          png.pixels[i + 1] ?? 0,
          png.pixels[i + 2] ?? 0,
          png.pixels[i + 3] ?? 0
        )
      ) {
        n += 1;
      }
    }
  }
  return n;
}
