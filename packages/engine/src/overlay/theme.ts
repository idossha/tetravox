/**
 * `OverlayTheme` — the colours §7.2's pass-3 chrome is drawn in (directed task 9, 2026-08-28).
 *
 * Every one of these used to be a `const` in `render/passes/overlay.ts`, which meant the orientation
 * letters, the corner info, the RAD/NEU badge, the colour-bar text and its frame, the crosshair and
 * the gizmo were all *engine* decisions. They are not: the embedder has a theme, and chrome drawn in
 * a fixed near-white with a fixed black halo is unreadable the moment that theme is a light one. The
 * halo in particular has to **invert**, not lighten — its job is contrast against anatomy, so it is
 * the theme's background, never a constant.
 *
 * Handed to the engine through {@link Engine.setTheme}, an *additive* §4.7 member (ARCHITECTURE
 * §4.7 / §7.2, `docs/DECISIONS.md` 2026-08-28). It is deliberately **not** part of `Scene`: a theme
 * is a property of the window looking at the scene, not of the scene, so a `*.tetravox.json` saved
 * in the light theme opens in whatever theme the reader is using. `background` is the exception and
 * is forwarded to `Scene.background`, which §4.6 does serialise — an embedder that does not want its
 * pane backgrounds to follow the theme simply leaves it out of the patch.
 *
 * **The defaults below are the Phase-1/2 constants, unchanged and deliberately so.** §11's goldens
 * are captured with them, so leaving them alone is what keeps a theming change from regenerating
 * every golden PNG in the repo. The app overrides them per theme; nothing in the engine does.
 */

import type { vec4 } from '../scene/types';

export interface OverlayTheme {
  /** Orientation letters, corner info, the badge, colour-bar ticks, titles and frame. */
  text: vec4;
  /** The 1 px outline behind every label. Its alpha is clamped to the label's own (§ builder). */
  halo: vec4;
  /** The 2D rules and the 3D marker (§4.5 `Annotations.crosshair`). */
  crosshair: vec4;
  /** The 1 px border on the active pane (§8). */
  activeBorder: vec4;
  /** §7.5's cut-plane gizmo, and the colour a hot handle takes. */
  gizmo: vec4;
  gizmoHot: vec4;
  /**
   * The pane clear colour, forwarded to `Scene.background`.
   *
   * Imaging convention keeps this dark in **both** of the app's themes; it is a theme field rather
   * than a constant so an embedder that wants a light viewport can have one.
   */
  background: vec4;
}

/**
 * The Phase-1/2 chrome colours, verbatim. Changing any of these moves §11's goldens and is a
 * `docs/DECISIONS.md` conversation, not a patch.
 *
 * The gizmo's cyan is deliberately neither the crosshair's amber nor the active border's blue: three
 * overlay items that can share a pane need three colours a test can tell apart, and
 * `pointer.spec.ts` finds the crosshair by "bright in R and G, dark in B".
 */
export const DEFAULT_OVERLAY_THEME: OverlayTheme = {
  text: [0.92, 0.94, 0.98, 1],
  halo: [0, 0, 0, 1],
  crosshair: [1, 0.85, 0.2, 0.9],
  activeBorder: [0.35, 0.62, 1, 1],
  gizmo: [0.25, 0.85, 0.95, 0.95],
  gizmoHot: [0.4, 1, 0.55, 1],
  background: [0.04, 0.05, 0.07, 1],
};

/** Apply a partial theme over a base, copying every vector so the result shares nothing. */
export function resolveOverlayTheme(
  patch: Partial<OverlayTheme> = {},
  base: OverlayTheme = DEFAULT_OVERLAY_THEME
): OverlayTheme {
  const pick = (key: keyof OverlayTheme): vec4 => {
    const value = patch[key] ?? base[key];
    return [value[0], value[1], value[2], value[3]];
  };
  return {
    text: pick('text'),
    halo: pick('halo'),
    crosshair: pick('crosshair'),
    activeBorder: pick('activeBorder'),
    gizmo: pick('gizmo'),
    gizmoHot: pick('gizmoHot'),
    background: pick('background'),
  };
}
