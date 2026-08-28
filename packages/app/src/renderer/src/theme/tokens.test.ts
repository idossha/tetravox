/**
 * The two themes, held to WCAG and to their own stylesheet (directed task 9, 2026-08-28).
 *
 * Three properties, and each one is a way the theme could rot silently:
 *
 *  1. **Contrast.** Every foreground token, on every surface it can appear on, in both themes:
 *     4.5:1 for text (WCAG 1.4.3), 3:1 for a UI boundary (1.4.11). The engine's pass-3 chrome is
 *     included — it is drawn in GL, so no DOM audit would ever see it.
 *  2. **No neon.** The Phase-1 cyan is gone, and nothing that replaced it is saturated. Measured,
 *     not asserted by eye — see `glare` below for what is being measured and why saturation alone
 *     is the wrong number.
 *  3. **The stylesheet agrees.** `index.css` carries the same hexes. It has to — Tailwind needs
 *     them as literals — so the test parses it rather than trusting a comment.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SURFACE_TOKENS, THEMES, TOKEN_ROLES, overlayPalette, toVec4 } from './tokens';
import type { Hex, ThemeName, ThemeTokens } from './tokens';
import { resolveTheme } from './theme';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, '..', 'index.css'), 'utf8');

// ------------------------------------------------------------------------------------------------
// WCAG 2.x relative luminance and contrast, from the spec's own formulae.
// ------------------------------------------------------------------------------------------------

function channels(hex: Hex): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** WCAG 2.2, "relative luminance". */
function luminance(hex: Hex): number {
  const [r, g, b] = channels(hex).map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.2, "contrast ratio". 1:1 … 21:1. */
export function contrast(a: Hex, b: Hex): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * "Glare": RGB chroma × relative luminance — the number that separates a highlighter pen from a
 * muted accent.
 *
 * Saturation alone does not: `#8a5a00`, the light theme's warning ochre, is *fully* saturated in
 * HSL and is not remotely neon, because it is dark. What makes `#6ee7ff` (0.385) and the old amber
 * `#ffc857` (0.417) glow is being colourful **and** bright at once, and multiplying the two says so.
 * Every token this theme ships scores under 0.21.
 */
function glare(hex: Hex): number {
  const [r, g, b] = channels(hex);
  return (Math.max(r, g, b) - Math.min(r, g, b)) * luminance(hex);
}

const THEME_NAMES: ThemeName[] = ['light', 'dark'];

/** The floor a token's role puts it under; `null` = not covered (see `TokenRole`). */
function floorFor(token: keyof typeof TOKEN_ROLES): number | null {
  const role = TOKEN_ROLES[token];
  if (role === 'text') return 4.5;
  if (role === 'ui') return 3;
  return null;
}

describe('theme tokens: contrast', () => {
  for (const name of THEME_NAMES) {
    const tokens: ThemeTokens = THEMES[name];
    for (const token of Object.keys(TOKEN_ROLES) as (keyof typeof TOKEN_ROLES)[]) {
      const floor = floorFor(token);
      if (floor === null) continue;
      for (const surface of SURFACE_TOKENS) {
        it(`${name}: ${token} on ${surface} ≥ ${floor}:1`, () => {
          const ratio = contrast(tokens[token], tokens[surface]);
          expect(
            ratio,
            `${name}.${token} ${tokens[token]} on ${name}.${surface} ${tokens[surface]}`
          ).toBeGreaterThanOrEqual(floor);
        });
      }
    }
  }

  /**
   * The tokens the roles table deliberately does **not** cover, named here so "excluded" is a
   * decision in the test rather than an omission from it. A hairline separator carries no
   * information and operates nothing; WCAG 1.4.11 does not reach it, and a border you can see from
   * across the room is the neon this theme exists to remove. It still has to be *visible*, so it
   * gets a floor of its own — well under 3, and above "invisible".
   */
  for (const name of THEME_NAMES) {
    it(`${name}: the decorative hairline is visible but not loud`, () => {
      const t = THEMES[name];
      expect(TOKEN_ROLES.line).toBe('decorative');
      for (const surface of ['bg', 'panel'] as const) {
        const ratio = contrast(t.line, t[surface]);
        expect(ratio, `${name}.line on ${surface}`).toBeGreaterThan(1.15);
        expect(ratio, `${name}.line on ${surface}`).toBeLessThan(3);
      }
    });
  }
});

describe('theme tokens: the engine chrome', () => {
  /**
   * §7.2's pass-3 chrome is drawn into the GL framebuffer, so it is invisible to any DOM contrast
   * audit — and it is the half a theme switch is most likely to forget. Every chrome colour is
   * checked against the pane it is drawn on, at the same floors.
   */
  for (const name of THEME_NAMES) {
    const palette = overlayPalette(name);
    const hex = (v: readonly number[]): Hex =>
      `#${[0, 1, 2]
        .map((i) =>
          Math.round((v[i] as number) * 255)
            .toString(16)
            .padStart(2, '0')
        )
        .join('')}`;
    const pane = hex(palette.background);

    it(`${name}: chrome text on the pane ≥ 4.5:1`, () => {
      expect(contrast(hex(palette.text), pane)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${name}: the crosshair, active border and gizmo are perceivable on the pane`, () => {
      for (const [label, color] of [
        ['crosshair', palette.crosshair],
        ['activeBorder', palette.activeBorder],
        ['gizmo', palette.gizmo],
        ['gizmoHot', palette.gizmoHot],
      ] as const) {
        expect(contrast(hex(color), pane), `${name}.${label}`).toBeGreaterThanOrEqual(3);
      }
    });
    it(`${name}: the halo inverts against the chrome text`, () => {
      // The halo's whole job is contrast behind a glyph. It must be the *opposite* end of the ramp
      // from the text, not a nearby shade of it — that is the bug a light theme introduces.
      expect(contrast(hex(palette.halo), hex(palette.text))).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('a dark pane keeps light chrome even in the light theme', () => {
    // Imaging convention: the panes stay dark in both themes, so the letters stay light in both.
    // This is the assertion that would fail if someone keyed the palette off the theme name.
    expect(THEMES.light.paneBackground).toBe('dark');
    expect(overlayPalette('light')).toEqual(overlayPalette('dark'));
  });
});

describe('theme tokens: no neon', () => {
  it('the Phase-1 cyan is gone from the stylesheet and the tokens', () => {
    expect(CSS.toLowerCase()).not.toContain('6ee7ff');
    for (const name of THEME_NAMES) {
      for (const value of Object.values(THEMES[name])) {
        expect(String(value).toLowerCase()).not.toBe('#6ee7ff');
      }
    }
  });

  it('every accent is muted', () => {
    for (const name of THEME_NAMES) {
      const t = THEMES[name];
      for (const token of ['accent', 'accentStrong', 'accentSurface', 'warn', 'danger'] as const) {
        expect(glare(t[token]), `${name}.${token} ${t[token]}`).toBeLessThan(0.25);
      }
    }
    // The bound has to actually exclude what it is aimed at: the Phase-1 cyan accent and the amber
    // the histogram drew its threshold rule in.
    expect(glare('#6ee7ff')).toBeGreaterThan(0.25);
    expect(glare('#ffc857')).toBeGreaterThan(0.25);
  });
});

describe('theme tokens: index.css agrees', () => {
  /** `--color-tvx-accent-strong` ← `accentStrong`. */
  function cssName(token: string): string {
    return `--color-tvx-${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
  }

  function blockOf(selector: string): string {
    const at = CSS.indexOf(selector);
    expect(at, `${selector} missing from index.css`).toBeGreaterThan(-1);
    const open = CSS.indexOf('{', at);
    const close = CSS.indexOf('}', open);
    return CSS.slice(open, close);
  }

  it.each([
    ['@theme', 'dark'],
    [":root[data-theme='dark']", 'dark'],
    [":root[data-theme='light']", 'light'],
    [':root:not([data-theme])', 'light'],
  ] as const)('%s carries the %s tokens verbatim', (selector, name) => {
    const block = blockOf(selector);
    const tokens = THEMES[name];
    for (const token of Object.keys(TOKEN_ROLES) as (keyof typeof TOKEN_ROLES)[]) {
      expect(block, `${selector} ${cssName(token)}`).toContain(
        `${cssName(token)}: ${tokens[token]};`
      );
    }
  });
});

describe('the window background main paints before the first frame', () => {
  /**
   * `BrowserWindow.backgroundColor` is chosen in `main/index.ts` from the same `settings.json` the
   * renderer reads, and it has to be the *same colour* the renderer is about to apply — that is the
   * whole reason it is not a constant any more. Main cannot import a renderer module (different
   * tsconfig, different process), so the two hexes are literals there and this is what keeps them
   * honest.
   */
  const MAIN = readFileSync(join(HERE, '..', '..', '..', 'main', 'index.ts'), 'utf8');
  const fn = MAIN.slice(MAIN.indexOf('function startupBackground'));

  it('uses each theme’s own bg token', () => {
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toContain(`'${THEMES.dark.bg}'`);
    expect(body).toContain(`'${THEMES.light.bg}'`);
  });
});

describe('theme resolution', () => {
  it('an explicit choice ignores the system', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
  it('system follows prefers-color-scheme, and falls back to dark when it cannot ask', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('system', null)).toBe('dark');
  });
});

describe('toVec4', () => {
  it('is the engine’s 0..1 form of the CSS hex', () => {
    expect(toVec4('#ffffff')).toEqual([1, 1, 1, 1]);
    expect(toVec4('#000000', 0.5)).toEqual([0, 0, 0, 0.5]);
    expect(toVec4('#3b5ba9')[0]).toBeCloseTo(0x3b / 255, 6);
  });
});
