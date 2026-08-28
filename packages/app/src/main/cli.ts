/**
 * CLI argv → candidate file paths (§8: `tetravox file1.nii.gz mesh.msh`).
 *
 * Electron hands main a different argv in dev (`electron . a.nii`) than packaged (`Tetravox a.nii`),
 * and Chromium adds switches of its own, so the filter is: drop argv[0], drop anything that starts
 * with `-`, drop the `.`/app-path argument electron-vite's dev runner passes.
 */

import { isAbsolute, resolve } from 'node:path';

/**
 * Switches whose **value** is a separate argument, so the value is not a file to open.
 *
 * Without this, `Tetravox --job job.json --out frames` opened `job.json` and `frames` as datasets on
 * top of running the job: `--job` is dropped for starting with `-`, and `job.json` is not.
 */
const VALUED_SWITCHES = ['--job', '--out', '--tvx-search', '--user-data-dir'];

export function collectCliPaths(argv: readonly string[], appPath: string, cwd: string): string[] {
  const out: string[] = [];
  let skipNext = false;
  for (const raw of argv.slice(1)) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (VALUED_SWITCHES.includes(raw)) {
      skipNext = true;
      continue;
    }
    if (raw.startsWith('-')) continue;
    if (raw === '.' || raw === appPath) continue;
    // `resolve` even when the path is already absolute: it normalises `..` and `.` segments, and the
    // comparison against `appPath` is against Electron's own already-normalised form. Without it,
    // launching as `electron /repo/python/../packages/app` opened the app directory itself as a
    // dataset — a 404 from the loader, three layers away from the cause.
    const abs = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
    if (abs === appPath) continue;
    out.push(abs);
  }
  return out;
}
