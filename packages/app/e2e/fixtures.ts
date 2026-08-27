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
 * The comparison is against **`src/`**, not against `out/`: `pnpm e2e`'s own `electron-vite build`
 * re-stamps `out/` every run, so `out/` would report every artefact as stale the moment it is used.
 */
export function packagedUnavailable(): string | null {
  const executablePath = packagedExecutable();
  if (executablePath === null) return 'no packaged artefact — run `pnpm package` first';
  const source = Math.max(
    newestMtime(join(APP_ROOT, 'src')),
    newestMtime(join(APP_ROOT, '..', 'wasm', 'pkg'))
  );
  return source > statSync(packagedStamp(executablePath)).mtimeMs
    ? 'packaged artefact predates packages/app/src — re-run `pnpm package`'
    : null;
}

export interface LaunchOptions {
  /** Extra CLI paths, to exercise the §8 argv capture. */
  args?: string[];
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

export async function launchApp(
  target: LaunchTarget,
  options: LaunchOptions = {}
): Promise<ElectronApplication> {
  const args = options.args ?? [];
  // The AppImage/deb sandbox needs a correctly-owned chrome-sandbox that a CI runner rarely has
  // (§12.2); on Linux the packaged binary is launched with --no-sandbox for that reason.
  const linuxSandbox = process.platform === 'linux' ? ['--no-sandbox'] : [];

  if (target === 'packaged') {
    const executablePath = packagedExecutable();
    if (executablePath === null) throw new Error('packaged artefact missing');
    return electron.launch({
      executablePath,
      args: [...DETERMINISM_ARGS, ...linuxSandbox, ...args],
    });
  }
  return electron.launch({
    args: [APP_ROOT, ...DETERMINISM_ARGS, ...linuxSandbox, ...args],
    cwd: APP_ROOT,
  });
}
