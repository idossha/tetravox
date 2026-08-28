/**
 * §8's **header panel**: `VolumeDataset.headerJson`, verbatim.
 *
 * §4.3 defines the field as "every raw header field, for the UI header panel", and §6.1 reads the
 * raw 348-byte NIfTI header to fill it. That is why the panel matters and why it is not a formatted
 * summary: `AGENTS.md` records that `nib.load(p).header` reports `scl_slope` as **NaN** on
 * `m2m_ernie/T1.nii.gz`, an artefact of `Nifti1Image.from_file_map` calling `set_slope_inter(None,
 * None)`, while the value **on disk is 1.0**. A-SHELL's real-data gate item is exactly that: the
 * header panel on `T1.nii.gz` shows `scl_slope = 1.0`. A panel that pretty-printed a subset, or that
 * re-derived a field from `VolumeDataset.sclSlope`, could not settle that question.
 *
 * So: every key/value the JSON carries, searchable, in the order the header wrote them — plus a raw
 * view for copying the whole thing out. Meshes have no `headerJson`; they get their §4.3 census
 * (nodes, tris, tets, tags, fields) instead of an empty box, because "this dataset has no header" is
 * a worse answer than "here is what this dataset is".
 */

import { useMemo, useState } from 'react';
import type { Dataset } from '@tetravox/engine';
import { formatNumber } from '../../lib/coords';
import { headerDataset } from '../../store/store';
import { useController, useUi } from '../../ui/context';

interface HeaderRow {
  key: string;
  value: string;
}

/** Flatten one level of the header JSON: arrays become `a, b, c`, objects become `k=v` pairs. */
export function headerRows(json: string): HeaderRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  return Object.entries(parsed as Record<string, unknown>).map(([key, value]) => ({
    key,
    value: headerValueText(value),
  }));
}

function headerValueText(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.map((v) => headerValueText(v)).join(', ');
  if (typeof value === 'number') {
    // Integers print as integers; a `scl_slope` of 1 must read `1`, not `1.0000`, so that the gate
    // item "shows the on-disk scl_slope = 1.0" is checked against the number and not its formatting.
    return Number.isInteger(value) ? String(value) : formatNumber(value, 6);
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}=${headerValueText(v)}`)
      .join(' ');
  }
  return String(value);
}

/** The §4.3 census a mesh has instead of a header. */
function meshRows(dataset: Extract<Dataset, { kind: 'mesh' }>): HeaderRow[] {
  const rows: HeaderRow[] = [
    { key: 'nodes', value: dataset.nNodes.toLocaleString() },
    { key: 'triangles', value: dataset.nTris.toLocaleString() },
    { key: 'tetrahedra', value: dataset.nTets.toLocaleString() },
    {
      key: 'tags',
      value: dataset.tags.map((t) => `${t.id}${t.name ? ` ${t.name}` : ''}`).join(', '),
    },
    {
      key: 'fields',
      value:
        dataset.fields.length === 0
          ? '—'
          : dataset.fields.map((f) => `${f.name} (${f.source}, ncomp ${f.ncomp})`).join(', '),
    },
    {
      key: 'bounds',
      value: `${dataset.bounds.min.map((c) => formatNumber(c, 3)).join(' ')} … ${dataset.bounds.max
        .map((c) => formatNumber(c, 3))
        .join(' ')}`,
    },
    {
      key: 'components',
      value: `${dataset.orient.components} (${dataset.orient.openComponents} open, ${dataset.orient.flippedComponents} flipped)`,
    },
  ];
  if (dataset.dataSpace !== undefined) rows.push({ key: 'dataSpace', value: dataset.dataSpace });
  if (dataset.transformedSpace !== undefined) {
    rows.push({ key: 'transformedSpace', value: dataset.transformedSpace });
  }
  if (dataset.opt !== undefined) {
    rows.push({
      key: '.msh.opt',
      value: `${Object.keys(dataset.opt.tagColor).length} tag colours`,
    });
  }
  return rows;
}

export function HeaderPanel(): React.JSX.Element {
  const controller = useController();
  const datasets = useUi((s) => s.datasets);
  const dataset = useUi(headerDataset);
  const [query, setQuery] = useState('');
  const [raw, setRaw] = useState(false);

  const rows = useMemo(() => {
    if (dataset === null) return [];
    return dataset.kind === 'volume' ? headerRows(dataset.headerJson) : meshRows(dataset);
  }, [dataset]);

  const needle = query.trim().toLowerCase();
  const shown =
    needle === ''
      ? rows
      : rows.filter(
          (r) => r.key.toLowerCase().includes(needle) || r.value.toLowerCase().includes(needle)
        );

  return (
    <section data-testid="header-panel" className="px-3 py-2">
      <div className="flex items-baseline gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-tvx-dim">Header</h3>
        <select
          data-testid="header-dataset"
          aria-label="Header dataset"
          className="tvx-input ml-auto max-w-[10rem] text-[10px]"
          value={dataset?.id ?? ''}
          onChange={(e) =>
            controller.setHeaderDataset(e.currentTarget.value === '' ? null : e.currentTarget.value)
          }
        >
          {datasets.length === 0 && <option value="">no dataset</option>}
          {datasets.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>

      {dataset === null ? (
        <p data-testid="header-panel-empty" className="mt-1 text-[10px] text-tvx-dim">
          Open a volume or a mesh to see its raw header.
        </p>
      ) : (
        <>
          <div className="mt-1 flex items-center gap-1.5">
            <input
              data-testid="header-search"
              aria-label="Search header fields"
              placeholder="search…"
              spellCheck={false}
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              className="tvx-input min-w-0 flex-1 text-[10px]"
            />
            {dataset.kind === 'volume' && (
              <button
                type="button"
                data-testid="header-raw-toggle"
                aria-pressed={raw}
                className={raw ? 'tvx-btn tvx-btn-sm tvx-btn-on' : 'tvx-btn tvx-btn-sm'}
                onClick={() => setRaw((value) => !value)}
              >
                Raw
              </button>
            )}
          </div>

          {raw && dataset.kind === 'volume' ? (
            <pre
              data-testid="header-raw"
              className="mt-1 max-h-64 overflow-auto rounded border border-tvx-line bg-tvx-bg/50 p-2 font-mono text-[10px] text-tvx-text"
            >
              {dataset.headerJson}
            </pre>
          ) : shown.length === 0 ? (
            <p data-testid="header-no-match" className="mt-1 text-[10px] text-tvx-dim">
              {rows.length === 0
                ? 'This dataset carries no header fields.'
                : `No header field matches “${query}”.`}
            </p>
          ) : (
            <dl
              data-testid="header-rows"
              className="mt-1 grid grid-cols-[7rem_1fr] gap-x-2 font-mono text-[10px]"
            >
              {shown.map((row) => (
                <div key={row.key} className="contents">
                  <dt data-testid={`header-key-${row.key}`} className="truncate text-tvx-dim">
                    {row.key}
                  </dt>
                  <dd data-testid={`header-value-${row.key}`} className="break-all text-tvx-text">
                    {row.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </>
      )}
    </section>
  );
}
