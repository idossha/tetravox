/**
 * The **volume** layer's property editor (§8: "per-kind property editor").
 *
 * Scalar contrast and visibility share one editor; label volumes use region controls.
 *
 * **No scene state lives here.** Every control computes a `Partial<VolumeLayer>` with a pure function
 * from `./patches.ts` and hands it to `controller.patchLayer`, which is one `Engine.updateLayer`
 * call (§8: "everything the UI can do must be reachable from the `Engine` API alone").
 *
 * Layer *opacity* is deliberately not repeated here: §8 puts it on the layer row, and `LayerPanel.tsx`
 * already ships that slider. Two sliders for one number is how they drift apart.
 */

import type { Dataset, Layer, VolumeDataset, VolumeLayer } from '@tetravox/engine';
import type { LayerPropertiesProps } from '../properties';
import { useController, useUi } from '../../../ui/context';
import { ScalarDisplayControls } from '../../histogram/ScalarDisplayControls';
import { RegionPanel } from '../../regions/RegionPanel';
import { iso3dLabels } from '@tetravox/engine';
import { hexToVec4, vec4ToHex } from '../mesh/state';
import {
  effectiveIso3d,
  iso3dRange,
  iso3dStep,
  iso3dSummary,
  patchIso3d,
  toggleIso3d,
} from './iso3d';
import {
  LABEL_MODES,
  clampOutlineWidth,
  effectiveInterpolation,
  forcedNearest,
  patchThreshold,
  scaleWindow,
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

  const forced = forcedNearest(ds, caps);

  return (
    <div
      data-testid={`volume-properties-${vl.id}`}
      data-scale-kind={vl.scale.kind}
      className="mt-1.5 flex flex-col gap-1 border-t border-tvx-line pt-1.5"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {!ds.isLabel && (
        <ScalarDisplayControls
          kind="volume"
          id={vl.id}
          colormap={vl.colormap}
          stats={ds.stats}
          window={scaleWindow(vl.scale)}
          threshold={vl.threshold}
          onColormap={(colormap) => patch({ colormap })}
          onWindow={(lo, hi) => patch({ scale: withWindow({ lo, hi }) })}
          onThreshold={(next) =>
            patch({
              threshold: patchThreshold(vl.threshold, {
                ...next,
                mode: 'hide',
                symmetric: false,
                softEdge: 0,
              }),
            })
          }
        />
      )}

      {/* ---- interpolation, and §7.1's forced-nearest flag (audit P2-08) ------------------------ */}
      <Row label="Sampling">
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
          <option value="linear">Smooth (linear)</option>
          <option value="nearest">Voxels (nearest)</option>
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

      {/* ---- the 3D surface (§4.4's iso3d) ------------------------------------------------------- */}
      <Iso3dSection layer={vl} dataset={ds} />

      {/* ---- R5's Region panel: where visibleLabels and labelOpacity are edited ------------------ */}
      {ds.isLabel && <RegionPanel layerId={vl.id} />}
    </div>
  );
}

/**
 * §4.4's `VolumeLayer.iso3d` — the **3D surface** switch and its controls (directed task 2).
 *
 * One switch and four controls, and the switch is the only one that ever appears for a label volume:
 * a label volume's surfaces are one per visible region at `label ± 0.5` in that region's LUT colour,
 * so a single iso slider and a single colour swatch would both be lies. The region panel below is
 * where those regions are chosen and recoloured, and the surfaces follow it — which is the point of
 * the volume layer owning them.
 *
 * The progress line is §8's load card, in the one-line form a property editor has room for:
 * marching cubes over 256×256×208 takes long enough to see, and a label volume queues one op per
 * region, so a switch with no progress reads as a switch that did nothing.
 */
function Iso3dSection({
  layer,
  dataset,
}: {
  layer: VolumeLayer;
  dataset: VolumeDataset;
}): React.JSX.Element {
  const controller = useController();
  const status = useUi((s) => s.iso3dPending[layer.id]);
  const spec = effectiveIso3d(layer, dataset);
  const range = iso3dRange(dataset);
  const step = iso3dStep(range);
  const regions = iso3dLabels(layer, dataset).length;
  const patch = (p: Partial<VolumeLayer>): void => controller.patchLayer<VolumeLayer>(layer.id, p);
  const pending = status !== undefined && status.pending > 0;
  const percent =
    status === undefined || status.total === 0
      ? 0
      : Math.round(((status.total - status.pending) / status.total) * 100);

  return (
    <div
      data-testid={`volume-iso3d-${layer.id}`}
      data-enabled={spec.enabled}
      data-regions={dataset.isLabel ? regions : undefined}
      className="mt-1 flex flex-col gap-1 border-t border-tvx-line pt-1.5"
    >
      <div className="flex items-center gap-1">
        <button
          type="button"
          data-testid={`volume-show-in-3d-${layer.id}`}
          aria-pressed={layer.showIn3D}
          title="Show the three anatomical slice planes in the 3D view"
          className={'tvx-btn tvx-btn-sm' + (layer.showIn3D ? ' tvx-btn-on' : '')}
          onClick={() => patch({ showIn3D: !layer.showIn3D })}
        >
          3D slices
        </button>
        <button
          type="button"
          data-testid={`volume-iso3d-toggle-${layer.id}`}
          aria-pressed={spec.enabled}
          title="Show an extracted 3D surface: an intensity boundary or the selected tissue regions"
          className={'tvx-btn tvx-btn-sm' + (spec.enabled ? ' tvx-btn-on' : '')}
          onClick={() => patch(toggleIso3d(layer, dataset, !spec.enabled))}
        >
          3D surface
        </button>
        <span
          data-testid={`volume-iso3d-summary-${layer.id}`}
          className="ml-auto font-mono text-[10px] text-tvx-dim"
        >
          {iso3dSummary(dataset, spec, regions)}
        </span>
      </div>

      {spec.enabled && (
        <>
          {!dataset.isLabel && (
            <>
              <Row label="Iso">
                <input
                  type="range"
                  data-testid={`volume-iso3d-level-${layer.id}`}
                  aria-label="3D surface iso level"
                  title="Level of the surface, over the volume's histogram range; default p95"
                  min={range.lo}
                  max={range.hi}
                  step={step}
                  value={spec.iso}
                  onChange={(e) =>
                    patch(patchIso3d(layer, dataset, { iso: Number(e.currentTarget.value) }))
                  }
                  className="h-1 flex-1 accent-tvx-accent"
                />
                <span
                  data-testid={`volume-iso3d-level-value-${layer.id}`}
                  className="w-14 shrink-0 text-right font-mono"
                >
                  {spec.iso.toPrecision(4)}
                </span>
              </Row>
              <Row label="Colour">
                <input
                  type="color"
                  data-testid={`volume-iso3d-color-${layer.id}`}
                  aria-label="3D surface colour"
                  value={vec4ToHex(spec.color)}
                  onChange={(e) =>
                    patch(
                      patchIso3d(layer, dataset, {
                        color: hexToVec4(e.currentTarget.value, spec.color[3]),
                      })
                    )
                  }
                  className="h-5 w-8 shrink-0 rounded border border-tvx-line bg-transparent p-0"
                />
              </Row>
            </>
          )}
          {dataset.isLabel && (
            <p
              data-testid={`volume-iso3d-labels-note-${layer.id}`}
              className="font-mono text-[10px] text-tvx-dim"
            >
              one surface per visible region, at label ± 0.5, in its LUT colour
            </p>
          )}
          <Row label="Opacity">
            <input
              type="range"
              data-testid={`volume-iso3d-opacity-${layer.id}`}
              aria-label="3D surface opacity"
              title="On top of the layer's opacity slider, which the surfaces follow too"
              min={0}
              max={1}
              step={0.01}
              value={spec.opacity}
              onChange={(e) =>
                patch(patchIso3d(layer, dataset, { opacity: Number(e.currentTarget.value) }))
              }
              className="h-1 flex-1 accent-tvx-accent"
            />
            <span className="w-8 shrink-0 text-right font-mono">{spec.opacity.toFixed(2)}</span>
          </Row>
          {status !== undefined && pending && (
            <div
              data-testid={`volume-iso3d-progress-${layer.id}`}
              data-pending={pending}
              data-total={status.total}
              className="flex items-center gap-2"
            >
              <span className="w-16 shrink-0 font-mono text-[10px] text-tvx-dim">building</span>
              <div className="h-1 flex-1 overflow-hidden rounded bg-tvx-line">
                <div className="h-full bg-tvx-accent" style={{ width: `${percent}%` }} />
              </div>
              <span className="w-9 shrink-0 text-right font-mono text-[10px] text-tvx-dim">
                {percent}%
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
