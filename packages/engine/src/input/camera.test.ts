/**
 * What each gesture does to a camera — the closed-form half of R2 and R3's gate assertions.
 *
 * R2 asks for "the world point under P is unchanged (±0.1 mm)" after a zoom step. That is a property
 * of {@link zoomAbout} and of nothing else, so it is proved here at exact arithmetic over a spread of
 * offsets and factors, and the e2e run then only has to prove that the DOM layer calls it with the
 * right numbers.
 */

import { describe, expect, it } from 'vitest';
import {
  clampMmPerPx,
  dolly,
  mmPerPx3D,
  normaliseWheelDelta,
  opacityAfterDrag,
  orbit,
  pan3D,
  panBy,
  wheelZoomFactor,
  windowLevel,
  zoomAbout,
  zoomAboutCentre,
  DOLLY_STEP,
  MAX_MM_PER_PX,
  MIN_MM_PER_PX,
  WHEEL_NOTCH,
  ZOOM_STEP,
} from './camera';
import type { Camera2D } from './camera';
import type { Camera3D, Scale } from '../scene/types';

const cam: Camera2D = { center: [12, -7], mmPerPx: 0.5 };

/** The world coordinate a pane offset addresses, in plane axes. */
const worldAt = (c: Camera2D, offset: number, axis: 0 | 1): number =>
  c.center[axis] + offset * c.mmPerPx;

describe('zoomAbout (R2)', () => {
  it('keeps the world point under the pointer fixed, exactly', () => {
    for (const offsetX of [-191.5, -40, 0, 7.5, 191.5]) {
      for (const offsetY of [-191.5, 0, 63]) {
        for (const factor of [1 / ZOOM_STEP, ZOOM_STEP, 0.37, 2.9]) {
          const next = zoomAbout(cam, offsetX, offsetY, factor);
          expect(worldAt(next, offsetX, 0)).toBeCloseTo(worldAt(cam, offsetX, 0), 10);
          expect(worldAt(next, offsetY, 1)).toBeCloseTo(worldAt(cam, offsetY, 1), 10);
        }
      }
    }
  });

  it('scales mmPerPx by the factor and clamps it to R2’s [0.05, 20]', () => {
    expect(zoomAbout(cam, 0, 0, 1 / ZOOM_STEP).mmPerPx).toBeCloseTo(0.5 / ZOOM_STEP, 12);
    expect(zoomAbout(cam, 100, 100, 1e-9).mmPerPx).toBe(MIN_MM_PER_PX);
    expect(zoomAbout(cam, 100, 100, 1e9).mmPerPx).toBe(MAX_MM_PER_PX);
    expect(clampMmPerPx(Number.NaN)).toBe(MIN_MM_PER_PX);
    expect(clampMmPerPx(0)).toBe(MIN_MM_PER_PX);
  });

  it('at the pane centre is zoomAboutCentre — the `+` / `-` keys', () => {
    expect(zoomAbout(cam, 0, 0, 1 / ZOOM_STEP)).toEqual(zoomAboutCentre(cam, 1 / ZOOM_STEP));
    expect(zoomAboutCentre(cam, ZOOM_STEP).center).toEqual(cam.center);
  });

  it('one wheel notch is exactly one zoom step', () => {
    expect(wheelZoomFactor(-WHEEL_NOTCH)).toBeCloseTo(1 / ZOOM_STEP, 12);
    expect(wheelZoomFactor(WHEEL_NOTCH)).toBeCloseTo(ZOOM_STEP, 12);
    // A trackpad pinch reports a small continuous delta and gets a small continuous factor.
    expect(wheelZoomFactor(-5)).toBeGreaterThan(1 / ZOOM_STEP);
    expect(wheelZoomFactor(-5)).toBeLessThan(1);
    expect(wheelZoomFactor(0)).toBe(1);
  });

  it('normalises line- and page-mode wheel deltas', () => {
    expect(normaliseWheelDelta(3, 0)).toBe(3);
    expect(normaliseWheelDelta(3, 1)).toBe(48);
    expect(normaliseWheelDelta(1, 2)).toBe(WHEEL_NOTCH);
  });
});

describe('panBy (R3)', () => {
  it('moves the image with the pointer, so the pane centre moves the other way', () => {
    const next = panBy(cam, 10, 4);
    expect(next.center[0]).toBeCloseTo(12 - 10 * 0.5, 12);
    expect(next.center[1]).toBeCloseTo(-7 + 4 * 0.5, 12);
    expect(next.mmPerPx).toBe(cam.mmPerPx);
    // Undoing the drag restores the camera exactly.
    expect(panBy(next, -10, -4).center[0]).toBeCloseTo(12, 12);
    expect(panBy(next, -10, -4).center[1]).toBeCloseTo(-7, 12);
  });
});

describe('windowLevel (§7.5 right-drag)', () => {
  const linear: Scale = { kind: 'linear', lo: 100, hi: 1300 };

  it('leaves the scale alone for a zero drag', () => {
    expect(windowLevel(linear, 0, 0)).toEqual(linear);
  });

  it('is multiplicative in width, so it is scale-free and never crosses zero', () => {
    const wide = windowLevel(linear, 0.5, 0);
    const narrow = windowLevel(linear, -0.5, 0);
    expect(wide.kind === 'linear' && wide.hi - wide.lo).toBeCloseTo(1200 * Math.exp(1), 6);
    expect(narrow.kind === 'linear' && narrow.hi - narrow.lo).toBeCloseTo(1200 * Math.exp(-1), 6);
    // The centre is untouched by a purely horizontal drag.
    expect(wide.kind === 'linear' && (wide.lo + wide.hi) / 2).toBeCloseTo(700, 6);
    // A 1/1000th-of-a-pane window is still positive, however far the user drags.
    const tiny = windowLevel({ kind: 'linear', lo: 0, hi: 1e-9 }, -20, 0);
    expect(tiny.kind === 'linear' && tiny.hi - tiny.lo).toBeGreaterThan(0);
  });

  it('shifts the centre vertically without changing the width', () => {
    const dark = windowLevel(linear, 0, 0.25);
    expect(dark.kind === 'linear' && dark.hi - dark.lo).toBeCloseTo(1200, 6);
    expect(dark.kind === 'linear' && (dark.lo + dark.hi) / 2).toBeCloseTo(700 + 0.25 * 1200 * 2, 6);
  });

  it('keeps a heat scale’s mid at the same position in the window', () => {
    const heat: Scale = {
      kind: 'heat',
      min: 0,
      mid: 2,
      max: 8,
      truncate: false,
      inverse: false,
      negative: 'hide',
    };
    const next = windowLevel(heat, 0.3, -0.1);
    if (next.kind !== 'heat') throw new Error('kind must survive');
    const t = (next.mid - next.min) / (next.max - next.min);
    expect(t).toBeCloseTo(0.25, 9);
    expect(next.truncate).toBe(false);
    expect(next.negative).toBe('hide');
  });
});

describe('opacityAfterDrag (§7.5 Shift+drag)', () => {
  it('makes the layer more opaque when dragged up, and clamps to 0..1', () => {
    expect(opacityAfterDrag(0.5, -0.25)).toBeCloseTo(0.75, 12);
    expect(opacityAfterDrag(0.5, 0.25)).toBeCloseTo(0.25, 12);
    expect(opacityAfterDrag(0.5, -10)).toBe(1);
    expect(opacityAfterDrag(0.5, 10)).toBe(0);
  });
});

describe('the 3D camera (§7.5)', () => {
  const cam3d: Camera3D = {
    target: [1, 2, 3],
    distance: 400,
    rotation: [0, 0, 0, 1],
    fovYDeg: 35,
    orthographic: false,
    near: 1,
    far: 2000,
  };

  it('orbit: a zero drag is the identity, and the quaternion stays normalised', () => {
    expect(orbit(cam3d, 0, 0).rotation.map((v) => Math.round(v * 1e12) / 1e12)).toEqual([
      0, 0, 0, 1,
    ]);
    let c = cam3d;
    for (let i = 0; i < 50; i += 1) c = orbit(c, 17, -9);
    // gl-matrix computes in Float32Array, so 50 composed rotations drift by ~2e-8 before the
    // re-normalisation `orbit` does each step pulls them back. That is the float32 floor, not a bug.
    const n = Math.hypot(...c.rotation);
    expect(n).toBeCloseTo(1, 6);
    expect(c.target).toEqual(cam3d.target);
    expect(c.distance).toBe(cam3d.distance);
  });

  it('orbit: a full turn about one axis returns to the start', () => {
    // 720 px of horizontal drag is 2π at ORBIT_RAD_PER_PX = π/360.
    let c = cam3d;
    for (let i = 0; i < 720; i += 1) c = orbit(c, 1, 0);
    // A quaternion and its negation are the same rotation, so compare |dot|.
    const d = Math.abs(
      c.rotation[0] * 0 + c.rotation[1] * 0 + c.rotation[2] * 0 + c.rotation[3] * 1
    );
    expect(d).toBeCloseTo(1, 6);
  });

  it('orbit: a horizontal drag actually turns the camera', () => {
    const turned = orbit(cam3d, 90, 0);
    expect(Math.abs(turned.rotation[1])).toBeGreaterThan(0.1);
  });

  it('pan3D moves the target in the camera plane, and undoes exactly', () => {
    const h = 384;
    const moved = pan3D(cam3d, 30, -12, h);
    const back = pan3D(moved, -30, 12, h);
    expect(back.target[0]).toBeCloseTo(cam3d.target[0], 9);
    expect(back.target[1]).toBeCloseTo(cam3d.target[1], 9);
    expect(back.target[2]).toBeCloseTo(cam3d.target[2], 9);
    // Identity rotation: screen-right is +X, so dragging right slides the target −X.
    expect(moved.target[0]).toBeCloseTo(cam3d.target[0] - 30 * mmPerPx3D(cam3d, h), 9);
  });

  it('dolly scales the distance one step per notch, clamped inside near/far', () => {
    expect(dolly(cam3d, WHEEL_NOTCH).distance).toBeCloseTo(400 * DOLLY_STEP, 9);
    expect(dolly(cam3d, -WHEEL_NOTCH).distance).toBeCloseTo(400 / DOLLY_STEP, 9);
    // §7.2 fits near/far to the scene; dollying through the near plane breaks depth ordering, so it
    // is not a thing the wheel is allowed to do.
    expect(dolly(cam3d, -100 * WHEEL_NOTCH).distance).toBe(cam3d.near * 2);
    expect(dolly(cam3d, 100 * WHEEL_NOTCH).distance).toBe(cam3d.far * 0.5);
  });
});
