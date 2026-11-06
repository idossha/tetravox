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

/**
 * Drag-resize bounds for an expanded sidebar, in CSS px. The floors are the widths below which the
 * layer rows and the info panel's two-column blocks start truncating every label; the ceiling keeps
 * a 1000 px window's view grid from being squeezed to nothing by one generous drag.
 */
export const PANEL_WIDTH_LIMITS = {
  left: { min: 224, max: 640, default: 288 },
  right: { min: 256, max: 640, default: 320 },
} as const;

/** The right panel's width while a module is docked, until the user drags it (§13.3). */
export const MODULE_PANEL_WIDTH_PX = 400;

/** However wide a saved right panel is, the views keep at least this much. */
export const MIN_VIEWS_PX = 320;

export function clampPanelWidth(side: 'left' | 'right', px: number): number {
  const { min, max, default: fallback } = PANEL_WIDTH_LIMITS[side];
  if (!Number.isFinite(px)) return fallback;
  return Math.round(Math.min(max, Math.max(min, px)));
}

export interface PanelPrefs {
  leftPanelCollapsed: boolean;
  rightPanelCollapsed: boolean;
  /**
   * The info panel's live `Mouse` block, which starts **collapsed**: it rewrites itself on every
   * pointer move, and a reader who wants the cursor's numbers is better served by a block that does
   * not churn under them. One click on its header opens it, and that choice is remembered here.
   */
  mouseBlockCollapsed: boolean;
  /** Show only the active layer's editor in the layer panel. Off unless asked for. */
  oneLayerOpen: boolean;
  /** Inspect's raw header, closed until asked for: most sessions never read it. */
  headerBlockCollapsed: boolean;
  /** Expanded widths in CSS px, set by dragging the sidebar's inner edge. */
  leftPanelWidth: number;
  rightPanelWidth: number;
  /** The right panel with a module docked. Dragging it leaves {@link rightPanelWidth} alone. */
  rightModuleWidth: number;
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
  mouseBlockCollapsed: true,
  oneLayerOpen: false,
  headerBlockCollapsed: true,
  leftPanelWidth: PANEL_WIDTH_LIMITS.left.default,
  rightPanelWidth: PANEL_WIDTH_LIMITS.right.default,
  rightModuleWidth: MODULE_PANEL_WIDTH_PX,
};

export function loadPanelPrefs(): PanelPrefs {
  const store = storage();
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_PANEL_PREFS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_PANEL_PREFS;
    const p = parsed as Partial<PanelPrefs>;
    const rightPanelWidth = clampPanelWidth(
      'right',
      p.rightPanelWidth ?? PANEL_WIDTH_LIMITS.right.default
    );
    return {
      leftPanelCollapsed: p.leftPanelCollapsed === true,
      rightPanelCollapsed: p.rightPanelCollapsed === true,
      // Absent (a pref written before the block was collapsible) means the default, not `false`.
      mouseBlockCollapsed: p.mouseBlockCollapsed !== false,
      oneLayerOpen: p.oneLayerOpen === true,
      headerBlockCollapsed: p.headerBlockCollapsed !== false,
      leftPanelWidth: clampPanelWidth('left', p.leftPanelWidth ?? PANEL_WIDTH_LIMITS.left.default),
      rightPanelWidth,
      // Absent: someone who widened the panel past 400 px before this existed keeps that width.
      rightModuleWidth: clampPanelWidth(
        'right',
        p.rightModuleWidth ?? Math.max(MODULE_PANEL_WIDTH_PX, rightPanelWidth)
      ),
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
