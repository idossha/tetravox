/**
 * The **points** layer's property editor (§4.4's `PointsLayer`), Phase 2.
 *
 * Source, shape, radius, colour and `showLabels`, plus the point list with per-point colour/radius
 * overrides and a jump-the-cursor button — which is how a user finds electrode `Fp1` in a 185-row
 * net without hunting for it in the 3D view.
 *
 * **The source line is read-only, deliberately.** A points layer is not backed by a dataset worker
 * (§4.4) — the points arrive with the layer — and opening files is `open/` plus the toolbar, which is
 * A-SHELL's; a second file picker in here would be a second open path for the same job.
 */

import { useMemo, useState } from 'react';
import type { Dataset, Layer, PointsLayer } from '@tetravox/engine';
import type { LayerPropertiesProps } from '../properties';
import { useController } from '../../../ui/context';
import { NumberField, Row, Section, Select, Slider, Swatch, Toggle } from '../mesh/controls';
import { hexToVec4, vec4ToHex } from '../mesh/state';
import {
  filterPoints,
  pointRows,
  pointsSourceText,
  resetPoint,
  setPointColor,
  setPointRadius,
  setPointsColor,
  setPointsRadius,
  setPointsShape,
  setShowLabels,
} from './state';

export function pointsSummary(_dataset: Dataset, layer: Layer): string {
  if (layer.kind !== 'points') return layer.kind;
  const n = (layer.points ?? []).length;
  return `${n.toLocaleString()} point${n === 1 ? '' : 's'} · ${layer.shape ?? 'sphere'}`;
}

export function PointsProperties({
  layer,
  dataset,
}: LayerPropertiesProps): React.JSX.Element | null {
  // Kind guard before the hooks — see the note in `iso/IsoProperties.tsx`.
  if (layer.kind !== 'points') return null;
  return <PointsEditor layer={layer} dataset={dataset} />;
}

function PointsEditor({
  layer,
  dataset,
}: {
  layer: PointsLayer;
  dataset: Dataset;
}): React.JSX.Element {
  const controller = useController();
  const [query, setQuery] = useState('');
  const rows = useMemo(() => pointRows(layer), [layer]);
  const shown = useMemo(() => filterPoints(rows, query), [rows, query]);
  const points: PointsLayer = layer;
  const patch = (p: Partial<PointsLayer>): void => controller.patchLayer<PointsLayer>(points.id, p);

  return (
    <div data-testid={`points-properties-${points.id}`} className="mt-1 flex flex-col">
      <Section testId={`points-section-${points.id}`} title="Points" defaultOpen>
        <p
          data-testid={`points-source-${points.id}`}
          className="truncate font-mono text-[9px] text-tvx-dim"
          title={pointsSourceText(dataset, points)}
        >
          {pointsSourceText(dataset, points)}
        </p>

        <Row label="Shape">
          <Select
            testId={`points-shape-${points.id}`}
            value={points.shape}
            options={[
              { value: 'sphere', label: 'sphere' },
              { value: 'dot', label: 'dot' },
            ]}
            onChange={(shape) => patch(setPointsShape(points, shape))}
          />
          <Toggle
            testId={`points-labels-${points.id}`}
            label="labels"
            on={points.showLabels}
            onChange={(v) => patch(setShowLabels(points, v))}
          />
        </Row>

        <Row label="Radius mm">
          <Slider
            testId={`points-radius-${points.id}`}
            value={points.radiusMm}
            min={0.5}
            max={20}
            step={0.5}
            format={(v) => v.toFixed(1)}
            onChange={(v) => patch(setPointsRadius(points, v))}
          />
        </Row>

        <Row label="Colour">
          <Swatch
            testId={`points-color-${points.id}`}
            hex={vec4ToHex(points.color)}
            title="Colour of every point without one of its own"
            onChange={(hex) => patch(setPointsColor(points, hexToVec4(hex, points.color[3])))}
          />
          <span className="shrink-0 text-[10px] text-tvx-dim">opacity</span>
          <Slider
            testId={`points-opacity-${points.id}`}
            value={points.opacity}
            min={0}
            max={1}
            step={0.01}
            onChange={(opacity) => patch({ opacity })}
          />
        </Row>

        {rows.length === 0 ? (
          <p data-testid={`points-empty-${points.id}`} className="text-[10px] text-tvx-dim">
            This layer carries no points.
          </p>
        ) : (
          <>
            <input
              type="search"
              data-testid={`points-search-${points.id}`}
              aria-label="Search points"
              placeholder="search…"
              className="tvx-input px-1 py-0.5 text-[10px]"
              value={query}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => setQuery(e.currentTarget.value)}
            />
            <div
              role="list"
              data-testid={`points-list-${points.id}`}
              className="flex max-h-40 flex-col overflow-y-auto"
            >
              {shown.map((row) => (
                <div
                  role="listitem"
                  key={row.index}
                  data-testid={`points-row-${points.id}-${row.index}`}
                  data-overridden={row.overridden}
                  className="flex items-center gap-1 py-0.5"
                >
                  <Swatch
                    testId={`points-row-color-${points.id}-${row.index}`}
                    hex={vec4ToHex(row.color)}
                    title={`Colour of ${row.name}`}
                    onChange={(hex) =>
                      patch(setPointColor(points, row.index, hexToVec4(hex, row.color[3])))
                    }
                  />
                  <button
                    type="button"
                    data-testid={`points-row-goto-${points.id}-${row.index}`}
                    className="tvx-btn tvx-btn-sm"
                    title="Move the cursor to this point"
                    onClick={(e) => {
                      e.stopPropagation();
                      controller.setCursorWorld(row.position);
                    }}
                  >
                    →
                  </button>
                  <span className="min-w-0 flex-1 truncate text-[10px]" title={row.name}>
                    {row.name}
                  </span>
                  <span className="shrink-0 font-mono text-[9px] text-tvx-dim">
                    {row.position.map((c) => c.toFixed(1)).join(' ')}
                  </span>
                  <NumberField
                    testId={`points-row-radius-${points.id}-${row.index}`}
                    value={row.radiusMm}
                    step={0.5}
                    min={0}
                    width="w-12"
                    onCommit={(v) => patch(setPointRadius(points, row.index, v))}
                  />
                  {row.overridden ? (
                    <button
                      type="button"
                      data-testid={`points-row-reset-${points.id}-${row.index}`}
                      className="tvx-btn tvx-btn-sm"
                      title="Follow the layer again"
                      onClick={(e) => {
                        e.stopPropagation();
                        patch(resetPoint(points, row.index));
                      }}
                    >
                      ↺
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          </>
        )}
      </Section>
    </div>
  );
}
