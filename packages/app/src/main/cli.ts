/**
 * CLI argv → candidate file paths (§8: `tetravox file1.nii.gz mesh.msh`).
 *
 * Electron hands main a different argv in dev (`electron . a.nii`) than packaged (`Tetravox a.nii`),
 * and Chromium adds switches of its own, so the filter is: drop argv[0], drop anything that starts
 * with `-`, drop the `.`/app-path argument electron-vite's dev runner passes.
 */

import { isAbsolute, resolve } from 'node:path';

export function collectCliPaths(argv: readonly string[], appPath: string, cwd: string): string[] {
  const out: string[] = [];
  for (const raw of argv.slice(1)) {
    if (raw.startsWith('-')) continue;
    if (raw === '.' || raw === appPath) continue;
    const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
    if (abs === appPath) continue;
    out.push(abs);
  }
  return out;
}
