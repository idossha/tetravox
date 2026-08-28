/**
 * `Engine.screenshot` (§4.7, §8) — reading the frame back and encoding it as a PNG.
 *
 * **Read back, do not `canvas.toBlob`.** The drawing buffer may be composited (and cleared) between
 * the render and an asynchronous encode, and this is also the path a `target: 'view'` crop takes.
 *
 * P2-06 is the whole of `ScreenshotOptions`, and everything except the GL calls themselves is a pure
 * function in this file so §11 can assert it without a context:
 *
 * * {@link screenshotPlan} — `target` / `viewId` / `width` / `height` / `scale` become one drawing
 *   buffer size, one supersample factor and one output size. **§7.0.4 is why the plan exists:**
 *   `blitFramebuffer` cannot resolve **and** rescale in one call, so a screenshot at a size the
 *   canvas is not cannot be a blit — the frame is *rendered* at the size it is wanted at (times the
 *   supersample factor) and the downsample is a separate, CPU-side step ({@link resampleArea}).
 * * {@link screenshotAnnotations} — the `include` toggles, as an §4.5 `Annotations` block. They
 *   suppress chrome **items**, which is the only way a flag can toggle something drawn inside the GL
 *   framebuffer; a DOM overlay would be invisible to this path entirely (§8, §11).
 * * {@link cropRgba} / {@link resampleArea} / {@link autoTrimRgba} — crop, downsample, trim.
 * * {@link withPngDpi} — the **pHYs** chunk. §11: "parse the chunk, do not eyeball the image".
 */

import type { ScreenshotOptions } from '../api';
import type { Annotations, vec4 } from '../scene/types';

/**
 * Transparent black.
 *
 * Kept as the documented clear colour of the `'transparent'` path, but **clearing to it is not how
 * that path works** — see {@link matteOverBlackAndWhite}. The engine's context is created with
 * `alpha: false` (`gl/context.ts`), so the default framebuffer has no alpha channel at all: a clear
 * to `[0,0,0,0]` reads back as opaque black, and every `readPixels` alpha is 255 no matter what was
 * drawn.
 */
export const TRANSPARENT: vec4 = [0, 0, 0, 0];

/** Clear colours for the two `background` modes that are not `'scene'`. */
export const OPAQUE_BLACK: vec4 = [0, 0, 0, 1];
export const OPAQUE_WHITE: vec4 = [1, 1, 1, 1];

/**
 * The largest drawing buffer a screenshot will ask for.
 *
 * `MAX_TEXTURE_SIZE` is 8192 on the golden authority (`docs/TESTING.md`) and larger on ANGLE/Metal
 * `[M2Max]`, and the default framebuffer is bounded by `MAX_VIEWPORT_DIMS`. 8192 is the floor of the
 * two renderer classes this project ships on, so a request past it is scaled down here — where the
 * plan can say so, in {@link ScreenshotPlan.clamped} — rather than becoming an `INVALID_VALUE` at
 * resize time or a silently black frame.
 */
export const MAX_RENDER_DIM = 8192;

/** A rectangle in canvas device pixels, **top-left origin**. */
export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Row-major RGBA8, top-left origin — what every function below passes around. */
export interface Image {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
}

/** How one `screenshot()` call is executed: render this big, crop this, resample to that. */
export interface ScreenshotPlan {
  /** Drawing-buffer size to render the **whole canvas** at. */
  renderWidth: number;
  renderHeight: number;
  /** Final image size, before {@link autoTrimRgba}. */
  outWidth: number;
  outHeight: number;
  /** `scale`, clamped and rounded: the frame is rendered this much larger and averaged down. */
  supersample: number;
  /** True when {@link MAX_RENDER_DIM} forced the render smaller than the output. */
  clamped: boolean;
}

function positiveInt(v: number | undefined): number | undefined {
  if (v === undefined || !Number.isFinite(v) || v <= 0) return undefined;
  return Math.round(v);
}

/**
 * Turn `ScreenshotOptions` into a render size, a supersample factor and an output size.
 *
 * `width` / `height` describe the **output**; `scale` is the factor the output is rendered at and
 * averaged down from (§4.7: "render at a multiple and downsample"). Giving one of `width` / `height`
 * keeps the aspect ratio of the region being captured — the pane for `target: 'view'`, the whole
 * canvas for `target: 'grid'` — so a caller never has to compute the other from a layout it does not
 * own.
 *
 * The render size is the size the **whole canvas** must be for the captured region to come out at
 * `outWidth × outHeight × supersample`: with a 2×2 layout a 1200 px pane needs a 2400 px canvas.
 * That is what makes `target: 'view'` a render at the requested size rather than an upscale of a
 * 384 px pane.
 */
export function screenshotPlan(
  opts: ScreenshotOptions,
  canvas: { width: number; height: number },
  pane: PixelRect | null,
  maxDim: number = MAX_RENDER_DIM
): ScreenshotPlan {
  const canvasW = Math.max(1, Math.round(canvas.width));
  const canvasH = Math.max(1, Math.round(canvas.height));
  const region = opts.target === 'view' && pane !== null ? pane : null;
  const baseW = Math.max(1, Math.round(region?.width ?? canvasW));
  const baseH = Math.max(1, Math.round(region?.height ?? canvasH));

  const wantW = positiveInt(opts.width);
  const wantH = positiveInt(opts.height);
  let outWidth: number;
  let outHeight: number;
  if (wantW !== undefined && wantH !== undefined) {
    outWidth = wantW;
    outHeight = wantH;
  } else if (wantW !== undefined) {
    outWidth = wantW;
    outHeight = Math.max(1, Math.round((wantW * baseH) / baseW));
  } else if (wantH !== undefined) {
    outHeight = wantH;
    outWidth = Math.max(1, Math.round((wantH * baseW) / baseH));
  } else {
    outWidth = baseW;
    outHeight = baseH;
  }

  const supersample = Math.min(4, Math.max(1, Math.round(opts.scale ?? 1) || 1));
  // How much bigger the whole canvas has to be for the captured region to reach the wanted size.
  const fx = (outWidth * supersample) / baseW;
  const fy = (outHeight * supersample) / baseH;
  let renderWidth = Math.max(1, Math.round(canvasW * fx));
  let renderHeight = Math.max(1, Math.round(canvasH * fy));
  let clamped = false;
  const over = Math.max(renderWidth / maxDim, renderHeight / maxDim);
  if (over > 1) {
    clamped = true;
    renderWidth = Math.max(1, Math.floor(renderWidth / over));
    renderHeight = Math.max(1, Math.floor(renderHeight / over));
  }
  return { renderWidth, renderHeight, outWidth, outHeight, supersample, clamped };
}

/**
 * The `include` toggles as an §4.5 `Annotations` block.
 *
 * `conventionBadge` stays `true`: §8 says it "is not optional", and `ScreenshotOptions.include` has
 * no flag for it — a screenshot that could drop the RAD/NEU badge would be a laterality hazard the
 * moment it left the application.
 */
export function screenshotAnnotations(include: ScreenshotOptions['include']): Annotations {
  return {
    orientationLabels: include.orientationLabels,
    cornerInfo: include.cornerInfo,
    conventionBadge: true,
    scaleBar: include.scaleBar,
    colorbars: include.colorbar,
    crosshair: include.crosshair,
  };
}

/**
 * Read the whole default framebuffer back as top-down RGBA8.
 *
 * GL rows run bottom-up and `ImageData` runs top-down, so the flip happens here rather than being
 * rediscovered by every consumer.
 */
export function readFrame(
  gl: WebGL2RenderingContext,
  width: number,
  height: number
): Uint8ClampedArray {
  const px = new Uint8Array(width * height * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const src = (height - 1 - y) * width * 4;
    out.set(px.subarray(src, src + width * 4), y * width * 4);
  }
  return out;
}

/** Crop, clamped to the source — `target: 'view'` (§4.7). An out-of-range ask stays transparent. */
export function cropRgba(src: Image, rect: PixelRect): Image {
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const x0 = Math.round(rect.x);
  const y0 = Math.round(rect.y);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sy = y0 + y;
    if (sy < 0 || sy >= src.height) continue;
    const sx0 = Math.max(0, -x0);
    const sx1 = Math.min(width, src.width - x0);
    if (sx1 <= sx0) continue;
    const from = (sy * src.width + x0 + sx0) * 4;
    rgba.set(src.rgba.subarray(from, from + (sx1 - sx0) * 4), (y * width + sx0) * 4);
  }
  return { rgba, width, height };
}

/**
 * Area-average resample — the SSAA downsample of §4.7's `scale`, and the ±1 px slop of a
 * `target: 'view'` crop, in one operation.
 *
 * Averaging over the source rectangle each destination pixel covers is the correct downsample, and
 * it degenerates to a nearest-neighbour read when the destination is larger — which is what a caller
 * asking for a 12000 px screenshot on a renderer capped at {@link MAX_RENDER_DIM} gets.
 * **Not a box filter over a fixed integer factor**: the crop is a rounded pane rectangle, so the
 * ratio is very often 2.0026 rather than 2.
 */
export function resampleArea(src: Image, dw: number, dh: number): Image {
  const width = Math.max(1, Math.round(dw));
  const height = Math.max(1, Math.round(dh));
  if (width === src.width && height === src.height) return src;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const sxStep = src.width / width;
  const syStep = src.height / height;
  for (let y = 0; y < height; y += 1) {
    const sy0 = Math.min(src.height - 1, Math.floor(y * syStep));
    const sy1 = Math.max(sy0 + 1, Math.min(src.height, Math.ceil((y + 1) * syStep)));
    for (let x = 0; x < width; x += 1) {
      const sx0 = Math.min(src.width - 1, Math.floor(x * sxStep));
      const sx1 = Math.max(sx0 + 1, Math.min(src.width, Math.ceil((x + 1) * sxStep)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy += 1) {
        let o = (sy * src.width + sx0) * 4;
        for (let sx = sx0; sx < sx1; sx += 1) {
          r += src.rgba[o] ?? 0;
          g += src.rgba[o + 1] ?? 0;
          b += src.rgba[o + 2] ?? 0;
          a += src.rgba[o + 3] ?? 0;
          n += 1;
          o += 4;
        }
      }
      const d = (y * width + x) * 4;
      rgba[d] = Math.round(r / n);
      rgba[d + 1] = Math.round(g / n);
      rgba[d + 2] = Math.round(b / n);
      rgba[d + 3] = Math.round(a / n);
    }
  }
  return { rgba, width, height };
}

/**
 * §4.7's `autoTrim`: drop the uniform border.
 *
 * "Uniform" is measured against the **top-left pixel**, not against `Scene.background`: after
 * `background: 'white'` compositing the border is white, after `'transparent'` it is zero and after
 * `'scene'` it is the scene colour — one rule covers all three, and it also trims a pane whose data
 * does not reach the edges. An image that is uniform everywhere is returned unchanged rather than as
 * a 0×0 PNG.
 */
export function autoTrimRgba(src: Image, tol = 0): Image {
  const { rgba, width, height } = src;
  const r0 = rgba[0] ?? 0;
  const g0 = rgba[1] ?? 0;
  const b0 = rgba[2] ?? 0;
  const a0 = rgba[3] ?? 0;
  const differs = (o: number): boolean =>
    Math.abs((rgba[o] ?? 0) - r0) > tol ||
    Math.abs((rgba[o + 1] ?? 0) - g0) > tol ||
    Math.abs((rgba[o + 2] ?? 0) - b0) > tol ||
    Math.abs((rgba[o + 3] ?? 0) - a0) > tol;

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!differs((y * width + x) * 4)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) return src;
  if (minX === 0 && minY === 0 && maxX === width - 1 && maxY === height - 1) return src;
  return cropRgba(src, { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 });
}

/**
 * §4.7's `background: 'transparent'`, recovered from **two renders** of the same frame — one over
 * opaque black, one over opaque white.
 *
 * The engine's WebGL context is created with `alpha: false` (`gl/context.ts`, and that is the right
 * default for a viewer: an alpha-blended canvas composites against the page on every frame). So the
 * drawing buffer has no alpha to read: clearing to `[0,0,0,0]` and reading the result back yields an
 * opaque black PNG, which is what Phase 1 shipped once "transparent" was asked for.
 *
 * The two-render matte is exact rather than a heuristic. Every pass blends with
 * `src·α + dst·(1−α)`, so a pixel whose accumulated coverage is `α` over a background `B` reads back
 * as `F + (1−α)·B` for one premultiplied foreground `F`. With `B = 0` and `B = 1`:
 *
 * ```
 * R_black = F            R_white = F + (1 − α)      ⇒   α = 1 − (R_white − R_black),  C = F / α
 * ```
 *
 * `α` is the mean of the three channels' estimates — they agree up to 8-bit rounding, and averaging
 * is what keeps a 1/255 disagreement from showing as a coloured fringe. The result is **straight**
 * (un-premultiplied) alpha, which is what PNG stores.
 */
export function matteOverBlackAndWhite(black: Image, white: Image): Image {
  const { width, height } = black;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    let alpha = 0;
    for (let c = 0; c < 3; c += 1) {
      const b = (black.rgba[i + c] ?? 0) / 255;
      const w = (white.rgba[i + c] ?? 0) / 255;
      alpha += 1 - (w - b);
    }
    alpha = Math.min(1, Math.max(0, alpha / 3));
    if (alpha <= 0) continue;
    for (let c = 0; c < 3; c += 1) {
      rgba[i + c] = Math.round(Math.min(1, (black.rgba[i + c] ?? 0) / 255 / alpha) * 255);
    }
    rgba[i + 3] = Math.round(alpha * 255);
  }
  return { rgba, width, height };
}

/** Encode top-down RGBA8 as a PNG `Blob` through a 2D canvas. */
export async function encodePng(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  if (ctx === null) throw new Error('2d context unavailable for screenshot encoding');
  const img = ctx.createImageData(width, height);
  img.data.set(rgba);
  ctx.putImageData(img, 0, 0);
  return await new Promise<Blob>((resolve, reject) => {
    c.toBlob(
      (b) => (b !== null ? resolve(b) : reject(new Error('toBlob returned null'))),
      'image/png'
    );
  });
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Pixels per metre for a DPI — the unit a `pHYs` chunk stores. 1 inch = 0.0254 m, exactly. */
export function pixelsPerMetre(dpi: number): number {
  return Math.round(dpi / 0.0254);
}

/**
 * Insert a `pHYs` chunk carrying `dpi` — §4.7's "`dpi` written to the PNG `pHYs` chunk".
 *
 * The encoder is `canvas.toBlob`, which writes no `pHYs`, and the frozen dependency list (§12.3) has
 * no image library. Splicing one 21-byte chunk in after `IHDR` keeps the browser's Deflate;
 * hand-rolling an encoder to add nine bytes of metadata would trade a compressed PNG for a
 * stored-block one.
 *
 * An existing `pHYs` is replaced, so the function is idempotent.
 */
export function withPngDpi(png: Uint8Array, dpi: number): Uint8Array {
  if (!Number.isFinite(dpi) || dpi <= 0) return png;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (png[i] !== PNG_SIGNATURE[i]) throw new Error('not a PNG: bad signature');
  }
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);

  const phys = new Uint8Array(21);
  const pv = new DataView(phys.buffer);
  pv.setUint32(0, 9);
  phys.set([0x70, 0x48, 0x59, 0x73], 4); // 'pHYs'
  const perMetre = pixelsPerMetre(dpi);
  pv.setUint32(8, perMetre);
  pv.setUint32(12, perMetre);
  phys[16] = 1; // unit specifier: metre
  pv.setUint32(17, crc32(phys.subarray(4, 17)));

  // Walk the chunk list: insert after IHDR, and drop any pHYs already there.
  let at = 8;
  let insertAt = -1;
  const drop: { start: number; end: number }[] = [];
  while (at + 8 <= png.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(
      png[at + 4] ?? 0,
      png[at + 5] ?? 0,
      png[at + 6] ?? 0,
      png[at + 7] ?? 0
    );
    const end = at + 12 + len;
    if (type === 'IHDR') insertAt = end;
    if (type === 'pHYs') drop.push({ start: at, end });
    if (type === 'IEND') break;
    at = end;
  }
  if (insertAt < 0) throw new Error('not a PNG: no IHDR');

  const parts: Uint8Array[] = [];
  let cursor = 0;
  for (const d of [...drop].sort((a, b) => a.start - b.start)) {
    parts.push(png.subarray(cursor, d.start));
    cursor = d.end;
  }
  parts.push(png.subarray(cursor));
  // IHDR always precedes any pHYs, so removing them cannot have moved `insertAt`.
  const withoutPhys = concat(parts);
  return concat([withoutPhys.subarray(0, insertAt), phys, withoutPhys.subarray(insertAt)]);
}

/** The `pHYs` DPI of a PNG, or `null` when it carries none — the reader half of {@link withPngDpi}. */
export function pngDpi(png: Uint8Array): number | null {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let at = 8;
  while (at + 8 <= png.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(
      png[at + 4] ?? 0,
      png[at + 5] ?? 0,
      png[at + 6] ?? 0,
      png[at + 7] ?? 0
    );
    if (type === 'pHYs') {
      if ((png[at + 16] ?? 0) !== 1) return null; // unit specifier != metre: no physical DPI
      return view.getUint32(at + 8) * 0.0254;
    }
    if (type === 'IEND') break;
    at += 12 + len;
  }
  return null;
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

/**
 * Crop, downsample, trim — the geometry half of `screenshot()`, in the one order that is correct.
 *
 * Cropping first keeps the resample from averaging a neighbouring pane's pixels into the border, and
 * `autoTrim` runs **last**, on the pixels the file will hold: a trim of the supersampled frame would
 * then be scaled by a non-integer factor and lose the very edge it just found.
 */
export function composeScreenshot(
  image: Image,
  opts: ScreenshotOptions,
  plan?: ScreenshotPlan,
  crop?: PixelRect
): Image {
  let out = image;
  if (crop !== undefined) out = cropRgba(out, crop);
  if (plan !== undefined) out = resampleArea(out, plan.outWidth, plan.outHeight);
  if (opts.autoTrim) out = autoTrimRgba(out);
  return out;
}

/** Encode a finished image, stamping `opts.dpi` into the `pHYs` chunk when one was asked for. */
export async function encodeImage(image: Image, opts: ScreenshotOptions): Promise<Blob> {
  const blob = await encodePng(image.rgba, image.width, image.height);
  if (opts.dpi === undefined) return blob;
  const stamped = withPngDpi(new Uint8Array(await blob.arrayBuffer()), opts.dpi);
  return new Blob([stamped.buffer as ArrayBuffer], { type: 'image/png' });
}

/** Read the default framebuffer back as an {@link Image}. */
export function frameImage(gl: WebGL2RenderingContext, width: number, height: number): Image {
  return { rgba: readFrame(gl, width, height), width, height };
}
