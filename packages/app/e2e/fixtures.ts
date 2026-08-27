/**
 * Launching the two Phase-0 targets (§12.1).
 *
 * `dev` runs the electron-vite build output through the `electron` npm binary; `packaged` runs the
 * electron-builder artefact by `executablePath`, and skips itself when that artefact is absent so a
 * bare `pnpm e2e` is green without a 2-minute package step.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = resolve(here, '..');

export type LaunchTarget = 'dev' | 'packaged';

/** The macOS/Linux executable inside `release/`, or null when `pnpm package` has not run. */
export function packagedExecutable(): string | null {
  const release = join(APP_ROOT, 'release');
  if (!existsSync(release)) return null;
  if (process.platform === 'darwin') {
    for (const dir of readdirSync(release)) {
      const exe = join(release, dir, 'Tetravox.app', 'Contents', 'MacOS', 'Tetravox');
      if (existsSync(exe)) return exe;
    }
    return null;
  }
  for (const entry of readdirSync(release)) {
    if (entry.endsWith('.AppImage')) return join(release, entry);
  }
  const unpacked = join(release, 'linux-unpacked', 'tetravox');
  return existsSync(unpacked) ? unpacked : null;
}

/**
 * The artefact file whose mtime says when `electron-builder` last ran. The Electron binary itself is
 * copied out of a downloaded zip and can keep the zip's timestamps, so it is not that file; the asar
 * builder writes is. An AppImage is one self-contained file, so there it *is* the executable.
 */
function packagedStamp(executablePath: string): string {
  const candidates =
    process.platform === 'darwin'
      ? [resolve(executablePath, '..', '..', 'Resources', 'app.asar')]
      : [join(dirname(executablePath), 'resources', 'app.asar')];
  return candidates.find((candidate) => existsSync(candidate)) ?? executablePath;
}

/** The newest mtime under `dir`, or 0 when it does not exist. */
function newestMtime(dir: string): number {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    const at = entry.isDirectory() ? newestMtime(child) : statSync(child).mtimeMs;
    if (at > newest) newest = at;
  }
  return newest;
}

/**
 * Why the `packaged` project cannot run right now, or null when it can.
 *
 * `pnpm e2e` rebuilds `out/` but does **not** repackage, so an artefact from an earlier commit will
 * happily launch and then fail on assertions about code it does not contain — as a mystery
 * `undefined` deep inside a page evaluation rather than as "you did not repackage".
 *
 * Compare against **sources** — `packages/app/src` and `crates/` — never against a build output.
 * `pnpm e2e` re-stamps `packages/app/out` on every run and `pnpm test` re-stamps
 * `packages/wasm/pkg` on every run, so either one would call a freshly built artefact stale.
 *
 * **`TETRAVOX_REQUIRE_PACKAGED=1` turns every skip reason into a failure.** ROADMAP Phase-0 gate 2 is
 * proved by this project and by nothing else, so the CI leg that exists to prove it must not go green
 * by skipping (`pnpm e2e` on a clean clone reports `10 skipped` here, which is correct there and would
 * be a silent hole after `pnpm package`). The `e2e:packaged` step in `.github/workflows/ci.yml` sets it.
 */
export function packagedUnavailable(): string | null {
  const reason = packagedBlockedReason();
  if (reason !== null && process.env['TETRAVOX_REQUIRE_PACKAGED']) {
    throw new Error(
      `TETRAVOX_REQUIRE_PACKAGED is set, but the packaged target is unavailable: ${reason}`
    );
  }
  return reason;
}

function packagedBlockedReason(): string | null {
  const executablePath = packagedExecutable();
  if (executablePath === null) return 'no packaged artefact — run `pnpm package` first';
  const source = Math.max(
    newestMtime(join(APP_ROOT, 'src')),
    newestMtime(resolve(APP_ROOT, '..', '..', 'crates'))
  );
  return source > statSync(packagedStamp(executablePath)).mtimeMs
    ? 'packaged artefact predates packages/app/src or crates/ — re-run `pnpm package`'
    : null;
}

export interface LaunchOptions {
  /** Extra CLI paths, to exercise the §8 argv capture. */
  args?: string[];
  /**
   * The renderer's launch query, handed to main as `--tvx-search=…` (see `src/main/index.ts`).
   * `ui=phase0` selects the Phase-0 walking skeleton; everything else configures the stand-in engine
   * the Phase-1 shell is developed against.
   */
  search?: string;
  /** Extra environment for the launched app — `TETRAVOX_DOWNLOAD_DIR` for the screenshot leg. */
  env?: Record<string, string>;
}

/**
 * Determinism switches, in the spirit of §11's golden launch args.
 *
 * `--force-color-profile=srgb` is the load-bearing one: without it Chromium colour-manages the
 * compositor output into the display profile, and on a P3 Mac the screenshot of a `#e5d634` triangle
 * comes back as `#e3d756` — a 34-count error in blue that would force a tolerance so wide the
 * assertion would stop meaning anything. `readPixels` is unaffected either way; this is what lets the
 * *screenshot* leg assert the same bytes.
 */
const DETERMINISM_ARGS = ['--force-color-profile=srgb', '--force-device-scale-factor=1'];

/**
 * A test run must not hijack the monitor (`src/main/window.ts`).
 *
 * On macOS every launch here used to raise a window, steal the keyboard focus and — under a tiling
 * window manager — re-tile the developer's whole workspace, a dozen times per `pnpm e2e`.
 * `TETRAVOX_E2E_OFFSCREEN=1` tells main to build the window and never show it. It stays on the real
 * GPU: `ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max)`, `norm16` and the timer query all
 * present, which is what these tests exist to cover.
 *
 * **Default on darwin only.** Linux CI runs under Xvfb, where there is no monitor to hijack and
 * where the shown-window path is the one worth exercising; Windows is not a target. Setting
 * `TETRAVOX_E2E_HEADED=1` restores visible windows everywhere — main gives that variable priority,
 * so the one export covers this suite and the engine's ANGLE project alike.
 *
 * The value is merged onto `process.env`, never assigned over it: `electron.launch({ env })`
 * REPLACES the child's environment, and dropping PATH/HOME from an Electron launch fails in ways
 * that look nothing like the cause.
 */
export function offscreenEnv(
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> | undefined {
  if (env['TETRAVOX_E2E_HEADED'] === '1') return undefined;
  if (env['TETRAVOX_E2E_OFFSCREEN'] !== undefined)
    return { TETRAVOX_E2E_OFFSCREEN: env['TETRAVOX_E2E_OFFSCREEN'] };
  return process.platform === 'darwin' ? { TETRAVOX_E2E_OFFSCREEN: '1' } : undefined;
}

export async function launchApp(
  target: LaunchTarget,
  options: LaunchOptions = {}
): Promise<ElectronApplication> {
  const search = options.search === undefined ? [] : [`--tvx-search=${options.search}`];
  const args = [...search, ...(options.args ?? [])];
  // The AppImage/deb sandbox needs a correctly-owned chrome-sandbox that a CI runner rarely has
  // (§12.2); on Linux the packaged binary is launched with --no-sandbox for that reason.
  const linuxSandbox = process.platform === 'linux' ? ['--no-sandbox'] : [];

  // `env` REPLACES the child's environment when given, so it is always merged onto `process.env`:
  // dropping PATH/HOME from an Electron launch fails in ways that look nothing like the cause.
  const offscreen = offscreenEnv();
  const extra =
    offscreen === undefined && options.env === undefined
      ? undefined
      : { ...offscreen, ...options.env };
  const env =
    extra === undefined ? undefined : ({ ...process.env, ...extra } as Record<string, string>);

  if (target === 'packaged') {
    const executablePath = packagedExecutable();
    if (executablePath === null) throw new Error('packaged artefact missing');
    return electron.launch({
      executablePath,
      args: [...DETERMINISM_ARGS, ...linuxSandbox, ...args],
      ...(env === undefined ? {} : { env }),
    });
  }
  return electron.launch({
    args: [APP_ROOT, ...DETERMINISM_ARGS, ...linuxSandbox, ...args],
    cwd: APP_ROOT,
    ...(env === undefined ? {} : { env }),
  });
}
