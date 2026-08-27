/**
 * The **tag LUT**: `tag → RGBA8`, the table every derived draw looks a tissue colour up in.
 *
 * Why a LUT indexed by the raw tag rather than a dense remap: §7.6 measures what real files carry —
 * `ernie_TDCS_1_scalar.msh` has tri tags 1101/1102/1501/1502/2101/2102 and tet tags 101/102/501/502
 * on top of the ten tissue tags, the SEEG meshes add 13–16 — and **tags are not contiguous**
 * (tag 4 is absent from ernie `[DATA]`). A dense remap would need a second table and a search; a
 * direct table costs `4 · (maxTag + 1)` bytes, which is 8.4 KB at tag 2102 and is uploaded once per
 * `tagStyle` edit, never per frame.
 *
 * **Alpha is the whole visibility and opacity mechanism.** `tagStyle[tag].visible === false` writes
 * alpha 0, and the shader discards on it: a hidden tissue contributes no fragment at all, so R5's
 * "hiding a label removes its colour from the pane pixels while others are unchanged" holds by
 * construction rather than by a second draw.
 *
 * **The colour bytes are the wire bytes.** §4.1 requires `MeshMeta.tags[].color`'s `[u8;4]` to
 * round-trip exactly through the engine's 0..1 form, and `round(c · 255)` is the inverse of
 * `fromMeta.ts`'s `c / 255` for every byte. That exactness is what R4's "the pixel equals the tag
 * colour" asserts.
 */

import { tagColor } from '../render/passes/mesh';
import type { MeshDataset, MeshLayer } from '../scene/types';

/** Tags above this are dropped rather than sized into a multi-megabyte table. */
export const MAX_TAG = 65535;

export interface TagLut {
  /** RGBA8, `4 · count` bytes, indexed by tag. */
  rgba: Uint8Array;
  /** `maxTag + 1`. */
  count: number;
  /** Identifies these bytes, so the texture is re-uploaded only when they change. */
  key: string;
}

function byte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

/**
 * Build the LUT for one layer.
 *
 * Precedence is `render/passes/mesh.ts`'s {@link tagColor} — the layer's per-tag override, then the
 * dataset's own tag colour (`$PhysicalNames` / `.msh.opt` / §7.6's default palette), then the
 * layer's solid colour — so a 2D cut and a 3D surface can never disagree about what a tissue looks
 * like.
 */
export function buildTagLut(layer: MeshLayer, ds: MeshDataset): TagLut {
  let maxTag = 0;
  for (const t of ds.tags) if (t.id > maxTag && t.id <= MAX_TAG) maxTag = t.id;
  for (const k of Object.keys(layer.tagStyle)) {
    const id = Number(k);
    if (Number.isFinite(id) && id > maxTag && id <= MAX_TAG) maxTag = id;
  }
  const count = maxTag + 1;
  const rgba = new Uint8Array(count * 4);
  const parts: string[] = [];
  for (const t of ds.tags) {
    if (t.id < 0 || t.id > maxTag) continue;
    const style = layer.tagStyle[t.id];
    const c = tagColor(layer, ds, t.id);
    const visible = style?.visible ?? true;
    const alpha = visible ? byte(c[3] * (style?.opacity ?? 1)) : 0;
    const o = t.id * 4;
    rgba[o] = byte(c[0]);
    rgba[o + 1] = byte(c[1]);
    rgba[o + 2] = byte(c[2]);
    rgba[o + 3] = alpha;
    parts.push(`${t.id}:${rgba[o]},${rgba[o + 1]},${rgba[o + 2]},${alpha}`);
  }
  return { rgba, count, key: `${layer.colorMode}|${parts.join(';')}` };
}
