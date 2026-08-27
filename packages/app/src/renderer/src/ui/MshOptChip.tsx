/**
 * §7.6's **"defaults from X.msh.opt" chip and one-click Reset**.
 *
 * §7.6, last bullet: "`<mesh>.msh.opt` seeds tag colours/visibility, field range, colormap and
 * colorbar on open, with a 'defaults from X.msh.opt' chip and a one-click Reset."
 * `docs/PHASE2-OWNERSHIP.md` splits that in two — E-SCENE seeds from `MeshMeta.opt` in
 * `scene/fromMeta.ts`, **A-SHELL owns the chip and Reset** — and this is A-SHELL's half.
 *
 * **Why it lives in `ui/` and not in the mesh property editor.** `panels/layers/mesh/` is A-PROPS's
 * directory (ownership map: `panels/` is split by subdirectory), so the chip is a self-contained
 * component here, mounted by `ui/Shell.tsx` in the right-hand column where it is visible whichever
 * panel is open. It is deliberately importable: when A-PROPS's mesh editor lands, it can render
 * `<MshOptChip layerId=… />` inside the tissue table instead of building a second one, and there is
 * still exactly one implementation with one owner.
 *
 * The chip renders **nothing at all** when the active layer is not a mesh, or when that mesh had no
 * `.msh.opt` beside it — an inert "Reset" for a file with no defaults to reset to would be a lie.
 */

import { useCallback, useState } from 'react';
import type { LayerId } from '@tetravox/engine';
import { activeLayer, activeMeshDataset } from '../store/store';
import { useController, useUi } from './context';

export interface MshOptChipProps {
  /** Which layer to reset. Defaults to the active one, which is what the shell mounts it as. */
  layerId?: LayerId;
}

export function MshOptChip({ layerId }: MshOptChipProps): React.JSX.Element | null {
  const controller = useController();
  const dataset = useUi(activeMeshDataset);
  const active = useUi(activeLayer);
  const [resetAt, setResetAt] = useState<number | null>(null);

  const target = layerId ?? active?.id ?? null;

  const onReset = useCallback(() => {
    if (target === null) return;
    if (controller.resetMeshOptDefaults(target)) setResetAt(Date.now());
  }, [controller, target]);

  // No mesh, or a mesh with no sidecar: nothing to claim defaults from, so nothing is shown.
  if (dataset === null || dataset.opt === undefined || target === null) return null;

  const sidecarName = `${dataset.name}.opt`;
  const tagCount = Object.keys(dataset.opt.tagColor).length;
  const view = dataset.opt.views[0];

  return (
    <div
      data-testid="mshopt-chip"
      data-dataset={dataset.id}
      className="flex items-center gap-2 border-b border-tvx-line bg-tvx-panel/40 px-3 py-1"
    >
      <span
        data-testid="mshopt-chip-label"
        className="truncate rounded border border-tvx-accent/40 px-1.5 py-0.5 text-[10px] text-tvx-accent"
        title={
          `${tagCount} tag colours` +
          (view?.customMin !== undefined && view.customMax !== undefined
            ? `, range ${view.customMin} … ${view.customMax}`
            : '') +
          (view?.showScale === undefined ? '' : `, colour bar ${view.showScale ? 'on' : 'off'}`)
        }
      >
        defaults from {sidecarName}
      </span>
      <button
        type="button"
        data-testid="mshopt-reset"
        className="tvx-btn tvx-btn-sm ml-auto"
        onClick={onReset}
      >
        Reset
      </button>
      {resetAt !== null && (
        <span data-testid="mshopt-reset-done" className="text-[10px] text-tvx-dim">
          reset
        </span>
      )}
    </div>
  );
}
