/**
 * The **volume** layer's property editor (§8: "per-kind property editor").
 *
 * Everything §8 and the ROADMAP ask of it: `Scale` (linear, and `heat`'s min/mid/max with `truncate`,
 * `inverse` and the negative branch), `Threshold` with `symmetric` and `softEdge`, the label
 * fill/outline/both selector with `outlineWidthPx`, `interpolation` with §7.1's forced-nearest flag
 * (audit P2-08), `showIn3D`, the 4D frame spinner (audit P2-05), the §8 histogram widget, and — for a
 * label volume — the R5 Region panel, which is where `visibleLabels` and `labelOpacity` are edited.
 *
 * **No scene state lives here.** Every control computes a `Partial<VolumeLayer>` with a pure function
 * from `./patches.ts` and hands it to `controller.patchLayer`, which is one `Engine.updateLayer`
 * call (§8: "everything the UI can do must be reachable from the `Engine` API alone").
 *
 * Layer *opacity* is deliberately not repeated here: §8 puts it on the layer row, and `LayerPanel.tsx`
 * already ships that slider. Two sliders for one number is how they drift apart.
 */

import type { Dataset, Layer, Scale, VolumeDataset, VolumeLayer } from '@tetravox/engine';
import type { LayerPropertiesProps } from '../properties';
import { useController, useUi } from '../../../ui/context';
import { Histogram } from '../../histogram/Histogram';
import { RegionPanel } from '../../regions/RegionPanel';
import { normalizeWindow } from '../../histogram/presets';
import {
  COLORMAPS,
  LABEL_MODES,
  NEGATIVE_MODES,
  clampOutlineWidth,
  effectiveInterpolation,
  forcedNearest,
  patchHeat,
  patchThreshold,
  scaleWindow,
  switchScaleKind,
  thresholdWindow,
  volumeIndexPatch,
  withWindow,
} from './patches';

/** The one-line summary shown under every volume row. */
export function volumeSummary(dataset: Dataset, layer: Layer): string {
  if (dataset.kind !== 'volume') return layer.kind;
  const dims = dataset.dims.join('×');
  const four =
    dataset.nvols > 1
      ? ` · vol ${(layer as Partial<VolumeLayer>).volumeIndex ?? 0}/${dataset.nvols - 1}`
      : '';
  return `${dims} ${dataset.dtype}${dataset.isLabel ? ' · labels' : ''}${four}`;
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
  return (
    <input
      type="number"
      data-testid={testId}
      aria-label={label}
      value={Number.isFinite(value) ? value : 0}
      step={step ?? 'any'}
      onPointerDown={(e) => e.stopPropagation()}
      onChange={(e) => {
        const next = Number(e.currentTarget.value);
        if (Number.isFinite(next)) onCommit(next);
      }}
      className="tvx-input w-full min-w-0 px-1 py-0.5 font-mono text-[10px]"
    />
  );
}

export function VolumeProperties({
  layer,
  dataset,
}: LayerPropertiesProps): React.JSX.Element | null {
  const controller = useController();
  const caps = useUi((s) => s.caps);
  if (layer.kind !== 'volume' || dataset.kind !== 'volume') return null;
  const vl: VolumeLayer = layer;
  const ds: VolumeDataset = dataset;

  const patch = (p: Partial<VolumeLayer>): void => controller.patchLayer<VolumeLayer>(vl.id, p);
  const setScale = (scale: Scale): void => patch({ scale });

  const forced = forcedNearest(ds, caps);
  const window = scaleWindow(vl.scale);
  const heat = vl.scale.kind === 'heat' ? vl.scale : null;

  return (
    <div
      data-testid={`volume-properties-${vl.id}`}
      data-scale-kind={vl.scale.kind}
      className="mt-1.5 flex flex-col gap-1 border-t border-tvx-line pt-1.5"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* ---- colormap ------------------------------------------------------------------------ */}
      <Row label="Colormap">
        <select
          data-testid={`volume-colormap-${vl.id}`}
          aria-label="Colormap"
          value={vl.colormap}
          onChange={(e) => patch({ colormap: e.currentTarget.value })}
          className="tvx-input min-w-0 flex-1 px-1 py-0.5 text-[10px]"
        >
          {COLORMAPS.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </Row>

      {/* ---- scale ---------------------------------------------------------------------------- */}
      <Row label="Scale">
        <select
          data-testid={`volume-scale-kind-${vl.id}`}
          aria-label="Scale kind"
          value={vl.scale.kind}
          onChange={(e) =>
            setScale(switchScaleKind(vl.scale, e.currentTarget.value as Scale['kind'], ds.stats))
          }
          className="tvx-input min-w-0 flex-1 px-1 py-0.5 text-[10px]"
        >
          <option value="linear">linear</option>
          <option value="heat">heat</option>
        </select>
      </Row>

      {heat === null ? (
        <div className="flex gap-1">
          <NumberField
            testId={`volume-scale-lo-${vl.id}`}
            label="Scale low"
            value={window.lo}
            onCommit={(lo) => setScale(withWindow(vl.scale, { lo, hi: window.hi }))}
          />
          <NumberField
            testId={`volume-scale-hi-${vl.id}`}
            label="Scale high"
            value={window.hi}
            onCommit={(hi) => setScale(withWindow(vl.scale, { lo: window.lo, hi }))}
          />
        </div>
      ) : (
        <>
          <div className="flex gap-1">
            <NumberField
              testId={`volume-heat-min-${vl.id}`}
              label="Heat min"
              value={heat.min}
              onCommit={(min) => setScale(patchHeat(vl.scale, { min }))}
            />
            <NumberField
              testId={`volume-heat-mid-${vl.id}`}
              label="Heat mid"
              value={heat.mid}
              onCommit={(mid) => setScale(patchHeat(vl.scale, { mid }))}
            />
            <NumberField
              testId={`volume-heat-max-${vl.id}`}
              label="Heat max"
              value={heat.max}
              onCommit={(max) => setScale(patchHeat(vl.scale, { max }))}
            />
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              data-testid={`volume-heat-truncate-${vl.id}`}
              aria-pressed={heat.truncate}
              title="Clamp everything above max to max instead of letting it saturate"
              className={'tvx-btn tvx-btn-sm' + (heat.truncate ? ' tvx-btn-on' : '')}
              onClick={() => setScale(patchHeat(vl.scale, { truncate: !heat.truncate }))}
            >
              truncate
            </button>
            <button
              type="button"
              data-testid={`volume-heat-inverse-${vl.id}`}
              aria-pressed={heat.inverse}
              className={'tvx-btn tvx-btn-sm' + (heat.inverse ? ' tvx-btn-on' : '')}
              onClick={() => setScale(patchHeat(vl.scale, { inverse: !heat.inverse }))}
            >
              inverse
            </button>
            <select
              data-testid={`volume-heat-negative-${vl.id}`}
              aria-label="Negative branch"
              value={heat.negative}
              onChange={(e) =>
                setScale(
                  patchHeat(vl.scale, {
                    negative: e.currentTarget.value as (typeof NEGATIVE_MODES)[number],
                  })
                )
              }
              className="tvx-input px-1 py-0.5 text-[10px]"
            >
              {NEGATIVE_MODES.map((m) => (
                <option key={m} value={m}>
                  −ve: {m}
                </option>
              ))}
            </select>
            {heat.negative === 'separate' && (
              <select
                data-testid={`volume-colormap-negative-${vl.id}`}
                aria-label="Negative colormap"
                value={vl.colormapNegative ?? 'blue-cyan'}
                onChange={(e) => patch({ colormapNegative: e.currentTarget.value })}
                className="tvx-input px-1 py-0.5 text-[10px]"
              >
                {COLORMAPS.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            )}
          </div>
        </>
      )}

      {/* ---- the §8 histogram ------------------------------------------------------------------ */}
      <Histogram
        idPrefix={`volume-histogram-${vl.id}`}
        stats={ds.stats}
        window={window}
        threshold={thresholdWindow(vl.threshold)}
        colormapName={String(vl.colormap)}
        onWindow={(lo, hi) => setScale(withWindow(vl.scale, normalizeWindow({ lo, hi })))}
        onThreshold={(lo, hi) => patch({ threshold: patchThreshold(vl.threshold, { lo, hi }) })}
      />

      {/* ---- threshold -------------------------------------------------------------------------- */}
      <Row label="Threshold">
        <NumberField
          testId={`volume-threshold-lo-${vl.id}`}
          label="Threshold low"
          value={vl.threshold.lo}
          onCommit={(lo) => patch({ threshold: patchThreshold(vl.threshold, { lo }) })}
        />
        <NumberField
          testId={`volume-threshold-hi-${vl.id}`}
          label="Threshold high"
          value={vl.threshold.hi}
          onCommit={(hi) => patch({ threshold: patchThreshold(vl.threshold, { hi }) })}
        />
      </Row>
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          data-testid={`volume-threshold-symmetric-${vl.id}`}
          aria-pressed={vl.threshold.symmetric}
          title="Compare |v| instead of v (§4.2)"
          className={'tvx-btn tvx-btn-sm' + (vl.threshold.symmetric ? ' tvx-btn-on' : '')}
          onClick={() =>
            patch({
              threshold: patchThreshold(vl.threshold, { symmetric: !vl.threshold.symmetric }),
            })
          }
        >
          symmetric
        </button>
        <select
          data-testid={`volume-threshold-mode-${vl.id}`}
          aria-label="Threshold mode"
          value={vl.threshold.mode}
          onChange={(e) =>
            patch({
              threshold: patchThreshold(vl.threshold, {
                mode: e.currentTarget.value as 'hide' | 'clamp',
              }),
            })
          }
          className="tvx-input px-1 py-0.5 text-[10px]"
        >
          <option value="hide">hide</option>
          <option value="clamp">clamp</option>
        </select>
        <span className="ml-auto font-mono text-[10px] text-tvx-dim">
          soft {vl.threshold.softEdge.toFixed(2)}
        </span>
      </div>
      <input
        type="range"
        data-testid={`volume-threshold-softedge-${vl.id}`}
        aria-label="Threshold soft edge"
        title="Width of the alpha ramp as a fraction of hi − lo; 0 = hard discard (§4.2)"
        min={0}
        max={1}
        step={0.01}
        value={vl.threshold.softEdge}
        onChange={(e) =>
          patch({
            threshold: patchThreshold(vl.threshold, { softEdge: Number(e.currentTarget.value) }),
          })
        }
        className="h-1 w-full accent-tvx-accent"
      />

      {/* ---- interpolation, and §7.1's forced-nearest flag (audit P2-08) ------------------------ */}
      <Row label="Interp">
        <select
          data-testid={`volume-interpolation-${vl.id}`}
          aria-label="Interpolation"
          value={effectiveInterpolation(vl, ds, caps)}
          disabled={forced !== null}
          onChange={(e) =>
            patch({ interpolation: e.currentTarget.value as VolumeLayer['interpolation'] })
          }
          className="tvx-input min-w-0 flex-1 px-1 py-0.5 text-[10px]"
        >
          <option value="linear">linear</option>
          <option value="nearest">nearest</option>
        </select>
      </Row>
      {forced !== null && (
        <p
          data-testid={`volume-forced-nearest-${vl.id}`}
          data-reason={forced.reason}
          className={
            'font-mono text-[10px] ' +
            (forced.reason === 'floatLinear' ? 'text-tvx-warn' : 'text-tvx-dim')
          }
          title={forced.detail}
        >
          {forced.reason === 'floatLinear' ? '⚠ forced nearest' : 'nearest (labels)'} —{' '}
          {ds.gpu.format}
        </p>
      )}

      {/* ---- label display ---------------------------------------------------------------------- */}
      {ds.isLabel && (
        <>
          <Row label="Labels">
            <select
              data-testid={`volume-label-mode-${vl.id}`}
              aria-label="Label mode"
              value={vl.labelMode}
              onChange={(e) =>
                patch({ labelMode: e.currentTarget.value as VolumeLayer['labelMode'] })
              }
              className="tvx-input min-w-0 flex-1 px-1 py-0.5 text-[10px]"
            >
              {LABEL_MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Row>
          {vl.labelMode !== 'fill' && (
            <Row label="Outline">
              <input
                type="range"
                data-testid={`volume-outline-width-${vl.id}`}
                aria-label="Outline width in px"
                min={0.5}
                max={8}
                step={0.5}
                value={vl.outlineWidthPx}
                onChange={(e) =>
                  patch({ outlineWidthPx: clampOutlineWidth(Number(e.currentTarget.value)) })
                }
                className="h-1 flex-1 accent-tvx-accent"
              />
              <span className="w-8 shrink-0 text-right font-mono">
                {vl.outlineWidthPx.toFixed(1)}
              </span>
            </Row>
          )}
        </>
      )}

      {/* ---- showIn3D and the 4D spinner --------------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          data-testid={`volume-show-in-3d-${vl.id}`}
          aria-pressed={vl.showIn3D}
          title="Draw this layer's slice planes in the 3D view (§7.3)"
          className={'tvx-btn tvx-btn-sm' + (vl.showIn3D ? ' tvx-btn-on' : '')}
          onClick={() => patch({ showIn3D: !vl.showIn3D })}
        >
          show in 3D
        </button>

        {ds.nvols > 1 && (
          <span
            data-testid={`volume-frame-${vl.id}`}
            data-index={vl.volumeIndex}
            className="ml-auto flex items-center gap-1 font-mono text-[10px] text-tvx-dim"
          >
            <button
              type="button"
              data-testid={`volume-frame-prev-${vl.id}`}
              aria-label="Previous volume"
              disabled={volumeIndexPatch(vl, ds, vl.volumeIndex - 1) === null}
              className="tvx-btn tvx-btn-sm"
              onClick={() => {
                const p = volumeIndexPatch(vl, ds, vl.volumeIndex - 1);
                if (p !== null) patch(p);
              }}
            >
              ◂
            </button>
            vol {vl.volumeIndex}/{ds.nvols - 1}
            <button
              type="button"
              data-testid={`volume-frame-next-${vl.id}`}
              aria-label="Next volume"
              disabled={volumeIndexPatch(vl, ds, vl.volumeIndex + 1) === null}
              className="tvx-btn tvx-btn-sm"
              onClick={() => {
                const p = volumeIndexPatch(vl, ds, vl.volumeIndex + 1);
                if (p !== null) patch(p);
              }}
            >
              ▸
            </button>
          </span>
        )}
      </div>

      {/* ---- R5's Region panel: where visibleLabels and labelOpacity are edited ------------------ */}
      {ds.isLabel && <RegionPanel layerId={vl.id} />}
    </div>
  );
}
