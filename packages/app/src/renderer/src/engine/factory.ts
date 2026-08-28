/**
 * **The one seam** between the shell and an `Engine` (§4.7).
 *
 * Phase 1 splits `packages/engine` and `packages/app` between two agents, so the shell is written and
 * tested against a stand-in while the WebGL2 engine is being built. Everything the UI does goes
 * through the frozen facade either way — this file is the only place that knows which implementation
 * is behind it, and flipping `ENGINE_IMPL` to `'real'` is the whole integration step.
 *
 * `?engine=real|mock` overrides it per window, so the E2E can pin the stand-in even after the flip,
 * and a developer can point the shell at the real engine before it is the default.
 */

import { create as createRealEngine } from '@tetravox/engine';
import type { Engine, EngineOptions } from '@tetravox/engine';
import { NoGlEngine } from './mockEngine';
import type { NoGlEngineOptions } from './mockEngine';

export type EngineImpl = 'real' | 'mock';

/**
 * The real WebGL2 engine, since the Phase-1 integration. `packages/engine`'s `create()` returns a
 * working engine and implements the four duck-typed members of `./commands.ts`, so every §8 control
 * is live. `?engine=mock` still selects the stand-in, which is what the shell's own unit and E2E
 * tests use so they stay independent of a GPU.
 */
export const ENGINE_IMPL: EngineImpl = 'real';

/** `?engine=` wins over `ENGINE_IMPL`; anything else is ignored rather than guessed at. */
export function engineImpl(search = globalThis.location?.search ?? ''): EngineImpl {
  const requested = new URLSearchParams(search).get('engine');
  return requested === 'real' || requested === 'mock' ? requested : ENGINE_IMPL;
}

/** Stand-in knobs the E2E sets on the URL: load speed, and a forced `parse` failure. */
export function mockOptions(search = globalThis.location?.search ?? ''): NoGlEngineOptions {
  const params = new URLSearchParams(search);
  const stepMs = Number(params.get('mockStepMs'));
  return {
    stepMs: Number.isFinite(stepMs) && stepMs > 0 ? stepMs : 40,
    parseFailSubstring: params.get('mockParseFail'),
    // Phase 2: `?mockTemplate=1` gives loaded volumes a `toTemplate`, which is what turns the §8
    // coordinate bar's MNI column on. Absent by default — see `NoGlEngineOptions`.
    toTemplate: params.get('mockTemplate') === '1',
  };
}

/**
 * A WebGL2 context is a *precondition*, not an error to catch: Chromium M137 removed the automatic
 * SwiftShader fallback (§1), so a blocklisted driver returns `null` here and the shell must show the
 * §8 error screen instead of a broken viewport. Probing on a throwaway canvas keeps the real one
 * unclaimed — `getContext` is sticky, and a probe on the live canvas would hand the engine a context
 * it did not create.
 */
export function webgl2Available(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const probe = document.createElement('canvas');
    return probe.getContext('webgl2') !== null;
  } catch {
    return false;
  }
}

export interface CreateEngineOptions extends EngineOptions {
  impl?: EngineImpl;
  mock?: NoGlEngineOptions;
}

export function createEngine(canvas: HTMLCanvasElement, opts: CreateEngineOptions = {}): Engine {
  const { impl, mock, ...engineOptions } = opts;
  if ((impl ?? engineImpl()) === 'mock') return new NoGlEngine(mock ?? mockOptions());
  return createRealEngine(canvas, engineOptions);
}
