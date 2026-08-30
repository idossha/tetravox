/**
 * Which module owns a layer (§13.3).
 *
 * One question, one place, because three callers ask it and each would get it subtly wrong on its
 * own: the layer panel (badge, and a read-only summary instead of the core editor), the discard
 * guard (closing this dataset closes a module's layers with it), and a module finding its own layer
 * after `Engine.load` reassigned every id.
 *
 * INTEGRATION(P1): the field is `LayerBase.module`, which P1 adds to the frozen `scene/types.ts`. It
 * is read through a structural cast here so this branch works before that lands — and the cast is
 * not a workaround for the *persistence*: a layer's unknown keys have always ridden the untyped
 * spreads through `serialize` → `load` → `addLayer` (§4.6), which is exactly what carries the stamp
 * across a save today. When P1 lands, this narrows to `layer.module` and nothing else changes.
 */

import type { Layer } from '@tetravox/engine';

/** The owning module's id, or null for a core-owned layer. */
export function moduleOfLayer(layer: Layer): string | null {
  const owner = (layer as { module?: unknown }).module;
  return typeof owner === 'string' && owner !== '' ? owner : null;
}

/** Every layer this module owns, bottom → top. */
export function layersOfModule(layers: readonly Layer[], moduleId: string): Layer[] {
  return layers.filter((layer) => moduleOfLayer(layer) === moduleId);
}
