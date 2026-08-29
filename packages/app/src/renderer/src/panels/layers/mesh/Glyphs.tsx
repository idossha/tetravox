/**
 * §4.4's `GlyphSpec`: field, stride, scale mode, length and colour.
 *
 * Only **vector** fields appear in the selector — a scalar has no direction, so it can never drive a
 * glyph. On the reference data that means `ernie_TDCS_1_scalar.msh`'s `E` (ncomp 3, magnitude
 * 8.56e-13 … 57.79); `Thalamus_TI.msh` carries `TI_max` alone and this panel says so rather than
 * offering a control that would produce nothing.
 *
 * The renderer is E-DERIVED's, and `clipToCutPlane` is the case §6.5.2 can already serve
 * (`CutPayload.positions` + `ownerTet`), so it is offered here with that note attached.
 *
 * **Origins** picks between the two tables §7.4 names: the layer's own surface (one origin per
 * surface triangle) or §6.5.2's `meshCentroids` (one per **tet**, which is the only way the interior
 * of `ernie_TDCS_1_scalar.msh` gets arrows at all). A mesh with no tets can only serve the first, so
 * the control says so instead of offering a choice that would render nothing.
 */

import type { MeshDataset, MeshLayer } from '@tetravox/engine';
import { useController } from '../../../ui/context';
import { NumberField, Row, Section, Select, Slider, Swatch, Toggle } from './controls';
import { glyphLegendLine, glyphScaling, referenceMagnitude } from '@tetravox/engine';
import type { GlyphScaling } from '@tetravox/engine';
import {
  disableGlyphs,
  enableGlyphs,
  fieldKey,
  glyphOrigins,
  glyphOriginsAvailable,
  glyphNormalizeKey,
  glyphStrideText,
  hexToVec4,
  patchGlyphs,
  setGlyphField,
  setGlyphMaxCount,
  setGlyphOrigins,
  setGlyphScaling,
  setGlyphStride,
  vec4ToHex,
  vectorFields,
} from './state';

export function Glyphs({
  dataset,
  layer,
}: {
  dataset: MeshDataset;
  layer: MeshLayer;
}): React.JSX.Element {
  const controller = useController();
  const patch = (p: Partial<MeshLayer>): void => controller.patchLayer(layer.id, p);
  const vectors = vectorFields(dataset);
  const spec = layer.glyphs;
  // The panel states the same sentence the overlay legend does, from the same function: two
  // spellings of one scaling model is how a picture and its key end up disagreeing.
  const scaling = spec === undefined ? null : glyphScaling(spec);
  const info =
    spec === undefined
      ? undefined
      : dataset.fields.find((f) => f.name === spec.field.name && f.source === spec.field.source);
  const hasCutPlane = layer.clip.planes.some((p) => p.enabled);

  return (
    <Section
      testId={`mesh-glyphs-${layer.id}`}
      title="Glyphs"
      right={
        <Toggle
          testId={`mesh-glyphs-enabled-${layer.id}`}
          label={spec === undefined ? 'off' : 'on'}
          on={spec !== undefined}
          disabled={vectors.length === 0}
          title={
            vectors.length === 0
              ? 'This mesh carries no vector field'
              : 'One instanced draw per visible element (§7.4)'
          }
          onChange={(on) => patch(on ? enableGlyphs(dataset, layer) : disableGlyphs(layer))}
        />
      }
    >
      {vectors.length === 0 ? (
        <p data-testid={`mesh-glyphs-none-${layer.id}`} className="text-[10px] text-tvx-dim">
          No vector field. <code>ernie_TDCS_1_scalar.msh</code>’s <code>E</code> is the reference
          case.
        </p>
      ) : spec === undefined || scaling === null ? (
        <p className="text-[10px] text-tvx-dim">Off.</p>
      ) : (
        <>
          <Row label="Field">
            <Select
              testId={`mesh-glyph-field-${layer.id}`}
              value={fieldKey(spec.field)}
              options={vectors.map((f) => ({
                value: fieldKey(f),
                label: `${f.name} (${f.source})`,
              }))}
              onChange={(key) => patch(setGlyphField(dataset, layer, key))}
            />
          </Row>
          <Row label="Shape">
            <Select
              testId={`mesh-glyph-shape-${layer.id}`}
              value={spec.shape}
              options={[
                { value: 'arrow', label: 'arrow' },
                { value: 'line', label: 'line' },
              ]}
              onChange={(shape) => patch(patchGlyphs(layer, { shape }))}
            />
          </Row>
          <Row label="Origins">
            <Select
              testId={`mesh-glyph-origins-${layer.id}`}
              value={glyphOrigins(spec)}
              options={[
                { value: 'surface', label: 'surface' },
                { value: 'volume', label: 'volume (tets)' },
              ]}
              disabled={!glyphOriginsAvailable(dataset)}
              onChange={(origins) => patch(setGlyphOrigins(dataset, layer, origins))}
            />
            <span
              data-testid={`mesh-glyph-origins-note-${layer.id}`}
              className="ml-auto shrink-0 text-[9px] text-tvx-dim"
            >
              {glyphOriginsAvailable(dataset)
                ? glyphOrigins(spec) === 'volume'
                  ? 'one per tet (§6.5.2 meshCentroids)'
                  : 'one per surface triangle'
                : 'no tets: surface only'}
            </span>
          </Row>
          <Row label="Stride">
            <Select
              testId={`mesh-glyph-stridemode-${layer.id}`}
              value={'everyNth' in spec.subsample ? 'everyNth' : 'maxCount'}
              options={[
                { value: 'everyNth', label: 'every Nth' },
                { value: 'maxCount', label: 'max count' },
              ]}
              onChange={(mode) =>
                patch(
                  mode === 'everyNth' ? setGlyphStride(layer, 100) : setGlyphMaxCount(layer, 20_000)
                )
              }
            />
            <NumberField
              testId={`mesh-glyph-stride-${layer.id}`}
              value={
                'everyNth' in spec.subsample ? spec.subsample.everyNth : spec.subsample.maxCount
              }
              step={'everyNth' in spec.subsample ? 1 : 1000}
              min={1}
              width="w-20"
              onCommit={(v) =>
                patch(
                  'everyNth' in spec.subsample
                    ? setGlyphStride(layer, v)
                    : setGlyphMaxCount(layer, v)
                )
              }
            />
          </Row>
          <Row label="Scale">
            <Select
              testId={`mesh-glyph-scale-${layer.id}`}
              value={scaling.mode}
              options={[
                { value: 'fixed', label: 'fixed' },
                { value: 'linear', label: 'linear' },
                { value: 'sqrt', label: 'sqrt' },
                { value: 'log', label: 'log10' },
              ]}
              onChange={(mode) =>
                patch(setGlyphScaling(layer, { mode: mode as GlyphScaling['mode'] }))
              }
            />
            <Select
              testId={`mesh-glyph-normalize-${layer.id}`}
              value={glyphNormalizeKey(spec)}
              disabled={scaling.mode === 'fixed'}
              options={[
                { value: 'p99', label: 'to p99' },
                { value: 'max', label: 'to max' },
                { value: 'value', label: 'to value' },
                { value: 'none', label: 'per unit' },
              ]}
              onChange={(key) =>
                patch(
                  setGlyphScaling(layer, {
                    normalizeTo:
                      key === 'none'
                        ? null
                        : key === 'value'
                          ? referenceMagnitude(scaling, info?.stats)
                          : (key as 'p99' | 'max'),
                  })
                )
              }
            />
          </Row>
          {glyphNormalizeKey(spec) === 'value' && (
            <Row label="Reference">
              <NumberField
                testId={`mesh-glyph-normalize-value-${layer.id}`}
                value={referenceMagnitude(scaling, info?.stats)}
                step={0.1}
                min={0}
                width="w-24"
                onCommit={(normalizeTo) => patch(setGlyphScaling(layer, { normalizeTo }))}
              />
              <span className="ml-auto shrink-0 text-[9px] text-tvx-dim">
                {info === undefined ? '' : `field max ${info.stats.max.toPrecision(4)}`}
              </span>
            </Row>
          )}
          {scaling.mode === 'log' && (
            <Row label="Log floor">
              <NumberField
                testId={`mesh-glyph-logfloor-${layer.id}`}
                value={scaling.logFloor}
                step={0.01}
                min={0}
                width="w-24"
                onCommit={(logFloor) => patch(setGlyphScaling(layer, { logFloor }))}
              />
              <span className="ml-auto shrink-0 text-[9px] text-tvx-dim">
                below this an arrow has no length
              </span>
            </Row>
          )}
          <Row label="Length mm">
            <Slider
              testId={`mesh-glyph-length-${layer.id}`}
              value={scaling.lengthMm}
              min={0.5}
              max={30}
              step={0.5}
              format={(v) => `${v.toFixed(1)}`}
              onChange={(lengthMm) => patch(setGlyphScaling(layer, { lengthMm }))}
            />
          </Row>
          <Row label="Head">
            <Slider
              testId={`mesh-glyph-head-${layer.id}`}
              value={spec.headProportion ?? 0.3}
              min={0}
              max={0.9}
              step={0.05}
              format={(v) => (spec.shape === 'arrow' ? `${Math.round(v * 100)}%` : 'none')}
              onChange={(headProportion) => patch(patchGlyphs(layer, { headProportion }))}
            />
          </Row>
          <Row label="Colour">
            <Select
              testId={`mesh-glyph-colorby-${layer.id}`}
              value={spec.colorBy}
              options={[
                { value: 'magnitude', label: 'by magnitude' },
                { value: 'solid', label: 'solid' },
              ]}
              onChange={(colorBy) => patch(patchGlyphs(layer, { colorBy }))}
            />
            <Swatch
              testId={`mesh-glyph-color-${layer.id}`}
              hex={vec4ToHex(spec.color)}
              title="Glyph colour (used when colouring is solid)"
              onChange={(hex) =>
                patch(patchGlyphs(layer, { color: hexToVec4(hex, spec.color[3]) }))
              }
            />
          </Row>
          <Row label="Restrict">
            <Toggle
              testId={`mesh-glyph-cliptocut-${layer.id}`}
              label="to cut plane"
              on={spec.onCutPlaneOnly === true || spec.clipToCutPlane}
              disabled={!hasCutPlane}
              title={
                hasCutPlane
                  ? 'Only origins within the slab about the first enabled clip plane (§7.4)'
                  : 'Enable a clip plane first: there is no other cut plane in a 3D pane'
              }
              onChange={(on) =>
                patch(patchGlyphs(layer, { onCutPlaneOnly: on, clipToCutPlane: on }))
              }
            />
            <NumberField
              testId={`mesh-glyph-slab-${layer.id}`}
              value={spec.cutSlabMm ?? 1}
              step={0.5}
              min={0.1}
              width="w-16"
              onCommit={(cutSlabMm) => patch(patchGlyphs(layer, { cutSlabMm }))}
            />
            <span
              data-testid={`mesh-glyph-summary-${layer.id}`}
              className="ml-auto shrink-0 font-mono text-[9px] text-tvx-dim"
            >
              {glyphStrideText(spec)}
            </span>
          </Row>
          <Row label="Slices">
            <Toggle
              testId={`mesh-glyph-in2d-${layer.id}`}
              label="in 2D panes"
              on={spec.in2D === true}
              title="Draw the arrows on the 2D slices too, from each pane's own cut. A slice shows the in-plane component: length and colour follow it, and a vector normal to the slice draws nothing"
              onChange={(in2D) => patch(patchGlyphs(layer, { in2D }))}
            />
            {spec.in2D === true ? (
              <span className="ml-auto shrink-0 font-mono text-[9px] text-tvx-dim">in-plane</span>
            ) : null}
          </Row>
          <p
            data-testid={`mesh-glyph-legend-${layer.id}`}
            className="font-mono text-[9px] leading-tight text-tvx-dim"
          >
            {glyphLegendLine(spec, info)}
          </p>
        </>
      )}
    </Section>
  );
}
