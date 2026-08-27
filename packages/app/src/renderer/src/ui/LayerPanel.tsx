/**
 * §8 left panel: "layer panel (ordered list, eye, opacity slider, per-kind property editor, 1 px
 * accent border on the active layer, per-dataset **load card** …)".
 *
 * The list is shown **top first** while `Scene.layers` is bottom → top (§4.4), so "move up" is
 * `reorderLayers` toward the end of the array. Every control here is one §4.7 call.
 *
 * The per-kind property editor is Phase 2's (histogram widget, tissue table, region panel); what
 * ships here is the row itself plus the read-only summary a Phase-1 user needs to tell two layers
 * apart — dims and dtype for a volume, node/element counts and tags for a mesh.
 */

import type { Dataset, Layer } from '@tetravox/engine';
import { formatBytes } from '../lib/metrics';
import { LoadCards } from './LoadCards';
import { useController, useUi } from './context';

function summary(dataset: Dataset | undefined, layer: Layer): string {
  if (dataset === undefined) return layer.kind;
  if (dataset.kind === 'volume') {
    const dims = dataset.dims.join('×');
    const four =
      dataset.nvols > 1
        ? ` · vol ${(layer as { volumeIndex?: number }).volumeIndex ?? 0}/${dataset.nvols - 1}`
        : '';
    return `${dims} ${dataset.dtype}${dataset.isLabel ? ' · labels' : ''}${four}`;
  }
  const tris = dataset.hasTris ? `${dataset.nTris.toLocaleString()} tris` : 'no tris';
  return `${dataset.nNodes.toLocaleString()} nodes · ${tris} · ${dataset.nTets.toLocaleString()} tets`;
}

function LayerRow({ layer }: { layer: Layer }): React.JSX.Element {
  const controller = useController();
  const active = useUi((s) => s.activeLayerId === layer.id);
  const dataset = useUi((s) => s.datasets.find((d) => d.id === layer.datasetId));
  const heap = useUi((s) => s.heapBytes[layer.datasetId]);

  return (
    <li
      data-testid={`layer-row-${layer.id}`}
      data-active={active}
      data-visible={layer.visible}
      className={
        'rounded border px-2 py-1.5 ' +
        (active ? 'border-tvx-accent bg-tvx-panel' : 'border-transparent hover:bg-tvx-panel/60')
      }
      onPointerDown={() => controller.setActiveLayer(layer.id)}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid={`layer-eye-${layer.id}`}
          aria-pressed={layer.visible}
          aria-label={layer.visible ? 'Hide layer' : 'Show layer'}
          className="tvx-btn tvx-btn-sm w-7"
          onClick={(e) => {
            e.stopPropagation();
            controller.toggleVisible(layer.id);
          }}
        >
          {layer.visible ? '◉' : '○'}
        </button>
        <span
          data-testid={`layer-name-${layer.id}`}
          className="truncate text-xs"
          title={dataset?.path ?? layer.name}
        >
          {layer.name}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[10px] uppercase text-tvx-dim">
          {layer.kind}
        </span>
        <button
          type="button"
          data-testid={`layer-up-${layer.id}`}
          aria-label="Move layer up"
          className="tvx-btn tvx-btn-sm"
          onClick={(e) => {
            e.stopPropagation();
            controller.moveLayer(layer.id, 1);
          }}
        >
          ↑
        </button>
        <button
          type="button"
          data-testid={`layer-down-${layer.id}`}
          aria-label="Move layer down"
          className="tvx-btn tvx-btn-sm"
          onClick={(e) => {
            e.stopPropagation();
            controller.moveLayer(layer.id, -1);
          }}
        >
          ↓
        </button>
        <button
          type="button"
          data-testid={`layer-close-${layer.id}`}
          aria-label="Close dataset"
          title="Close the dataset — terminates its worker (§5 rule 1)"
          className="tvx-btn tvx-btn-sm"
          onClick={(e) => {
            e.stopPropagation();
            controller.closeDataset(layer.datasetId);
          }}
        >
          ✕
        </button>
      </div>

      <div className="mt-1 flex items-center gap-2">
        <input
          type="range"
          data-testid={`layer-opacity-${layer.id}`}
          aria-label="Layer opacity"
          min={0}
          max={1}
          step={0.01}
          value={layer.opacity}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => controller.setOpacity(layer.id, Number(e.currentTarget.value))}
          className="h-1 flex-1 accent-tvx-accent"
        />
        <span className="w-8 shrink-0 text-right font-mono text-[10px] text-tvx-dim">
          {Math.round(layer.opacity * 100)}%
        </span>
      </div>

      <p className="mt-0.5 truncate font-mono text-[10px] text-tvx-dim">
        {summary(dataset, layer)}
        {heap === undefined ? '' : ` · heap ${formatBytes(heap)}`}
      </p>
    </li>
  );
}

export function LayerPanel(): React.JSX.Element {
  // Bottom → top in the model, top first on screen.
  const layers = useUi((s) => s.layers);
  const shown = [...layers].reverse();
  return (
    <aside
      data-testid="layer-panel"
      className="flex w-72 min-w-56 flex-col overflow-hidden border-r border-tvx-line bg-tvx-panel/40"
    >
      <h2 className="border-b border-tvx-line px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-tvx-dim">
        Layers
      </h2>
      <LoadCards />
      {shown.length === 0 ? (
        <p data-testid="layer-panel-empty" className="p-3 text-xs text-tvx-dim">
          Nothing open. File ▸ Open…, drop a file on the window, or pass a path on the command line.
        </p>
      ) : (
        <ul data-testid="layer-list" className="flex flex-col gap-0.5 overflow-y-auto p-2">
          {shown.map((layer) => (
            <LayerRow key={layer.id} layer={layer} />
          ))}
        </ul>
      )}
    </aside>
  );
}
