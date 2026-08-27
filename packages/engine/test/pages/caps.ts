/**
 * §7.1 capability-probe page. Creates one WebGL2 context through `createContext` and publishes the
 * probe result on `window.__tvxProbe`; `test/e2e/caps.spec.ts` asserts it and logs it, so every CI run
 * records which renderer produced that run's goldens (§11, last bullet).
 */

import { createContext, probeGlLimits, rendererClass } from '../../src/gl/context';
import type { ProbeReport } from './types';

function run(): ProbeReport {
  const canvas = document.getElementById('gl');
  if (!(canvas instanceof HTMLCanvasElement)) {
    return { ok: false, message: 'no #gl canvas in the page' };
  }
  try {
    // The probe must run before any texture exists (§7.1), which is exactly what createContext does.
    const { gl, caps } = createContext(canvas, { antialias: false });
    return {
      ok: true,
      caps,
      limits: probeGlLimits(gl),
      rendererClass: rendererClass(caps),
      supportedExtensions: (gl.getSupportedExtensions() ?? []).slice().sort(),
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

window.__tvxProbe = run();
