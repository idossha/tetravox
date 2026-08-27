/**
 * Whether this launch is allowed to put a window on the user's screen.
 *
 * A test run must not hijack the monitor. `pnpm e2e` launches Electron a dozen times, and every
 * launch used to raise a 1280x860 window, take the keyboard focus off whatever the developer was
 * doing and — under a tiling window manager — re-tile the whole workspace. None of that is what the
 * tests are for: measured on this machine (M2 Max, macOS 15.7, Electron 44.0.0, 2026-08-27), a
 * `BrowserWindow` that is created and never shown still reports
 * `ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max)` with `EXT_texture_norm16`,
 * `EXT_disjoint_timer_query_webgl2`, `MAX_TEXTURE_SIZE 16384` and 36 extensions — the same
 * capability set a shown window reports, digit for digit.
 *
 * Two modes, and the env vars that pick them:
 *
 * | `TETRAVOX_E2E_HEADED` | `TETRAVOX_E2E_OFFSCREEN` | mode | what happens |
 * |---|---|---|---|
 * | `1` | anything | `'normal'` | a real, shown, focusable window — the debugging opt-in |
 * | unset | `1` | `'offscreen'` | the window is built and never shown; no dock icon; no focus |
 * | unset | unset | `'normal'` | a normal user launch, untouched |
 *
 * `TETRAVOX_E2E_HEADED` wins, so one variable turns the windows back on for every leg at once — it
 * is the same variable `packages/engine/playwright.config.ts` reads. `e2e/fixtures.ts` sets
 * `TETRAVOX_E2E_OFFSCREEN=1` by default on darwin; nothing sets it for a user.
 *
 * **Why not Electron's OSR** (`webPreferences.offscreen`, the first candidate). It works: the whole
 * app E2E is 29/29 green under it, on ANGLE/Metal, with no window and no focus steal. It is not
 * free, though — it replaces the compositor with a CPU-side `paint` event, and the §12.1 benchmark
 * test measured the cost: orbit `gpuMs` median **3.52 ms @1x / 4.07 ms @2x** under OSR against
 * **2.02 / 3.32** for a never-shown window, with `cpuMs` median doubling from 0.10 to 0.20 ms. The
 * benchmark exists to record what the shipping renderer costs, so the mode that runs it must not be
 * the mode that inflates it. OSR also pins the frame loop to `setFrameRate` (61 Hz measured, against
 * the 122 Hz a never-shown window gets on this 120 Hz display) and routes `Page.captureScreenshot`
 * down a path that disagreed with `capturePage()` on the same frame (5,188 B vs 17,065 B). Rejected
 * for cost and for surface area, not because it fails.
 *
 * **Why not a real window parked off-screen** (the second candidate). Measured, and it does not
 * work: asking for `x: -10000` gave `getBounds().x === -1240`, and `CGWindowListCopyWindowInfo` then
 * listed a live on-screen `Electron` window at `761,48,741,864` — macOS clamps the frame and the
 * developer's tiling WM re-tiled it back into view. Never shown is the only position nothing can
 * clamp.
 */

export type WindowMode = 'normal' | 'offscreen';

export function windowMode(env: NodeJS.ProcessEnv = process.env): WindowMode {
  if (env['TETRAVOX_E2E_HEADED'] === '1') return 'normal';
  return env['TETRAVOX_E2E_OFFSCREEN'] === '1' ? 'offscreen' : 'normal';
}
