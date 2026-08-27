/**
 * The §11 verification helpers.
 *
 * Rule 0 of `docs/ARCHITECTURE.md` §11: *an agent cannot judge a PNG; it can judge a number.* So every
 * rendering feature gets two tests, and this module provides both halves:
 *
 * 1. {@link expectPixel} — the **primary** test. The expected RGBA is computed from first principles and
 *    compared against a `gl.readPixels` readback taken **in the page**. There is no PNG round-trip and no
 *    screenshot decoding: what is asserted is the drawing buffer itself. This is the harness stand-in for
 *    `engine.readPixel(viewId, x, y)` (§4.7) until the engine exists; the coordinate convention and the
 *    tolerance semantics are identical, so a Phase-1 test only swaps the target.
 * 2. {@link expectGolden} — regression only, under the §11 policy: captured on headless
 *    Chromium/SwiftShader at a fixed canvas size and `deviceScaleFactor: 1`, stored per renderer class
 *    under `test/golden/<swiftshader|angle-metal>/`, compared at `maxDiffPixelRatio ≤ 0.002` and
 *    `threshold: 0.15` — never byte equality, because SwiftShader's LLVM JIT is not bit-identical across
 *    arm64 macOS and x86_64 Linux. `ubuntu-24.04` is the golden authority; macOS compares looser.
 *
 * **Coordinates are top-left origin** — canvas pixel `(0, 0)` is the top-left pixel, the same pixel a
 * golden PNG and a human call `(0, 0)`. `gl.readPixels` is bottom-left, and the flip happens inside this
 * module exactly once so no test has to remember it.
 */

import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { RendererClass } from '../../src/gl/context';

/** 0..255 per channel, as `readPixels` and a PNG both report it. */
export type Rgba = readonly [number, number, number, number];

/** Every test page draws into a single `#gl` canvas. */
export const DEFAULT_CANVAS_SELECTOR = '#gl';

/** §11: goldens are compared at this ratio on the golden authority (`ubuntu-24.04`). */
export const GOLDEN_MAX_DIFF_PIXEL_RATIO = 0.002;
/** §11: "the macOS job runs the same tests with a looser ratio". */
export const GOLDEN_MAX_DIFF_PIXEL_RATIO_DARWIN = 0.01;
/** §11: per-pixel colour distance tolerance. */
export const GOLDEN_THRESHOLD = 0.15;

/** The env var that unlocks golden regeneration. Nothing else may write a golden. */
export const GOLDEN_UPDATE_ENV = 'TETRAVOX_UPDATE_GOLDENS';

export function goldenMaxDiffPixelRatio(platform: string = process.platform): number {
  return platform === 'darwin' ? GOLDEN_MAX_DIFF_PIXEL_RATIO_DARWIN : GOLDEN_MAX_DIFF_PIXEL_RATIO;
}

/** §7.1's `isSoftware` rule, duplicated here because this runs inside the browser page. */
const SOFTWARE_RENDERER_RE = /SwiftShader|llvmpipe|softpipe/i;

function canvasOf(target: Page | Locator, selector: string): Locator {
  return 'goto' in target ? target.locator(selector) : target;
}

/**
 * Read RGBA at several top-left-origin canvas pixels in one round trip.
 *
 * Calls the page's `window.__tvxRender()` (when it has one) and `readPixels` in the **same** task, so
 * the read can never be beaten to the drawing buffer by a compositor pass.
 */
export async function readCanvasPixels(
  target: Page | Locator,
  points: readonly (readonly [number, number])[],
  selector: string = DEFAULT_CANVAS_SELECTOR
): Promise<Rgba[]> {
  return canvasOf(target, selector).evaluate((el, pts): Rgba[] => {
    if (!(el instanceof HTMLCanvasElement)) throw new Error('pixel target is not a <canvas>');
    const gl = el.getContext('webgl2');
    if (gl === null) throw new Error('canvas has no webgl2 context');
    window.__tvxRender?.();
    const px = new Uint8Array(4);
    return pts.map(([x, y]): Rgba => {
      if (x < 0 || y < 0 || x >= el.width || y >= el.height) {
        throw new Error(`pixel (${x}, ${y}) is outside the ${el.width}x${el.height} canvas`);
      }
      // readPixels' origin is bottom-left; this module's coordinates are top-left.
      gl.readPixels(x, el.height - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return [px[0] ?? 0, px[1] ?? 0, px[2] ?? 0, px[3] ?? 0];
    });
  }, points);
}

/**
 * Read a whole rectangle in **one** `readPixels`, row-major, top-left origin.
 *
 * `readCanvasPixels` costs one `readPixels` per point, which is fine for a handful of analytic
 * pixels and far too slow for the thousands a glyph decode needs.
 */
export async function readCanvasRect(
  target: Page | Locator,
  x: number,
  y: number,
  w: number,
  h: number,
  selector: string = DEFAULT_CANVAS_SELECTOR
): Promise<Uint8Array> {
  const flat = await canvasOf(target, selector).evaluate(
    (el, [rx, ry, rw, rh]): number[] => {
      if (!(el instanceof HTMLCanvasElement)) throw new Error('pixel target is not a <canvas>');
      const gl = el.getContext('webgl2');
      if (gl === null) throw new Error('canvas has no webgl2 context');
      if (rx < 0 || ry < 0 || rx + rw > el.width || ry + rh > el.height) {
        throw new Error(
          `rect ${rx},${ry} ${rw}x${rh} is outside the ${el.width}x${el.height} canvas`
        );
      }
      window.__tvxRender?.();
      const px = new Uint8Array(rw * rh * 4);
      // readPixels' origin is bottom-left; this module's coordinates are top-left.
      gl.readPixels(rx, el.height - ry - rh, rw, rh, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const out = new Array<number>(px.length);
      for (let row = 0; row < rh; row += 1) {
        const src = (rh - 1 - row) * rw * 4;
        const dst = row * rw * 4;
        for (let i = 0; i < rw * 4; i += 1) out[dst + i] = px[src + i] ?? 0;
      }
      return out;
    },
    [x, y, w, h] as const
  );
  return Uint8Array.from(flat);
}

/**
 * §11 (1) — the analytic pixel assertion.
 *
 * @param target   the page (canvas found by `selector`) or the canvas locator itself
 * @param x, y     canvas pixel, **top-left origin**
 * @param rgba     the expected 0..255 RGBA, computed from first principles — never from a previous run
 * @param tol      per-channel tolerance, default 1
 */
export async function expectPixel(
  target: Page | Locator,
  x: number,
  y: number,
  rgba: Rgba,
  tol = 1,
  selector: string = DEFAULT_CANVAS_SELECTOR
): Promise<void> {
  const [actual] = await readCanvasPixels(target, [[x, y]], selector);
  if (actual === undefined) throw new Error('readCanvasPixels returned nothing');
  const worst = Math.max(...actual.map((v, i) => Math.abs(v - (rgba[i] ?? 0))));
  expect(
    worst,
    `pixel (${x}, ${y}): expected rgba(${rgba.join(', ')}) ±${tol}, got rgba(${actual.join(', ')})`
  ).toBeLessThanOrEqual(tol);
}

/**
 * Which §11 golden directory this run's pixels belong in, read from the live context rather than from
 * the platform: the same machine produces SwiftShader pixels headless and ANGLE pixels headed.
 */
export async function rendererClassOf(
  target: Page | Locator,
  selector: string = DEFAULT_CANVAS_SELECTOR
): Promise<RendererClass> {
  const renderer = await canvasOf(target, selector).evaluate((el): string => {
    if (!(el instanceof HTMLCanvasElement)) throw new Error('pixel target is not a <canvas>');
    const gl = el.getContext('webgl2');
    if (gl === null) throw new Error('canvas has no webgl2 context');
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    // 0x9246 = UNMASKED_RENDERER_WEBGL, 0x9245 = UNMASKED_VENDOR_WEBGL.
    const unmasked = dbg ? String(gl.getParameter(0x9246) ?? '') : '';
    const vendor = dbg ? String(gl.getParameter(0x9245) ?? '') : '';
    return `${unmasked || String(gl.getParameter(gl.RENDERER) ?? '')} ${vendor}`;
  });
  return SOFTWARE_RENDERER_RE.test(renderer) ? 'swiftshader' : 'angle-metal';
}

/**
 * §11 (2) — the golden PNG, regression only.
 *
 * The snapshot is stored at `test/golden/<rendererClass>/<name>.png` (see `snapshotPathTemplate` in
 * `playwright.config.ts`) and compared with the §11 ratio for this platform.
 *
 * Regeneration is guarded: writing a golden needs `TETRAVOX_UPDATE_GOLDENS=1` **and** an update mode, so
 * a stray `playwright test -u` cannot silently re-bless a rendering change. §11 additionally requires the
 * commit body to state what changed visually — see `docs/TESTING.md`.
 */
export async function expectGolden(
  target: Page | Locator,
  name: string,
  selector: string = DEFAULT_CANVAS_SELECTOR
): Promise<void> {
  const info = test.info();
  if (info.config.updateSnapshots !== 'none' && !process.env[GOLDEN_UPDATE_ENV]) {
    throw new Error(
      `refusing to write goldens: set ${GOLDEN_UPDATE_ENV}=1 to regenerate (ARCHITECTURE.md §11), ` +
        'and state in the commit body what changed visually.'
    );
  }
  const cls = await rendererClassOf(target, selector);
  await expect(canvasOf(target, selector)).toHaveScreenshot([cls, `${name}.png`], {
    maxDiffPixelRatio: goldenMaxDiffPixelRatio(),
    threshold: GOLDEN_THRESHOLD,
    animations: 'disabled',
    caret: 'hide',
    scale: 'css',
  });
}
