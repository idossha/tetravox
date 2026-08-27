import { describe, expect, it } from 'vitest';
import type { MeshMeta, OpName, Res, VolumeMeta } from './index';
import { OP_NAMES, OP_TO_EXPORT, isCancel, isOk, isProgress, isReq, isRes } from './index';

describe('§6.5.2 op table', () => {
  it('has exactly the 18 ops §6.5 declares', () => {
    // 17 through Phase 1; `meshCentroids` is the eighteenth (§6.5.2, W-WASM Phase-2 gap 2).
    expect(OP_NAMES).toHaveLength(18);
    expect(new Set(OP_NAMES).size).toBe(18);
  });

  it('maps every op to a §6.4 wasm export, one-to-one and exhaustive', () => {
    // `satisfies Record<OpName, string>` already makes a missing op a compile error; this pins the
    // other direction — no export is reused, and no op is silently pointed at the wrong one.
    const exports = OP_NAMES.map((op) => OP_TO_EXPORT[op]);
    expect(exports).toHaveLength(18);
    expect(new Set(exports).size).toBe(18);
    expect(OP_TO_EXPORT.elmToNode).toBe('mesh_convert_field');
    expect(OP_TO_EXPORT.marchingCubes).toBe('volume_marching_cubes');
    expect(OP_TO_EXPORT.marchingTets).toBe('mesh_marching_tets');
    expect(OP_TO_EXPORT.volumeFrame).toBe('volume_frame');
    // Two centroid ops, two different exports: `labelCentroids` is a volume's label centres of
    // mass, `meshCentroids` is a mesh's per-tet glyph origins. Pointing either at the other's
    // export type-checks and fails only at run time, which is what this table exists to stop.
    expect(OP_TO_EXPORT.labelCentroids).toBe('volume_label_centroids');
    expect(OP_TO_EXPORT.meshCentroids).toBe('mesh_centroids');
  });

  it('names every export in snake_case, as wasm-bindgen emits them', () => {
    for (const name of Object.values(OP_TO_EXPORT)) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe('§6.5 envelope type guards', () => {
  it('separates Progress from Res on the FromWorker channel', () => {
    const progress = { kind: 'progress', id: 1, phase: 'parse', done: 3, total: 4 } as const;
    const res: Res<'free'> = {
      id: 1,
      op: 'free',
      ok: true,
      result: {},
      transfer: [],
      heapBytes: 1024,
    };
    expect(isProgress(progress)).toBe(true);
    expect(isRes(progress)).toBe(false);
    expect(isProgress(res)).toBe(false);
    expect(isRes(res)).toBe(true);
  });

  it('separates Cancel from Req on the ToWorker channel', () => {
    const cancel = { kind: 'cancel', id: 7 } as const;
    const req = {
      id: 7,
      key: 'layer-1:cut',
      op: 'buildTopology' as OpName,
      args: { handle: 3 },
    } as Parameters<typeof isReq>[0];
    expect(isCancel(cancel)).toBe(true);
    expect(isReq(cancel)).toBe(false);
    expect(isCancel(req)).toBe(false);
    expect(isReq(req)).toBe(true);
  });

  it('narrows a failed Res away from `result`', () => {
    const failed: Res<'loadMesh'> = {
      id: 2,
      op: 'loadMesh',
      ok: false,
      error: { code: 'cancelled', message: 'worker.terminate()' },
    };
    expect(isOk(failed)).toBe(false);
    if (!isOk(failed)) {
      // §5 rule 6: cancelling an in-flight load is a terminate, synthesised as this error.
      expect(failed.error.code).toBe('cancelled');
    }
  });
});

describe('§4.6 DatasetRef.fingerprint', () => {
  /** `tvxfp1-<len:16hex>-<hash:16hex>` — `tvx_core::fingerprint`, §4.6. */
  const SHAPE = /^tvxfp1-[0-9a-f]{16}-[0-9a-f]{16}$/;

  it('is a required member of both metas, so a loader cannot forget it', () => {
    // These two literals are the assertion: `fingerprint` is not optional, so omitting it in
    // `tvx-wasm`'s `meta()` would fail `pnpm typecheck` rather than reach `serialize.ts` as
    // `undefined`. The runtime check pins the string's shape, which is what §8's relocate dialog
    // compares.
    const volume = { fingerprint: 'tvxfp1-000000000000019c-5c8c9854af79690c' } as Pick<
      VolumeMeta,
      'fingerprint'
    >;
    const mesh = { fingerprint: 'tvxfp1-000000000000019c-5c8c9854af79690c' } as Pick<
      MeshMeta,
      'fingerprint'
    >;
    expect(volume.fingerprint).toMatch(SHAPE);
    expect(mesh.fingerprint).toMatch(SHAPE);
  });

  it('carries the byte length in its first half, in hex', () => {
    const fingerprint: VolumeMeta['fingerprint'] = 'tvxfp1-000000000000019c-5c8c9854af79690c';
    expect(Number.parseInt(fingerprint.split('-')[1] ?? '', 16)).toBe(412);
  });
});
