/**
 * The two themes (directed task 9, 2026-08-28) — **the** source of truth for both halves of them.
 *
 * There are two halves, and the whole point of this file is that they cannot drift:
 *
 *  * **The DOM half.** `index.css` defines `--color-tvx-*` under `:root`, `[data-theme='light']`
 *    and `[data-theme='dark']`, and every panel, dialog, slider, table, chip and the status bar are
 *    written against those Tailwind tokens. The hex values there are the ones in {@link THEMES},
 *    and `tokens.test.ts` parses the stylesheet and fails if a single one has been edited in only
 *    one of the two places.
 *  * **The engine half.** §7.2's pass-3 chrome — orientation letters, corner info, the RAD/NEU
 *    badge, the crosshair, the colour bar and the gizmo — is drawn into the GL framebuffer, so CSS
 *    cannot reach it. It is themed through `Engine.setTheme` with {@link overlayPalette}.
 *
 * **No neon.** The cyan `#6ee7ff` that Phase 1 shipped as the accent is gone from the app entirely;
 * so is every saturated highlight it inspired (the histogram's cyan window handles, the amber
 * threshold rule, the active-row and load-card bars). One muted slate-blue accent family carries all
 * of it, `#3b5ba9` on white and `#93aae2` on graphite, and `tokens.test.ts` holds every pair to WCAG
 * 4.5:1 for text and 3:1 for a UI affordance.
 *
 * **The panes stay dark in both themes.** Imaging convention: a light viewport changes what a
 * greyscale T1 and a heat overlay *look like*, and a radiologist's window is dark whatever the
 * chrome around it does. `ThemeTokens.paneBackground` is the per-theme option — flip it and the
 * overlay palette flips with it, because {@link overlayPalette} keys off the pane, never off the
 * chrome.
 */

/** A colour as the CSS token holds it: `#rrggbb`, lower case, always six digits. */
export type Hex = string;

/**
 * What each token is for, which is what decides the contrast floor it is held to.
 *
 * WCAG 1.4.3 is about **text** (4.5:1) and 1.4.11 about the boundary of a **UI component or
 * graphical object** a user has to perceive to operate it (3:1). A hairline that only separates two
 * panels is neither: it carries no information, and a border you can see from across the room is
 * exactly the "neon" this task exists to remove. Those are declared `decorative` and named as such
 * in the test rather than quietly skipped.
 */
export type TokenRole = 'text' | 'ui' | 'surface' | 'decorative';

export interface ThemeTokens {
  /** Window background — also `BrowserWindow.backgroundColor`, so there is no flash on show. */
  bg: Hex;
  /** Panels, toolbar, status bar. */
  panel: Hex;
  /** Hairline separators and control borders. Decorative: see {@link TokenRole}. */
  line: Hex;
  /** A control's border once it is hovered or focused — a UI boundary, held to 3:1. */
  lineStrong: Hex;
  /** Body text. */
  text: Hex;
  /** Secondary text: units, hints, the key-map line. */
  dim: Hex;
  /** The one accent. Active rows, focus rings, toggles, sliders, load-card bars, chips. */
  accent: Hex;
  /** The accent under the pointer / pressed, and the histogram's window handles. */
  accentStrong: Hex;
  /** The accent as a *fill*: a selected row's background, a slider's track. */
  accentSurface: Hex;
  danger: Hex;
  warn: Hex;
  /**
   * Which way the **view panes** are shaded. `'dark'` in both shipped themes (imaging convention);
   * this is the per-theme option the task asks for, and {@link overlayPalette} follows it.
   */
  paneBackground: 'dark' | 'light';
}

export const TOKEN_ROLES: Record<Exclude<keyof ThemeTokens, 'paneBackground'>, TokenRole> = {
  bg: 'surface',
  panel: 'surface',
  line: 'decorative',
  lineStrong: 'ui',
  text: 'text',
  dim: 'text',
  accent: 'ui',
  accentStrong: 'text',
  accentSurface: 'surface',
  danger: 'text',
  warn: 'text',
};

/** The three surfaces every foreground token has to be legible on. */
export const SURFACE_TOKENS = ['bg', 'panel', 'accentSurface'] as const;

export type ThemeName = 'light' | 'dark';

/**
 * Light: white and light grey with soft shading — the depth comes from a one-step surface ramp
 * (`#ffffff` window, `#eef1f5` panels) and a hairline, not from heavy borders.
 */
const LIGHT: ThemeTokens = {
  bg: '#ffffff',
  panel: '#eef1f5',
  line: '#ccd2db',
  lineStrong: '#767f8d',
  text: '#15181d',
  dim: '#5a6473',
  accent: '#3b5ba9',
  accentStrong: '#2f4a8c',
  accentSurface: '#dce4f4',
  danger: '#b3261e',
  warn: '#8a5a00',
  paneBackground: 'dark',
};

/** Dark: graphite, deliberately not black — `#16181c` window, `#1e2126` panels. */
const DARK: ThemeTokens = {
  bg: '#16181c',
  panel: '#1e2126',
  line: '#333941',
  lineStrong: '#7d8794',
  text: '#dfe3ea',
  dim: '#99a1ae',
  accent: '#93aae2',
  accentStrong: '#aec0ee',
  accentSurface: '#262d3b',
  danger: '#f0a09a',
  warn: '#d9b76e',
  paneBackground: 'dark',
};

export const THEMES: Record<ThemeName, ThemeTokens> = { light: LIGHT, dark: DARK };

// ------------------------------------------------------------------------------------------------
// The engine half: §7.2 pass-3 chrome.
// ------------------------------------------------------------------------------------------------

/** `#rrggbb` → the engine's `vec4`, alpha given separately because chrome uses it. */
export function toVec4(hex: Hex, alpha = 1): [number, number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, alpha];
}

/**
 * The pane palette, keyed by **which way the viewport is shaded** rather than by the theme name.
 *
 * This is the distinction that makes "dark panes in a light theme" work rather than look broken. The
 * orientation letters and the corner readout have to contrast with the *anatomy behind them*, not
 * with the toolbar two hundred pixels away — so a light theme with dark panes keeps light chrome and
 * a black halo, exactly as before, and only an embedder that flips `paneBackground` gets the
 * inverse. The halo is the field that proves it: it inverts, it does not shift.
 */
const CHROME = {
  dark: {
    text: '#eaeef6',
    halo: '#000000',
    crosshair: '#c9a15e',
    accent: '#93aae2',
    accentStrong: '#b7c7ef',
    background: '#0f1116',
  },
  light: {
    text: '#1a1d23',
    halo: '#ffffff',
    crosshair: '#8a6420',
    accent: '#3b5ba9',
    accentStrong: '#2f4a8c',
    background: '#f2f4f7',
  },
} as const;

/**
 * The `Engine.setTheme` patch for a theme.
 *
 * `background` is included on purpose, and it is the field that carries the per-theme pane option:
 * `paneBackground: 'dark'` sends the graphite clear colour in **both** themes, which is what keeps a
 * light-theme window's viewport a viewport.
 */
export function overlayPalette(theme: ThemeName): {
  text: [number, number, number, number];
  halo: [number, number, number, number];
  crosshair: [number, number, number, number];
  activeBorder: [number, number, number, number];
  gizmo: [number, number, number, number];
  gizmoHot: [number, number, number, number];
  background: [number, number, number, number];
} {
  const c = CHROME[THEMES[theme].paneBackground];
  return {
    text: toVec4(c.text),
    halo: toVec4(c.halo),
    // 0.9 alpha, as the engine's own default crosshair has: the rules sit *over* the anatomy and a
    // fully opaque rule hides the voxel the user is pointing at.
    crosshair: toVec4(c.crosshair, 0.9),
    activeBorder: toVec4(c.accent),
    gizmo: toVec4(c.accent, 0.95),
    gizmoHot: toVec4(c.accentStrong),
    background: toVec4(c.background),
  };
}
