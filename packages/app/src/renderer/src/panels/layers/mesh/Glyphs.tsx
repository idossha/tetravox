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
import {
  disableGlyphs,
  enableGlyphs,
  fieldKey,
  glyphOrigins,
  glyphOriginsAvailable,
  glyphStrideText,
  hexToVec4,
  patchGlyphs,
  setGlyphField,
  setGlyphMaxCount,
  setGlyphOrigins,
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
      ) : spec === undefined ? (
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
              value={spec.scale}
              options={[
                { value: 'fixed', label: 'fixed' },
                { value: 'byMagnitude', label: 'by magnitude' },
              ]}
              onChange={(scale) => patch(patchGlyphs(layer, { scale }))}
            />
          </Row>
          <Row label="Length mm">
            <Slider
              testId={`mesh-glyph-length-${layer.id}`}
              value={spec.lengthMm}
              min={0.5}
              max={30}
              step={0.5}
              format={(v) => `${v.toFixed(1)}`}
              onChange={(lengthMm) => patch(patchGlyphs(layer, { lengthMm }))}
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
              on={spec.clipToCutPlane}
              title="Only elements the active cut plane intersects (§7.4)"
              onChange={(clipToCutPlane) => patch(patchGlyphs(layer, { clipToCutPlane }))}
            />
            <span
              data-testid={`mesh-glyph-summary-${layer.id}`}
              className="ml-auto shrink-0 font-mono text-[9px] text-tvx-dim"
            >
              {glyphStrideText(spec)}
            </span>
          </Row>
        </>
      )}
    </Section>
  );
}
