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

/**
 * The dev-server port, **scoped to this checkout**.
 *
 * `reuseExistingServer: !CI` is what makes a local `pnpm e2e` fast: the second run reuses the Vite
 * the first one started. On a hard-coded port it also silently reuses a Vite belonging to a
 * *different clone*, and then the harness serves that tree's pages while the reporter names this
 * one. It is not hypothetical — a clean-clone gate run failed exactly that way (engine leg
 * `9 passed, 2 skipped, 5 did not run`) while another checkout held 5199, and §12.2's clean-clone
 * reproducibility item is not a gate item if another window can break it.
 *
 * So the base port is offset by a hash of this file's own absolute path. Two clones get two ports
 * and never meet; one clone gets the same port every time and keeps the reuse. `TETRAVOX_WASM_TEST_PORT`
 * still wins, for CI and for pinning a run by hand.
 */
export function checkoutPort(base: number, override: string | undefined): number {
  if (override !== undefined && override !== '') return Number(override);
  const root = fileURLToPath(new URL('.', import.meta.url));
  let h = 2166136261;
  for (let i = 0; i < root.length; i += 1) {
    h ^= root.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // 900 ports above the base, all inside the IANA dynamic range.
  return base + ((h >>> 0) % 900);
}

const PORT = checkoutPort(5299, process.env.TETRAVOX_WASM_TEST_PORT);
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
