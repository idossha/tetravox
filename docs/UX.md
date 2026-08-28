# The Tetravox UX: themes and tokens

The contract is `docs/ARCHITECTURE.md` §8 (the shell) and §7.2 (the overlay pass). This file is the
palette both halves are written against.

**One source of truth:** `packages/app/src/renderer/src/theme/tokens.ts`. The stylesheet
(`renderer/src/index.css`) and main's `BrowserWindow.backgroundColor` carry the same hexes as
literals because they have to — Tailwind and Electron both need them there — and
`renderer/src/theme/tokens.test.ts` parses both files and fails if a value has been edited in only
one place. Do not edit a colour in one file and assume the others followed.

---

## 1. The two themes

**No neon.** The Phase-1 accent `#6ee7ff` is gone from the app, and so is every saturated highlight
it inspired. One muted slate-blue family does every job it did. The bound is measured, not asserted
by eye: `glare = RGB chroma × relative luminance`, and every token below scores under 0.21 while
`#6ee7ff` scores 0.385 and the old amber `#ffc857` 0.417.

| Token | CSS variable | Light | Dark | Role | Where |
|---|---|---|---|---|---|
| `bg` | `--color-tvx-bg` | `#ffffff` | `#16181c` | surface | window; also `BrowserWindow.backgroundColor` |
| `panel` | `--color-tvx-panel` | `#eef1f5` | `#1e2126` | surface | toolbar, side panels, status bar |
| `line` | `--color-tvx-line` | `#ccd2db` | `#333941` | decorative | hairlines, resting control borders |
| `lineStrong` | `--color-tvx-line-strong` | `#767f8d` | `#7d8794` | UI (3:1) | hovered/focused control border, histogram bars |
| `text` | `--color-tvx-text` | `#15181d` | `#dfe3ea` | text (4.5:1) | body copy, control labels |
| `dim` | `--color-tvx-dim` | `#5a6473` | `#99a1ae` | text (4.5:1) | units, hints, the key-map line |
| `accent` | `--color-tvx-accent` | `#3b5ba9` | `#93aae2` | UI (3:1) | active borders, focus rings, sliders, load-card bars, chips |
| `accentStrong` | `--color-tvx-accent-strong` | `#2f4a8c` | `#aec0ee` | text (4.5:1) | hover text, histogram window handles |
| `accentSurface` | `--color-tvx-accent-surface` | `#dce4f4` | `#262d3b` | surface | pressed controls, selected rows |
| `danger` | `--color-tvx-danger` | `#b3261e` | `#f0a09a` | text (4.5:1) | errors, the WebGL2-null screen |
| `warn` | `--color-tvx-warn` | `#8a5a00` | `#d9b76e` | text (4.5:1) | software-renderer notice, histogram threshold rule |

**Light** is white and light grey with soft shading: the depth comes from a one-step surface ramp
(`#ffffff` window over `#eef1f5` panels) plus a hairline, not from heavy borders. **Dark** is
graphite, deliberately not black.

**Contrast floors.** WCAG 1.4.3 (text, 4.5:1) and 1.4.11 (the boundary of a UI component, 3:1). Each
token declares its role in `TOKEN_ROLES` and the test enforces the matching floor on **every**
foreground × surface pair, in both themes. `line` is declared `decorative` — a separator carries no
information and operates nothing — and is held instead to "visible but not loud" (between 1.15:1 and
3:1). That exclusion is a line in the table, not an omission from it.

### Active, not accented

A pressed control is `.tvx-btn-on`: an `accentSurface` **fill** plus an `accent` border, with the
label still `text`. Saturated accent *text* passes 4.5:1 and still reads as a highlighter pen next to
eight neighbours that do not — the tinted surface says "this one is on" quietly.

### The one native control

`input[type='range']` gets `accent-color: var(--color-tvx-accent)` in one rule. Left alone, Chromium
paints a slider in the platform's own system blue, which is exactly the neon this palette removes and
does not flip with `data-theme`.

---

## 2. The switch

The toolbar's **Theme** group — `Sys` / `Light` / `Dark` — is `data-testid="theme-group"`, carrying
`data-theme-choice` (what the user picked) and `data-theme-resolved` (what it means right now).

* The choice is persisted by main in `settings.json` under `userData` (`main/settings.ts`), **not** in
  `localStorage`: every E2E launch gets a fresh `--user-data-dir`, so a preference kept in the
  profile could never be tested across a relaunch.
* `system` follows `prefers-color-scheme` live, and only while it is the choice.
* `applyTheme()` stamps `data-theme` and `color-scheme` on `<html>`. Every override in `index.css`
  keys off that attribute, so the whole window re-themes with no reload and no remount.
* Main reads the same file to pick `BrowserWindow.backgroundColor`, so a light-theme launch does not
  open on a black rectangle before the first frame.

---

## 3. The engine's chrome

§7.2's pass 3 — orientation letters, corner info, the RAD/NEU badge, the crosshair, the colour bar's
text/ticks/frame, the label halo and the cut-plane gizmo — is drawn **into the GL framebuffer**, so no
stylesheet can reach it. It is themed through `Engine.setTheme(patch: Partial<OverlayTheme>)`
(ARCHITECTURE §4.7), which the app calls from `ShellController.setThemeChoice` in the same tick as
the DOM flip.

**The view panes stay dark in both themes** (imaging convention: a light viewport changes what a
greyscale T1 and a heat overlay look like). `ThemeTokens.paneBackground` is the per-theme option, and
the overlay palette is keyed off **the pane**, never off the theme name:

| Chrome | On a dark pane (both themes today) | On a light pane |
|---|---|---|
| `text` | `#eaeef6` | `#1a1d23` |
| `halo` | `#000000` | `#ffffff` |
| `crosshair` | `#c9a15e` @ 0.9 | `#8a6420` @ 0.9 |
| `activeBorder` | `#93aae2` | `#3b5ba9` |
| `gizmo` / `gizmoHot` | `#93aae2` @ 0.95 / `#b7c7ef` | `#3b5ba9` @ 0.95 / `#2f4a8c` |
| `background` | `#0f1116` | `#f2f4f7` |

The halo is the field that proves the keying is right: it **inverts**, it does not shift.

**The engine's own defaults are unchanged.** `DEFAULT_OVERLAY_THEME` is the Phase-1/2 constants
verbatim, and `DrawInput.theme` is optional — so §11's goldens were not regenerated for this change,
and `pointer.spec.ts` still finds the crosshair by "bright in R and G, dark in B". The muted palette
above is what the *app* sends.

---

## 4. Tests

| What | Where |
|---|---|
| WCAG floors, the no-neon bound, and `index.css` / `main/index.ts` agreement | `packages/app/src/renderer/src/theme/tokens.test.ts` (vitest) |
| The switch: computed colours, live application, the engine half, persistence across a relaunch | `packages/app/e2e/theme.spec.ts` (Playwright-Electron) |
| Pictures | `docs/screenshots/directed-2026-08-28/theme-light.png`, `theme-dark.png` |

Adding a token means adding it to `ThemeTokens`, to `TOKEN_ROLES`, and to all four blocks in
`index.css`. The test will tell you which one you forgot.
