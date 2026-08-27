/**
 * Launching the two Phase-0 targets (§12.1).
 *
 * `dev` runs the electron-vite build output through the `electron` npm binary; `packaged` runs the
 * electron-builder artefact by `executablePath`, and skips itself when that artefact is absent so a
 * bare `pnpm e2e` is green without a 2-minute package step.
 */

import { existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
 * A private profile directory per launch, and why every E2E needs one.
 *
 * `src/main/index.ts` takes `app.requestSingleInstanceLock()` (§8: a second `tetravox file.nii`
 * hands its paths to the running window). That lock is keyed by the **userData directory**, which
 * for an unpackaged Electron app is derived from the app name alone — so it is shared by every
 * checkout of this repo on the machine, and by the developer's own running copy. While any of them
 * holds it, a launched app calls `app.quit()` **before it creates a window**, and Playwright reports
 * `Target page, context or browser has been closed` with `exitCode=0`: a failure that looks like a
 * crash in the code under test and is not one. Reproduced 2026-08-27 against a second worktree's
 * e2e run; the same shape appears in CI the moment two jobs share a runner.
 *
 * `--user-data-dir` moves the lock — and the cache, and local storage — into a fresh temp directory,
 * so each launch is genuinely alone. It changes nothing any spec asserts: the `tetravox://file/…`
 * allow-list is in-memory, the scheme is registered per process, and no test reads a profile.
 */
function privateUserDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'tetravox-e2e-profile-'));
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
  const profile = [`--user-data-dir=${privateUserDataDir()}`];

  // `env` REPLACES the child's environment when given, so it is always merged onto `process.env`:
  // dropping PATH/HOME from an Electron launch fails in ways that look nothing like the cause.
  const env =
    options.env === undefined
      ? undefined
      : ({ ...process.env, ...options.env } as Record<string, string>);

  if (target === 'packaged') {
    const executablePath = packagedExecutable();
    if (executablePath === null) throw new Error('packaged artefact missing');
    return electron.launch({
      executablePath,
      args: [...DETERMINISM_ARGS, ...profile, ...linuxSandbox, ...args],
      ...(env === undefined ? {} : { env }),
    });
  }
  return electron.launch({
    args: [APP_ROOT, ...DETERMINISM_ARGS, ...profile, ...linuxSandbox, ...args],
    cwd: APP_ROOT,
    ...(env === undefined ? {} : { env }),
  });
}
