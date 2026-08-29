/**
 * Every mesh-editor control, as a **pure function from the layer to a `Partial<MeshLayer>`** (§8:
 * "everything the UI can do must be reachable from the `Engine` API alone. No logic in React.").
 *
 * The components in this directory do exactly two things: render the current layer, and hand one of
 * these patches to `ShellController.patchLayer`, which is one `Engine.updateLayer` call. That is what
 * makes the whole editor testable without a DOM — `state.test.ts` asserts the patch, and the E2E
 * asserts that the control emits it.
 *
 * Nothing here reads or writes the scene. A patch is a value; applying it is the engine's business.
 */

import type {
  ClipPlane,
  ColormapName,
  GlyphScaling,
  GlyphSpec,
  IsolateSpec,
  MeshDataset,
  MeshFieldInfo,
  MeshLayer,
  Scale,
  Threshold,
  VolumeDataset,
  vec3,
  vec4,
} from '@tetravox/engine';
import { DEFAULT_GLYPH_LENGTH_MM, glyphScaling } from '@tetravox/engine';

// ------------------------------------------------------------------------------------------------
// Small shared arithmetic
// ------------------------------------------------------------------------------------------------

export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export function dot3(a: vec3, b: vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Unit-length, or `null` when the input is degenerate — a zero normal is not a plane. */
export function normalize3(v: vec3): vec3 | null {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!Number.isFinite(len) || len < 1e-9) return null;
  return [v[0] / len, v[1] / len, v[2] / len];
}

/**
 * §4.1's colour convention is 0..1 floats everywhere in §4, and the **wire** form is 0..255. That
 * rule names `scene/fromMeta.ts` as the only place that converts *wire* colours, and these two are
 * not that: a colour the user just picked in an `<input type="color">` never came off a wire. The
 * round trip is exact because every hex value is `k / 255` (§11's "make the colours exact 8-bit
 * values"), so a swatch shown for a tag colour and saved back unedited is byte-identical.
 */
export function vec4ToHex(c: vec4): string {
  const byte = (x: number): string =>
    Math.max(0, Math.min(255, Math.round(x * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${byte(c[0])}${byte(c[1])}${byte(c[2])}`;
}

export function hexToVec4(hex: string, alpha = 1): vec4 {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (m === null) return [0, 0, 0, alpha];
  const n = Number.parseInt(m[1] as string, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, alpha];
}

// ------------------------------------------------------------------------------------------------
// `tagStyle` — what the Region panel's tissue rows write (§8, R5)
// ------------------------------------------------------------------------------------------------
//
// The mesh editor's own tissue table is gone: it listed the same tissues the Region panel lists, and
// both listed every tissue twice because a `.msh` carries a volume tag and a surface tag per
// tissue. `panels/regions/regions.ts` is the one list now, and it owns the row model. What stays
// here are the two per-tag primitives the rest of the editor still needs.

export interface TagStyleEntry {
  visible: boolean;
  opacity: number;
  color?: vec4;
  /** Per-tissue paint (`regions.ts`'s `paintPatch`): the field, or the fixed colour. */
  colorMode?: 'field' | 'color';
}

const DEFAULT_STYLE: TagStyleEntry = { visible: true, opacity: 1 };

export function styleOf(layer: MeshLayer, tag: number): TagStyleEntry {
  return layer.tagStyle[tag] ?? DEFAULT_STYLE;
}

function withStyle(
  layer: MeshLayer,
  tags: readonly number[],
  edit: (current: TagStyleEntry) => TagStyleEntry
): Partial<MeshLayer> {
  const next: MeshLayer['tagStyle'] = { ...layer.tagStyle };
  for (const tag of tags) next[tag] = edit(styleOf(layer, tag));
  return { tagStyle: next };
}

export function setTagVisible(layer: MeshLayer, tag: number, visible: boolean): Partial<MeshLayer> {
  return withStyle(layer, [tag], (s) => ({ ...s, visible }));
}

/** R5's Alt-click solo: exactly one tag left visible, every other tag in `tags` hidden. */
export function soloTag(
  layer: MeshLayer,
  tags: readonly number[],
  tag: number
): Partial<MeshLayer> {
  const next: MeshLayer['tagStyle'] = { ...layer.tagStyle };
  for (const t of tags) next[t] = { ...styleOf(layer, t), visible: t === tag };
  return { tagStyle: next };
}

// ------------------------------------------------------------------------------------------------
// The field selector
// ------------------------------------------------------------------------------------------------

/** A stable id for a field, since a node field and an element field may share a name. */
export function fieldKey(field: { source: 'node' | 'elm'; name: string }): string {
  return `${field.source}:${field.name}`;
}

export function findField(dataset: MeshDataset, key: string): MeshFieldInfo | null {
  return dataset.fields.find((f) => fieldKey(f) === key) ?? null;
}

/** The components a field offers: scalars only `mag`; vectors and tensors also x / y / z. */
export function componentsOf(field: MeshFieldInfo): ('mag' | 0 | 1 | 2)[] {
  return field.ncomp === 1 ? ['mag'] : ['mag', 0, 1, 2];
}

/**
 * Switching the colour source. Choosing `'field'` also turns the layer's colour bar on:
 * `scene/defaults.ts` opens a mesh with `showColorbar: false` because a tag palette is a table, not
 * a ramp — but a field *is* a ramp, and §8's "one bar per visible scalar layer" is what a volume
 * gets for free. The app offers no per-layer bar switch (the toolbar's `Bars` is global), so this
 * is the only place the bit could ever be set for a mesh a `.msh.opt` did not seed.
 */
export function setColorMode(
  _layer: MeshLayer,
  colorMode: MeshLayer['colorMode']
): Partial<MeshLayer> {
  return colorMode === 'field' ? { colorMode, showColorbar: true } : { colorMode };
}

/**
 * Selecting a field: `colorMode` follows, and the `Scale`/`Threshold` are re-seeded from **that field's**
 * `Stats` — a viridis ramp still pinned to the previous field's range is the same bug as an unset
 * window, and the user cannot see it in the colour bar until they know the other field's numbers.
 * §7.6's `.msh.opt` seeding is `fromMeta`'s and is not undone here: this runs only on a user edit.
 */
export function selectField(
  dataset: MeshDataset,
  layer: MeshLayer,
  key: string
): Partial<MeshLayer> {
  const field = findField(dataset, key);
  if (field === null) return {};
  const component: 'mag' | 0 | 1 | 2 =
    field.ncomp === 1 ? 'mag' : (layer.field?.component ?? 'mag');
  return {
    colorMode: 'field',
    showColorbar: true,
    field: { source: field.source, name: field.name, component },
    scale: { kind: 'linear', lo: field.stats.min, hi: field.stats.max },
    threshold: { ...layer.threshold, lo: field.stats.min, hi: field.stats.max },
  };
}

export function setFieldComponent(
  layer: MeshLayer,
  component: 'mag' | 0 | 1 | 2
): Partial<MeshLayer> {
  if (layer.field === undefined) return {};
  return { field: { ...layer.field, component } };
}

export function setColormap(_layer: MeshLayer, colormap: ColormapName): Partial<MeshLayer> {
  return { colormap };
}

export function setScaleBounds(layer: MeshLayer, lo: number, hi: number): Partial<MeshLayer> {
  const s = layer.scale;
  if (s.kind === 'linear') return { scale: { kind: 'linear', lo, hi } };
  return { scale: { ...s, min: lo, max: hi, mid: Math.min(Math.max(s.mid, lo), hi) } };
}

/** `linear` ⇄ `heat` (§7.6: a different CPU bake, not a different shader). */
export function setScaleKind(layer: MeshLayer, kind: Scale['kind']): Partial<MeshLayer> {
  const s = layer.scale;
  if (s.kind === kind) return {};
  if (kind === 'linear') {
    return {
      scale: {
        kind: 'linear',
        lo: s.kind === 'heat' ? s.min : 0,
        hi: s.kind === 'heat' ? s.max : 1,
      },
    };
  }
  const lo = s.kind === 'linear' ? s.lo : 0;
  const hi = s.kind === 'linear' ? s.hi : 1;
  return {
    scale: {
      kind: 'heat',
      min: lo,
      mid: (lo + hi) / 2,
      max: hi,
      truncate: false,
      inverse: false,
      negative: 'mirror',
    },
  };
}

export function patchHeat(
  layer: MeshLayer,
  patch: Partial<Extract<Scale, { kind: 'heat' }>>
): Partial<MeshLayer> {
  if (layer.scale.kind !== 'heat') return {};
  return { scale: { ...layer.scale, ...patch } };
}

export function patchThreshold(layer: MeshLayer, patch: Partial<Threshold>): Partial<MeshLayer> {
  return { threshold: { ...layer.threshold, ...patch } };
}

export function setFlatShading(_layer: MeshLayer, flatShading: boolean): Partial<MeshLayer> {
  return { flatShading };
}

export function setFaceMode(
  _layer: MeshLayer,
  faceMode: MeshLayer['faceMode']
): Partial<MeshLayer> {
  return { faceMode };
}

export function setEdges(layer: MeshLayer, patch: Partial<MeshLayer['edges']>): Partial<MeshLayer> {
  return { edges: { ...layer.edges, ...patch } };
}

export function setEdgeWidth(_layer: MeshLayer, edgeWidthPx: number): Partial<MeshLayer> {
  return { edgeWidthPx: Math.max(0, edgeWidthPx) };
}

export function setEdgeColor(_layer: MeshLayer, edgeColor: vec4): Partial<MeshLayer> {
  return { edgeColor };
}

export function setSolidColor(_layer: MeshLayer, solidColor: vec4): Partial<MeshLayer> {
  return { solidColor };
}

// ------------------------------------------------------------------------------------------------
// R4 — the 2D cross-sections
// ------------------------------------------------------------------------------------------------

export function setFillIn2D(_layer: MeshLayer, fillIn2D: boolean): Partial<MeshLayer> {
  return { fillIn2D };
}

export function setContoursIn2D(_layer: MeshLayer, contoursIn2D: boolean): Partial<MeshLayer> {
  return { contoursIn2D };
}

export function setContourWidth(_layer: MeshLayer, contourWidthPx: number): Partial<MeshLayer> {
  return { contourWidthPx: Math.max(0.5, contourWidthPx) };
}

/**
 * The 2D contour's own colour (directed task 12).
 *
 * The alpha is carried over from whatever the layer already had — the swatch is an
 * `<input type="color">` and has no alpha to give — so setting a colour never silently makes a
 * hidden contour visible or a visible one transparent. A layer with no `contourColor` yet (every
 * tet mesh) starts from opaque, which is what its `edgeColor` fallback already was.
 */
export function setContourColor(layer: MeshLayer, hex: string): Partial<MeshLayer> {
  return { contourColor: hexToVec4(hex, layer.contourColor?.[3] ?? 1) };
}

/** What the contour swatch shows: the layer's own colour, else the edge colour it falls back to. */
export function contourColorHex(layer: MeshLayer): string {
  return vec4ToHex(layer.contourColor ?? layer.edgeColor);
}

/**
 * **What colours the cut** (R4). The frozen §4.4 `MeshLayer` has no separate cut field — §7.4 draws
 * `fillIn2D` polygons "with tag/field colour", i.e. through the layer's own `colorMode` and `field`,
 * which is exactly what R4 asks for ("coloured by tissue tag (or by the selected node/element field
 * through the layer's colormap/scale)"). So this control is the layer's colour source, surfaced a
 * second time where the cross-section toggles are, and `'tag'` here means `colorMode: 'tag'`.
 */
export function setCutColorSource(
  dataset: MeshDataset,
  layer: MeshLayer,
  source: 'tag' | 'solid' | string
): Partial<MeshLayer> {
  if (source === 'tag' || source === 'solid') return { colorMode: source };
  return selectField(dataset, layer, source);
}

/** What the cut-colour selector shows: `'tag'`, `'solid'`, or the active field's key. */
export function cutColorSource(layer: MeshLayer): string {
  if (layer.colorMode === 'field' && layer.field !== undefined) return fieldKey(layer.field);
  return layer.colorMode;
}

// ------------------------------------------------------------------------------------------------
// Clip planes (§7.4: up to 6)
// ------------------------------------------------------------------------------------------------

export const MAX_CLIP_PLANES = 6;

/** §3's preset normals, the same triple the canonical views use. */
export const CLIP_PRESETS: readonly { name: 'axial' | 'coronal' | 'sagittal'; normal: vec3 }[] = [
  { name: 'axial', normal: [0, 0, 1] },
  { name: 'coronal', normal: [0, -1, 0] },
  { name: 'sagittal', normal: [-1, 0, 0] },
];

/** The offset that puts the plane through `point`: §4.1's `dot(normal, x) + offset >= 0` keeps. */
export function offsetThrough(normal: vec3, point: vec3): number {
  return -dot3(normal, point);
}

function withPlanes(layer: MeshLayer, planes: ClipPlane[]): Partial<MeshLayer> {
  return { clip: { ...layer.clip, planes } };
}

export function addClipPlane(layer: MeshLayer, normal: vec3, offset: number): Partial<MeshLayer> {
  if (layer.clip.planes.length >= MAX_CLIP_PLANES) return {};
  const unit = normalize3(normal) ?? [0, 0, 1];
  return withPlanes(layer, [
    ...layer.clip.planes,
    { plane: { normal: unit, offset }, enabled: true },
  ]);
}

export function removeClipPlane(layer: MeshLayer, index: number): Partial<MeshLayer> {
  if (layer.clip.planes[index] === undefined) return {};
  return withPlanes(
    layer,
    layer.clip.planes.filter((_, i) => i !== index)
  );
}

function patchPlane(
  layer: MeshLayer,
  index: number,
  edit: (p: ClipPlane) => ClipPlane
): Partial<MeshLayer> {
  const current = layer.clip.planes[index];
  if (current === undefined) return {};
  return withPlanes(
    layer,
    layer.clip.planes.map((p, i) => (i === index ? edit(p) : p))
  );
}

export function setClipEnabled(
  layer: MeshLayer,
  index: number,
  enabled: boolean
): Partial<MeshLayer> {
  return patchPlane(layer, index, (p) => ({ ...p, enabled }));
}

/**
 * §4.4's `ClipPlane.followCursor` — the flag itself, as a patch like every other control.
 *
 * It is a layer field (added by the Phase-2 integrator, `docs/DECISIONS.md`) rather than UI state
 * precisely so it round-trips: a saved scene reopening with the plane where it was but no longer
 * following is a scene that did not persist. `false` is written as `undefined` so a plane that never
 * followed serialises exactly as Phase 1's did.
 */
export function setClipFollowsCursor(
  layer: MeshLayer,
  index: number,
  on: boolean
): Partial<MeshLayer> {
  return patchPlane(layer, index, (p) => {
    const next = { ...p };
    if (on) next.followCursor = true;
    else delete next.followCursor;
    return next;
  });
}

export function setClipNormal(layer: MeshLayer, index: number, normal: vec3): Partial<MeshLayer> {
  const unit = normalize3(normal);
  if (unit === null) return {};
  return patchPlane(layer, index, (p) => ({ ...p, plane: { ...p.plane, normal: unit } }));
}

export function setClipOffset(layer: MeshLayer, index: number, offset: number): Partial<MeshLayer> {
  return patchPlane(layer, index, (p) => ({ ...p, plane: { ...p.plane, offset } }));
}

/**
 * Flip which side is kept, **without moving the plane**: `dot(n, x) + d >= 0` becomes
 * `dot(−n, x) − d >= 0`, and the set `dot(n, x) + d == 0` is the same set. Negating only the normal
 * would translate the plane to `dot(n, x) = d`, which is the mirror plane through the origin — a
 * bug that looks like "flip works, but the cut jumps" and is invisible at `offset == 0`.
 */
export function flipClipPlane(layer: MeshLayer, index: number): Partial<MeshLayer> {
  return patchPlane(layer, index, (p) => ({
    ...p,
    plane: {
      normal: [-p.plane.normal[0], -p.plane.normal[1], -p.plane.normal[2]],
      offset: -p.plane.offset,
    },
  }));
}

export function setClipCaps(layer: MeshLayer, caps: boolean): Partial<MeshLayer> {
  return { clip: { ...layer.clip, caps } };
}

export function setCapColorMode(
  layer: MeshLayer,
  capColorMode: MeshLayer['clip']['capColorMode']
): Partial<MeshLayer> {
  return { clip: { ...layer.clip, capColorMode } };
}

/**
 * The patch that makes every `followCursor` plane pass through `cursor`, keeping its normal.
 *
 * Returns `{}` when nothing follows or nothing moved, so the controller can skip the call rather
 * than emit an `updateLayer` per cursor event.
 */
export function planesThroughCursor(layer: MeshLayer, cursor: vec3): Partial<MeshLayer> {
  let changed = false;
  const planes = layer.clip.planes.map((p) => {
    if (p.followCursor !== true) return p;
    const offset = offsetThrough(p.plane.normal, cursor);
    if (offset === p.plane.offset) return p;
    changed = true;
    return { ...p, plane: { ...p.plane, offset } };
  });
  return changed ? withPlanes(layer, planes) : {};
}

/** Whether any plane of this layer follows the cursor — the controller's cheap early-out. */
export function anyPlaneFollowsCursor(layer: MeshLayer): boolean {
  return layer.clip.planes.some((p) => p.followCursor === true);
}

// ------------------------------------------------------------------------------------------------
// Isolation (§7.4 / §4.4's `IsolateSpec`)
// ------------------------------------------------------------------------------------------------

export type IsolateClause = 'tags' | 'field' | 'sphere' | 'box' | 'labelVolume';

const EMPTY_ISOLATE: IsolateSpec = { combine: 'all' };

export function isolateOf(layer: MeshLayer): IsolateSpec {
  return layer.isolate ?? EMPTY_ISOLATE;
}

/** True when the spec constrains nothing — the engine should be given `undefined`, not an empty spec. */
export function isolateIsEmpty(spec: IsolateSpec): boolean {
  return (
    (spec.tags === undefined || spec.tags.length === 0) &&
    spec.field === undefined &&
    spec.sphere === undefined &&
    spec.box === undefined &&
    (spec.labelVolume === undefined || spec.labelVolume.labels.length === 0)
  );
}

function withIsolate(spec: IsolateSpec): Partial<MeshLayer> {
  return { isolate: isolateIsEmpty(spec) ? undefined : spec };
}

export function setIsolateCombine(
  layer: MeshLayer,
  combine: IsolateSpec['combine']
): Partial<MeshLayer> {
  if (layer.isolate === undefined) return {};
  return { isolate: { ...layer.isolate, combine } };
}

export function setIsolateTags(layer: MeshLayer, tags: readonly number[]): Partial<MeshLayer> {
  const spec = { ...isolateOf(layer) };
  if (tags.length === 0) delete spec.tags;
  else spec.tags = [...tags].sort((a, b) => a - b);
  return withIsolate(spec);
}

export function toggleIsolateTag(layer: MeshLayer, tag: number): Partial<MeshLayer> {
  const current = isolateOf(layer).tags ?? [];
  const next = current.includes(tag) ? current.filter((t) => t !== tag) : [...current, tag];
  return setIsolateTags(layer, next);
}

export function setIsolateField(
  dataset: MeshDataset,
  layer: MeshLayer,
  key: string,
  lo?: number,
  hi?: number
): Partial<MeshLayer> {
  const field = findField(dataset, key);
  if (field === null) return {};
  const spec = { ...isolateOf(layer) };
  spec.field = {
    source: field.source,
    name: field.name,
    component: field.ncomp === 1 ? 'mag' : (spec.field?.component ?? 'mag'),
    lo: lo ?? field.stats.min,
    hi: hi ?? field.stats.max,
  };
  return withIsolate(spec);
}

export function setIsolateFieldRange(layer: MeshLayer, lo: number, hi: number): Partial<MeshLayer> {
  const spec = { ...isolateOf(layer) };
  if (spec.field === undefined) return {};
  spec.field = { ...spec.field, lo, hi };
  return withIsolate(spec);
}

/** The sphere centre comes from the cursor (§8's "from the cursor"), never from a typed triple. */
export function setIsolateSphere(
  layer: MeshLayer,
  center: vec3,
  radius: number
): Partial<MeshLayer> {
  const spec = { ...isolateOf(layer) };
  spec.sphere = { center, radius: Math.max(0, radius) };
  return withIsolate(spec);
}

export function setIsolateBox(layer: MeshLayer, min: vec3, max: vec3): Partial<MeshLayer> {
  const spec = { ...isolateOf(layer) };
  spec.box = {
    min: [Math.min(min[0], max[0]), Math.min(min[1], max[1]), Math.min(min[2], max[2])],
    max: [Math.max(min[0], max[0]), Math.max(min[1], max[1]), Math.max(min[2], max[2])],
  };
  return withIsolate(spec);
}

export function setIsolateLabelVolume(
  layer: MeshLayer,
  datasetId: string,
  volumeIndex: number,
  labels: readonly number[]
): Partial<MeshLayer> {
  const spec = { ...isolateOf(layer) };
  if (labels.length === 0) delete spec.labelVolume;
  else spec.labelVolume = { datasetId, volumeIndex, labels: [...labels].sort((a, b) => a - b) };
  return withIsolate(spec);
}

export function toggleIsolateLabel(
  layer: MeshLayer,
  dataset: VolumeDataset,
  volumeIndex: number,
  label: number
): Partial<MeshLayer> {
  const current = isolateOf(layer).labelVolume;
  const same = current !== undefined && current.datasetId === dataset.id;
  const labels = same ? current.labels : [];
  const next = labels.includes(label) ? labels.filter((l) => l !== label) : [...labels, label];
  return setIsolateLabelVolume(layer, dataset.id, volumeIndex, next);
}

export function clearIsolateClause(layer: MeshLayer, clause: IsolateClause): Partial<MeshLayer> {
  if (layer.isolate === undefined) return {};
  const spec = { ...layer.isolate };
  delete spec[clause];
  return withIsolate(spec);
}

export function clearIsolate(_layer: MeshLayer): Partial<MeshLayer> {
  return { isolate: undefined };
}

// ------------------------------------------------------------------------------------------------
// Glyphs (§4.4's `GlyphSpec`)
// ------------------------------------------------------------------------------------------------

/** Vector fields only: a scalar has no direction, so it can never drive a glyph. */
export function vectorFields(dataset: MeshDataset): MeshFieldInfo[] {
  return dataset.fields.filter((f) => f.ncomp === 3);
}

/**
 * The defaults a new `GlyphSpec` opens with (revised 2026-08-28, directed task 7).
 *
 * **Linear, normalised to p99, 6 mm.** The previous default normalised to the field **maximum**,
 * and on `ernie_TDCS_1_scalar.msh` the maximum is 57.7899 V/m against a 99th percentile of about
 * 1.2 `[DATA]` — an electrode-gel outlier setting the scale for the whole brain, which drew every
 * cortical arrow at under 2 % of `lengthMm` and looked like a bug in the field. p99 puts the useful
 * range of the data across the useful range of lengths and leaves the outliers long, which is the
 * honest picture of an outlier.
 *
 * `logFloor` starts at the 5th percentile: `log` has to bottom out somewhere, and the bottom 5 % of
 * a head-mesh field is the far side of the skull.
 */
export function defaultGlyphs(dataset: MeshDataset): GlyphSpec | null {
  const field = vectorFields(dataset)[0];
  if (field === undefined) return null;
  const p5 = field.stats.percentiles['5'];
  const p99 = field.stats.percentiles['99'];
  return {
    field: { source: field.source, name: field.name },
    shape: 'arrow',
    subsample: { everyNth: 100 },
    scale: {
      mode: 'linear',
      lengthMm: DEFAULT_GLYPH_LENGTH_MM,
      normalizeTo: 'p99',
      logFloor: p5 > 0 ? p5 : Math.max(1e-12, p99 / 1000),
    },
    lengthMm: DEFAULT_GLYPH_LENGTH_MM,
    colorBy: 'magnitude',
    color: [1, 1, 1, 1],
    clipToCutPlane: false,
    onCutPlaneOnly: false,
    in2D: false,
    cutSlabMm: 1,
    headProportion: 0.3,
  };
}

/**
 * Patch the scaling, in object form, whatever form the spec was in.
 *
 * `lengthMm` is written in **both** places on purpose: the top-level field is what a scene saved
 * before 2026-08-28 carries and what the legacy `'fixed'` / `'byMagnitude'` strings read, so leaving
 * it stale would make a downgrade silently change the picture.
 */
export function setGlyphScaling(
  layer: MeshLayer,
  patch: Partial<GlyphScaling>
): Partial<MeshLayer> {
  if (layer.glyphs === undefined) return {};
  const scale: GlyphScaling = { ...glyphScaling(layer.glyphs), ...patch };
  return patchGlyphs(layer, { scale, lengthMm: scale.lengthMm });
}

/** `normalizeTo` as the selector's value; a number shows as `'value'` with its own field. */
export function glyphNormalizeKey(spec: GlyphSpec): 'p99' | 'max' | 'value' | 'none' {
  const n = glyphScaling(spec).normalizeTo;
  if (n === null) return 'none';
  return typeof n === 'number' ? 'value' : n;
}

export function enableGlyphs(dataset: MeshDataset, layer: MeshLayer): Partial<MeshLayer> {
  if (layer.glyphs !== undefined) return {};
  const spec = defaultGlyphs(dataset);
  return spec === null ? {} : { glyphs: spec };
}

export function disableGlyphs(_layer: MeshLayer): Partial<MeshLayer> {
  return { glyphs: undefined };
}

export function patchGlyphs(layer: MeshLayer, patch: Partial<GlyphSpec>): Partial<MeshLayer> {
  if (layer.glyphs === undefined) return {};
  return { glyphs: { ...layer.glyphs, ...patch } };
}

export function setGlyphField(
  dataset: MeshDataset,
  layer: MeshLayer,
  key: string
): Partial<MeshLayer> {
  const field = findField(dataset, key);
  if (field === null || field.ncomp !== 3 || layer.glyphs === undefined) return {};
  return patchGlyphs(layer, { field: { source: field.source, name: field.name } });
}

/**
 * The `GlyphSpec.origins` choices this mesh can actually serve (§7.4).
 *
 * `'surface'` always can — every mesh has a surface, stored or extracted. `'volume'` reads §6.5.2's
 * `meshCentroids`, which returns **one point per tet**, so a mesh with none (a `.gii` surface, an
 * `.annot`-coloured cortex) would silently draw nothing. §8 forbids a control that does nothing, so
 * the option is offered disabled with the reason attached rather than left to fail quietly.
 */
export function glyphOriginsAvailable(dataset: MeshDataset): boolean {
  return dataset.nTets > 0;
}

/** §4.4: an absent `origins` **is** `'surface'`, so the selector never shows an empty value. */
export function glyphOrigins(spec: GlyphSpec): 'surface' | 'volume' {
  return spec.origins ?? 'surface';
}

/**
 * Pick the origin table. `'volume'` on a tet-less mesh is refused rather than written: it would be a
 * layer state whose only rendering is nothing.
 */
export function setGlyphOrigins(
  dataset: MeshDataset,
  layer: MeshLayer,
  origins: 'surface' | 'volume'
): Partial<MeshLayer> {
  if (origins === 'volume' && !glyphOriginsAvailable(dataset)) return {};
  return patchGlyphs(layer, { origins });
}

/** The stride: `everyNth` is the §4.4 form the user thinks in ("one glyph per N elements"). */
export function setGlyphStride(layer: MeshLayer, everyNth: number): Partial<MeshLayer> {
  return patchGlyphs(layer, { subsample: { everyNth: Math.max(1, Math.round(everyNth)) } });
}

export function setGlyphMaxCount(layer: MeshLayer, maxCount: number): Partial<MeshLayer> {
  return patchGlyphs(layer, { subsample: { maxCount: Math.max(1, Math.round(maxCount)) } });
}

export function glyphStrideText(spec: GlyphSpec): string {
  return 'everyNth' in spec.subsample
    ? `every ${spec.subsample.everyNth}`
    : `max ${spec.subsample.maxCount}`;
}

// ------------------------------------------------------------------------------------------------
// §7.4's three async switches
// ------------------------------------------------------------------------------------------------

/**
 * §7.4: "the first toggle of `edges.surface`, the first switch to an element field, and the first
 * `colorMode:'label'` on a given mask are **async loads with a progress state**, not instant
 * checkboxes. They are free thereafter." These are the keys the panel shows a spinner for.
 */
export type AsyncSwitch = 'edges' | 'elmField' | 'label';

/** Which async switch (if any) a patch trips — the de-indexed variant it forces the worker to build. */
export function asyncSwitchFor(layer: MeshLayer, patch: Partial<MeshLayer>): AsyncSwitch | null {
  if (patch.edges?.surface === true && !layer.edges.surface) return 'edges';
  if (patch.colorMode === 'label' && layer.colorMode !== 'label') return 'label';
  if (patch.field?.source === 'elm' && layer.field?.source !== 'elm') return 'elmField';
  return null;
}
