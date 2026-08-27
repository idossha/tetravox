// Vite dev server for the §6.5 worker e2e.
//
// Root is the **repository** root, not this package: the harness page lives under
// `packages/wasm/e2e/pages/` and the fixtures it loads live under `testdata/`, and the worker must
// reach both over plain `http://` URLs the way it will reach `tetravox://file/…` in the app.
// `server.fs.allow` additionally admits `$TETRAVOX_TESTDATA`, so the real-data spec can fetch
// `/@fs/<abs path>` for `m2m_ernie/T1.nii.gz` without copying a 13 MB file into the repo.
//
// Like `packages/engine/test/vite.config.ts`, this file imports **nothing from `vite`**: `vite` is a
// devDependency of `packages/app` only and the Phase-0 lockfile is frozen (§12.3), so the server is
// launched as `pnpm --filter @tetravox/app exec vite --config <this file>`.

import { fileURLToPath } from 'node:url';

const port = Number(process.env.TETRAVOX_WASM_TEST_PORT ?? 5299);
const root = fileURLToPath(new URL('../../..', import.meta.url));
const realData = process.env.TETRAVOX_TESTDATA;

export default {
  root,
  appType: 'mpa',
  logLevel: 'warn',
  clearScreen: false,
  cacheDir: fileURLToPath(new URL('../node_modules/.vite-e2e', import.meta.url)),
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    fs: { strict: true, allow: realData ? [root, realData] : [root] },
  },
};
