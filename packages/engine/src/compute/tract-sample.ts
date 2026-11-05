/**
 * §5 rule 2's sampling relay: each step runs on one dataset's worker, and this thread only carries one
 * bounded chunk at a time between them.
 */

import type { TractFieldMeta, TractSampleOpT } from '@tetravox/protocol';
import type { ComputeClient } from '@tetravox/wasm';
import type { TractSampleSpec } from '../scene/types';

export const TRACT_SAMPLE_CHUNK = 1_000_000;

export function needsTangent(op: TractSampleOpT): boolean {
  return op === 'dot' || op === 'abs-dot' || op === 'abs-cross';
}

/** `<source>:<field>:<op>`, where a volume's field is `vol<i>` or `vector`. */
export function tractSampleName(spec: TractSampleSpec, sourceName: string): string {
  const source = sourceName.replace(/\.(nii\.gz|nii|mgz|mgh|nrrd|mha|msh|vtu|vtk)$/i, '');
  const field =
    spec.field?.name ?? (spec.op === 'value' ? `vol${spec.volumeIndex ?? 0}` : 'vector');
  return `${source}:${field}:${spec.op}`;
}

export interface TractRelay {
  tract: ComputeClient;
  tractHandle: number;
  source: ComputeClient;
  sourceHandle: number;
  sourceKind: 'volume' | 'mesh';
  nPoints: number;
  spec: TractSampleSpec;
  name: string;
  units?: string;
  onProgress?: (done: number, total: number) => void;
}

export async function runTractSample(r: TractRelay): Promise<TractFieldMeta> {
  const op = r.spec.op;
  const tangents = needsTangent(op);
  let first = 0;
  for (;;) {
    const count = Math.min(TRACT_SAMPLE_CHUNK, r.nPoints - first);
    const pts = await r.tract.call(`sample:${r.name}:${first}:p`, 'tractPoints', {
      handle: r.tractHandle,
      first,
      count,
      tangents,
    });
    const common = {
      handle: r.sourceHandle,
      points: pts.positions,
      ...(pts.tangents === undefined ? {} : { tangents: pts.tangents }),
      op,
    };
    const res =
      r.sourceKind === 'volume'
        ? await r.source.call(`sample:${r.name}:${first}:s`, 'volumeSample', {
            ...common,
            volumeIndex: r.spec.volumeIndex ?? 0,
            basis: r.spec.basis ?? 'world',
          })
        : await r.source.call(`sample:${r.name}:${first}:s`, 'meshSample', {
            ...common,
            source: r.spec.field?.source ?? 'elm',
            name: r.spec.field?.name ?? '',
          });
    const done = first + count >= r.nPoints;
    const written = await r.tract.call(`sample:${r.name}:${first}:w`, 'tractFieldChunk', {
      handle: r.tractHandle,
      name: r.name,
      ...(r.units === undefined ? {} : { units: r.units }),
      first,
      values: res.values,
      done,
    });
    first += count;
    r.onProgress?.(first, r.nPoints);
    if (done) {
      if (written.field === undefined) throw new Error('tractFieldChunk finished with no field');
      return written.field;
    }
  }
}
