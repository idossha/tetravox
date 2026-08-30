/**
 * `ContactSet` ⇄ `PointsLayer`, and §13.2's degradation contract (§13.4).
 *
 * The last test here is the one that matters most: a scene re-saved by a build that never had this
 * module keeps the layer and drops the block, and what the module can rebuild from the layer alone
 * — and what it honestly cannot — is written down as an assertion rather than as a promise.
 */

import { describe, expect, it } from 'vitest';
import type { Layer, PointsLayer, vec3 } from '@tetravox/engine';
import type { Contact, ContactSet } from './model';
import {
  CONTACT_LAYER_STYLE,
  contactLayerName,
  contactSetFromLayer,
  ctDisplayPreset,
  GHOST_OPACITY,
  layerPatch,
  namePadOfLayer,
  pointsOf,
  shaftSegments,
} from './layer';
import { paletteColor } from './palette';

function contact(id: string, group: string, ordinal: number, position: vec3): Contact {
  return {
    id,
    name: `${group}${String(ordinal).padStart(2, '0')}`,
    group,
    ordinal,
    position,
    original: [...position] as vec3,
    loadedStatus: null,
    extra: {},
  };
}

const SET: ContactSet = {
  contacts: [
    // Deliberately not in ordinal order: the array is drawing order, the ordinal is anatomy.
    contact('c2', 'A', 2, [0, 0, 3.5]),
    contact('c1', 'A', 1, [0, 0, 0]),
    contact('c3', 'B', 1, [5, 0, 0]),
    contact('c4', 'B', 2, [5, 0, 3.5]),
  ],
  groups: [
    { name: 'A', color: paletteColor(0), tip: 'auto' },
    { name: 'B', color: paletteColor(1), tip: 'auto' },
  ],
};

describe('pointsOf', () => {
  it('carries id / name / group / ordinal and the group’s colour, in the set’s order', () => {
    const points = pointsOf(SET);
    expect(points.map((p) => p.id)).toEqual(['c2', 'c1', 'c3', 'c4']);
    expect(points[0]).toMatchObject({ name: 'A02', group: 'A', ordinal: 2 });
    expect(points[0]?.color).toEqual(paletteColor(0));
    expect(points[2]?.color).toEqual(paletteColor(1));
  });

  it('copies the position, so an edit to the layer cannot reach back into the set', () => {
    const points = pointsOf(SET);
    (points[1] as { position: vec3 }).position[2] = 99;
    expect((SET.contacts[1] as Contact).position[2]).toBe(0);
  });
});

describe('shaftSegments', () => {
  it('joins consecutive ORDINALS, not consecutive array entries', () => {
    const segments = shaftSegments(SET);
    // Two groups of two contacts: one segment each, six floats per segment.
    expect(segments).toHaveLength(12);
    // A: ordinal 1 at the origin to ordinal 2 at z = 3.5 — the array had them the other way round.
    expect(Array.from(segments.slice(0, 6))).toEqual([0, 0, 0, 0, 0, 3.5]);
    expect(Array.from(segments.slice(6))).toEqual([5, 0, 0, 5, 0, 3.5]);
  });

  it('is empty for a group with one contact', () => {
    expect(
      shaftSegments({ contacts: [contact('c1', 'A', 1, [0, 0, 0])], groups: SET.groups })
    ).toHaveLength(0);
  });
});

describe('layerPatch', () => {
  it('switches the ghost between Slicer’s 0.6 and §7.2’s plain cull', () => {
    expect(layerPatch(SET, true).offPlaneOpacity).toBe(GHOST_OPACITY);
    // 0, not `undefined`: absent would leave whatever the layer already had.
    expect(layerPatch(SET, false).offPlaneOpacity).toBe(0);
  });

  it('is the whole of what an edit changes on the layer', () => {
    expect(Object.keys(layerPatch(SET, true)).sort()).toEqual([
      'lineSegments',
      'offPlaneOpacity',
      'points',
    ]);
  });
});

describe('the layer style and the CT preset', () => {
  it('is a dot at 1.5 mm with names and the ghost, per §4.4', () => {
    expect(CONTACT_LAYER_STYLE).toMatchObject({
      kind: 'points',
      shape: 'dot',
      radiusMm: 1.5,
      showLabels: true,
      labelSource: 'names',
      offPlaneOpacity: GHOST_OPACITY,
    });
  });

  it('hides below 150 HU rather than clamping, so the T1 shows through', () => {
    const preset = ctDisplayPreset();
    expect(preset.colormap).toBe('gray');
    expect(preset.opacity).toBe(1);
    expect(preset.threshold.lo).toBe(150);
    expect(preset.threshold.mode).toBe('hide');
    expect(preset.threshold.hi).toBe(Infinity);
  });

  it('names the layer after the table it came from', () => {
    expect(contactLayerName('sub-P076_space-T1w_electrodes')).toBe(
      'Contacts · sub-P076_space-T1w_electrodes'
    );
    expect(contactLayerName('')).toBe('Contacts · untitled');
  });
});

describe('contactSetFromLayer — §13.2’s degradation contract', () => {
  const layer: PointsLayer = {
    id: 'l1',
    datasetId: 'ds1',
    name: 'Contacts · sub-01',
    visible: true,
    opacity: 1,
    pickable: false,
    showColorbar: false,
    module: 'tetravox.seeg',
    kind: 'points',
    points: pointsOf(SET),
    shape: 'dot',
    radiusMm: 1.5,
    color: [1, 1, 1, 1],
    showLabels: true,
  };

  it('recovers every contact, its electrode and its number', () => {
    const rebuilt = contactSetFromLayer(layer);
    expect(rebuilt.contacts.map((c) => c.name)).toEqual(['A02', 'A01', 'B01', 'B02']);
    expect(rebuilt.contacts.map((c) => c.ordinal)).toEqual([2, 1, 1, 2]);
    expect(rebuilt.groups.map((g) => g.name)).toEqual(['A', 'B']);
    expect(namePadOfLayer(layer)).toBe(2);
  });

  it('cannot recover provenance, and says so with a null rather than a guess', () => {
    // Every `original` is null, which is what makes the panel say "provenance unknown" and Save
    // become Save as… — a rebuilt set that claimed its positions were the file's would write a
    // table in which nothing had ever been edited.
    for (const rebuilt of contactSetFromLayer(layer).contacts) {
      expect(rebuilt.original).toBeNull();
      expect(rebuilt.extra).toEqual({});
    }
  });

  it('falls back to the name when a point carries no group or ordinal', () => {
    const bare: PointsLayer = {
      ...layer,
      points: [
        { name: 'LHIP8', position: [0, 0, 0] },
        { name: 'LHIP9', position: [0, 0, 1] },
      ],
    };
    const rebuilt = contactSetFromLayer(bare);
    expect(rebuilt.groups.map((g) => g.name)).toEqual(['LHIP']);
    expect(rebuilt.contacts.map((c) => c.ordinal)).toEqual([8, 9]);
    expect(rebuilt.contacts.map((c) => c.id)).toEqual(['p0', 'p1']);
  });

  it('is empty for a layer that is not a points layer', () => {
    const volume = { ...layer, kind: 'volume' } as unknown as Layer;
    expect(contactSetFromLayer(volume).contacts).toEqual([]);
    expect(namePadOfLayer(volume)).toBe(2);
  });
});
