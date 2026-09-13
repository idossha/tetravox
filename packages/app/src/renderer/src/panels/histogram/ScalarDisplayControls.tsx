/** Shared scalar contrast and threshold controls; statistics stay in the dataset worker. */
import { useState } from 'react';
import type { ColormapName, Stats, Threshold } from '@tetravox/engine';
import { Histogram } from './Histogram';
import { SCALAR_PRESETS } from './presets';
import type { ValueWindow } from './presets';
import { percentToValue, valueToPercent } from './threshold-percentiles';
import { COLORMAPS, colormapStops } from '../layers/volume/patches';

export interface ScalarDisplayControlsProps {
  kind: 'volume' | 'mesh';
  id: string;
  colormap: ColormapName | string;
  stats: Stats | null;
  window: ValueWindow;
  threshold: Threshold;
  onColormap(name: string): void;
  onWindow(lo: number, hi: number): void;
  onThreshold(patch: Partial<Threshold>): void;
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <label className="flex items-center gap-1.5 text-[10px] text-tvx-dim">
      <span className="w-16 shrink-0">{label}</span>
      {children}
    </label>
  );
}

function NumberField({
  testId,
  label,
  value,
  step,
  onCommit,
}: {
  testId: string;
  label: string;
  value: number;
  step?: number;
  onCommit(v: number): void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = Number.isFinite(value) ? String(value) : '';
  return (
    <input
      type="number"
      data-testid={testId}
      aria-label={label}
      value={draft ?? shown}
      placeholder="No limit"
      step={step ?? 'any'}
      onPointerDown={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.currentTarget.value)}
      onBlur={(e) => {
        const raw = e.currentTarget.value;
        const next = e.currentTarget.valueAsNumber;
        setDraft(null);
        if (raw !== '' && Number.isFinite(next) && next !== value) onCommit(next);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          e.currentTarget.value = shown;
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
      className="tvx-input w-full min-w-0 px-1 py-0.5 font-mono text-[10px]"
    />
  );
}

export function ScalarDisplayControls({
  kind,
  id,
  colormap,
  stats,
  window,
  threshold,
  onColormap,
  onWindow,
  onThreshold,
}: ScalarDisplayControlsProps): React.JSX.Element {
  const [percentileMode, setThresholdPercentiles] = useState(false);
  const thresholdPercentiles = percentileMode && stats !== null;
  // Preserve chosen ranks where several percentiles share the same intensity.
  const [percentEntries, setPercentEntries] = useState<
    Partial<Record<'lo' | 'hi', { value: number; percent: number }>>
  >({});
  const thresholdEnabled =
    kind === 'volume' || Number.isFinite(threshold.lo) || Number.isFinite(threshold.hi);
  const visibleThreshold = {
    lo:
      kind === 'volume' && stats !== null && !Number.isFinite(threshold.lo)
        ? stats.min
        : threshold.lo,
    hi:
      kind === 'volume' && stats !== null && !Number.isFinite(threshold.hi)
        ? stats.max
        : threshold.hi,
  };
  return (
    <section
      aria-label="Contrast and visibility"
      className="flex min-w-0 flex-col gap-2 rounded border border-tvx-line p-2"
    >
      <div className="text-[11px] font-medium">Contrast & visibility</div>
      <Row label="Colormap">
        <select
          data-testid={`${kind}-colormap-${id}`}
          aria-label="Colormap"
          value={colormap}
          onChange={(e) => onColormap(e.currentTarget.value)}
          className="tvx-input min-w-0 flex-1 px-1 py-0.5 text-[10px]"
        >
          {COLORMAPS.map((name) => (
            <option key={name} value={name}>
              {name === 'gray' ? 'Grayscale' : name}
            </option>
          ))}
        </select>
      </Row>
      {stats !== null && (
        <Histogram
          idPrefix={`${kind}-histogram-${id}`}
          stats={stats}
          window={window}
          presets={SCALAR_PRESETS}
          threshold={thresholdEnabled ? visibleThreshold : null}
          colormapName={String(colormap)}
          colormapStops={colormapStops(colormap)}
          onWindow={(lo, hi) => onWindow(lo, hi)}
          onThreshold={(lo, hi) => onThreshold({ lo, hi })}
        />
      )}
      <div className="text-[10px] text-tvx-dim">Contrast</div>
      <div className="grid grid-cols-2 gap-2">
        {(['lo', 'hi'] as const).map((edge) => (
          <label key={edge} className="flex min-w-0 flex-col gap-1 text-[10px] text-tvx-dim">
            {edge === 'lo' ? 'Low' : 'High'}
            <NumberField
              testId={`${kind}-scale-${edge}-${id}`}
              label={`Display range ${edge === 'lo' ? 'low' : 'high'}`}
              value={window[edge]}
              onCommit={(value) =>
                onWindow(edge === 'lo' ? value : window.lo, edge === 'hi' ? value : window.hi)
              }
            />
          </label>
        ))}
      </div>
      <div className="flex flex-col gap-2 border-t border-tvx-line pt-2">
        <div className="flex items-center gap-2">
          {kind === 'mesh' ? (
            <label className="flex items-center gap-2 text-[11px]">
              <input
                type="checkbox"
                data-testid={`${kind}-threshold-enabled-${id}`}
                checked={thresholdEnabled}
                className="accent-tvx-accent"
                onChange={(e) =>
                  onThreshold({
                    lo: e.currentTarget.checked ? window.lo : -Infinity,
                    hi: e.currentTarget.checked ? window.hi : Infinity,
                  })
                }
              />
              Threshold
            </label>
          ) : (
            <div className="text-[10px] text-tvx-dim">Threshold</div>
          )}
          {thresholdEnabled && stats !== null && (
            <div className="ml-auto text-[10px]">
              <select
                id={`threshold-units-${id}`}
                aria-label="Threshold units"
                data-testid={`${kind}-threshold-units-${id}`}
                title="Percentiles use exact stored cutoffs and estimates between them"
                value={thresholdPercentiles ? 'percentiles' : 'values'}
                onChange={(e) => setThresholdPercentiles(e.currentTarget.value === 'percentiles')}
                className="tvx-input min-w-0 flex-1 px-1 py-0.5"
              >
                <option value="values">Values</option>
                <option value="percentiles">Percentiles (%)</option>
              </select>
            </div>
          )}
        </div>
        {thresholdEnabled && (
          <>
            <div className="grid grid-cols-2 gap-2">
              {(['lo', 'hi'] as const).map((edge) => (
                <label key={edge} className="flex min-w-0 flex-col gap-1 text-[10px] text-tvx-dim">
                  {edge === 'lo' ? 'Low' : 'High'}
                  {thresholdPercentiles ? ' (%)' : ''}
                  <NumberField
                    key={thresholdPercentiles ? 'percentiles' : 'values'}
                    testId={`${kind}-threshold-${edge}-${id}`}
                    label={`Threshold ${edge === 'lo' ? 'low' : 'high'}`}
                    step={thresholdPercentiles ? 0.1 : undefined}
                    value={
                      thresholdPercentiles
                        ? percentEntries[edge]?.value === visibleThreshold[edge]
                          ? percentEntries[edge]!.percent
                          : edge === 'hi' && visibleThreshold.hi >= stats!.max
                            ? 100
                            : Number(valueToPercent(stats!, visibleThreshold[edge]).toFixed(3))
                        : visibleThreshold[edge]
                    }
                    onCommit={(entered) => {
                      const percent = Math.min(100, Math.max(0, entered));
                      const value = thresholdPercentiles
                        ? percentToValue(stats!, percent)
                        : entered;
                      if (thresholdPercentiles)
                        setPercentEntries((entries) => ({
                          ...entries,
                          [edge]: { value, percent },
                        }));
                      onThreshold({ [edge]: value });
                    }}
                  />
                </label>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
