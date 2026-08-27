/**
 * Launching the two Phase-0 targets (§12.1).
 *
 * `dev` runs the electron-vite build output through the `electron` npm binary; `packaged` runs the
 * electron-builder artefact by `executablePath`, and skips itself when that artefact is absent so a
 * bare `pnpm e2e` is green without a 2-minute package step.
 */

import { existsSync, readdirSync } from 'node:fs';
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
