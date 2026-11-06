/**
 * The panel-tabs fixture (§13.3): the content for whichever tab core's row has chosen, and its own nav in
 * a window where core has no row.
 */

import { useState, useSyncExternalStore } from 'react';
import type { ModuleHost, ModuleInstance } from '../host';

function Panel({ host }: { host: ModuleHost }): React.JSX.Element {
  const tab = useSyncExternalStore((cb) => host.ui.onPanelTab(cb), host.ui.panelTab);
  const placement = useSyncExternalStore((cb) => host.ui.onPlacement(cb), host.ui.placement);
  // React state on purpose: it is what is lost if a tab switch ever unmounts the panel.
  const [kept, setKept] = useState(0);
  return (
    <div data-testid="tabs-panel" data-tab={tab} className="flex flex-col gap-1.5 text-[11px]">
      {placement === 'window' && (
        <nav data-testid="tabs-own-nav" className="flex gap-1">
          {['filter', 'network', 'export'].map((id) => (
            <button
              key={id}
              type="button"
              data-testid={`tabs-own-${id}`}
              className={id === tab ? 'tvx-btn tvx-btn-sm tvx-btn-on' : 'tvx-btn tvx-btn-sm'}
              onClick={() => host.ui.setPanelTab(id)}
            >
              {id}
            </button>
          ))}
        </nav>
      )}
      <p data-testid={`tabs-content-${String(tab)}`}>Content for {tab}.</p>
      <button
        type="button"
        data-testid="tabs-kept"
        className="tvx-btn tvx-btn-sm self-start"
        onClick={() => setKept((n) => n + 1)}
      >
        {kept}
      </button>
    </div>
  );
}

export function activate(host: ModuleHost): ModuleInstance {
  return {
    Panel: () => <Panel host={host} />,
    runCommand: () => undefined,
    dirty: () => false,
    dispose: () => undefined,
  };
}
