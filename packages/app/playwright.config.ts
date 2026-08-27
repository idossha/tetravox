/**
 * Playwright-Electron (§11, §12.1). Two projects over the same spec:
 *
 * * `dev`      — the electron-vite **build** output run by the `electron` binary. Loads
 *                `tetravox://app/index.html`, because no dev server is running.
 * * `packaged` — the electron-builder artefact, launched by `executablePath`. This is the one ROADMAP
 *                Phase-0 gate 2 actually demands; it self-skips when `pnpm package` has not run.
 *
 * `@playwright/test` is pinned to an exact version because it pins the SwiftShader build the §11
 * goldens are captured against.
 */

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  reporter: process.env['CI'] ? [['list'], ['github']] : [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  projects: [
    // The project name IS the launch target; `e2e/fixtures.ts` reads it off `workerInfo.project`.
    { name: 'dev' },
    { name: 'packaged' },
  ],
});
