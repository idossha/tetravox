/**
 * `@tetravox/engine` — public entry point.
 *
 * Framework-free and browser-compatible (§2). Exports the frozen facade (§4.7), the frozen scene model
 * (§4.1–§4.6) and the §7.1 capability probe. `MockEngine` is exported for UI tests.
 */

export * from './scene/types';
export * from './api';
export type { Capabilities } from './gl/caps';
export { probeCapabilities } from './gl/caps';

/**
 * §7.6's colour tables, for chrome the engine does not draw itself.
 *
 * §8 puts "the current colormap painted along the x axis" under the histogram, and that widget is
 * DOM in `packages/app`. Without these it would need its own copy of the tables — a second source of
 * truth against the pane, which is the one thing a viewer must never have. `scalePosition` is here
 * for the same reason: where a value sits on the ramp is `Scale`'s arithmetic, not the widget's.
 *
 * Pure functions over §4.1 values; nothing here touches GL.
 */
export { isColormapName, sampleColormap, scalePosition } from './color/colormaps';
/** The deterministic colour §7.6 gives a label no LUT names — so a swatch matches the pane. */
export { fallbackLabelColor } from './layers/volume';

/**
 * §4.4's `VolumeLayer.iso3d` (directed task 2, 2026-08-28): the defaults the **3D surface** switch
 * turns on with, and the derivation the engine reconciles against. The app's editor needs the first
 * — a switch that has to invent a p95 itself would be §8's "no logic in React" broken — and the unit
 * tests need the second.
 */
export { defaultIso3d, derivedIsoLayers, iso3dLabels, iso3dLayerId } from './layers/iso3d';

/**
 * §4.6's sidecar resolution, for the host that owns the filesystem.
 *
 * `Engine.load` derives each `DatasetRef`'s sidecar paths from wherever the dataset resolved to and
 * asks the loader for them. In Electron that read goes through `tetravox://file/…`, which serves
 * only paths on main's allow-list (§5 directive A2) — so the shell has to allow-list the same paths
 * before it calls `load`, and it must derive them the same way. One implementation, exported, rather
 * than two that can drift.
 */
export { sidecarPathsFor } from './scene/serialize';
export type { SidecarPaths } from './scene/serialize';

/**
 * §8's coordinate spaces (directed task 8, 2026-08-28): the arithmetic and the selector policy.
 *
 * Exported for the same reason the colormaps are — the app's `NoGlEngine` has to give the *same*
 * answers as the real engine without a GL context, and a second implementation of `vox2ras-tkr` in
 * the app would be a second source of truth for a coordinate a user pastes into a paper. §8's "no
 * logic in React" then means React calls `Engine.coordinateSpaces` / `toSpace` / `fromSpace`, and
 * these are what both engines implement them with.
 */
export {
  coordinateSpaceOptions,
  fromSpace,
  isDeformationField,
  probeSpaces,
  referenceVolume,
  toSpace,
  volumesInMenuOrder,
} from './view/coord-spaces';
export {
  parseTextAffine,
  sampleDeformation,
  subjectToMniAffine,
  tkrToWorldMatrix,
  vox2rasTkr,
  worldToTkr,
  worldToTkrMatrix,
} from './view/spaces';

/**
 * The §7.2 pass-3 chrome palette (directed task 9, 2026-08-28).
 *
 * §8's theme switch has to reach the orientation letters, the corner info, the badge, the crosshair,
 * the colour bar and the gizmo, or half the window flips and the other half stays dark. It reaches
 * them through {@link Engine.setTheme}; this export is the shape of the patch and the defaults §11's
 * goldens are captured with.
 */
export { DEFAULT_OVERLAY_THEME } from './overlay/theme';
export type { OverlayTheme } from './overlay/theme';

/**
 * The glyph scaling model (§4.4's `GlyphScaling`) — exported because the app editor states the same
 * sentence in its panel that the overlay legend states on the picture, and one of them being a
 * re-implementation is how they end up disagreeing.
 */
export {
  DEFAULT_GLYPH_LENGTH_MM,
  glyphLegendLine,
  glyphLengthMm,
  glyphScaling,
  glyphScalingWord,
  referenceMagnitude,
} from './derived/glyph-scale';
export type { GlyphInstance } from './derived/glyph-readback';

/**
 * Measurement arithmetic (directed task 11, 2026-08-28) — exported because §8's measurement panel
 * prints the same number the overlay does, and two formatters would be two answers to "how long is
 * it". `formatMeasurementHtml` is the DOM's spelling of the one the bitmap font has to shout.
 */
export {
  angleDeg,
  distanceMm,
  formatMeasurement,
  formatMeasurementHtml,
  measurementFocus,
  measurementValue,
  nextMeasurementName,
  pointsNeeded,
} from './derived/measure';
