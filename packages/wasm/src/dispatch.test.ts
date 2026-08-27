/**
 * The worker's pure rules: error mapping (§5 rule 8), transfer lists (§6.4) and the `CutOut` pool
 * arithmetic (§6.4's overflow protocol).
 */

import type { CutCounts } from '@tetravox/protocol';
import { describe, expect, it } from 'vitest';

import { collectTransfers, grownPool, makePool, requiredFrom, toWorkerError } from './dispatch';

describe('toWorkerError', () => {
  it('passes a tvx-wasm rejection through with its §6.5 code', () => {
    expect(toWorkerError({ code: 'unsupported', message: 'two-file NIfTI' })).toEqual({
      code: 'unsupported',
      message: 'two-file NIfTI',
    });
  });

  it('maps a trapped module to `panic`, which is what poisons the instance', () => {
    // A Rust `panic!` on wasm32-unknown-unknown aborts; the worker sees a RuntimeError, not an
    // object with a `code`.
    expect(toWorkerError(new WebAssembly.RuntimeError('unreachable'))).toEqual({
      code: 'panic',
      message: 'unreachable',
    });
    expect(toWorkerError('boom')).toEqual({ code: 'panic', message: 'boom' });
  });

  it('does not accept a made-up code', () => {
    expect(toWorkerError({ code: 'nonsense', message: 'x' }).code).toBe('panic');
  });
});

describe('collectTransfers (§6.4)', () => {
  it('finds every buffer in a SurfacePayload-shaped result, deduplicated', () => {
    const positions = new Float32Array(9);
    const indices = new Uint32Array(3);
    const list = collectTransfers('surface', {
      variant: 'indexed',
      positions,
      normals: new Float32Array(positions.buffer), // same buffer — must appear once
      indices,
      perTag: [{ tag: 1, first: 0, count: 1 }],
    });
    expect(list).toHaveLength(2);
    expect(list).toContain(positions.buffer);
    expect(list).toContain(indices.buffer);
  });

  it('reaches into arrays, which is where CutPayload[] keeps its buffers', () => {
    const a = new Float32Array(3);
    const b = new Uint32Array(2);
    const list = collectTransfers('cut', {
      mode: 'buffers',
      cuts: [{ plane: 0, positions: a, interpNodes: b }],
    });
    expect(new Set(list)).toEqual(new Set([a.buffer, b.buffer]));
  });

  it('transfers nothing on the recycled cut path — the pool stays in the worker', () => {
    expect(collectTransfers('cut', { mode: 'recycled', truncated: false, counts: [] })).toEqual([]);
  });

  it('takes a bare ArrayBuffer, which is what loadVolume returns for `data`', () => {
    const data = new ArrayBuffer(16);
    expect(collectTransfers('loadVolume', { data, meta: { name: 'x' } })).toEqual([data]);
  });
});

describe('the CutOut pool (§6.4)', () => {
  const counts: CutCounts[] = [
    { plane: 0, vertices: 10, triangles: 4, edgeSegments: 6, boundarySegments: 2 },
    { plane: 1, vertices: 6, triangles: 2, edgeSegments: 1, boundarySegments: 9 },
  ];

  it('sums the per-plane requirements, because the arrays are packed plane-major', () => {
    // The two segment arrays are separate, so each must hold the larger of the two totals: 7 edge
    // segments against 11 boundary segments.
    expect(requiredFrom(counts)).toEqual({ vertices: 16, triangles: 6, segments: 11 });
  });

  it('sizes every array by its own stride', () => {
    const p = makePool(16, 6, 11, 2);
    expect(p.positions.length).toBe(48);
    expect(p.interpN.length).toBe(32);
    expect(p.interpT.length).toBe(16);
    expect(p.ownerTet.length).toBe(6);
    expect(p.tag.length).toBe(6);
    expect(p.edgeMask.length).toBe(6);
    expect(p.edgeSegments.length).toBe(66);
    expect(p.boundarySegments.length).toBe(66);
    expect(p.planeOffsets.length).toBe(12);
  });

  it('at least doubles, and jumps straight to a requirement that is bigger than double', () => {
    const small = makePool(4, 4, 4, 1);
    const doubled = grownPool(small, { vertices: 5, triangles: 5, segments: 5 }, 1);
    expect(doubled.interpT.length).toBe(8);
    expect(doubled.tag.length).toBe(8);
    expect(doubled.edgeSegments.length / 6).toBe(8);

    const jumped = grownPool(small, { vertices: 1000, triangles: 2000, segments: 30 }, 1);
    expect(jumped.interpT.length).toBe(1000);
    expect(jumped.tag.length).toBe(2000);
    expect(jumped.edgeSegments.length / 6).toBe(30);
  });

  it('converges from the minimum pool to any requirement in a few doublings', () => {
    let pool = makePool(1, 1, 1, 1);
    const need = { vertices: 70_000, triangles: 63_000, segments: 40_000 };
    let steps = 0;
    while (pool.interpT.length < need.vertices || pool.tag.length < need.triangles) {
      pool = grownPool(pool, need, 1);
      steps += 1;
      expect(steps).toBeLessThan(8);
    }
    expect(pool.interpT.length).toBeGreaterThanOrEqual(need.vertices);
  });
});
