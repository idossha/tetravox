/**
 * The Region panel — maintainer requirement **R5**, and §8's "region panel".
 *
 * R5: "One **Region panel** for every labelled thing: label volumes (atlases/tissue maps), mesh
 * tissue tags (`tagStyle`), surface annotations (`.annot` / `.label.gii` via `colorMode:'label'`).
 * Rows: eye (show/hide), colour swatch (colour picker), opacity, name, id, count. Search-as-you-type;
 * click = select/highlight; ⇧/⌘-click multi-select; Alt-click = **solo** (mute all others); "Show all
 * / Hide all / Invert"; double-click = jump the cursor to the region centroid. Clicking a labelled
 * voxel / tissue in a pane selects that row (Freeview behaviour)."
 *
 * All three sources are flattened to `RegionRow[]` by `./regions.ts`, and every gesture below is one
 * pure function from that module plus one `controller.patchLayer` / `setCursorWorld` call — §8:
 * "everything the UI can do must be reachable from the `Engine` API alone. No logic in React."
 *
 * All three sources are fully editable: `VolumeLayer.labelColors`, `MeshLayer.tagStyle[t].color` and
 * the `LabelTable` on `MeshLayer.label` (§4.4), so a recolour is a layer patch in every case and
 * survives save/load. `data-recolorable` stays in the DOM because an *annot with no table* still has
 * nowhere to put one.
 *
 * Counts and centroids come from §4.7's `labelCentroids`, asked for once per layer on mount; a row
 * renders `—` and refuses the centroid jump only while that answer is outstanding or empty.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { LayerId } from '@tetravox/engine';
import { useController, useUi } from '../../ui/context';
import {
  EMPTY_SELECTION,
  bulkVisible,
  colorPatch,
  filterRows,
  fromHex,
  opacityPatch,
  probedRegionId,
  regionSourceFor,
  selectOnClick,
  soloVisible,
  toHex,
  toggledVisible,
  visibilityPatch,
} from './regions';
import type { BulkOp, RegionRow, RegionSource } from './regions';

export interface RegionPanelProps {
  /** The label volume, mesh or `.annot` layer whose table is being browsed. */
  layerId: LayerId;
}

const BULK: readonly { op: BulkOp; label: string }[] = [
  { op: 'showAll', label: 'Show all' },
  { op: 'hideAll', label: 'Hide all' },
  { op: 'invert', label: 'Invert' },
];

export function RegionPanel({ layerId }: RegionPanelProps): React.JSX.Element | null {
  const controller = useController();
  const [query, setQuery] = useState('');

  const layer = useUi((s) => s.layers.find((l) => l.id === layerId));
  const dataset = useUi((s) => s.datasets.find((d) => d.id === layer?.datasetId));
  const stats = useUi((s) => s.regionStats[layerId]);
  const selection = useUi((s) => s.regionSelection[layerId]) ?? EMPTY_SELECTION;
  const cursorProbe = useUi((s) => s.cursorProbe);

  const source: RegionSource | null = useMemo(
    () =>
      layer === undefined || dataset === undefined ? null : regionSourceFor(layer, dataset, stats),
    [layer, dataset, stats]
  );

  // R5's Freeview behaviour: a click in a pane selects the row under the cursor. The engine already
  // resolved the label id into the probe (`ProbeRow.labelId` / `.tag`); this only routes it.
  //
  // It fires on a **change** of the probed id and not on every probe: `updateLayer` re-probes the
  // cursor, so an unguarded effect would undo the selection the user had just made with the very
  // patch that made it — Alt-click solo selected a row and then immediately reselected whatever the
  // cursor happened to be sitting on.
  const probedId = source === null ? null : probedRegionId(source, cursorProbe);
  const lastProbedId = useRef<number | null>(null);
  useEffect(() => {
    if (probedId === null || probedId === lastProbedId.current) return;
    lastProbedId.current = probedId;
    controller.selectRegions(layerId, { ids: [probedId], anchor: probedId });
  }, [controller, layerId, probedId]);

  // R5's row count and double-click target. One `labelCentroids` per layer; the engine caches the
  // op per `(dataset, volumeIndex)` and the controller skips a layer it already has an answer for,
  // so a remount costs nothing.
  const wantsStats = source !== null && source.kind !== 'meshTag' && stats === undefined;
  useEffect(() => {
    if (!wantsStats) return;
    void controller.loadRegionStats(layerId);
  }, [controller, layerId, wantsStats]);

  const shown = useMemo(
    () => (source === null ? [] : filterRows(source.rows, query)),
    [source, query]
  );

  if (source === null || layer === undefined) return null;

  const patch = (visibleIds: readonly number[]): void => {
    const p = visibilityPatch(source, layer, visibleIds);
    if (p !== null) controller.patchLayer(layerId, p);
  };

  const onRowClick = (row: RegionRow, event: ReactMouseEvent<HTMLElement>): void => {
    if (event.altKey) {
      // Solo: mute all others. The selection follows, so the highlight and the mute agree.
      patch(soloVisible([row.id]));
      controller.selectRegions(layerId, { ids: [row.id], anchor: row.id });
      return;
    }
    controller.selectRegions(
      layerId,
      selectOnClick(shown, selection, row.id, {
        shift: event.shiftKey,
        meta: event.metaKey || event.ctrlKey,
      })
    );
  };

  const onRowDoubleClick = (row: RegionRow): void => {
    if (row.centroid === null) return;
    controller.setCursorWorld(row.centroid);
  };

  const selected = new Set(selection.ids);
  const visibleCount = source.rows.filter((r) => r.visible).length;

  return (
    <section data-testid={`region-panel-${layerId}`} data-kind={source.kind} className="mt-2">
      <div className="flex items-center gap-1">
        <span className="text-[10px] uppercase tracking-wide text-tvx-dim">{source.title}</span>
        <span
          data-testid={`region-count-${layerId}`}
          className="ml-auto font-mono text-[10px] text-tvx-dim"
        >
          {visibleCount}/{source.rows.length}
        </span>
      </div>

      <input
        type="search"
        data-testid={`region-search-${layerId}`}
        aria-label="Search regions"
        placeholder="Search name or id…"
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
        className="tvx-input mt-1 w-full text-xs"
      />

      <div className="mt-1 flex gap-1">
        {BULK.map(({ op, label }) => (
          <button
            key={op}
            type="button"
            data-testid={`region-${op}-${layerId}`}
            className="tvx-btn tvx-btn-sm"
            onClick={() => patch(bulkVisible(source.rows, op))}
          >
            {label}
          </button>
        ))}
      </div>

      {/* `div role="list"` rather than `<ul>`, and the same for the rows — `TissueTable` already does
          it, and the reason matters here: this panel is mounted **inside** a layer's editor, which
          is itself an `<li>` of `[data-testid="layer-list"]`. A nested `<ul><li>` is legal HTML and
          silently breaks every `layer-list li` count in `shell.spec.ts` (measured: 2 layers read as
          8 rows), because a descendant selector cannot tell the two lists apart. */}
      <div
        role="list"
        data-testid={`region-list-${layerId}`}
        data-rows={shown.length}
        className="mt-1 max-h-64 overflow-y-auto"
      >
        {shown.map((row) => (
          <div
            role="listitem"
            key={row.id}
            data-testid={`region-row-${layerId}-${row.id}`}
            data-visible={row.visible}
            data-selected={selected.has(row.id)}
            data-recolorable={source.recolorable}
            className={
              'flex items-center gap-1 rounded px-1 py-0.5 ' +
              (selected.has(row.id) ? 'bg-tvx-accent/15 ring-1 ring-tvx-accent' : '')
            }
            onClick={(e) => onRowClick(row, e)}
            onDoubleClick={() => onRowDoubleClick(row)}
            title={
              row.centroid === null
                ? 'No centroid for this region — double-click has nowhere to jump'
                : 'Double-click to jump the cursor to this region’s centroid'
            }
          >
            <button
              type="button"
              data-testid={`region-eye-${layerId}-${row.id}`}
              aria-pressed={row.visible}
              aria-label={row.visible ? `Hide ${row.name}` : `Show ${row.name}`}
              className="tvx-btn tvx-btn-sm w-6 shrink-0"
              onClick={(e) => {
                e.stopPropagation();
                patch(toggledVisible(source.rows, row.id));
              }}
            >
              {row.visible ? '◉' : '○'}
            </button>

            {source.recolorable && row.color !== null ? (
              <input
                type="color"
                data-testid={`region-color-${layerId}-${row.id}`}
                aria-label={`Colour of ${row.name}`}
                value={toHex(row.color)}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => {
                  const p = colorPatch(
                    source,
                    layer,
                    row.id,
                    fromHex(e.currentTarget.value, row.color?.[3] ?? 1)
                  );
                  if (p !== null) controller.patchLayer(layerId, p);
                }}
                className="h-4 w-4 shrink-0 cursor-pointer border-0 bg-transparent p-0"
              />
            ) : (
              <span
                data-testid={`region-swatch-${layerId}-${row.id}`}
                title={
                  row.color === null
                    ? 'No LUT entry — the engine paints §7.6’s deterministic palette'
                    : 'This source has no table an edited colour could be written to'
                }
                className="h-4 w-4 shrink-0 rounded-sm border border-tvx-line"
                style={
                  row.color === null
                    ? undefined
                    : { backgroundColor: toHex(row.color), opacity: row.color[3] }
                }
              />
            )}

            <span
              data-testid={`region-name-${layerId}-${row.id}`}
              className="truncate text-[11px]"
              title={row.name}
            >
              {row.name}
            </span>

            <span className="ml-auto shrink-0 font-mono text-[10px] text-tvx-dim">
              <span data-testid={`region-id-${layerId}-${row.id}`}>{row.id}</span>
              {row.elementKind === undefined ? '' : ` ${row.elementKind}`}
              {' · '}
              <span data-testid={`region-tally-${layerId}-${row.id}`}>
                {row.count === null ? '—' : row.count.toLocaleString('en-US')}
              </span>
            </span>

            {source.adjustableOpacity && (
              <input
                type="range"
                data-testid={`region-opacity-${layerId}-${row.id}`}
                aria-label={`Opacity of ${row.name}`}
                min={0}
                max={1}
                step={0.01}
                value={row.opacity}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => {
                  const p = opacityPatch(source, layer, row.id, Number(e.currentTarget.value));
                  if (p !== null) controller.patchLayer(layerId, p);
                }}
                className="h-1 w-10 shrink-0 accent-tvx-accent"
              />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
