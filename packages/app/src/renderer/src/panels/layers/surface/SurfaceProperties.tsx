/**
 * The **surface** layer's property editor (2026-09-06, R4 of
 * `docs/ARCHITECTURE.md` §4.4/§8).
 *
 * Five sections and no more: **Colour** (one source at a time — solid, overlay, annotation — with
 * the picker for the chosen one and *Attach file…*), **Regions** (the annotation's atlas, only when
 * one is shown), **Appearance**, **2D outline** and **Clip planes**. There is no tissue table, no
 * isolation, no glyphs, no cross-section fill and no caps: those are a tet mesh's, and a
 * neuroscientist looking at a pial surface has never wanted them. Every control is a thin renderer
 * over `./state.ts`.
 */

import type { ColormapName, Dataset, Layer, MeshDataset, SurfaceLayer } from '@tetravox/engine';
import type { LayerPropertiesProps } from '../properties';
import { useController } from '../../../ui/context';
import { NumberField, Row, Section, Select, Slider, Swatch, Toggle } from '../mesh/controls';
import { ClipPlanes } from '../mesh/ClipPlanes';
import { hexToVec4, vec4ToHex } from '../mesh/state';
import { RegionPanel } from '../../regions/RegionPanel';
import {
  annotationNames,
  hemisphereLabel,
  overlayFields,
  setAnnotationMode,
  setAnnotationOutlineWidth,
  setBackFaces,
  setEdges,
  setFlatShading,
  setOutline,
  setOutlineColor,
  setOutlineWidth,
  setOverlayRange,
  setSolidColor,
  showAnnotation,
  showOverlay,
  showSolid,
} from './state';

const COLORMAPS = [
  'gray',
  'viridis',
  'plasma',
  'inferno',
  'magma',
  'cividis',
  'turbo',
  'jet',
  'hot',
  'cool',
  'bone',
  'coolwarm',
  'bwr',
  'freesurfer-heat',
  'blue-cyan',
] as const satisfies readonly ColormapName[];

export function surfaceSummary(dataset: Dataset, layer: Layer): string {
  if (dataset.kind !== 'mesh') return layer.kind;
  const hemi = hemisphereLabel(dataset.name);
  const counts = `${dataset.nNodes.toLocaleString()} vertices · ${dataset.nTris.toLocaleString()} triangles`;
  return hemi === null ? counts : `${hemi} · ${counts}`;
}

export function SurfaceProperties({
  layer,
  dataset,
}: LayerPropertiesProps): React.JSX.Element | null {
  if (layer.kind !== 'surface' || dataset.kind !== 'mesh') return null;
  return (
    <div data-testid={`surface-properties-${layer.id}`} className="mt-1 flex flex-col">
      <ColourSection dataset={dataset} layer={layer} />
      {layer.colorMode === 'annotation' && layer.annotation !== undefined ? (
        <Section testId={`surface-regions-${layer.id}`} title="Regions" defaultOpen>
          <RegionPanel layerId={layer.id} />
        </Section>
      ) : null}
      <AppearanceSection layer={layer} />
      <OutlineSection layer={layer} />
      <ClipPlanes dataset={dataset} layer={layer} prefix="surface" />
    </div>
  );
}

function ColourSection({
  dataset,
  layer,
}: {
  dataset: MeshDataset;
  layer: SurfaceLayer;
}): React.JSX.Element {
  const controller = useController();
  const patch = (p: Partial<SurfaceLayer>): void => controller.patchLayer(layer.id, p);
  const overlays = overlayFields(dataset);
  const atlases = annotationNames(dataset);
  const scale = layer.scale;
  const lo = scale.kind === 'linear' ? scale.lo : scale.min;
  const hi = scale.kind === 'linear' ? scale.hi : scale.max;

  return (
    <Section testId={`surface-color-${layer.id}`} title="Colour" defaultOpen>
      <Row label="Source">
        <Select
          testId={`surface-colormode-${layer.id}`}
          value={layer.colorMode}
          options={[
            { value: 'solid', label: 'solid colour' },
            {
              value: 'overlay',
              label: `overlay${overlays.length === 0 ? ' (none attached)' : ''}`,
            },
            {
              value: 'annotation',
              label: `annotation${atlases.length === 0 ? ' (none attached)' : ''}`,
            },
          ]}
          onChange={(mode) => {
            if (mode === 'solid') patch(showSolid());
            else if (mode === 'overlay') {
              const name = layer.overlay?.name ?? overlays[0]?.name;
              if (name !== undefined) patch(showOverlay(dataset, name));
            } else {
              const name = layer.annotation?.name ?? atlases[0];
              if (name !== undefined) {
                void controller.patchLayerAsync<SurfaceLayer>(
                  layer.id,
                  showAnnotation(dataset, layer, name),
                  'label'
                );
              }
            }
          }}
        />
        <button
          type="button"
          data-testid={`surface-attach-${layer.id}`}
          className="tvx-btn tvx-btn-sm ml-auto shrink-0"
          title="Attach an annotation (.annot, .label.gii) or a per-vertex overlay (curv, thickness, .func.gii)"
          onClick={() => void controller.chooseSurfaceData(layer.id)}
        >
          Attach file…
        </button>
      </Row>

      {layer.colorMode === 'solid' ? (
        <Row label="Colour">
          <Swatch
            testId={`surface-solid-color-${layer.id}`}
            hex={vec4ToHex(layer.solidColor)}
            title="The surface's single colour; also its 2D outline unless changed below"
            onChange={(hex) => patch(setSolidColor(layer, hexToVec4(hex, 1)))}
          />
        </Row>
      ) : null}

      {layer.colorMode === 'overlay' ? (
        <>
          <Row label="Overlay">
            <Select
              testId={`surface-overlay-${layer.id}`}
              value={layer.overlay?.name ?? ''}
              options={overlays.map((f) => ({ value: f.name, label: f.name }))}
              onChange={(name) => patch(showOverlay(dataset, name))}
            />
          </Row>
          <Row label="Colormap">
            <Select
              testId={`surface-colormap-${layer.id}`}
              value={layer.colormap as string}
              options={COLORMAPS.map((c) => ({ value: c, label: c }))}
              onChange={(colormap) => patch({ colormap })}
            />
          </Row>
          <Row label="Range">
            <NumberField
              testId={`surface-scale-lo-${layer.id}`}
              value={lo}
              onCommit={(v) => patch(setOverlayRange(layer, v, hi))}
            />
            <NumberField
              testId={`surface-scale-hi-${layer.id}`}
              value={hi}
              onCommit={(v) => patch(setOverlayRange(layer, lo, v))}
            />
          </Row>
        </>
      ) : null}

      {layer.colorMode === 'annotation' && layer.annotation !== undefined ? (
        <>
          <Row label="Atlas">
            <Select
              testId={`surface-annotation-${layer.id}`}
              value={layer.annotation.name}
              options={atlases.map((n) => ({ value: n, label: n }))}
              onChange={(name) =>
                void controller.patchLayerAsync<SurfaceLayer>(
                  layer.id,
                  showAnnotation(dataset, layer, name),
                  'label'
                )
              }
            />
          </Row>
          <Row label="Draw">
            <Select
              testId={`surface-annotation-mode-${layer.id}`}
              value={layer.annotation.mode}
              options={[
                { value: 'fill', label: 'fill' },
                { value: 'outline', label: 'outline' },
                { value: 'both', label: 'both' },
              ]}
              onChange={(mode) => patch(setAnnotationMode(layer, mode))}
            />
            <span className="shrink-0 text-[10px] text-tvx-dim">px</span>
            <NumberField
              testId={`surface-annotation-width-${layer.id}`}
              value={layer.annotation.outlineWidthPx}
              step={0.5}
              min={0.5}
              max={8}
              onCommit={(w) => patch(setAnnotationOutlineWidth(layer, w))}
            />
          </Row>
        </>
      ) : null}
    </Section>
  );
}

function AppearanceSection({ layer }: { layer: SurfaceLayer }): React.JSX.Element {
  const controller = useController();
  const patch = (p: Partial<SurfaceLayer>): void => controller.patchLayer(layer.id, p);
  return (
    <Section testId={`surface-appearance-${layer.id}`} title="Appearance" defaultOpen>
      <Row label="Opacity">
        <Slider
          testId={`surface-opacity-${layer.id}`}
          value={layer.opacity}
          min={0}
          max={1}
          step={0.01}
          onChange={(opacity) => patch({ opacity })}
        />
      </Row>
      <Row label="Shading">
        <Toggle
          testId={`surface-flat-${layer.id}`}
          label="flat"
          on={layer.flatShading}
          onChange={(v) => patch(setFlatShading(v))}
        />
        <Toggle
          testId={`surface-backfaces-${layer.id}`}
          label="back faces"
          on={layer.faceMode === 'both'}
          title="Draw both sides; forced on for a surface with open edges"
          onChange={(v) => patch(setBackFaces(v))}
        />
        <Toggle
          testId={`surface-edges-${layer.id}`}
          label="edges"
          on={layer.edges}
          title="Triangle edges (the first switch builds the de-indexed variant, §7.4)"
          onChange={(v) => {
            if (v && !layer.edges) {
              void controller.patchLayerAsync<SurfaceLayer>(layer.id, setEdges(true), 'edges');
              return;
            }
            patch(setEdges(v));
          }}
        />
      </Row>
    </Section>
  );
}

function OutlineSection({ layer }: { layer: SurfaceLayer }): React.JSX.Element {
  const controller = useController();
  const patch = (p: Partial<SurfaceLayer>): void => controller.patchLayer(layer.id, p);
  return (
    <Section testId={`surface-outline-${layer.id}`} title="2D outline" defaultOpen>
      <Row label="Draw">
        <Toggle
          testId={`surface-outline-on-${layer.id}`}
          label={layer.contoursIn2D ? 'on' : 'off'}
          on={layer.contoursIn2D}
          title="The surface's intersection with each slice, as a line (§7.4)"
          onChange={(v) => patch(setOutline(v))}
        />
        <span className="shrink-0 text-[10px] text-tvx-dim">px</span>
        <NumberField
          testId={`surface-outline-width-${layer.id}`}
          value={layer.contourWidthPx}
          step={0.5}
          min={0.5}
          max={8}
          onCommit={(w) => patch(setOutlineWidth(w))}
        />
        <Swatch
          testId={`surface-outline-color-${layer.id}`}
          hex={vec4ToHex(layer.contourColor)}
          title="Outline colour"
          onChange={(hex) => patch(setOutlineColor(hexToVec4(hex, 1)))}
        />
      </Row>
    </Section>
  );
}
