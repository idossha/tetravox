/**
 * P2-06's pure half: the plan, the `include` mapping, crop / resample / trim, and the `pHYs` chunk.
 *
 * §11 rule 0 — *an agent cannot judge a PNG; it can judge a number.* Every expectation here is
 * arithmetic done in the test rather than a value copied out of a run, and the `pHYs` assertions
 * parse the chunk byte by byte (§11: "parse the chunk, do not eyeball the image").
 */

import { describe, expect, it } from 'vitest';
import {
  autoTrimRgba,
  cropRgba,
  matteOverBlackAndWhite,
  MAX_RENDER_DIM,
  pixelsPerMetre,
  pngDpi,
  resampleArea,
  screenshotAnnotations,
  screenshotPlan,
  withPngDpi,
} from './screenshot';
import type { Image } from './screenshot';
import type { ScreenshotOptions } from '../api';

const INCLUDE_ALL: ScreenshotOptions['include'] = {
  colorbar: true,
  orientationLabels: true,
  crosshair: true,
  cornerInfo: true,
  scaleBar: true,
};

function opts(patch: Partial<ScreenshotOptions> = {}): ScreenshotOptions {
  return {
    target: 'grid',
    background: 'scene',
    include: INCLUDE_ALL,
    autoTrim: false,
    ...patch,
  };
}

/** A `w × h` image whose pixel `(x, y)` is `[x, y, 0, 255]` — every pixel names its own position. */
function ramp(w: number, h: number): Image {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      rgba[o] = x;
      rgba[o + 1] = y;
      rgba[o + 2] = 0;
      rgba[o + 3] = 255;
    }
  }
  return { rgba, width: w, height: h };
}

const at = (img: Image, x: number, y: number): number[] => [
  img.rgba[(y * img.width + x) * 4] ?? 0,
  img.rgba[(y * img.width + x) * 4 + 1] ?? 0,
  img.rgba[(y * img.width + x) * 4 + 2] ?? 0,
  img.rgba[(y * img.width + x) * 4 + 3] ?? 0,
];

const CANVAS = { width: 768, height: 768 };
/** The axial pane of the 2×2 layout at that canvas size. */
const PANE = { x: 0, y: 0, width: 384, height: 384 };

describe('screenshotPlan (§4.7 target / width / height / scale)', () => {
  it('defaults to the canvas, one to one', () => {
    const p = screenshotPlan(opts(), CANVAS, null);
    expect(p).toMatchObject({
      renderWidth: 768,
      renderHeight: 768,
      outWidth: 768,
      outHeight: 768,
      supersample: 1,
      clamped: false,
    });
  });

  it('a width alone keeps the captured region’s aspect ratio', () => {
    const p = screenshotPlan(opts({ width: 1536 }), { width: 800, height: 400 }, null);
    // 800x400 is 2:1, so a 1536-wide grid shot is 768 tall.
    expect([p.outWidth, p.outHeight]).toEqual([1536, 768]);
    expect([p.renderWidth, p.renderHeight]).toEqual([1536, 768]);
  });

  it('a height alone does the same the other way round', () => {
    const p = screenshotPlan(opts({ height: 200 }), { width: 800, height: 400 }, null);
    expect([p.outWidth, p.outHeight]).toEqual([400, 200]);
  });

  it('target:"view" renders the WHOLE canvas big enough for the pane to reach the asked size', () => {
    // The pane is a quarter of the canvas, so a 1200 px pane needs a 2400 px canvas.
    const p = screenshotPlan(opts({ target: 'view', viewId: 'axial', width: 1200 }), CANVAS, PANE);
    expect([p.outWidth, p.outHeight]).toEqual([1200, 1200]);
    expect([p.renderWidth, p.renderHeight]).toEqual([2400, 2400]);
  });

  it('scale is a supersample factor, clamped to 1..4 and applied on top of the output size', () => {
    const p = screenshotPlan(opts({ width: 400, height: 300, scale: 2 }), CANVAS, null);
    expect(p.supersample).toBe(2);
    expect([p.outWidth, p.outHeight]).toEqual([400, 300]);
    expect([p.renderWidth, p.renderHeight]).toEqual([800, 600]);
    expect(screenshotPlan(opts({ scale: 9 }), CANVAS, null).supersample).toBe(4);
    expect(screenshotPlan(opts({ scale: 0 }), CANVAS, null).supersample).toBe(1);
  });

  it('clamps the render to MAX_RENDER_DIM and says so, keeping the output size asked for', () => {
    const p = screenshotPlan(opts({ width: 20_000 }), CANVAS, null);
    expect(p.outWidth).toBe(20_000);
    expect(p.clamped).toBe(true);
    expect(Math.max(p.renderWidth, p.renderHeight)).toBeLessThanOrEqual(MAX_RENDER_DIM);
    // Square canvas in, square render out: the clamp is one ratio applied to both axes.
    expect(p.renderWidth).toBe(p.renderHeight);
  });

  it('ignores a pane rect for target:"grid"', () => {
    const p = screenshotPlan(opts({ width: 768 }), CANVAS, PANE);
    expect([p.outWidth, p.outHeight]).toEqual([768, 768]);
    expect(p.renderWidth).toBe(768);
  });
});

describe('screenshotAnnotations (§4.7 include)', () => {
  it('maps every flag, and keeps the badge on (§8: not optional)', () => {
    expect(screenshotAnnotations(INCLUDE_ALL)).toEqual({
      orientationLabels: true,
      cornerInfo: true,
      conventionBadge: true,
      scaleBar: true,
      colorbars: true,
      crosshair: true,
    });
    const none = screenshotAnnotations({
      colorbar: false,
      orientationLabels: false,
      crosshair: false,
      cornerInfo: false,
      scaleBar: false,
    });
    expect(none).toEqual({
      orientationLabels: false,
      cornerInfo: false,
      conventionBadge: true,
      scaleBar: false,
      colorbars: false,
      crosshair: false,
    });
  });
});

describe('cropRgba', () => {
  it('takes exactly the rectangle asked for', () => {
    const out = cropRgba(ramp(8, 8), { x: 2, y: 3, width: 4, height: 2 });
    expect([out.width, out.height]).toEqual([4, 2]);
    expect(at(out, 0, 0)).toEqual([2, 3, 0, 255]);
    expect(at(out, 3, 1)).toEqual([5, 4, 0, 255]);
  });

  it('leaves out-of-source pixels transparent rather than reading the wrong row', () => {
    const out = cropRgba(ramp(4, 4), { x: 3, y: 3, width: 3, height: 3 });
    expect(at(out, 0, 0)).toEqual([3, 3, 0, 255]);
    expect(at(out, 2, 2)).toEqual([0, 0, 0, 0]);
  });
});

describe('resampleArea', () => {
  it('is the exact average over each destination pixel’s source block', () => {
    // 4x4 down to 2x2: destination (0,0) averages source x in {0,1} and y in {0,1}, i.e. the ramp
    // values 0 and 1 -> mean 0.5 -> 1 (Math.round is half-up). Destination (1,1) averages 2 and 3.
    const out = resampleArea(ramp(4, 4), 2, 2);
    expect([out.width, out.height]).toEqual([2, 2]);
    expect(at(out, 0, 0)).toEqual([1, 1, 0, 255]);
    expect(at(out, 1, 1)).toEqual([3, 3, 0, 255]);
  });

  it('averages a 2x supersample to the arithmetic mean, channel by channel', () => {
    // A 2x2 source with known values; the 1x1 result is their mean.
    const rgba = new Uint8ClampedArray([
      0, 0, 0, 255, 100, 40, 8, 255, 200, 80, 16, 255, 100, 40, 8, 255,
    ]);
    const out = resampleArea({ rgba, width: 2, height: 2 }, 1, 1);
    expect(at(out, 0, 0)).toEqual([100, 40, 8, 255]);
  });

  it('is the identity at the same size, and returns the same object', () => {
    const src = ramp(4, 4);
    expect(resampleArea(src, 4, 4)).toBe(src);
  });

  it('upscales by nearest rather than throwing', () => {
    const out = resampleArea(ramp(2, 2), 4, 4);
    expect([out.width, out.height]).toEqual([4, 4]);
    expect(at(out, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(at(out, 3, 3)).toEqual([1, 1, 0, 255]);
  });
});

describe('autoTrimRgba', () => {
  it('drops the uniform border and keeps the content box exactly', () => {
    const w = 6;
    const h = 5;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i += 1) rgba.set([10, 20, 30, 255], i * 4);
    // One 2x2 block of content at (2,1)..(3,2).
    for (const [x, y] of [
      [2, 1],
      [3, 1],
      [2, 2],
      [3, 2],
    ] as const) {
      rgba.set([255, 0, 0, 255], (y * w + x) * 4);
    }
    const out = autoTrimRgba({ rgba, width: w, height: h });
    expect([out.width, out.height]).toEqual([2, 2]);
    expect(at(out, 0, 0)).toEqual([255, 0, 0, 255]);
  });

  it('returns a uniform image untouched instead of a 0x0 PNG', () => {
    const rgba = new Uint8ClampedArray(4 * 4 * 4).fill(7);
    const src = { rgba, width: 4, height: 4 };
    expect(autoTrimRgba(src)).toBe(src);
  });

  it('is a no-op when the content already reaches every edge', () => {
    const src = ramp(4, 4);
    expect(autoTrimRgba(src)).toBe(src);
  });
});

describe('matteOverBlackAndWhite (§4.7 background: "transparent")', () => {
  /**
   * The forward model, done in the test: a fragment of straight colour `C` and coverage `a` drawn
   * over background `B` reads back as `C·a + B·(1−a)`. The matte must invert it exactly.
   */
  function over(c: number, a: number, bg: number): number {
    return Math.round(c * a + bg * (1 - a));
  }

  it('recovers coverage and straight colour from the two renders', () => {
    const cases: { c: number; a: number }[] = [
      { c: 200, a: 1 },
      { c: 200, a: 0.5 },
      { c: 64, a: 0.25 },
      { c: 255, a: 0 },
    ];
    const black = new Uint8ClampedArray(cases.length * 4);
    const white = new Uint8ClampedArray(cases.length * 4);
    cases.forEach((k, i) => {
      for (let ch = 0; ch < 3; ch += 1) {
        black[i * 4 + ch] = over(k.c, k.a, 0);
        white[i * 4 + ch] = over(k.c, k.a, 255);
      }
      black[i * 4 + 3] = 255;
      white[i * 4 + 3] = 255;
    });
    const out = matteOverBlackAndWhite(
      { rgba: black, width: cases.length, height: 1 },
      { rgba: white, width: cases.length, height: 1 }
    );
    cases.forEach((k, i) => {
      const px = at(out, i, 0);
      expect(Math.abs((px[3] ?? 0) - Math.round(k.a * 255))).toBeLessThanOrEqual(1);
      if (k.a > 0) expect(Math.abs((px[0] ?? 0) - k.c)).toBeLessThanOrEqual(2);
    });
  });

  it('leaves an uncovered pixel fully transparent black, whatever the background was', () => {
    const black = new Uint8ClampedArray([0, 0, 0, 255]);
    const white = new Uint8ClampedArray([255, 255, 255, 255]);
    const out = matteOverBlackAndWhite(
      { rgba: black, width: 1, height: 1 },
      { rgba: white, width: 1, height: 1 }
    );
    expect(at(out, 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it('leaves an opaque pixel opaque and unchanged', () => {
    const px = new Uint8ClampedArray([12, 34, 56, 255]);
    const out = matteOverBlackAndWhite(
      { rgba: px, width: 1, height: 1 },
      { rgba: px.slice(), width: 1, height: 1 }
    );
    expect(at(out, 0, 0)).toEqual([12, 34, 56, 255]);
  });
});

describe('withPngDpi / pngDpi (§4.7: dpi -> the pHYs chunk)', () => {
  /** The smallest legal PNG: signature, IHDR, IDAT, IEND. Built here, never captured. */
  function tinyPng(): Uint8Array {
    const crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
    const crc = (b: Uint8Array): number => {
      let c = 0xffffffff;
      for (const v of b) c = (crcTable[(c ^ v) & 0xff] as number) ^ (c >>> 8);
      return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type: string, body: Uint8Array): Uint8Array => {
      const out = new Uint8Array(12 + body.length);
      const dv = new DataView(out.buffer);
      dv.setUint32(0, body.length);
      for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
      out.set(body, 8);
      dv.setUint32(8 + body.length, crc(out.subarray(4, 8 + body.length)));
      return out;
    };
    const ihdr = new Uint8Array(13);
    new DataView(ihdr.buffer).setUint32(0, 1);
    new DataView(ihdr.buffer).setUint32(4, 1);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const parts = [
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', Uint8Array.from([0x78, 0x01, 0x01, 0x00, 0x00, 0xff, 0xff, 0, 0, 0, 1])),
      chunk('IEND', new Uint8Array(0)),
    ];
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  it('converts DPI to pixels per metre with the exact inch', () => {
    // 1 inch = 0.0254 m exactly, so 300 dpi is 300 / 0.0254 = 11811.02... -> 11811.
    expect(pixelsPerMetre(300)).toBe(11_811);
    expect(pixelsPerMetre(72)).toBe(2835);
  });

  it('writes a pHYs chunk immediately after IHDR, with a valid length, unit and CRC', () => {
    const png = withPngDpi(tinyPng(), 300);
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    // signature (8) + IHDR (12 + 13) = 33 is where the chunk must start.
    expect(view.getUint32(33)).toBe(9);
    expect(String.fromCharCode(png[37]!, png[38]!, png[39]!, png[40]!)).toBe('pHYs');
    expect(view.getUint32(41)).toBe(11_811);
    expect(view.getUint32(45)).toBe(11_811);
    expect(png[49]).toBe(1);
    expect(pngDpi(png)).toBeCloseTo(300, 1);
  });

  it('is idempotent: a second stamp replaces the first rather than appending', () => {
    const once = withPngDpi(tinyPng(), 300);
    const twice = withPngDpi(once, 144);
    expect(twice.length).toBe(once.length);
    expect(pngDpi(twice)).toBeCloseTo(144, 1);
  });

  it('leaves the PNG alone for a nonsensical DPI, and reports none', () => {
    const png = tinyPng();
    expect(withPngDpi(png, 0)).toBe(png);
    expect(withPngDpi(png, Number.NaN)).toBe(png);
    expect(pngDpi(png)).toBeNull();
  });

  it('refuses a buffer that is not a PNG', () => {
    expect(() => withPngDpi(new Uint8Array(32), 300)).toThrow(/not a PNG/);
  });
});
