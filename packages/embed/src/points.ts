/**
 * The two things a host says about points that §4.4 has no word for, resolved into fields it does
 * (`docs/EMBED.md` §4.1, protocol 2).
 *
 * Everything else about a points layer is already the engine's: inline coordinates, per-point ids,
 * groups, colours and radii are `PointsLayer` verbatim, and `Engine.load` restores one from a
 * `ViewSpec` the way it restores a volume or a mesh (`isRestorableKind`). So this file is small on
 * purpose — it is a *translation*, not a second points model:
 *
 *  1. **`state` → `color`.** A host says "this electrode is selected"; the engine paints
 *     `points[].color`. Resolving here rather than in the host is what keeps one montage's selected
 *     colour the same as the next one's, and what makes `load` and `setPoints` agree — the same
 *     function runs for both. An explicit `color` always wins: the state is a shorthand for a
 *     colour, so a host that named one has already said what it wanted.
 *
 *  2. **`labelMode` → `showLabels` + `labelSource`.** §4.4 spells "draw each point's own name" as
 *     two fields whose legal combinations are three, and the third (`showLabels: true` with
 *     `labelSource: 'labels'` on a layer that has no `labels[]`) draws nothing. One enum with three
 *     values says the same thing and cannot be written wrong.
 *
 * Pure and engine-free, so `points.test.ts` drives every branch with no browser and no GL — the
 * same reason `protocol.ts`'s `acceptMessage` is a pure function.
 */

import type { vec4 } from '@tetravox/engine';
import type { EmbedPoint, EmbedPointsLayer } from './protocol';

/**
 * What each state paints when the layer names no `stateColors`.
 *
 * `idle` is deliberately **absent** rather than a colour: a point whose state is `idle` and whose
 * layer named no `stateColors.idle` is the layer's own `color`, whatever the host set it to, and
 * baking a grey here would override a host that coloured its whole net blue. (A host that *does*
 * name `stateColors.idle` gets it — that was broken until 2026-09-05, see {@link resolvePoint}.) `selected` is an amber that reads against both themes; `disabled` is a mid grey that is
 * legible without claiming attention.
 *
 * Both are **byte-exact**: every channel is a whole multiple of `1/255`, so `round(c · 255)` is the
 * wire value with no rounding argument to have — `[1, 0.8, 0.2, 1]` is `rgb(255, 204, 51)` and
 * `[0.6, 0.6, 0.6, 1]` is `rgb(153, 153, 153)`, exactly. §4.1 requires a 0..255 colour to round-trip
 * through the engine's 0..1 representation, and §11's analytic pixel assertion for these is that
 * arithmetic and nothing else; a value like `0.85` would have made the expected pixel a question
 * about the rasteriser's rounding rather than about the colour.
 */
export const DEFAULT_STATE_COLORS: { selected: vec4; disabled: vec4 } = {
  selected: [1, 0.8, 0.2, 1],
  disabled: [0.6, 0.6, 0.6, 1],
};

/** The three `labelMode` values, as the §4.4 pair each one stands for. */
export function labelFieldsFor(mode: EmbedPointsLayer['labelMode']): {
  showLabels: boolean;
  labelSource?: 'labels' | 'names';
} {
  if (mode === 'names') return { showLabels: true, labelSource: 'names' };
  if (mode === 'labels') return { showLabels: true, labelSource: 'labels' };
  return { showLabels: false };
}

/**
 * One point, with `state` spent.
 *
 * `state` is **kept** on the way out as well as resolved. It is not a field the engine reads — §4.4
 * carries unknown per-point keys the way it carries `group` — and leaving it there is what lets
 * `serialize` hand a host back the layer it sent, and a host read a point's state off a `layers`
 * event rather than remembering which ids it dimmed.
 */
export function resolvePoint(
  point: EmbedPoint,
  stateColors: EmbedPointsLayer['stateColors']
): EmbedPoint {
  const state = point.state;
  if (state === undefined) return point;
  // An explicit colour is the host being specific, and specific beats shorthand.
  if (point.color !== undefined) return point;
  if (state === 'idle') {
    // `stateColors.idle` was unreachable until 2026-09-05: this branch returned before consulting
    // it, so a host that named an idle colour got the layer's `color` and no complaint — a field
    // that silently did nothing. Reported by the TI-Toolbox electrode pane, which had to write an
    // explicit `color` on every idle point to work around it.
    //
    // Falling through to the layer's own `color` when the host named no `idle` is the OLD
    // behaviour exactly, which is what keeps this additive: `DEFAULT_STATE_COLORS` still has no
    // `idle` entry, deliberately — baking a grey here would override a host that coloured its whole
    // net blue and never said `stateColors`.
    const idle = stateColors?.idle;
    return idle === undefined ? point : { ...point, color: idle };
  }
  const color = stateColors?.[state] ?? DEFAULT_STATE_COLORS[state];
  return { ...point, color };
}

/**
 * A host's points layer → the §4.4 one `Engine.load` and `Engine.updateLayer` take.
 *
 * **`labelMode` is spent; `stateColors` is kept.** The difference is whether the field has a §4.4
 * twin. `labelMode` *is* `showLabels` + `labelSource`, so leaving it on the layer would put two
 * spellings of the label rule on one object and let them disagree. `stateColors` has no twin — it
 * resolves *into* per-point `color`, a different field — and the layer that carries it is the only
 * place a later `setPoints` can read the host's palette back from. So it stays, alongside each
 * point's own `state`, and `serialize()` hands the host back the layer it wrote.
 */
export function resolvePointsLayer(layer: EmbedPointsLayer): Record<string, unknown> {
  const { labelMode, points, ...rest } = layer;
  const out: Record<string, unknown> = { ...rest };
  out['points'] = (points ?? []).map((p) => resolvePoint(p, layer.stateColors));
  if (labelMode !== undefined) Object.assign(out, labelFieldsFor(labelMode));
  return out;
}

/**
 * The palette a live layer carries, for a `setPoints` that must paint the same states the `load`
 * did. `undefined` for a layer that never named one, which is {@link DEFAULT_STATE_COLORS}.
 */
export function stateColorsOf(layer: unknown): EmbedPointsLayer['stateColors'] {
  if (typeof layer !== 'object' || layer === null) return undefined;
  const colors = (layer as Record<string, unknown>)['stateColors'];
  return typeof colors === 'object' && colors !== null
    ? (colors as EmbedPointsLayer['stateColors'])
    : undefined;
}

/** Is this spec layer a points layer? Written once, because `load` and `setPoints` both ask. */
export function isPointsLayer(
  layer: Record<string, unknown>
): layer is EmbedPointsLayer & Record<string, unknown> {
  return layer['kind'] === 'points';
}
