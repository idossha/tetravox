/**
 * What the layer panel shows for a layer a module owns (§13.3).
 *
 * A **read-only summary instead of the core property editor**, and each half of that is a concrete
 * defect it prevents rather than a matter of taste. Against a contacts layer, the core points editor
 * would offer: a per-point ↺ that deletes the electrode's colour; a 0.5–20 mm radius slider that is
 * also the layer's probe radius and its 2D slab; and — worst — a path where every edit reaches
 * `controller.patchLayer` directly, bypassing the module's own history and its dirty flag, so an
 * `Undo` in the module's panel would not undo it and a Save would not know it happened.
 *
 * So the module's own panel stays the only way to change a module's layer, and this says which
 * module owns it and where its controls are. Visibility, opacity and the stacking order stay on the
 * row itself — those are the layer panel's, they cost the module nothing, and hiding a layer you can
 * see in the list is the one thing a reader always expects to work.
 */

import type { Layer } from '@tetravox/engine';
import { manifestFor } from '../../../modules/manifests';
import { useController, useUi } from '../ui/context';
import { moduleOfLayer } from './ownership';

export function ModuleLayerSummary({ layer }: { layer: Layer }): React.JSX.Element | null {
  const controller = useController();
  const activeModule = useUi((s) => s.activeModule);
  const owner = moduleOfLayer(layer);
  if (owner === null) return null;
  const manifest = manifestFor(owner);
  const title = manifest?.title ?? owner;
  const active = activeModule === owner;
  const known = controller.modules().some((m) => m.manifest.id === owner);

  return (
    <div
      data-testid={`module-layer-summary-${layer.id}`}
      data-module={owner}
      className="px-2 py-1.5 text-[11px] text-tvx-dim"
    >
      <p>
        Owned by <span className="text-tvx-text">{title}</span>. Its contents are edited from that
        module&rsquo;s panel, so the per-point controls are not offered here.
      </p>
      {!known ? (
        // A scene made with a module this build does not have. The layer still draws — it is a
        // core-typed layer (§13.2) — and saying so is better than an editor that would silently
        // orphan it from the module that will read it back.
        <p className="mt-1">
          This build does not carry that module. The layer still draws, and its record is carried
          through when the scene is saved.
        </p>
      ) : (
        !active && (
          <button
            type="button"
            data-testid={`module-layer-open-${layer.id}`}
            className="tvx-btn tvx-btn-sm mt-1"
            onClick={() => void controller.activateModule(owner)}
          >
            Open {title}
          </button>
        )
      )}
    </div>
  );
}
