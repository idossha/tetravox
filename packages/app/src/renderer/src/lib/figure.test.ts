import { describe, expect, it } from 'vitest';
import type { ScreenshotOptions } from '@tetravox/engine';
import {
  EXPORT_PRESETS,
  autoColumns,
  figureLabel,
  figureLayout,
  labelPx,
  mmForPixels,
  pixelsForMm,
} from './figure';
import { encodePng, readPngInfo, withPngDpi } from './png';

const BASE: ScreenshotOptions = {
  target: 'grid',
  background: 'scene',
  include: {
    colorbar: true,
    orientationLabels: true,
    crosshair: true,
    cornerInfo: true,
    scaleBar: false,
    orientationCube: false,
  },
  autoTrim: false,
  width: 1200,
};

describe('physical size', () => {
  it('85 mm at 300 dpi is the 1004 px every journal template quotes', () => {
    expect(pixelsForMm(85, 300)).toBe(1004);
    expect(pixelsForMm(174, 600)).toBe(4110);
    expect(mmForPixels(1004, 300)).toBeCloseTo(85, 0);
  });
  it('label size is points at dpi, never below a legible floor', () => {
    expect(labelPx(10, 300)).toBe(42);
    expect(labelPx(1, 72)).toBe(6);
  });
});

describe('presets', () => {
  it('patch the print knobs and leave the target and size alone', () => {
    const print = EXPORT_PRESETS.find((p) => p.id === 'print300')!.apply(BASE);
    expect(print).toMatchObject({
      target: 'grid',
      width: 1200,
      dpi: 300,
      background: 'white',
      autoTrim: true,
    });
    expect(print.include).toMatchObject({ crosshair: false, cornerInfo: false, colorbar: true });
    const web = EXPORT_PRESETS.find((p) => p.id === 'web')!.apply(print);
    expect(web).toMatchObject({ dpi: 144, background: 'scene', autoTrim: false });
  });
});

describe('figure layout', () => {
  it('labels run A…Z, AA…', () => {
    expect([0, 1, 25, 26, 27].map((i) => figureLabel(i, 'upper'))).toEqual([
      'A',
      'B',
      'Z',
      'AA',
      'AB',
    ]);
    expect(figureLabel(2, 'lower')).toBe('c');
    expect(figureLabel(2, 'none')).toBe('');
  });
  it('auto columns: 4 → 2×2, 3 → 2 + 1, 1 → 1', () => {
    expect(autoColumns(4)).toBe(2);
    expect(autoColumns(3)).toBe(2);
    expect(autoColumns(1)).toBe(1);
  });
  it('is a uniform grid with a gutter around and between cells', () => {
    const l = figureLayout(
      [
        { width: 100, height: 80 },
        { width: 90, height: 100 },
        { width: 100, height: 100 },
      ],
      2,
      10
    );
    expect(l.columns).toBe(2);
    expect(l.rows).toBe(2);
    expect(l.width).toBe(10 + 2 * (100 + 10));
    expect(l.height).toBe(10 + 2 * (100 + 10));
    expect(l.cells).toEqual([
      { x: 10, y: 10, width: 100, height: 100 },
      { x: 120, y: 10, width: 100, height: 100 },
      { x: 10, y: 120, width: 100, height: 100 },
    ]);
  });
  it('never asks for more columns than panels, and 0 means auto', () => {
    expect(figureLayout([{ width: 5, height: 5 }], 4, 0).columns).toBe(1);
    expect(figureLayout(Array(4).fill({ width: 5, height: 5 }), 0, 0).columns).toBe(2);
    expect(figureLayout([], 0, 4)).toMatchObject({ width: 0, height: 0, cells: [] });
  });
});

describe('withPngDpi', () => {
  const png = encodePng({ width: 2, height: 1, pixels: new Uint8Array(8) });
  it('inserts a pHYs chunk after IHDR when there is none', () => {
    expect(readPngInfo(png)?.dpi).toBeUndefined();
    expect(readPngInfo(withPngDpi(png, 300))?.dpi).toBe(300);
  });
  it('replaces an existing one rather than adding a second', () => {
    const once = withPngDpi(png, 300);
    const twice = withPngDpi(once, 600);
    expect(readPngInfo(twice)?.dpi).toBe(600);
    expect(twice.length).toBe(once.length);
  });
  it('leaves a non-PNG untouched', () => {
    const junk = new Uint8Array([1, 2, 3]);
    expect(withPngDpi(junk, 300)).toBe(junk);
  });
});
