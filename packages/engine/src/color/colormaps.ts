/**
 * Colormaps and the LUT bake — `docs/ARCHITECTURE.md` §7.6.
 *
 * A continuous colormap is a **256×1 RGBA8** texture baked on the CPU from `Scale`. `kind:'heat'`
 * costs nothing extra in the shader — it is a different bake, which is the whole point of doing the
 * mapping here rather than in GLSL. `negative:'separate'` bakes a **512×1** signed LUT.
 *
 * Every table below is 9 evenly-spaced stops (5 or 6 for the piecewise-linear classics), linearly
 * interpolated. The names are §4.1's frozen `ColormapName` union, in that order.
 */

import type { ColormapName, Scale } from '../scene/types';

type Stops = [number, number, number][];

/** Evenly spaced stops unless the name is listed in {@link POSITIONS}. */
const TABLES: Record<ColormapName, Stops> = {
  gray: [
    [0, 0, 0],
    [255, 255, 255],
  ],
  viridis: [
    [68, 1, 84],
    [72, 40, 120],
    [62, 74, 137],
    [49, 104, 142],
    [38, 130, 142],
    [31, 158, 137],
    [53, 183, 121],
    [109, 205, 89],
    [253, 231, 37],
  ],
  plasma: [
    [13, 8, 135],
    [75, 3, 161],
    [125, 3, 168],
    [168, 34, 150],
    [203, 70, 121],
    [229, 107, 93],
    [248, 148, 65],
    [253, 195, 40],
    [240, 249, 33],
  ],
  inferno: [
    [0, 0, 4],
    [22, 11, 57],
    [66, 10, 104],
    [106, 23, 110],
    [147, 38, 103],
    [188, 55, 84],
    [221, 81, 58],
    [243, 120, 25],
    [252, 255, 164],
  ],
  magma: [
    [0, 0, 4],
    [20, 14, 54],
    [59, 15, 112],
    [100, 26, 128],
    [140, 41, 129],
    [183, 55, 121],
    [222, 73, 104],
    [247, 112, 92],
    [252, 253, 191],
  ],
  cividis: [
    [0, 32, 76],
    [0, 50, 109],
    [52, 71, 111],
    [81, 90, 113],
    [108, 110, 115],
    [136, 131, 113],
    [168, 153, 105],
    [200, 177, 91],
    [255, 234, 70],
  ],
  turbo: [
    [48, 18, 59],
    [65, 88, 199],
    [46, 152, 238],
    [26, 206, 190],
    [86, 234, 120],
    [167, 249, 60],
    [231, 215, 46],
    [250, 140, 32],
    [122, 4, 3],
  ],
  jet: [
    [0, 0, 131],
    [0, 60, 170],
    [5, 255, 255],
    [255, 255, 0],
    [250, 0, 0],
    [128, 0, 0],
  ],
  hot: [
    [0, 0, 0],
    [255, 0, 0],
    [255, 255, 0],
    [255, 255, 255],
  ],
  cool: [
    [0, 255, 255],
    [255, 0, 255],
  ],
  bone: [
    [0, 0, 0],
    [84, 84, 116],
    [168, 200, 200],
    [255, 255, 255],
  ],
  coolwarm: [
    [59, 76, 192],
    [221, 221, 221],
    [180, 4, 38],
  ],
  bwr: [
    [0, 0, 255],
    [255, 255, 255],
    [255, 0, 0],
  ],
  'freesurfer-heat': [
    [127, 0, 0],
    [255, 0, 0],
    [255, 255, 0],
    [255, 255, 255],
  ],
  'blue-cyan': [
    [0, 0, 127],
    [0, 0, 255],
    [0, 255, 255],
    [255, 255, 255],
  ],
};

/** Non-uniform stop positions, where the classic definition is not evenly spaced. */
const POSITIONS: Partial<Record<ColormapName, number[]>> = {
  hot: [0, 0.375, 0.75, 1],
};

export function isColormapName(name: string): name is ColormapName {
  return Object.prototype.hasOwnProperty.call(TABLES, name);
}

/** Sample a colormap at `t` in 0..1, clamped. Returns RGB 0..255. */
export function sampleColormap(name: ColormapName, t: number): [number, number, number] {
  const stops = TABLES[name];
  const pos = POSITIONS[name] ?? stops.map((_, i) => i / (stops.length - 1));
  const u = t <= 0 ? 0 : t >= 1 ? 1 : t;
  let i = 0;
  while (i < pos.length - 2 && u > (pos[i + 1] ?? 1)) i += 1;
  const a = stops[i] ?? [0, 0, 0];
  const b = stops[i + 1] ?? a;
  const p0 = pos[i] ?? 0;
  const p1 = pos[i + 1] ?? 1;
  const f = p1 > p0 ? (u - p0) / (p1 - p0) : 0;
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

/**
 * The value → 0..1 position a `Scale` maps to, before the colormap.
 *
 * `heat` (§4.2: min/mid/max, `truncate`, `inverse`) is a two-segment ramp: `min..mid` fades in over
 * the lower half of the colormap and `mid..max` covers the upper half, which is what makes a
 * FreeSurfer-style heat overlay reach full saturation at `mid` rather than at `max`.
 */
export function scalePosition(scale: Scale, v: number): number {
  if (scale.kind === 'linear') {
    const d = scale.hi - scale.lo;
    return d === 0 ? 0 : (v - scale.lo) / d;
  }
  const { min, mid, max, inverse } = scale;
  const a = Math.abs(v);
  let t: number;
  if (a <= min) t = 0;
  else if (a <= mid) t = mid > min ? (0.5 * (a - min)) / (mid - min) : 0.5;
  else if (a <= max) t = max > mid ? 0.5 + (0.5 * (a - mid)) / (max - mid) : 1;
  else t = scale.truncate ? 1 : 1;
  return inverse ? 1 - t : t;
}

export interface BakedLut {
  /** RGBA8, `width * 4` bytes. */
  rgba: Uint8Array;
  width: 256 | 512;
  /** What the shader maps a physical value into, matching the bake. */
  lo: number;
  hi: number;
  /** True for a 512-wide signed LUT (`negative: 'separate'`). */
  signed: boolean;
}

/**
 * Bake a `Scale` + colormap pair into the texture the slice/mesh shaders sample.
 *
 * The shader's job is then exactly `texture(lut, vec2((v - lo) / (hi - lo), 0.5))` — one divide and
 * one fetch, with every branch of §4.2's display model already resolved on the CPU.
 */
export function bakeScale(
  scale: Scale,
  colormap: ColormapName,
  negativeColormap: ColormapName = 'blue-cyan'
): BakedLut {
  const separate = scale.kind === 'heat' && scale.negative === 'separate';
  const width = separate ? 512 : 256;
  const rgba = new Uint8Array(width * 4);

  const lo = scale.kind === 'linear' ? scale.lo : -scale.max;
  const hi = scale.kind === 'linear' ? scale.hi : scale.max;

  for (let i = 0; i < width; i += 1) {
    const u = i / (width - 1);
    const v = lo + u * (hi - lo);
    let rgb: [number, number, number];
    let alpha = 255;
    if (scale.kind === 'linear') {
      rgb = sampleColormap(colormap, scalePosition(scale, v));
    } else {
      const t = scalePosition(scale, v);
      if (v < 0) {
        switch (scale.negative) {
          case 'hide':
            rgb = [0, 0, 0];
            alpha = 0;
            break;
          case 'mirror':
            rgb = sampleColormap(colormap, t);
            break;
          case 'separate':
            rgb = sampleColormap(negativeColormap, t);
            break;
        }
      } else {
        rgb = sampleColormap(colormap, t);
      }
      // Below `min` a heat scale contributes nothing — that is what makes it an overlay.
      if (Math.abs(v) < scale.min) alpha = 0;
    }
    rgba[i * 4] = rgb[0];
    rgba[i * 4 + 1] = rgb[1];
    rgba[i * 4 + 2] = rgb[2];
    rgba[i * 4 + 3] = alpha;
  }
  return { rgba, width: width as 256 | 512, lo, hi, signed: separate };
}
