/**
 * §8 left panel: "layer panel (ordered list, eye, opacity slider, per-kind property editor, 1 px
 * accent border on the active layer, per-dataset **load card** …)".
 *
 * The list is shown **top first** while `Scene.layers` is bottom → top (§4.4), so "move up" is
 * `reorderLayers` toward the end of the array. Every control here is one §4.7 call.
 *
 * The per-kind property editor is Phase 2's (histogram widget, tissue table, region panel), and it
 * lives one directory down per kind — `volume/`, `mesh/`, `iso/`, `points/` — behind the registry in
 * `properties.tsx`. What ships here is the row itself plus the read-only summary a Phase-1 user needs
 * to tell two layers apart.
 */

import type { Layer } from '@tetravox/engine';
import { formatBytes } from '../../lib/metrics';
import { LoadCards } from './LoadCards';
import { LayerProperties, layerSummary } from './properties';
import { useController, useUi } from '../../ui/context';

/**
 * The §8 "kind icon" of the header line. A row that is collapsed shows nothing but this line, so the
 * kind has to be legible at a glance rather than only in the summary the disclosure hides.
 */
const KIND_ICON: Record<Layer['kind'], string> = {
  volume: '▦',
  mesh: '◈',
  iso: '◐',
  points: '⁙',
};

function LayerRow({ layer }: { layer: Layer }): React.JSX.Element {
  const controller = useController();
  const active = useUi((s) => s.activeLayerId === layer.id);
  const dataset = useUi((s) => s.datasets.find((d) => d.id === layer.datasetId));
  const heap = useUi((s) => s.heapBytes[layer.datasetId]);
  const collapsed = useUi((s) => s.collapsedLayers[layer.id] === true);

  return (
    <li
      data-testid={`layer-row-${layer.id}`}
      data-active={active}
      data-visible={layer.visible}
      data-collapsed={collapsed}
      tabIndex={active ? 0 : -1}
      className={
        'rounded border px-2 py-1.5 outline-none ' +
        (active ? 'border-tvx-accent bg-tvx-panel' : 'border-transparent hover:bg-tvx-panel/60')
      }
      onPointerDown={(e) => {
        controller.setActiveLayer(layer.id);
        // Take the focus so the ←/→ binding below is reachable without a Tab — but only when the
        // press was on the row itself. A press on the eye, the slider or anything inside the editor
        // is on its way to that control's own focus, and stealing it would break its keyboard.
        //
        // `preventScroll` is not a nicety. This `<li>` is the *whole* layer — header, summary and
        // the expanded editor with its Region panel — so it is routinely taller than `layer-list`'s
        // viewport, and a plain `focus()` asks the browser to scroll that whole element into view.
        // The scroll lands between `pointerdown` and `click`, which yanks the list out from under
        // the finger: an Alt-click meant to solo a tissue row several hundred pixels down the panel
        // arrives on whatever slid under the cursor, and the solo never happens. Focus is for the
        // keyboard; the viewport is the user's.
        if (!(e.target as HTMLElement).closest('input,button,select,textarea,[contenteditable]')) {
          e.currentTarget.focus({ preventScroll: true });
        }
      }}
      onKeyDown={(e) => {
        // ←/→ collapse and expand *the active row*. Handled on the row rather
        // than in `keymap.ts` because those two keys are already §7.5's in-plane cursor nudge: the
        // binding is scoped to a focused row, and `stopPropagation` keeps the native event from
        // reaching the window listener in `ui/Shell.tsx` so the cursor does not move as well.
        if (!active) return;
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        e.stopPropagation();
        controller.setLayerCollapsed(layer.id, e.key === 'ArrowLeft');
      }}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid={`layer-disclosure-${layer.id}`}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand layer' : 'Collapse layer'}
          title={collapsed ? 'Expand this layer (→)' : 'Collapse this layer (←)'}
          className="tvx-btn tvx-btn-sm w-5 shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            controller.toggleLayerCollapsed(layer.id);
          }}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span
          data-testid={`layer-icon-${layer.id}`}
          aria-hidden="true"
          className="shrink-0 text-xs text-tvx-dim"
        >
          {KIND_ICON[layer.kind]}
        </span>
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

      {/*
        Everything below the header line is what the disclosure hides: the summary and the per-kind
        editor — which is where the region panel lives, for both volume and mesh layers, so it
        collapses with its layer without needing a second switch.
      */}
      {collapsed ? null : (
        <div data-testid={`layer-body-${layer.id}`}>
          <p className="mt-0.5 truncate font-mono text-[10px] text-tvx-dim">
            {layerSummary(dataset, layer)}
            {heap === undefined ? '' : ` · heap ${formatBytes(heap)}`}
          </p>
          <LayerProperties layer={layer} dataset={dataset} />
        </div>
      )}
    </li>
  );
}

export function LayerPanel(): React.JSX.Element {
  // Bottom → top in the model, top first on screen.
  const layers = useUi((s) => s.layers);
  const controller = useController();
  const collapsedLayers = useUi((s) => s.collapsedLayers);
  const shown = [...layers].reverse();
  const anyExpanded = layers.some((l) => collapsedLayers[l.id] !== true);
  return (
    <aside
      data-testid="layer-panel"
      className="flex w-72 min-w-56 flex-col overflow-hidden border-r border-tvx-line bg-tvx-panel/40"
    >
      <h2 className="flex items-center gap-2 border-b border-tvx-line px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-tvx-dim">
        Layers
        <button
          type="button"
          data-testid="layer-collapse-all"
          data-action={anyExpanded ? 'collapse' : 'expand'}
          aria-label={anyExpanded ? 'Collapse all layers' : 'Expand all layers'}
          title={anyExpanded ? 'Collapse every layer' : 'Expand every layer'}
          disabled={layers.length === 0}
          className="tvx-btn tvx-btn-sm ml-auto disabled:opacity-40"
          onClick={() => controller.setAllLayersCollapsed(anyExpanded)}
        >
          {anyExpanded ? '⌃' : '⌄'}
        </button>
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
