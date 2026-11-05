/** The `tracts` editor's pure logic (§4.4). Nothing here touches the engine. */

import type {
  Dataset,
  Layer,
  Threshold,
  TractFieldInfo,
  TractogramDataset,
  TractSampleSpec,
  TractsLayer,
} from '@tetravox/engine';
import { tractFieldScale } from '@tetravox/engine';

export const OPEN_THRESHOLD: Threshold = {
  lo: Number.NEGATIVE_INFINITY,
  hi: Number.POSITIVE_INFINITY,
  symmetric: false,
  mode: 'clamp',
  softEdge: 0,
};

/** "displaying N of M" while N < M, in the file's own unit. */
export function displayedText(ds: TractogramDataset): string {
  const n = ds.nStreamlines.toLocaleString();
  const m = ds.sourceStreamlines.toLocaleString();
  const pts = ds.nPoints.toLocaleString();
  if (ds.nStreamlines < ds.sourceStreamlines) {
    return `displaying ${n} of ${m} streamlines · ${pts} points`;
  }
  return `${n} streamlines · ${pts} points`;
}

export function tractsSummary(dataset: Dataset, layer: Layer): string {
  if (layer.kind !== 'tracts' || dataset.kind !== 'tractogram') return layer.kind;
  const field =
    layer.colorMode === 'vertex' || layer.colorMode === 'streamline' ? layer.field : null;
  return `${displayedText(dataset)} · ${field ?? layer.colorMode}`;
}

/** Fields a colour mode can read. */
export function fieldsFor(ds: TractogramDataset, mode: TractsLayer['colorMode']): TractFieldInfo[] {
  if (mode === 'vertex') return ds.vertexFields;
  if (mode === 'streamline') return ds.streamlineFields;
  return [];
}

/** A mode change lands on a field of that mode, at that field's own window. */
export function selectMode(
  layer: TractsLayer,
  ds: TractogramDataset,
  colorMode: TractsLayer['colorMode']
): Partial<TractsLayer> {
  const fields = fieldsFor(ds, colorMode);
  if (fields.length === 0) return { colorMode, threshold: OPEN_THRESHOLD };
  const field = fields.find((f) => f.name === layer.field) ?? fields[0];
  return field === undefined ? { colorMode } : selectField(colorMode, field);
}

export function selectField(
  colorMode: TractsLayer['colorMode'],
  field: TractFieldInfo
): Partial<TractsLayer> {
  return {
    colorMode,
    field: field.name,
    scale: tractFieldScale(field),
    threshold: OPEN_THRESHOLD,
  };
}

/** Streamline fields that can name groups, plus the file's own when it has any. */
export function groupSources(ds: TractogramDataset): { value: string; label: string }[] {
  const own = ds.groups.length > 0 ? [{ value: '', label: 'file groups' }] : [];
  return [
    ...own,
    ...ds.streamlineFields
      .filter((f) => f.categorical === true)
      .map((f) => ({ value: f.name, label: f.name })),
  ];
}

export function toggleGroup(
  all: readonly number[],
  visible: readonly number[] | undefined,
  id: number
): number[] | undefined {
  const shown = new Set(visible ?? all);
  if (shown.has(id)) shown.delete(id);
  else shown.add(id);
  return shown.size === all.length ? undefined : all.filter((g) => shown.has(g));
}

/** What a dataset can be sampled for: one row per (field, op) the source's shape allows. */
export interface SampleChoice {
  key: string;
  label: string;
  spec: Omit<TractSampleSpec, 'tractogramId'>;
}

const VECTOR_OPS: { op: TractSampleSpec['op']; label: string }[] = [
  { op: 'magnitude', label: 'magnitude' },
  { op: 'dot', label: 'v·t' },
  { op: 'abs-dot', label: '|v·t|' },
  { op: 'abs-cross', label: '|v×t|' },
];

export function sampleChoices(source: Dataset): SampleChoice[] {
  if (source.kind === 'volume') {
    const rows: SampleChoice[] = [];
    const frames = Math.min(source.nvols, 16);
    for (let i = 0; i < frames; i += 1) {
      rows.push({
        key: `v${i}`,
        label: source.nvols > 1 ? `frame ${i}` : 'value',
        spec: { sourceId: source.id, volumeIndex: i, op: 'value' },
      });
    }
    if (source.nvols === 3) {
      for (const { op, label } of VECTOR_OPS) {
        rows.push({
          key: `vec-${op}`,
          label: `vector ${label}`,
          spec: { sourceId: source.id, op, basis: 'world' },
        });
      }
    }
    return rows;
  }
  if (source.kind === 'mesh' && source.nTets > 0) {
    return source.fields.flatMap((f): SampleChoice[] => {
      const field = { source: f.source, name: f.name };
      if (f.ncomp === 1) {
        return [
          {
            key: `${f.source}:${f.name}`,
            label: `${f.name} (${f.source})`,
            spec: { sourceId: source.id, field, op: 'value' },
          },
        ];
      }
      if (f.ncomp !== 3) return [];
      return VECTOR_OPS.map(({ op, label }) => ({
        key: `${f.source}:${f.name}:${op}`,
        label: `${f.name} (${f.source}) ${label}`,
        spec: { sourceId: source.id, field, op },
      }));
    });
  }
  return [];
}
