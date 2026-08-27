/**
 * The shapes the §11 test pages publish on `window`, shared by the page bundles and the Playwright
 * specs so neither side has to describe the other with `any`.
 */

import type { Capabilities } from '../../src/gl/caps';
import type { GlLimits, RendererClass } from '../../src/gl/context';

export interface ProbeReport {
  /** False when `getContext('webgl2')` returned null (§7.1) — the page never renders a white window. */
  ok: boolean;
  message?: string;
  caps?: Capabilities;
  limits?: GlLimits;
  rendererClass?: RendererClass;
  /** Everything `getSupportedExtensions()` offers, logged so a CI run records the whole surface. */
  supportedExtensions?: string[];
}

declare global {
  interface Window {
    /** Set by `pages/caps.ts` once the probe has run. */
    __tvxProbe?: ProbeReport;
    /**
     * Re-issues the page's draw calls. `helpers/pixels.ts` calls this in the same task as `readPixels`,
     * so the read never races the compositor.
     */
    __tvxRender?: () => void;
  }
}

export {};
