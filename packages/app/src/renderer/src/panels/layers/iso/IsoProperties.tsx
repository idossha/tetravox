/**
 * The **isosurface** layer's property editor (§4.4's `IsosurfaceLayer`), Phase 2.
 *
 * Source, iso level (a slider over the **source's own** range), colour, opacity, smooth and
 * `faceMode`. The engine half is `layers/iso.ts` (E-DERIVED); the `tvx-geom` half — `marching_cubes`
 * / `marching_tets`, with the analytic-sphere test — landed in Phase 1.
 *
 * The controls come from `../mesh/controls`: the properties editors are split in two and
 * `panels/layers/` itself is shared, so this half keeps its primitives inside its own directories
 * rather than adding a file at the shared root.
 */

import { useMemo } from 'react';
import type { Dataset, IsosurfaceLayer, Layer } from '@tetravox/engine';
import type { LayerPropertiesProps } from '../properties';
import { useController, useUi } from '../../../ui/context';
import { NumberField, Row, Section, Select, Slider, Swatch, Toggle } from '../mesh/controls';
import { hexToVec4, vec4ToHex } from '../mesh/state';
import {
  isoRange,
  isoSourceKey,
  isoSourceOptions,
  isoStep,
  selectIsoSource,
  setIso,
  setIsoColor,
  setIsoFaceMode,
  setIsoSmooth,
} from './state';

export function isoSummary(dataset: Dataset, layer: Layer): string {
  if (layer.kind !== 'iso') return layer.kind;
  const level = Number.isFinite(layer.iso) ? layer.iso.toPrecision(4) : '—';
  const where = layer.source?.field?.name ?? dataset.name;
  return `iso ${level} · ${where}`;
}

export function IsoProperties({ layer }: LayerPropertiesProps): React.JSX.Element | null {
  // The kind guard comes **before** the hooks on purpose. `LayerProperties` dispatches on
  // `layer.kind` and a layer's kind never changes, so one mounted instance always takes the same
  // branch and the hook order is stable — and a mismatched kind (which only a test or a half-built
  // layer produces) then costs nothing and needs no provider.
  if (layer.kind !== 'iso') return null;
  return <IsoEditor layer={layer} />;
}

function IsoEditor({ layer }: { layer: IsosurfaceLayer }): React.JSX.Element {
  const controller = useController();
  const datasets = useUi((s) => s.datasets);
  const options = useMemo(() => isoSourceOptions(datasets), [datasets]);
  const iso: IsosurfaceLayer = layer;
  const range = isoRange(options, iso);
  const step = isoStep(range);
  const patch = (p: Partial<IsosurfaceLayer>): void =>
    controller.patchLayer<IsosurfaceLayer>(iso.id, p);

  return (
    <div data-testid={`iso-properties-${iso.id}`} className="mt-1 flex flex-col">
      <Section testId={`iso-section-${iso.id}`} title="Isosurface" defaultOpen>
        <Row label="Source">
          <Select
            testId={`iso-source-${iso.id}`}
            value={isoSourceKey(iso)}
            options={
              options.length === 0
                ? [{ value: isoSourceKey(iso), label: '(source not in the scene)' }]
                : options.map((o) => ({ value: o.key, label: o.label }))
            }
            onChange={(key) => patch(selectIsoSource(options, key))}
          />
        </Row>
        <Row label="Iso level">
          <Slider
            testId={`iso-level-${iso.id}`}
            value={iso.iso}
            min={range.lo}
            max={range.hi}
            step={step}
            format={(v) => v.toPrecision(4)}
            onChange={(v) => patch(setIso(iso, v))}
          />
        </Row>
        <Row label="Exact">
          <NumberField
            testId={`iso-level-exact-${iso.id}`}
            value={iso.iso}
            step={step}
            width="w-24"
            onCommit={(v) => patch(setIso(iso, v))}
          />
          <span
            data-testid={`iso-range-${iso.id}`}
            className="ml-auto shrink-0 font-mono text-[9px] text-tvx-dim"
          >
            {range.lo.toPrecision(3)} … {range.hi.toPrecision(3)}
          </span>
        </Row>
        <Row label="Colour">
          <Swatch
            testId={`iso-color-${iso.id}`}
            hex={vec4ToHex(iso.color)}
            title="Isosurface colour"
            onChange={(hex) => patch(setIsoColor(iso, hexToVec4(hex, iso.color[3])))}
          />
          <span className="shrink-0 text-[10px] text-tvx-dim">opacity</span>
          <Slider
            testId={`iso-opacity-${iso.id}`}
            value={iso.opacity}
            min={0}
            max={1}
            step={0.01}
            onChange={(opacity) => patch({ opacity })}
          />
        </Row>
        <Row label="Shading">
          <Toggle
            testId={`iso-smooth-${iso.id}`}
            label={iso.smooth ? 'smooth' : 'flat'}
            on={iso.smooth}
            onChange={(v) => patch(setIsoSmooth(iso, v))}
          />
          <Toggle
            testId={`iso-facemode-${iso.id}`}
            label={iso.faceMode === 'both' ? 'two-sided' : 'cull back'}
            on={iso.faceMode === 'both'}
            onChange={(v) => patch(setIsoFaceMode(iso, v ? 'both' : 'cull'))}
          />
        </Row>
      </Section>
    </div>
  );
}
