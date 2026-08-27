// Vite dev server for the §11 rendering-verification pages.
//
// Root is `packages/engine`, so a page can import engine source with a plain relative path
// (`../../src/gl/context`) and Vite transpiles the TypeScript on the fly. `appType: 'mpa'` disables the
// SPA index.html fallback, so a typo in a page URL is a 404 instead of a silently blank page.
//
// This file deliberately imports **nothing from `vite`** (no `defineConfig`, hence no typed config).
// `vite` is a devDependency of `packages/app` only and the Phase-0 lockfile is frozen (§12.3), so the
// server is launched as `pnpm --filter @tetravox/app exec vite --config <this file>` — see
// `playwright.config.ts` and `docs/DECISIONS.md`. Vite bundles the config and resolves any bare import
// from *this* directory, where `vite` is not resolvable; a plain object avoids the problem entirely.

import { fileURLToPath } from 'node:url';

const port = Number(process.env.TETRAVOX_TEST_PORT ?? 5199);

export default {
  root: fileURLToPath(new URL('..', import.meta.url)),
  appType: 'mpa',
  logLevel: 'warn',
  clearScreen: false,
  cacheDir: fileURLToPath(new URL('../node_modules/.vite-test', import.meta.url)),
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    fs: { strict: true },
  },
};
