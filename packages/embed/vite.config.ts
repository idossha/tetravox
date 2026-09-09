/**
 * The embed build (ARCHITECTURE.md §2, `docs/EMBED.md`).
 *
 * `base: './'` is **mandatory**, not a preference. A host serves `dist/` from whatever route it
 * likes — `/tetravox/`, `/viewer/v3/`, a versioned CDN prefix — and it has no way to tell this
 * build which. Every emitted URL is therefore relative to `index.html`: the chunks, the CSS, the
 * module Worker and `tvx_wasm_bg-*.wasm`, all of which Vite emits as `new URL(…, import.meta.url)`
 * and all of which sit at the same depth under `assets/`. It is the same reason `electron.vite.config.ts`
 * uses `base: './'` for the Electron renderer, arrived at from the opposite direction.
 *
 * `assetsInlineLimit: 0` for the same reason it is set there: an inlined wasm or worker leaves
 * Vite's asset graph and stops being a file the host can serve with a content type.
 */

import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/**
 * Drop the Sample Data thumbnails — 1.5 MB of JPEG for a dialog an embed cannot open.
 *
 * `SampleDataDialog` reaches them through `import.meta.glob('../assets/samples/*.jpg', { eager })`,
 * which is resolved at transform time, so there is no tree-shaking that can remove them: the module
 * is reachable from `ShellDialogs` whether or not the branch that renders it can ever be taken. The
 * catalogue behind that dialog is served by the preload bridge, which an embed does not have
 * (`ABSENT.sampleCatalog` answers with an empty list), so the dialog is unreachable and the cards
 * that would have shown these images cannot exist.
 *
 * A build-time stub rather than a change in `packages/app`: the desktop app *does* need them, and
 * the difference is a property of this build, not of that component.
 */
function dropSampleThumbnails(): Plugin {
  const STUB = '\0tvx-embed-empty-asset';
  return {
    name: 'tvx-embed-drop-sample-thumbnails',
    enforce: 'pre',
    resolveId(source) {
      return /[\\/]assets[\\/]samples[\\/][^\\/]+\.jpg(\?|$)/.test(source) ? STUB : null;
    },
    load(id) {
      return id === STUB ? 'export default ""' : null;
    },
  };
}

export default defineConfig({
  root: here('.'),
  base: './',
  plugins: [dropSampleThumbnails(), react(), tailwindcss()],
  // The wasm-pack glue is a linked workspace package; pre-bundling it would move
  // `new URL('tvx_wasm_bg.wasm', import.meta.url)` out of Vite's asset graph.
  optimizeDeps: { exclude: ['@tetravox/wasm'] },
  worker: { format: 'es' },
  // The dev server is also the E2E harness (`playwright.config.ts`), which is deliberate: the suite
  // then drives the same entry, the same config and the same documented example page a developer
  // does, rather than a second wiring that can rot in private.
  server: {
    host: '127.0.0.1',
    port: Number(process.env.TETRAVOX_TEST_PORT ?? 5299),
    strictPort: true,
    // The renderer source lives in a sibling package and `$TETRAVOX_TESTDATA` outside the repo
    // entirely, so the server has to be allowed to reach both. `strict` stays on: everything else
    // is refused, and the reference dataset is admitted by name rather than by opening the disk.
    fs: {
      strict: true,
      allow: [
        here('../..'),
        ...(process.env.TETRAVOX_TESTDATA ? [process.env.TETRAVOX_TESTDATA] : []),
      ],
    },
  },
  build: {
    outDir: here('dist'),
    emptyOutDir: true,
    target: 'chrome138',
    sourcemap: true,
    assetsInlineLimit: 0,
  },
});
