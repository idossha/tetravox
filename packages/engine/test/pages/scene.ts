/**
 * The §11 scene page: a **real** `Engine` over a real dataset worker, driven from Playwright.
 *
 * Nothing here is a stand-in. `create()` is the frozen §4.7 entry point, the worker is the one
 * `packages/wasm` ships, and the bytes arrive over an `http`/`/@fs/` URL exactly the way they arrive
 * over `tetravox://file/…` in the app — a streaming `Response` the worker reads itself.
 *
 * Every knob is a query parameter so a spec can pin the scene without a round trip:
 * `?aa=off` (the golden default), `?norm16=0` / `?floatLinear=0` for `EngineOptions.forceCaps`
 * (§7.1's test axis — it may only ever REMOVE a capability), and `?dpr=`.
 */

import { create } from '../../src/api';
import type { Engine } from '../../src/api';
import type { TetravoxEngine } from '../../src/engine';

const params = new URLSearchParams(location.search);
const canvas = document.querySelector<HTMLCanvasElement>('#gl');
if (canvas === null) throw new Error('#gl is missing');

const forceCaps: Record<string, boolean> = {};
if (params.get('norm16') === '0') forceCaps.norm16 = false;
if (params.get('floatLinear') === '0') forceCaps.floatLinear = false;
if (params.get('clipDistance') === '0') forceCaps.clipDistance = false;

// §7.4 / §11's clip-path axis. Both spellings work: the query parameter a spec sets per test, and
// the `TETRAVOX_FORCE_DISCARD_CLIP` env var §11 names, which a spec forwards into the URL so the
// whole suite can be run once on each path.
const forceDiscardClip = params.get('forceDiscardClip') === '1';

const engine = create(canvas, {
  aa: params.get('aa') === 'on' ? 'auto' : 'off',
  dpr: Number(params.get('dpr') ?? '1') || 1,
  deterministic: true,
  forceCaps: Object.keys(forceCaps).length > 0 ? forceCaps : undefined,
  forceDiscardClip,
}) as TetravoxEngine;

declare global {
  interface Window {
    __tvxEngine?: Engine;
    /** Errors the engine emitted, so a spec can assert a clean run rather than guessing. */
    __tvxErrors?: string[];
    /** Every op the dataset workers were asked to run, in order — gate item 2's evidence. */
    __tvxOps?: string[];
  }
}

const errors: string[] = [];
engine.on('error', (e) => errors.push(`${e.code}: ${e.message}`));

// Gate item 2 needs to prove `build_topology` is **not** on the tag-surface path (§6.3). The honest
// way to show that is to record what the worker was actually asked to do, so the log is taken by
// wrapping `Worker.prototype.postMessage` before any worker exists.
const ops: string[] = [];
const realPost = Worker.prototype.postMessage;
Worker.prototype.postMessage = function patched(this: Worker, message: unknown, ...rest: never[]) {
  // §6.5's `Req` is `{ id, key, op, args }` — no `kind` discriminator; only `Cancel` has one.
  const m = message as { kind?: string; op?: string; id?: number };
  if (m !== null && m.kind === undefined && typeof m.op === 'string') ops.push(m.op);
  return (realPost as (this: Worker, m: unknown, ...r: never[]) => void).call(
    this,
    message,
    ...rest
  );
};

window.__tvxEngine = engine;
window.__tvxErrors = errors;
window.__tvxOps = ops;
window.__tvxRender = () => {
  engine.renderNow();
};
