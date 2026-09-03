/**
 * The embed E2E: one headless Chromium, one Vite, the documented example host page.
 *
 * **Windowless, and it stays that way** (AGENTS.md rule 8, `docs/TESTING.md` §2.1). There is no
 * headed project here and none may be added. `--enable-unsafe-swiftshader` is §11's flag: Chromium
 * M137 removed the *automatic* SwiftShader fallback (§1), so without it `getContext('webgl2')`
 * returns null on a GPU-less runner and every one of these tests would assert the no-WebGL2 path by
 * accident.
 *
 * Real data is **skipped, never failed**, when `TETRAVOX_TESTDATA` is unset (AGENTS.md, rule 2).
 * The protocol tests that need no bytes still run.
 *
 * The port is offset by a hash of this file's own path, for the reason `packages/engine`'s config
 * explains at length: a hard-coded port silently reuses a dev server belonging to a *different*
 * clone, and the harness then serves that tree's pages while the reporter names this one.
 */

import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export function checkoutPort(base: number, override: string | undefined): number {
  if (override !== undefined && override !== '') return Number(override);
  const root = fileURLToPath(new URL('.', import.meta.url));
  let h = 2166136261;
  for (let i = 0; i < root.length; i += 1) {
    h ^= root.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return base + ((h >>> 0) % 900);
}

const PORT = checkoutPort(5299, process.env.TETRAVOX_TEST_PORT);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  // A 420 MB mesh parse is not instant, and the load test waits for a real one.
  timeout: 180_000,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    trace: process.env.CI ? 'retain-on-failure' : 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium-swiftshader',
      use: {
        browserName: 'chromium',
        launchOptions: {
          args: [
            '--enable-unsafe-swiftshader',
            '--force-device-scale-factor=1',
            '--hide-scrollbars',
          ],
        },
      },
    },
  ],
  webServer: {
    command: `pnpm exec vite --config ${fileURLToPath(new URL('./vite.config.ts', import.meta.url))}`,
    url: `${BASE_URL}/example/host.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
    env: { TETRAVOX_TEST_PORT: String(PORT) },
  },
});
