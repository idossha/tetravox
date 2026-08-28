/**
 * The job presets (`automation/presets.ts`).
 *
 * A preset's whole job is to pick numbers from data, so the tests build datasets with *known*
 * distributions and assert the number that comes out — the p90 of a known histogram, the 0.3 the plan
 * gives the scalp — rather than that "a patch was produced".
 */

import { describe, expect, it } from 'vitest';
import type { Dataset, Layer, MeshDataset, MeshLayer, Stats, VolumeLayer } from '@tetravox/engine';
import { TRANSLUCENT_TISSUE_OPACITY, percentileFromHistogram, planPreset } from './presets';

// ------------------------------------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------------------------------------

/** A `Stats` whose histogram is a uniform ramp over `[lo, hi]`, so every percentile is arithmetic. */
function uniformStats(lo: number, hi: number, bins = 256): Stats {
  return {
    min: lo,
    max: hi,
    mean: (lo + hi) / 2,
    percentiles: {
      '0.1': lo,
      '1': lo,
      '2': lo,
      '5': lo,
      '50': (lo + hi) / 2,
      '95': hi,
      '98': hi,
      '99': hi,
      '99.9': hi,
    },
    histogram: new Uint32Array(bins).fill(1000),
    histogramLo: lo,
    histogramHi: hi,
  };
}

function volumeDataset(id: string, name: string, extra: Partial<Dataset> = {}): Dataset {
  return {
    kind: 'volume',
    id,
    name,
    dims: [4, 4, 4],
    nvols: 1,
    stats: uniformStats(0, 1),
    isLabel: false,
    ...extra,
  } as unknown as Dataset;
}

function meshDataset(id: string, name: string, extra: Record<string, unknown> = {}): MeshDataset {
  return {
    kind: 'mesh',
    id,
    name,
    fields: [],
    tags: [],
    ...extra,
  } as unknown as MeshDataset;
}

function volumeLayer(id: string, datasetId: string, name: string): VolumeLayer {
  return {
    id,
    datasetId,
    name,
    kind: 'volume',
    visible: true,
    opacity: 1,
    pickable: true,
    showColorbar: false,
    volumeIndex: 0,
    colormap: 'gray',
    labelMode: 'fill',
    outlineWidthPx: 1,
    interpolation: 'linear',
  } as unknown as VolumeLayer;
}

function meshLayer(id: string, datasetId: string, name: string): MeshLayer {
  return {
    id,
    datasetId,
    name,
    kind: 'mesh',
    visible: true,
    opacity: 1,
    pickable: true,
    showColorbar: false,
    colorMode: 'tag',
    tagStyle: {},
  } as unknown as MeshLayer;
}

function input(
  layers: Layer[],
  datasets: Dataset[]
): {
  layers: Layer[];
  datasets: Map<string, Dataset>;
} {
  return { layers, datasets: new Map(datasets.map((d) => [d.id, d])) };
}

// ------------------------------------------------------------------------------------------------

describe('percentileFromHistogram', () => {
  it('reads a uniform distribution back as a linear map', () => {
    const stats = uniformStats(0, 100);
    expect(percentileFromHistogram(stats, 50)).toBeCloseTo(50, 1);
    expect(percentileFromHistogram(stats, 90)).toBeCloseTo(90, 1);
    expect(percentileFromHistogram(stats, 0)).toBeCloseTo(0, 6);
  });

  it('finds the tail of a skewed distribution, which is the case a TI field actually is', () => {
    // 99 % of the mass in the bottom bin, 1 % in the top: p90 is in the low bin, p99.9 in the high.
    const stats = uniformStats(0, 10);
    stats.histogram = new Uint32Array(256);
    stats.histogram[0] = 9900;
    stats.histogram[255] = 100;
    expect(percentileFromHistogram(stats, 90)).toBeLessThan(0.05);
    expect(percentileFromHistogram(stats, 99.9)).toBeGreaterThan(9.9);
  });

  it('answers `min` for an empty histogram rather than NaN', () => {
    const stats = uniformStats(3, 4);
    stats.histogram = new Uint32Array(256);
    expect(percentileFromHistogram(stats, 90)).toBe(3);
  });
});

describe('plain', () => {
  it('changes nothing — "load it and leave it alone"', () => {
    const plan = planPreset(
      'plain',
      input([volumeLayer('l1', 'd1', 'T1.nii.gz')], [volumeDataset('d1', 'T1.nii.gz')])
    );
    expect(plan).toEqual({ patches: [], order: [], warnings: [] });
  });
});

describe('ti-field-on-t1', () => {
  const t1 = volumeDataset('d1', 'T1.nii.gz');
  const field = volumeDataset('d2', 'Thalamus_TI_subject_TI_max.nii.gz', {
    stats: uniformStats(0, 10),
  } as Partial<Dataset>);
  const layers = [volumeLayer('l1', 'd1', 'T1.nii.gz'), volumeLayer('l2', 'd2', 'TI_max')];

  it('greys the anatomy and heats the field', () => {
    const plan = planPreset('ti-field-on-t1', input(layers, [t1, field]));
    expect(plan.warnings).toEqual([]);
    const [base, overlay] = plan.patches;
    expect(base).toEqual({ layerId: 'l1', patch: { colormap: 'gray', opacity: 1, visible: true } });
    expect(overlay?.layerId).toBe('l2');
    expect((overlay?.patch as VolumeLayer).colormap).toBe('hot');
    expect((overlay?.patch as VolumeLayer).showColorbar).toBe(true);
  });

  it('thresholds at the field’s OWN 90th percentile, not at a typed-in number', () => {
    const plan = planPreset('ti-field-on-t1', input(layers, [t1, field]));
    const patch = plan.patches[1]?.patch as VolumeLayer;
    // A uniform 0…10 field: p90 is 9.
    expect(patch.threshold.lo).toBeCloseTo(9, 1);
    expect(patch.threshold.mode).toBe('hide');
    expect(patch.scale.kind).toBe('heat');
    if (patch.scale.kind === 'heat') {
      expect(patch.scale.min).toBeCloseTo(9, 1);
      expect(patch.scale.max).toBeCloseTo(9.99, 1);
      expect(patch.scale.max).toBeGreaterThan(patch.scale.min);
    }
  });

  it('scales a different field to different numbers', () => {
    const weak = volumeDataset('d3', 'weak_TI_max.nii.gz', {
      stats: uniformStats(0, 0.5),
    } as Partial<Dataset>);
    const plan = planPreset(
      'ti-field-on-t1',
      input([volumeLayer('l1', 'd1', 'T1'), volumeLayer('l3', 'd3', 'weak')], [t1, weak])
    );
    expect((plan.patches[1]?.patch as VolumeLayer).threshold.lo).toBeCloseTo(0.45, 2);
  });

  it('never produces a zero-width scale, even for a constant field', () => {
    const flat = volumeDataset('d4', 'flat_TI_max.nii.gz', {
      stats: uniformStats(2, 2),
    } as Partial<Dataset>);
    const plan = planPreset('ti-field-on-t1', input([volumeLayer('l4', 'd4', 'flat')], [flat]));
    const scale = (plan.patches[0]?.patch as VolumeLayer).scale;
    if (scale.kind === 'heat') expect(scale.max).toBeGreaterThan(scale.min);
  });

  it('takes the field off a MESH when there is no field volume — the plan names both', () => {
    const mesh = meshDataset('d5', 'Thalamus_TI.msh', {
      fields: [
        {
          name: 'TI_max',
          source: 'elm',
          ncomp: 1,
          n: 10,
          partial: false,
          stats: uniformStats(0, 10),
        },
      ],
    });
    const plan = planPreset(
      'ti-field-on-t1',
      input([volumeLayer('l1', 'd1', 'T1'), meshLayer('l5', 'd5', 'Thalamus_TI.msh')], [t1, mesh])
    );
    const patch = plan.patches[1]?.patch as MeshLayer;
    expect(patch.colorMode).toBe('field');
    expect(patch.field).toEqual({ source: 'elm', name: 'TI_max', component: 'mag' });
  });

  it('puts the anatomy under the field, whatever order they were opened in', () => {
    const reversed = [volumeLayer('l2', 'd2', 'TI_max'), volumeLayer('l1', 'd1', 'T1.nii.gz')];
    expect(planPreset('ti-field-on-t1', input(reversed, [t1, field])).order).toEqual(['l1', 'l2']);
  });

  it('warns rather than throwing when there is no field to draw', () => {
    const plan = planPreset('ti-field-on-t1', input([volumeLayer('l1', 'd1', 'T1')], [t1]));
    expect(plan.patches).toEqual([]);
    expect(plan.warnings[0]).toContain('no TI field found');
  });
});

describe('mesh-tissues-translucent', () => {
  it('is the plan’s numbers: scalp 0.3, bone 0.5, opaque GM and WM', () => {
    expect(TRANSLUCENT_TISSUE_OPACITY[5]).toBe(0.3);
    expect(TRANSLUCENT_TISSUE_OPACITY[1005]).toBe(0.3);
    expect(TRANSLUCENT_TISSUE_OPACITY[7]).toBe(0.5);
    expect(TRANSLUCENT_TISSUE_OPACITY[1008]).toBe(0.5);
    expect(TRANSLUCENT_TISSUE_OPACITY[2]).toBe(1);
    expect(TRANSLUCENT_TISSUE_OPACITY[1001]).toBe(1);
  });

  it('styles only the tags the mesh actually has', () => {
    const mesh = meshDataset('d1', 'ernie.msh', {
      // A mesh with scalp and GM but no bone: tag 4 is absent from the real census too.
      tags: [
        { id: 1005, kind: 'tri', count: 1, color: [0, 0, 0, 1] },
        { id: 1002, kind: 'tri', count: 1, color: [0, 0, 0, 1] },
      ],
    });
    const plan = planPreset(
      'mesh-tissues-translucent',
      input([meshLayer('l1', 'd1', 'ernie.msh')], [mesh])
    );
    const patch = plan.patches[0]?.patch as MeshLayer;
    expect(Object.keys(patch.tagStyle).sort()).toEqual(['1002', '1005']);
    expect(patch.tagStyle[1005]?.opacity).toBe(0.3);
    expect(patch.tagStyle[1002]?.opacity).toBe(1);
    // A translucent shell with back faces culled shows the inside of the head through the front.
    expect(patch.faceMode).toBe('both');
  });

  it('warns when there is no mesh to style', () => {
    const plan = planPreset(
      'mesh-tissues-translucent',
      input([volumeLayer('l1', 'd1', 'T1')], [volumeDataset('d1', 'T1.nii.gz')])
    );
    expect(plan.warnings[0]).toContain('no mesh layer');
  });
});

describe('atlas-outline', () => {
  it('outlines the LABEL volume — chosen by the header flag, not by its name', () => {
    const t1 = volumeDataset('d1', 'T1.nii.gz');
    const atlas = volumeDataset('d2', 'labeling.nii.gz', { isLabel: true } as Partial<Dataset>);
    const plan = planPreset(
      'atlas-outline',
      input(
        [volumeLayer('l1', 'd1', 'T1.nii.gz'), volumeLayer('l2', 'd2', 'labeling.nii.gz')],
        [t1, atlas]
      )
    );
    const patch = plan.patches[1]?.patch as VolumeLayer;
    expect(plan.patches[1]?.layerId).toBe('l2');
    expect(patch.labelMode).toBe('outline');
    // A label volume interpolated linearly invents label ids that are not in the file.
    expect(patch.interpolation).toBe('nearest');
    expect(plan.order).toEqual(['l1', 'l2']);
  });

  it('warns when nothing loaded is a label volume', () => {
    const plan = planPreset(
      'atlas-outline',
      input([volumeLayer('l1', 'd1', 'T1')], [volumeDataset('d1', 'T1.nii.gz')])
    );
    expect(plan.warnings[0]).toContain('no label volume');
  });
});
