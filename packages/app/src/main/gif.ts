/**
 * A pure-JS **GIF89a encoder**, so a `sweep` or an `orbit` always produces an animation.
 *
 * The plan makes MP4 conditional on ffmpeg being on PATH and the GIF unconditional, which means the
 * animation path cannot depend on anything outside the process. §12.3 freezes the dependency list, so
 * this is written rather than installed — the same reasoning that produced the hand-written PNG
 * encoder in `renderer/src/lib/png.ts` and the reader in `e2e/png.ts`.
 *
 * Three pieces, in the order the bytes come out:
 *
 * 1. **One palette for the whole animation** ({@link quantize}), built by a median cut over the
 *    5-5-5 colour histogram of every frame. A per-frame palette would be smaller per frame and would
 *    make the animation shimmer, because two consecutive slices of the same brain would be quantised
 *    to two different greys. One global table also lets every frame after the first be a plain
 *    indexed image with no local colour table.
 * 2. **Nearest-colour mapping**, exact (not dithered): dithering a medical image invents texture that
 *    is not in the data, and §11's rule about judging pictures by numbers cuts against noise a test
 *    would then have to tolerate.
 * 3. **LZW**, variable code width, with the clear code emitted at the start and whenever the table
 *    fills at 4095 entries — the encoder GIF89a specifies, no early-change tricks.
 *
 * Frame delays are in hundredths of a second, which is the GIF unit; an fps that does not divide 100
 * is rounded there and nowhere else, so a 24 fps sweep is honestly a 25 fps GIF rather than silently
 * a different length.
 */

export interface GifFrame {
  /** RGBA8, row-major, top-left origin, `width * height * 4` bytes. Alpha is ignored. */
  pixels: Uint8Array;
  width: number;
  height: number;
}

export interface GifOptions {
  /** Frames per second. Converted to the GIF's hundredths-of-a-second delay. */
  fps?: number;
  /** 0 = forever (the default), n = play n times. */
  loop?: number;
  /** Palette size, 2..256. Fewer colours is a smaller file and visible banding. */
  colors?: number;
}

// ------------------------------------------------------------------------------------------------
// Palette
// ------------------------------------------------------------------------------------------------

interface Box {
  /** Indices into the 32768-entry 5-5-5 histogram. */
  cells: number[];
  count: number;
}

const BITS = 5;
const LEVELS = 1 << BITS; // 32
const CELLS = LEVELS * LEVELS * LEVELS;

function cellOf(r: number, g: number, b: number): number {
  return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
}

/**
 * A global palette by median cut over the 5-5-5 histogram.
 *
 * The histogram is what keeps this linear in pixels rather than in colours: a 1400×900 frame has
 * 1.26 M pixels and at most 32768 occupied cells, so the cut operates on the cells and the pixel loop
 * runs once per frame. Boxes are split on the channel with the widest occupied range, at the weighted
 * median, and the box holding the most pixels is always split next — so a frame that is 90 % dark
 * background does not spend half the palette on it.
 */
export function quantize(frames: readonly GifFrame[], colors: number): Uint8Array {
  const wanted = Math.max(2, Math.min(256, colors));
  const histogram = new Uint32Array(CELLS);
  // The **true** colour sums per cell, not the cell's centre. A palette entry reconstructed from the
  // 5-5-5 grid is up to 4 counts off per channel, so a frame of one flat colour came back as a
  // slightly different flat colour — visible as a seam wherever a GIF frame met a PNG of the same
  // capture, and a needless loss on the many frames whose colours are already few.
  const sums = new Float64Array(CELLS * 3);
  for (const frame of frames) {
    const { pixels } = frame;
    for (let i = 0; i + 3 < pixels.length; i += 4) {
      const r = pixels[i] as number;
      const g = pixels[i + 1] as number;
      const b = pixels[i + 2] as number;
      const cell = cellOf(r, g, b);
      histogram[cell] = (histogram[cell] as number) + 1;
      sums[cell * 3] = (sums[cell * 3] as number) + r;
      sums[cell * 3 + 1] = (sums[cell * 3 + 1] as number) + g;
      sums[cell * 3 + 2] = (sums[cell * 3 + 2] as number) + b;
    }
  }

  const occupied: number[] = [];
  let total = 0;
  for (let cell = 0; cell < CELLS; cell += 1) {
    const n = histogram[cell] as number;
    if (n > 0) {
      occupied.push(cell);
      total += n;
    }
  }
  if (occupied.length === 0) return new Uint8Array(wanted * 3);

  let boxes: Box[] = [{ cells: occupied, count: total }];
  while (boxes.length < wanted) {
    // Split the heaviest box that still has more than one colour in it.
    let at = -1;
    let best = 0;
    for (const [i, box] of boxes.entries()) {
      if (box.cells.length > 1 && box.count > best) {
        best = box.count;
        at = i;
      }
    }
    if (at === -1) break;
    const box = boxes[at] as Box;
    const split = splitBox(box, histogram);
    if (split === null) {
      // Nothing to split on: mark it done by pinning it to a single cell list we will not revisit.
      boxes = [
        ...boxes.slice(0, at),
        { ...box, cells: [box.cells[0] as number] },
        ...boxes.slice(at + 1),
      ];
      continue;
    }
    boxes = [...boxes.slice(0, at), split[0], split[1], ...boxes.slice(at + 1)];
  }

  const palette = new Uint8Array(wanted * 3);
  for (const [i, box] of boxes.entries()) {
    if (i >= wanted) break;
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (const cell of box.cells) {
      r += sums[cell * 3] as number;
      g += sums[cell * 3 + 1] as number;
      b += sums[cell * 3 + 2] as number;
      n += histogram[cell] as number;
    }
    if (n === 0) continue;
    palette[i * 3] = Math.round(r / n);
    palette[i * 3 + 1] = Math.round(g / n);
    palette[i * 3 + 2] = Math.round(b / n);
  }
  return palette;
}

function splitBox(box: Box, histogram: Uint32Array): [Box, Box] | null {
  const shifts = [10, 5, 0];
  let axis = -1;
  let widest = -1;
  for (const [i, shift] of shifts.entries()) {
    let lo = LEVELS;
    let hi = -1;
    for (const cell of box.cells) {
      const v = (cell >> shift) & (LEVELS - 1);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (hi - lo > widest) {
      widest = hi - lo;
      axis = i;
    }
  }
  if (axis === -1 || widest <= 0) return null;
  const shift = shifts[axis] as number;
  const sorted = [...box.cells].sort(
    (a, b) => ((a >> shift) & (LEVELS - 1)) - ((b >> shift) & (LEVELS - 1))
  );
  const half = box.count / 2;
  let running = 0;
  let cut = 0;
  for (let i = 0; i < sorted.length - 1; i += 1) {
    running += histogram[sorted[i] as number] as number;
    cut = i + 1;
    if (running >= half) break;
  }
  const left = sorted.slice(0, cut);
  const right = sorted.slice(cut);
  if (left.length === 0 || right.length === 0) return null;
  const weigh = (cells: number[]): number =>
    cells.reduce((sum, cell) => sum + (histogram[cell] as number), 0);
  return [
    { cells: left, count: weigh(left) },
    { cells: right, count: weigh(right) },
  ];
}

/** Nearest palette entry per pixel, cached on the 5-5-5 cell so the search runs once per colour. */
export function mapToPalette(frame: GifFrame, palette: Uint8Array, cache: Int16Array): Uint8Array {
  const n = frame.width * frame.height;
  const out = new Uint8Array(n);
  const entries = palette.length / 3;
  for (let p = 0; p < n; p += 1) {
    const src = p * 4;
    const r = frame.pixels[src] as number;
    const g = frame.pixels[src + 1] as number;
    const b = frame.pixels[src + 2] as number;
    const cell = cellOf(r, g, b);
    const cached = cache[cell] as number;
    if (cached >= 0) {
      out[p] = cached;
      continue;
    }
    let best = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < entries; i += 1) {
      const dr = r - (palette[i * 3] as number);
      const dg = g - (palette[i * 3 + 1] as number);
      const db = b - (palette[i * 3 + 2] as number);
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
        if (dist === 0) break;
      }
    }
    cache[cell] = best;
    out[p] = best;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// LZW
// ------------------------------------------------------------------------------------------------

/** GIF's variable-width LZW. `minCodeSize` is the palette's bit depth, at least 2. */
export function lzwEncode(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const out: number[] = [];
  let bitBuffer = 0;
  let bitCount = 0;

  const emit = (code: number, width: number): void => {
    bitBuffer |= code << bitCount;
    bitCount += width;
    while (bitCount >= 8) {
      out.push(bitBuffer & 0xff);
      bitBuffer >>>= 8;
      bitCount -= 8;
    }
  };

  let codeWidth = minCodeSize + 1;
  let next = end + 1;
  let table = new Map<string, number>();
  emit(clear, codeWidth);

  let prefix = String(indices[0] ?? 0);
  for (let i = 1; i < indices.length; i += 1) {
    const k = indices[i] as number;
    const candidate = `${prefix},${k}`;
    const found = table.get(candidate);
    if (found !== undefined) {
      prefix = candidate;
      continue;
    }
    emit(codeOf(prefix, table, end), codeWidth);
    if (next < 4096) {
      table.set(candidate, next);
      next += 1;
      if (next > 1 << codeWidth && codeWidth < 12) codeWidth += 1;
    } else {
      emit(clear, codeWidth);
      table = new Map();
      next = end + 1;
      codeWidth = minCodeSize + 1;
    }
    prefix = String(k);
  }
  if (indices.length > 0) emit(codeOf(prefix, table, end), codeWidth);
  emit(end, codeWidth);
  if (bitCount > 0) out.push(bitBuffer & 0xff);
  return Uint8Array.from(out);
}

/** A single-symbol prefix is its own index; anything longer is in the table. */
function codeOf(prefix: string, table: Map<string, number>, end: number): number {
  const found = table.get(prefix);
  if (found !== undefined) return found;
  const single = Number(prefix);
  return Number.isFinite(single) ? single : end;
}

// ------------------------------------------------------------------------------------------------
// The file
// ------------------------------------------------------------------------------------------------

/**
 * A growable byte sink.
 *
 * Written rather than reached for because the obvious `number[]` + `push(...bytes)` blows the call
 * stack: an LZW-compressed 1400×900 frame is ~300 kB, and spreading that into `Array.prototype.push`
 * is 300,000 arguments. This was a real crash, not a hypothetical one.
 */
class Bytes {
  private buffer = new Uint8Array(1 << 16);
  private length = 0;

  private grow(need: number): void {
    if (this.length + need <= this.buffer.length) return;
    let size = this.buffer.length;
    while (size < this.length + need) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
  }

  u8(...values: number[]): void {
    this.grow(values.length);
    for (const value of values) {
      this.buffer[this.length] = value & 0xff;
      this.length += 1;
    }
  }

  /** Little-endian u16, which is every multi-byte field in a GIF. */
  u16(value: number): void {
    this.u8(value & 0xff, (value >> 8) & 0xff);
  }

  raw(data: Uint8Array): void {
    this.grow(data.length);
    this.buffer.set(data, this.length);
    this.length += data.length;
  }

  ascii(text: string): void {
    for (const ch of text) this.u8(ch.charCodeAt(0));
  }

  /** GIF sub-blocks: at most 255 bytes each, terminated by a zero-length block. */
  blocks(data: Uint8Array): void {
    for (let at = 0; at < data.length; at += 255) {
      const slice = data.subarray(at, Math.min(at + 255, data.length));
      this.u8(slice.length);
      this.raw(slice);
    }
    this.u8(0);
  }

  done(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

export function encodeGif(frames: readonly GifFrame[], options: GifOptions = {}): Uint8Array {
  if (frames.length === 0) throw new Error('a GIF needs at least one frame');
  const first = frames[0] as GifFrame;
  const width = first.width;
  const height = first.height;
  for (const frame of frames) {
    if (frame.width !== width || frame.height !== height) {
      throw new Error(`frame size ${frame.width}x${frame.height} != ${width}x${height}`);
    }
    if (frame.pixels.length !== frame.width * frame.height * 4) {
      throw new Error('frame is not width * height * 4 RGBA bytes');
    }
  }

  const colors = Math.max(2, Math.min(256, options.colors ?? 256));
  // The colour table's size is a power of two; `minCodeSize` is its exponent, floored at 2.
  const depth = Math.max(2, Math.ceil(Math.log2(colors)));
  const tableSize = 1 << depth;
  const palette = quantize(frames, tableSize);

  const fps = options.fps !== undefined && options.fps > 0 ? options.fps : 10;
  const delay = Math.max(2, Math.round(100 / fps));
  const loop = options.loop ?? 0;

  const bytes = new Bytes();
  // Header + logical screen descriptor, with a global colour table.
  bytes.ascii('GIF89a');
  bytes.u16(width);
  bytes.u16(height);
  bytes.u8(0x80 | (depth - 1), 0, 0); // global table, 8-bit colour resolution, no sort
  const table = new Uint8Array(tableSize * 3);
  table.set(palette.subarray(0, Math.min(palette.length, table.length)));
  bytes.raw(table);

  // NETSCAPE2.0 looping extension.
  bytes.u8(0x21, 0xff, 0x0b);
  bytes.ascii('NETSCAPE2.0');
  bytes.u8(0x03, 0x01);
  bytes.u16(loop);
  bytes.u8(0x00);

  const cache = new Int16Array(CELLS).fill(-1);
  for (const frame of frames) {
    // Graphic control extension: the delay, no transparency, leave the frame in place.
    bytes.u8(0x21, 0xf9, 0x04, 0x00);
    bytes.u16(delay);
    bytes.u8(0x00, 0x00);
    // Image descriptor: full frame, no local table, not interlaced.
    bytes.u8(0x2c);
    bytes.u16(0);
    bytes.u16(0);
    bytes.u16(width);
    bytes.u16(height);
    bytes.u8(0x00);
    const indices = mapToPalette(frame, palette, cache);
    bytes.u8(depth);
    bytes.blocks(lzwEncode(indices, depth));
  }
  bytes.u8(0x3b); // trailer
  return bytes.done();
}
