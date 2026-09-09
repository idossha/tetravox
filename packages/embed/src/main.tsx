/**
 * The embed's entry point: the **same renderer**, in a browser tab, with a message port instead of
 * a preload bridge (`docs/EMBED.md`).
 *
 * It differs from `packages/app`'s `renderer/src/main.tsx` in exactly three ways, and each one is
 * something an embed cannot have rather than something it chooses not to do:
 *
 *  * **No `globalThis.tetravox`.** `bridge()` falls through to `ABSENT`, the null object the app
 *    already ships for "vitest, or a plain browser tab" — so every filesystem, updater, sample and
 *    extension call answers "no preload bridge" and the chrome that would have called them is
 *    hidden by `embedMode()`. Installing a *partial* bridge is not an option and never was:
 *    `bridge()` returns `globalThis.tetravox` wholesale, so a half-filled one is a `TypeError` on
 *    the first method nobody remembered.
 *  * **No module SDK and no installed manifests.** The only way to reach a module's code is a
 *    `tetravox://module` URL that only Electron's main process can put a file behind, so a page
 *    that cannot install a module also cannot be running one.
 *  * **The host channel**, registered *before* `createRoot`. `Shell` calls `emitShellReady` inside
 *    an effect on its first commit, and React runs effects synchronously enough that a listener
 *    attached after `render()` would already have missed it.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../app/src/renderer/src/App';
import { onShellReady } from '../../app/src/renderer/src/embed/mode';
import { EmbedHost } from './host';
import { embedParams } from './protocol';
import './index.css';

const root = document.getElementById('root');
if (root === null) throw new Error('#root missing from index.html');

const { hostOrigin } = embedParams(globalThis.location.search);

let host: EmbedHost | null = null;
onShellReady(({ controller, engine, store }) => {
  // A remount — React StrictMode's double-invoke in development, or a hot reload — hands over
  // rather than stacking a second channel on a destroyed engine.
  host?.stop();
  host = new EmbedHost({ controller, engine, store, hostOrigin });
  host.start();
  // The e2e drives the protocol from inside the page as well as across the frame boundary, which is
  // how the origin checks stay testable without a second origin to serve from.
  (globalThis as { __tvxEmbedHost?: EmbedHost }).__tvxEmbedHost = host;
});

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
