/**
 * The renderer's root: which UI this window is.
 *
 * `?ui=phase0` renders the Phase-0 walking skeleton, which ROADMAP gate items 2, 3 and 8 are proved
 * by and which the macOS CI leg still runs against the **packaged** artefact. Everything else renders
 * the §8 shell, which is the app from Phase 1 onward.
 *
 * The query arrives from main as `--tvx-search=…` (or `TETRAVOX_SEARCH`), because the window is
 * loaded with `loadURL('tetravox://app/index.html')` and there is no other place to put a launch
 * option that the renderer can read synchronously on its first render.
 */

import { Phase0App } from './Phase0App';
import { Shell } from './ui/Shell';

export type UiMode = 'shell' | 'phase0';

export function uiMode(search = globalThis.location?.search ?? ''): UiMode {
  return new URLSearchParams(search).get('ui') === 'phase0' ? 'phase0' : 'shell';
}

export function App(): React.JSX.Element {
  return uiMode() === 'phase0' ? <Phase0App /> : <Shell />;
}
