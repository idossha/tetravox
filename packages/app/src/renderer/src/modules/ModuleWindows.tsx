/**
 * The popped-out modules, one window each (ARCHITECTURE.md §13.10).
 *
 * A thin list, deliberately: everything that is hard lives in `ModuleWindow.tsx`, and everything
 * that decides *which* modules are out lives in the controller. This subscribes to
 * `UiState.modulePlacement` — the field the controller writes in the same `setState` as
 * `activeModule` — so a pop-out, a re-dock and a close each re-render exactly this component.
 *
 * `key` is the module id and nothing else. Keying on anything that changes across a re-dock would
 * unmount `ModuleWindow`, which closes the OS window and re-opens a new one: the same module,
 * blinking, in a window the user had already sized and placed.
 */

import { ModuleWindow } from './ModuleWindow';
import { useController, useUi } from '../ui/context';

export function ModuleWindows(): React.JSX.Element | null {
  const controller = useController();
  const placements = useUi((s) => s.modulePlacement);
  const out = Object.entries(placements).filter(([, placement]) => placement === 'window');
  if (out.length === 0) return null;
  return (
    <>
      {out.map(([id]) => {
        const manifest = controller
          .moduleSessionsInfo()
          .find((session) => session.manifest.id === id)?.manifest;
        const Panel = controller.modulePanelFor(id);
        if (manifest === undefined || Panel === null) return null;
        return <ModuleWindow key={id} manifest={manifest} Panel={Panel} />;
      })}
    </>
  );
}
