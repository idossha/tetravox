/**
 * Playwright config for the §11 rendering-verification harness.
 *
 * `@playwright/test` is pinned to an exact version in the root `package.json` (1.62.1) because it pins
 * the bundled Chromium, and therefore the SwiftShader build that produces every golden (§11).
 *
 * **SwiftShader flags — measured, not assumed** (2026-08-27, Playwright 1.62.1 / Chromium 151, macOS
 * arm64). Chromium M137 removed the *automatic* SwiftShader WebGL fallback (§1). Reproduced with
 * `--disable-gpu` (a GPU-less CI runner) on the full Chromium build:
 * * neither flag ⇒ `getContext('webgl2') === null`. This is the §1 claim, exactly.
 * * `--enable-unsafe-swiftshader` ⇒ SwiftShader. It *permits the fallback*; it does not select a
 *   renderer, so a machine that has a GPU still gets ANGLE/Metal and still produces `angle-metal`
 *   goldens. This is what §11 mandates and what this config passes.
 * * `--use-gl=angle --use-angle=swiftshader` also yields SwiftShader, with or without the unsafe flag —
 *   explicitly *choosing* the backend is its own consent. But it forces software everywhere, which
 *   would erase the ANGLE/Metal half of §11's two-renderer-class strategy. Rejected for that reason,
 *   not because it fails.
 * Playwright 1.62 already appends `--enable-unsafe-swiftshader` on its own launch path (and its default
 * `chromium` is the headless shell, which has no GPU access at all, so SwiftShader is what a bare
 * `chromium.launch()` gives). Passing it explicitly is a harmless duplicate that keeps the requirement
 * visible and survives a Playwright default changing under us. `docs/TESTING.md` has the full table.
 *
 * The rest of the args are §11 verbatim, and they exist to make the image a function of the scene only:
 * `--force-device-scale-factor=1` (DPR 1), `--disable-lcd-text` and `--font-render-hinting=none`
 * (subpixel text rendering differs per platform), `--hide-scrollbars` (no chrome in the frame).
 */

import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { GOLDEN_THRESHOLD, goldenMaxDiffPixelRatio } from './test/helpers/pixels';

const PORT = Number(process.env.TETRAVOX_TEST_PORT ?? 5199);
const BASE_URL = `http://127.0.0.1:${PORT}`;

/** §11's launch args, verbatim. */
export const SWIFTSHADER_ARGS = [
  '--enable-unsafe-swiftshader',
  '--force-device-scale-factor=1',
  '--disable-lcd-text',
  '--font-render-hinting=none',
  '--hide-scrollbars',
];

// `vite` is a devDependency of `packages/app` only and the Phase-0 lockfile is frozen (§12.3), so the
// test-page server is that package's vite binary pointed at this package's config. `pnpm --filter`
// runs it with cwd = packages/app, which is why the config path is absolute.
const VITE_CONFIG = fileURLToPath(new URL('./test/vite.config.ts', import.meta.url));

export default defineConfig({
  testDir: './test/e2e',
  snapshotDir: './test/golden',
  // {arg} is `<rendererClass>/<name>` as passed to expectGolden; {ext} is '.png'. No platform or
  // project suffix: the golden is keyed on the renderer class (§11), not on the machine that ran it.
  snapshotPathTemplate: '{snapshotDir}/{arg}{ext}',

  // §11: a golden is written only on purpose. `'none'` makes a missing golden a failure instead of a
  // silent capture, and `test/helpers/pixels.ts` additionally requires TETRAVOX_UPDATE_GOLDENS.
  updateSnapshots: process.env.TETRAVOX_UPDATE_GOLDENS ? 'all' : 'none',

  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 30_000,
  reporter: process.env.CI
    ? [['github'], ['list'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],

  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: goldenMaxDiffPixelRatio(),
      threshold: GOLDEN_THRESHOLD,
    },
  },

  use: {
    baseURL: BASE_URL,
    // Fixed viewport and DPR 1: every golden pixel is a canvas pixel (§11).
    viewport: { width: 1024, height: 768 },
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
        // No `channel`: the bundled Chromium, whose build is pinned by @playwright/test's version.
        launchOptions: { args: SWIFTSHADER_ARGS },
      },
    },
  ],

  webServer: {
    command: `pnpm --filter @tetravox/app exec vite --config ${VITE_CONFIG}`,
    url: `${BASE_URL}/test/pages/caps.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
    env: { TETRAVOX_TEST_PORT: String(PORT) },
  },
});
