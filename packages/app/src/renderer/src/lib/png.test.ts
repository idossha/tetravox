/**
 * `readPngInfo` — §11's "parse the chunk, do not eyeball the image", against the encoder beside it.
 *
 * The encoder and the reader in `lib/png.ts` are independent halves: `encodePng` computes
 * pixels-per-metre from a DPI and `readPngInfo` computes a DPI back from pixels-per-metre, so a
 * round trip through both is a real assertion about the `pHYs` chunk and not about one function
 * agreeing with itself.
 */

import { describe, expect, it } from 'vitest';
import { encodePng, readPngInfo } from './png';

function png(dpi?: number, width = 4, height = 3): Uint8Array {
  return encodePng({
    width,
    height,
    pixels: new Uint8Array(width * height * 4),
    ...(dpi === undefined ? {} : { dpi }),
  });
}

describe('readPngInfo', () => {
  it('reads IHDR: size, bit depth and colour type', () => {
    const info = readPngInfo(png(undefined, 7, 5));
    expect(info).not.toBeNull();
    expect(info?.width).toBe(7);
    expect(info?.height).toBe(5);
    expect(info?.bitDepth).toBe(8);
    expect(info?.colorType).toBe(6); // RGBA
  });

  it('reads the requested DPI back out of the pHYs chunk', () => {
    // 144 dpi → round(144 / 0.0254) = 5669 px/m → round(5669 * 0.0254) = 144.
    const info = readPngInfo(png(144));
    expect(info?.dpi).toBe(144);
    expect(info?.physical).toEqual({ xPerUnit: 5669, yPerUnit: 5669, unit: 1 });
  });

  it('round-trips every DPI the dialog offers', () => {
    for (const dpi of [72, 96, 144, 150, 300, 600]) {
      expect(readPngInfo(png(dpi))?.dpi).toBe(dpi);
    }
  });

  it('reports no DPI when the file carries no pHYs, rather than inventing one', () => {
    const info = readPngInfo(png());
    expect(info).not.toBeNull();
    expect(info?.dpi).toBeUndefined();
    expect(info?.physical).toBeUndefined();
  });

  it('rejects anything that is not a PNG', () => {
    expect(readPngInfo(new Uint8Array(4))).toBeNull();
    expect(readPngInfo(new Uint8Array(64))).toBeNull();
    const jpeg = new Uint8Array(64);
    jpeg.set([0xff, 0xd8, 0xff, 0xe0]);
    expect(readPngInfo(jpeg)).toBeNull();
  });

  it('stops at a truncated chunk instead of walking past the buffer', () => {
    const full = png(300);
    // Cut inside the IDAT chunk: IHDR and pHYs are already read, the rest is not guessed at.
    const truncated = full.subarray(0, full.length - 20);
    const info = readPngInfo(truncated);
    expect(info?.width).toBe(4);
    expect(info?.dpi).toBe(300);
  });

  it('ignores a pHYs whose unit is "aspect ratio only", which carries no DPI at all', () => {
    const bytes = png(96);
    // The pHYs body is the 9 bytes after its 8-byte header; byte 8 of the body is the unit.
    const at = bytes.indexOf(0x70); // 'p' of pHYs — the first one, in the chunk type
    const unitAt = at + 4 + 8;
    expect(bytes[unitAt]).toBe(1);
    const copy = Uint8Array.from(bytes);
    copy[unitAt] = 0;
    const info = readPngInfo(copy);
    expect(info?.dpi).toBeUndefined();
    expect(info?.physical?.unit).toBe(0);
  });
});
