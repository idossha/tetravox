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
