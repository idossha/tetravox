/**
 * Resolving and applying a theme (directed task 9, 2026-08-28).
 *
 * Three pure functions and one DOM write, kept out of both React and the controller so the choice →
 * resolution → attribute chain is unit-testable with no window at all. `ShellController.setTheme`
 * calls {@link applyTheme} and then `Engine.setTheme`; nothing else writes `data-theme`.
 */

import { THEMES, overlayPalette } from './tokens';
import type { ThemeName } from './tokens';

/** What the user picked in the toolbar. `'system'` is the default and follows the OS. */
export type ThemeChoice = 'system' | 'light' | 'dark';

export const THEME_CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark'];

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === 'system' || value === 'light' || value === 'dark';
}

/**
 * The theme a choice actually means right now.
 *
 * `'system'` reads `prefers-color-scheme`, and falls back to `'dark'` where there is no
 * `matchMedia` — a headless render, a unit test, an Electron build with the media query
 * unimplemented. Dark rather than light because that is what the window's own
 * `BrowserWindow.backgroundColor` is: guessing light here would put a white flash in front of every
 * launch that could not answer.
 */
export function resolveTheme(
  choice: ThemeChoice,
  prefersDark: boolean | null = systemPrefersDark()
): ThemeName {
  if (choice !== 'system') return choice;
  return prefersDark === false ? 'light' : 'dark';
}

/** `prefers-color-scheme: dark`, or null where the query cannot be asked. */
export function systemPrefersDark(): boolean | null {
  if (typeof globalThis.matchMedia !== 'function') return null;
  try {
    return globalThis.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return null;
  }
}

/**
 * Stamp the resolved theme onto `<html>`, which is what every `--color-tvx-*` override in
 * `index.css` keys off.
 *
 * `color-scheme` goes on with it, so the form controls the shell does not style itself — the native
 * scrollbars, a `<select>` popup, the focus ring Chromium draws on a checkbox — come out of the
 * platform in the same theme instead of staying dark under a white panel.
 */
export function applyTheme(name: ThemeName, root: HTMLElement | null = documentRoot()): void {
  if (root === null) return;
  root.setAttribute('data-theme', name);
  root.style.colorScheme = name;
}

function documentRoot(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.documentElement;
}

/**
 * The `Engine.setTheme` patch for a resolved theme — re-exported here so a caller needs one import,
 * and so `tokens.ts` stays the only file that knows a colour.
 */
export function enginePatch(name: ThemeName): ReturnType<typeof overlayPalette> {
  return overlayPalette(name);
}

/** Whether this theme's viewport is light or dark — §8's status readout and the E2E both ask. */
export function paneBackground(name: ThemeName): 'dark' | 'light' {
  return THEMES[name].paneBackground;
}
