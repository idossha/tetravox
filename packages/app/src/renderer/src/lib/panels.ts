/**
 * §8 sidebar collapse: persistence and the narrow-window breakpoint.
 *
 * Which of the left (layer) and right (info) panels is collapsed is chrome, exactly like
 * `collapsedLayers` (`store/collapse.test.ts`) is — it never reaches the engine and never reaches a
 * `ViewSpec`. Unlike the per-row disclosure, though, a sidebar being open or shut is a preference
 * about *this machine's window*, not about the scene in it, so it is kept outside `settings.json`
 * (which is per-profile, shared by every scene) in `localStorage` instead — same reasoning `theme.ts`
 * would use if a scene-independent, machine-local, "remember across launches" preference did not
 * already have a home in `settings.json` for `theme`. Panels differ from `theme` in one way that
 * matters here: `docs/ARCHITECTURE.md` §8 keeps theme out of `localStorage` specifically because E2E
 * gets a fresh `--user-data-dir` per launch and needed to *test* the preference surviving a relaunch.
 * No panel spec asks for that, so the simpler store is the right one.
 */

/**
 * Below this window width, both sidebars auto-collapse to a rail and expand only as an overlay.
 *
 * Above the main window's own floor (`minWidth: 960` in `main/index.ts`) on purpose: a breakpoint
 * *below* that floor could never fire from a real drag-resize, since the OS won't let the window get
 * that narrow in the first place. `1000` leaves room to actually cross it before hitting the floor.
 */
export const NARROW_BREAKPOINT_PX = 1000;

const STORAGE_KEY = 'tetravox.panels.v1';

export interface PanelPrefs {
  leftPanelCollapsed: boolean;
  rightPanelCollapsed: boolean;
}

/**
 * A same-process fallback, used whenever `globalThis.localStorage` is absent or unusable — Node's
 * own built-in global (no `--localstorage-file`, which is how vitest's `node` environment runs it)
 * exists but every method throws `not a function`. The fallback keeps `loadPanelPrefs` /
 * `savePanelPrefs` round-tripping correctly within one process either way; only cross-launch
 * persistence is what a real renderer's `localStorage` adds.
 */
const memoryFallback = new Map<string, string>();

interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function storage(): KeyValueStore {
  try {
    const candidate = globalThis.localStorage;
    if (
      typeof candidate !== 'undefined' &&
      typeof candidate.getItem === 'function' &&
      typeof candidate.setItem === 'function'
    ) {
      return candidate;
    }
  } catch {
    // A sandboxed or private-mode context can throw just reading the accessor.
  }
  return {
    getItem: (key) => memoryFallback.get(key) ?? null,
    setItem: (key, value) => void memoryFallback.set(key, value),
  };
}

/** What a fresh window with no stored preference — or a broken/foreign `localStorage` — starts as. */
export const DEFAULT_PANEL_PREFS: PanelPrefs = {
  leftPanelCollapsed: false,
  rightPanelCollapsed: false,
};

export function loadPanelPrefs(): PanelPrefs {
  const store = storage();
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_PANEL_PREFS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_PANEL_PREFS;
    const p = parsed as Partial<PanelPrefs>;
    return {
      leftPanelCollapsed: p.leftPanelCollapsed === true,
      rightPanelCollapsed: p.rightPanelCollapsed === true,
    };
  } catch {
    return DEFAULT_PANEL_PREFS;
  }
}

export function savePanelPrefs(prefs: PanelPrefs): void {
  const store = storage();
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // A full or denied store loses the preference for next launch, not this one — `store.setState`
    // already ran, so the toggle the user just clicked still works.
  }
}
