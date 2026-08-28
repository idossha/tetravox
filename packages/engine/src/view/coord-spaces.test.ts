/**
 * The space-selector policy (`coord-spaces.ts`) — what the menu offers and what it refuses.
 *
 * Every assertion here is a rule from §8 or directed task 8 that no type can enforce: that an
 * unusable space is *listed and disabled with a reason* rather than hidden, that a deformation field
 * never appears in the menu as a volume of its own, that the affine and the nonlinear MNI are two
 * entries and not one, and that a `fromSpace` with nothing to convert with returns null instead of a
 * plausible-looking triple.
 */

import { describe, expect, it } from 'vitest';

import type { Dataset, DatasetId, Layer, Scene, TemplateSpace, mat4, vec3 } from '../scene/types';
import type { CoordSpaceRef } from '../api';
import { invert4 } from './m4';
import {
  coordinateSpaceOptions,
  fromSpace,
  isDeformationField,
  probeSpaces,
  referenceVolume,
  toSpace,
  volumesInMenuOrder,
} from './coord-spaces';

const T1_AFFINE = Float32Array.from([
  0, -1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, -99.737457, 154.1875, -143.642273, 1,
]) as mat4;

function volume(
  id: DatasetId,
  name: string,
  extra: Partial<{ nvols: number; toTemplate: TemplateSpace; data: Float32Array; dims: vec3 }> = {}
): Dataset {
  const dims = extra.dims ?? ([256, 256, 208] as vec3);
  return {
    kind: 'volume',
    id,
    name,
    dims,
    nvols: extra.nvols ?? 1,
    affine: T1_AFFINE,
    inverseAffine: invert4(T1_AFFINE),
    spacing: [1, 1, 1],
    sclSlope: 1,
    sclInter: 0,
    data: extra.data ?? new Float32Array(1),
    ...(extra.toTemplate !== undefined ? { toTemplate: extra.toTemplate } : {}),
  } as unknown as Dataset;
}

function scene(datasets: Dataset[], layerFor: DatasetId[] = [], activeLayerId?: string): Scene {
  const layers: Layer[] = layerFor.map((datasetId, i) => ({
    id: `L${i}`,
    datasetId,
    kind: 'volume',
    name: `layer ${i}`,
    visible: true,
  })) as unknown as Layer[];
  return {
    datasets: new Map(datasets.map((d) => [d.id, d])),
    layers,
    activeLayerId: activeLayerId ?? layers[0]?.id ?? null,
  } as unknown as Scene;
}

describe('volumesInMenuOrder', () => {
  it('puts the active layer’s volume first, then the rest top-to-bottom', () => {
    const s = scene(
      [volume('a', 'T1'), volume('b', 'tissues'), volume('c', 'field')],
      ['a', 'b', 'c'],
      'L1'
    );
    expect(volumesInMenuOrder(s).map((d) => d.name)).toEqual(['tissues', 'field', 'T1']);
  });

  it('still finds a volume that has no layer at all', () => {
    const s = scene([volume('a', 'T1'), volume('warp', 'Conform2MNI_nonl')], ['a']);
    expect(volumesInMenuOrder(s).map((d) => d.id)).toEqual(['a', 'warp']);
  });
});

describe('the menu', () => {
  it('offers world RAS plus a voxel and a tkr entry per volume', () => {
    const s = scene([volume('a', 'T1')], ['a']);
    expect(coordinateSpaceOptions(s).map((o) => o.label)).toEqual([
      'World RAS',
      'Voxel · T1',
      'tkr-RAS · T1',
    ]);
    // §8's copy format: a voxel index is an integer, millimetres get one decimal.
    expect(coordinateSpaceOptions(s).map((o) => o.decimals)).toEqual([1, 0, 1]);
  });

  it('never lists a deformation field as a volume of its own', () => {
    const template: TemplateSpace = {
      name: 'MNI152',
      kind: 'simnibs',
      matrix: invert4(T1_AFFINE),
      hasAffine: false,
      forwardFieldId: 'warp',
    };
    const s = scene(
      [
        volume('a', 'T1', { toTemplate: template }),
        volume('warp', 'Conform2MNI_nonl', { nvols: 3 }),
      ],
      ['a']
    );
    expect(isDeformationField(s, 'warp')).toBe(true);
    expect(referenceVolume(s)?.id).toBe('a');
    expect(coordinateSpaceOptions(s).some((o) => o.label.includes('Conform2MNI'))).toBe(false);
  });

  it('lists affine and nonlinear MNI as two entries, disabling the one that is absent', () => {
    // The SimNIBS 4 shape: a warp, no `MNI2conform_*DOF.txt` at all.
    const template: TemplateSpace = {
      name: 'MNI152',
      kind: 'simnibs',
      matrix: new Float32Array(16) as mat4,
      hasAffine: false,
      nonlinearAvailable: true,
    };
    const s = scene([volume('a', 'T1', { toTemplate: template })], ['a']);
    const opts = coordinateSpaceOptions(s);
    const affine = opts.find((o) => o.ref.space === 'mni-affine');
    const nonl = opts.find((o) => o.ref.space === 'mni-nonlinear');

    // Listed, not hidden — §8's rule, so the absence is visible rather than silent.
    expect(affine?.label).toBe('MNI152 (affine)');
    expect(affine?.enabled).toBe(false);
    expect(affine?.reason).toContain('no MNI2conform');
    // The warp exists on disk but has not been loaded, so the space is **enabled** — selecting it is
    // what starts the load, and a disabled `<option>` can never be selected — and says "loading".
    expect(nonl?.enabled).toBe(true);
    expect(nonl?.loading).toBe(true);
    expect(nonl?.reason).toContain('loading');
    // …but it still cannot convert anything until the field lands.
    expect(toSpace(s, nonl?.ref as CoordSpaceRef, [0, 0, 0])).toBeNull();
  });

  it('disables the nonlinear space for a subject that has no warp at all', () => {
    const template: TemplateSpace = {
      name: 'MNI152',
      kind: 'simnibs',
      matrix: new Float32Array(16) as mat4,
      hasAffine: false,
    };
    const s = scene([volume('a', 'T1', { toTemplate: template })], ['a']);
    const nonl = coordinateSpaceOptions(s).find((o) => o.ref.space === 'mni-nonlinear');
    expect(nonl?.enabled).toBe(false);
    expect(nonl?.reason).toContain('no Conform2MNI_nonl');
  });

  it('enables the nonlinear space once the field dataset is in the scene', () => {
    const template: TemplateSpace = {
      name: 'MNI152',
      kind: 'simnibs',
      matrix: new Float32Array(16) as mat4,
      hasAffine: false,
      forwardFieldId: 'warp',
    };
    const s = scene(
      [
        volume('a', 'T1', { toTemplate: template }),
        volume('warp', 'warp', { nvols: 3, dims: [2, 2, 2], data: new Float32Array(24) }),
      ],
      ['a']
    );
    expect(coordinateSpaceOptions(s).find((o) => o.ref.space === 'mni-nonlinear')?.enabled).toBe(
      true
    );
  });
});

describe('toSpace / fromSpace', () => {
  const s = scene([volume('a', 'T1')], ['a']);

  it('round-trips voxel and tkr', () => {
    const world: vec3 = [-40, -20, 50];
    for (const space of ['voxel', 'tkr'] as const) {
      const ref = { space, datasetId: 'a' } as const;
      const there = toSpace(s, ref, world) as vec3;
      const back = fromSpace(s, ref, there) as vec3;
      for (let i = 0; i < 3; i++) expect(back[i] as number).toBeCloseTo(world[i] as number, 3);
    }
  });

  it('reports the tkr triple nibabel reports', () => {
    // python3: vox2ras_tkr @ inv(affine) @ [-40, -20, 50, 1] on m2m_ernie/T1.nii.gz.
    const got = toSpace(s, { space: 'tkr', datasetId: 'a' }, [-40, -20, 50]) as vec3;
    expect(got[0]).toBeCloseTo(-46.1875, 3);
    expect(got[1]).toBeCloseTo(-44.262543, 3);
    expect(got[2]).toBeCloseTo(-65.642273, 3);
  });

  it('returns null rather than a guess when a ref no longer resolves', () => {
    expect(toSpace(s, { space: 'voxel', datasetId: 'gone' }, [0, 0, 0])).toBeNull();
    expect(fromSpace(s, { space: 'tkr', datasetId: 'gone' }, [0, 0, 0])).toBeNull();
    // An affine-less template cannot answer the affine space in either direction.
    expect(toSpace(s, { space: 'mni-affine', datasetId: 'a' }, [0, 0, 0])).toBeNull();
    // …and a nonlinear space whose warp is not loaded cannot accept typed entry.
    expect(fromSpace(s, { space: 'mni-nonlinear', datasetId: 'a' }, [0, 0, 0])).toBeNull();
  });

  it('world is the identity in both directions', () => {
    expect(toSpace(s, { space: 'world' }, [1, 2, 3])).toEqual([1, 2, 3]);
    expect(fromSpace(s, { space: 'world' }, [1, 2, 3])).toEqual([1, 2, 3]);
  });
});

describe('probeSpaces', () => {
  it('names the volume its tkr triple belongs to', () => {
    const s = scene([volume('a', 'T1')], ['a']);
    const p = probeSpaces(s, [0, 0, 0]);
    expect(p.tkrVolume).toBe('T1');
    expect((p.tkr as vec3)[0]).toBeCloseTo(-26.1875, 3);
    expect(p.mni).toBeUndefined();
    expect(p.mniNonlinear).toBeUndefined();
  });

  it('is empty when nothing is loaded — no volume, no tkr space', () => {
    expect(probeSpaces(scene([]), [0, 0, 0])).toEqual({});
  });
});
