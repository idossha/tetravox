/**
 * §7.4's **six clip planes**, and §7.5's "cut plane: sliders (normal preset + free normal + offset)".
 *
 * Per plane: enable, a preset normal (axial / coronal / sagittal), free normal sliders, an offset
 * slider that scrubs across the scene's own extent, flip, and **follow cursor**. Plus the layer-wide
 * cap switch and `capColorMode`.
 *
 * **Flip is `n → −n`, `offset → −offset`.** Negating only the normal moves the plane to its mirror
 * about the origin, which looks right at `offset == 0` and is wrong everywhere else; `state.ts` has
 * the derivation and `state.test.ts` pins it.
 *
 * **Follow cursor is layer state.** `ClipPlane.followCursor` (§4.4, added by the Phase-2 integrator
 * from this panel's filing) holds the flag, so it is one `updateLayer` like every other control here
 * and it survives `serialize()` / `load()`. The controller re-issues the offset on every `cursor`
 * event; the arithmetic is `planesThroughCursor` in `state.ts`, never in this file.
 */

import type { MeshDataset, MeshLayer, vec3 } from '@tetravox/engine';
import { useController, useUi } from '../../../ui/context';
import { NumberField, Row, Section, Select, Slider, Toggle } from './controls';
import {
  CLIP_PRESETS,
  MAX_CLIP_PLANES,
  addClipPlane,
  flipClipPlane,
  offsetThrough,
  removeClipPlane,
  setCapColorMode,
  setClipCaps,
  setClipEnabled,
  setClipNormal,
  setClipOffset,
} from './state';

/**
 * How far the offset slider must reach. `offset = −dot(n, p)` for a unit `n`, so over the bounding
 * box the extreme is the corner farthest from the origin — which is what this is. The mesh bounds are
 * not centred on the origin (`ernie.msh` is y ∈ [−92.4, 136.2]), so a half-diagonal would fall short.
 */
function offsetRange(dataset: MeshDataset): number {
  const { min, max } = dataset.bounds;
  const far = Math.max(
    Math.abs(min[0]),
    Math.abs(max[0]),
    Math.abs(min[1]),
    Math.abs(max[1]),
    Math.abs(min[2]),
    Math.abs(max[2])
  );
  return Math.max(1, Math.ceil(far * Math.sqrt(3)));
}

export function ClipPlanes({
  dataset,
  layer,
}: {
  dataset: MeshDataset;
  layer: MeshLayer;
}): React.JSX.Element {
  const controller = useController();
  const cursor = useUi((s) => s.cursor);
  const patch = (p: Partial<MeshLayer>): void => controller.patchLayer(layer.id, p);
  const planes = layer.clip.planes;
  const limit = offsetRange(dataset);

  return (
    <Section
      testId={`mesh-clip-${layer.id}`}
      title={`Clip planes (${planes.length}/${MAX_CLIP_PLANES})`}
      right={
        <button
          type="button"
          data-testid={`mesh-clip-add-${layer.id}`}
          className="tvx-btn tvx-btn-sm"
          disabled={planes.length >= MAX_CLIP_PLANES}
          title="Add a plane through the cursor, normal +Z"
          onClick={(e) => {
            e.stopPropagation();
            patch(addClipPlane(layer, [0, 0, 1], offsetThrough([0, 0, 1], cursor)));
          }}
        >
          + plane
        </button>
      }
    >
      {planes.length === 0 ? (
        <p data-testid={`mesh-clip-empty-${layer.id}`} className="text-[10px] text-tvx-dim">
          No clip plane. §7.4 allows up to six, each with exact caps.
        </p>
      ) : null}

      {planes.map((clip, index) => {
        const n = clip.plane.normal;
        const follows = clip.followCursor === true;
        const setNormal = (next: vec3): void => {
          const p = setClipNormal(layer, index, next);
          controller.patchLayer(layer.id, p);
          // A plane that follows the cursor keeps doing so through a normal change.
          if (follows) controller.applyClipFollowsCursor(layer.id);
        };
        return (
          <div
            key={index}
            data-testid={`mesh-clip-plane-${layer.id}-${index}`}
            data-enabled={clip.enabled}
            data-follows-cursor={follows}
            className="rounded border border-tvx-line/60 p-1"
          >
            <div className="flex items-center gap-1">
              <Toggle
                testId={`mesh-clip-enabled-${layer.id}-${index}`}
                label={`#${index + 1}`}
                on={clip.enabled}
                onChange={(v) => patch(setClipEnabled(layer, index, v))}
              />
              {CLIP_PRESETS.map((preset) => (
                <button
                  key={preset.name}
                  type="button"
                  data-testid={`mesh-clip-preset-${layer.id}-${index}-${preset.name}`}
                  className="tvx-btn tvx-btn-sm"
                  title={`Normal ${preset.normal.join(', ')}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setNormal(preset.normal);
                  }}
                >
                  {preset.name.slice(0, 3)}
                </button>
              ))}
              <button
                type="button"
                data-testid={`mesh-clip-flip-${layer.id}-${index}`}
                className="tvx-btn tvx-btn-sm"
                title="Keep the other side (the plane does not move)"
                onClick={(e) => {
                  e.stopPropagation();
                  patch(flipClipPlane(layer, index));
                }}
              >
                flip
              </button>
              <button
                type="button"
                data-testid={`mesh-clip-remove-${layer.id}-${index}`}
                className="tvx-btn tvx-btn-sm ml-auto"
                aria-label={`Remove clip plane ${index + 1}`}
                onClick={(e) => {
                  e.stopPropagation();
                  controller.setClipFollowsCursor(layer.id, index, false);
                  patch(removeClipPlane(layer, index));
                }}
              >
                ✕
              </button>
            </div>

            <Row label="Normal">
              {([0, 1, 2] as const).map((axis) => (
                <NumberField
                  key={axis}
                  testId={`mesh-clip-normal-${layer.id}-${index}-${axis}`}
                  value={Number(n[axis].toFixed(3))}
                  step={0.05}
                  min={-1}
                  max={1}
                  width="w-14"
                  onCommit={(v) => {
                    const next: vec3 = [n[0], n[1], n[2]];
                    next[axis] = v;
                    setNormal(next);
                  }}
                />
              ))}
            </Row>

            <Row label="Offset">
              <Slider
                testId={`mesh-clip-offset-${layer.id}-${index}`}
                value={clip.plane.offset}
                min={-limit}
                max={limit}
                step={0.5}
                format={(v) => `${v.toFixed(1)}`}
                onChange={(v) => patch(setClipOffset(layer, index, v))}
              />
            </Row>

            <Row label="Follow">
              <Toggle
                testId={`mesh-clip-follow-${layer.id}-${index}`}
                label="cursor"
                on={follows}
                title="Keep this plane through the cursor as it moves"
                onChange={(v) => controller.setClipFollowsCursor(layer.id, index, v)}
              />
              <button
                type="button"
                data-testid={`mesh-clip-tocursor-${layer.id}-${index}`}
                className="tvx-btn tvx-btn-sm"
                title="Move the plane through the cursor once"
                onClick={(e) => {
                  e.stopPropagation();
                  patch(setClipOffset(layer, index, offsetThrough(n, cursor)));
                }}
              >
                to cursor
              </button>
            </Row>
          </div>
        );
      })}

      <Row label="Caps">
        <Toggle
          testId={`mesh-clip-caps-${layer.id}`}
          label={layer.clip.caps ? 'exact caps' : 'no caps'}
          on={layer.clip.caps}
          title="Exact per-element cap polygons from `plane_cut` (§7.4)"
          onChange={(v) => patch(setClipCaps(layer, v))}
        />
        <Select
          testId={`mesh-clip-capcolor-${layer.id}`}
          value={layer.clip.capColorMode}
          options={[
            { value: 'inherit', label: 'inherit' },
            { value: 'tag', label: 'by tag' },
          ]}
          onChange={(m) => patch(setCapColorMode(layer, m))}
        />
      </Row>
    </Section>
  );
}
