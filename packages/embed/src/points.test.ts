/**
 * The host vocabulary a points layer carries, and what it resolves to (`points.ts`, protocol 2).
 *
 * These are the two translations `load` and `setPoints` both run, so they are asserted here rather
 * than only through a browser: a `state` that resolved to the wrong colour is a wrong *picture*, and
 * §11's rule is that the number comes first. The e2e then reads the resolved colour back off the
 * framebuffer, which is what proves the two halves meet.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STATE_COLORS,
  isPointsLayer,
  labelFieldsFor,
  resolvePoint,
  resolvePointsLayer,
  stateColorsOf,
} from './points';
import type { EmbedPointsLayer } from './protocol';

const LAYER: EmbedPointsLayer = {
  id: 'l2',
  datasetId: 'd1',
  kind: 'points',
  points: [
    { id: 'E1', position: [1, 2, 3] },
    { id: 'E2', position: [4, 5, 6], state: 'selected' },
    { id: 'E3', position: [7, 8, 9], state: 'disabled' },
    { id: 'E4', position: [0, 0, 0], state: 'idle' },
  ],
};

describe('resolvePoint', () => {
  it('leaves a point with no state exactly as it was', () => {
    const point = { id: 'E1', position: [1, 2, 3] as [number, number, number] };
    expect(resolvePoint(point, undefined)).toBe(point);
  });

  it("treats 'idle' as no state at all", () => {
    // An idle point is the layer's own colour, whatever the host set it to. Painting one here would
    // override a host that coloured its whole net blue.
    const point = {
      id: 'E4',
      position: [0, 0, 0] as [number, number, number],
      state: 'idle' as const,
    };
    expect(resolvePoint(point, undefined)).toBe(point);
  });

  it('paints the documented default for selected and disabled', () => {
    expect(resolvePoint({ position: [0, 0, 0], state: 'selected' }, undefined).color).toEqual(
      DEFAULT_STATE_COLORS.selected
    );
    expect(resolvePoint({ position: [0, 0, 0], state: 'disabled' }, undefined).color).toEqual(
      DEFAULT_STATE_COLORS.disabled
    );
  });

  it("prefers the layer's own palette", () => {
    const colors = { selected: [0, 1, 0, 1] as const };
    expect(
      resolvePoint({ position: [0, 0, 0], state: 'selected' }, { selected: [0, 1, 0, 1] }).color
    ).toEqual(colors.selected);
  });

  it('lets an explicit colour win, because specific beats shorthand', () => {
    const point = {
      position: [0, 0, 0] as [number, number, number],
      state: 'selected' as const,
      color: [1, 0, 1, 1] as [number, number, number, number],
    };
    expect(resolvePoint(point, { selected: [0, 1, 0, 1] })).toBe(point);
  });

  it('keeps the state on the point it resolved', () => {
    // The engine carries an unknown per-point key the way it carries `group`, so a host reads a
    // point's state back off a `layers` event rather than remembering which ids it dimmed.
    expect(resolvePoint({ position: [0, 0, 0], state: 'disabled' }, undefined).state).toBe(
      'disabled'
    );
  });
});

describe('labelFieldsFor', () => {
  it('maps the three modes onto §4.4s pair', () => {
    expect(labelFieldsFor('none')).toEqual({ showLabels: false });
    expect(labelFieldsFor(undefined)).toEqual({ showLabels: false });
    expect(labelFieldsFor('names')).toEqual({ showLabels: true, labelSource: 'names' });
    expect(labelFieldsFor('labels')).toEqual({ showLabels: true, labelSource: 'labels' });
  });
});

describe('resolvePointsLayer', () => {
  it('resolves every point and leaves the rest of the layer alone', () => {
    const out = resolvePointsLayer({ ...LAYER, color: [0, 0, 1, 1], radiusMm: 6 });
    expect(out['id']).toBe('l2');
    expect(out['datasetId']).toBe('d1');
    expect(out['kind']).toBe('points');
    expect(out['radiusMm']).toBe(6);
    const points = out['points'] as { id: string; color?: number[] }[];
    expect(points.map((p) => p.color)).toEqual([
      undefined,
      DEFAULT_STATE_COLORS.selected,
      DEFAULT_STATE_COLORS.disabled,
      undefined,
    ]);
  });

  it('spends labelMode and keeps stateColors', () => {
    // `labelMode` IS `showLabels` + `labelSource`, so leaving it would put two spellings of one rule
    // on one object. `stateColors` has no §4.4 twin and is the only place a later `setPoints` can
    // read the host's palette back from.
    const out = resolvePointsLayer({
      ...LAYER,
      labelMode: 'names',
      stateColors: { selected: [0, 1, 0, 1] },
    });
    expect(out['labelMode']).toBeUndefined();
    expect(out['showLabels']).toBe(true);
    expect(out['labelSource']).toBe('names');
    expect(out['stateColors']).toEqual({ selected: [0, 1, 0, 1] });
    expect((out['points'] as { color?: number[] }[])[1]?.color).toEqual([0, 1, 0, 1]);
  });

  it('says nothing about labels when the host said nothing', () => {
    // Absent must reproduce the previous behaviour (§12.3): a layer with no `labelMode` gets no
    // `showLabels` key at all, so §4.4's own default — and a parsed view's `showLabels: true` seed —
    // still decides.
    const out = resolvePointsLayer(LAYER);
    expect('showLabels' in out).toBe(false);
    expect('labelSource' in out).toBe(false);
  });

  it('accepts a layer with no points', () => {
    expect(
      resolvePointsLayer({ id: 'l', datasetId: 'd', kind: 'points', points: [] })['points']
    ).toEqual([]);
  });
});

describe('stateColorsOf', () => {
  it('reads the palette back off a live layer', () => {
    const live = resolvePointsLayer({ ...LAYER, stateColors: { disabled: [0.1, 0.2, 0.3, 1] } });
    expect(stateColorsOf(live)).toEqual({ disabled: [0.1, 0.2, 0.3, 1] });
  });

  it('is undefined for a layer that never named one, and for a non-layer', () => {
    expect(stateColorsOf(resolvePointsLayer(LAYER))).toBeUndefined();
    expect(stateColorsOf(null)).toBeUndefined();
    expect(stateColorsOf('layer')).toBeUndefined();
  });
});

describe('isPointsLayer', () => {
  it('picks the points layers out of a mixed spec', () => {
    expect(isPointsLayer({ kind: 'points' })).toBe(true);
    expect(isPointsLayer({ kind: 'volume' })).toBe(false);
    expect(isPointsLayer({})).toBe(false);
  });
});
