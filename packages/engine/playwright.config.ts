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

/** The half of §11's launch args that is about determinism rather than about the renderer. */
export const DETERMINISM_ARGS = [
  '--force-device-scale-factor=1',
  '--disable-lcd-text',
  '--font-render-hinting=none',
  '--hide-scrollbars',
];

/** §11's launch args, verbatim. */
export const SWIFTSHADER_ARGS = ['--enable-unsafe-swiftshader', ...DETERMINISM_ARGS];

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
    {
      // §11's **second leg**, and the only place the R16 branch of the §6.1 ladder can execute.
      //
      // The golden authority has no `EXT_texture_norm16` (§7.1 `[SwS]`), so `T1.nii.gz` is R32F in
      // every golden and R16 in the shipping renderer. §11's answer is explicit: the coverage
      // "comes from analytic `expectPixel` tests run **twice** on the macOS/ANGLE leg". Phase 1
      // implemented the test and not the leg, so the R16 half self-skipped in every environment
      // that existed — on a format that is the primary path for real data.
      //
      // `headless: false` + `channel: 'chromium'` is what selects the full browser and lets it
      // reach the platform GPU; `--enable-unsafe-swiftshader` is deliberately absent, because this
      // project exists to NOT be SwiftShader. On a machine or runner with no GPU it still falls
      // back to software, `caps.norm16` is false and the R16 test skips with its reason — the leg
      // is then honestly empty rather than silently missing.
      //
      // **`@angle` only.** No golden is captured here: §11 stores goldens per renderer class and
      // `test/golden/angle-metal/` does not exist, so running a golden test on this project would
      // demand a capture rather than a comparison. The tag marks the analytic tests, which are the
      // ones §11 asks to run twice.
      name: 'chromium-angle',
      grep: /@angle/,
      use: {
        browserName: 'chromium',
        channel: 'chromium',
        headless: false,
        launchOptions: { args: DETERMINISM_ARGS },
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
