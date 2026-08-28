/**
 * The pure-JS GIF encoder (`main/gif.ts`).
 *
 * §11's rule — a picture is judged by numbers — applies to a written *file* just as much as to a
 * rendered frame: these tests read the bytes back. The GIF is decoded by a small reader written here,
 * deliberately not shared with the encoder, so a round trip is two independent implementations
 * agreeing rather than one agreeing with itself (`docs/TESTING.md` §4).
 */

import { describe, expect, it } from 'vitest';
import { encodeGif, lzwEncode, quantize } from './gif';
import type { GifFrame } from './gif';

// ------------------------------------------------------------------------------------------------
// A minimal GIF reader: header, global colour table, and LZW-decoded frames.
// ------------------------------------------------------------------------------------------------

interface ReadGif {
  width: number;
  height: number;
  palette: Uint8Array;
  loop: number | null;
  frames: { delay: number; indices: Uint8Array }[];
}

function readGif(bytes: Uint8Array): ReadGif {
  const ascii = String.fromCharCode(...bytes.subarray(0, 6));
  if (ascii !== 'GIF89a') throw new Error(`not a GIF89a: ${ascii}`);
  const u16 = (at: number): number => (bytes[at] as number) | ((bytes[at + 1] as number) << 8);
  const width = u16(6);
  const height = u16(8);
  const packed = bytes[10] as number;
  if ((packed & 0x80) === 0) throw new Error('no global colour table');
  const tableSize = 1 << ((packed & 0x07) + 1);
  const palette = bytes.slice(13, 13 + tableSize * 3);

  let at = 13 + tableSize * 3;
  let loop: number | null = null;
  let delay = 0;
  const frames: { delay: number; indices: Uint8Array }[] = [];

  const readBlocks = (): Uint8Array => {
    const parts: Uint8Array[] = [];
    for (;;) {
      const size = bytes[at] as number;
      at += 1;
      if (size === 0) break;
      parts.push(bytes.subarray(at, at + size));
      at += size;
    }
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let cursor = 0;
    for (const part of parts) {
      out.set(part, cursor);
      cursor += part.length;
    }
    return out;
  };

  while (at < bytes.length) {
    const marker = bytes[at] as number;
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      const label = bytes[at + 1] as number;
      at += 2;
      if (label === 0xf9) {
        at += 1; // block size
        delay = u16(at + 1);
        at += 4;
        at += 1; // terminator
      } else if (label === 0xff) {
        at += 1 + 11; // block size + NETSCAPE2.0
        at += 1; // sub-block size (3)
        at += 1; // sub-block id (1)
        loop = u16(at);
        at += 2;
        at += 1; // terminator
      } else {
        at += 1;
        readBlocks();
      }
      continue;
    }
    if (marker !== 0x2c) throw new Error(`unexpected marker 0x${marker.toString(16)} at ${at}`);
    const frameW = u16(at + 5);
    const frameH = u16(at + 7);
    at += 10;
    const minCodeSize = bytes[at] as number;
    at += 1;
    frames.push({ delay, indices: lzwDecode(readBlocks(), minCodeSize, frameW * frameH) });
  }
  return { width, height, palette, loop, frames };
}

function lzwDecode(data: Uint8Array, minCodeSize: number, pixels: number): Uint8Array {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const out = new Uint8Array(pixels);
  let written = 0;
  let dictionary: number[][] = [];
  const reset = (): void => {
    dictionary = [];
    for (let i = 0; i < clear; i += 1) dictionary.push([i]);
    dictionary.push([], []);
  };
  reset();
  let codeWidth = minCodeSize + 1;
  let previous: number[] | null = null;
  let bitBuffer = 0;
  let bitCount = 0;
  for (let at = 0; at <= data.length;) {
    while (bitCount < codeWidth && at < data.length) {
      bitBuffer |= (data[at] as number) << bitCount;
      bitCount += 8;
      at += 1;
    }
    if (bitCount < codeWidth) break;
    const code = bitBuffer & ((1 << codeWidth) - 1);
    bitBuffer >>>= codeWidth;
    bitCount -= codeWidth;
    if (code === clear) {
      reset();
      codeWidth = minCodeSize + 1;
      previous = null;
      continue;
    }
    if (code === end) break;
    let entry: number[];
    if (code < dictionary.length && (dictionary[code] as number[]).length > 0) {
      entry = dictionary[code] as number[];
    } else if (previous !== null) {
      entry = [...previous, previous[0] as number];
    } else {
      throw new Error(`bad LZW code ${code}`);
    }
    for (const value of entry) {
      if (written < out.length) out[written++] = value;
    }
    if (previous !== null) {
      dictionary.push([...previous, entry[0] as number]);
      if (dictionary.length === 1 << codeWidth && codeWidth < 12) codeWidth += 1;
    }
    previous = entry;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------

/** A frame of flat colour. */
function solid(width: number, height: number, rgb: [number, number, number]): GifFrame {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    pixels[i * 4] = rgb[0];
    pixels[i * 4 + 1] = rgb[1];
    pixels[i * 4 + 2] = rgb[2];
    pixels[i * 4 + 3] = 255;
  }
  return { pixels, width, height };
}

/** Left half one colour, right half another — a frame with structure to check position with. */
function split(width: number, height: number, left: number, right: number): GifFrame {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const v = x < width / 2 ? left : right;
      const at = (y * width + x) * 4;
      pixels[at] = v;
      pixels[at + 1] = v;
      pixels[at + 2] = v;
      pixels[at + 3] = 255;
    }
  }
  return { pixels, width, height };
}

describe('encodeGif', () => {
  it('writes a GIF89a whose header carries the frame size', () => {
    const gif = readGif(encodeGif([solid(8, 5, [255, 0, 0])]));
    expect([gif.width, gif.height]).toEqual([8, 5]);
    expect(gif.frames).toHaveLength(1);
  });

  it('round-trips a flat colour exactly', () => {
    const gif = readGif(encodeGif([solid(6, 6, [12, 200, 34])]));
    const index = gif.frames[0]?.indices[0] as number;
    const rgb = [...gif.palette.subarray(index * 3, index * 3 + 3)];
    // The 5-5-5 histogram quantises to a 32-level grid, so an exact colour comes back within a step
    // of 255/31 = 8.2 — and a *flat* frame has one occupied cell, so it comes back exact.
    expect(rgb).toEqual([12, 200, 34]);
  });

  it('keeps every pixel in its place', () => {
    const frame = split(10, 4, 20, 220);
    const gif = readGif(encodeGif([frame]));
    const indices = gif.frames[0]?.indices as Uint8Array;
    expect(indices).toHaveLength(40);
    const value = (i: number): number => gif.palette[(indices[i] as number) * 3] as number;
    expect(value(0)).toBe(20);
    expect(value(4)).toBe(20);
    expect(value(5)).toBe(220);
    expect(value(9)).toBe(220);
    // Second row, same pattern: the row stride survived the LZW.
    expect(value(10)).toBe(20);
    expect(value(19)).toBe(220);
  });

  it('writes one frame per input, in order, and loops forever by default', () => {
    const gif = readGif(
      encodeGif([solid(4, 4, [0, 0, 0]), solid(4, 4, [255, 255, 255]), solid(4, 4, [0, 0, 0])])
    );
    expect(gif.frames).toHaveLength(3);
    expect(gif.loop).toBe(0);
    const grey = (f: number): number =>
      gif.palette[(gif.frames[f]?.indices[0] as number) * 3] as number;
    expect(grey(0)).toBe(0);
    expect(grey(1)).toBe(255);
    expect(grey(2)).toBe(0);
  });

  it('turns fps into the GIF delay unit — hundredths of a second', () => {
    expect(readGif(encodeGif([solid(2, 2, [1, 1, 1])], { fps: 10 })).frames[0]?.delay).toBe(10);
    expect(readGif(encodeGif([solid(2, 2, [1, 1, 1])], { fps: 25 })).frames[0]?.delay).toBe(4);
    // Below 50 fps the unit runs out: 2/100 s is the smallest delay every decoder honours.
    expect(readGif(encodeGif([solid(2, 2, [1, 1, 1])], { fps: 120 })).frames[0]?.delay).toBe(2);
  });

  it('shares ONE palette across frames, which is what stops an animation shimmering', () => {
    const gif = readGif(encodeGif([solid(4, 4, [255, 0, 0]), solid(4, 4, [0, 0, 255])]));
    const colourOf = (f: number): number[] => {
      const i = gif.frames[f]?.indices[0] as number;
      return [...gif.palette.subarray(i * 3, i * 3 + 3)];
    };
    // Both colours are in the one global table, and they are different entries.
    expect(colourOf(0)).toEqual([255, 0, 0]);
    expect(colourOf(1)).toEqual([0, 0, 255]);
    expect(gif.frames[0]?.indices[0]).not.toBe(gif.frames[1]?.indices[0]);
  });

  it('survives a frame big enough to need multiple 255-byte sub-blocks', () => {
    // 400x300 of noise compresses to well over 255 bytes, which is what the sub-block loop is for —
    // and, as `number[].push(...bytes)`, is what used to blow the call stack.
    const width = 400;
    const height = 300;
    const pixels = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i += 1) {
      const v = (i * 7919) % 256;
      pixels[i * 4] = v;
      pixels[i * 4 + 1] = (v * 3) % 256;
      pixels[i * 4 + 2] = 255 - v;
      pixels[i * 4 + 3] = 255;
    }
    const gif = readGif(encodeGif([{ pixels, width, height }]));
    expect(gif.frames[0]?.indices).toHaveLength(width * height);
  });

  it('refuses frames of different sizes rather than writing a broken file', () => {
    expect(() => encodeGif([solid(4, 4, [0, 0, 0]), solid(5, 4, [0, 0, 0])])).toThrow(/5x4/);
    expect(() => encodeGif([])).toThrow(/at least one frame/);
  });
});

describe('quantize', () => {
  it('gives every distinct colour its own entry when there is room', () => {
    const frames = [solid(2, 2, [255, 0, 0]), solid(2, 2, [0, 255, 0]), solid(2, 2, [0, 0, 255])];
    const palette = quantize(frames, 16);
    const entries = new Set<string>();
    for (let i = 0; i < 16; i += 1) {
      entries.add([...palette.subarray(i * 3, i * 3 + 3)].join(','));
    }
    expect(entries.has('255,0,0')).toBe(true);
    expect(entries.has('0,255,0')).toBe(true);
    expect(entries.has('0,0,255')).toBe(true);
  });

  it('spends its entries on the colours that cover the most pixels', () => {
    // 99 % mid-grey with a single bright pixel: a 2-colour palette must keep the grey.
    const width = 100;
    const frame = solid(width, 1, [128, 128, 128]);
    frame.pixels[0] = 255;
    frame.pixels[1] = 255;
    frame.pixels[2] = 255;
    const palette = quantize([frame], 2);
    expect(palette[0]).toBeGreaterThan(120);
    expect(palette[0]).toBeLessThan(136);
  });
});

describe('lzwEncode', () => {
  it('starts with a clear code and ends with an end-of-information code', () => {
    // minCodeSize 2 → clear = 4, end = 5, first code width 3 bits.
    const encoded = lzwEncode(Uint8Array.from([1, 1, 1, 1]), 2);
    const first = (encoded[0] as number) & 0x07;
    expect(first).toBe(4);
    expect(encoded.length).toBeGreaterThan(1);
  });
});
