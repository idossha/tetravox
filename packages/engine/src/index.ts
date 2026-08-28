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
