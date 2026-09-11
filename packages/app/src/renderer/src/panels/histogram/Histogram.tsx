/**
 * The histogram widget — §8, in the volume **and** mesh-field property editors.
 *
 * Log-y toggle, draggable contrast and threshold handles, a colormap strip, and scalar presets.
 *
 * The bins are `Stats.histogram` — 256 counts over `[histogramLo, histogramHi]`, computed exactly in
 * the worker (§6.1). This component never touches `VolumeDataset.data`, which is what keeps a handle
 * drag off the ≤ 16 ms probe budget (§8) and what lets it live in React at all.
 *
 * It takes **numbers, not a layer**: one widget, two producers (a volume's `Scale`/`Threshold` and a
 * mesh field's), so neither owner needs the other's types. Every gesture ends in `onWindow` /
 * `onThreshold`, and the arithmetic behind it is `./geometry.ts` — pure, and asserted by vitest
 * against exact values rather than by a picture of a `<canvas>` (§11 rule 0).
 *
 * Drawn as **SVG in a fixed 256 × 64 logical box**, stretched to the panel width. 256 logical units
 * is one per bin, so a bar is exactly one unit wide and no rounding decides which bin a column shows.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Stats } from '@tetravox/engine';
import { axisRange, barHeights, dragHandle, formatValue, handleAt, xForValue } from './geometry';
import type { HandleId, HandleValues, PlotBox } from './geometry';
import { SCALAR_PRESETS, activePreset, applyPreset } from './presets';
import type { Preset, PresetId, ValueWindow } from './presets';

/** Logical units; the SVG is stretched to the panel by `preserveAspectRatio="none"`. */
export const HISTOGRAM_BOX: PlotBox = { width: 256, height: 64 };

export interface HistogramProps {
  stats: Stats;
  /** Override the shared scalar preset choices when needed. */
  presets?: readonly Preset[];
  /** The window currently applied, in physical units. */
  window: ValueWindow;
  /** The threshold currently applied, or `null` when there is none. */
  threshold: ValueWindow | null;
  onWindow(lo: number, hi: number): void;
  onThreshold(lo: number, hi: number): void;
  /**
   * §8's "current colormap painted along the x axis": evenly-spaced CSS colours, low → high.
   *
   * Supplied by the caller rather than sampled here, because the colormap tables are the engine's
   * (`packages/engine/src/color/colormaps.ts`, §7.6) and a copy in the app would be a second source
   * of truth for every pixel the user compares this strip against. The caller builds them with
   * `panels/layers/volume/patches.ts`'s `colormapStops`, over the engine's own re-exported
   * `sampleColormap`. Absent or empty — a user `.json` colormap the app has no table for — the strip
   * renders as a neutral rail carrying the colormap's **name**, which is honest rather than wrong.
   */
  colormapStops?: readonly string[];
  colormapName?: string;
  /** Distinguishes two histograms on one screen. */
  idPrefix?: string;
}

export function Histogram({
  stats,
  presets = SCALAR_PRESETS,
  window,
  threshold,
  onWindow,
  onThreshold,
  colormapStops,
  colormapName,
  idPrefix = 'histogram',
}: HistogramProps): React.JSX.Element {
  const [logY, setLogY] = useState(true);
  const [dragging, setDragging] = useState<HandleId | null>(null);
  const plotRef = useRef<SVGSVGElement | null>(null);

  const box = HISTOGRAM_BOX;
  const axis = axisRange(stats);
  const bars = useMemo(() => barHeights(stats.histogram, box, logY), [stats.histogram, box, logY]);
  const values: HandleValues = { window, threshold };
  const preset = activePreset(window, stats, 1e-4, presets);
  const span = axis.hi - axis.lo;

  /** Pointer client x → the logical x the geometry helpers speak. */
  const logicalX = useCallback(
    (clientX: number): number => {
      const rect = plotRef.current?.getBoundingClientRect();
      if (rect === undefined || rect.width === 0) return 0;
      return ((clientX - rect.left) / rect.width) * box.width;
    },
    [box.width]
  );

  const emit = useCallback(
    (next: HandleValues, handle: HandleId): void => {
      if (handle === 'windowLo' || handle === 'windowHi') onWindow(next.window.lo, next.window.hi);
      else if (next.threshold !== null) onThreshold(next.threshold.lo, next.threshold.hi);
    },
    [onWindow, onThreshold]
  );

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const x = logicalX(event.clientX);
    const target = event.target as Element;
    const explicit = target
      .closest('[data-handle]')
      ?.getAttribute('data-handle') as HandleId | null;
    const grabbed = explicit ?? handleAt(x, values, stats, box);
    if (grabbed === null) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(grabbed);
    if (explicit === null) emit(dragHandle(grabbed, x, values, stats, box), grabbed);
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (dragging === null) return;
    emit(dragHandle(dragging, logicalX(event.clientX), values, stats, box), dragging);
  };

  const onPointerUp = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (dragging === null) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(null);
  };

  const applyPresetId = (id: PresetId): void => {
    const next = applyPreset(id, stats);
    onWindow(next.lo, next.hi);
  };

  // Keep grab targets inside the plot even for unlimited or out-of-histogram bounds.
  const handleX = (v: number): number =>
    Math.max(7, Math.min(box.width - 7, xForValue(v, stats, box)));
  const gradientId = `${idPrefix}-colormap`;
  const painted = colormapStops !== undefined && colormapStops.length > 1;

  return (
    <div data-testid={idPrefix} className="mt-1.5 flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <span className="text-[10px] uppercase tracking-wide text-tvx-dim">Histogram</span>
        <button
          type="button"
          data-testid={`${idPrefix}-logy`}
          aria-pressed={logY}
          title="Log-y — the air peak of a whole-head volume is otherwise the only visible bar"
          className={'tvx-btn tvx-btn-sm ml-auto' + (logY ? ' tvx-btn-on' : '')}
          onClick={() => setLogY(!logY)}
        >
          log y
        </button>
      </div>

      <svg
        ref={plotRef}
        data-testid={`${idPrefix}-plot`}
        data-dragging={dragging ?? ''}
        viewBox={`0 0 ${box.width} ${box.height + 8}`}
        preserveAspectRatio="none"
        className="h-20 w-full touch-none select-none rounded border border-tvx-line bg-tvx-bg/60"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {painted && (
          <defs>
            <linearGradient id={gradientId} x1="0" x2="1" y1="0" y2="0">
              {(colormapStops ?? []).map((stop, i) => (
                <stop
                  key={i}
                  offset={i / Math.max(1, (colormapStops ?? []).length - 1)}
                  stopColor={stop}
                />
              ))}
            </linearGradient>
          </defs>
        )}

        <g data-testid={`${idPrefix}-bins`}>
          {Array.from(bars, (h, i) => (
            <rect
              key={i}
              x={i}
              y={box.height - h}
              width={1}
              height={h}
              fill="var(--color-tvx-line-strong)"
              shapeRendering="crispEdges"
            />
          ))}
        </g>

        <rect
          data-testid={`${idPrefix}-colormap-strip`}
          data-stops={colormapStops?.length ?? 0}
          x={0}
          y={box.height}
          width={box.width}
          height={8}
          fill={painted ? `url(#${gradientId})` : 'var(--color-tvx-line)'}
        />

        {(['windowLo', 'windowHi', 'thresholdLo', 'thresholdHi'] as const).map((id, index) => {
          const isThreshold = id.startsWith('threshold');
          if (isThreshold && threshold === null) return null;
          const range = isThreshold ? threshold! : window;
          const low = id.endsWith('Lo');
          const value = low ? range.lo : range.hi;
          const x = handleX(value);
          const lineX = Math.max(0, Math.min(box.width, xForValue(value, stats, box)));
          const y = [2, 17, 36, 51][index]!;
          const color = isThreshold ? 'var(--color-tvx-warn)' : 'var(--color-tvx-accent-strong)';
          const label = `${isThreshold ? 'Threshold' : 'Contrast'} ${low ? 'low' : 'high'}`;
          return (
            <g
              key={id}
              data-testid={`${idPrefix}-handle-${id}`}
              data-handle={id}
              data-value={value}
              style={{ cursor: 'ew-resize' }}
            >
              <title>
                {label}: {Number.isFinite(value) ? value : 'No limit'} — drag to adjust
              </title>
              <line
                pointerEvents="none"
                x1={lineX}
                x2={lineX}
                y1={0}
                y2={box.height}
                stroke={color}
                strokeWidth={1.5}
                strokeDasharray={isThreshold ? '3 3' : undefined}
                vectorEffect="non-scaling-stroke"
              />
              <rect
                data-testid={`${idPrefix}-grab-${id}`}
                x={x - 6}
                y={y}
                width={12}
                height={12}
                rx={2}
                fill="var(--color-tvx-bg)"
                stroke={color}
                vectorEffect="non-scaling-stroke"
              />
              <text
                x={x}
                y={y + 8.5}
                textAnchor="middle"
                fontSize={8}
                fontWeight={600}
                fill={color}
                pointerEvents="none"
              >
                {low ? 'L' : 'H'}
              </text>
            </g>
          );
        })}
      </svg>

      <div className="flex items-baseline justify-between font-mono text-[10px] text-tvx-dim">
        <span data-testid={`${idPrefix}-axis-lo`}>{formatValue(axis.lo, span)}</span>
        <span data-testid={`${idPrefix}-colormap-name`}>{colormapName ?? ''}</span>
        <span data-testid={`${idPrefix}-axis-hi`}>{formatValue(axis.hi, span)}</span>
      </div>

      <div className="flex flex-wrap gap-1">
        {presets.map((p) => (
          <button
            key={p.id}
            type="button"
            data-testid={`${idPrefix}-preset-${p.id}`}
            aria-pressed={preset === p.id}
            title={p.title}
            className={'tvx-btn tvx-btn-sm' + (preset === p.id ? ' tvx-btn-on' : '')}
            onClick={() => applyPresetId(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}
