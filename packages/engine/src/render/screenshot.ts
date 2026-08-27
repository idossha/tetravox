/**
 * `Engine.screenshot` (§4.7, §8) — reading the frame back and encoding it as a PNG.
 *
 * **Read back, do not `canvas.toBlob`.** The drawing buffer may be composited (and cleared) between
 * the render and an asynchronous encode, and this is also the path a `target: 'view'` crop takes.
 *
 * **Phase 2 (owners: E-SCENE for the engine half, A-SHELL for the dialog)** — what
 * `ScreenshotOptions` still asks for and this does not do: `target: 'view'` with `viewId` (crop to
 * one pane's `ViewportRect`), `width` / `height` / `scale` (render at a multiple and downsample —
 * note §7.0.4: `blitFramebuffer` cannot resolve **and** rescale in one call, so resolve and SSAA
 * downsample are two steps), `dpi` written into the PNG **pHYs** chunk, `include` (suppressing
 * individual chrome items), and `autoTrim`.
 */

import type { ScreenshotOptions } from '../api';
import type { vec4 } from '../scene/types';

/** Transparent black — the clear colour for `background: 'transparent'`. */
export const TRANSPARENT: vec4 = [0, 0, 0, 0];

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

/** Composite premultiplied-by-alpha over opaque white, in place — `background: 'white'`. */
export function compositeOverWhite(rgba: Uint8ClampedArray): void {
  for (let i = 0; i < rgba.length; i += 4) {
    const a = (rgba[i + 3] ?? 255) / 255;
    for (let k = 0; k < 3; k += 1) {
      rgba[i + k] = Math.round((rgba[i + k] ?? 0) * a + 255 * (1 - a));
    }
    rgba[i + 3] = 255;
  }
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

/** The whole encode half of `screenshot()`: read back, composite if asked, encode. */
export async function encodeFrame(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  opts: ScreenshotOptions
): Promise<Blob> {
  const rgba = readFrame(gl, width, height);
  if (opts.background === 'white') compositeOverWhite(rgba);
  return await encodePng(rgba, width, height);
}
