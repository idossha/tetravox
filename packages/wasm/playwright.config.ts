/**
 * Playwright config for the §6.5 worker e2e.
 *
 * This suite asserts **numbers through the protocol**, not pixels: it boots the real module Worker
 * in Chromium, loads every committed fixture and compares the `VolumeMeta` / `MeshMeta` /
 * `SurfacePayload` that comes back against `testdata/manifest.json`. There are no goldens here —
 * §11's golden policy is `packages/engine`'s, and this package draws nothing.
 *
 * `@playwright/test` is still pinned exactly in the root `package.json` (1.62.1), because the whole
 * repo shares one Chromium download.
 */

import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.TETRAVOX_WASM_TEST_PORT ?? 5299);
const BASE_URL = `http://127.0.0.1:${PORT}`;

const VITE_CONFIG = fileURLToPath(new URL('./e2e/vite.config.ts', import.meta.url));

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  // A 492 MB mesh is a legitimate part of the real-data spec (§9.1 row 6 budgets 9 s for it alone).
  timeout: 180_000,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],

  use: {
    baseURL: BASE_URL,
    viewport: { width: 800, height: 600 },
    deviceScaleFactor: 1,
    trace: process.env.CI ? 'retain-on-failure' : 'off',
    screenshot: 'off',
    video: 'off',
  },

  projects: [
    {
      name: 'chromium-worker',
      use: {
        browserName: 'chromium',
        launchOptions: { args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] },
      },
    },
  ],

  webServer: {
    command: `pnpm --filter @tetravox/app exec vite --config ${VITE_CONFIG}`,
    url: `${BASE_URL}/packages/wasm/e2e/pages/harness.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      TETRAVOX_WASM_TEST_PORT: String(PORT),
      ...(process.env.TETRAVOX_TESTDATA === undefined
        ? {}
        : { TETRAVOX_TESTDATA: process.env.TETRAVOX_TESTDATA }),
    },
  },
});
