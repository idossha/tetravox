/**
 * The points parsers, against the shapes the reference dataset actually contains.
 *
 * The two rows quoted here are transcribed from
 * `m2m_ernie/eeg_positions/easycap_BC_TMS64_X21.csv` and `EEG10-10_Cutini_2011.csv`. The trap they
 * pin: the file has **no header** and its first column is a *type*, not a coordinate — so a parser
 * that treats every line as `x,y,z` reads the reference electrode's type string as an x of `NaN`
 * and plants a point at the origin.
 */

import { describe, expect, it } from 'vitest';
import { parsePoints, parsePointsCsv, parsePointsJson } from './points-source';

const SIMNIBS = `ReferenceElectrode,2.182542192384508,22.01588488214105,98.26506048178896,reference
Electrode,3.1580753497774077,2.5861636926470153,99.89741319823554,1
Electrode,3.354689916258697,41.9468998394212,95.30868633864495,2
`;

describe('parsePointsCsv', () => {
  it('reads SimNIBS `eeg_positions/*.csv`: type, x, y, z, name — reference row included', () => {
    const pts = parsePointsCsv(SIMNIBS);
    expect(pts).toHaveLength(3);
    expect(pts[0]?.name).toBe('reference');
    expect(pts[0]?.position[0]).toBeCloseTo(2.182542192384508, 12);
    expect(pts[0]?.position[2]).toBeCloseTo(98.26506048178896, 12);
    expect(pts[1]?.name).toBe('1');
    expect(pts[2]?.position[1]).toBeCloseTo(41.9468998394212, 12);
  });

  it('reads a 10-10 net row, whose name is a label rather than an index', () => {
    const pts = parsePointsCsv(
      'Electrode,-24.3288540915789,113.26339254097407,22.05214801443279,Fp1'
    );
    expect(pts).toEqual([
      { position: [-24.3288540915789, 113.26339254097407, 22.05214801443279], name: 'Fp1' },
    ]);
  });

  it('reads a generic `x,y,z[,name]` file and skips its header, comments and blank lines', () => {
    const pts = parsePointsCsv('# roi\nx,y,z,name\n1,2,3,a\n\n4,5,6\n');
    expect(pts).toEqual([{ position: [1, 2, 3], name: 'a' }, { position: [4, 5, 6] }]);
  });

  it('skips a row whose type is recognised but whose coordinates are not numbers', () => {
    expect(parsePointsCsv('Electrode,nope,2,3,x')).toEqual([]);
  });
});

describe('parsePointsJson', () => {
  it('reads a bare array of triples', () => {
    expect(parsePointsJson('[[1,2,3],[4,5,6]]')).toEqual([
      { position: [1, 2, 3] },
      { position: [4, 5, 6] },
    ]);
  });

  it('reads objects, under `points`, with name / colour / radius', () => {
    const pts = parsePointsJson(
      '{"points":[{"position":[1,2,3],"name":"M1","color":[1,0,0,1],"radiusMm":6},{"coords":[7,8,9]}]}'
    );
    expect(pts).toEqual([
      { position: [1, 2, 3], name: 'M1', color: [1, 0, 0, 1], radiusMm: 6 },
      { position: [7, 8, 9] },
    ]);
  });

  it('is total on malformed input rather than throwing into a render', () => {
    expect(parsePointsJson('not json')).toEqual([]);
    expect(parsePointsJson('[{"position":[1,2]},{"position":"x"},7]')).toEqual([]);
  });
});

describe('parsePoints', () => {
  it('routes on the file extension', () => {
    expect(parsePoints('rois.json', '[[1,2,3]]')).toHaveLength(1);
    expect(parsePoints('GSN-HydroCel-256.csv', SIMNIBS)).toHaveLength(3);
  });
});
