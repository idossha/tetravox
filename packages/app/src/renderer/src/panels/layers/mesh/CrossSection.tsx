/** Mesh cross-section visibility and outline styling. Coloring follows Field & appearance. */

import type { MeshLayer } from '@tetravox/engine';
import { useController } from '../../../ui/context';
import { Row, Section, Slider, Swatch, Toggle } from './controls';
import {
  contourColorHex,
  setContourColor,
  setContourWidth,
  setContoursIn2D,
  setFillIn2D,
} from './state';

export function CrossSection({ layer }: { layer: MeshLayer }): React.JSX.Element {
  const controller = useController();
  const patch = (p: Partial<MeshLayer>): void => controller.patchLayer(layer.id, p);
  const on = layer.fillIn2D || layer.contoursIn2D;

  return (
    <Section
      testId={`mesh-cut2d-${layer.id}`}
      title="2D cross-section"
      defaultOpen
      right={
        <span
          data-testid={`mesh-cut2d-state-${layer.id}`}
          className="shrink-0 font-mono text-[9px] text-tvx-dim"
        >
          {on ? 'on' : 'off'}
        </span>
      }
    >
      <Row label="Draw">
        <Toggle
          testId={`mesh-fill2d-${layer.id}`}
          label="Fill"
          on={layer.fillIn2D}
          title="Filled per-element cut polygons in every 2D pane (R4)"
          onChange={(v) => patch(setFillIn2D(layer, v))}
        />
        <Toggle
          testId={`mesh-contours2d-${layer.id}`}
          label="Outline"
          on={layer.contoursIn2D}
          title="Tissue-boundary contour lines in every 2D pane (R4)"
          onChange={(v) => patch(setContoursIn2D(layer, v))}
        />
      </Row>

      {layer.contoursIn2D && (
        <>
          <Row label="Outline width">
            <Slider
              testId={`mesh-contour-width-${layer.id}`}
              value={layer.contourWidthPx}
              min={0.5}
              max={6}
              step={0.5}
              format={(v) => `${v.toFixed(1)} px`}
              onChange={(v) => patch(setContourWidth(layer, v))}
            />
          </Row>

          {/* Without a dedicated contour color, the swatch follows the renderer's edge color fallback. */}
          <Row label="Outline colour">
            <Swatch
              testId={`mesh-contour-color-${layer.id}`}
              hex={contourColorHex(layer)}
              title="The colour this layer's outline draws in, in every 2D pane"
              onChange={(hex) => patch(setContourColor(layer, hex))}
            />
          </Row>
        </>
      )}
    </Section>
  );
}
