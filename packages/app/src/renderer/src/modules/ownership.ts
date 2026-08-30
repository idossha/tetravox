/**
 * Which module owns a layer (§13.3).
 *
 * One question, one place, because three callers ask it and each would get it subtly wrong on its
 * own: the layer panel (badge, and a read-only summary instead of the core editor), the discard
 * guard (closing this dataset closes a module's layers with it), and a module finding its own layer
 * after `Engine.load` reassigned every id.
 *
 * The field is `LayerBase.module` — a declared optional on the frozen `scene/types.ts` (§4.4), which
 * the engine carries and never interprets. It survives a save because every layer field does: the
 * `{ ...layer }` spreads through `serialize` → `load` → `addLayer` are §4.6's stated guarantee, not
 * an accident this relies on.
 */

import type { Layer } from '@tetravox/engine';

/** The owning module's id, or null for a core-owned layer. */
export function moduleOfLayer(layer: Layer): string | null {
  // Still guarded rather than returned straight: `module` arrives from a scene file as often as from
  // `addModuleLayer`, and `''` in a hand-edited file must read as "core-owned", not as a module id.
  const owner = layer.module;
  return typeof owner === 'string' && owner !== '' ? owner : null;
}

/** Every layer this module owns, bottom → top. */
export function layersOfModule(layers: readonly Layer[], moduleId: string): Layer[] {
  return layers.filter((layer) => moduleOfLayer(layer) === moduleId);
}
