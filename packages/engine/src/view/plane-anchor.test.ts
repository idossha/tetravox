/**
 * The 2D pane's in-plane frame — R3's "move the crosshair, not the scan".
 *
 * These are the closed-form halves of the gate assertions in `test/e2e/pointer.spec.ts`: that a
 * pane's pixel↔world mapping does **not** depend on where the cursor is in-plane (so a left-drag
 * cannot move the image), that it is its own inverse, and that the radiological mirror moves the
 * cursor the same physical way — §11's named laterality test for the pointer layer.
 */

import { describe, expect, it } from 'vitest';
import {
  effectiveSliceView,
  paneToWorld,
  planeAnchor,
  presetNormal,
  presetUp,
  sliceBasis,
  stepMm,
  worldToPane,
  worldToPane3D,
  MESH_ONLY_STEP_MM,
} from './geometry';
import type { Aabb, SliceMode, SliceView, vec3 } from '../scene/types';

const RECT = { width: 384, height: 384 };
const BOUNDS: Aabb = { min: [-84, -92, -128], max: [83, 136, 99] };

function viewOf(mode: SliceMode, mmPerPx = 0.5, center: [number, number] = [0, 0]): SliceView {
  return {
    id: mode,
    mode,
    normal: presetNormal(mode),
    up: presetUp(mode),
    camera: { center, mmPerPx },
  };
}

const dot = (a: vec3, b: vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe('planeAnchor (R3)', () => {
  it('is the scene bounding-box centre, which no gesture moves', () => {
    expect(planeAnchor(BOUNDS)).toEqual([(-84 + 83) / 2, (-92 + 136) / 2, (-128 + 99) / 2]);
  });

  it('coincides with the cursor at load, so no Phase-1 framing moves', () => {
    // `#onFirstDataset` puts the cursor on the bbox centre and `camera.center` at [0,0]. With
    // anchor === cursor the compensation is identically zero, which is what keeps every Phase-1
    // golden byte-identical through this change.
    const anchor = planeAnchor(BOUNDS);
    const eff = effectiveSliceView(viewOf('axial'), anchor, anchor, false);
    expect(eff.camera.center).toEqual([0, 0]);
  });
});

describe('the pane ↔ world mapping (R1, R3)', () => {
  it('does not depend on the cursor in-plane — the scan cannot move when the cursor does', () => {
    const view = viewOf('axial');
    const anchor = planeAnchor(BOUNDS);
    const a = paneToWorld(view, [0, 0, 10], anchor, false, RECT, 100, 250);
    // Move the cursor 40 mm in-plane (axial: x and y are in-plane, z is the normal).
    const b = paneToWorld(view, [37, -3, 10], anchor, false, RECT, 100, 250);
    expect(b[0]).toBeCloseTo(a[0], 9);
    expect(b[1]).toBeCloseTo(a[1], 9);
    // …and the along-normal component still follows the cursor, because the plane is derived from it.
    expect(a[2]).toBeCloseTo(10, 9);
    expect(b[2]).toBeCloseTo(10, 9);
  });

  it('round-trips pixel → world → pixel exactly', () => {
    for (const mode of ['axial', 'coronal', 'sagittal'] as const) {
      for (const rad of [false, true]) {
        const view = viewOf(mode, 0.73, [12, -5]);
        const cursor: vec3 = [3, 26, -16];
        const anchor = planeAnchor(BOUNDS);
        const world = paneToWorld(view, cursor, anchor, rad, RECT, 111, 47);
        const [x, y] = worldToPane(view, cursor, anchor, rad, RECT, world);
        expect(x).toBeCloseTo(111, 9);
        expect(y).toBeCloseTo(47, 9);
      }
    }
  });

  it('moves the cursor by exactly N·mmPerPx along the pane right, in BOTH conventions (§11)', () => {
    // The laterality-safety test of the pointer layer: a drag of N device pixels to the screen-right
    // must move the cursor N·mmPerPx along that pane's own `right`, and the radiological mirror
    // negates `right` — so the same gesture moves the cursor the opposite physical way, which is
    // exactly what the mirrored image under the pointer shows.
    const mm = 0.5;
    const N = 64;
    const anchor = planeAnchor(BOUNDS);
    const cursor: vec3 = [3, 26, -16];
    for (const mode of ['axial', 'coronal', 'sagittal'] as const) {
      for (const rad of [false, true]) {
        const view = viewOf(mode, mm);
        const basis = sliceBasis(view, rad);
        const from = paneToWorld(view, cursor, anchor, rad, RECT, 100, 200);
        const to = paneToWorld(view, cursor, anchor, rad, RECT, 100 + N, 200);
        const d: vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
        expect(dot(d, basis.right)).toBeCloseTo(N * mm, 9);
        // …and nothing along `up` or the normal.
        expect(dot(d, basis.up)).toBeCloseTo(0, 9);
        expect(dot(d, basis.normal)).toBeCloseTo(0, 9);
      }
    }
    // Screen-down is −up, at the same rate.
    const view = viewOf('axial', mm);
    const basis = sliceBasis(view, false);
    const from = paneToWorld(view, cursor, anchor, false, RECT, 100, 200);
    const to = paneToWorld(view, cursor, anchor, false, RECT, 100, 200 + N);
    const d: vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    expect(dot(d, basis.up)).toBeCloseTo(-N * mm, 9);
  });

  it('puts the pane centre on anchor + camera.center', () => {
    const view = viewOf('axial', 0.5, [10, -4]);
    const anchor = planeAnchor(BOUNDS);
    const cursor: vec3 = [50, -50, 7];
    const w = paneToWorld(
      view,
      cursor,
      anchor,
      false,
      RECT,
      RECT.width / 2 - 0.5,
      RECT.height / 2 - 0.5
    );
    const basis = sliceBasis(view, false);
    expect(dot([w[0] - anchor[0], w[1] - anchor[1], w[2] - anchor[2]], basis.right)).toBeCloseTo(
      10,
      9
    );
    expect(dot([w[0] - anchor[0], w[1] - anchor[1], w[2] - anchor[2]], basis.up)).toBeCloseTo(
      -4,
      9
    );
  });
});

describe('worldToPane3D', () => {
  it('projects the eye-space centre to the pane centre and rejects points behind the eye', () => {
    // A trivial view-projection: identity maps world (0,0,0) to NDC (0,0) with w = 1.
    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const p = worldToPane3D(identity, RECT, [0, 0, 0]);
    expect(p).not.toBeNull();
    expect(p![0]).toBeCloseTo(RECT.width / 2 - 0.5, 9);
    expect(p![1]).toBeCloseTo(RECT.height / 2 - 0.5, 9);
    // A matrix whose w row is −z puts a point at +z behind the eye.
    const flipW = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0]);
    expect(worldToPane3D(flipW, RECT, [0, 0, 1])).toBeNull();
  });
});

describe('the mesh-only slice step (R4)', () => {
  it('is 1 mm, not the bbox diagonal / 256', () => {
    // `ernie.msh`'s bounds: the §7.5 rule gave 1.32 mm here, so one wheel notch meant a different
    // distance per file. R4 fixes it at 1 mm, configurable.
    expect(stepMm([0, 0, 1], null, null, BOUNDS)).toBe(MESH_ONLY_STEP_MM);
    expect(MESH_ONLY_STEP_MM).toBe(1);
    expect(stepMm([0, 0, 1], null, null, BOUNDS, 2.5)).toBe(2.5);
    // A volume still wins: the step is that volume's voxel size along the normal.
    const affine = new Float32Array([1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1]);
    expect(stepMm([0, 0, 1], affine, null, BOUNDS)).toBeCloseTo(3, 9);
  });
});
