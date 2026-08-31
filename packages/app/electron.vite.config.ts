/**
 * electron-vite (§2, §12.2).
 *
 * The renderer is served from a **real origin**, `tetravox://app`, by `protocol.handle`, never from
 * `file://` (§5, directive A2). electron-vite's `base: './'` is right for that too: `index.html` and
 * every chunk sit at the same depth under `out/renderer`, so the relative `new URL(…, import.meta.url)`
 * that Vite emits for the module Worker and for `tvx_wasm_bg.wasm` resolves to `tetravox://app/assets/…`
 * — which is what makes the wasm arrive with `content-type: application/wasm`.
 */

import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: {
      // Electron 44 ships Node 22; nothing here needs downlevelling.
      target: 'node22',
      minify: false,
      sourcemap: true,
      // §12.4: electron-updater has to ride *inside* the bundle. The packaged app ships no
      // node_modules (`electron-builder.yml` excludes them, because "everything is bundled by
      // electron-vite") — but electron-vite's default is the opposite for the main process: every
      // `dependencies` entry is silently externalized (`build.externalizeDeps` defaults to true),
      // which no other main-process import has ever tripped over because main's imports were all
      // electron/node/local until now. Externalized, the first Check for Updates in a shipped
      // build is a MODULE_NOT_FOUND.
      externalizeDeps: { exclude: ['electron-updater'] },
    },
  },
  preload: {
    build: {
      target: 'node22',
      minify: false,
      sourcemap: true,
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    // The wasm-pack glue is a linked workspace package; pre-bundling it would move
    // `new URL('tvx_wasm_bg.wasm', import.meta.url)` out of Vite's asset graph.
    optimizeDeps: { exclude: ['@tetravox/wasm'] },
    worker: { format: 'es' },
    build: {
      target: 'chrome138',
      sourcemap: true,
      assetsInlineLimit: 0,
    },
  },
});
