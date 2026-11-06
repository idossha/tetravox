/**
 * `tetravox.tabs` — the fixture for §13.3's panel tabs.
 *
 * `hello` declares no tabs and must keep behaving as a module with none, so this is the consumer of
 * `ui.panelTabs`. Compiled in and listed only behind `?modules=tabs`,
 * like `hello`, and for the same reason.
 *
 * Data only: this file imports its types and nothing else.
 */

import type { ModuleManifest } from '../manifest-types';

export const tabsManifest: ModuleManifest = {
  id: 'tetravox.tabs',
  title: 'Tabs',
  version: '1.0.0',
  hostApi: 1,
  docs: 'Extensions',
  activation: ['onToggle'],
  commands: [],
  ui: {
    panelTabs: [
      { id: 'filter', label: 'Filter' },
      { id: 'network', label: 'Network' },
      { id: 'export', label: 'Export' },
    ],
  },
};
